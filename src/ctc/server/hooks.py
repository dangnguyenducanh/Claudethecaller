"""Machine-facing /v1 routes: Claude Code hooks, route, bundle, search, health (PLAN.md B5, Cache design, AI integration flow).

Hooks never error: any failure is an empty 200 (prompt) or a 204 (tool, stop). `route()` is the shared core of
/v1/hook/prompt, /v1/route and the MCP tool: bundle:{ref} → embed (emb: cache) → blend (session, project, memories)
→ semantic cache → search + decide → bundle:{ref}, sem:{ref}, sess:{id}:last. It writes caches only; the hook writes rows.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import time
from pathlib import Path

import httpx
import numpy as np
import orjson
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from pydantic import BaseModel

from ctc.config import cfg
from ctc.decision.bundle import Bundle, decide, followed, stage_rows, suggestion_line
from ctc.graph import core, push
from ctc.graph.extract import SOURCE, prose
from ctc.ingestion.scanner import project_id
from ctc.memory.longterm import recall
from ctc.memory.session import blend, project_vector, session_vector
from ctc.retrieval.hybrid import result_json, search
from ctc.runner.engine import in_runs
from ctc.server.jobs import submit
from ctc.server.schemas import Health
from ctc.server.state import State
from ctc.server.writer import write

log = logging.getLogger(__name__)
router = APIRouter()
PROMPT_BUDGET_S = 0.14  # PLAN Constraints: the hook adds <= 150 ms; curl -m 0.15 leaves 10 ms for the socket + curl
MAX_Q = 2000  # ponytail: routing reads the first 2000 chars of a prompt (pasted logs); ref still hashes all of it
_bg: set[asyncio.Task] = set()  # prompt work that outlived its budget, finishing its cache + row writes


def _st(request: Request) -> State:
    return request.app.state.ctc


def _user(request: Request) -> str:
    return getattr(request.state, "user_id", "local")


def _scoped(st: State, user_id: str, key: str) -> str:
    """Shared mode puts user_id in bundle:/sess: keys (Cache design); local mode keeps the plain names."""
    return f"{user_id}:{key}" if st.cfg["mode"] == "shared" else key


async def _embed(st: State, texts: list[str]) -> list[np.ndarray]:
    """Query embeddings through emb:{model8}:{sha256(text)[:16]}; one TEI call for the misses."""
    m8 = hashlib.sha256((st.embedder.model_version or st.cfg["embed_model"]).encode()).hexdigest()[:8]
    ins = st.cfg["embed"]["instruction"]  # the query prefix changes the vector; `coding` keeps the old key shape
    keys = [f"emb:{m8}{'' if ins == 'coding' else ':' + ins}:{hashlib.sha256(t.encode()).hexdigest()[:16]}" for t in texts]
    vecs = list(await asyncio.gather(*(st.cache.get_vec(k) for k in keys)))
    if miss := [i for i, v in enumerate(vecs) if v is None]:
        for i, v in zip(miss, await st.embedder.embed([texts[i] for i in miss], "query")):
            vecs[i] = v
        await asyncio.gather(*(st.cache.set_vec(keys[i], vecs[i], st.cfg["cache"]["ttl"]["emb"]) for i in miss))
    return vecs


async def _recall(st: State, qv, pid: str, user_id: str) -> list[dict]:
    try:
        return await recall(qv, st.store, pid, user_id=user_id)
    except Exception:  # fail-open: the blend drops the memory part
        log.exception("recall failed")
        return []


def router_version(st: State) -> str:
    """Semantic-cache key part: library + gate file + search knobs, so retuning never serves stale bundles (hex: a TAG)."""
    try:
        gate = os.stat(st.cfg["gate_path"]).st_mtime_ns
    except OSError:
        gate = 0
    knobs = [st.cfg.get(k) for k in ("k", "depth", "rerank_top", "rrf_k", "abstain_below", "agent_min_rerank", "ranking",
                                     "memory_in_query", "memory_weight", "blend", "embed", "gate")]
    return hashlib.md5(f"{st.store.library_version}|{gate}|{knobs}".encode()).hexdigest()


async def cached_bundle(st: State, ref: str, user_id: str = "local") -> Bundle | None:
    got = await st.cache.get_json(f"bundle:{_scoped(st, user_id, ref)}")
    return Bundle(**got) if got else None


async def route(st: State, prompt: str, session_id: str, cwd: str, user_id: str = "local", k: int | None = None) -> Bundle:
    """session_id "" = no session (no turn vector, no sess:last); cwd "" = no project part."""
    c, cache = st.cfg, st.cache
    ref = hashlib.sha256((session_id + prompt).encode()).hexdigest()[:8]
    if b := await cached_bundle(st, ref, user_id):
        return b
    q, pid, sk = prompt[:MAX_Q], project_id(cwd), _scoped(st, user_id, session_id)
    (qv,) = await _embed(st, [q])
    sv, pv = await asyncio.gather(
        session_vector(sk, qv, cache) if session_id else asyncio.sleep(0),
        project_vector(cwd, st.store, cache, st.embedder, user_id) if cwd else asyncio.sleep(0))
    qs = blend(qv, sv, pv)  # semantic-cache key: no memory part, so a hit costs no recall() round trip
    libv = router_version(st)
    if hit := await cache.semantic_get(qs, libv, pid, user_id):
        b = Bundle(**{**hit, "ref": ref, "intent": q})
    else:
        ctx = st.ctx(cwd, user_id)
        kw = {"k": k or c["k"], "depth": c["depth"], "rerank_top": c["rerank_top"], "abstain_below": c["abstain_below"]}
        if c.get("memory_in_query", True):
            texts = [m["text"] for m in await _recall(st, qv, pid, user_id)]
            mv = np.mean([v / max(np.linalg.norm(v), 1e-9) for v in await _embed(st, texts)], axis=0) if texts else None
            res = await search(q, ctx, qv=blend(qv, sv, pv, mv), **kw)
        else:  # memories only ride along in the bundle: recall in parallel with the search (one Supabase hop saved)
            mems, res = await asyncio.gather(_recall(st, qv, pid, user_id), search(q, ctx, qv=blend(qv, sv, pv), **kw))
            texts = [m["text"] for m in mems]
        b = await decide(q, res, ctx, qv=qv, memories=texts)
        b.ref = ref
        await cache.semantic_put(ref, qs, libv, pid, b.model_dump(), user_id)
    await cache.set_json(f"bundle:{_scoped(st, user_id, ref)}", b.model_dump(), c["cache"]["ttl"]["bundle"])
    if session_id:
        await cache.set_json(f"sess:{sk}:last", {"ref": ref, "steps": [s.model_dump() for s in b.steps]}, c["cache"]["ttl"]["sess"])
    return b


def _in_run(body: dict) -> bool:
    """A workflow run's own claude (engine.in_runs: any home's runs dir) or the graph extractor's (cwd under
    graph_extract.dir): no suggestion, rows, or extract / graph jobs (PLAN.md m5, m6 FR-011)."""
    cwd = str(body.get("cwd") or "")
    return in_runs(cwd) or f"{cwd}/".startswith(f"{Path(cfg()['graph_extract']['dir']).expanduser()}/")


async def _body(request: Request) -> dict:
    try:
        body = orjson.loads(await request.body())
        return body if isinstance(body, dict) else {}
    except ValueError:  # not JSON
        return {}


async def _prompt(st: State, body: dict, user_id: str) -> str:
    """Route one UserPromptSubmit and write its session + decision rows; never raises."""
    try:
        prompt, sid, cwd = (str(body.get(f) or "") for f in ("prompt", "session_id", "cwd"))
        if not (prompt.strip() and sid and cwd) or _in_run(body):
            return ""
        pid = project_id(cwd)
        if (user_id, pid) not in st.names:  # first sight in this worker: the row (FK of sessions), then its .claude/ caps
            st.names[(user_id, pid)] = await st.store.ensure_project(cwd, user_id)
            await submit(st, "index", {"cwd": cwd}, user_id)
        await write(st, "session", {"id": sid, "user_id": user_id, "project_id": pid, "title": prompt[:200], "turns": 1})
        t = time.perf_counter()
        b = await route(st, prompt, sid, cwd, user_id)
        ms, line = round((time.perf_counter() - t) * 1000, 1), None
        try:  # m6 FR-022: the graph line; the prompt's vector is an emb: cache hit from route() (same first MAX_Q chars)
            if g := await core.graph_for(st, cwd, user_id):
                line = push.prompt_line(g, (await _embed(st, [prompt[:MAX_Q]]))[0], st.cfg) or None
        except Exception:
            log.exception("hook/prompt: graph line failed; suggestion only")
        await write(st, "decision", {
            "user_id": user_id, "session_id": sid, "project_id": pid, "ref": b.ref, "prompt": prompt[:MAX_Q],
            "abstained": b.abstained, "confidence": b.confidence, "difficulty": b.difficulty, "model_tier": b.model_tier,
            "latency_ms": ms, "bundle": b.model_dump(), "stages": [s.model_dump() for s in b.stages], "graph_line": line})
        return "\n".join(s for s in (suggestion_line(b), line) if s)
    except Exception:
        log.exception("hook/prompt failed; empty suggestion")
        return ""


@router.post("/v1/hook/prompt", response_class=PlainTextResponse)
async def hook_prompt(request: Request) -> PlainTextResponse:
    line = ""
    try:
        task = asyncio.ensure_future(_prompt(_st(request), await _body(request), _user(request)))
        _bg.add(task)
        task.add_done_callback(_bg.discard)
        line = await asyncio.wait_for(asyncio.shield(task), PROMPT_BUDGET_S)
    except TimeoutError:
        log.info("hook/prompt over its %.0f ms budget: empty now, caches + rows when it finishes", PROMPT_BUDGET_S * 1000)
    except Exception:
        log.exception("hook/prompt failed; empty suggestion")
    return PlainTextResponse(line)


PRE_BUDGET_S = 0.04  # curl -m 0.05 (contracts/hooks.md); RAM only, no DB, no embedder


async def _note(st: State, body: dict, user_id: str) -> str:
    tin, cwd = body.get("tool_input"), str(body.get("cwd") or "")
    path = str((tin if isinstance(tin, dict) else {}).get("file_path") or "")
    if not (path and cwd) or _in_run(body) or not (g := await core.graph_for(st, cwd, user_id)):
        return ""
    return push.file_note(g, Path(path).relative_to(cwd).as_posix() if Path(path).is_relative_to(cwd) else path, st.cfg)


@router.post("/v1/hook/pre")
async def hook_pre(request: Request) -> Response:
    """PreToolUse on Read|Edit|Write|MultiEdit (m6 FR-024): the file's tasks/requirements/decision as additional context.
    Never a permissionDecision; nothing to say or any error = empty 200."""
    try:
        if note := await asyncio.wait_for(_note(_st(request), await _body(request), _user(request)), PRE_BUDGET_S):
            return JSONResponse({"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": note}})
    except TimeoutError:
        log.info("hook/pre over its %.0f ms budget: no note", PRE_BUDGET_S * 1000)
    except Exception:
        log.exception("hook/pre failed; no note")
    return Response(status_code=200)


EDIT_TOOLS = ("Write", "Edit", "MultiEdit")
TICK = re.compile(r"^\s*- \[([ xX])\] (T\d{3})\b", re.MULTILINE)
# one queued job per kind and file is enough: it parses / extracts the file as it is when it runs
QUEUED_SQL = ("select 1 from jobs where user_id = %s and kind = %s and status = 'queued' and payload->>'cwd' = %s"
              " and payload->'files' ? %s limit 1")


def _ticks(tool: str, tin: dict) -> list[str]:
    """T### boxes an edit ticks: `- [x]` in a new_string where its old_string had `- [ ]` (a Write compares against nothing)."""
    edits = tin.get("edits") if tool == "MultiEdit" else [tin] if tool == "Edit" else []
    out: list[str] = []
    for e in edits if isinstance(edits, list) else []:
        e = e if isinstance(e, dict) else {}
        was = {t for box, t in TICK.findall(str(e.get("old_string") or "")) if box == " "}
        out += [t for box, t in TICK.findall(str(e.get("new_string") or "")) if box != " " and t in was and t not in out]
    return out


