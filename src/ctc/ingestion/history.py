"""B9 Claude history import (PLAN.md "History import design"): the user's own <claude_home>/projects transcripts ->
sessions, decisions, memories. <claude_home> is only read; the DB gets structure, counts, tool names and what the local
LLM wrote (titles, summaries, intents), never a raw prompt or transcript text.

Phase 1 `scan` (no LLM): changed transcripts -> history_files, projects, sessions (status pending), events (Skill /
Agent / Task names). Phase 2 `distill_session` (local LLM, one `distill` job per session): title + summary + one intent
per typed prompt; each prompt replayed through search + decide -> decisions (prompt = the intent); A3 extraction ->
processed. Phase 3 `outcomes`: per (project, capability) follow rate -> skill_outcome memories.
"""

from __future__ import annotations

import asyncio
import hashlib
import re
import time
from collections import Counter
from pathlib import Path
from typing import Annotated

import orjson
from psycopg.types.json import Jsonb
from pydantic import Field, create_model

from ctc.ai.extract import INJECTED, extract_session, transcript_cwd
from ctc.config import cfg
from ctc.decision.bundle import decide, followed
from ctc.ingestion.scanner import project_id
from ctc.memory.longterm import Memory, write_memory
from ctc.retrieval.hybrid import search
from ctc.runner.engine import in_runs
from ctc.server.hooks import MAX_Q
from ctc.server.jobs import COLS, submit

KEY = {"Skill": "skill", "Agent": "subagent_type", "Task": "subagent_type"}  # tool -> input field naming the capability
SYSTEM = """You read the prompts a user typed in one session with a coding assistant (numbered, oldest first, each cut
to 300 characters). Describe the session in your own, generic words: what you write is stored, the prompts are not.
- title: at most 8 words naming the session's main task.
- summary: 3 to 5 sentences: the goal, what was done, and the outcome, stating only what the prompts show. When a summary
  so far is given, extend it so it covers the whole session.
- intents: exactly one per prompt, in the same order: the kind of task that prompt asks for, at most 12 words, starting
  with a verb.
For every field: write in English; never repeat a prompt's wording; replace every name of a person, project, product,
file, path, URL, host, key, password or other secret with a generic noun such as "the project", "a module", "a config file"."""

SESSION_SQL = """
insert into sessions (id, user_id, project_id, title, model, started_at, ended_at, turns, tokens, source, status, git_branch, transcript_path)
values (%(id)s, %(u)s, %(p)s, %(title)s, %(model)s, coalesce(%(start)s::timestamptz, now()), %(end)s::timestamptz, %(turns)s,
  %(tokens)s, 'history', 'pending', %(branch)s, %(path)s)
on conflict (id) do update set
  title = case when %(custom)s or sessions.processed_at is null then excluded.title else sessions.title end,
  model = excluded.model, started_at = excluded.started_at, ended_at = excluded.ended_at, turns = excluded.turns,
  tokens = excluded.tokens, git_branch = excluded.git_branch, transcript_path = excluded.transcript_path,
  status = case when sessions.status = 'processed' and sessions.processed_at is not null and sessions.turns = excluded.turns
    and not exists (select 1 from decisions d where d.session_id = sessions.id and d.source = 'hook' and d.at > sessions.processed_at)
    then 'processed' else 'pending' end
"""
FILE_SQL = """
insert into history_files (user_id, path, session_id, size, mtime, rows, status, error)
values (%(u)s, %(path)s, %(sid)s, %(size)s, %(mtime)s, %(rows)s, %(status)s, %(error)s)
on conflict (user_id, path) do update set session_id = excluded.session_id, size = excluded.size, mtime = excluded.mtime,
  rows = excluded.rows, status = excluded.status, error = excluded.error, imported_at = now()
where (history_files.size, history_files.mtime, history_files.status, history_files.error)
  is distinct from (excluded.size, excluded.mtime, excluded.status, excluded.error)
"""
DECISION_SQL = """
insert into decisions (user_id, session_id, project_id, ref, prompt, abstained, followed, confidence, difficulty, model_tier,
  latency_ms, bundle, stages, at, source)
values (%(u)s, %(s)s, %(p)s, %(ref)s, %(prompt)s, %(abstained)s, %(followed)s, %(confidence)s, %(difficulty)s, %(model_tier)s,
  %(latency_ms)s, %(bundle)s, %(stages)s, coalesce(%(at)s::timestamptz, now()), 'history')
on conflict (session_id, ref) do update set prompt = excluded.prompt, followed = decisions.followed or excluded.followed,
  bundle = jsonb_set(decisions.bundle, '{intent}', to_jsonb(excluded.prompt))
"""
# a live hook row (or an earlier distill's) keeps its bundle; its raw prompt, there and in bundle.intent, becomes the intent.
# A row matched by text (ids) keeps the transcript ref as bundle.history_ref: its prompt was that link, so a rerun uses this
INTENT_SQL = """
update decisions set prompt = %(prompt)s, bundle = jsonb_set(bundle, '{intent}', to_jsonb(%(prompt)s::text))
  || case when id = any(%(ids)s) then jsonb_build_object('history_ref', %(ref)s::text) else '{}' end,
  followed = followed or %(followed)s
where session_id = %(s)s and (ref = %(ref)s or id = any(%(ids)s))
"""
# per (project, step capability): n = decisions suggesting it, k = of those, the ones where Claude called it (Skill /
# Agent / Task event naming its invoke, id or agent) before the session's next decision
OUTCOME_SQL = """
with d as (
  select session_id, project_id, at, bundle->'steps' as steps, lead(at) over (partition by session_id order by at) as nxt
  from decisions where user_id = %(u)s and not abstained
), s as (
  select d.project_id, x->>'cap_id' as cap_id, x->>'invoke' as invoke,
    exists (select 1 from events e where e.session_id = d.session_id and e.type = 'tool' and e.at >= d.at
            and (d.nxt is null or e.at < d.nxt) and e.payload->>'name' in (x->>'invoke', x->>'cap_id', x->>'agent')) as used
  from d, jsonb_array_elements(d.steps) x
)
select s.project_id, p.name, s.cap_id, max(s.invoke) as invoke, count(*) as n, count(*) filter (where used) as k
from s join projects p on p.user_id = %(u)s and p.id = s.project_id
group by s.project_id, p.name, s.cap_id having count(*) >= 3
"""
# newest row per (project, cap) this phase wrote: live = current, deleted = the user retired it (a supersede leaves a newer live row)
OWN_OUTCOMES_SQL = """
select distinct on (project_id, source->>'cap_id') id::text as id, project_id, source->>'cap_id' as cap_id, text, deleted_at
from memories where user_id = %s and source->>'kind' = 'history-outcome' order by project_id, source->>'cap_id', created_at desc
"""
PENDING_SQL = """
select s.id from sessions s join projects p on p.user_id = s.user_id and p.id = s.project_id
where s.user_id = %(u)s and s.status in ('pending', 'failed') and s.transcript_path is not null
  and (%(pr)s::text[] is null or p.name = any(%(pr)s) or regexp_replace(p.path, '^.*/', '') = any(%(pr)s))
  and not exists (select 1 from jobs j where j.user_id = s.user_id and j.kind = 'distill' and j.status in ('queued', 'running')
                  and j.payload->>'session_id' = s.id)
order by s.started_at desc
"""


