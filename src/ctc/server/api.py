"""/api dashboard routes: projects, overview (kpis, timeline, activity), decisions, sessions, index + jobs, history, keys
(PLAN.md "API design", "History import design").

Every query filters `user_id` (request.state.user_id, "local" in local mode); `?project=<name>` resolves to the project id
(unknown -> 404). Days are UTC dates. ponytail: a per-user time zone when the dashboard sends one.
"""

from __future__ import annotations

import hashlib
import itertools
import secrets

import psycopg
from fastapi import APIRouter, HTTPException, Query, Request

from ctc.ingestion import history as hist
from ctc.memory.observations import _FROM, _OSEL, _SSEL, ctx_key
from ctc.server import jobs
from ctc.server.schemas import (
    KPI_KEYS,
    Activity,
    ApiKey,
    Decision,
    HistoryFile,
    HistoryImport,
    HistoryStatus,
    IndexRequest,
    Job,
    JobRef,
    Kpis,
    Metric,
    NewApiKey,
    Ok,
    Project,
    ProjectDetail,
    ProjectRename,
    Range,
    Session,
    SessionDetail,
    Source,
    Timeline,
    to_decision,
    to_memory,
)

router = APIRouter(prefix="/api")
DAYS = {"7d": 7, "30d": 30, "90d": 90, "all": None}
TODAY = "(now() at time zone 'utc')::date"
PF = "(%(p)s::text is null or project_id = %(p)s)"  # optional project filter

# Shared CTEs, params u, p, n (window days, null = since the first decision), back (extra days before the window, kpis'
# previous window). days = one row per day of the window; d = the user's decisions from (start - back) on.
WINDOW = f"""t as (select {TODAY} as today),
w as (select coalesce(today - %(n)s::int + 1,
  (select min((at at time zone 'utc')::date) from decisions where user_id = %(u)s and {PF}), today) as start, today from t),
days as (select start + i as day from w, generate_series(0, today - start) i),
d as (select project_id, (at at time zone 'utc')::date as day, abstained, followed, latency_ms from decisions
  where user_id = %(u)s and {PF}
    and at >= ((select start from w) - coalesce(%(back)s::int, 0))::timestamp at time zone 'utc')"""
AGG = """count(d.day) as calls, count(*) filter (where not d.abstained) as sug,
  count(*) filter (where d.followed and not d.abstained) as fol, percentile_cont(0.95) within group (order by d.latency_ms) as p95"""

DEC_COLS = """d.id, d.at, d.session_id, coalesce(p.name, d.project_id) as project, d.prompt, d.abstained, d.followed, d.latency_ms,
  d.difficulty, d.model_tier, d.confidence, d.bundle, d.stages, d.source"""
DEC_FROM = "decisions d left join projects p on p.user_id = d.user_id and p.id = d.project_id"
MEM_COLS = """m.id::text as id, m.scope, pm.name as project, m.kind, m.text, m.confidence, m.pinned, m.use_count, m.updated_at,
  m.source, m.supersedes::text as supersedes, sm.text as supersedes_text, m.deleted_at"""
MEM_FROM = """memories m left join projects pm on pm.user_id = m.user_id and pm.id = m.project_id
  left join memories sm on sm.id = m.supersedes"""
SESSION_COLS = """s.id, coalesce(p.name, s.project_id) as project, s.title, s.model, s.started_at, s.turns, s.tokens, s.source,
  s.summary, s.status, s.git_branch"""
SESSION_FROM = "sessions s left join projects p on p.user_id = s.user_id and p.id = s.project_id"


def fail(status: int, code: str, message: str):
    raise HTTPException(status, {"code": code, "message": message})


def ctx(request: Request) -> tuple:
    return request.app.state.st, getattr(request.state, "user_id", "local")


def like(q: str | None) -> str | None:
    return "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%" if q else None


async def project_id(st, user: str, name: str | None) -> str | None:
    if name is None:
        return None
    pid = await st.store.fetchval("select id from projects where user_id = %s and name = %s", (user, name))
    return pid if pid is not None else fail(404, "not_found", f"no project {name}")


