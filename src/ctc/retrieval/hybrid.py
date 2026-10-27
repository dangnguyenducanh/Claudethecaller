"""Hybrid search: dense + keyword candidates → RRF → filters → rerank → abstain gate (PLAN.md B4, AI flow step 4)."""

from __future__ import annotations

import asyncio
import json
import logging
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from ctc.config import cfg
from ctc.embedding.embedder import Embedder
from ctc.ingestion.scanner import project_id, project_namespace
from ctc.reranking.reranker import Reranker
from ctc.retrieval import gate
from ctc.storage.local import LocalStore
from ctc.storage.store import Store

log = logging.getLogger(__name__)


@dataclass
class Ctx:
    store: Store | LocalStore  # async candidates()/overrides(), sync get()
    embedder: Embedder
    reranker: Reranker
    project: str  # project dir
    user_id: str = "local"


@dataclass
class Hit:
    cap_id: str
    score: float
    stages: dict[str, float | None] = field(default_factory=dict)


@dataclass
class SearchResult:
    hits: list[Hit]
    abstained: bool
    ms: dict[str, float]
    dropped: list[tuple[Hit, str]]
    considered: list[Hit]  # every reranked hit, so `ctc explain` can show why it abstained
    p: float | None = None  # abstain-gate probability when a gate model is installed


def rrf(rankings: list[list[str]], k: int = 60, weights: list[float] | None = None) -> dict[str, float]:
    """Weighted RRF; a weight-0 ranking still adds its ids (score 0, after the others, in its own order)."""
    scores: dict[str, float] = {}
    for ranking, w in zip(rankings, weights or [1.0] * len(rankings)):
        for rank, cap_id in enumerate(ranking, 1):
            scores[cap_id] = scores.get(cap_id, 0.0) + w / (k + rank)
    return scores


