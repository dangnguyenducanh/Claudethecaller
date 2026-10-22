"""K4 memory lift + adoption, H4 prep (PLAN.md K4, H4, Targets).

uv run python -m evaluation.memory_eval sample   # H4: up to 50 live session-extracted memories -> own-eval-memories.jsonl
uv run python -m evaluation.memory_eval          # K4: Recall@5 with vs without recall() memories, adoption -> data/reports/
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np

from ctc.ai.extract import transcript_cwd
from ctc.config import ROOT, cfg
from ctc.ingestion.scanner import project_id
from ctc.memory.longterm import recall
from ctc.memory.session import _unit, blend, project_profile
from ctc.retrieval.hybrid import Ctx, search
from ctc.server.hooks import MAX_Q
from evaluation.retrieval_eval import (
    NEUTRAL,
    REPORTS,
    TODAY,
    closed,
    embed_all,
    opened,
    scores,
)

OWN = ROOT / "data" / "processed" / "own-eval.jsonl"
H4 = ROOT / "data" / "processed" / "own-eval-memories.jsonl"
SAMPLE_N = 50
SAMPLE_SQL = """
select m.id::text as id, m.kind, m.scope, p.name as project, m.text, m.source from memories m
left join projects p on p.user_id = m.user_id and p.id = m.project_id
where m.user_id = 'local' and m.deleted_at is null and m.source->>'kind' = 'session'
order by md5(m.id::text) limit %s
"""
ADOPTION_SQL = """
select count(*) as n, count(*) filter (where not abstained) as fired, avg(followed::int)::float8 as adoption,
  (avg(followed::int) filter (where not abstained))::float8 as adoption_fired from decisions where user_id = 'local'
