"""/mcp: the find_capabilities tool over streamable HTTP (PLAN.md B5, B6; mcp 2.x MCPServer)."""

from __future__ import annotations

from mcp.server.mcpserver import Context, MCPServer
from mcp_types import CallToolResult, TextContent

from ctc.decision.bundle import plan_text
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


def mcp_app():
    """ASGI app for mounting at /mcp; app.py runs mcp.session_manager.run() in its lifespan."""
    sub = mcp.streamable_http_app(streamable_http_path="/")

    async def app(scope, receive, send):
        global state
        if scope["type"] == "http":
            state = scope["app"].state.ctc  # the mounting FastAPI app (a mounted Starlette app rewrites scope["app"])
        await sub(scope, receive, send)

    return app
