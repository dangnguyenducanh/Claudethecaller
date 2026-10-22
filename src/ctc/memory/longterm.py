"""Long-term memory (PLAN.md B8, "Memory design"): write as NOOP / SUPERSEDE / UPDATE / ADD against the nearest live
neighbour, recall by similarity x recency x use, import Claude Code's own memory files read-only."""

from __future__ import annotations

import hashlib
import uuid
from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import psycopg
from psycopg.types.json import Jsonb

from ctc.config import cfg
from ctc.embedding.embedder import Embedder
from ctc.ingestion.scanner import _split_frontmatter
from ctc.storage.store import Store

NOOP_MIN, UPDATE_MIN, HALF_LIFE_DAYS, MAX_CHARS = 0.95, 0.85, 30, 2000
CLAUDE_KIND = {"user": "preference", "feedback": "convention", "project": "fact", "reference": "fact"}
COLS = (
    "id::text as id, user_id, scope, project_id, kind, text, hash, source, supersedes::text as supersedes, confidence,"
    " pinned, created_at, updated_at, last_used_at, use_count, deleted_at"
)
_INS = "insert into memories (user_id, scope, project_id, kind, text, hash, source, confidence, pinned, embedding"
_NEW = "%(u)s, %(scope)s, %(p)s, %(kind)s, %(text)s, %(hash)s, %(src)s, %(conf)s, %(pinned)s, %(v)s"

# ponytail: HNSW post-filters its ef_search=200 nearest rows; once ~200 closer rows of other users/scopes exist the
# neighbour is missed (-> a duplicate ADD). Turn on `hnsw.iterative_scan` when one DB holds that many memories.
NEAREST_SQL = """
select id, hash, 1 - (embedding <=> %(v)s) as sim from memories
where user_id = %(u)s and scope = %(scope)s and project_id is not distinct from %(p)s and deleted_at is null
order by embedding <=> %(v)s limit 1
"""
# use_count = independent re-observations: the same source again (a re-extracted session) and file imports (run at
# every daemon start, the same text may sit in several project memory dirs) are not new evidence
NOOP_SQL = f"update memories set use_count = use_count + (%(bump)s and source <> %(src)s)::int, pinned = pinned or %(pinned)s where id = %(id)s returning {COLS}"
# an imported row stays tied to its file, so the next import sees the edit is newer than the file and keeps it
UPDATE_SQL = f"""
update memories set text = %(text)s, hash = %(hash)s, embedding = %(v)s, pinned = pinned or %(pinned)s,
  source = case when source->>'kind' = 'claude-memory' then source else %(src)s end,
  confidence = least(1, greatest(confidence, %(conf)s) + 0.1), updated_at = now()
where id = %(id)s returning {COLS}
"""
# one statement: the old row is retired and the new one inserted together, or nothing happens (unknown supersedes id)
SUPERSEDE_SQL = f"""
with old as (update memories set deleted_at = coalesce(deleted_at, now()) where id = %(sup)s::uuid and user_id = %(u)s returning id)
{_INS}, supersedes) select {_NEW}, old.id from old returning {COLS}
"""
# ponytail: exact scan over the user's live rows (the score is not index-orderable); past ~50k memories per user,
# prefilter the few hundred nearest through HNSW and rescore only those.
RECALL_SQL = f"""
with top as (
  select id, text, kind, ((1 - (embedding <=> %(v)s))
    * case when pinned then 1 else power(0.5, extract(epoch from now() - updated_at) / 86400 / {HALF_LIFE_DAYS}) end
    * (1 + ln(1 + use_count)))::float8 as score
  from memories
  where user_id = %(u)s and deleted_at is null and (scope = 'global' or project_id = %(p)s)
  order by score desc limit %(k)s
), used as (update memories m set last_used_at = now() from top where m.id = top.id)
select id::text as id, text, kind, score from top order by score desc
"""
# import: the row this file produced (newest first), else a global row with the same text; deleted ones included
OWN_SQL = """
select id, hash, deleted_at, updated_at from memories
where user_id = %(u)s and (source @> %(src)s or (scope = 'global' and hash = %(hash)s))
order by source @> %(src)s desc, created_at desc limit 1
"""
REFRESH_SQL = "update memories set text = %(text)s, hash = %(hash)s, kind = %(kind)s, embedding = %(v)s, updated_at = now() where id = %(id)s"