def typed_prompt(row) -> str:
    """The user's typed prompt, or '' for meta / tool-result / system-injected rows (shared with evaluation/label.py)."""
    if not isinstance(row, dict) or row.get("type") != "user" or row.get("isMeta"):
        return ""
    m = row.get("message")
    c = m.get("content") if isinstance(m, dict) else None
    parts = [{"type": "text", "text": c}] if isinstance(c, str) else [p for p in c if isinstance(p, dict)] if isinstance(c, list) else []
    if any(p.get("type") == "tool_result" for p in parts):
        return ""
    # Per part: IDE clients put an injected <ide_opened_file>/<ide_selection> part before the typed one.
    texts = (str(p.get("text", "")).strip() for p in parts if p.get("type") == "text")
    return "\n".join(t for t in texts if t and not t.startswith(("<", "[Request interrupted")))


def _files(path: Path) -> list[Path]:
    return [path, *sorted(path.with_suffix("").glob("subagents/*.jsonl"))]


def fingerprint(path: Path) -> tuple[int, int]:
    """(bytes, newest mtime_ns) of a main transcript and its subagents/: a subagent finishing later changes the session."""
    st = [f.stat() for f in _files(path)]
    return sum(s.st_size for s in st), max(s.st_mtime_ns for s in st)


def parse(path: Path) -> dict:
    """One main transcript + its <session>/subagents/*.jsonl, streamed. prompts (main file, no sidechains): (timestamp,
    text as Claude Code got it, typed text), in memory only; tools: (timestamp, tool, name) of Skill / Agent / Task calls,
    subagents' included; tokens summed once per message id (one API response spans several rows); model = most used."""
    p = {"cwd": "", "branch": "", "title": "", "start": "", "end": "", "rows": 0, "prompts": [], "tools": []}
    usage, models, seen = {}, {}, set()
    for f in _files(path):
        main = f == path
        with f.open(encoding="utf-8", errors="replace") as fh:
            for line in fh:
                p["rows"] += 1
                try:
                    row = orjson.loads(line)
                except orjson.JSONDecodeError:
                    continue
                if not isinstance(row, dict):
                    continue
                ts = row["timestamp"] if isinstance(row.get("timestamp"), str) else ""
                if main:
                    if ts:
                        p["start"], p["end"] = min(p["start"] or ts, ts), max(p["end"], ts)
                    for k, field in (("cwd", "cwd"), ("branch", "gitBranch"), ("title", "customTitle")):  # first cwd, last others
                        if isinstance(v := row.get(field), str) and v and not (k == "cwd" and p["cwd"]):
                            p[k] = v
                    # ponytail: a forked / resumed session copies earlier rows, so their prompts count in both sessions
                    if not row.get("isSidechain") and (t := typed_prompt(row)):
                        c = row["message"]["content"]
                        p["prompts"].append((ts, c if isinstance(c, str) else t, t))
                m = row.get("message")
                if not isinstance(m, dict):
                    continue
                if isinstance(m.get("usage"), dict):
                    mid = m.get("id") or f"{f}:{p['rows']}"
                    usage[mid] = sum(v for k, v in m["usage"].items() if k.endswith("_tokens") and isinstance(v, int))
                    if m.get("model") and m["model"] != "<synthetic>":
                        models[mid] = m["model"]
                for b in m["content"] if row.get("type") == "assistant" and isinstance(m.get("content"), list) else []:
                    if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") in KEY and b.get("id") not in seen:
                        seen.add(b.get("id") or len(seen))  # a block id at most once; id-less blocks all kept
                        name = (b.get("input") if isinstance(b.get("input"), dict) else {}).get(KEY[b["name"]])
                        p["tools"].append((ts, b["name"], name if isinstance(name, str) else ""))
    p["tokens"], p["model"] = sum(usage.values()), Counter(models.values()).most_common(1)[0][0] if models else ""
    return p


