"""/mcp over streamable HTTP (mcp 2.x MCPServer): find_capabilities (PLAN.md B5, B6); the run tools list_workflows,
run_workflow, workflow_status, approve_run, reject_run, continue_run and cancel_run (m5 WB13, n8n-parity US4: local
mode only, this login's runs, through server/runs.py's route helpers, so the dashboard's code path and owner scoping)."""

from __future__ import annotations

import contextlib
import json
from typing import Any, Literal

import yaml
from fastapi import HTTPException
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import CallToolResult, TextContent

from ctc.decision.bundle import plan_text
from ctc.runner.graph import load
from ctc.server import runs
from ctc.server.hooks import cached_bundle, route
from ctc.server.library import _caps
from ctc.server.state import State

mcp = MCPServer("claudethecaller", instructions=(
    "Routes a coding task to the installed skills, agents, commands and workflows (find_capabilities), and runs ctc "
    "workflows on this machine: list_workflows, run_workflow, workflow_status, approve_run, reject_run, continue_run, "
    "cancel_run."))
STEP_OUT_MAX = 2000  # chars of a step's output or error in workflow_status
state: State | None = None  # this worker's State; mcp_app() sets it from the FastAPI app on each request


def _user(ctx: Context | None) -> str:
    try:  # shared mode: the auth middleware put user_id on the request state
        return ctx.request_context.request.scope.get("state", {}).get("user_id", "local")
    except (ValueError, AttributeError):  # no HTTP request (direct call_tool) -> local
        return "local"


@mcp.tool()
async def find_capabilities(task: str, blocker: str | None = None, ref: str | None = None, ctx: Context | None = None) -> CallToolResult:
    """Get the plan of installed capabilities (skills, agents, commands, workflows) for a task: ordered steps with
    reasons, plus relevant memories. Pass the `ref` from a [claudethecaller] suggestion line to get its prefetched plan;
    pass `blocker` (what went wrong) to re-route the task around it."""
    user = _user(ctx)
    b = await cached_bundle(state, ref, user) if ref and not blocker else None
    if b is None:  # ponytail: no session or cwd over MCP, so no session/project blend; the hook's ref path has both
        b = await route(state, f"{task}\nBlocked by: {blocker}" if blocker else task, "", "", user)
    return CallToolResult(content=[TextContent(type="text", text=plan_text(b))], structured_content=b.model_dump())


@contextlib.contextmanager
def _api_errors():
    """An /api error (no run, not logged in, shared mode, invalid graph, ...) -> a tool error carrying its message."""
    try:
        yield
    except HTTPException as e:
        raise ToolError(e.detail["message"]) from e


@mcp.tool()
async def run_workflow(workflow: str, input: str = "", project: str | None = None, inputs: dict[str, Any] | None = None,
                       ctx: Context | None = None) -> dict[str, Any]:
    """Start a saved ctc workflow on this machine's Claude login, in its own git worktree and branch. `workflow` is its
    capability id or its unique name; `inputs` {name: value} for a workflow whose trigger declares inputs (see
    list_workflows; values are checked and coerced), `input` the free text that fills {{input}} for one that declares
    none; `project` (a project name) is where a user or plugin workflow runs, by default the project of your latest
    prompt. Returns {run_id} at once; then call workflow_status."""
    with _api_errors():
        st, u, o = await runs.scope(state, _user(ctx))
        ids = [workflow] if workflow in st.store.catalog else sorted(
            i for i, c in st.store.catalog.items() if c["kind"] == "workflow" and c["name"] == workflow)
        if len(ids) != 1:
            raise ToolError(f"{workflow!r} names {len(ids)} workflows; pass one id of {ids}" if ids else f"no workflow {workflow!r}")
        if project is None and not st.store.catalog[ids[0]]["namespace"].startswith("project@"):
            # ponytail: MCP over HTTP carries no cwd, so the latest hooked prompt's project stands in for it; two sessions
            # in different projects may pick the other one (pass project to be exact)
            project = await st.store.fetchval(
                "select p.name from decisions d join projects p on p.user_id = d.user_id and p.id = d.project_id"
                " where d.user_id = %s order by d.at desc limit 1", (u,))
        return {"run_id": await runs.submit_run(st, u, o, ids[0], input, project, "mcp", inputs=inputs)}


