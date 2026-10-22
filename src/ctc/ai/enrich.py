"""A1 enrichment + dedup (PLAN.md A1, "AI integration flow"): one llm.json call per capability -> summary + 8-12 search
triggers (>= 2 non-English) -> set_enrichment -> build_index (the summary joins the doc vector, each trigger gets its
own) -> dedup: near-duplicate doc vectors share a cluster_id (search keeps the best hit per cluster), borderline pairs
go to dedup_review. Background job `enrich` only, never on the prompt path.
Eval rule (CLAUDE.md): test queries never come from the enricher. The prompt carries no eval rows, and schema ctc is
not enriched until K2 has measured the un-enriched baseline."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from collections import Counter
from typing import Annotated

import numpy as np
from pydantic import BaseModel, Field, computed_field, model_validator

from ctc.embedding.embedder import Embedder
from ctc.ingestion.indexer import build_index, texts
from ctc.llm.client import Llm

log = logging.getLogger(__name__)
BODY_CHARS, MERGE_AT, REVIEW_AT, NEIGHBOURS = 6000, 0.92, 0.85, 5

# The JSON keys steer the 3B model: one `triggers` list ignored the multilingual rule (12 English items, also after the
# retry), and a few-shot example got copied verbatim. A Vietnamese and a Chinese slot of their own (the owner prompts in
# Vietnamese) fill reliably; `triggers` is their merge.
SYSTEM = """You write search metadata for one capability (a skill, agent, command or workflow) of a coding assistant, so that a search engine can match it to the requests it helps with. Answer with one JSON object:
- summary: one or two sentences: what it does and when to use it.
- english_triggers: 6 to 10 different requests a developer would type, in English, when they need the job the summary describes. In their own words, without the capability's name, never about details of its code samples.
- vietnamese_trigger: one more such request, in Vietnamese with its diacritics.
- chinese_trigger: one more such request, in Chinese.
- prerequisites: what must exist or be set up before it can be used ([] if nothing).
- inputs: what it needs from the user or the codebase.
- outputs: what it produces.
Use only what the capability text says; do not invent features."""

Short = Annotated[str, Field(max_length=200)]  # grammar-enforced bounds: a 3B model looping never holds the one LLM slot for long


def non_english(t: str) -> bool:
    # ponytail: non-ASCII = non-English; an unaccented Spanish/Indonesian trigger doesn't count. A language-id model would.
    return any(ord(ch) > 127 for ch in t)


class Enrichment(BaseModel):
    summary: str = Field(max_length=600)
    english_triggers: list[Short] = Field(min_length=6, max_length=10)
    vietnamese_trigger: Short
    chinese_trigger: Short
    prerequisites: list[Short] = Field(max_length=8)
    inputs: list[Short] = Field(max_length=8)
    outputs: list[Short] = Field(max_length=8)

    @computed_field
    @property
    def triggers(self) -> list[str]:
        """8..12 search phrases, the non-English ones first (what set_enrichment stores and build_index embeds)."""
        return list(dict.fromkeys(t.strip() for t in [self.vietnamese_trigger, self.chinese_trigger, *self.english_triggers] if t.strip()))

    @model_validator(mode="after")
    def _multilingual(self) -> Enrichment:
        if sum(map(non_english, self.triggers)) < 2:
            raise ValueError("vietnamese_trigger and chinese_trigger must be written in Vietnamese (with diacritics) and in Chinese, not English")
        return self


def enricher_version(llm: Llm) -> str:
    """Moves when the prompt, the output schema or the model does: those caps count as stale again."""
    schema = json.dumps(Enrichment.model_json_schema(), sort_keys=True)
    return hashlib.sha256((SYSTEM + schema + llm.spec).encode()).hexdigest()[:12]


def enrich(cap: dict, llm: Llm) -> Enrichment:
    """Sync (Llm.json blocks the thread): async callers run it in asyncio.to_thread."""
    user = f"{cap['kind']} {cap['name']}\nDescription: {cap['description']}\n\n{(cap.get('body') or '')[:BODY_CHARS]}"
    try:
        return llm.json(SYSTEM, user, Enrichment)
    except ValueError as e:  # pydantic's ValidationError and bad JSON both are; one retry with the error fed back
        return llm.json(SYSTEM, f"{user}\n\nYour previous answer was rejected: {str(e)[:500]}\nAnswer again and fix that.", Enrichment)


# Exact nearest neighbours in numpy: one binary fetch of the doc vectors (n x 4 KB: 2.5 MB for ctc, 40 MB for a 10k-cap
# SkillRet schema) and blocked X @ X.T. Whole dedup on the dev DB: 0.13 s at 635 caps, 2.7 s at 6,006 (ctc_skillret);
# the brute-force SQL lateral it replaces took 2.0 s at 635 and minutes at 6k. ponytail: the transfer grows with n;
# past ~50k caps an HNSW lateral on cap_vectors with hnsw.iterative_scan filtered to doc rows avoids it.
DOC_SQL = "select v.cap_id, v.embedding from cap_vectors v join unnest(%s::text[], %s::text[]) d(cap_id, text) using (cap_id, text)"


async def nearest(store, docs: dict[str, str]) -> dict[tuple[str, str], float]:
    """{(a, b) with a < b: cosine} for each doc vector's NEIGHBOURS nearest other doc vectors with cosine >= REVIEW_AT.
    The doc vector is the "name: description summary" text, not the triggers."""
    async with store.pool.connection() as conn, conn.transaction(), conn.cursor(binary=True) as cur:
        await conn.execute("set local statement_timeout = '1min'")
        await cur.execute(DOC_SQL, (list(docs), list(docs.values())))
        vecs = {r["cap_id"]: r["embedding"].to_numpy() for r in await cur.fetchall()}
    ids, k, pairs = list(vecs), min(NEIGHBOURS, len(vecs) - 1), {}
    if k < 1:
        return pairs
    x = np.asarray(list(vecs.values()), dtype=np.float32)
    x /= np.linalg.norm(x, axis=1, keepdims=True)
    for s in range(0, len(ids), 2048):  # 2048 x n similarities per block: 80 MB at 10k caps
        sim = x[s : s + 2048] @ x.T
        rows = np.arange(len(sim))[:, None]
        sim[rows[:, 0], rows[:, 0] + s] = -1  # not its own neighbour
        top = np.argpartition(-sim, k - 1, axis=1)[:, :k]
        hit = sim[rows, top]
        for r, c in zip(*np.nonzero(hit >= REVIEW_AT)):
            pairs[tuple(sorted((ids[s + r], ids[top[r, c]])))] = round(float(hit[r, c]), 4)
    return pairs


async def dedup(store, dry_run: bool = False) -> dict:
    """Same-kind pairs >= MERGE_AT (plus pairs an owner marked 'merged') -> union-find -> cluster_id = the smallest id of
    each group; caps in no group get cluster_id null (a changed cap leaves its old cluster). A union that would put a
    pair the owner marked 'kept_apart' into one group is skipped (the owner's merges go first, then the strongest pairs).
    Every other pair >= REVIEW_AT not in one cluster -> dedup_review: new rows open, open rows get the new similarity,
    decided rows are kept; open rows whose pair is now one cluster or whose cap is gone are deleted. Cross-kind pairs
    are never merged automatically: a command and the agent it delegates to look alike (ecc:fastapi-review /
    ecc:fastapi-reviewer 0.92), and one cluster would make search drop the agent that decide attaches."""
    await store.refresh_catalog()
    docs = {c["id"]: texts(c)[0] for c in store.catalog.values()}
    pairs = await nearest(store, docs)
    decided = {(r["a"], r["b"]): r["status"] for r in await store.fetch("select a, b, status from dedup_review")}
    live = lambda a, b: a in docs and b in docs
    kind = lambda i: store.catalog[i]["kind"]
    apart = [p for p, s in decided.items() if s == "kept_apart" and live(*p)]
    edges = [p for p, s in decided.items() if s == "merged" and live(*p)]
    edges += sorted((p for p, s in pairs.items() if s >= MERGE_AT and kind(p[0]) == kind(p[1])), key=lambda p: -pairs[p])

    parent: dict[str, str] = {}  # non-roots only

    def find(x: str) -> str:
        while x in parent:
            x = parent[x]
        return x

    for a, b in edges:
        ra, rb = find(a), find(b)
        if ra != rb and not any({find(x), find(y)} == {ra, rb} for x, y in apart):
            parent[max(ra, rb)] = min(ra, rb)  # the smaller root wins, so a root is always its group's smallest id
    root = {i: find(i) for i in docs}
    size = Counter(root.values())
    want = {i: r if size[r] > 1 else None for i, r in root.items()}
    together = lambda a, b: want.get(a) is not None and want.get(a) == want.get(b)
    changes = [(i, w) for i, w in want.items() if store.catalog[i]["cluster_id"] != w]
    review = [(a, b, s) for (a, b), s in pairs.items() if not together(a, b) and decided.get((a, b), "open") == "open"]
    closed = [p for p, s in decided.items() if s == "open" and (not live(*p) or together(*p))]
    if not dry_run:
        for i, w in changes:
            await store.set_cluster(i, w)
        if review:
            await store.executemany("insert into dedup_review (a, b, similarity) values (%s, %s, %s) on conflict (a, b)"
                                    " do update set similarity = excluded.similarity where dedup_review.status = 'open'", review)
        if closed:
            await store.executemany("delete from dedup_review where a = %s and b = %s and status = 'open'", closed)
    return {"pairs": len(pairs), "clusters": len({w for w in want.values() if w}), "clustered": sum(w is not None for w in want.values()),
            "cluster_changes": len(changes), "review": len(review), "review_closed": len(closed)}


# Store.set_enrichment has no hash guard: a cap edited while its LLM call ran (dashboard PATCH, `ctc index`, another
# daemon) must stay stale, not get the old content's summary stamped with the current enricher_version.
SET_ENRICHMENT_SQL = ("update capabilities set summary = %s, triggers = %s, enricher_version = %s, updated_at = now()"
                      " where id = %s and hash = %s")


async def enrich_stale(store, embedder: Embedder, llm: Llm, limit: int | None = None, cap_ids: list[str] | None = None,
                       progress=None, budget_s: float | None = None) -> dict:
    """Enrich caps whose enricher_version is not the current one (cap_ids given: exactly those, re-enriched even when
    current: an explicit request), then build_index -> dedup -> refresh_catalog. build_index runs before dedup so
    dedup compares the enriched doc vectors. Every write commits on its own: a job cut short keeps its work.
    budget_s: no LLM call starts after that many seconds; the caps left over are counted in `remaining` and `next` is
    the payload of the follow-up job that picks them up (None when nothing is left)."""
    version = enricher_version(llm)
    rows = await store.fetch(
        "select id, kind, name, description, left(body, %s) as body, hash from capabilities"
        " where (%s::text[] is null and enricher_version is distinct from %s) or id = any(%s) order by id limit %s",
        (BODY_CHARS, cap_ids, version, cap_ids, limit),
    )
    deadline = time.monotonic() + budget_s if budget_s else None
    failed: dict[str, str] = {}
    changed: list[str] = []
    done = 0
    for cap in rows:
        if done and deadline and time.monotonic() > deadline:  # at least one call per job: a chain always progresses
            break
        try:
            e = await asyncio.to_thread(enrich, cap, llm)
        except ValueError as err:  # still invalid after the retry: the cap stays stale, the next run tries again
            log.warning("enrich %s failed: %s", cap["id"], err)
            failed[cap["id"]] = str(err)[:300]
        else:
            if not await store.execute(SET_ENRICHMENT_SQL, (e.summary, e.triggers, version, cap["id"], cap["hash"])):
                changed.append(cap["id"])  # edited or removed meanwhile: stays stale (or gone)
        done += 1
        if progress:
            await progress(0.9 * done / len(rows))
    left = rows[done:]
    # the follow-up takes exactly the leftovers: caps that failed here are not retried by every job of the chain
    nxt = {"cap_ids": [c["id"] for c in left]} if left else None
    embedded = await build_index(store, embedder)  # refreshes the catalog first: it picks up the new summaries
    d = await dedup(store)
    await store.refresh_catalog()
    if progress:
        await progress(1.0)
    return {"enriched": done - len(failed) - len(changed), "failed": failed, "changed_meanwhile": changed, "remaining": len(left),
            "next": nxt, "embedded": embedded, "enricher_version": version, **d}


async def run_job(st, payload: dict, progress) -> dict:
    """Job kind `enrich`, payload {cap_ids?, limit?}. Own embedder: build_index batches need batch_timeout_s.
    jobs.py cancels a job after jobs.timeout_s (and a cancelled to_thread LLM call keeps the one llama-server slot until
    it returns), so the LLM loop stops at half of it; the rest goes to a follow-up `enrich` job."""
    embedder = Embedder(st.cfg["embed_url"], st.cfg["batch_timeout_s"])
    try:
        r = await enrich_stale(st.store, embedder, st.llm, payload.get("limit"), payload.get("cap_ids"), progress,
                               budget_s=0.5 * st.cfg["jobs"]["timeout_s"])
    finally:  # also after a failure: caps enriched before it are committed, other workers must reload their catalog
        await embedder.aclose()
        await st.cache.publish_inval("lib")
    if (nxt := r.pop("next")) is not None:  # lazy import: jobs.py imports the handlers lazily too
        from ctc.server.jobs import submit

        r["next_job"] = await submit(st, "enrich", nxt)
    return r


async def _selfcheck(dsn: str) -> None:
    """Throwaway schema: 5 real caps, <= 5 real LLM calls, then dedup on synthetic vectors with known similarities."""
    import tempfile
    from pathlib import Path
    from types import SimpleNamespace

    import psycopg

    from ctc.config import cfg
    from ctc.ingestion.scanner import Capability, default_roots, scan_library
    from ctc.storage.store import Store

    # offline: validator and the one retry with the error fed back
    ok = {"summary": "s", "english_triggers": [f"t{i}" for i in range(6)], "vietnamese_trigger": "viết test", "chinese_trigger": "写测试",
          "prerequisites": [], "inputs": [], "outputs": []}
    e = Enrichment.model_validate(ok)
    assert e.triggers == ["viết test", "写测试", *ok["english_triggers"]] and e.model_dump()["triggers"] == e.triggers, e
    assert "triggers" not in Enrichment.model_json_schema()["properties"] and Enrichment.model_validate(e.model_dump()) == e
    try:
        Enrichment.model_validate({**ok, "vietnamese_trigger": "viet test"})
        raise AssertionError("an all-English trigger set was accepted")
    except ValueError:
        pass
    seen: list[str] = []

    def fake(system, user, schema):
        seen.append(user)
        return schema.model_validate(ok if len(seen) > 1 else {**ok, "chinese_trigger": "write a test"})

    assert enrich({"kind": "skill", "name": "n", "description": "d"}, SimpleNamespace(json=fake)).summary == "s"
    assert len(seen) == 2 and "rejected" in seen[1] and "in Chinese, not English" in seen[1], seen

    SELF = "ctc_selfcheck_enrich"

    async def drop() -> None:
        async with await psycopg.AsyncConnection.connect(dsn, autocommit=True) as conn:
            await conn.execute(f"drop schema if exists {SELF} cascade")

    class Budget(Llm):  # rule: <= 5 real LLM calls; the 6th becomes a failed cap
        n = 0

        def json(self, *a):
            Budget.n += 1
            if Budget.n > 5:
                raise ValueError("self-check LLM budget spent")
            return super().json(*a)

    await drop()
    store = await Store.open(dsn, SELF)
    embedder = Embedder(cfg()["embed_url"], cfg()["batch_timeout_s"])
    try:
        caps, _ = scan_library(default_roots(Path(tempfile.mkdtemp()), Path(cfg()["claude_home"])))  # reads ~/.claude only
        caps = sorted((c for c in caps if len(c.body) > 200), key=lambda c: c.id)
        caps = caps[:: max(1, len(caps) // 5)][:5]
        await store.upsert(caps, sorted({c.namespace for c in caps}))
        assert await build_index(store, embedder) == 5
        llm = Budget(cfg()["llm"])
        v = enricher_version(llm)
        assert v == enricher_version(Llm(cfg()["llm"])) and v != enricher_version(Llm("openai:http://x/v1:other"))

        t0 = asyncio.get_running_loop().time()
        fractions: list[float] = []

        async def progress(f: float) -> None:
            fractions.append(f)

        r = await enrich_stale(store, embedder, llm, progress=progress)
        secs = asyncio.get_running_loop().time() - t0
        print({k: r[k] for k in ("enriched", "failed", "embedded", "pairs", "clusters", "review")}, f"{secs:.1f} s, {Budget.n} LLM calls")
        assert r["enriched"] + len(r["failed"]) == 5 and r["enriched"] >= 3 and fractions[-1] == 1.0, r
        got = await store.fetch("select id, summary, triggers, enricher_version, (select count(*) from cap_vectors where cap_id = id) as n"
                                " from capabilities where enricher_version is not null order by id")
        assert len(got) == r["enriched"]
        for g in got:
            assert g["summary"] and 2 <= len(g["triggers"]) <= 12 and sum(map(non_english, g["triggers"])) >= 2, g
            assert g["enricher_version"] == v and g["n"] == 1 + len(g["triggers"]), g  # doc vector (with summary) + one per trigger
            assert store.get(g["id"])["summary"] == g["summary"]
        for g in got[:2]:
            print(json.dumps({"id": g["id"], "summary": g["summary"], "triggers": g["triggers"]}, ensure_ascii=False, indent=1))
        r2 = await enrich_stale(store, embedder, llm)  # the budget is spent: only the failed caps are stale, and fail again
        assert (r2["enriched"], set(r2["failed"]), r2["embedded"]) == (0, set(r["failed"]), 0), r2

        # fake LLM (0.3 s per call), every real cap stale for it. Budget 0.5 s: two calls start, the third doesn't.
        # The first cap is edited on disk while its call runs: its old-content enrichment is not stamped current.
        ids = sorted(c.id for c in caps)
        calls: list[str] = []

        def slow(system, user, schema):
            calls.append(user)
            if len(calls) == 1:
                with psycopg.connect(dsn, autocommit=True) as c:
                    c.execute(f"update {SELF}.capabilities set hash = 'h2', enricher_version = null where id = %s", (ids[0],))
            time.sleep(0.3)
            return schema.model_validate(ok)

        fk = SimpleNamespace(spec="fake", json=slow)
        fv = enricher_version(fk)
        ver = lambda: store.fetch("select id, enricher_version as v, (select count(*) from cap_vectors where cap_id = id) as n"
                                  " from capabilities where id = any(%s) order by id", (ids,))
        r3 = await enrich_stale(store, embedder, fk, cap_ids=ids, budget_s=0.5)
        assert (r3["enriched"], r3["changed_meanwhile"], r3["remaining"], r3["next"]) == (1, ids[:1], 3, {"cap_ids": ids[2:]}), r3
        got3 = await ver()
        assert got3[0]["v"] is None and (got3[1]["v"], got3[1]["n"]) == (fv, 9), got3  # build_index ran after the stop
        r4 = await enrich_stale(store, embedder, fk, limit=4, budget_s=1e-6)  # stale: ids 0, 2, 3, 4; one call all the same
        assert (r4["enriched"], r4["changed_meanwhile"], r4["remaining"], r4["next"]) == (1, [], 3, {"cap_ids": ids[2:]}), r4
        assert (await ver())[0]["v"] == fv and len(calls) == 3  # the edited cap, re-read with its new hash
        base = await dedup(store, dry_run=True)  # whatever the real caps pair up into
        assert base["cluster_changes"] == 0, base

        # dedup on synthetic doc vectors with known cosines. Orthonormal e0..e6:
        # m = e0; k: cos(m,k) = 0.95 (merge); c: cos(k,c) = 0.93 (merge), cos(m,c) ~ 0.77 (not a pair) -> one group via k;
        # d: cos(m,d) = 0.88 (review only); far: ~0 to all; ag: an agent at 0.95 to far (cross-kind: review, not merged).
        # Group root = smallest id = zz:c.
        e = np.linalg.qr(np.random.default_rng(0).normal(size=(1024, 7)))[0].T
        th, ps = np.arccos(0.95), np.arccos(0.93)
        unit = lambda cs, a, b: cs * e[a] + np.sqrt(1 - cs**2) * e[b]
        vec = {"m": e[0], "k": np.cos(th) * e[0] + np.sin(th) * e[1], "c": np.cos(th + ps) * e[0] + np.sin(th + ps) * e[1],
               "d": unit(0.88, 0, 2), "far": e[3], "ag": unit(0.95, 3, 4)}
        syn = [Capability(f"zz:{k}", "agent" if k == "ag" else "skill", k, "zz", f"synthetic {k}", "", f"/x/{k}.md", "h") for k in vec]
        await store.upsert(syn, ["zz"])
        put = lambda vs: store.insert_vectors([(f"zz:{k}", f"syn-{k}", "m", texts(store.get(f"zz:{k}"))[0], x) for k, x in vs.items()])
        await put(vec)
        clusters = lambda: store.fetch("select id, cluster_id from capabilities where namespace = 'zz'")
        reviews = lambda: store.fetch("select a, b, similarity, status from dedup_review where a like 'zz:%%'")
        dry = await dedup(store, dry_run=True)
        assert [dry[k] - base[k] for k in ("clusters", "clustered", "cluster_changes", "review")] == [1, 3, 3, 2], (dry, base)
        assert await store.fetchval("select count(*) from capabilities where namespace = 'zz' and cluster_id is not null") == 0
        assert await store.fetchval("select count(*) from dedup_review where a like 'zz:%%'") == 0
        assert (d := await dedup(store)) == dry, d
        cl = {r["id"]: r["cluster_id"] for r in await clusters()}
        assert cl == {"zz:m": "zz:c", "zz:k": "zz:c", "zz:c": "zz:c", "zz:d": None, "zz:far": None, "zz:ag": None}, cl
        assert sorted((x["a"], x["b"], x["status"], round(x["similarity"], 2)) for x in await reviews()) == [
            ("zz:ag", "zz:far", "open", 0.95), ("zz:d", "zz:m", "open", 0.88)]
        assert (await dedup(store))["cluster_changes"] == 0 and await store.fetchval("select count(*) from dedup_review where a like 'zz:%%'") == 2

        # the owner kept p and q apart (dashboard keep_apart): p-r 0.95 merges, r-q 0.93 would join q to p: skipped,
        # r-q goes to review. Meanwhile d drifts to 0.95 to m: it joins the group, its open row closes; ag-far drops to
        # 0.90: the open row gets the new similarity.
        vec2 = {"p": e[5], "r": np.cos(th) * e[5] + np.sin(th) * e[6], "q": np.cos(th + ps) * e[5] + np.sin(th + ps) * e[6]}
        await store.upsert(syn + [Capability(f"zz:{k}", "skill", k, "zz", f"synthetic {k}", "", f"/x/{k}.md", "h") for k in vec2], ["zz"])
        await put(vec2)
        await store.execute("insert into dedup_review (a, b, similarity, status) values ('zz:p', 'zz:q', 0.77, 'kept_apart')")
        await store.execute("update cap_vectors set embedding = %s where cap_id = 'zz:d'", (unit(0.95, 0, 2),))
        await store.execute("update cap_vectors set embedding = %s where cap_id = 'zz:ag'", (unit(0.90, 3, 4),))
        d = await dedup(store)
        cl = {r["id"]: r["cluster_id"] for r in await clusters()}
        assert cl == {**{f"zz:{k}": "zz:c" for k in "mkcd"}, "zz:far": None, "zz:ag": None, "zz:p": "zz:p", "zz:r": "zz:p", "zz:q": None}, cl
        assert sorted((x["a"], x["b"], x["status"], round(x["similarity"], 2)) for x in await reviews()) == [
            ("zz:ag", "zz:far", "open", 0.9), ("zz:p", "zz:q", "kept_apart", 0.77), ("zz:q", "zz:r", "open", 0.93)], d
        assert d["review_closed"] == 1 and (await dedup(store, dry_run=True))["cluster_changes"] == 0, d

        # k moves away and d back to 0.88: m-k and k-c break, the group dissolves; the owner had merged d+m by hand: kept
        await store.execute("update cap_vectors set embedding = %s where cap_id = 'zz:k'", (e[2] * -1,))
        await store.execute("update cap_vectors set embedding = %s where cap_id = 'zz:d'", (vec["d"],))
        await store.execute("insert into dedup_review (a, b, similarity, status) values ('zz:d', 'zz:m', 0.88, 'merged')")
        d = await dedup(store)
        cl = {r["id"]: r["cluster_id"] for r in await clusters()}
        assert cl == {"zz:m": "zz:d", "zz:k": None, "zz:c": None, "zz:d": "zz:d", "zz:far": None, "zz:ag": None,
                      "zz:p": "zz:p", "zz:r": "zz:p", "zz:q": None}, (cl, d)
        assert d["review"] == base["review"] + 2 and store.get("zz:m")["cluster_id"] == "zz:d", (d, base)
        print("dedup on synthetic vectors:", d)
    finally:
        await store.close()
        await embedder.aclose()
        await drop()
    print("enrich self-check ok")


if __name__ == "__main__":
    import argparse

    from ctc.config import cfg
    from ctc.storage.cache import Cache
    from ctc.storage.store import Store

    ap = argparse.ArgumentParser(prog="python -m ctc.ai.enrich", description="Enrich stale capabilities, then dedup (PLAN.md A1).")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--schema", default="ctc")
    ap.add_argument("--dedup-only", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="count stale caps and what dedup would write; no LLM, no writes")
    ap.add_argument("--selfcheck", action="store_true", help="run the self-check in a throwaway schema")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    async def main() -> None:
        c = cfg()
        if args.selfcheck:
            return await _selfcheck(c["database_url"])
        store, embedder, llm = await Store.open(c["database_url"], args.schema), Embedder(c["embed_url"], c["batch_timeout_s"]), Llm(c["llm"])
        try:
            if args.dry_run:
                stale = await store.fetchval("select count(*) from capabilities where enricher_version is distinct from %s", (enricher_version(llm),))
                print({"stale": stale, "enricher_version": enricher_version(llm), **await dedup(store, dry_run=True)})
            elif args.dedup_only:
                print(await dedup(store))
            else:
                print(await enrich_stale(store, embedder, llm, args.limit))
        finally:
            await store.close()
            await embedder.aclose()
        if not args.dry_run:  # running daemons reload their catalog (never raises)
            cache = Cache(c["redis_url"], c["cache"])
            await cache.start()
            await cache.publish_inval("lib")
            await cache.close()

    asyncio.run(main())