async def _flush(store, sessions: list[dict], events: list[tuple[str, list]], files: list[dict]) -> None:
    """One transaction per batch, each statement one row (the pool's 2 s timeout). Tool events are replaced for
    history-made sessions only: a hook-made one already has them live from PostToolUse."""
    hook = {r["id"] for r in await store.fetch("select id from sessions where id = any(%s) and source = 'hook'", ([s["id"] for s in sessions],))}
    evs = [(sid, Jsonb({"tool": tool, **({"name": name} if name else {})}), ts or None)
           for sid, tools in events if sid not in hook for ts, tool, name in tools]

    async def go(conn):
        async with conn.transaction(), conn.cursor() as cur:
            if sessions:
                await cur.executemany(SESSION_SQL, sessions)
                await cur.execute("delete from events where type = 'tool' and session_id = any(%s)", ([s for s, _ in events if s not in hook],))
            if evs:
                await cur.executemany("insert into events (session_id, type, payload, at) values (%s, 'tool', %s, coalesce(%s::timestamptz, now()))", evs)
            if files:
                await cur.executemany(FILE_SQL, files)
    await store._run(go)


async def scan(store, user_id: str, claude_home, projects: list[str] | None = None, files: list[Path] | None = None,
               progress=None) -> dict:
    """Phase 1, no LLM. `files` (SessionEnd: its one transcript) defaults to <claude_home>/projects/*/*.jsonl (the glob
    depth leaves out subagents/). A file whose (size, mtime) matches history_files is not read. `projects` (names or
    folder basenames) and history.skip_projects match the transcript's cwd; those files get no row.
    -> {files, unchanged, imported, skipped (no cwd), excluded (projects / skip_projects), failed}."""
    root = Path(claude_home).expanduser().resolve() / "projects"
    files = sorted(root.glob("*/*.jsonl")) if files is None else files
    known = {r["path"]: (r["size"], r["mtime"]) for r in await store.fetch(
        "select path, size, mtime from history_files where user_id = %s and status <> 'failed'", (user_id,))}
    names = {r["id"]: r["name"] for r in await store.fetch("select id, name from projects where user_id = %s", (user_id,))}
    want, skip = set(projects or []), set(cfg()["history"]["skip_projects"])
    n, sessions, events, rows = Counter(files=len(files)), [], [], []
    for i, f in enumerate(files):
        if progress:
            await progress(i / max(len(files), 1))
        row = {"u": user_id, "path": str(f), "sid": f.stem, "size": 0, "mtime": 0, "rows": 0, "status": "imported", "error": None}
        try:
            row["size"], row["mtime"] = fingerprint(f)
            if known.get(str(f)) == (row["size"], row["mtime"]):
                n["unchanged"] += 1
                continue
            cwd = await asyncio.to_thread(transcript_cwd, f)  # reads only up to the first row with a cwd
            tags = {Path(cwd).name, names.get(project_id(cwd))} if cwd else set()
            # ponytail: excluded files get no row, so each run re-reads their first rows (cheap) to recheck
            if (want and not tags & want) or tags & skip:
                n["excluded"] += 1
                continue
            if not cwd or in_runs(cwd):  # a workflow run's own claude never feeds the router (PLAN.md m5 decision 9)
                row.update(status="skipped", error="a workflow run's own session" if cwd else "no cwd in any row")
            else:
                p = await asyncio.to_thread(parse, f)
                pid = project_id(cwd)
                if pid not in names:
                    names[pid] = await store.ensure_project(cwd, user_id)
                sessions.append({"id": f.stem, "u": user_id, "p": pid, "custom": bool(p["title"]), "model": p["model"],
                                 "title": (p["title"] or " · ".join(filter(None, (names[pid], p["start"][:10]))))[:200],
                                 "start": p["start"] or None, "end": p["end"] or None, "turns": len(p["prompts"]),
                                 "tokens": p["tokens"], "branch": p["branch"] or None, "path": str(f)})
                events.append((f.stem, p["tools"]))
                row["rows"] = p["rows"]
        except OSError as e:  # vanished or unreadable: retried next run
            row.update(status="failed", error=f"{type(e).__name__}: {e}")
        n[row["status"]] += 1
        rows.append(row)
        if len(rows) >= 100:
            await _flush(store, sessions, events, rows)
            sessions, events, rows = [], [], []
    if rows:
        await _flush(store, sessions, events, rows)
    return {k: n[k] for k in ("files", "unchanged", "imported", "skipped", "excluded", "failed")}


def _words(s: str, n: int) -> str:
    return " ".join(str(s).split()[:n])


def distill_text(llm, prompts: list[str], chunk: int = 30) -> tuple[str, str, list[str]]:
    """(title <= 8 words, summary, one <= 12-word intent per prompt), `chunk` prompts per llm.json call, each call
    extending the summary so far. The schema fixes the intent count (llama.cpp grammar); a bad answer is retried once,
    then that chunk's intents are "". Server errors propagate (the job retries). Sync: run it in asyncio.to_thread."""
    title = summary = ""
    intents: list[str] = []
    for i in range(0, len(prompts), chunk):
        part = prompts[i:i + chunk]
        schema = create_model("Distill", title=(str, Field(max_length=80)), summary=(str, Field(max_length=1000)),
                              intents=(list[Annotated[str, Field(max_length=120)]], Field(min_length=len(part), max_length=len(part))))
        user = (f"Summary so far: {summary}\n\n" if summary else "") + f"Prompts {i + 1} to {i + len(part)} of {len(prompts)}:\n" + "\n".join(
            f"{i + j}. {t or '(no text)'}" for j, t in enumerate(part, 1))
        out = None
        for _ in range(2):
            try:
                out = llm.json(SYSTEM, user, schema)
                break
            except ValueError:  # pydantic ValidationError and bad JSON are ValueErrors
                pass
        if out:
            title, summary = out.title.strip() or title, out.summary.strip() or summary
        intents += [_words(x, 12) for x in out.intents] if out else [""] * len(part)
    return _words(title, 8), summary, intents


