"""K1 retrieval benchmark + K2 tuning (PLAN.md K1, K2, Targets): ranx metrics per mode, abstain gate, report.

uv run python -m evaluation.retrieval_eval index-skillret   # SkillRet test (6,006) -> ctc_skillret, train (10,123) -> ctc_skillret_train
uv run python -m evaluation.retrieval_eval index-skillret --text skillret --body-chars 8000   # name | description | body -> ctc_skillret_sk, ctc_skillret_train_sk
uv run python -m evaluation.retrieval_eval tune [limit]     # abstain gate candidates (off, margin, platt, isotonic, lr): fit on dev, report on test -> data/reports/gate-<date>.json
uv run python -m evaluation.retrieval_eval ranking [--fusion score] [--no-write]   # DEV ONLY: keyword_rrf_weight x rerank_weight sweep -> config `ranking`; --fusion score: score_w sweep, never writes the yaml
uv run python -m evaluation.retrieval_eval ranking-test [n] # SkillRet TEST, report only: dense vs old {1, 1} vs configured ranking
uv run python -m evaluation.retrieval_eval ablate --split dev|test [--on own] --variant name=text:skillret,fusion:score,w:0.7 ...  # paired p-values, report only
uv run python -m evaluation.retrieval_eval index-own        # this machine's library (the scan K1 labels against) -> ctc_own[_sk]; CTC_LIVE_DATABASE_URL = read-only source of A1 summaries
uv run python -m evaluation.retrieval_eval run [limit]      # TEST: three modes on SkillRet, own-eval, gold-none -> data/reports/
--text current|skillret and --body-chars N work on every command (they pick the schemas and the query instruction to match).
--fusion rrf|score and --score-w W set ranking.fusion / score_w for the whole run (so tune and ranking-test can use score fusion without editing the yaml).
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from datetime import date
from pathlib import Path

import joblib
import numpy as np
import psycopg
from ranx import Qrels, Run, compare, evaluate
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold, cross_val_predict

from ctc.config import ROOT, cfg
from ctc.embedding.embedder import Embedder
from ctc.ingestion.indexer import build_index
from ctc.ingestion.scanner import default_roots, scan_library
from ctc.reranking.reranker import Reranker
from ctc.retrieval import gate
from ctc.retrieval.hybrid import Ctx, rrf, search
from ctc.storage.store import Store
from evaluation.loaders import metatool, skillret, skillret_caps

METRICS = ["recall@1", "recall@5", "recall@10", "ndcg@10", "mrr"]
MODES = ["dense", "hybrid", "full"]
SHOWN = [*MODES, "full+gate"]  # full+gate = what the user gets: an abstained query retrieves nothing
OWN = "ctc_own"  # this machine's library as K1 labels it: a scratch copy per text mode, so the live index is never re-embedded
SKILLRET = {"test": "ctc_skillret", "train": "ctc_skillret_train"}  # train skills only serve the dev sample (disjoint qrels)
NEUTRAL = "/nonexistent/ctc-eval"  # project dir with no project capabilities and no overrides: nothing is project-filtered
REPORTS = ROOT / "data" / "reports"
TODAY = date.today().isoformat()
MAX_FT, SR_DEV_N = 0.10, 500
TEI_MAX_BATCH = 32  # TEI max_client_batch_size: the shipped Reranker sends one request, so rerank_top > 32 gets HTTP 413
KW_WEIGHTS, RERANK_WEIGHTS = (0, 0.25, 0.5, 1), (0, 0.25, 0.5, 1, 2)
OLD_RANKING = {"keyword_rrf_weight": 1, "rerank_weight": 1}
SCORE_WS = (0.5, 0.6, 0.7, 0.8, 0.9)  # `ranking --fusion score`: the cosine's weight in (1 - w) * keyword + w * cosine
MARGIN_RATIOS = [round(1 + 0.05 * i, 2) for i in range(41)]  # tune: 1.0 (always fires) .. 3.0
LANGS = ("ascii", "other")
SC003_SUGGEST = 0.5  # SC-003: a gate must suggest on >= 50% of SkillRet test queries at <= MAX_FT false-trigger on MetaTool test
CMP_METRICS = ["ndcg@10", "recall@5"]
MIN_AUC = 0.7  # the pre-m8 tune saved its gate only at or above this out-of-fold AUC; report() still renders such a tune-<date>.json


def is_test(qid: str) -> bool:  # same rule as the labeler's session split, for MetaTool rows
    return int(hashlib.sha256(qid.encode()).hexdigest(), 16) % 2 == 1


def set_text_mode(text: str | None, body_chars: int | None) -> None:
    """--text / --body-chars for the whole process: the cached config is changed in place, so texts() and the Embedder see
    it. The instruction follows the text (skillret text <-> skillret instruction). ponytail: mutates the config cache."""
    e = cfg()["embed"]
    if text:
        e["text"], e["instruction"] = text, {"current": "coding", "skillret": "skillret"}[text]
    if body_chars:
        e["skillret_body_chars"] = body_chars


def set_fusion(fusion: str | None, score_w: float | None) -> None:
    """--fusion / --score-w for the whole process, like set_text_mode. ponytail: mutates the config cache."""
    r = cfg()["ranking"]
    if fusion:
        r["fusion"] = fusion
    if score_w is not None:
        r["score_w"] = score_w


def text_suffix() -> str:
    """The skillret text mode lives beside the current one (`_sk`; `_sk<N>` for a body cap other than the shipped 8,000, so
    cap variants never share vectors), never in the live `ctc` schema."""
    e = cfg()["embed"]
    return "" if e["text"] != "skillret" else "_sk" + ("" if e["skillret_body_chars"] == 8000 else str(e["skillret_body_chars"]))


def sr_schema(split: str) -> str:
    return SKILLRET[split] + text_suffix()


def own_schema() -> str:
    return OWN + text_suffix()


def reranker_tag() -> str:
    """The TEI image tag of the tei-reranker service in docker-compose.yml ('' when unreadable)."""
    try:
        m = re.search(r"tei-reranker:\s*\n\s*image:\s*\S+:([\w.\-]+)", (ROOT / "docker-compose.yml").read_text())
    except OSError:
        return ""
    return m[1] if m else ""


def commit_sha() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], check=False, cwd=ROOT, capture_output=True, text=True, timeout=5).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def header() -> dict:
    """Report header (contracts/knobs-and-eval.md): what this run's numbers were produced with."""
    e, r = cfg()["embed"], cfg()["ranking"]
    return {"text_mode": e["text"], "instruction": e["instruction"], "body_chars": e["skillret_body_chars"] if e["text"] == "skillret" else None,
            "fusion": r["fusion"], "score_w": r["score_w"], "tei_reranker_tag": reranker_tag(), "git_sha": commit_sha()}