async def _graph_jobs(st: State, user_id: str, cwd: str, rel: str, tick: dict | None) -> None:
    """After the 204 (m6 FR-012, FR-020): a saved context source queues graph_build + graph_extract for that file, unless
    one is already queued; ticked tasks.md boxes queue a graph_build that confirms the session's edited files. Only in a
    project that has a graph: the hook runs in every repo, and `ctc graph build` there is the opt-in (spec: this repo only)."""
    try:
        if not await st.store.fetchval(core.VERSION_SQL, (user_id, project_id(cwd))):
            return
        if SOURCE.fullmatch(rel):
            # extract first: the worker runs jobs in order, so the build embeds and links the extractor's new nodes
            for kind in ("graph_extract", "graph_build") if prose(rel) else ("graph_build",):
                if await st.store.fetchval(QUEUED_SQL, (user_id, kind, cwd, rel)) is None:
                    await submit(st, kind, {"cwd": cwd, "files": [rel]}, user_id)
        if tick:
            await submit(st, "graph_build", {"cwd": cwd, "tick": tick}, user_id)
    except Exception:
        log.exception("hook/tool: graph jobs failed")


@router.post("/v1/hook/tool", status_code=204)
async def hook_tool(request: Request, tasks: BackgroundTasks) -> Response:
    try:
        st, user_id, body = _st(request), _user(request), await _body(request)
        sid, tool, tin = str(body.get("session_id") or ""), str(body.get("tool_name") or ""), body.get("tool_input")
        tin, cwd = tin if isinstance(tin, dict) else {}, str(body.get("cwd") or "")
        if sid and tool and not _in_run(body):
            name = tin.get("skill") or tin.get("subagent_type")
            rel, inside = str(tin.get("file_path") or "") if tool in EDIT_TOOLS else "", False
            if rel and cwd:  # resolved, not lexical: `specs/../../x.md` or a symlink out of the repo is not inside it
                p, root = (Path(cwd) / rel).resolve(), Path(cwd).resolve()
                if inside := p.is_relative_to(root):
                    rel = p.relative_to(root).as_posix()
            await write(st, "event", {"session_id": sid, "type": "tool", "payload": {
                "tool": tool, **({"name": name} if name else {}), **({"file_path": rel} if rel else {})}})
            # shared mode: cwd names a path on the client's disk, which the jobs cannot read
            if inside and st.cfg["mode"] == "local":
                ticks = _ticks(tool, tin) if rel.endswith("tasks.md") else []
                if SOURCE.fullmatch(rel) or ticks:
                    tasks.add_task(_graph_jobs, st, user_id, cwd, rel,
                                   {"session_id": sid, "file": rel, "tasks": ticks} if ticks else None)
            last = await st.cache.get_json(f"sess:{_scoped(st, user_id, sid)}:last")
            if last and followed(last, tool, tin):
                await write(st, "followed", {"session_id": sid, "ref": last["ref"]})
    except Exception:
        log.exception("hook/tool failed")
    return Response(status_code=204)