"""


def jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()] if path.exists() else []


async def sample() -> None:
    """Stable sample (md5 order), so a re-run keeps the same rows; `correct` already filled by the owner is kept by id."""
    embedder, reranker, (store,) = await opened("ctc")
    try:
        done = {r["id"]: r["correct"] for r in jsonl(H4)}
        rows = [{**r, "correct": done.get(r["id"])} for r in await store.fetch(SAMPLE_SQL, (SAMPLE_N,))]
        H4.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
        print(f"{len(rows)} memories -> {H4} ({sum(r['correct'] is not None for r in rows)} already checked)")
    finally:
        await closed(embedder, reranker, [store])


async def recall_ro(store, qv, pid: str | None) -> list[dict]:
    """recall() as the route calls it, in a rolled-back transaction: the eval must not mark memories used (last_used_at)."""
    async with store.pool.connection() as conn, conn.transaction(force_rollback=True):
        async def fetch(sql, params=None):
            return await (await conn.execute(sql, params)).fetchall()
        return await recall(qv, SimpleNamespace(fetch=fetch), pid)


async def run() -> None:
    """Per own-eval row with gold (dev + test): the route's first-turn query vector blend(prompt, project) WITHOUT vs
    blend(prompt, project, mean(recalled memories)) WITH, then search() as shipped; same rows, same library state."""
    c = cfg()
    embedder, reranker, (store,) = await opened("ctc")
    try:
        libv = store.library_version
        rows = [r for r in jsonl(OWN) if r["gold"]]
        tx = {f.stem: f for f in Path(c["claude_home"]).glob("projects/*/*.jsonl")}  # read-only
        cwd = {s: transcript_cwd(tx[s]) if s in tx else None for s in {r["session_id"] for r in rows}}
        pv = {}  # project_vector() without its projects-row/cache writes: the same profile text, embedded as a query
        for d in {d for d in cwd.values() if d}:
            text = project_profile(d)[1]
            pv[d] = _unit((await embedder.embed([text], "query"))[0]) if text else None
        qvs, _ = await embed_all(embedder, [r["query"][:MAX_Q] for r in rows])
        memo: dict[str, np.ndarray] = {}
        arms, recalled = {"without": [], "with": []}, {}
        for r, qv in zip(rows, qvs):
            q, d = r["query"][:MAX_Q], cwd[r["session_id"]]
            mems = await recall_ro(store, qv, project_id(d) if d else None)
            texts = [m["text"] for m in mems]
            if miss := [t for t in dict.fromkeys(texts) if t not in memo]:
                memo.update(zip(miss, await embedder.embed(miss, "query")))
            mv = np.mean([_unit(memo[t]) for t in texts], axis=0) if texts else None
            recalled[r["id"]] = [m["id"] for m in mems]
            ctx = Ctx(store, embedder, reranker, d or NEUTRAL)
            for arm, v in (("without", blend(qv, None, pv.get(d))), ("with", blend(qv, None, pv.get(d), mv) if texts else None)):
                if v is None:  # nothing recalled: the WITH vector is the WITHOUT one
                    arms[arm].append(arms["without"][-1])
                    continue
                res = await search(q, ctx, qv=v, k=c["k"], depth=c["depth"], rerank_top=c["rerank_top"], abstain_below=c["abstain_below"])
                arms[arm].append({"id": r["id"], "split": r["split"], "gold": dict.fromkeys(r["gold"], 1),
                                  "full": [h.cap_id for h in res.considered], "abstained": res.abstained})
        ids = sorted({i for v in recalled.values() for i in v})
        src = {m["id"]: m["source"] for m in await store.fetch("select id::text as id, source from memories where id = any(%s::uuid[])", (ids,))}
        sid = {r["id"]: r["session_id"] for r in rows}
        leaked = sum(any(src.get(i, {}).get("session_id") == sid[q] for i in v) for q, v in recalled.items())
        changed = sum(a["full"][:5] != b["full"][:5] for a, b in zip(arms["without"], arms["with"]))
        adopt = await store.fetchrow(ADOPTION_SQL)
        kinds = await store.fetch("select source->>'kind' as kind, count(*) as n from memories where user_id = 'local' and deleted_at is null group by 1 order by 1")
        h4 = [r["correct"] for r in jsonl(H4) if r.get("correct") is not None]
        await store.refresh_catalog()
    finally:
        await closed(embedder, reranker, [store])

    splits = {"dev": 0, "test": 1, "all": None}
    table = {(s, a): scores([x for x in arms[a] if n is None or x["split"] == n], "full") for s, n in splits.items() for a in arms}
    lines = [f"# Memory lift + adoption ({TODAY})", "",
             f"Library version `{libv}` (catalog at end of run `{store.library_version}`{'' if store.library_version == libv else ': changed during the run'}"
             f"; both arms of a row ran back to back on the same state). Memories live: "
             + ", ".join(f"{k['kind']} {k['n']}" for k in kinds) + ".", "",
             "## Recall@5 with vs without recalled memories", "",
             ("Query vector = the route's first-turn blend: prompt 0.6 + project profile 0.15, WITH adds mean(recall() top 5 memories, "
             f"global + the session's project) at memory_weight {c['memory_weight']}; no session part (rows are scored as first turns). "
             "Gold = the K1 Qwen-3B judge's labels, H1 hand-check pending: noisy (over-labels, `ecc:*`-heavy), so absolute values "
             "are a lower bound; the with/without delta on the same rows is what this measures. Gate off (no installed model), abstain_below null."), "",
             "| split | n | R@5 without | R@5 with | lift | NDCG@10 without | NDCG@10 with | MRR without | MRR with |",
             "|---|---|---|---|---|---|---|---|---|"]
    for s, n in splits.items():
        w, m = table[(s, "without")], table[(s, "with")]
        cnt = sum(n is None or x["split"] == n for x in arms["without"])
        lines.append(f"| {s} | {cnt} | {w['recall@5']:.4f} | {m['recall@5']:.4f} | {m['recall@5'] - w['recall@5']:+.4f} | "
                     f"{w['ndcg@10']:.4f} | {m['ndcg@10']:.4f} | {w['mrr']:.4f} | {m['mrr']:.4f} |")
    with_mem = sum(bool(v) for v in recalled.values())
    lines += ["", (f"Rows with >= 1 recalled memory: {with_mem}/{len(rows)}; top-5 changed by the memory part: {changed}/{len(rows)}; "
              f"rows whose recall returned a memory extracted from that same session (future knowledge for an early turn): {leaked}. "
              f"Target memory lift >= 0: **{'met' if table[('all', 'with')]['recall@5'] >= table[('all', 'without')]['recall@5'] else 'missed'}** (all rows)."),
              "", "## Extraction precision (H4)", "",
              f"{len(h4)} of {len(jsonl(H4))} sampled memories hand-checked: "
              + (f"precision {np.mean(h4):.3f} (target >= 0.80)." if h4 else f"pending H4 (owner fills `correct` in `{H4.relative_to(ROOT)}`)."),
              "", "## Adoption", "",
              (f"avg(followed::int) over {adopt['n']} decisions: {adopt['adoption'] or 0:.4f}; over the {adopt['fired']} non-abstained: "
              f"{adopt['adoption_fired'] or 0:.4f}. Expected ~0 until H3 (the PostToolUse follow signal from real sessions); "
              "the follow rate is meaningful only for decisions after H3."), ""]
    REPORTS.mkdir(parents=True, exist_ok=True)
    out = REPORTS / f"memory-{TODAY}.md"
    out.write_text("\n".join(lines))
    print(out.read_text(), f"-> {out}", sep="\n")


if __name__ == "__main__":
    import asyncio

    asyncio.run(sample() if sys.argv[1:] == ["sample"] else run())