def save(name: str, data: dict) -> None:
    REPORTS.mkdir(parents=True, exist_ok=True)  # a fresh checkout has no data/reports
    (REPORTS / name).write_text(json.dumps(data, indent=1))


def lang(q: str) -> str:
    """ponytail: script test only (ASCII letters vs anything else, so Vietnamese with diacritics and CJK are both "other")."""
    return "ascii" if all(ch.isascii() for ch in q if ch.isalpha()) else "other"


def own_sets(test: bool) -> tuple[list[tuple], list[tuple]]:
    """(rows with gold, gold-none rows) as (id, query, {cap_id: 1}); gold-none = own none + MetaTool negatives."""
    rows = [json.loads(line) for line in (ROOT / "data" / "processed" / "own-eval.jsonl").read_text().splitlines() if line.strip()]
    rows = [r for r in rows if r["split"] == int(test)]  # 1 = test
    pos = [(r["id"], r["query"], dict.fromkeys(r["gold"], 1)) for r in rows if r["gold"]]
    neg = [(r["id"], r["query"], {}) for r in rows if not r["gold"]] + [(m["id"], m["query"], {}) for m in metatool() if is_test(m["id"]) == test]
    return pos, neg


class MemoReranker:
    """Sweep-only reranker: memoizes (query, doc) scores across configs and sends <= 32 docs per request."""

    def __init__(self, r: Reranker):
        self.r, self.memo = r, {}

    async def score_with_logits(self, q: str, docs: list[str]) -> list[tuple[float, float]]:
        new = [d for d in dict.fromkeys(docs) if (q, d) not in self.memo]
        for i in range(0, len(new), TEI_MAX_BATCH):
            self.memo.update(zip([(q, d) for d in new[i : i + TEI_MAX_BATCH]], await self.r.score_with_logits(q, new[i : i + TEI_MAX_BATCH])))
        return [self.memo[(q, d)] for d in docs]

    async def score(self, q: str, docs: list[str]) -> list[float]:
        return [s for s, _ in await self.score_with_logits(q, docs)]


def memo_candidates(store: Store) -> Store:
    """Sweep-only: candidates depend on (query, depth) alone, so each is fetched once across ranking configs."""
    memo, fetch = {}, store.candidates

    async def candidates(qv, q, k=50):
        if (q, k) not in memo:
            memo[q, k] = await fetch(qv, q, k)
        return memo[q, k]
    store.candidates = candidates
    return store


def sr_dev() -> list[tuple]:
    """The SkillRet dev sample: SR_DEV_N train queries by sha256(id), against the train skills."""
    _, queries, qrels = skillret("train")
    return [(q["id"], q["query"], qrels[q["id"]]) for q in sorted(queries, key=lambda q: hashlib.sha256(q["id"].encode()).hexdigest())[:SR_DEV_N]]


async def embed_all(embedder: Embedder, queries: list[str]) -> tuple[np.ndarray, float]:
    """Query vectors in batches of 32 (reused across modes and sweep configs) + amortized ms per query."""
    t = time.perf_counter()
    vecs = [v for i in range(0, len(queries), TEI_MAX_BATCH) for v in await embedder.embed(queries[i : i + TEI_MAX_BATCH], "query")]
    return np.array(vecs), (time.perf_counter() - t) * 1000 / max(len(queries), 1)


async def run_set(ctx: Ctx, items: list[tuple], qvs: np.ndarray, depth: int, rerank_top: int, modes: bool = True,
                  ranking: dict | None = None) -> list[dict]:
    """Per query, sequentially (latency is per stage, so no concurrency): dense order, hybrid order (RRF of dense and
    keyword ids, no rerank), full = search() as shipped (`considered` = reranked order before the gate cut)."""
    out = []
    for (qid, q, gold), qv in zip(items, qvs):
        row = {"id": qid, "gold": gold}
        if modes:
            dense, sparse = await ctx.store.candidates(qv, q, depth)
            row["dense"] = [c for c, _ in dense]
            row["hybrid"] = [c for c, _ in sorted(rrf([row["dense"], [c for c, _ in sparse]]).items(), key=lambda x: -x[1])]
        res = await search(q, ctx, qv=qv, k=cfg()["k"], depth=depth, rerank_top=rerank_top, abstain_below=cfg()["abstain_below"], ranking=ranking)
        row.update(full=[h.cap_id for h in res.considered], abstained=res.abstained, p=res.p, x=gate.features(res, q), s=gate.first_scores(res), ms=res.ms)
        out.append(row)
    return out


def run_dict(rows: list[dict], mode: str, gated: bool = False) -> dict[str, dict[str, float]]:
    """One mode's ranking per query as a ranx run (score = 1 / rank); gated = an abstained query retrieves nothing."""
    return {r["id"]: {} if gated and r["abstained"] else {c: 1 / i for i, c in enumerate(r[mode], 1)} for r in rows}


def scores(rows: list[dict], mode: str, gated: bool = False) -> dict[str, float]:
    """ranx metrics; gated = an abstained query retrieves nothing (what the user gets)."""
    qrels = Qrels.from_dict({r["id"]: r["gold"] for r in rows})
    run = Run.from_dict(run_dict(rows, mode, gated))
    return {m: round(float(v), 4) for m, v in evaluate(qrels, run, METRICS, make_comparable=True).items()}


def compare_runs(qrels: dict, runs: dict[str, dict], split: str = "test") -> list[dict]:
    """Paired two-sided Student's t per query (ranx.compare) for every pair in `runs` (name -> {qid: {doc: score}}), in
    dict order, A first: delta = mean(A) - mean(B). One row per pair and metric (contracts/knobs-and-eval.md).
    sig_0.01 is ranx's own flag; sig_0.05 is the same p-value against 0.05. Identical runs have no variance: p = 1.
    ponytail: no multiple-comparison correction across pairs; read p with that many pairs in mind."""
    report = compare(Qrels.from_dict(qrels), [Run.from_dict(r, name=n) for n, r in runs.items()], CMP_METRICS,
                     stat_test="student", max_p=0.01, make_comparable=True)
    names, rows = list(runs), []
    for i, a in enumerate(names):
        for b in names[i + 1 :]:
            for m in CMP_METRICS:
                c = report.comparisons[a, b][m]
                p = 1.0 if np.isnan(c["p_value"]) else float(c["p_value"])
                rows.append({"a": a, "b": b, "metric": m, "split": split, "delta": round(report.results[a][m] - report.results[b][m], 4),
                             "p": p, "sig_0.01": bool(c["significant"]), "sig_0.05": p <= 0.05})
    return rows