def _usage(path: Path) -> tuple[str, int]:
    """(model of the last assistant message, summed *_tokens of its usage per message id) from a .jsonl transcript.
    One API response spans several rows (one per content block) with the same id and usage, hence the dedupe."""
    model, per_msg = "", {}
    with path.open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if '"usage"' not in line:
                continue
            try:
                m = orjson.loads(line).get("message")
            except (ValueError, AttributeError):
                continue
            if isinstance(m, dict) and isinstance(m.get("usage"), dict):
                if m.get("model") and m["model"] != "<synthetic>":
                    model = m["model"]
                per_msg[m.get("id") or len(per_msg)] = sum(
                    v for k, v in m["usage"].items() if k.endswith("_tokens") and isinstance(v, int))
    return model, sum(per_msg.values())


EXTRACT_EVERY_S = 1800
INFLIGHT_SQL = ("select 1 from jobs where user_id = %s and kind = %s and status in ('queued', 'running')"
                " and payload->>'session_id' = %s limit 1")


async def _want_extract(st: State, sid: str, end: bool, user_id: str) -> bool:
    """Stop fires after every turn: extract at most once per EXTRACT_EVERY_S per session (Redis SET NX; Redis down =
    skip, fail-open). SessionEnd always distills (B9: title, summary, intents in place of raw prompts, then A3 extraction).
    Both skip while a job of their kind for the session is queued or running.
    ponytail: a session killed without SessionEnd loses its last < 30 min to extraction until `backfill` re-reads it."""
    if not end and not await st.cache._safe(st.cache.r.set(f"ctc:extract:{sid}", 1, nx=True, ex=EXTRACT_EVERY_S)):
        return False
    return await st.store.fetchval(INFLIGHT_SQL, (user_id, "distill" if end else "extract", sid)) is None