@dataclass
class Memory:
    scope: str  # global | project
    kind: str  # preference | convention | fact | skill_outcome
    text: str
    project_id: str | None = None
    confidence: float = 0.5
    pinned: bool = False
    source: dict = field(default_factory=dict)
    supersedes: str | None = None  # id of the memory this one contradicts (A3)
    id: str | None = None


def _unit(v) -> np.ndarray:
    v = np.asarray(v, dtype=np.float32)
    return v / max(float(np.linalg.norm(v)), 1e-9)


async def write_memory(m: Memory, store: Store, embedder: Embedder, user_id: str = "local", update: bool = True) -> tuple[str, dict]:
    """(ADD|UPDATE|NOOP|SUPERSEDE, memories row without the embedding). Neighbours: same user + scope + project, live.
    update=False (import) skips the UPDATE band: one file must never overwrite another file's row."""
    if m.scope == "project" and not m.project_id:
        raise ValueError("a project memory needs project_id")
    try:
        sup = str(uuid.UUID(str(m.supersedes))) if m.supersedes else None
    except ValueError:  # A3 copies `contradicts` from LLM output: "none", a truncated id, ...
        sup = None
    h = hashlib.sha256(m.text.encode()).hexdigest()
    a = {
        "u": user_id, "scope": m.scope, "p": m.project_id if m.scope == "project" else None, "kind": m.kind, "text": m.text,
        "hash": h, "src": Jsonb(m.source), "conf": m.confidence, "pinned": m.pinned, "sup": sup,
        "bump": m.source.get("kind") != "claude-memory", "v": _unit((await embedder.embed([m.text], "doc"))[0]),
    }
    near = await store.fetchrow(NEAREST_SQL, a)
    noop = near and near["sim"] >= NOOP_MIN
    # a contradiction beats a near-identical neighbour unless the text is the same: embeddings barely see negation.
    # An unknown or malformed supersedes id inserts nothing and falls through to the plain rules.
    if sup and not (noop and near["hash"] == h) and (row := await store.fetchrow(SUPERSEDE_SQL, a)):
        return "SUPERSEDE", row
    if noop:
        return "NOOP", await store.fetchrow(NOOP_SQL, {**a, "id": near["id"]})
    if update and near and near["sim"] >= UPDATE_MIN:
        return "UPDATE", await store.fetchrow(UPDATE_SQL, {**a, "id": near["id"]})
    return "ADD", await store.fetchrow(f"{_INS}) values ({_NEW}) returning {COLS}", a)


async def recall(qv, store: Store, project_id: str | None, k: int = 5, user_id: str = "local") -> list[dict]:
    """Top k live global + this project's memories: similarity x 0.5^(age_days/30) (pinned exempt; age from updated_at)
    x (1 + ln(1 + use_count)). One round trip; bumps last_used_at of the rows returned. Never use_count: recall feeding
    its own score would entrench whatever comes back for everyday prompts."""
    return await store.fetch(RECALL_SQL, {"v": _unit(qv), "u": user_id, "p": project_id, "k": k})


def memory_files(dirs: list[Path] | None = None) -> list[Path]:
    """*.md in each memory dir (default <claude_home>/projects/*/memory) minus the MEMORY.md index."""
    dirs = sorted(Path(cfg()["claude_home"]).glob("projects/*/memory")) if dirs is None else dirs
    return [f for d in dirs for f in sorted(Path(d).glob("*.md")) if f.name != "MEMORY.md" and f.is_file()]