def compare_rows(rows: list[dict], modes: list[str], split: str = "test") -> list[dict]:
    return compare_runs({r["id"]: r["gold"] for r in rows}, {m: run_dict(rows, m) for m in modes}, split)


def compare_table(rows: list[dict]) -> list[str]:
    yn = lambda b: "yes" if b else "no"
    return ["| A | B | metric | split | Δ (A − B) | p | p ≤ 0.01 | p ≤ 0.05 |", "|---|---|---|---|---|---|---|---|",
            *[f"| {r['a']} | {r['b']} | {r['metric']} | {r['split']} | {r['delta']:+.4f} | {r['p']:.3g} | {yn(r['sig_0.01'])} | {yn(r['sig_0.05'])} |" for r in rows]]


def fired(rows: list[dict], mode: str) -> float:
    """Share of rows that got a suggestion: only full+gate can abstain; the other modes fire whenever they have a hit."""
    return round(float(np.mean([not r["abstained"] if mode == "full+gate" else bool(r[mode]) for r in rows])), 4) if rows else 0.0


def recall5(r: dict) -> float:
    return len(set(r["full"][:5]) & set(r["gold"])) / len(r["gold"])


def latency(rows: list[dict]) -> dict[str, list[float]]:
    stages = {s: [r["ms"].get(s, 0.0) for r in rows] for s in ("candidates", "filter", "rerank")}
    stages["search"] = [sum(v) for v in zip(*stages.values())]
    return {s: [round(float(np.percentile(v, 50)), 1), round(float(np.percentile(v, 95)), 1)] for s, v in stages.items()}


async def opened(*schemas: str) -> tuple[Embedder, Reranker, list[Store]]:
    c = cfg()
    stores = [await Store.open(c["database_url"], s) for s in schemas]
    return Embedder(c["embed_url"], max(c["batch_timeout_s"], 300)), Reranker(c["rerank_url"], c["batch_timeout_s"]), stores  # ponytail: a 32-batch of 24k-char bodies outlasts the daemon's 60 s


async def closed(embedder: Embedder, reranker: Reranker, stores: list[Store]) -> None:
    for s in stores:
        await s.close()
    await embedder.aclose()
    await reranker.aclose()


async def index_skillret() -> None:
    """Index SkillRet under the configured text mode (--text): `current` -> ctc_skillret*, `skillret` -> ctc_skillret*_sk."""
    embedder, reranker, stores = await opened(*map(sr_schema, SKILLRET))
    try:
        done = {}
        for split, store in zip(SKILLRET, stores):
            diff = await store.upsert(skillret_caps(skillret(split)[0]), ["skillret"])  # idempotent: unchanged rows are skipped
            n = await build_index(store, embedder)
            done[store.schema] = {"added": len(diff.added), "changed": len(diff.changed), "removed": len(diff.removed), "embedded": n, "counts": await store.counts()}
            print(f"{store.schema}: +{len(diff.added)} ~{len(diff.changed)} -{len(diff.removed)}, embedded {n}, {done[store.schema]['counts']}")
        REPORTS.mkdir(parents=True, exist_ok=True)
        (REPORTS / f"index-skillret-{cfg()['embed']['text']}-{TODAY}.json").write_text(json.dumps({"header": header(), "schemas": done}, indent=1))
    finally:
        await closed(embedder, reranker, stores)


async def index_own() -> None:
    """Index this machine's library (the scan K1 labels against) under the configured text mode into ctc_own[_sk]. A1's summary and
    triggers come by id from the live index, read-only, when CTC_LIVE_DATABASE_URL is set (so `current` text is not handicapped).
    ponytail: ids new since the last live A1 pass stay un-enriched."""
    embedder, reranker, (store,) = await opened(own_schema())
    try:
        caps, _ = scan_library(default_roots(Path.cwd()))
        diff = await store.upsert(caps, sorted({c.namespace for c in caps}))
        enriched = 0
        if dsn := os.environ.get("CTC_LIVE_DATABASE_URL"):
            def read():
                with psycopg.connect(dsn) as conn:
                    conn.read_only = True
                    return conn.execute("select id, summary, triggers, enricher_version from ctc.capabilities where summary is not null").fetchall()
            rows = [r for r in await asyncio.to_thread(read) if r[0] in store.catalog]
            await store.executemany("update capabilities set summary = %s, triggers = %s, enricher_version = %s where id = %s", [(s, t, v, i) for i, s, t, v in rows])
            enriched = len(rows)
        n = await build_index(store, embedder)
        done = {"added": len(diff.added), "changed": len(diff.changed), "removed": len(diff.removed), "enriched": enriched, "embedded": n, "counts": await store.counts()}
        print(f"{store.schema}: {done}")
        save(f"index-own-{cfg()['embed']['text']}-{TODAY}.json", {"header": header(), "schema": store.schema, **done})
    finally:
        await closed(embedder, reranker, [store])


def threshold_at_ft(p: np.ndarray, y: np.ndarray, cap: float = MAX_FT) -> float | None:
    """Lowest out-of-fold p whose false-trigger rate on the negatives (y == 0) is <= cap: the lowest threshold keeps the most
    suggestions. None = no p meets the cap, so the gate never fires."""
    neg = p[y == 0]
    return next((float(t) for t in np.sort(p) if np.mean(neg >= t) <= cap), None)


def by_lang(fire: np.ndarray, d: dict, label: int) -> dict[str, list[int]]:
    """{lang: [fired, rows]} among the rows with this label."""
    out = {}
    for lg in LANGS:
        m = (d["y"] == label) & (d["lang"] == lg)
        out[lg] = [int(fire[m].sum()), int(m.sum())]
    return out