def stats(r: dict | None) -> dict:
    sug, fol = (r["sug"], r["fol"]) if r else (0, 0)
    return {"routing_calls": r["calls"] if r else 0, "adoption_rate": fol / sug if sug else 0.0, "lazy_misses": sug - fol,
            "p95_ms": (r["p95"] if r else None) or 0.0}


# ---- projects ----

@router.get("/projects", response_model=list[Project])
async def projects(request: Request):
    st, u = ctx(request)
    # creation order, not recency: the dashboard colours projects by their index in this list
    return await st.store.fetch(
        "select p.id, p.name, (select count(*) from sessions s where s.user_id = p.user_id and s.project_id = p.id) as sessions"
        " from projects p where p.user_id = %s order by p.created_at, p.name", (u,))


@router.get("/projects/{name}", response_model=ProjectDetail)
async def project(name: str, request: Request):
    st, u = ctx(request)
    r = await st.store.fetchrow(
        """select p.id, p.name, p.path, p.last_active,
             (select count(*) from sessions s where s.user_id = p.user_id and s.project_id = p.id) as sessions,
             (select count(*) from decisions d where d.user_id = p.user_id and d.project_id = p.id) as decisions,
             (select count(*) from memories m where m.user_id = p.user_id and m.project_id = p.id and m.deleted_at is null) as memories,
             (select count(*) from overrides o where o.user_id = p.user_id and o.project = p.id) as overrides
           from projects p where p.user_id = %s and p.name = %s""", (u, name))
    return r or fail(404, "not_found", f"no project {name}")


@router.patch("/projects/{name}", response_model=Project)
async def rename_project(name: str, body: ProjectRename, request: Request):
    st, u = ctx(request)
    to = body.name.strip() or fail(422, "invalid", "name is required")
    try:
        r = await st.store.fetchrow(
            """update projects p set name = %s where user_id = %s and name = %s returning id, name,
                 (select count(*) from sessions s where s.user_id = p.user_id and s.project_id = p.id) as sessions""", (to, u, name))
    except psycopg.errors.UniqueViolation:
        fail(409, "conflict", f"project {to} already exists")
    if not r:
        fail(404, "not_found", f"no project {name}")
    st.names[(u, r["id"])] = to  # ponytail: other workers keep the old name until restart; names only gate ensure_project
    return r


@router.delete("/projects/{name}", response_model=Ok)
async def delete_project(name: str, request: Request):
    st, u = ctx(request)
    # sessions (-> decisions, events) and project memories go by FK cascade; overrides have no FK (project may be '*')
    pid = await st.store.fetchval(
        """with pr as (delete from projects where user_id = %(u)s and name = %(n)s returning id),
             o as (delete from overrides where user_id = %(u)s and project in (select id from pr))
           select id from pr""", {"u": u, "n": name})
    if pid is None:
        fail(404, "not_found", f"no project {name}")
    st.names.pop((u, pid), None)
    await st.cache.delete(f"ovr:{u}:{pid}", ctx_key(u, pid))  # the observations went with the project (FK cascade)
    await st.cache.publish_inval("ovr", user=u, project=pid)
    return Ok()


# ---- overview ----

@router.get("/kpis", response_model=Kpis)
async def kpis(request: Request, range: Range = "30d", project: str | None = None):
    st, u = ctx(request)
    n = DAYS[range]
    r = await st.store.fetchrow(
        f"""with {WINDOW},
              s as (select days.day, {AGG} from days left join d using (day) group by days.day),
              tot as (select d.day >= w.start as cur, {AGG} from d, w group by 1)
            select (select json_agg(s order by day) from s) as spark, (select json_agg(tot) from tot) as tot""",
        {"u": u, "p": await project_id(st, u, project), "n": n, "back": n})
    tot = {x["cur"]: x for x in r["tot"] or []}
    cur, prev = stats(tot.get(True)), stats(tot.get(False))
    per = [stats(x) for x in r["spark"]]
    return {**cur, "delta": {k: None if n is None or not prev[k] else (cur[k] - prev[k]) / prev[k] for k in KPI_KEYS},
            "spark": {k: [x[k] for x in per] for k in KPI_KEYS}}