async def _stop(st: State, body: dict, user_id: str) -> None:
    """Stop and SessionEnd (same endpoint; Claude Code names the event in hook_event_name)."""
    try:
        sid, cwd, tp = (str(body.get(f) or "") for f in ("session_id", "cwd", "transcript_path"))
        if not sid or _in_run(body):
            return
        end = body.get("hook_event_name") == "SessionEnd"
        await write(st, "event", {"session_id": sid, "type": "session_end" if end else "stop", "payload": {}})
        model, tokens, path = "", 0, None
        if st.cfg["mode"] == "local" and tp:  # shared mode: the transcript is on the client's disk
            p = Path(tp).expanduser().resolve()
            # the TCP port is open to every local user: read only Claude Code transcripts (same rule as ai/extract.py)
            if p.suffix == ".jsonl" and p.is_relative_to(Path(st.cfg["claude_home"]).resolve() / "projects") and p.is_file():
                path = p
                model, tokens = await asyncio.to_thread(_usage, p)
        await write(st, "session_end", {"id": sid, "model": model, "tokens": tokens})
        if path and await _want_extract(st, sid, end, user_id):
            await submit(st, "distill" if end else "extract", {"session_id": sid, "transcript_path": str(path),
                                         "project_id": project_id(cwd) if cwd else None, "user_id": user_id}, user_id)
    except Exception:
        log.exception("hook/stop failed")