def gate_candidates(dev: dict, test: dict) -> tuple[list[dict], dict]:
    """The abstain candidates off, margin, platt, isotonic, lr: everything is fitted and thresholded on `dev`; `test` is only
    scored with the dev threshold. A split is {"top1", "top2" (first-stage scores: fused, else dense), "x" (gate.FEATURES rows),
    "y" (1 = SkillRet query, some skill should fire; 0 = MetaTool no-tool prompt), "lang"}. Returns (one row per candidate in the
    contracts/knobs-and-eval.md "Gate section" shape + meets_sc003 + fired/rows per language on test, {kind: (model, threshold)}).
    ECE is out-of-fold on dev; the threshold is the lowest with false-trigger <= MAX_FT on the dev negatives (out-of-fold p for
    the fitted gates, so it is not picked on rows the model memorized)."""
    y, ty = dev["y"], test["y"]
    cv = StratifiedKFold(5, shuffle=True, random_state=0)
    out, models = [], {}

    def add(kind: str, thr: float | None, ft_dev: float | None, fire: np.ndarray, **extra) -> None:
        sr, ft = float(fire[ty == 1].mean()), float(fire[ty == 0].mean())
        out.append({"kind": kind, "ece_before": None, "ece_after": None, "threshold": thr,
                    "false_trigger_dev": None if ft_dev is None else round(ft_dev, 4), "suggest_rate_test": round(sr, 4), "false_trigger_test": round(ft, 4),
                    **extra, "meets_sc003": sr >= SC003_SUGGEST and ft <= MAX_FT,
                    "by_lang_test": {"skillret": by_lang(fire, test, 1), "metatool": by_lang(fire, test, 0)}})

    def p_gate(kind: str, p_cv: np.ndarray, p_test: np.ndarray, **extra) -> float | None:
        """A gate that fires at P >= threshold: out-of-fold dev P `p_cv` picks the threshold, `p_test` is P on the test rows."""
        thr = threshold_at_ft(p_cv, y)
        add(kind, thr, None if thr is None else float(np.mean(p_cv[y == 0] >= thr)),
            np.zeros(len(ty), bool) if thr is None else p_test >= thr, ece_after=round(gate.ece(p_cv, y), 4), **extra)
        return thr

    add("off", None, 1.0, np.ones(len(ty), bool))  # abstain off: every prompt gets a suggestion
    ratio = next((r for r in MARGIN_RATIOS if gate.margin(dev["top1"], dev["top2"], r)[y == 0].mean() <= MAX_FT), None)
    add("margin", ratio, None if ratio is None else float(gate.margin(dev["top1"], dev["top2"], ratio)[y == 0].mean()),
        np.zeros(len(ty), bool) if ratio is None else gate.margin(test["top1"], test["top2"], ratio))
    for kind, fit in (("platt", gate.fit_platt), ("isotonic", gate.fit_isotonic)):
        p_cv = np.zeros(len(y))
        for tr, va in cv.split(dev["top1"], y):
            p_cv[va] = gate.calibrate(fit(dev["top1"][tr], y[tr]), dev["top1"][va])
        model = fit(dev["top1"], y)
        models[kind] = (model, p_gate(kind, p_cv, gate.calibrate(model, test["top1"]), ece_before=round(gate.ece(dev["top1"], y), 4)))
    # the pre-m8 gate: seven search-stage features, class_weight=balanced, raw feature units (retrieval/gate.py FEATURES)
    lr = LogisticRegression(class_weight="balanced", max_iter=5000)
    p_cv = cross_val_predict(lr, dev["x"], y, cv=cv, method="predict_proba")[:, 1]
    lr.fit(dev["x"], y)
    models["lr"] = (lr, p_gate("lr", p_cv, lr.predict_proba(test["x"])[:, 1]))
    return out, models


async def tune(limit: int | None = None) -> None:
    """K2 abstain-gate candidates on SkillRet (positives) vs MetaTool no-tool prompts (negatives), both searched against the
    same SkillRet catalog (dev: train skills, sample of SR_DEV_N queries; test: test skills, all queries) at the configured
    depth / rerank_top, so catalog shifts cannot leak into the gate. MetaTool dev/test = is_test(id), as in own_sets. Fit and
    threshold on dev; test is scored once. Writes data/reports/gate-<date>.json and models/gate-<kind>-<date>.joblib, never
    models/abstain.joblib or config. `limit` (>= 50) = smoke run on the first N rows of every set, writes nothing."""
    c = cfg()
    embedder, reranker, (sr_train, sr_test) = await opened(sr_schema("train"), sr_schema("test"))
    try:
        assert sr_train.catalog and sr_test.catalog, "run index-skillret first"
        _, queries, qrels = skillret("test")
        mt = [(m["id"], m["query"], {}) for m in metatool()]
        sets = {"dev": (sr_train, sr_dev()[:limit], [m for m in mt if not is_test(m[0])][:limit]),
                "test": (sr_test, [(q["id"], q["query"], qrels[q["id"]]) for q in queries][:limit], [m for m in mt if is_test(m[0])][:limit])}
        data = {}
        for split, (store, pos, neg) in sets.items():
            items = pos + neg
            qvs, _ = await embed_all(embedder, [q for _, q, _ in items])
            rows = await run_set(Ctx(store, embedder, reranker, NEUTRAL), items, qvs, c["depth"], c["rerank_top"], modes=False)
            data[split] = {"top1": np.array([r["s"][0] for r in rows]), "top2": np.array([r["s"][1] for r in rows]), "x": np.stack([r["x"] for r in rows]),
                           "y": np.array([1] * len(pos) + [0] * len(neg)), "lang": np.array([lang(q) for _, q, _ in items])}
            print(f"{split}: {len(pos)} SkillRet queries, {len(neg)} MetaTool prompts")
    finally:
        await closed(embedder, reranker, [sr_train, sr_test])
    cands, models = gate_candidates(data["dev"], data["test"])
    score = "fused" if c["ranking"]["fusion"] == "score" else "dense"
    sizes = {f"{name}_{split}": {"n": int((d["y"] == label).sum()), **{lg: int(((d["y"] == label) & (d["lang"] == lg)).sum()) for lg in LANGS}}
             for split, d in data.items() for name, label in (("skillret", 1), ("metatool", 0))}
    f = lambda v, spec=".3f": "-" if v is None else format(v, spec)
    print(f"first-stage score: {score}; depth {c['depth']} rerank_top {c['rerank_top']}; sizes {json.dumps(sizes)}")
    for r in cands:
        bl = r["by_lang_test"]
        print(f"{r['kind']:9} ECE {f(r['ece_before'])} -> {f(r['ece_after'])}  threshold {f(r['threshold'], '.4f')}  false-trigger dev {f(r['false_trigger_dev'], '.1%')}  "
              f"| test: suggest {r['suggest_rate_test']:.1%} (SkillRet)  false-trigger {r['false_trigger_test']:.1%} (MetaTool)  {'SC-003 ok' if r['meets_sc003'] else 'fails SC-003'}")
        print("          fired/rows by language: " + "; ".join(f"{n} " + " ".join(f"{lg} {a}/{b}" for lg, (a, b) in bl[n].items()) for n in bl))
    if limit:
        print(f"smoke run on {limit} rows per set: nothing written")
        return
    save(f"gate-{TODAY}.json", {"header": header(), "score": score, "depth": c["depth"], "rerank_top": c["rerank_top"], "sizes": sizes, "candidates": cands})
    (ROOT / "models").mkdir(exist_ok=True)
    for kind, (model, thr) in models.items():  # lr in the shape gate.load wants; platt / isotonic are over one score, so load() rejects them (no wiring yet)
        if thr is not None:
            joblib.dump({"kind": kind, "model": model, "threshold": thr, "features": gate.FEATURES if kind == "lr" else [f"top1_{score}"]}, ROOT / "models" / f"gate-{kind}-{TODAY}.joblib")
    print("wrote", REPORTS / f"gate-{TODAY}.json", "(models/abstain.joblib untouched)")


