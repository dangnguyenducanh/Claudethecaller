"""/api workflow runs (PLAN.md m5 "API"): start, list, detail, step log + diff, run diff, compare, cancel, approve,
continue; schedules.

Local mode only, and scoped to this machine's claude login (`claude auth status` email = wf_runs.owner).
"""

from __future__ import annotations

import asyncio
import gzip
import hashlib
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Query, Request

from ctc.runner import engine, schedule
from ctc.runner.export import to_js
from ctc.runner.graph import load
from ctc.server.api import ctx, fail
from ctc.server.library import _cap_root, _inside, _known, _local_only, check_graph
from ctc.server.schemas import (
    Diff,
    Ok,
    Run,
    RunApprove,
    RunContinue,
    RunDetail,
    RunRef,
    RunStart,
    RunStatus,
    RunTrigger,
    Schedule,
    ScheduleSet,
    StepLog,
    WorkflowExport,
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
    return await scope(*ctx(request))


async def scope(st, u: str) -> tuple:
    """(st, u, owner) for the run endpoints and the MCP run tools: local mode only, this machine's claude login."""
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
    return {"run_id": await submit_run(st, u, o, cap_id, b.input, b.project, b.trigger)}


async def submit_run(st, u: str, o: str, cap_id: str, text: str = "", project: str | None = None, trigger: str = "api") -> int:
    """Queue a run of the workflow file as it is now (POST /runs, schedules, MCP run_workflow); 422 invalid_graph /
    project_required."""
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
    elif project and (p := await st.store.fetchrow("select id, path from projects where user_id = %s and name = %s", (u, project))):
        repo, pid = p["path"], p["id"]
    else:
        fail(422, "project_required", "a user or plugin workflow needs a project to run in: pass project (its name)")
    return await engine.submit(st, o, cap_id, g, sha, str(repo), pid, trigger, text)


@router.put("/workflows/{cap_id}/schedule", response_model=Schedule)
async def set_schedule(cap_id: str, b: ScheduleSet, request: Request):
    """This login's cron for a project workflow (it runs in that project); the runner fires it (trigger `schedule`)
    and holds a fire while you work (ctc.runner.schedule)."""
    st, _, o = await _scope(request)
    c = _known(st, cap_id)
    if c["kind"] != "workflow" or not c["namespace"].startswith("project@"):
        fail(422, "project_required", f"{cap_id} is not a project's workflow: only those can be scheduled")
    if not schedule.valid(b.cron):
        fail(422, "bad_cron", f"{b.cron!r} is not a cron: 5 fields, min hour dom mon dow")
    r = await st.store.fetchrow(
        "insert into wf_schedules (owner, workflow, cron, input, enabled) values (%s, %s, %s, %s, %s)"
        " on conflict (owner, workflow) do update set cron = excluded.cron, input = excluded.input, enabled = excluded.enabled"
        " returning *", (o, cap_id, b.cron, b.input, b.enabled))
    schedule.ARMED[(o, cap_id)] = datetime.now(UTC)  # slots before this save never fire
    engine.WAKE.set()  # the runner loop re-reads schedules and wakes at the next slot
    return schedule.view(r, o)


@router.delete("/workflows/{cap_id}/schedule", response_model=Ok)
async def delete_schedule(cap_id: str, request: Request):
    st, _, o = await _scope(request)
    await st.store.execute("delete from wf_schedules where owner = %s and workflow = %s", (o, cap_id))
    schedule.ARMED.pop((o, cap_id), None)
    return Ok()


@router.get("/runs", response_model=list[Run])
async def runs(request: Request, workflow: str | None = None, status: RunStatus | None = None, trigger: RunTrigger | None = None,
               limit: int = 50, before: int | None = None):
    st, u, o = await _scope(request)
    return await st.store.fetch(
        f"""select {RUN_COLS} from {RUN_FROM} where r.owner = %(o)s and (%(w)s::text is null or r.workflow = %(w)s)
        and (%(s)s::text is null or r.status = %(s)s) and (%(t)s::text is null or r.trigger = %(t)s)
        and (%(b)s::bigint is null or r.id < %(b)s) order by r.id desc limit %(n)s""",
        {"u": u, "o": o, "w": workflow, "s": status, "t": trigger, "b": before, "n": max(1, min(limit, 500))})


@router.get("/runs/compare", response_model=Diff)  # before /runs/{rid}, which would take "compare" as an id
async def compare_runs(request: Request, a: int, b: int, node: str | None = None):
    """Two runs of this owner in one repo: whole runs = git diff a.branch..b.branch; with node, that node's latest
    committed visit in each run (post_sha)."""
    st, _, o = await _scope(request)
    rows = {r["id"]: r for r in await st.store.fetch(
        """select r.id, r.repo, r.branch, (select s.post_sha from wf_steps s where s.run_id = r.id and s.node_id = %(n)s
        and s.post_sha is not null order by s.visit desc limit 1) as post_sha from wf_runs r
        where r.id = any(%(ids)s) and r.owner = %(o)s""", {"n": node, "ids": [a, b], "o": o})}
    if a not in rows or b not in rows or rows[a]["repo"] != rows[b]["repo"]:
        fail(422, "not_comparable", f"runs {a} and {b} are not two of your runs in one repo")
    ref = "post_sha" if node else "branch"
    if not (rows[a][ref] and rows[b][ref]):
        fail(422, "not_comparable", f"node {node} has no commit in both runs" if node else "a run has not started yet")
    try:
        return await engine.git_diff(rows[a]["repo"], rows[a][ref], rows[b][ref])
    except RuntimeError as e:  # a branch was deleted
        fail(404, "not_found", str(e))


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


@router.post("/runs/{rid}/approve", response_model=Run)
async def approve_run(rid: int, b: RunApprove, request: Request):
    """A run waiting at an approval node: approve -> it walks on (queued); reject -> cancelled."""
    st, u, o = await _scope(request)
    await _run(st, u, o, rid)
    if not await engine.approve(st, rid, o, b.approve, b.note):
        fail(409, "not_waiting", f"run {rid} is not waiting for an approval")
    return await _run(st, u, o, rid)


@router.post("/runs/{rid}/continue", response_model=Run)
async def continue_run(rid: int, b: RunContinue, request: Request):
    """A run out of usage (quota): now -> queued at once; reset -> it goes on by itself once its usage window resets."""
    st, u, o = await _scope(request)
    await _run(st, u, o, rid)
    if not await engine.resume(st, rid, o, b.when == "now"):
        fail(409, "not_quota", f"run {rid} is not stopped at a usage limit")
    return await _run(st, u, o, rid)


@router.post("/workflows/{cap_id}/export", response_model=WorkflowExport)
async def export_workflow(cap_id: str, request: Request):
    """Write the workflow as a Claude Code workflow script, <root>/.claude/workflows/<name>.js (ctc.runner.export):
    422 has_approval (a native run can't pause for a sign-off), 409 conflict when a different file is already there."""
    st, _ = ctx(request)
    _local_only(st, "workflows can only be exported")
    c = _known(st, cap_id)
    if c["kind"] != "workflow":
        fail(422, "invalid", f"{cap_id} is a {c['kind']}, not a workflow")
    try:
        g = load(c["path"])
    except OSError:
        fail(404, "not_found", f"{c['path']} is gone; reindex")
    check_graph(g)
    if gate := next((n["id"] for n in g["nodes"] if n.get("type") == "approval"), None):
        fail(422, "has_approval", f"{gate} is an approval node: a native workflow can't pause for a sign-off")
    try:
        js = to_js(g, c["name"], g.get("description") or c["description"] or "")
    except ValueError as e:
        fail(422, "not_exportable", str(e))
    root = _cap_root(st, c)
    path = root / "workflows" / f"{c['name']}.js"
    _inside(path, root)
    if path.exists() and path.read_text() != js:
        fail(409, "conflict", f"{path} already exists and differs: delete or rename it, then export again")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(js)
    return {"path": str(path)}