def parse_claude_memory(path: Path) -> Memory | None:
    """One Claude Code memory file -> a global Memory; None when unreadable, without frontmatter, or empty."""
    try:
        parsed = _split_frontmatter(path.read_text(encoding="utf-8", errors="replace").replace("\x00", ""), lenient=True)  # PG text: no NUL
    except OSError:
        return None
    if parsed is None:
        return None
    meta, body = parsed
    md = meta.get("metadata")  # Claude Code nests `type` under `metadata:`; older files have it top-level
    typ = meta.get("type") or (md.get("type") if isinstance(md, dict) else None)
    desc = meta.get("description") if isinstance(meta.get("description"), str) else ""
    text = "\n\n".join(s.strip() for s in (desc, body) if s.strip())[:MAX_CHARS]
    if not text:
        return None
    return Memory("global", CLAUDE_KIND.get(str(typ).strip().lower(), "fact"), text, source={"kind": "claude-memory", "file": str(path)})


async def _import_file(f: Path, m: Memory, store: Store, embedder: Embedder, user_id: str) -> str:
    """The file is the identity: its own row (any state) or a global row with its exact text decides, never similarity.
    Retired (deleted, superseded) stays retired; a row edited after the file changed (PATCH, A3 UPDATE) wins."""
    a = {"u": user_id, "src": Jsonb(m.source), "hash": hashlib.sha256(m.text.encode()).hexdigest(), "kind": m.kind, "text": m.text}
    own = await store.fetchrow(OWN_SQL, a)
    if own is None:
        # ponytail: a near-duplicate (>= 0.95) of another row gets no row of its own: re-embedded per import, and
        # back as ADD once that row is deleted. Record extra source files per row if that starts to matter.
        return (await write_memory(m, store, embedder, user_id, update=False))[0]
    if own["deleted_at"] or own["hash"] == a["hash"] or own["updated_at"] >= datetime.fromtimestamp(f.stat().st_mtime, UTC):
        return "NOOP"
    await store.execute(REFRESH_SQL, {**a, "id": own["id"], "v": _unit((await embedder.embed([m.text], "doc"))[0])})
    return "UPDATE"


async def import_claude_memory(store: Store, embedder: Embedder, dirs: list[Path] | None = None, user_id: str = "local", progress=None) -> dict:
    """Each Claude Code memory file -> one global memory, keyed by file. READ-ONLY on those files.
    {"written": ADD + UPDATE, "skipped": NOOP + MALFORMED, "actions": per-action counts}."""
    files, acts = memory_files(dirs), Counter()
    # ponytail: 1-3 round trips per file, sequential (unchanged files are not re-embedded); batch if imports reach thousands
    for i, f in enumerate(files):
        m = parse_claude_memory(f)
        try:
            acts[await _import_file(f, m, store, embedder, user_id) if m else "MALFORMED"] += 1
        except (OSError, psycopg.DataError):  # one file the DB rejects (or that vanished) must not block every later one
            acts["MALFORMED"] += 1
        if progress:
            await progress((i + 1) / len(files))
    return {"written": acts["ADD"] + acts["UPDATE"], "skipped": acts["NOOP"] + acts["MALFORMED"], "actions": dict(acts)}


async def run_import(st, payload: dict, progress) -> dict:
    """Job kind `import_memory` (server/jobs.py). payload: {dirs?: [path], user_id?}. dirs arrive over POST
    /api/memories/import (the TCP port is open to every local user), so only dirs under <claude_home>/projects/ are read,
    symlinks resolved — the same guard as extract.run_job."""
    if st.cfg["mode"] != "local":  # shared mode: never let a client make the daemon read paths on its host
        raise ValueError("import_memory reads files on the daemon host: local mode only")
    base = Path(st.cfg["claude_home"]).resolve() / "projects"
    dirs = [Path(d).expanduser().resolve() for d in payload["dirs"]] if payload.get("dirs") else None
    if bad := [str(d) for d in dirs or [] if not d.is_relative_to(base)]:
        raise ValueError(f"memory dirs must be under {base}: {bad}")
    return await import_claude_memory(st.store, st.embedder, dirs, payload.get("user_id", "local"), progress)


