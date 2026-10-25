"""/mcp over streamable HTTP (mcp 2.x MCPServer): find_capabilities (PLAN.md B5, B6); run_workflow and workflow_status
(m5 WB13: local mode only, this login's runs, through server/runs.py's submit and read paths)."""

from __future__ import annotations

import contextlib

from fastapi import HTTPException
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import CallToolResult, TextContent

from ctc.decision.bundle import plan_text
from ctc.server import runs
from ctc.server.hooks import cached_bundle, route
from ctc.server.state import State

mcp = MCPServer("claudethecaller", instructions="Routes a coding task to the installed skills, agents, commands and workflows.")
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
async def run_workflow(workflow: str, input: str = "", ctx: Context | None = None) -> dict:
    """Start a saved ctc workflow on this machine's Claude login, in its own git worktree and branch. `workflow` is its
    capability id or its unique name; `input` fills {{input}}. Returns {run_id} at once; then call workflow_status."""
    with _api_errors():
        st, u, o = await runs.scope(state, _user(ctx))
        ids = [workflow] if workflow in st.store.catalog else sorted(
            i for i, c in st.store.catalog.items() if c["kind"] == "workflow" and c["name"] == workflow)
        if len(ids) != 1:
            raise ToolError(f"{workflow!r} names {len(ids)} workflows; pass one id of {ids}" if ids else f"no workflow {workflow!r}")
        return {"run_id": await runs.submit_run(st, u, o, ids[0], input, trigger="mcp")}


@mcp.tool()
async def workflow_status(run_id: int, ctx: Context | None = None) -> dict:
    """A workflow run's {status (queued, running, waiting, done, failed, cancelled, quota), error, quota_resets_at,
    steps: [{node_id, visit, status}]}."""
    with _api_errors():
        st, u, o = await runs.scope(state, _user(ctx))
        r = await runs._run(st, u, o, run_id)
        steps = await st.store.fetch("select node_id, visit, status from wf_steps where run_id = %s order by id", (run_id,))
        return {"status": r["status"], "error": r["error"],
                "quota_resets_at": r["quota_resets_at"] and r["quota_resets_at"].isoformat(), "steps": steps}


def mcp_app():
    """ASGI app for mounting at /mcp; app.py runs mcp.session_manager.run() in its lifespan."""
    sub = mcp.streamable_http_app(streamable_http_path="/")

    async def app(scope, receive, send):
        global state
        if scope["type"] == "http":
            state = scope["app"].state.ctc  # the mounting FastAPI app (a mounted Starlette app rewrites scope["app"])
        await sub(scope, receive, send)

    return app