async def distill_session(st, session_id: str) -> dict:
    """Phase 2 for one scanned session: status -> processed, or failed (and re-raised: the job retries)."""
    s = await st.store.fetchrow("select s.user_id, s.project_id, s.transcript_path, p.path as cwd from sessions s"
                                " join projects p on p.user_id = s.user_id and p.id = s.project_id where s.id = %s", (session_id,))
    if not s or not s["transcript_path"]:
        raise ValueError(f"session {session_id} has no scanned transcript")
    try:
        return await _distill(st, session_id, s)
    except Exception:
        await st.store.execute("update sessions set status = 'failed' where id = %s", (session_id,))
        raise


async def _distill(st, sid: str, s: dict) -> dict:
    c, u, path = st.cfg, s["user_id"], Path(s["transcript_path"])
    p = await asyncio.to_thread(parse, path)
    have = await st.store.fetch("select id, ref, prompt, source, bundle->'steps' as steps, bundle->>'history_ref' as href"
                                " from decisions where session_id = %s", (sid,))
    steps = {r["ref"]: r["steps"] for r in have}
    # one item per distinct prompt; ref = the live hook's sha256(session_id + prompt)[:8]; window = the Skill / Agent /
    # Task calls between this prompt and the next (subagents' by timestamp)
    items, by_ref, by_text = [], {}, {}
    for i, (ts, raw, text) in enumerate(p["prompts"]):
        nxt = p["prompts"][i + 1][0] if i + 1 < len(p["prompts"]) else "￿"
        window = [(tool, name) for t, tool, name in p["tools"] if ts and ts <= t < nxt]
        ref = hashlib.sha256((sid + raw).encode()).hexdigest()[:8]
        if ref in by_ref:
            by_ref[ref]["window"] += window
            continue
        by_ref[ref] = it = {"ref": ref, "raw": raw, "text": text, "at": ts or None, "window": window, "ids": []}
        items.append(it)
        by_text.setdefault(raw[:MAX_Q], it)
        by_text.setdefault(text[:MAX_Q], it)
    for r in have:  # hook rows: same ref, else an earlier distill's text match, else same text, else (a slash command: the
        if r["source"] == "hook" and r["ref"] not in by_ref:  # transcript logs it as tags) their own item
            if it := by_ref.get(r["href"]) or by_text.get(r["prompt"]):
                it["ids"].append(r["id"])
            else:
                items.append({"ref": r["ref"], "raw": r["prompt"], "text": r["prompt"], "at": None, "window": [], "ids": [r["id"]]})
    texts = [INJECTED.sub("", it["text"]).strip()[: c["history"]["max_prompt_chars"]] for it in items]
    title, summary, intents = await asyncio.to_thread(distill_text, st.llm, texts, c["history"]["chunk"]) if texts else ("", "", [])
    # the 3B model sometimes copies prompt wording into an intent, the title or a summary sentence, which would store raw
    # prompt text: that field (summary: that sentence) becomes "". Caught: a whole prompt of >= 15 chars or any 40-char span.
    # ponytail: a copied span under 40 chars of a longer prompt relies on SYSTEM's rule
    flat = lambda x: " ".join(x.lower().split())
    win = lambda f: {f[i:i + 40] for i in range(len(f) - 39)}
    fl = [flat(t) for t in texts]
    spans, short = set().union(*map(win, fl)), [f for f in fl if 15 <= len(f) < 40]
    echo = lambda x: not spans.isdisjoint(win(flat(x))) or any(f in flat(x) for f in short)
    intents, title = ["" if echo(x) else x for x in intents], "" if echo(title) else title
    summary = " ".join(x for x in re.split(r"(?<=[.!?])\s+", summary) if not echo(x))
    summary = "" if echo(summary) else summary  # a span across two kept sentences

    def used(bundle: dict, it: dict) -> bool:
        return any(followed(bundle, tool, {KEY[tool]: name}) for tool, name in it["window"])

    upd = [{"s": sid, "ref": it["ref"], "ids": it["ids"], "prompt": x, "followed": it["ref"] in steps and used({"steps": steps[it["ref"]]}, it)}
           for it, x in zip(items, intents) if it["ref"] in steps or it["ids"]]
    new = [(it, x) for it, x in zip(items, intents) if it["ref"] not in steps and not it["ids"]]
    qvs = []
    for i in range(0, len(new), 32):  # TEI batch; the daemon embedder's 2 s timeout holds for 32 x 2000 chars
        qvs += list(await st.embedder.embed([it["raw"][:MAX_Q] for it, _ in new[i:i + 32]], "query"))
    ctx, kw = st.ctx(s["cwd"], u), {k: c[k] for k in ("k", "depth", "rerank_top", "abstain_below")}
    ins = []
    # ponytail: replay is plain search + decide on the prompt: no session / project / memory blend, no caches
    for (it, intent), qv in zip(new, qvs):
        t, q = time.perf_counter(), it["raw"][:MAX_Q]
        b = await decide(q, await search(q, ctx, qv=qv, **kw), ctx, qv=qv)
        b.ref, b.intent = it["ref"], intent
        bd = b.model_dump()
        ins.append({"u": u, "s": sid, "p": s["project_id"], "ref": it["ref"], "prompt": intent, "abstained": b.abstained,
                    "followed": used(bd, it), "confidence": b.confidence, "difficulty": b.difficulty, "model_tier": b.model_tier,
                    "latency_ms": round((time.perf_counter() - t) * 1000, 1), "bundle": Jsonb(bd),
                    "stages": Jsonb(bd["stages"]), "at": it["at"]})
    if ins:
        await st.store.executemany(DECISION_SQL, ins)
    if upd:
        await st.store.executemany(INTENT_SQL, upd)
    mem = await extract_session(st, sid, path, s["project_id"], u)
    await st.store.execute("update sessions set title = coalesce(%s, title), summary = %s, status = 'processed', processed_at = now()"
                           " where id = %s", (None if p["title"] else title or None, summary, sid))
    return {"prompts": len(items), "inserted": len(ins), "replaced": len(upd),
            "followed": sum(r["followed"] for r in ins + upd), "memories": mem}


