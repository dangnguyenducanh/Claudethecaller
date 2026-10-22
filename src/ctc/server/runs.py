"""/api workflow runs, M1 endpoints (PLAN.md m5 "API"): start, list, detail, step log + diff, run diff, cancel.

Local mode only, and scoped to this machine's claude login (`claude auth status` email = wf_runs.owner).
"""

from __future__ import annotations

import asyncio
import gzip
import hashlib
from pathlib import Path

from fastapi import APIRouter, Query, Request

from ctc.runner import engine
from ctc.runner.graph import load
from ctc.server.api import ctx, fail
from ctc.server.library import _cap_root, _known, _local_only, check_graph
from ctc.server.schemas import (
    Diff,
    Run,
    RunDetail,
    RunRef,
    RunStart,
    RunStatus,
    RunTrigger,
    StepLog,
)

router = APIRouter(prefix="/api")
LOG_CHUNK = 1 << 20  # bytes per log poll

RUN_COLS = """r.id, r.workflow, coalesce(p.name, r.project_id) as project, r.status, r.trigger, r.input, r.branch, r.worktree,
  r.pr_url, r.error, r.quota_resets_at, r.auto_resume, r.created_at, r.started_at, r.ended_at, r.tokens,
  (select count(distinct s.node_id) from wf_steps s where s.run_id = r.id and s.status in ('done', 'skipped')) as nodes_done,
  jsonb_array_length(coalesce(r.graph->'nodes', '[]')) as nodes_total"""
RUN_FROM = "wf_runs r left join projects p on p.user_id = %(u)s and p.id = r.project_id"
STEP_COLS = """s.id, s.node_id, s.visit, s.kind, s.status, s.input, s.output, s.error, s.session_id, s.num_turns, s.usage,
  s.cost_usd, s.permission_denials, s.overage, s.files, s.diff, s.log_path, s.started_at, s.ended_at"""


async def _scope(request: Request) -> tuple:
    st, u = ctx(request)
    _local_only(st, "workflow runs only work")
    return st, u, await engine.owner() or fail(409, "not_logged_in", "claude auth status shows no login: run claude and log in")


async def _run(st, u: str, o: str, rid: int, extra: str = "") -> dict:
    r = await st.store.fetchrow(f"select {RUN_COLS}{extra} from {RUN_FROM} where r.id = %(id)s and r.owner = %(o)s",
                                {"u": u, "o": o, "id": rid})
    return r or fail(404, "not_found", f"no run {rid}")


async def _step(st, o: str, rid: int, sid: int) -> dict:
    r = await st.store.fetchrow(f"select {STEP_COLS} from wf_steps s join wf_runs r on r.id = s.run_id"
                                " where s.id = %s and s.run_id = %s and r.owner = %s", (sid, rid, o))
    return r or fail(404, "not_found", f"no step {sid} in run {rid}")


@router.post("/workflows/{cap_id}/runs", response_model=RunRef, status_code=202)
async def start_run(cap_id: str, b: RunStart, request: Request):
    st, u, o = await _scope(request)
    c = _known(st, cap_id)
    if c["kind"] != "workflow":
        fail(422, "invalid", f"{cap_id} is a {c['kind']}, not a workflow")
    try:
        g, sha = load(c["path"]), hashlib.sha256(Path(c["path"]).read_bytes()).hexdigest()
    except OSError:
        fail(404, "not_found", f"{c['path']} is gone; reindex")
    check_graph(g)
    if c["namespace"].startswith("project@"):  # a project's workflow runs in that project (its file is in its git)
        repo, pid = _cap_root(st, c).parent, c["namespace"].removeprefix("project@")
    elif b.project and (p := await st.store.fetchrow("select id, path from projects where user_id = %s and name = %s", (u, b.project))):
        repo, pid = p["path"], p["id"]
    else:
        fail(422, "project_required", "a user or plugin workflow needs a project to run in: pass project (its name)")
    return {"run_id": await engine.submit(st, o, cap_id, g, sha, str(repo), pid, b.trigger, b.input)}


