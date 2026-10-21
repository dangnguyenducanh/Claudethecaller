"""Hybrid search: dense + keyword candidates → RRF → filters → rerank → abstain (PLAN.md B4)."""

from __future__ import annotations

import asyncio
import json
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from ctc.embedding.embedder import Embedder
from ctc.ingestion.scanner import project_namespace
from ctc.reranking.reranker import Reranker


@dataclass
class Ctx:
    store: object  # anything with candidates(), overrides(), get(): LocalStore now, Supabase Store after B3
    embedder: Embedder
    reranker: Reranker
    project: str


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


def rrf(rankings: list[list[str]], k: int = 60) -> dict[str, float]:
    scores: dict[str, float] = {}
    for ranking in rankings:
        for rank, cap_id in enumerate(ranking, 1):
            scores[cap_id] = scores.get(cap_id, 0.0) + 1 / (k + rank)
    return scores


async def search(q: str, ctx: Ctx, qv: np.ndarray | None = None, k: int = 5, depth: int = 50,
                 rerank_top: int = 20, abstain_below: float | None = None) -> SearchResult:
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
    dense, sparse = ctx.store.candidates(qv, q, depth)
    lap("candidates")

    dense_rank = {c: i for i, (c, _) in enumerate(dense, 1)}
    sparse_rank = {c: i for i, (c, _) in enumerate(sparse, 1)}
    dense_score = dict(dense)
    overrides = ctx.store.overrides(ctx.project)
    own_ns = project_namespace(Path(ctx.project))
    hits: list[Hit] = []
    dropped: list[tuple[Hit, str]] = []
    clusters: set[str] = set()
    for cap_id, score in sorted(rrf([list(dense_rank), list(sparse_rank)]).items(), key=lambda x: -x[1]):
        cap = ctx.store.get(cap_id)
        hit = Hit(cap_id, score, {"dense": round(dense_score[cap_id], 4) if cap_id in dense_score else None,
                                  "dense_rank": dense_rank.get(cap_id), "sparse_rank": sparse_rank.get(cap_id), "rrf": round(score, 5)})
        if overrides.get(cap_id) in ("block", "disable"):
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
        for h, s in zip(top, await ctx.reranker.score(q, docs)):
            h.stages["rerank"] = round(s, 4)
        # bge-reranker's absolute scores carry no signal for tool matching (measured: right and junk matches both
        # score ~0.001-0.04), so it only votes with its ORDER. Keywords only widen the candidate pool (common words
        # like "review"/"test" are noisy); the final order is RRF over dense rank and rerank rank.
        rerank_order = [h.cap_id for h in sorted(top, key=lambda h: -h.stages["rerank"])]
        dense_order = [h.cap_id for h in sorted(top, key=lambda h: h.stages["dense_rank"] or 10**6)]
        final = rrf([dense_order, rerank_order])
        for h in top:
            h.score = h.stages["final"] = round(final[h.cap_id], 5)
        top.sort(key=lambda h: -h.score)
        top.sort(key=lambda h: overrides.get(h.cap_id) != "pin")  # stable sort: pins first
    lap("rerank")

    # ponytail: no abstain until K2 calibrates one (dense cosine and rerank scores both fail as thresholds).
    abstained = not top or (abstain_below is not None and max(h.stages["rerank"] for h in top) < abstain_below)
    return SearchResult([] if abstained else top[:k], abstained, ms, dropped, top)


async def open_ctx(project_dir: Path) -> Ctx:
    # ponytail: local in-memory store until the Supabase store (B3); swap the store here.
    from ctc.storage.local import LocalStore

    store, embedder = LocalStore(project_dir), Embedder()
    await store.build(embedder)
    return Ctx(store, embedder, Reranker(), str(project_dir.resolve()))


def result_json(q: str, ctx: Ctx, res: SearchResult) -> dict:
    hit = lambda h: {**ctx.store.get(h.cap_id), "score": round(h.score, 4), "stages": h.stages}
    return {"query": q, "abstained": res.abstained, "hits": [hit(h) for h in res.hits], "ms": res.ms}


async def _main(q: str) -> None:
    ctx = await open_ctx(Path.cwd())
    print(json.dumps(result_json(q, ctx, await search(q, ctx)), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(_main(" ".join(sys.argv[1:]) or "fix a flaky test"))