async def outcomes(st, user_id: str = "local") -> int:
    """Phase 3: "In <project>, <cap> was used k of n times it was suggested" per (project, capability) with n >= 3, as a
    project skill_outcome memory keyed by source {kind: history-outcome, cap_id}. Unchanged text -> nothing; new counts
    -> write_memory SUPERSEDE of the old row (similarity alone would NOOP: two counts embed at ~0.99); a row the user
    deleted stays deleted. Returns the number of memories written."""
    async def go(conn):
        async with conn.transaction():
            await conn.execute("set local statement_timeout = '60s'")  # one scan over every decision step of the user
            return await (await conn.execute(OUTCOME_SQL, {"u": user_id})).fetchall()

    own = {(r["project_id"], r["cap_id"]): r for r in await st.store.fetch(OWN_OUTCOMES_SQL, (user_id,))}
    n = 0
    for r in await st.store._run(go):
        text = f"In {r['name']}, {r['invoke']} was used {r['k']} of {r['n']} times it was suggested"
        o = own.get((r["project_id"], r["cap_id"]))
        if o and (o["deleted_at"] or o["text"] == text):
            continue
        m = Memory("project", "skill_outcome", text, r["project_id"], source={"kind": "history-outcome", "cap_id": r["cap_id"]},
                   supersedes=o["id"] if o else None)
        await write_memory(m, st.store, st.embedder, user_id, update=False)  # update=False: never rewrite another cap's row
        n += 1
    return n


async def status(store, user_id: str, claude_home) -> dict:
    """HistoryStatus {root, files, imported, pending, processed, failed, last_job} (PLAN.md "History import design" API)."""
    root = Path(claude_home).expanduser().resolve() / "projects"
    r = await store.fetchrow(
        "select (select count(*) from history_files where user_id = %(u)s and status = 'imported') as imported,"
        " count(*) filter (where status = 'pending') as pending, count(*) filter (where status = 'processed') as processed,"
        " count(*) filter (where status = 'failed') as failed from sessions where user_id = %(u)s and transcript_path is not null",
        {"u": user_id})
    last = await store.fetchrow(f"select {COLS} from jobs where user_id = %s and kind = 'history' order by created_at desc limit 1", (user_id,))
    return {"root": str(root), "files": sum(1 for _ in root.glob("*/*.jsonl")), **r, "last_job": last}


def _local_only(st) -> None:
    if st.cfg["mode"] != "local":  # shared mode: the transcripts are on the client's disk, never read the daemon host's
        raise ValueError("history import reads transcripts on the daemon host: local mode only")


def _transcript(st, path) -> Path:
    """A main transcript <claude_home>/projects/<project>/<session>.jsonl, symlinks resolved: the path arrives in a hook
    request and the TCP port is open to every local user."""
    p, root = Path(path).expanduser().resolve(), Path(st.cfg["claude_home"]).expanduser().resolve() / "projects"
    if p.suffix != ".jsonl" or p.parent.parent != root:
        raise ValueError(f"not a main Claude Code transcript: {p}")
    return p


async def run_job(st, payload: dict, progress) -> dict:
    """Job kind `history` (daemon start, POST /api/history/import, `ctc history import`). payload: {process?: true,
    projects?: [name], user_id?}. Phase 1 + 3, then one `distill` job per pending (or failed) session.
    ponytail: phase 3 runs before this run's distills, so outcomes lag one history job behind (`ctc history import` reruns it)."""
    _local_only(st)
    u, projects = payload.get("user_id", "local"), payload.get("projects") or None
    out = await scan(st.store, u, st.cfg["claude_home"], projects, progress=progress)
    out["outcomes"] = await outcomes(st, u)
    out["submitted"] = 0
    if payload.get("process", True):
        # ponytail: a failed session is retried on every history job (2 attempts each); give up after N if one keeps failing
        for r in await st.store.fetch(PENDING_SQL, {"u": u, "pr": projects}):
            await submit(st, "distill", {"session_id": r["id"], "user_id": u}, u)
            out["submitted"] += 1
    return out


