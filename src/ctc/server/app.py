"""The daemon (PLAN.md B5): one FastAPI app, lifespan-owned State + background tasks, /v1 hooks, /api, /mcp, dashboard.

`uv run python -m ctc.server.app` serves it on the unix socket (local mode, 0600) and 127.0.0.1:port from one loop.
Shared mode: `uvicorn ctc.server.app:app --port 18310 --workers N` (no socket). CTC_WORKER=0 runs no job worker and
submits no startup jobs (a second daemon on the same DB, e.g. a check instance with a temp CTC_CLAUDE_HOME, whose
`index` jobs would delete the real library's rows).
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import os
import socket
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware

from ctc.config import ROOT, cfg
from ctc.server import api, hooks, library
from ctc.server.jobs import run_worker, submit
from ctc.server.mcp import mcp, mcp_app
from ctc.server.state import State, close_state, open_state
from ctc.server.writer import run_writer

log = logging.getLogger("ctc.server")
CODES = {400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 405: "method_not_allowed",
         409: "conflict", 422: "invalid", 429: "rate_limited"}


async def _inval(st: State, m: dict) -> None:
    """ctc:inval from any worker: lib → reload the catalog (new library_version) and drop derived L1 entries."""
    if m.get("scope") == "lib":
        await st.store.refresh_catalog()
        st.cache.l1_drop("bundle")
        st.cache.l1_drop("sem")
    elif m.get("scope") == "ovr":
        st.cache.l1_drop("ovr")


async def _warm(st: State) -> None:
    """The first route in a process costs ~2.6 s (joblib models, TEI /info, pool); pay it before the first prompt."""
    try:
        await hooks.route(st, "warm up the router", "", "")
    except Exception as e:  # noqa: BLE001 - model servers may still be starting; the first prompt pays instead
        log.warning("warm-up route failed: %s: %s", type(e).__name__, e)


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    st = await open_state()
    app.state.st = app.state.ctc = st  # api/library read .st, hooks/mcp read .ctc
    try:
        st.tasks += [asyncio.create_task(run_writer(st)), st.cache.subscribe_inval(lambda m: _inval(st, m))]
        if os.environ.get("CTC_WORKER", "1") != "0":
            st.tasks.append(asyncio.create_task(run_worker(st)))
            await submit(st, "index", {})  # no cwd: user + plugin roots (the daemon's cwd is not a project)
            if st.cfg["mode"] == "local":
                await submit(st, "import_memory", {})
        st.tasks.append(asyncio.create_task(_warm(st)))
        async with mcp.session_manager.run():
            yield
    finally:
        await close_state(st)


app = FastAPI(title="claudethecaller", lifespan=lifespan)


def _err(status: int, code: str, message: str, headers=None) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status, headers=headers)


@app.exception_handler(HTTPException)
async def _http_error(request: Request, e: HTTPException) -> JSONResponse:
    d = e.detail if isinstance(e.detail, dict) else {"code": CODES.get(e.status_code, f"http_{e.status_code}"), "message": str(e.detail)}
    return _err(e.status_code, d.get("code", f"http_{e.status_code}"), d.get("message", ""), e.headers)


@app.exception_handler(RequestValidationError)
async def _invalid(request: Request, e: RequestValidationError) -> JSONResponse:
    return _err(422, "invalid", "; ".join(f"{'.'.join(map(str, x['loc']))}: {x['msg']}" for x in e.errors()))


@app.exception_handler(Exception)
async def _crash(request: Request, e: Exception) -> JSONResponse:
    return _err(500, "internal", type(e).__name__)  # traceback goes to the log, not to the client


async def _key_user(st: State, authorization: str) -> str | None:
    """Bearer ctc_… → sha256 → key:{hash} (cache) else api_keys; None = no valid key."""
    token = authorization.removeprefix("Bearer ").strip()
    if not token.startswith("ctc_"):
        return None
    h = hashlib.sha256(token.encode()).hexdigest()
    if user := await st.cache.get_json(f"key:{h}"):
        return user
    user = await st.store.fetchval("select user_id from api_keys where key_hash = %s and revoked_at is null", (h,))
    if user:
        await st.cache.set_json(f"key:{h}", user, st.cfg["cache"]["ttl"]["key"])
    return user


if cfg()["mode"] == "shared":

    @app.middleware("http")
    async def _auth(request: Request, call_next):
        path = request.url.path
        if not path.startswith(("/api", "/v1", "/mcp")):  # dashboard static files
            return await call_next(request)
        hook, st = path.startswith("/v1/hook/"), request.app.state.st
        try:
            user = await _key_user(st, request.headers.get("authorization", ""))
            over = user is not None and await st.cache.hit_rate(user) > st.cfg["rate_limit_per_min"]
        except Exception:
            if hook:  # hooks never error
                return Response()
            raise
        if user is None or over:
            if hook:  # an empty 200: Claude Code shows nothing, the prompt goes on
                return Response()
            return _err(429, "rate_limited", "too many requests") if over else _err(401, "unauthorized", "missing or revoked API key")
        request.state.user_id = user
        return await call_next(request)


app.include_router(hooks.router)
app.include_router(api.router)
app.include_router(library.router)
app.mount("/mcp", mcp_app())


def _mcp_slash(app):
    """`claude mcp add` registers …/mcp; the mount only matches /mcp/…, and the dashboard's / mount would take /mcp."""
    async def asgi(scope, receive, send):
        if scope["type"] == "http" and scope["path"] == "/mcp":
            scope = {**scope, "path": "/mcp/", "raw_path": b"/mcp/"}
        await app(scope, receive, send)
    return asgi


app.add_middleware(_mcp_slash)
if cfg()["mode"] == "local":  # DNS rebinding: a web page can't reach the open 127.0.0.1 port under its own hostname
    # ponytail: local-mode /api writes are still open to every local user on the TCP port; token or socket-only if that matters
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "ctc"])  # hooks/CLI send Host: ctc
DIST = Path(os.environ.get("CTC_DASHBOARD_DIST") or ROOT / "dashboard" / "dist")
if DIST.is_dir():  # after every route: /api, /v1 and /mcp win
    app.mount("/", StaticFiles(directory=DIST, html=True), name="dashboard")


def _uds(path: Path) -> socket.socket:
    """Unix socket for the hooks: parent dir 0700, socket 0600; a stale file is removed, a live daemon is not."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.parent.chmod(0o700)
    if path.exists():
        with socket.socket(socket.AF_UNIX) as probe:
            if probe.connect_ex(str(path)) == 0:
                raise SystemExit(f"a ctc daemon already listens on {path}")
        path.unlink()
    s = socket.socket(socket.AF_UNIX)
    s.bind(str(path))
    path.chmod(0o600)
    return s


def main() -> None:
    """One uvicorn server, one lifespan, two listeners (socket + 127.0.0.1:port); SIGTERM/SIGINT stop both."""
    c = cfg()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # one INFO line per TEI call otherwise
    socks = [socket.create_server(("127.0.0.1", c["port"]))]
    if c["mode"] == "local":
        socks.append(_uds(Path(c["socket"])))
    log.info("ctc daemon (%s mode) on 127.0.0.1:%d%s, pid %d", c["mode"], c["port"],
             f" and {c['socket']}" if c["mode"] == "local" else "", os.getpid())
    # uvicorn re-raises SIGTERM after a clean shutdown, so no cleanup runs here; _uds() removes the stale socket next start
    uvicorn.Server(uvicorn.Config(app, access_log=False, log_level="info")).run(sockets=socks)


if __name__ == "__main__":
    main()