async def tune_ranking(fusion: str = "rrf", write: bool = True) -> None:
    """Final-order sweep on dev rows only (SkillRet train sample + own dev) at the configured depth / rerank_top.
    Winner = best SkillRet dev NDCG@10, then R@5, then own dev NDCG@10 (3 decimals); ties go to the lower weights.
    fusion "rrf": keyword_rrf_weight x rerank_weight; the winner goes into config/retrieval.yaml unless write is False.
    fusion "score": score_w in SCORE_WS at the configured rerank_weight, next to the configured rrf order as the reference;
    never writes the yaml (the winner is printed and saved to ranking-score-<date>.json, the config is changed by hand)."""
    c = cfg()
    embedder, reranker, (lib, sr) = await opened("ctc", sr_schema("train"))
    memo = MemoReranker(reranker)
    try:
        assert sr.catalog, "run index-skillret first"
        sets = {"skillret_dev": (sr, sr_dev()), "own_dev": (lib, own_sets(test=False)[0])}
        qvs = {n: (await embed_all(embedder, [q for _, q, _ in items]))[0] for n, (_, items) in sets.items()}
        ctxs = {n: Ctx(memo_candidates(store), embedder, memo, NEUTRAL) for n, (store, _) in sets.items()}
        base = {k: c["ranking"][k] for k in ("keyword_rrf_weight", "rerank_weight")}
        grid = ([{"keyword_rrf_weight": kw, "rerank_weight": rr} for kw in KW_WEIGHTS for rr in RERANK_WEIGHTS] if fusion == "rrf"
                else [{**base, "fusion": "rrf"}, *({**base, "fusion": "score", "score_w": w} for w in SCORE_WS)])
        label = lambda rk: f"score_w {rk['score_w']}" if rk.get("fusion") == "score" else f"kw {rk['keyword_rrf_weight']:4} rr {rk['rerank_weight']:4}"
        sweep, ref = [], {}
        for rk in grid:
            s = {}
            for n, (_, items) in sets.items():
                rows = await run_set(ctxs[n], items, qvs[n], c["depth"], c["rerank_top"], modes=not ref.get(n), ranking=rk)
                ref[n] = ref.get(n) or {m: scores(rows, m) for m in ("dense", "hybrid")}
                s[n] = scores(rows, "full")
            sweep.append({"ranking": rk, **s})
            print(f"{label(rk)}: SkillRet dev NDCG@10 {s['skillret_dev']['ndcg@10']:.4f} R@5 {s['skillret_dev']['recall@5']:.4f}, "
                  f"own dev NDCG@10 {s['own_dev']['ndcg@10']:.4f} R@5 {s['own_dev']['recall@5']:.4f}")
        key = lambda s: tuple(round(s[n][m], 3) for n, m in (("skillret_dev", "ndcg@10"), ("skillret_dev", "recall@5"), ("own_dev", "ndcg@10")))
        if fusion == "score":  # ponytail: the winner is the dev optimum, not tested against rrf; ranking-test (once, on test) does that
            win, rrf_cfg = max((s for s in sweep if s["ranking"]["fusion"] == "score"), key=key), sweep[0]
            f = lambda s: f"{s['skillret_dev']['ndcg@10']:.3f} / {s['skillret_dev']['recall@5']:.3f}"
            save(f"ranking-score-{TODAY}.json", {"header": header(), "winner": win["ranking"], "rrf_configured": rrf_cfg, "reference": ref, "sweep": sweep,
                                                 "depth": c["depth"], "rerank_top": c["rerank_top"]})
            print(f"winner {label(win['ranking'])}: SkillRet dev NDCG@10 / R@5 {f(win)} vs configured rrf {f(rrf_cfg)}, dense-only {f({n: r['dense'] for n, r in ref.items()})}; "
                  f"own dev NDCG@10 {win['own_dev']['ndcg@10']:.3f} vs {rrf_cfg['own_dev']['ndcg@10']:.3f}")
            print(f"config/retrieval.yaml NOT written; to adopt, set ranking: fusion: score, score_w: {win['ranking']['score_w']}")
            return
        win, old = max(sweep, key=key), next(s for s in sweep if s["ranking"] == OLD_RANKING)
        f = lambda s: f"{s['skillret_dev']['ndcg@10']:.3f} / {s['skillret_dev']['recall@5']:.3f}"
        note = (f"K2 ranking sweep {TODAY}, SkillRet dev ({len(sets['skillret_dev'][1])} train q) NDCG@10 / R@5: this {f(win)}, "
                f"old {{1, 1}} {f(old)}, dense-only {f({n: r['dense'] for n, r in ref.items()})}; own dev NDCG@10 {win['own_dev']['ndcg@10']:.3f} vs old {old['own_dev']['ndcg@10']:.3f}")
        path = ROOT / "config" / "retrieval.yaml"
        rk = win["ranking"]
        if write:
            text, n = re.subn(r"^ranking:.*$", f"ranking: {{keyword_rrf_weight: {rk['keyword_rrf_weight']}, rerank_weight: {rk['rerank_weight']}, fusion: {c['ranking']['fusion']}, "
                              f"score_w: {c['ranking']['score_w']}}}   # {note}",
                              path.read_text(), count=1, flags=re.MULTILINE)
            assert n == 1, f"ranking not in {path}"
            path.write_text(text)
            cfg.cache_clear()
        save(f"ranking-{TODAY}.json", {"header": header(), "winner": rk, "reference": ref, "sweep": sweep, "depth": c["depth"], "rerank_top": c["rerank_top"]})
        print("winner", rk, "->", path if write else "(config/retrieval.yaml not written: --no-write)")
    finally:
        await closed(embedder, reranker, [lib, sr])