@router.get("/timeline", response_model=Timeline)
async def timeline(request: Request, range: Range = "30d", metric: Metric = "calls", project: str | None = None):
    st, u = ctx(request)
    rows = await st.store.fetch(
        f"""with {WINDOW},
              pr as (select id, name, created_at from projects where user_id = %(u)s and (%(p)s::text is null or id = %(p)s))
            select pr.name as project, days.day::text as day, {AGG}
            from days left join pr on true left join d on d.project_id = pr.id and d.day = days.day
            group by pr.name, pr.created_at, days.day order by pr.created_at, pr.name, days.day""",
        {"u": u, "p": await project_id(st, u, project), "n": DAYS[range], "back": 0})

    def value(r: dict) -> float:
        s = stats(r)
        return round(s["adoption_rate"] * 100, 1) if metric == "adoption" else s["p95_ms"] if metric == "latency" else s["routing_calls"]

    series = [{"project": k, "values": [value(r) for r in g]} for k, g in itertools.groupby(rows, lambda r: r["project"]) if k is not None]
    return {"days": list(dict.fromkeys(r["day"] for r in rows)), "series": series}


@router.get("/activity", response_model=Activity)
async def activity(request: Request, project: str | None = None):
    st, u = ctx(request)
    days = await st.store.fetch(
        f"with {WINDOW} select days.day::text as day, count(d.day)::int as count from days left join d using (day)"
        " group by days.day order by days.day",
        {"u": u, "p": await project_id(st, u, project), "n": 84, "back": 0})
    run = longest = 0
    for x in days:
        run = run + 1 if x["count"] else 0
        longest = max(longest, run)
    active = [x["count"] for x in days if x["count"]]
    return {"days": days, "active_days": len(active), "streak": run, "longest_streak": longest,
            "busiest": max(days, key=lambda x: x["count"]),  # first of the busiest days, like the mock
            "per_active_day": round(sum(active) / len(active), 1) if active else 0.0}


# ---- decisions ----

@router.get("/decisions", response_model=list[Decision])
async def decisions(request: Request, range: Range = "30d", project: str | None = None, q: str | None = None,
                    session_id: str | None = None, followed: bool | None = None, abstained: bool | None = None,
                    source: Source | None = None, limit: int = Query(200, ge=1), before: int | None = None):
    st, u = ctx(request)
    rows = await st.store.fetch(
        f"""select {DEC_COLS} from {DEC_FROM}
            where d.user_id = %(u)s and (%(p)s::text is null or d.project_id = %(p)s)
              and (%(n)s::int is null or d.at >= ({TODAY} - %(n)s::int + 1)::timestamp at time zone 'utc')
              and (%(sid)s::text is null or d.session_id = %(sid)s)
              and (%(f)s::bool is null or d.followed = %(f)s) and (%(a)s::bool is null or d.abstained = %(a)s)
              and (%(src)s::text is null or d.source = %(src)s)
              and (%(q)s::text is null or d.prompt ilike %(q)s
                   or exists (select 1 from jsonb_array_elements(d.bundle->'steps') x where x->>'cap_id' ilike %(q)s))
              and (%(before)s::bigint is null or d.id < %(before)s)
            order by d.id desc limit %(lim)s""",
        {"u": u, "p": await project_id(st, u, project), "n": DAYS[range], "sid": session_id, "f": followed, "a": abstained,
         "src": source, "q": like(q), "before": before, "lim": min(limit, 500)})
    return [to_decision(r) for r in rows]


@router.get("/decisions/{did}", response_model=Decision)
async def decision(did: int, request: Request):
    st, u = ctx(request)
    r = await st.store.fetchrow(f"select {DEC_COLS} from {DEC_FROM} where d.user_id = %s and d.id = %s", (u, did))
    return to_decision(r) if r else fail(404, "not_found", f"no decision {did}")