@router.get("/runs", response_model=list[Run])
async def runs(request: Request, workflow: str | None = None, status: RunStatus | None = None, trigger: RunTrigger | None = None,
               limit: int = 50, before: int | None = None):
    st, u, o = await _scope(request)
    return await st.store.fetch(
        f"""select {RUN_COLS} from {RUN_FROM} where r.owner = %(o)s and (%(w)s::text is null or r.workflow = %(w)s)
        and (%(s)s::text is null or r.status = %(s)s) and (%(t)s::text is null or r.trigger = %(t)s)
        and (%(b)s::bigint is null or r.id < %(b)s) order by r.id desc limit %(n)s""",
        {"u": u, "o": o, "w": workflow, "s": status, "t": trigger, "b": before, "n": max(1, min(limit, 500))})


@router.get("/runs/{rid}", response_model=RunDetail)
async def run(rid: int, request: Request):
    st, u, o = await _scope(request)
    r = await _run(st, u, o, rid, ", r.graph, r.file_sha, r.auth")
    steps = await st.store.fetch(f"select {STEP_COLS} from wf_steps s where s.run_id = %s order by s.id", (rid,))
    return {**r, "steps": [s | {"tokens": engine.usage_tokens(s["usage"]) if s["usage"] else None} for s in steps]}


def _read(p: Path, offset: int) -> bytes:
    """LOG_CHUNK bytes from offset: the .jsonl while the node runs, its .jsonl.gz after (same bytes, same offsets)."""
    gz = p.with_name(p.name + ".gz")
    try:
        with gzip.open(gz) if gz.exists() else p.open("rb") as f:
            f.seek(offset)
            return f.read(LOG_CHUNK)
    except FileNotFoundError:  # the node never started its process
        return b""


@router.get("/runs/{rid}/steps/{sid}/log", response_model=StepLog)
async def step_log(rid: int, sid: int, request: Request, offset: int = Query(0, ge=0)):
    st, _, o = await _scope(request)
    s = await _step(st, o, rid, sid)
    done = s["status"] != "running"
    if not s["log_path"]:  # shell, trigger, if: no log file; a shell's output tails are its log
        out = s["output"] or {}
        b = f"{out.get('stdout_tail') or ''}{out.get('stderr_tail') or ''}".encode()
        return {"text": b[offset:].decode(errors="replace"), "offset": max(offset, len(b)), "done": done}
    chunk = await asyncio.to_thread(_read, Path(s["log_path"]), offset)
    if not done:
        chunk = chunk[: chunk.rfind(b"\n") + 1]  # whole lines while it is still being written
    return {"text": chunk.decode(errors="replace"), "offset": offset + len(chunk), "done": done and len(chunk) < LOG_CHUNK}


@router.get("/runs/{rid}/steps/{sid}/diff", response_model=Diff)
async def step_diff(rid: int, sid: int, request: Request):
    st, _, o = await _scope(request)
    s = await _step(st, o, rid, sid)
    d = s["diff"] or ""
    return {"diff": d, "files": s["files"] or [], "truncated": len(d) >= engine.DIFF_MAX}


@router.get("/runs/{rid}/diff", response_model=Diff)
async def run_diff(rid: int, request: Request):
    """The run's whole diff, base_sha..its branch (kept after the run)."""
    st, _, o = await _scope(request)
    r = await st.store.fetchrow("select repo, branch, base_sha from wf_runs where id = %s and owner = %s", (rid, o))
    if not r:
        fail(404, "not_found", f"no run {rid}")
    if not r["base_sha"]:  # never started
        return {"diff": "", "files": [], "truncated": False}
    try:
        return await engine.git_diff(r["repo"], r["base_sha"], r["branch"])
    except RuntimeError as e:  # the branch was deleted
        fail(404, "not_found", str(e))


@router.post("/runs/{rid}/cancel", response_model=Run)
async def cancel_run(rid: int, request: Request):
    st, u, o = await _scope(request)
    await _run(st, u, o, rid)
    await engine.cancel(st, rid, o)
    return await _run(st, u, o, rid)