async def ranking_test(limit: int | None = None) -> None:
    """SkillRet test, report only (never tunes): dense, plain hybrid, the old {1, 1} order and the configured ranking."""
    c = cfg()
    embedder, reranker, (sr,) = await opened(sr_schema("test"))
    try:
        _, queries, qrels = skillret("test")
        items = [(q["id"], q["query"], qrels[q["id"]]) for q in queries][:limit]
        qvs, _ = await embed_all(embedder, [q for _, q, _ in items])
        ctx = Ctx(memo_candidates(sr), embedder, MemoReranker(reranker), NEUTRAL)
        rows = await run_set(ctx, items, qvs, c["depth"], c["rerank_top"])
        for r, o in zip(rows, await run_set(ctx, items, qvs, c["depth"], c["rerank_top"], modes=False, ranking=OLD_RANKING)):
            r["old"] = o["full"]
        out = {"n": len(rows), "header": header(), "ranking": c["ranking"], "scores": {m: scores(rows, m) for m in ("dense", "hybrid", "old", "full")},
               "compare": compare_rows(rows, ["full", "dense", "old"])}  # full = the configured ranking
        print(json.dumps(out, indent=1))
        print("\n".join(["", "Paired significance (full = configured ranking, old = {1, 1}):", *compare_table(out["compare"])]))
        if not limit:
            path = REPORTS / f"ranking-{TODAY}.json"
            save(path.name, {**(json.loads(path.read_text()) if path.exists() else {}), "skillret_test": out})
    finally:
        await closed(embedder, reranker, [sr])


async def ablate(split: str, specs: list[str], limit: int | None = None, on: str = "skillret") -> None:
    """The same queries through several named variants in ONE process, so every pair gets a paired test (ranx.compare).
    A variant is `name=key:val,key:val` with keys text (current|skillret), body (chars), fusion (rrf|score), w (score_w), by (rerank_by: sigmoid|logit), kw / rw (keyword_rrf_weight / rerank_weight);
    keys it leaves out keep the config. dev = the SkillRet train sample (sr_dev) against the train schema; test = the
    4,392 test queries. `--on own`: the own-transcript rows with gold (split = their K1 split) against `index-own`'s library.
    Report only: nothing is written to config. Needs the variants' schemas indexed beforehand."""
    base_embed, base_ranking, c = dict(cfg()["embed"]), dict(cfg()["ranking"]), cfg()
    if on == "own":
        items = own_sets(test=split == "test")[0][:limit]
    elif split == "dev":
        items = sr_dev()[:limit]
    else:
        _, queries, qrels = skillret("test")
        items = [(q["id"], q["query"], qrels[q["id"]]) for q in queries][:limit]
    memo, names, rows_by, hdr = {}, [], {}, {}
    for spec in specs:
        name, _, kv = spec.partition("=")
        opts = dict(p.split(":", 1) for p in kv.split(",") if p)
        set_text_mode(opts.get("text"), int(opts["body"]) if "body" in opts else None)
        set_fusion(opts.get("fusion"), float(opts["w"]) if "w" in opts else None)
        if "by" in opts:
            cfg()["ranking"]["rerank_by"] = opts["by"]
        for key, field in (("kw", "keyword_rrf_weight"), ("rw", "rerank_weight")):
            if key in opts:
                cfg()["ranking"][field] = float(opts[key])
        embedder, reranker, (store,) = await opened(own_schema() if on == "own" else sr_schema("train" if split == "dev" else "test"))
        try:
            qvs, _ = await embed_all(embedder, [q for _, q, _ in items])
            mr = MemoReranker(reranker)
            mr.memo = memo  # (query, doc) -> (sigmoid, logit): shared, so a variant only pays for docs the others did not rerank
            ctx = Ctx(memo_candidates(store), embedder, mr, NEUTRAL)
            rows_by[name], hdr[name] = await run_set(ctx, items, qvs, c["depth"], c["rerank_top"]), header()
            names.append(name)
            print(f"{name}: {hdr[name]} {scores(rows_by[name], 'full')}", flush=True)
        finally:
            await closed(embedder, reranker, [store])
            cfg()["embed"].clear(); cfg()["embed"].update(base_embed)
            cfg()["ranking"].clear(); cfg()["ranking"].update(base_ranking)
    gold = {i: g for i, _, g in items}
    compare_rows_ = {m: compare_runs(gold, {f"{n}:{m}": run_dict(rows_by[n], m) for n in names}, split) for m in ("dense", "full")}
    out = {"split": split, "on": on, "n": len(items), "variants": {n: {"header": hdr[n], "scores": {m: scores(rows_by[n], m) for m in ("dense", "hybrid", "full")}} for n in names},
           "compare": compare_rows_}
    print(json.dumps(out, indent=1))
    for m, rs in compare_rows_.items():
        print("\n".join(["", f"Paired significance, {m} order ({split}):", *compare_table(rs)]))
    save(f"ablate-{split}{'-own' if on == 'own' else ''}-{TODAY}.json", out)


async def run(limit: int | None = None) -> None:
    c = cfg()
    embedder, reranker, (lib, sr) = await opened(own_schema(), sr_schema("test"))
    try:
        assert sr.catalog, "run index-skillret first"
        assert lib.catalog, "run index-own first"
        _, queries, qrels = skillret("test")
        pos, neg = own_sets(test=True)
        sets = {"skillret": (sr, [(q["id"], q["query"], qrels[q["id"]]) for q in queries][:limit]), "own": (lib, pos[:limit]), "none": (lib, neg[:limit])}
        out = {}
        for name, (store, items) in sets.items():
            qvs, embed_ms = await embed_all(embedder, [q for _, q, _ in items])
            rows = await run_set(Ctx(store, embedder, reranker, NEUTRAL), items, qvs, c["depth"], c["rerank_top"])
            out[name] = {"n": len(rows), "embed_ms": round(embed_ms, 1), "latency": latency(rows),
                         "fired": {m: fired(rows, m) for m in SHOWN}, "abstained": round(float(np.mean([r["abstained"] for r in rows])), 4)}
            if name != "none":
                out.setdefault("compare", {})[name] = compare_rows(rows, MODES)
            if name == "none":
                for part, keep in (("none_own", lambda i: not i.startswith("metatool:")), ("none_metatool", lambda i: i.startswith("metatool:"))):
                    out[part] = {"n": sum(keep(r["id"]) for r in rows), "fired": {m: fired([r for r in rows if keep(r["id"])], m) for m in SHOWN}}
            else:
                out[name]["scores"] = {m: scores(rows, m) for m in MODES} | {"full+gate": scores(rows, "full", gated=True)}
            print(name, json.dumps({k: v for k, v in out[name].items() if k != "latency"}))
        out["header"] = header()
        out["config"] = {k: c[k] for k in ("k", "depth", "rerank_top", "rrf_k", "ranking", "abstain_below", "gate_min_p")}
        out["gate"] = gate.load(c["gate_path"]) is not None
        out["library"] = {"ctc": {"schema": lib.schema, "capabilities": len(lib.catalog), "library_version": lib.library_version}, "skillret": len(sr.catalog),
                          "changed_during_run": await lib.compute_library_version() != lib.library_version}  # another process re-indexed
        REPORTS.mkdir(parents=True, exist_ok=True)
        (REPORTS / f"run-{TODAY}.json").write_text(json.dumps(out, indent=1))
        tuned = REPORTS / f"tune-{TODAY}.json"
        (REPORTS / f"report-{TODAY}.md").write_text(report(out, json.loads(tuned.read_text()) if tuned.exists() else None, limit))
        print("wrote", REPORTS / f"report-{TODAY}.md")
    finally:
        await closed(embedder, reranker, [lib, sr])