@router.post("/v1/hook/stop", status_code=204)
async def hook_stop(request: Request, tasks: BackgroundTasks) -> Response:
    try:
        tasks.add_task(_stop, _st(request), await _body(request), _user(request))  # after the 204 is sent
    except Exception:
        log.exception("hook/stop failed")
    return Response(status_code=204)


class RouteIn(BaseModel):
    prompt: str
    session_id: str = ""
    cwd: str = ""
    k: int | None = None


class SearchIn(BaseModel):
    q: str
    cwd: str = ""
    k: int | None = None
    explain: bool = False


@router.post("/v1/route", response_model=Bundle)
async def route_ep(body: RouteIn, request: Request) -> Bundle:
    return await route(_st(request), body.prompt, body.session_id, body.cwd, _user(request), body.k)


@router.get("/v1/bundle/{ref}", response_model=Bundle)
async def bundle_ep(ref: str, request: Request) -> Bundle:
    if b := await cached_bundle(_st(request), ref, _user(request)):
        return b
    raise HTTPException(404, {"code": "not_found", "message": f"no bundle {ref} (expired or never routed)"})


@router.post("/v1/search")
async def search_ep(body: SearchIn, request: Request) -> dict:
    st, c = _st(request), _st(request).cfg
    q = body.q[:MAX_Q]
    ctx = st.ctx(body.cwd, _user(request))
    (qv,) = await _embed(st, [q])
    res = await search(q, ctx, qv=qv, k=body.k or c["k"], depth=c["depth"], rerank_top=c["rerank_top"], abstain_below=c["abstain_below"])
    out = result_json(q, ctx, res)
    if body.explain:
        out["stages"] = [r.model_dump() for r in stage_rows(res)]  # per candidate: ranks, rrf, rerank, dropped reason
    else:
        for h in out["hits"]:
            h.pop("stages", None)
    return out


async def _probe(aw) -> str:
    try:
        r = await asyncio.wait_for(aw, 1.0)
        if isinstance(r, httpx.Response):
            r.raise_for_status()
        return "ok"
    except Exception:  # noqa: BLE001 - any failure is the answer "down"
        return "down"


@router.get("/v1/health", response_model=Health)
async def health(request: Request) -> dict:
    st = _st(request)
    provider, rest = st.llm.spec.split(":", 1)
    async with httpx.AsyncClient(timeout=1.0) as h:
        llm = h.get(rest.rsplit(":", 1)[0].removesuffix("/v1") + "/health") if provider == "openai" else None  # llama-server
        db, redis, emb, rer, llm = await asyncio.gather(
            _probe(st.store.fetchval("select 1")), _probe(st.cache.r.ping()),
            _probe(h.get(f"{st.cfg['embed_url']}/health")), _probe(h.get(f"{st.cfg['rerank_url']}/health")),
            _probe(llm) if llm else asyncio.sleep(0, "ok" if os.environ.get("ANTHROPIC_API_KEY") else "down"))
    return {"db": db, "redis": redis, "embedder": emb, "reranker": rer, "llm": llm,
            "library_version": st.store.library_version, "mode": st.cfg["mode"]}
