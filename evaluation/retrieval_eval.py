"""K1 retrieval benchmark + K2 tuning (PLAN.md K1, K2, Targets): ranx metrics per mode, abstain gate, report.

uv run python -m evaluation.retrieval_eval index-skillret   # SkillRet test (6,006) -> ctc_skillret, train (10,123) -> ctc_skillret_train
uv run python -m evaluation.retrieval_eval tune             # DEV ONLY: depth x rerank_top sweep + abstain gate -> config, models/
uv run python -m evaluation.retrieval_eval run [limit]      # TEST: three modes on SkillRet, own-eval, gold-none -> data/reports/
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import sys
import time
from datetime import date

import joblib
import numpy as np
from ranx import Qrels, Run, evaluate
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import StratifiedKFold, cross_val_predict

from ctc.config import ROOT, cfg
from ctc.embedding.embedder import Embedder
from ctc.ingestion.indexer import build_index
from ctc.reranking.reranker import Reranker
from ctc.retrieval import gate
from ctc.retrieval.hybrid import Ctx, rrf, search
from ctc.storage.store import Store
from evaluation.loaders import metatool, skillret, skillret_caps

METRICS = ["recall@1", "recall@5", "recall@10", "ndcg@10", "mrr"]
MODES = ["dense", "hybrid", "full"]
SHOWN = [*MODES, "full+gate"]  # full+gate = what the user gets: an abstained query retrieves nothing
SKILLRET = {"test": "ctc_skillret", "train": "ctc_skillret_train"}  # train skills only serve the dev sample (disjoint qrels)
NEUTRAL = "/nonexistent/ctc-eval"  # project dir with no project capabilities and no overrides: nothing is project-filtered
REPORTS = ROOT / "data" / "reports"
TODAY = date.today().isoformat()
DEPTHS, RERANK_TOPS, MAX_FT, SR_DEV_N = (25, 50, 100), (10, 20, 40), 0.10, 500
TEI_MAX_BATCH = 32  # TEI max_client_batch_size: the shipped Reranker sends one request, so rerank_top > 32 gets HTTP 413


def is_test(qid: str) -> bool:  # same rule as the labeler's session split, for MetaTool rows
    return int(hashlib.sha256(qid.encode()).hexdigest(), 16) % 2 == 1


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

    async def score(self, q: str, docs: list[str]) -> list[float]:
        new = [d for d in dict.fromkeys(docs) if (q, d) not in self.memo]
        for i in range(0, len(new), TEI_MAX_BATCH):
            self.memo.update(zip([(q, d) for d in new[i : i + TEI_MAX_BATCH]], await self.r.score(q, new[i : i + TEI_MAX_BATCH])))
        return [self.memo[(q, d)] for d in docs]


async def embed_all(embedder: Embedder, queries: list[str]) -> tuple[np.ndarray, float]:
    """Query vectors in batches of 32 (reused across modes and sweep configs) + amortized ms per query."""
    t = time.perf_counter()
    vecs = [v for i in range(0, len(queries), TEI_MAX_BATCH) for v in await embedder.embed(queries[i : i + TEI_MAX_BATCH], "query")]
    return np.array(vecs), (time.perf_counter() - t) * 1000 / max(len(queries), 1)


async def run_set(ctx: Ctx, items: list[tuple], qvs: np.ndarray, depth: int, rerank_top: int, modes: bool = True) -> list[dict]:
    """Per query, sequentially (latency is per stage, so no concurrency): dense order, hybrid order (RRF of dense and
    keyword ids, no rerank), full = search() as shipped (`considered` = reranked order before the gate cut)."""
    out = []
    for (qid, q, gold), qv in zip(items, qvs):
        row = {"id": qid, "gold": gold}
        if modes:
            dense, sparse = await ctx.store.candidates(qv, q, depth)
            row["dense"] = [c for c, _ in dense]
            row["hybrid"] = [c for c, _ in sorted(rrf([row["dense"], [c for c, _ in sparse]]).items(), key=lambda x: -x[1])]
        res = await search(q, ctx, qv=qv, k=cfg()["k"], depth=depth, rerank_top=rerank_top, abstain_below=cfg()["abstain_below"])
        row.update(full=[h.cap_id for h in res.considered], abstained=res.abstained, p=res.p, x=gate.features(res, q), ms=res.ms)
        out.append(row)
    return out


def scores(rows: list[dict], mode: str, gated: bool = False) -> dict[str, float]:
    """ranx metrics; gated = an abstained query retrieves nothing (what the user gets)."""
    qrels = Qrels.from_dict({r["id"]: r["gold"] for r in rows})
    run = Run.from_dict({r["id"]: {} if gated and r["abstained"] else {c: 1 / i for i, c in enumerate(r[mode], 1)} for r in rows})
    return {m: round(float(v), 4) for m, v in evaluate(qrels, run, METRICS, make_comparable=True).items()}


def fired(rows: list[dict], mode: str) -> float:
    """Share of rows that got a suggestion: only full+gate can abstain; the other modes fire whenever they have a hit."""
    return round(float(np.mean([not r["abstained"] if mode == "full+gate" else bool(r[mode]) for r in rows])), 4) if rows else 0.0


def recall5(r: dict) -> float:
    return len(set(r["full"][:5]) & set(r["gold"])) / len(r["gold"])


def latency(rows: list[dict]) -> dict[str, list[float]]:
    stages = {s: [r["ms"].get(s, 0.0) for r in rows] for s in ("candidates", "filter", "rerank")}
    stages["search"] = [sum(v) for v in zip(*stages.values())]
    return {s: [round(float(np.percentile(v, 50)), 1), round(float(np.percentile(v, 95)), 1)] for s, v in stages.items()}


def write_config(depth: int, rerank_top: int, threshold: float) -> None:
    """Winners into config/retrieval.yaml; only the value is replaced, comments stay."""
    path = ROOT / "config" / "retrieval.yaml"
    text = path.read_text()
    for key, val in (("depth", depth), ("rerank_top", rerank_top), ("gate_min_p", threshold)):
        def put(m: re.Match, val: str = str(val)) -> str:  # keep a trailing comment in its column
            return m[1] + val + (" " * max(1, len(m[2]) + len(m[3]) - len(val)) if m[3] else "")
        text, n = re.subn(rf"^({key}:\s*)([^\s#]+)([ \t]*)", put, text, count=1, flags=re.MULTILINE)
        assert n == 1, f"{key} not in {path}"
    path.write_text(text)
    cfg.cache_clear()


async def opened(*schemas: str) -> tuple[Embedder, Reranker, list[Store]]:
    c = cfg()
    stores = [await Store.open(c["database_url"], s) for s in schemas]
    return Embedder(c["embed_url"], c["batch_timeout_s"]), Reranker(c["rerank_url"], c["batch_timeout_s"]), stores


async def closed(embedder: Embedder, reranker: Reranker, stores: list[Store]) -> None:
    for s in stores:
        await s.close()
    await embedder.aclose()
    await reranker.aclose()


async def index_skillret() -> None:
    embedder, reranker, stores = await opened(*SKILLRET.values())
    try:
        for (split, _), store in zip(SKILLRET.items(), stores):
            diff = await store.upsert(skillret_caps(skillret(split)[0]), ["skillret"])  # idempotent: unchanged rows are skipped
            n = await build_index(store, embedder)
            print(f"{store.schema}: +{len(diff.added)} ~{len(diff.changed)} -{len(diff.removed)}, embedded {n}, {await store.counts()}")
    finally:
        await closed(embedder, reranker, stores)


async def tune() -> None:
    """K2 on dev rows only: sweep depth x rerank_top (own dev + SkillRet train sample), then fit the abstain gate."""
    embedder, reranker, (lib, sr) = await opened("ctc", SKILLRET["train"])
    memo = MemoReranker(reranker)
    own_ctx, sr_ctx = Ctx(lib, embedder, memo, NEUTRAL), Ctx(sr, embedder, memo, NEUTRAL)
    try:
        assert sr.catalog, "run index-skillret first"
        pos, neg = own_sets(test=False)
        _, queries, qrels = skillret("train")
        sample = sorted(queries, key=lambda q: hashlib.sha256(q["id"].encode()).hexdigest())[:SR_DEV_N]
        sr_items = [(q["id"], q["query"], qrels[q["id"]]) for q in sample]
        qv_pos, qv_neg, qv_sr = [(await embed_all(embedder, [q for _, q, _ in items]))[0] for items in (pos, neg, sr_items)]
        sweep = []
        for depth in DEPTHS:
            for rt in RERANK_TOPS:
                rows = await run_set(own_ctx, pos, qv_pos, depth, rt, modes=False)
                sr_rows = await run_set(sr_ctx, sr_items, qv_sr, depth, rt, modes=False)
                own_s, sr_s = scores(rows, "full"), scores(sr_rows, "full")
                sweep.append({"depth": depth, "rerank_top": rt, "own_dev": own_s, "skillret_dev": sr_s, "eligible": rt <= TEI_MAX_BATCH, "rows": rows})
                print(f"depth {depth:3} rerank_top {rt:2}: own dev R@5 {own_s['recall@5']:.3f}, SkillRet dev R@5 {sr_s['recall@5']:.3f}")
        # best mean dev Recall@5; ties go to the cheaper config (sweep order is ascending cost)
        win = max((s for s in sweep if s["eligible"]), key=lambda s: round((s["own_dev"]["recall@5"] + s["skillret_dev"]["recall@5"]) / 2, 3))
        pos_rows = win.pop("rows")
        neg_rows = await run_set(own_ctx, neg, qv_neg, win["depth"], win["rerank_top"], modes=False)
        for s in sweep:
            s.pop("rows", None)

        # abstain gate: positives = own dev rows with gold, negatives = own dev gold-none + MetaTool dev half
        X = np.stack([r["x"] for r in pos_rows + neg_rows])
        y = np.array([1] * len(pos_rows) + [0] * len(neg_rows))
        model = LogisticRegression(class_weight="balanced", max_iter=5000)
        # threshold from out-of-fold probabilities, so it is not picked on the rows the model memorized
        p_cv = cross_val_predict(model, X, y, cv=StratifiedKFold(5, shuffle=True, random_state=0), method="predict_proba")[:, 1]
        model.fit(X, y)
        r5 = np.array([recall5(r) for r in pos_rows])
        # Recall@5 only falls as the threshold rises, so the lowest threshold within the false-trigger cap is the best one
        threshold = round(next(float(t) for t in np.sort(p_cv) if np.mean(p_cv[y == 0] >= t) <= MAX_FT), 4)

        def at(p: np.ndarray) -> dict:
            return {"false_trigger": round(float(np.mean(p[y == 0] >= threshold)), 4),
                    "recall@5": round(float(np.mean(r5 * (p[y == 1] >= threshold))), 4), "fire_rate_pos": round(float(np.mean(p[y == 1] >= threshold)), 4)}

        (ROOT / "models").mkdir(exist_ok=True)
        joblib.dump({"model": model, "threshold": threshold, "features": gate.FEATURES}, ROOT / cfg()["gate_path"])
        write_config(win["depth"], win["rerank_top"], threshold)
        result = {"sweep": sweep, "winner": {"depth": win["depth"], "rerank_top": win["rerank_top"]},
                  "gate": {"threshold": threshold, "features": gate.FEATURES, "coef": model.coef_[0].round(4).tolist(),
                           "intercept": round(float(model.intercept_[0]), 4), "n_pos": int(y.sum()), "n_neg": int(len(y) - y.sum()),
                           "n_neg_own": sum(not i.startswith("metatool:") for i, _, _ in neg), "cv": at(p_cv), "in_sample": at(model.predict_proba(X)[:, 1]),
                           "auc_cv": round(float(roc_auc_score(y, p_cv)), 4), "mean_pos": X[y == 1].mean(0).round(4).tolist(),
                           "mean_neg": X[y == 0].mean(0).round(4).tolist(), "recall@5_ungated": round(float(r5.mean()), 4)},
                  "sizes": {"own_dev_gold": len(pos), "own_dev_none": sum(not i.startswith("metatool:") for i, _, _ in neg),
                            "metatool_dev": sum(i.startswith("metatool:") for i, _, _ in neg), "skillret_dev": len(sr_items)}}
        REPORTS.mkdir(parents=True, exist_ok=True)
        (REPORTS / f"tune-{TODAY}.json").write_text(json.dumps(result, indent=1))
        print(json.dumps({k: result[k] for k in ("winner", "gate", "sizes")}, indent=1))
    finally:
        await closed(embedder, reranker, [lib, sr])


async def run(limit: int | None = None) -> None:
    c = cfg()
    embedder, reranker, (lib, sr) = await opened("ctc", SKILLRET["test"])
    try:
        assert sr.catalog, "run index-skillret first"
        _, queries, qrels = skillret("test")
        pos, neg = own_sets(test=True)
        sets = {"skillret": (sr, [(q["id"], q["query"], qrels[q["id"]]) for q in queries][:limit]), "own": (lib, pos[:limit]), "none": (lib, neg[:limit])}
        out = {}
        for name, (store, items) in sets.items():
            qvs, embed_ms = await embed_all(embedder, [q for _, q, _ in items])
            rows = await run_set(Ctx(store, embedder, reranker, NEUTRAL), items, qvs, c["depth"], c["rerank_top"])
            out[name] = {"n": len(rows), "embed_ms": round(embed_ms, 1), "latency": latency(rows),
                         "fired": {m: fired(rows, m) for m in SHOWN}, "abstained": round(float(np.mean([r["abstained"] for r in rows])), 4)}
            if name == "none":
                for part, keep in (("none_own", lambda i: not i.startswith("metatool:")), ("none_metatool", lambda i: i.startswith("metatool:"))):
                    out[part] = {"n": sum(keep(r["id"]) for r in rows), "fired": {m: fired([r for r in rows if keep(r["id"])], m) for m in SHOWN}}
            else:
                out[name]["scores"] = {m: scores(rows, m) for m in MODES} | {"full+gate": scores(rows, "full", gated=True)}
            print(name, json.dumps({k: v for k, v in out[name].items() if k != "latency"}))
        out["config"] = {k: c[k] for k in ("k", "depth", "rerank_top", "rrf_k", "abstain_below", "gate_min_p")}
        out["gate"] = gate.load(c["gate_path"]) is not None
        out["library"] = {"ctc": {"capabilities": len(lib.catalog), "library_version": lib.library_version}, "skillret": len(sr.catalog),
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
        label = {"dense": "dense only", "hybrid": "hybrid (RRF dense + keyword)", "full": "full: hybrid + rerank, gate off", "full+gate": "full + gate (shipped)"}
        for m, s in out[name]["scores"].items():
            rows.append(f"| {label[m]} | " + " | ".join(f"{s[k]:.3f}" for k in METRICS) + f" | {out[name]['fired'][m]:.0%} |")
        return rows

    sr, own, cf = out["skillret"]["scores"], out["own"]["scores"], out["config"]
    ft = out["none"]["fired"]["full+gate"]
    lat = out["own"]["latency"]["search"][1] + out["own"]["embed_ms"]
    L = [f"# Retrieval benchmark — {TODAY}", ""]
    if limit:
        L += [f"> **Smoke run: first {limit} queries per set only. Not a result.**", ""]
    L += [("> **Own-eval gold is LLM-judged (Qwen2.5-3B, step K1) and not yet hand-checked (H1).** The judge over-labels "
          "(often 5 ids, `ecc:*`-heavy), so Recall@k on own-eval is a noisy lower bound, and the gate was trained on the same "
          "noisy labels. Treat own-eval numbers as provisional until the owner's H1 check."), "",
          (f"Config used: k={cf['k']}, depth={cf['depth']}, rerank_top={cf['rerank_top']}, rrf_k={cf['rrf_k']}, "
          f"abstain_below={cf['abstain_below']}, gate {'on' if out['gate'] else 'off'} (gate_min_p={cf['gate_min_p']}). "
          f"Library `ctc`: {out['library']['ctc']['capabilities']} capabilities (library_version `{out['library']['ctc']['library_version']}`); "
          f"`ctc_skillret`: {out['library']['skillret']} skills. Dev DB `ctc-dev-pg` on localhost (no Supabase hop yet)."), "",
          *(["> **The `ctc` library changed during this run (another process re-indexed it): own-eval numbers are suspect.**", ""]
            if out["library"]["changed_during_run"] else []),
          "## Targets (PLAN.md)", "", "| target | measured | |", "|---|---|---|",
          (f"| Recall@5 ≥ 0.90 (own test, shipped) | {own['full+gate']['recall@5']:.3f} (gate off {own['full']['recall@5']:.3f}) | "
          f"{ok(own['full+gate']['recall@5'] >= 0.9)} (LLM-judged gold; target is on the 200 H1 rows) |"),
          f"| hybrid + rerank NDCG@10 ≥ dense-only (SkillRet test) | {sr['full']['ndcg@10']:.3f} vs {sr['dense']['ndcg@10']:.3f} | {ok(sr['full']['ndcg@10'] >= sr['dense']['ndcg@10'])} |",
          f"| false-trigger ≤ 10% (gold-none test rows) | {ft:.1%} (own {out['none_own']['fired']['full+gate']:.1%}, MetaTool {out['none_metatool']['fired']['full+gate']:.1%}) | {ok(ft <= MAX_FT)} |",
          "| GPU ≤ 7 GB | not re-measured (nvidia-smi does not list container PIDs to this user); R3: 6.4 GB | — |",
          f"| route p95 ≤ 150 ms cold | search p95 {out['own']['latency']['search'][1]} ms + embed {out['own']['embed_ms']} ms/query (batched) ≈ {lat:.0f} ms on the local dev DB | indicative only; K3 measures `/v1/route` |",
          "| ≤ 15 ms Redis hit, ≤ 10 ms L1 hit, semantic cache hit rate | not measured here | K3 |",
          "| memory lift ≥ 0 · extraction precision ≥ 0.80 | not measured here | K4 / A3 |", "",
          f"## SkillRet test ({out['skillret']['n']} queries, 6,006 skills, neutral project)", "", *table("skillret"), "",
          (f"The gate abstains on {out['skillret']['abstained']:.0%} of SkillRet queries (every one has a correct skill): it was trained "
          "on own-library features, so the gated row measures transfer, not retrieval."), "",
          f"## Own transcripts, test split ({out['own']['n']} rows with gold, real library `ctc`)", "", *table("own"), "",
          ("4 of the 652 gold ids (all splits) point at `project@d63e3c8f:graphify`, a project-only skill of this repo; the queries come "
          "from other projects, so the neutral project filters it and those ids are unreachable."), "",
          f"## False triggers (gold-none test rows: {out['none_own']['n']} own + {out['none_metatool']['n']} MetaTool negatives)", "",
          "| mode | all | own none | MetaTool |", "|---|---|---|---|",
          *[f"| {m} | {out['none']['fired'][m]:.1%} | {out['none_own']['fired'][m]:.1%} | {out['none_metatool']['fired'][m]:.1%} |" for m in SHOWN],
          "", "Only full + gate can abstain; the other modes fire on every query with a candidate.", "",
          "## Latency per stage (ms, p50 / p95, sequential, shared TEI servers)", "",
          "| set | embed (batched, per query) | candidates | filter | rerank | search total |", "|---|---|---|---|---|---|",
          *[f"| {n} | {out[n]['embed_ms']} | " + " | ".join(f"{a} / {b}" for a, b in (out[n]['latency'][s] for s in ('candidates', 'filter', 'rerank', 'search'))) + " |"
            for n in ("skillret", "own", "none")], "",
          ("`candidates` is one SQL round trip (dense + keyword) to the local dev DB; Supabase adds ~65 ms. Queries are embedded 32 per "
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
              ("Winner = best mean of the two dev Recall@5 (gate off), ties to the cheaper config. rerank_top 40 was measured with an "
              "eval-side reranker that splits requests at 32; the shipped `Reranker.score` sends one request and TEI rejects > 32 texts "
              "(HTTP 413), so 40 cannot be shipped until it chunks."), "",
              (f"**Abstain gate** (`models/abstain.joblib`, LogisticRegression, class_weight=balanced, raw feature units): trained on "
              f"{g['n_pos']} positives (own dev with gold) vs {g['n_neg']} negatives ({g['n_neg_own']} own dev gold-none + MetaTool dev), "
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
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "index-skillret":
        asyncio.run(index_skillret())
    elif cmd == "tune":
        asyncio.run(tune())
    elif cmd == "run":
        asyncio.run(run(int(sys.argv[2]) if len(sys.argv) > 2 else None))
    else:
        sys.exit(__doc__)