async def search(q: str, ctx: Ctx, qv: np.ndarray | None = None, k: int = 5, depth: int = 50,
                 rerank_top: int = 20, abstain_below: float | None = None, ranking: dict | None = None) -> SearchResult:
    """`ranking` (default cfg()["ranking"]): keyword_rrf_weight = keyword rank's weight in the RRF that picks the
    rerank_top pool; rerank_weight = rerank rank's weight next to dense rank (weight 1) in the final order.
    {0, 0} = dense order; {1, 1} = the pre-2026-10-21 order. `fusion` ("rrf" | "score", default rrf) picks how dense and
    keyword candidates are first ordered; `score_w` (default 0.7) is the cosine's weight under "score" (M8-3)."""
    rk = ranking or cfg()["ranking"]
    ms: dict[str, float] = {}
    t = time.perf_counter()

    def lap(stage: str) -> None:
        nonlocal t
        now = time.perf_counter()
        ms[stage] = round((now - t) * 1000, 1)
        t = now

    if qv is None:
        qv = (await ctx.embedder.embed([q], "query"))[0]
    lap("embed")
    (dense, sparse), overrides = await asyncio.gather(  # independent: one DB hop, not two
        ctx.store.candidates(qv, q, depth), ctx.store.overrides(project_id(ctx.project), ctx.user_id))
    lap("candidates")

    dense_rank = {c: i for i, (c, _) in enumerate(dense, 1)}
    sparse_rank = {c: i for i, (c, _) in enumerate(sparse, 1)}
    dense_score = dict(dense)
    own_ns = project_namespace(Path(ctx.project))
    hits: list[Hit] = []
    dropped: list[tuple[Hit, str]] = []
    clusters: set[str] = set()
    rrf_score = rrf([list(dense_rank), list(sparse_rank)], weights=[1, rk["keyword_rrf_weight"]])
    pool = rrf_score
    score_fusion = rk.get("fusion", "rrf") == "score"
    if score_fusion:  # fuse on scores, not ranks: (1 - w) * keyword + w * cosine, both in [0, 1]; the stages keep their rrf too
        # ponytail: a keyword-only hit has no cosine (dense returns just the top `depth`), so it scores (1 - w) * keyword alone.
        w, lex = rk.get("score_w", 0.7), dict(sparse)
        lex_max = max(lex.values(), default=0.0)  # ts_rank_cd of the best keyword hit; no keyword arm -> fused = w * cosine
        pool = {c: (1 - w) * (lex.get(c, 0.0) / lex_max if lex_max > 0 else 0.0) + w * min(max(dense_score.get(c, 0.0), 0.0), 1.0)
                for c in rrf_score}
    for cap_id, score in sorted(pool.items(), key=lambda x: -x[1]):
        cap = ctx.store.catalog.get(cap_id)
        hit = Hit(cap_id, score, {"dense": round(dense_score[cap_id], 4) if cap_id in dense_score else None,
                                  "dense_rank": dense_rank.get(cap_id), "sparse_rank": sparse_rank.get(cap_id), "rrf": round(rrf_score[cap_id], 5)})
        if score_fusion:
            hit.stages["fused"] = round(score, 4)
        if cap is None:  # in the DB, not in this worker's catalog: another process indexed it and the 'lib' inval is pending
            dropped.append((hit, "not in this worker's catalog yet"))
        elif overrides.get(cap_id) in ("block", "disable"):
            dropped.append((hit, f"{overrides[cap_id]}ed in this project"))
        elif cap["namespace"].startswith("project@") and cap["namespace"] != own_ns:
            dropped.append((hit, "belongs to another project"))
        elif cap["cluster_id"] and cap["cluster_id"] in clusters:
            dropped.append((hit, f"duplicate of a better hit (cluster {cap['cluster_id']})"))
        else:
            if cap["cluster_id"]:
                clusters.add(cap["cluster_id"])
            hits.append(hit)
    lap("filter")

    top = hits[:rerank_top]
    if top:
        docs = [f"{ctx.store.get(h.cap_id)['name']}: {ctx.store.get(h.cap_id)['description']}"[:1000] for h in top]
        for h, (s, logit) in zip(top, await ctx.reranker.score_with_logits(q, docs)):
            h.stages["rerank"], h.stages["rerank_logit"] = round(s, 4), round(logit, 4)  # rerank = sigmoid: agent_min_rerank and abstain_below read it
        # bge-reranker's absolute scores carry no signal for tool matching (measured: right and junk matches both
        # score ~0.001-0.04), so it only votes with its ORDER. Keywords never vote in the final order (common words
        # like "review"/"test" are noisy); the final order is weighted RRF over dense rank and rerank rank.
        # ponytail: rerank runs even at rerank_weight 0, since bundle reasons and agent_min_rerank read stages["rerank"].
        by = "rerank_logit" if rk.get("rerank_by") == "logit" else "rerank"  # the sigmoid is rounded to 4 decimals: logits below ~-9.9 tie at 0.0
        rerank_order = [h.cap_id for h in sorted(top, key=lambda h: -h.stages[by])]
        # first-stage order: dense rank; under score fusion `top` is already in fused order and that replaces dense rank.
        first_order = [h.cap_id for h in top] if score_fusion else [h.cap_id for h in sorted(top, key=lambda h: h.stages["dense_rank"] or 10**6)]
        final = rrf([first_order, rerank_order], weights=[1, rk["rerank_weight"]])
        for h in top:
            h.score = h.stages["final"] = round(final[h.cap_id], 5)
        top.sort(key=lambda h: -h.score)
        top.sort(key=lambda h: overrides.get(h.cap_id) != "pin")  # stable sort: pins first
    lap("rerank")

    # Dense cosine and rerank scores both fail as thresholds; K2's gate (a classifier over stage features) decides.
    abstained = not top or (abstain_below is not None and max(h.stages["rerank"] for h in top) < abstain_below)
    res = SearchResult([] if abstained else top[:k], abstained, ms, dropped, top)
    if top and (g := gate.load(cfg()["gate_path"])):
        try:
            res.p = round(gate.p(g, res, q), 4)
            if res.p < g["threshold"]:
                res.hits, res.abstained = [], True
        except Exception:  # fail-open: a gate that breaks at predict time is skipped, search still answers
            log.exception("abstain gate failed; no gate for this prompt")
    return res


async def open_ctx(project_dir: Path) -> Ctx:
    """Postgres Store when CTC_DATABASE_URL is set, else the in-memory LocalStore (embeds the library on first use)."""
    c = cfg()
    embedder = Embedder(c["embed_url"], c["timeout_s"])
    if c["database_url"]:
        store = await Store.open(c["database_url"], pool_min=c["db_pool"]["min"], pool_max=c["db_pool"]["max"])
    else:
        store = LocalStore(project_dir)
        await store.build(embedder)
    return Ctx(store, embedder, Reranker(c["rerank_url"], c["timeout_s"]), str(project_dir.resolve()))


async def close_ctx(ctx: Ctx) -> None:
    if isinstance(ctx.store, Store):
        await ctx.store.close()
    await ctx.embedder.aclose()
    await ctx.reranker.aclose()


def result_json(q: str, ctx: Ctx, res: SearchResult) -> dict:
    hit = lambda h: {**ctx.store.get(h.cap_id), "score": round(h.score, 4), "stages": h.stages}
    return {"query": q, "abstained": res.abstained, "p": res.p, "hits": [hit(h) for h in res.hits], "ms": res.ms}


async def _main(q: str) -> None:
    ctx = await open_ctx(Path.cwd())
    try:
        print(json.dumps(result_json(q, ctx, await search(q, ctx)), indent=2, ensure_ascii=False))
    finally:
        await close_ctx(ctx)


if __name__ == "__main__":
    asyncio.run(_main(" ".join(sys.argv[1:]) or "fix a flaky test"))
