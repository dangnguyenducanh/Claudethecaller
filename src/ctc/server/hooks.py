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
import time
from pathlib import Path

import httpx
import numpy as np
import orjson
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from fastapi.responses import PlainTextResponse, Response
from pydantic import BaseModel

from ctc.decision.bundle import Bundle, decide, followed, stage_rows, suggestion_line
from ctc.ingestion.scanner import project_id
from ctc.memory.longterm import recall
from ctc.memory.session import blend, project_vector, session_vector
from ctc.retrieval.hybrid import result_json, search
from ctc.server.jobs import submit
from ctc.server.schemas import Health
from ctc.server.state import State
from ctc.server.writer import write

log = logging.getLogger(__name__)
router = APIRouter()
PROMPT_BUDGET_S = 0.12
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
    keys = [f"emb:{m8}:{hashlib.sha256(t.encode()).hexdigest()[:16]}" for t in texts]
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
                                     "memory_in_query", "memory_weight", "blend")]
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
        texts = [m["text"] for m in await _recall(st, qv, pid, user_id)]
        mv = np.mean([v / max(np.linalg.norm(v), 1e-9) for v in await _embed(st, texts)], axis=0) \
            if texts and c.get("memory_in_query", True) else None
        ctx = st.ctx(cwd, user_id)
        res = await search(q, ctx, qv=blend(qv, sv, pv, mv), k=k or c["k"], depth=c["depth"], rerank_top=c["rerank_top"],
                           abstain_below=c["abstain_below"])
        b = await decide(q, res, ctx, qv=qv, memories=texts)
        b.ref = ref
        await cache.semantic_put(ref, qs, libv, pid, b.model_dump(), user_id)
    await cache.set_json(f"bundle:{_scoped(st, user_id, ref)}", b.model_dump(), c["cache"]["ttl"]["bundle"])
    if session_id:
        await cache.set_json(f"sess:{sk}:last", {"ref": ref, "steps": [s.model_dump() for s in b.steps]}, c["cache"]["ttl"]["sess"])
    return b


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
        if not (prompt.strip() and sid and cwd):
            return ""
        pid = project_id(cwd)
        if (user_id, pid) not in st.names:  # first sight in this worker: the row (FK of sessions), then its .claude/ caps
            st.names[(user_id, pid)] = await st.store.ensure_project(cwd, user_id)
            await submit(st, "index", {"cwd": cwd}, user_id)
        await write(st, "session", {"id": sid, "user_id": user_id, "project_id": pid, "title": prompt[:200], "turns": 1})
        t = time.perf_counter()
        b = await route(st, prompt, sid, cwd, user_id)
        await write(st, "decision", {
            "user_id": user_id, "session_id": sid, "project_id": pid, "ref": b.ref, "prompt": prompt[:MAX_Q],
            "abstained": b.abstained, "confidence": b.confidence, "difficulty": b.difficulty, "model_tier": b.model_tier,
            "latency_ms": round((time.perf_counter() - t) * 1000, 1), "bundle": b.model_dump(),
            "stages": [s.model_dump() for s in b.stages]})
        return suggestion_line(b)
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


@router.post("/v1/hook/tool", status_code=204)
async def hook_tool(request: Request) -> Response:
    try:
        st, user_id, body = _st(request), _user(request), await _body(request)
        sid, tool, tin = str(body.get("session_id") or ""), str(body.get("tool_name") or ""), body.get("tool_input")
        tin = tin if isinstance(tin, dict) else {}
        if sid and tool:
            name = tin.get("skill") or tin.get("subagent_type")
            await write(st, "event", {"session_id": sid, "type": "tool", "payload": {"tool": tool, **({"name": name} if name else {})}})
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
INFLIGHT_SQL = ("select 1 from jobs where user_id = %s and kind = 'extract' and status in ('queued', 'running')"
                " and payload->>'session_id' = %s limit 1")


async def _want_extract(st: State, sid: str, end: bool, user_id: str) -> bool:
    """Stop fires after every turn: extract at most once per EXTRACT_EVERY_S per session (Redis SET NX; Redis down =
    skip, fail-open). SessionEnd always extracts. Both skip while an extract job for the session is queued or running.
    ponytail: a session killed without SessionEnd loses its last < 30 min to extraction until `backfill` re-reads it."""
    if not end and not await st.cache._safe(st.cache.r.set(f"ctc:extract:{sid}", 1, nx=True, ex=EXTRACT_EVERY_S)):
        return False
    return await st.store.fetchval(INFLIGHT_SQL, (user_id, sid)) is None


async def _stop(st: State, body: dict, user_id: str) -> None:
    """Stop and SessionEnd (same endpoint; Claude Code names the event in hook_event_name)."""
    try:
        sid, cwd, tp = (str(body.get(f) or "") for f in ("session_id", "cwd", "transcript_path"))
        if not sid:
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
            await submit(st, "extract", {"session_id": sid, "transcript_path": str(path),
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