async def run_distill(st, payload: dict, progress) -> dict:
    """Job kind `distill`. payload: {session_id, user_id?, transcript_path?}. With transcript_path (SessionEnd) the file
    is scanned first and the session distilled even if processed; a session that cannot be imported (no cwd,
    skip_projects) still gets A3 extraction. Without it (history job), an already processed session is skipped."""
    _local_only(st)
    sid, u = payload["session_id"], payload.get("user_id", "local")
    path = _transcript(st, payload["transcript_path"]) if payload.get("transcript_path") else None
    if path:
        await scan(st.store, u, st.cfg["claude_home"], files=[path])
    s = await st.store.fetchrow("select status, transcript_path from sessions where id = %s", (sid,))
    if not s or not s["transcript_path"]:
        return {"extract": await extract_session(st, sid, path, payload.get("project_id"), u)} if path else {"skipped": "not imported"}
    if not path and s["status"] == "processed":
        return {"skipped": "already processed"}
    return await distill_session(st, sid)


if __name__ == "__main__":
    import json
    import tempfile
    from types import SimpleNamespace

    import psycopg

    from ctc.embedding.embedder import Embedder
    from ctc.ingestion.scanner import Capability
    from ctc.llm.client import Llm
    from ctc.reranking.reranker import Reranker
    from ctc.server.state import State
    from ctc.storage.local import doc_text
    from ctc.storage.store import Store

    # in_runs (hooks, scan, backfill): a run's own claude under any home's runs dir, a teammate's too; nothing else
    assert in_runs("/home/mate/.claudethecaller/runs/7/wt") and in_runs("/Users/x/.claudethecaller/runs")
    assert not (in_runs("/home/mate/.claudethecaller/runsX/7") or in_runs("/home/mate/proj") or in_runs(""))
    SELF = "ctc_selfcheck_history"
    OWN = "-home-aiface-dangnguyenducanh-claudethecaller"  # this repo's sessions: never the real sample
    DSN = cfg()["database_url"]
    assert DSN and psycopg.conninfo.conninfo_to_dict(DSN).get("host") in ("127.0.0.1", "localhost"), \
        "the self-check writes a throwaway schema: point CTC_DATABASE_URL at the dev DB"

    class Stub:  # Llm-like, no llama calls: intents never echo the prompt
        def __init__(self, fail: int = 0, echo: bool = False):
            self.calls, self.fail, self.echo = [], fail, echo

        def json(self, system, user, schema):
            self.calls.append((schema.__name__, user))
            if schema.__name__ == "Extraction":
                return schema.model_validate({"memories": []})
            if len(self.calls) <= self.fail:
                raise ValueError("bad JSON")
            n = schema.model_json_schema()["properties"]["intents"]["minItems"]
            said = re.findall(r"^\d+\. (.*)$", user, re.MULTILINE)
            return schema.model_validate({"title": "Write and ship a parser with tests first today",
                                          "summary": f"The user {f'said {said[0][:45]}' if self.echo else 'worked on a parser'} ({len(self.calls)}). Tests came first.",
                                          "intents": [said[j][:120] if self.echo else f"asks for step {j}" for j in range(n)]})

    class Spy:
        def __init__(self, llm):
            self.llm, self.calls = llm, []

        def json(self, system, user, schema):
            self.calls.append(schema.__name__)
            return self.llm.json(system, user, schema)

    # distill_text: chunks with a rolling summary, retry once, then empty intents
    sp = Stub()
    title, summary, intents = distill_text(sp, ["a", "b", "c", "d", "e"], chunk=2)
    assert len(sp.calls) == 3 and intents == ["asks for step 0", "asks for step 1"] * 2 + ["asks for step 0"], (sp.calls, intents)
    assert "Summary so far: The user worked on a parser (1)" in sp.calls[1][1] and "4. d" in sp.calls[1][1]
    assert title == "Write and ship a parser with tests first" and summary.endswith("(3). Tests came first."), (title, summary)
    assert distill_text(Stub(fail=1), ["a"])[2] == ["asks for step 0"]
    assert distill_text(Stub(fail=2), ["a", "b"]) == ("", "", ["", ""])

    def jl(path: Path, rows: list) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(map(json.dumps, rows)) + "\nnot json\n[1]\n")
        return path

    T = lambda s: f"2026-10-20T10:{s:02d}:00.000Z"
    user = lambda t, s, **kw: {"type": "user", "timestamp": T(s), "cwd": "/x/app", "gitBranch": "main", "message": {"content": t}, **kw}

    def tool(skill: str, s: int, mid: str, tokens: int = 10, model: str = "claude-a") -> dict:
        return {"type": "assistant", "timestamp": T(s), "message": {"id": mid, "model": model, "usage": {"input_tokens": tokens, "output_tokens": 1},
                "content": [{"type": "tool_use", "id": f"tu-{mid}", "name": "Skill", "input": {"skill": skill}}]}}

    RAW = ["zebra-raw-1 please write the failing tests first for the parser using TDD", "zebra-raw-2 deploy the service to production now",
           "zebra-raw-3 review my diff for bugs", "zebra-raw-4 write tests first with TDD for the utils", "/commit zebra-raw-5"]
    home = Path(tempfile.mkdtemp())
    app = home / "projects" / "-x-app"
    s1 = jl(app / "s1.jsonl", [
        {"type": "queue-operation", "operation": "enqueue"}, user(RAW[0], 1),
        tool("tdd", 2, "m1", 100), tool("tdd", 2, "m1", 100),  # one API response over two rows: counted once
        user([{"type": "tool_result", "content": "zebra-tool-output"}], 3), user(RAW[1], 4), tool("unknown-skill", 5, "m2", 30, "claude-b"),
        user("Caveat: zebra-meta", 6, isMeta=True), user("<command-name>/clear</command-name>", 7), user(RAW[2], 8),
        {"type": "assistant", "timestamp": T(9), "message": {"id": "m3", "model": "claude-a", "usage": {"output_tokens": 5}, "content": [{"type": "text", "text": "ok"}]}}])
    jl(app / "s1" / "subagents" / "agent-x.jsonl", [user("zebra-sub subagent task prompt", 9), tool("review", 10, "m9", 50)])
    s2 = jl(app / "s2.jsonl", [user(RAW[3], 20), tool("tdd", 21, "m20"), {"type": "custom-title", "customTitle": "My custom title", "sessionId": "s2"}])
    jl(home / "projects" / "-x-none" / "s3.jsonl", [{"type": "user", "message": {"content": "zebra-nocwd"}}])

    async def drop() -> None:
        async with await psycopg.AsyncConnection.connect(DSN, autocommit=True) as conn:
            await conn.execute(f"drop schema if exists {SELF} cascade")

    async def check() -> None:
        s = await Store.open(DSN, SELF)
        c = {**cfg(), "mode": "local", "claude_home": str(home)}
        st = State(c, s, None, Embedder(c["embed_url"], 30), Reranker(c["rerank_url"], 30), Stub())
        try:
            caps = [Capability(f"user:{n}", "skill", n, "user", d, "body", f"/x/{n}/SKILL.md", "h") for n, d in (
                ("tdd", "Test-driven development: write the failing tests first, then the code"),
                ("deploy", "Deploy the service to production"), ("review", "Review a diff for bugs before merging"))]
            await s.upsert(caps, ["user"])
            await s.insert_vectors([(x.id, "t", "m", doc_text(x), v) for x, v in zip(caps, await st.embedder.embed([doc_text(x) for x in caps], "doc"))])
            # a live hook session: raw title, a raw decision for RAW[3] and one for a slash command, a PostToolUse event
            await s.ensure_project("/x/app")
            pid = project_id("/x/app")
            hb = lambda raw: Jsonb({"intent": raw, "abstained": False, "steps": [{"order": 1, "cap_id": "user:tdd", "invoke": "tdd", "kind": "skill", "reason": "r"}]})
            await s.execute("insert into sessions (id, project_id, title, turns) values ('s2', %s, %s, 2)", (pid, RAW[3]))
            await s.executemany("insert into decisions (session_id, project_id, ref, prompt, abstained, bundle, at) values ('s2', %s, %s, %s, false, %s, %s)",
                                [(pid, hashlib.sha256(("s2" + r).encode()).hexdigest()[:8], r, hb(r), T(at)) for r, at in ((RAW[3], 20), (RAW[4], 22))])
            await s.execute("insert into events (session_id, type, payload, at) values ('s2', 'tool', %s, %s)", (Jsonb({"tool": "Skill", "name": "tdd"}), T(21)))

            # phase 1: structure only; a second scan reads nothing and writes nothing
            r1 = await scan(s, "local", home)
            assert r1 == {"files": 3, "unchanged": 0, "imported": 2, "skipped": 1, "excluded": 0, "failed": 0}, r1
            ses = {r["id"]: r for r in await s.fetch("select * from sessions")}
            a = ses["s1"]
            assert (a["source"], a["status"], a["turns"], a["tokens"], a["model"], a["git_branch"], a["title"]) == (
                "history", "pending", 3, 101 + 31 + 5 + 51, "claude-a", "main", "app · 2026-10-20"), a
            assert a["transcript_path"] == str(s1.resolve()) and a["started_at"].minute == 1 and a["ended_at"].minute == 9
            assert (ses["s2"]["source"], ses["s2"]["status"], ses["s2"]["title"]) == ("hook", "pending", "My custom title"), ses["s2"]
            ev = await s.fetch("select session_id, payload from events order by at")
            assert [(e["session_id"], e["payload"]["name"]) for e in ev] == [("s1", "tdd"), ("s1", "unknown-skill"), ("s1", "review"), ("s2", "tdd")], ev
            assert await s.fetchval("select error from history_files where session_id = 's3'") == "no cwd in any row"

            async def snap():
                return [await s.fetch(f"select * from {t} order by 1, 2") for t in ("history_files", "sessions", "events", "decisions")]
            before = await snap()
            assert (await scan(s, "local", home))["unchanged"] == 3 and await snap() == before
            assert (await scan(s, "local", home, projects=["nope"]))["unchanged"] == 3  # the fingerprint check comes first

            # history job: phase 1 + 3, then one distill job per pending session (jobs.submit faked: the real one XADDs to Redis)
            subs = []

            async def fake_submit(st_, kind, payload, user_id="local"):
                subs.append((kind, payload))
                return "job"
            globals()["submit"] = fake_submit
            r = await run_job(st, {}, None)
            assert r["submitted"] == 2 and r["outcomes"] == 0 and sorted(p["session_id"] for _, p in subs) == ["s1", "s2"], (r, subs)
            for kind, payload in subs:
                assert kind == "distill" and (await run_distill(st, payload, None))["prompts"] >= 1
            assert (await run_distill(st, {"session_id": "s1"}, None)) == {"skipped": "already processed"}
            assert len([x for x in st.llm.calls if x[0] == "Distill"]) == 2 and len(st.llm.calls) == 4  # + one A3 call each

            ses = {r["id"]: r for r in await s.fetch("select * from sessions")}
            assert (ses["s1"]["status"], ses["s1"]["title"], ses["s2"]["title"]) == ("processed", "Write and ship a parser with tests first", "My custom title"), ses
            assert ses["s1"]["summary"].startswith("The user worked on a parser") and ses["s1"]["processed_at"]
            dec = {r["prompt"]: r for r in await s.fetch("select * from decisions where session_id = 's1'")}
            assert {d["source"] for d in dec.values()} == {"history"} and [dec[f"asks for step {j}"]["followed"] for j in range(3)] == [True, False, True], dec
            assert dec["asks for step 0"]["at"].minute == 1 and dec["asks for step 0"]["bundle"]["intent"] == "asks for step 0"
            assert [x["invoke"] for x in dec["asks for step 0"]["bundle"]["steps"]] and not dec["asks for step 0"]["abstained"]
            hk = {r["ref"]: r for r in await s.fetch("select * from decisions where session_id = 's2'")}
            assert len(hk) == 2 and all(r["source"] == "hook" and r["prompt"].startswith("asks for step") and r["bundle"]["intent"] == r["prompt"] for r in hk.values())
            assert sorted(r["followed"] for r in hk.values()) == [False, True], hk

            # SessionEnd path: scan the one file, distill again; guards on the path
            st.llm = Stub(echo=True)  # an intent that copies its prompt is dropped
            assert (await run_distill(st, {"session_id": "s2", "transcript_path": str(s2)}, None))["replaced"] == 2
            assert [r["prompt"] for r in await s.fetch("select prompt from decisions where session_id = 's2'")] == ["", ""]
            assert await s.fetchval("select summary from sessions where id = 's2'") == "Tests came first."  # the echoing sentence dropped
            for bad in ("/etc/passwd", app / "s1" / "subagents" / "agent-x.jsonl", home / "s2.jsonl"):
                try:
                    await run_distill(st, {"session_id": "x", "transcript_path": str(bad)}, None)
                    raise AssertionError(f"read {bad}")
                except ValueError:
                    pass
            try:
                await run_job(SimpleNamespace(cfg={**c, "mode": "shared"}), {}, None)
                raise AssertionError("shared mode read the host's transcripts")
            except ValueError:
                pass

            # phase 3: tdd suggested 5x (s1 x3, s2 x2), called after s1 #1 and s2 #1; deploy never; review once (subagent)
            assert await outcomes(st) == 3 and await outcomes(st) == 0
            got = {r["text"] for r in await s.fetch("select text from memories where kind = 'skill_outcome' and deleted_at is null")}
            assert got == {"In app, tdd was used 2 of 5 times it was suggested", "In app, deploy was used 0 of 3 times it was suggested",
                           "In app, review was used 1 of 3 times it was suggested"}, got
            await s.execute("update memories set text = 'stale', hash = 'stale' where text like 'In app, tdd%%'")
            await s.execute("update memories set deleted_at = now() where text like 'In app, deploy%%'")
            assert await outcomes(st) == 1
            assert await s.fetchval("select count(*) from memories where kind = 'skill_outcome' and deleted_at is null") == 2
            assert await s.fetchval("select supersedes is not null from memories where text like 'In app, tdd%%' and deleted_at is null")

            # privacy: no raw prompt, tool output or meta text anywhere the import wrote
            dump = " ".join([str(x) for t in ("history_files", "sessions", "events", "decisions", "memories")
                             for x in await s.fetch(f"select * from {t}")])
            assert not re.search(r"zebra-(raw|sub|tool|meta|nocwd)", dump), re.findall(r".{40}zebra-\w+.{20}", dump)
            print("synthetic: scan x2, 2 sessions distilled (stub LLM), followed, outcomes, privacy ok")

            # ONE real transcript (read-only), the real local LLM: one Distill + one A3 call (<= 3 with a retry)
            real = Path(cfg()["claude_home"]) / "projects"
            pick = next(f for f in sorted(real.glob("*/*.jsonl"), key=lambda f: f.stat().st_size)
                        if not f.parent.name.startswith(OWN) and transcript_cwd(f) and 3 <= len(parse(f)["prompts"]) <= 10)
            assert (await scan(s, "local", real.parent, files=[pick]))["imported"] == 1
            st.llm, st.cfg = Spy(Llm(cfg()["llm"])), {**c, "claude_home": str(real.parent)}
            t0 = time.perf_counter()
            r = await run_distill(st, {"session_id": pick.stem}, None)
            row = await s.fetchrow("select title, summary, turns from sessions where id = %s", (pick.stem,))
            print(f"real {pick.parent.name}/{pick.name} ({pick.stat().st_size} B, {row['turns']} prompts):"
                  f" {time.perf_counter() - t0:.1f}s, {len(st.llm.calls)} LLM calls {st.llm.calls}, {r}")
            print(f"  title:   {row['title']}\n  summary: {row['summary']}")
            for d in await s.fetch("select prompt, followed, bundle->'steps'->0->>'invoke' as top from decisions where session_id = %s order by at", (pick.stem,)):
                print(f"  intent:  {d['prompt']}  (top {d['top']}, followed {d['followed']})")
            assert len(st.llm.calls) <= 3 and row["title"]
            dump = " ".join([str(x) for t in ("sessions", "decisions", "events") for x in await s.fetch(f"select * from {t} where {'id' if t == 'sessions' else 'session_id'} = %s", (pick.stem,))])
            assert not [t for _, _, t in parse(pick)["prompts"] if len(t) >= 15 and t[:40].lower() in dump.lower()], "raw prompt stored"
        finally:
            await st.embedder.aclose()
            await st.reranker.aclose()
            await s.close()

    async def main() -> None:
        await drop()
        try:
            await check()
        finally:
            await drop()
        print("history self-check ok")

    asyncio.run(main())