@router.delete("/decisions/{did}", response_model=Ok)
async def delete_decision(did: int, request: Request):
    st, u = ctx(request)
    if not await st.store.execute("delete from decisions where user_id = %s and id = %s", (u, did)):
        fail(404, "not_found", f"no decision {did}")
    return Ok()


# ---- sessions ----

@router.get("/sessions", response_model=list[Session])
async def sessions(request: Request, project: str | None = None, q: str | None = None, range: Range | None = None,
                   source: Source | None = None, limit: int = Query(200, ge=1), before: str | None = None):
    st, u = ctx(request)
    return await st.store.fetch(
        f"""select {SESSION_COLS},
              (select count(*) from decisions d where d.session_id = s.id) as decisions,
              (select count(*) from decisions d where d.session_id = s.id and d.followed) as followed,
              coalesce(mm.n, 0) as memories, coalesce(oc.n, 0) as observations
            from {SESSION_FROM}
            left join (select source->>'session_id' as sid, count(*) as n from memories
                       where user_id = %(u)s and source->>'kind' = 'session' and deleted_at is null group by 1) mm on mm.sid = s.id
            left join (select session_id, count(*) as n from observations
                       where user_id = %(u)s and deleted_at is null group by 1) oc on oc.session_id = s.id
            where s.user_id = %(u)s and (%(p)s::text is null or s.project_id = %(p)s)
              and (%(q)s::text is null or s.title ilike %(q)s or s.model ilike %(q)s)
              and (%(src)s::text is null or s.source = %(src)s)
              and (%(n)s::int is null or s.started_at >= ({TODAY} - %(n)s::int + 1)::timestamp at time zone 'utc')
              and (%(before)s::text is null
                   or (s.started_at, s.id) < (select started_at, id from sessions where user_id = %(u)s and id = %(before)s))
            order by s.started_at desc, s.id desc limit %(lim)s""",
        {"u": u, "p": await project_id(st, u, project), "q": like(q), "src": source, "n": DAYS[range] if range else None, "before": before,
         "lim": min(limit, 500)})


@router.get("/sessions/{sid}", response_model=SessionDetail)
async def session(sid: str, request: Request):
    st, u = ctx(request)
    r = await st.store.fetchrow(
        f"""select {SESSION_COLS},
              coalesce((select json_agg(x order by x.id desc) from (select {DEC_COLS} from {DEC_FROM}
                        where d.user_id = s.user_id and d.session_id = s.id) x), '[]') as decisions,
              coalesce((select json_agg(x order by x.updated_at desc) from (select {MEM_COLS} from {MEM_FROM}
                        where m.user_id = s.user_id and m.source @> jsonb_build_object('kind', 'session', 'session_id', s.id)) x),
                       '[]') as memories,
              coalesce((select json_agg(x order by x.created_at desc, x.id desc) from (select {_OSEL} from {_FROM['o']}
                        where o.user_id = s.user_id and o.session_id = s.id and o.deleted_at is null) x), '[]') as observations,
              coalesce((select json_agg(x order by x.created_at desc, x.id desc) from (select {_SSEL} from {_FROM['s']}
                        where s.user_id = %(u)s and s.session_id = %(sid)s and s.deleted_at is null) x), '[]') as summaries
            from {SESSION_FROM} where s.user_id = %(u)s and s.id = %(sid)s""", {"u": u, "sid": sid})
    if not r:
        fail(404, "not_found", f"no session {sid}")
    return {**r, "followed": sum(x["followed"] for x in r["decisions"]), "decisions": [to_decision(x) for x in r["decisions"]],
            "memories": [to_memory(x) for x in r["memories"]]}