def report(out: dict, tune: dict | None, limit: int | None) -> str:
    def ok(cond: bool) -> str:
        return "pass" if cond else "**FAIL**"

    def table(name: str) -> list[str]:
        rows = ["| mode | Recall@1 | Recall@5 | Recall@10 | NDCG@10 | MRR | suggests |", "|---|---|---|---|---|---|---|"]
        label = {"dense": "dense only", "hybrid": "hybrid (RRF dense + keyword)", "full": f"full: shipped order {out['config']['ranking']}, gate off", "full+gate": "full + gate (shipped)"}
        for m, s in out[name]["scores"].items():
            rows.append(f"| {label[m]} | " + " | ".join(f"{s[k]:.3f}" for k in METRICS) + f" | {out[name]['fired'][m]:.0%} |")
        return rows

    sr, own, cf, h = out["skillret"]["scores"], out["own"]["scores"], out["config"], out["header"]
    ft = out["none"]["fired"]["full+gate"]
    lat = out["own"]["latency"]["search"][1] + out["own"]["embed_ms"]
    db = "Supabase (session pooler)" if "supabase" in (cfg()["database_url"] or "") else "local dev Postgres"
    L = [f"# Retrieval benchmark — {TODAY}", ""]
    if limit:
        L += [f"> **Smoke run: first {limit} queries per set only. Not a result.**", ""]
    L += [("> **Own-eval gold is LLM-judged (Qwen2.5-3B, step K1) and not yet hand-checked (H1).** The judge over-labels "
          "(often 5 ids, `ecc:*`-heavy), so Recall@k on own-eval is a noisy lower bound, and the gate was trained on the same "
          "noisy labels. Treat own-eval numbers as provisional until the owner's H1 check."), "",
          (f"Config used: k={cf['k']}, depth={cf['depth']}, rerank_top={cf['rerank_top']}, rrf_k={cf['rrf_k']}, "
          f"ranking={cf['ranking']} (keyword weight in the rerank pool, rerank weight in the final order), abstain_below={cf['abstain_below']}, gate {'on' if out['gate'] else 'off'} (gate_min_p={cf['gate_min_p']}). "
          f"Library `{out['library']['ctc'].get('schema', 'ctc')}`: {out['library']['ctc']['capabilities']} capabilities (library_version `{out['library']['ctc']['library_version']}`); "
          f"`ctc_skillret`: {out['library']['skillret']} skills. DB: {db}."), "",
          (f"Text mode `{h['text_mode']}`, query instruction `{h['instruction']}`, body cap {h['body_chars']}, fusion `{h['fusion']}` (score_w {h['score_w']})."
           + (" The own-transcript and gold-none sets query this machine's library as `index-own` embedded it under the same text mode."
              if out["library"]["ctc"].get("schema") else "")), "",
          *(["> **The `ctc` library changed during this run (another process re-indexed it): own-eval numbers are suspect.**", ""]
            if out["library"]["changed_during_run"] else []),
          "## Targets (PLAN.md)", "", "| target | measured | |", "|---|---|---|",
          (f"| Recall@5 ≥ 0.90 (own test, shipped) | {own['full+gate']['recall@5']:.3f} (gate off {own['full']['recall@5']:.3f}) | "
          f"{ok(own['full+gate']['recall@5'] >= 0.9)} (LLM-judged gold; target is on the 200 H1 rows) |"),
          f"| hybrid + rerank NDCG@10 ≥ dense-only (SkillRet test) | {sr['full']['ndcg@10']:.3f} vs {sr['dense']['ndcg@10']:.3f} | {ok(sr['full']['ndcg@10'] >= sr['dense']['ndcg@10'])} |",
          f"| false-trigger ≤ 10% (gold-none test rows) | {ft:.1%} (own {out['none_own']['fired']['full+gate']:.1%}, MetaTool {out['none_metatool']['fired']['full+gate']:.1%}) | {ok(ft <= MAX_FT)} |",
          "| GPU ≤ 7 GB | not re-measured (nvidia-smi does not list container PIDs to this user); R3: 6.4 GB | — |",
          f"| route p95 ≤ 150 ms cold | search p95 {out['own']['latency']['search'][1]} ms + embed {out['own']['embed_ms']} ms/query (batched) ≈ {lat:.0f} ms on {db} | indicative only; K3 measures `/v1/route` |",
          "| ≤ 15 ms Redis hit, ≤ 10 ms L1 hit, semantic cache hit rate | not measured here | K3 |",
          "| memory lift ≥ 0 · extraction precision ≥ 0.80 | not measured here | K4 / A3 |", "",
          f"## SkillRet test ({out['skillret']['n']} queries, 6,006 skills, neutral project)", "", *table("skillret"), "",
          f"The gate abstains on {out['skillret']['abstained']:.0%} of SkillRet queries (every one has a correct skill, so each abstain is a miss).", "",
          f"### Significance, SkillRet test (paired two-sided Student's t over {out['skillret']['n']} queries, ranx.compare; Δ = A − B)", "", *compare_table(out["compare"]["skillret"]), "",
          f"## Own transcripts, test split ({out['own']['n']} rows with gold, real library `ctc`)", "", *table("own"), "",
          ("4 of the 652 gold ids (all splits) point at `project@d63e3c8f:graphify`, a project-only skill of this repo; the queries come "
          "from other projects, so the neutral project filters it and those ids are unreachable."), "",
          f"### Significance, own test ({out['own']['n']} queries)", "", *compare_table(out["compare"]["own"]), "",
          f"## False triggers (gold-none test rows: {out['none_own']['n']} own + {out['none_metatool']['n']} MetaTool negatives)", "",
          "| mode | all | own none | MetaTool |", "|---|---|---|---|",
          *[f"| {m} | {out['none']['fired'][m]:.1%} | {out['none_own']['fired'][m]:.1%} | {out['none_metatool']['fired'][m]:.1%} |" for m in SHOWN],
          "", "Only full + gate can abstain; the other modes fire on every query with a candidate.", "",
          "## Latency per stage (ms, p50 / p95, sequential, shared TEI servers)", "",
          "| set | embed (batched, per query) | candidates | filter | rerank | search total |", "|---|---|---|---|---|---|",
          *[f"| {n} | {out[n]['embed_ms']} | " + " | ".join(f"{a} / {b}" for a, b in (out[n]['latency'][s] for s in ('candidates', 'filter', 'rerank', 'search'))) + " |"
            for n in ("skillret", "own", "none")], "",
          (f"`candidates`: dense search runs in RAM; only keywords + overrides go to the DB ({db}, one parallel hop). Queries are embedded 32 per "
          "request and reused across modes, so per-query embed latency is amortized, not a single-prompt number."), ""]
    if tune:
        g, sz = tune["gate"], tune["sizes"]
        L += ["## K2 tuning (dev rows only)", "",
              (f"Dev sizes: own-eval dev {sz['own_dev_gold']} with gold + {sz['own_dev_none']} gold-none, MetaTool dev half {sz['metatool_dev']} "
              f"(sha256(id) % 2 == 0), SkillRet dev sample {sz['skillret_dev']} train queries against the 10,123 train skills "
              f"(`ctc_skillret_train`; SkillRet test was never used for tuning). Test sizes: own-eval {out['own']['n']} with gold + "
              f"{out['none_own']['n']} gold-none, MetaTool test half {out['none_metatool']['n']}, SkillRet test {out['skillret']['n']}."), "",
              "| depth | rerank_top | own dev R@5 | own dev NDCG@10 | SkillRet dev R@5 | SkillRet dev NDCG@10 | |", "|---|---|---|---|---|---|---|",
              *[f"| {s['depth']} | {s['rerank_top']} | {s['own_dev']['recall@5']:.3f} | {s['own_dev']['ndcg@10']:.3f} | {s['skillret_dev']['recall@5']:.3f} | "
                f"{s['skillret_dev']['ndcg@10']:.3f} | "
                + ("**winner**" if (s["depth"], s["rerank_top"]) == (tune["winner"]["depth"], tune["winner"]["rerank_top"]) else "" if s["eligible"] else "not eligible (> 32 docs: TEI 413)") + " |"
                for s in tune["sweep"]], "",
              ("Winner = best SkillRet dev Recall@5, then own dev Recall@5 (3 decimals, gate off), ties to the cheaper config. rerank_top 40 was measured with an "
              "eval-side reranker that splits requests at 32; the shipped `Reranker.score` sends one request and TEI rejects > 32 texts "
              "(HTTP 413), so 40 cannot be shipped until it chunks."), "",
              (f"**Abstain gate** (`models/abstain.joblib`{'' if g.get('saved', True) else f', **not saved**: CV AUC < {MIN_AUC}'}, LogisticRegression, class_weight=balanced, raw feature units): trained on "
              f"{g['n_pos']} positives ({g.get('n_pos_skillret', 0)} SkillRet dev + own dev with gold) vs {g['n_neg']} negatives ({g['n_neg_own']} own dev gold-none + MetaTool dev), "
              f"features from search() at the winning config. Threshold {g['threshold']} = lowest out-of-fold (5-fold) probability with dev "
              f"false-trigger ≤ 10%: out-of-fold dev false-trigger {g['cv']['false_trigger']:.1%}, dev Recall@5 {g['cv']['recall@5']:.3f} "
              f"(fires on {g['cv']['fire_rate_pos']:.0%} of positives); in-sample {g['in_sample']['false_trigger']:.1%} / {g['in_sample']['recall@5']:.3f}."), "",
              f"Out-of-fold ROC AUC {g['auc_cv']:.3f}; dev Recall@5 without the gate {g['recall@5_ungated']:.3f}.", "",
              "| feature | coefficient | mean, positives | mean, negatives |", "|---|---|---|---|",
              *[f"| {f} | {c:+.4f} | {a:.4f} | {b:.4f} |" for f, c, a, b in zip(g["features"], g["coef"], g["mean_pos"], g["mean_neg"])],
              f"| intercept | {g['intercept']:+.4f} | | |", "",
              ("`abstain_below` (rerank-score floor) stays null: bge-reranker-v2-m3's absolute scores carry no signal for tool matching "
              "(CLAUDE.md, 2026-10-21), so the gate replaces the PLAN's abstain_below sweep. Qwen3-Reranker-0.6B was not tried (no GPU budget)."), ""]
    L += ["## Not run", "", ("- **bge-m3 dense baseline: skipped.** It needs a second embedding model on the GPU and our 7 GB budget is full "
          "(embedder + reranker + llama-server ≈ 6.4 GB). Only SKILLRET-Embedding-0.6B is reported."), ""]
    return "\n".join(L)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(usage=__doc__, add_help=False)
    ap.add_argument("cmd", nargs="?", default="")
    ap.add_argument("limit", nargs="?", type=int)
    ap.add_argument("--text", choices=["current", "skillret"])
    ap.add_argument("--body-chars", type=int)
    ap.add_argument("--fusion", choices=["rrf", "score"])
    ap.add_argument("--score-w", type=float)
    ap.add_argument("--no-write", action="store_true")
    ap.add_argument("--split", choices=["dev", "test"], default="test")
    ap.add_argument("--variant", action="append", default=[])
    ap.add_argument("--on", choices=["skillret", "own"], default="skillret")
    args = ap.parse_args()
    set_text_mode(args.text, args.body_chars)
    set_fusion(args.fusion, args.score_w)
    cmd = args.cmd
    if cmd == "index-skillret":
        asyncio.run(index_skillret())
    elif cmd == "index-own":
        asyncio.run(index_own())
    elif cmd == "tune":
        asyncio.run(tune(args.limit))
    elif cmd == "ranking":
        asyncio.run(tune_ranking(args.fusion or "rrf", not args.no_write))
    elif cmd == "ranking-test":
        asyncio.run(ranking_test(args.limit))
    elif cmd == "ablate":
        asyncio.run(ablate(args.split, args.variant, args.limit, args.on))
    elif cmd == "run":
        asyncio.run(run(args.limit))
    else:
        sys.exit(__doc__)
