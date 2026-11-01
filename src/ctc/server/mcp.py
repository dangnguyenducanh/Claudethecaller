"""/mcp over streamable HTTP (mcp 2.x MCPServer): find_capabilities (PLAN.md B5, B6); run_workflow and workflow_status
(m5 WB13: local mode only, this login's runs, through server/runs.py's submit and read paths); graph_search, graph_explain,
graph_affected, graph_path (m6 G5: read-only pulls on the context + coding graph)."""

from __future__ import annotations

import contextlib
import time
from pathlib import Path
from typing import Literal

from fastapi import HTTPException
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import CallToolResult, TextContent

from ctc.decision.bundle import plan_text
from ctc.graph import core, query
from ctc.ingestion.scanner import project_id
from ctc.server import runs
from ctc.server.hooks import _embed, cached_bundle, route
from ctc.server.state import State

mcp = MCPServer("claudethecaller", instructions="Routes a coding task to the installed skills, agents, commands and workflows;"
                  " graph_* tools search the project's specs, tasks and decisions and the code that implements them.")
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


async def _graph(user: str, project: str | None) -> core.Graph:
    """The graph of `project` (name or path), else of this user's most recent session's project. MCP is not on the hook
    path, so a missing or 30 s old copy is loaded (or version-checked) here and awaited.
    ponytail: core.graph_for keys by cwd and never waits; MCP has a project id, so it calls the same refresh directly."""
    if project:
        pid = next((p for (u, p), n in state.names.items() if u == user and n == project), None) or await state.store.fetchval(
            "select id from projects where user_id = %s and name = %s", (user, project)) or project_id(Path(project).expanduser())
    else:
        pid = await state.store.fetchval("select project_id from sessions where user_id = %s order by started_at desc limit 1", (user,))
    if not pid:
        raise ToolError("no session yet: pass `project` (its name or path)")
    g = state.graphs.get((user, pid))
    if g is None or time.monotonic() - g.loaded_at > core.MAX_AGE_S:
        await core._refresh(state, (user, pid))
    g = state.graphs.get((user, pid))
    if g is None or not g.nodes:
        raise ToolError(f"no graph for project {project or pid}: run `ctc graph build` in it")
    return g


async def _pull(ctx: Context | None, project: str | None, fn, *args) -> CallToolResult:
    """One query.* call on the resolved graph; a node that matches nothing or several -> ToolError."""
    g = await _graph(_user(ctx), project)
    try:
        r = fn(g, *args) or {"hops": [], "truncated": 0, "text": f"no path within {query.MAX_HOPS} hops"}
    except LookupError as e:
        raise ToolError(str(e)) from e
    return CallToolResult(content=[TextContent(type="text", text=r.pop("text"))], structured_content=r)


@mcp.tool()
async def graph_search(question: str, graph: Literal["context", "coding", "both"] = "both", k: int = 8, project: str | None = None,
                       ctx: Context | None = None) -> CallToolResult:
    """Search this project's graph by meaning: context (specs, stories, requirements, tasks, tickets, decisions) and code
    (files, functions). Each hit lists the code that implements it, or the tasks a code hit implements. `project`: name or
    path (default: your latest session's). Pass a hit's id to graph_explain, graph_affected or graph_path."""
    return await _pull(ctx, project, query.search, (await _embed(state, [question]))[0], graph, k)


@mcp.tool()
async def graph_explain(node: str, project: str | None = None, ctx: Context | None = None) -> CallToolResult:
    """One graph node (id, label such as `retry` or `retry()`, or a file path): its text and up to 20 neighbours grouped
    by relation (calls, implemented_in, serves, constrains, ...)."""
    return await _pull(ctx, project, query.explain, node)


@mcp.tool()
async def graph_affected(node: str, project: str | None = None, ctx: Context | None = None) -> CallToolResult:
    """What a change to this node can break: callers, importers and subclasses up to 3 levels, plus the tasks,
    requirements and stories linked to them."""
    return await _pull(ctx, project, query.affected, node)


@mcp.tool()
async def graph_path(a: str, b: str, project: str | None = None, ctx: Context | None = None) -> CallToolResult:
    """Shortest connection between two nodes (ids, labels or file paths), ignoring edge direction, up to 6 hops."""
    return await _pull(ctx, project, query.path, a, b)


def mcp_app():
    """ASGI app for mounting at /mcp; app.py runs mcp.session_manager.run() in its lifespan."""
    sub = mcp.streamable_http_app(streamable_http_path="/")

    async def app(scope, receive, send):
        global state
        if scope["type"] == "http":
            state = scope["app"].state.ctc  # the mounting FastAPI app (a mounted Starlette app rewrites scope["app"])
        await sub(scope, receive, send)

    return app