if __name__ == "__main__":
    import asyncio
    import os
    import tempfile
    import time
    from types import SimpleNamespace

    import psycopg

    from ctc.ingestion.scanner import project_id

    SELF = "ctc_selfcheck_mem"

    def e(i: int, j: int | None = None, c: float = 1.0) -> np.ndarray:
        """Unit vector with cosine exactly c to basis i (rest on basis j)."""
        v = np.zeros(1024, np.float32)
        v[i] = c
        if j is not None:
            v[j] = (1 - c * c) ** 0.5
        return v

    class Stub:  # deterministic vectors, so the 0.95 / 0.85 thresholds are hit exactly
        def __init__(self, vecs: dict[str, np.ndarray]):
            self.vecs = vecs

        async def embed(self, texts, kind):
            return np.stack([self.vecs[t] for t in texts])

    async def drop(dsn: str) -> None:
        async with await psycopg.AsyncConnection.connect(dsn, autocommit=True) as conn:
            await conn.execute(f"drop schema if exists {SELF} cascade")

    async def check(dsn: str) -> None:
        s = await Store.open(dsn, SELF)
        real = Embedder(cfg()["embed_url"], cfg()["timeout_s"])
        try:
            root = Path(tempfile.mkdtemp())
            (root / "a").mkdir(), (root / "b").mkdir()
            await s.ensure_project(str(root / "a")), await s.ensure_project(str(root / "b"))
            pa, pb = project_id(root / "a"), project_id(root / "b")
            stub = Stub({
                "use pnpm": e(0), "use pnpm, always": e(0, 1, 0.97), "use pnpm in the dashboard": e(0, 2, 0.9),
                "use npm, not pnpm": e(0, 3, 0.5), "never use tabs": e(5), "always use tabs": e(5, 6, 0.97),
                "project b only": e(7), "global fact": e(8), "pinned rule": e(9), "old rule": e(10), "pinned rule!": e(9, 11, 0.9),
                "brand new rule": e(12),
            })

            async def w(text, scope="project", p=pa, user="local", **kw):
                return await write_memory(Memory(scope, "convention", text, p, **kw), s, stub, user)

            # ADD, then NOOP: same source -> no use_count bump, new source -> +1; text and id stay
            act, r1 = await w("use pnpm")
            assert act == "ADD" and r1["use_count"] == 0 and r1["hash"] == hashlib.sha256(b"use pnpm").hexdigest(), (act, r1)
            assert "embedding" not in r1 and isinstance(r1["id"], str)
            act, r = await w("use pnpm")
            assert (act, r["id"], r["use_count"]) == ("NOOP", r1["id"], 0), (act, r)
            act, r = await w("use pnpm, always", source={"kind": "manual"})
            assert (act, r["id"], r["use_count"], r["text"]) == ("NOOP", r1["id"], 1, "use pnpm"), (act, r)
            # UPDATE at 0.90: newer text, re-embedded, confidence = min(1, max(old, new) + 0.1)
            act, r = await w("use pnpm in the dashboard", confidence=0.7)
            assert (act, r["id"], r["text"]) == ("UPDATE", r1["id"], "use pnpm in the dashboard"), (act, r)
            assert abs(r["confidence"] - 0.8) < 1e-6 and r["updated_at"] > r["created_at"], r
            sim = await s.fetchval("select 1 - (embedding <=> %s) from memories where id = %s", (e(0, 2, 0.9), r1["id"]))
            assert sim > 0.999, sim
            # SUPERSEDE: old row retired, new row points at it
            act, r4 = await w("use npm, not pnpm", supersedes=r1["id"])
            assert (act, r4["supersedes"]) == ("SUPERSEDE", r1["id"]) and r4["id"] != r1["id"], (act, r4)
            assert await s.fetchval("select deleted_at is not null from memories where id = %s", (r1["id"],))
            # a contradiction at cosine 0.97 still supersedes (NOOP would drop it); unknown supersedes id -> normal path
            _, r5 = await w("never use tabs")
            act, r6 = await w("always use tabs", supersedes=r5["id"])
            assert (act, r6["supersedes"]) == ("SUPERSEDE", r5["id"]), (act, r6)
            act, _ = await w("never use tabs", supersedes="00000000-0000-0000-0000-000000000000")
            assert act == "NOOP", act  # live neighbour "always use tabs" at 0.97; the stale id is ignored
            for bad in ("none", "not-a-uuid", 5):  # LLM output: malformed ids fall through instead of raising
                act, r = await w("brand new rule", supersedes=bad)
                assert act in ("ADD", "NOOP") and r["supersedes"] is None, (bad, act, r)
            # write path: deleted rows are not neighbours, the retired text comes back as ADD (nearest live is 0.45
            # away). New evidence from a session or by hand; import keys on the file and keeps it retired (below).
            act, r = await w("use pnpm in the dashboard")
            assert act == "ADD" and r["id"] != r1["id"], act
            await s.execute("update memories set deleted_at = now() where id = %s", (r["id"],))

            # scope isolation: neighbours never cross project / scope / user
            _, rb = await w("project b only", p=pb)
            act, ra = await w("project b only")
            assert act == "ADD" and ra["id"] != rb["id"], act
            await s.execute("update memories set deleted_at = now() where id = %s", (ra["id"],))  # DELETE /api/memories
            _, rg = await w("global fact", scope="global", p=None)
            assert rg["project_id"] is None
            act, ru = await w("global fact", scope="global", p=None, user="u2")
            assert act == "ADD" and ru["id"] != rg["id"], act
            act, _ = await w("project b only", scope="global", p=None)
            assert act == "ADD", act
            await s.execute("update memories set deleted_at = now() where scope = 'global' and text = 'project b only'")

            q = _unit(e(7) + e(8))

            def ids(rows):
                return {x["id"] for x in rows}

            got = await recall(q, s, pa, k=10)
            assert rg["id"] in ids(got) and rb["id"] not in ids(got) and ra["id"] not in ids(got) and ru["id"] not in ids(got), got
            assert {rb["id"], rg["id"]} <= ids(await recall(q, s, pb, k=10))
            assert ids(await recall(q, s, None, k=10)) == {rg["id"]}  # no project -> global only
            assert len(await recall(q, s, pa, k=1)) == 1 and set(got[0]) == {"id", "text", "kind", "score"}
            used = await s.fetchrow("select use_count, last_used_at from memories where id = %s", (rg["id"],))
            assert used["use_count"] == 0 and used["last_used_at"] is not None, used  # recalled 4 times: not evidence
            # deleted rows never recalled: the superseded and the soft-deleted ones
            got = ids(await recall(e(0, 2, 0.9), s, pa, k=10)) | ids(await recall(e(5), s, pa, k=10))
            assert r1["id"] not in got and r5["id"] not in got and r4["id"] in got and r6["id"] in got, got

            # pinned exempt from decay: both 90 days old, same similarity -> unpinned scores 0.5^3 of pinned
            _, rp = await w("pinned rule", scope="global", p=None, user="decay", pinned=True)
            _, ro = await w("old rule", scope="global", p=None, user="decay")
            await s.execute("update memories set created_at = now() - interval '90 days', updated_at = now() - interval '90 days' where user_id = 'decay'")
            got = await recall(_unit(e(9) + e(10)), s, None, user_id="decay")
            assert [x["id"] for x in got] == [rp["id"], ro["id"]], got
            assert abs(got[0]["score"] - 0.5**0.5) < 1e-3 and abs(got[1]["score"] / got[0]["score"] - 0.125) < 1e-3, got
            # recall never feeds its own score: 30 more recalls leave scores as they were
            for _ in range(30):
                again = await recall(_unit(e(9) + e(10)), s, None, user_id="decay")
            assert all(abs(x["score"] - y["score"]) < 1e-4 for x, y in zip(got, again)), (got, again)
            # use_count (a re-observation from a new source) lifts the score by (1 + ln(1 + n))
            act, r = await w("pinned rule", scope="global", p=None, user="decay", source={"kind": "manual"})
            assert (act, r["use_count"]) == ("NOOP", 1), (act, r)
            got = await recall(_unit(e(9) + e(10)), s, None, user_id="decay")
            assert abs(got[0]["score"] - 0.5**0.5 * (1 + np.log(2))) < 1e-3, got
            # confidence caps at 1
            act, r = await w("pinned rule!", scope="global", p=None, user="decay", confidence=0.95)
            assert act == "UPDATE" and r["confidence"] == 1.0 and r["pinned"], (act, r)

            # import: 3 typed files + a malformed one + the MEMORY.md index, default dirs from claude_home
            home = root / "claude"
            mem = home / "projects" / "-tmp-x" / "memory"
            mem.mkdir(parents=True)
            files = {
                "user_lang.md": "---\nname: lang\ndescription: Prefers answers in Vietnamese when chatting casually\ntype: user\n---\n\nSwitch back to English for code review comments.\n",
                "feedback_tests.md": "---\nname: tests\ndescription: Run pytest with -x before every commit\nmetadata:\n  node_type: memory\n  type: feedback\n---\n\nThe owner wants fail-fast test runs; never push with red tests.\n",
                "project_db.md": "---\nname: db\ndescription: \"The staging database listens on port 5433 of the docker host\"\nmetadata: \n  type: project\n---\n\nUse it for read-only checks; prod is elsewhere.\n" + "x" * 3000,
                "broken.md": "no frontmatter here, just a stray note\n",
                "MEMORY.md": "- [lang](user_lang.md) — index line\n",
            }
            for n, t in files.items():
                (mem / n).write_text(t)
            before = {p.name: (p.stat().st_mtime_ns, p.read_bytes()) for p in mem.iterdir()}
            old = os.environ.get("CTC_CLAUDE_HOME")
            os.environ["CTC_CLAUDE_HOME"] = str(home)
            cfg.cache_clear()
            try:
                assert [f.name for f in memory_files()] == ["broken.md", "feedback_tests.md", "project_db.md", "user_lang.md"]
                res = await import_claude_memory(s, real, user_id="imp")
            finally:
                os.environ.pop("CTC_CLAUDE_HOME") if old is None else os.environ.update(CTC_CLAUDE_HOME=old)
                cfg.cache_clear()
            assert res == {"written": 3, "skipped": 1, "actions": {"ADD": 3, "MALFORMED": 1}}, res
            rows = await s.fetch("select kind, scope, project_id, text, source, use_count from memories where user_id = 'imp' order by kind")
            assert [r["kind"] for r in rows] == ["convention", "fact", "preference"], rows
            assert all(r["scope"] == "global" and r["project_id"] is None and r["source"]["kind"] == "claude-memory" for r in rows)
            assert rows[2]["text"] == "Prefers answers in Vietnamese when chatting casually\n\nSwitch back to English for code review comments."
            assert rows[1]["source"]["file"] == str(mem / "project_db.md") and len(rows[1]["text"]) == MAX_CHARS
            # re-import through the job handler: all NOOP, no use_count drift, files untouched
            prog = []

            async def progress(f):
                prog.append(f)

            res = await run_import(SimpleNamespace(cfg={"mode": "local", "claude_home": str(home)}, store=s, embedder=real), {"dirs": [str(mem)], "user_id": "imp"}, progress)
            assert res == {"written": 0, "skipped": 4, "actions": {"MALFORMED": 1, "NOOP": 3}}, res
            assert prog == [0.25, 0.5, 0.75, 1.0], prog
            assert await s.fetchval("select sum(use_count) from memories where user_id = 'imp'") == 0
            assert before == {p.name: (p.stat().st_mtime_ns, p.read_bytes()) for p in mem.iterdir()}, "import wrote a memory file"
            # retired stays retired, a newer edit beats an older file, a newer file updates its own row in place
            ids_ = {r["source"]["file"]: r["id"] for r in await s.fetch("select id::text as id, source from memories where user_id = 'imp'")}
            lang, tests, db = (ids_[str(mem / n)] for n in ("user_lang.md", "feedback_tests.md", "project_db.md"))
            await s.execute("update memories set deleted_at = now() where id = %s", (lang,))  # DELETE /api/memories
            act, r = await write_memory(Memory("global", "convention", "Run pytest -x only in CI", supersedes=tests), s, real, "imp")
            assert act == "SUPERSEDE", act
            await s.execute("update memories set text = 'edited by hand', hash = 'h', updated_at = now() where id = %s", (db,))  # PATCH
            res = await import_claude_memory(s, real, [mem], "imp")
            assert res["actions"] == {"MALFORMED": 1, "NOOP": 3}, res
            live = {r["id"]: r["text"] for r in await s.fetch("select id::text as id, text from memories where user_id = 'imp' and deleted_at is null")}
            assert lang not in live and tests not in live and live[db] == "edited by hand" and len(live) == 2, live
            f = mem / "project_db.md"
            f.write_text(f.read_text().replace("port 5433", "port 5434"))
            os.utime(f, (time.time() + 60, time.time() + 60))  # temp file: edited after the PATCH
            res = await import_claude_memory(s, real, [mem], "imp")
            assert res["actions"] == {"MALFORMED": 1, "NOOP": 2, "UPDATE": 1}, res
            text = await s.fetchval("select text from memories where id = %s", (db,))
            sim = await s.fetchval("select 1 - (embedding <=> %s) from memories where id = %s", (_unit((await real.embed([text], "doc"))[0]), db))
            assert "port 5434" in text and sim > 0.999, (text, sim)  # re-embedded
            assert (await import_claude_memory(s, real, [mem], "imp"))["actions"] == {"MALFORMED": 1, "NOOP": 3}

            # files at cosine 0.9 keep one row each; the same file in 2 project dirs is one row, no use_count drift;
            # a NUL byte (PG text rejects it) is stripped instead of failing the job at that file on every start
            dy, dz = home / "projects" / "-tmp-y" / "memory", home / "projects" / "-tmp-z" / "memory"
            dy.mkdir(parents=True), dz.mkdir(parents=True)
            hdr = "---\nname: n\ndescription: {}\ntype: user\n---\n\n{}\n"
            for d, n, desc, body in ((dy, "pm_build.md", "pnpm rules", "build"), (dy, "pm_dev.md", "pnpm rules", "dev"),
                                     (dy, "gpu.md", "GPU is shared", "7 GB"), (dz, "gpu.md", "GPU is shared", "7 GB"), (dy, "nul.md", "paste", "a\x00b")):
                (d / n).write_text(hdr.format(desc, body))
            st2 = Stub({"pnpm rules\n\nbuild": e(20), "pnpm rules\n\ndev": e(20, 21, 0.9), "GPU is shared\n\n7 GB": e(22), "paste\n\nab": e(23)})
            res = await import_claude_memory(s, st2, [dy, dz], "imp2")
            assert res["actions"] == {"ADD": 4, "NOOP": 1}, res
            for _ in range(2):
                assert (await import_claude_memory(s, st2, [dy, dz], "imp2"))["actions"] == {"NOOP": 5}
            rows = await s.fetch("select text, confidence, use_count from memories where user_id = 'imp2' order by text")
            assert [(r["text"], r["confidence"], r["use_count"]) for r in rows] == [
                ("GPU is shared\n\n7 GB", 0.5, 0), ("paste\n\nab", 0.5, 0), ("pnpm rules\n\nbuild", 0.5, 0), ("pnpm rules\n\ndev", 0.5, 0)], rows
            try:
                await run_import(SimpleNamespace(cfg={"mode": "shared"}, store=s, embedder=real), {"dirs": ["/etc"]}, progress)
                raise AssertionError("shared mode imported host files")
            except ValueError:
                pass
            for d in ("/etc", str(mem / ".." / ".." / ".." / "..")):  # local mode: only <claude_home>/projects/, `..` resolved
                try:
                    await run_import(SimpleNamespace(cfg={"mode": "local", "claude_home": str(home)}, store=s, embedder=real), {"dirs": [d]}, progress)
                    raise AssertionError(f"imported {d}")
                except ValueError:
                    pass
            print("memory rows in", SELF, await s.fetchval("select count(*) from memories"))
        finally:
            await real.aclose()
            await s.close()

    async def main() -> None:
        # read-only count of what import would pick up from the real ~/.claude (never written, never imported here)
        files = memory_files()
        parsed = [parse_claude_memory(f) for f in files]
        kinds = Counter(m.kind for m in parsed if m)
        print(f"real {cfg()['claude_home']}/projects/*/memory: {len(files)} files -> {sum(map(bool, parsed))} memories {dict(kinds)}, {parsed.count(None)} malformed")
        dsn = cfg()["database_url"]
        await drop(dsn)
        try:
            await check(dsn)
        finally:
            await drop(dsn)
        print("longterm memory self-check ok")

    asyncio.run(main())