@mcp.tool()
async def list_workflows(ctx: Context | None = None) -> dict[str, Any]:
    """The saved ctc workflows: {workflows: [{id, name, scope (user, project, plugin), project (its name, for a project's
    workflow), description, has_schedule (this login's schedule is on), inputs (the trigger's declared [{name, type,
    required, default, description}] to pass as run_workflow's inputs; [] = it takes free-text input)}]}."""
    with _api_errors():
        st, u, o = await runs.scope(state, _user(ctx))
        rows = await _caps(st, u, None, kind="workflow", detail=True, n=500)
    names = {r["id"]: r["name"] for r in await st.store.fetch("select id, name from projects where user_id = %s", (u,))}
    sched = {r["workflow"] for r in await st.store.fetch("select workflow from wf_schedules where owner = %s and enabled", (o,))}
    return {"workflows": [{
        "id": r["id"], "name": r["name"], "description": r["description"], "has_schedule": r["id"] in sched,
        "scope": "user" if r["namespace"] == "user" else "project" if r["namespace"].startswith("project@") else "plugin",
        "project": names.get(r["namespace"].removeprefix("project@")) if r["namespace"].startswith("project@") else None,
        "inputs": _inputs(r["path"])} for r in rows]}


def _inputs(path: str) -> list:
    """A workflow file's trigger inputs; [] when it declares none or the file is gone or unreadable."""
    try:
        g = load(path)
    except (OSError, yaml.YAMLError):
        return []
    return next((n.get("inputs") or [] for n in g["nodes"] if isinstance(n, dict) and n.get("type") == "trigger"), [])


def _cut(v):
    """A step's output or error as text of at most STEP_OUT_MAX chars (dicts as JSON); the run page has it all."""
    if v is None:
        return None
    t = v if isinstance(v, str) else json.dumps(v, default=str)
    return t if len(t) <= STEP_OUT_MAX else f"{t[:STEP_OUT_MAX]}... [{len(t) - STEP_OUT_MAX} more chars: see the run page]"


@mcp.tool()
async def workflow_status(run_id: int, ctx: Context | None = None) -> dict[str, Any]:
    """A workflow run (GET /runs/{id}): {run_id, workflow, status (queued, running, waiting, done, failed, cancelled,
    quota), error, branch, pr_url, tokens, quota_resets_at, steps: [{node_id, visit, kind, status, error, output (cut),
    tokens, input (a waiting approval's message), marker, tries (a retried shell's, when > 1)}]}."""
    with _api_errors():
        r = await runs.detail(*(await runs.scope(state, _user(ctx))), run_id)
    steps = [{"node_id": s["node_id"], "visit": s["visit"], "kind": s["kind"], "status": s["status"], "error": _cut(s["error"]),
              "output": _cut(s["output"]), "tokens": s["tokens"]}
             | ({"input": s["input"]} if s["status"] == "waiting" else {}) | ({"marker": s["marker"]} if s["marker"] else {})
             | ({"tries": s["tries"]} if s["tries"] > 1 else {})
             for s in r["steps"]]
    return {"run_id": r["id"], "workflow": r["workflow"], "status": r["status"], "error": r["error"], "branch": r["branch"],
            "pr_url": r["pr_url"], "tokens": r["tokens"],
            "quota_resets_at": r["quota_resets_at"] and r["quota_resets_at"].isoformat(), "steps": steps}


async def _control(ctx: Context | None, fn, run_id: int, *args) -> dict[str, Any]:
    """One of runs.py's control helpers (the dashboard's route code and owner scoping) -> {run_id, status, error}."""
    with _api_errors():
        r = await fn(*(await runs.scope(state, _user(ctx))), run_id, *args)
    return {"run_id": r["id"], "status": r["status"], "error": r["error"]}


@mcp.tool()
async def approve_run(run_id: int, note: str | None = None, ctx: Context | None = None) -> dict[str, Any]:
    """Approve a run waiting at an approval node: it walks on (status queued). Returns {run_id, status, error}."""
    return await _control(ctx, runs.approve, run_id, True, note)


@mcp.tool()
async def reject_run(run_id: int, note: str | None = None, ctx: Context | None = None) -> dict[str, Any]:
    """Reject a run waiting at an approval node: it ends (status cancelled). Returns {run_id, status, error}."""
    return await _control(ctx, runs.approve, run_id, False, note)


@mcp.tool()
async def continue_run(run_id: int, when: Literal["now", "reset"] = "reset", ctx: Context | None = None) -> dict[str, Any]:
    """Continue a run stopped at a usage limit (status quota): now, or by itself at its usage reset. Returns {run_id,
    status, error}."""
    return await _control(ctx, runs.resume, run_id, when == "now")


@mcp.tool()
async def cancel_run(run_id: int, ctx: Context | None = None) -> dict[str, Any]:
    """Cancel a queued, running, waiting or quota run (a running node's processes are stopped). Returns {run_id, status,
    error}."""
    return await _control(ctx, runs.cancel, run_id)


def mcp_app():
    """ASGI app for mounting at /mcp; app.py runs mcp.session_manager.run() in its lifespan."""
    sub = mcp.streamable_http_app(streamable_http_path="/")

    async def app(scope, receive, send):
        global state
        if scope["type"] == "http":
            state = scope["app"].state.ctc  # the mounting FastAPI app (a mounted Starlette app rewrites scope["app"])
        await sub(scope, receive, send)

    return app