@router.delete("/sessions/{sid}", response_model=Ok)
async def delete_session(sid: str, request: Request):
    st, u = ctx(request)  # decisions, events and observations cascade; memories stay (their source keeps the id as text)
    r = await st.store.fetchrow("delete from sessions where user_id = %s and id = %s returning project_id", (u, sid))
    if not r:
        fail(404, "not_found", f"no session {sid}")
    await st.cache.delete(ctx_key(u, r["project_id"]))
    return Ok()


# ---- index + jobs ----

@router.post("/index", response_model=JobRef)
async def index(request: Request, body: IndexRequest | None = None):
    st, u = ctx(request)
    payload = {}  # no project: user + plugin roots only
    if body and body.project:
        path = await st.store.fetchval("select path from projects where user_id = %s and name = %s", (u, body.project))
        payload = {"cwd": path or fail(404, "not_found", f"no project {body.project}")}
    return {"job_id": await jobs.submit(st, "index", payload, u)}


@router.get("/jobs", response_model=list[Job])
async def list_jobs(request: Request, status: str | None = None, kind: str | None = None, limit: int = Query(200, ge=1)):
    st, u = ctx(request)
    return await jobs.list_jobs(st, status, kind, min(limit, 500), u)


@router.get("/jobs/{job_id}", response_model=Job)
async def get_job(job_id: str, request: Request):
    st, u = ctx(request)
    return await jobs.get_job(st, job_id, u) or fail(404, "not_found", f"no job {job_id}")


# ---- Claude history import (local mode only: the transcripts are on the daemon host's disk) ----

def local(st) -> None:
    if st.cfg["mode"] != "local":
        fail(404, "not_found", "history import exists only in local mode")


@router.get("/history", response_model=HistoryStatus)
async def history_status(request: Request):
    st, u = ctx(request)
    local(st)
    return await hist.status(st.store, u, st.cfg["claude_home"])


@router.post("/history/import", response_model=JobRef)
async def history_import(request: Request, body: HistoryImport | None = None):
    st, u = ctx(request)
    local(st)
    body = body or HistoryImport()
    return {"job_id": await jobs.submit(st, "history", {"process": body.process, "projects": body.projects}, u)}


@router.get("/history/files", response_model=list[HistoryFile])
async def history_files(request: Request, status: str | None = None):
    st, u = ctx(request)
    local(st)
    # ponytail: no paging; one row per main transcript (tens to a few thousand)
    return await st.store.fetch(
        "select path, session_id, size, status, error, imported_at from history_files"
        " where user_id = %s and (%s::text is null or status = %s) order by imported_at desc, path", (u, status, status))


# ---- API keys (shared mode only) ----

def shared(st) -> None:
    if st.cfg["mode"] != "shared":
        fail(404, "not_found", "API keys exist only in shared mode")


@router.get("/keys", response_model=list[ApiKey], response_model_exclude_unset=True)
async def keys(request: Request):
    st, u = ctx(request)
    shared(st)
    return await st.store.fetch("select id, name, created_at, revoked_at from api_keys where user_id = %s order by id desc", (u,))


@router.post("/keys", response_model=ApiKey, status_code=201)
async def create_key(body: NewApiKey, request: Request):
    st, u = ctx(request)
    shared(st)
    name = body.name.strip() or fail(422, "invalid", "name is required")
    key = "ctc_" + secrets.token_urlsafe(32)  # shown once; only its sha256 is stored
    r = await st.store.fetchrow("insert into api_keys (key_hash, user_id, name) values (%s, %s, %s) returning id, name, created_at, revoked_at",
                                (hashlib.sha256(key.encode()).hexdigest(), u, name))
    return {**r, "key": key}


@router.delete("/keys/{kid}", response_model=Ok)
async def revoke_key(kid: int, request: Request):
    st, u = ctx(request)
    shared(st)
    h = await st.store.fetchval("update api_keys set revoked_at = coalesce(revoked_at, now()) where id = %s and user_id = %s returning key_hash",
                                (kid, u))
    if h is None:
        fail(404, "not_found", f"no key {kid}")
    await st.cache.delete(f"key:{h}")  # auth stops at once on this worker; others' L1 copies expire within seconds
    return Ok()
