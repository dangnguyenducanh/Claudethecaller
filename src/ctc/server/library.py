"""/api capabilities, overrides, dedup review and memories (PLAN.md "API design": Capabilities + Memories tables).

Capability writes touch files: user scope under cfg claude_home, project scope under <project path>/.claude; the final
path must resolve strictly inside that root. Then the one file is re-scanned, upserted and embedded.
Workflows are saved as plain YAML in ctc-workflows/<name>.yaml (PLAN.md m5 "Workflow file"): `graph` (validated, 422
invalid_graph) and `settings`, plus the `steps:` the router reads, derived from the graph. Legacy workflows/*.yaml|md
(frontmatter) stay readable and editable.
"""

from __future__ import annotations

import hashlib
import logging
import os
import shutil
import uuid
from datetime import UTC, datetime
from pathlib import Path

import httpx
import yaml
from fastapi import APIRouter, HTTPException, Request
from psycopg.types.json import Jsonb

from ctc.decision.bundle import _workflow_steps
from ctc.ingestion.indexer import build_index
from ctc.ingestion.scanner import (
    _make_capability,
    _split_frontmatter,
    project_namespace,
)
from ctc.memory.longterm import Memory as MemoryRow
from ctc.memory.longterm import _unit, write_memory
from ctc.runner import schedule
from ctc.runner.engine import SETTINGS, owner
from ctc.runner.graph import derived_steps, load, validate
from ctc.server import jobs
from ctc.server.api import (
    DEC_COLS,
    DEC_FROM,
    MEM_COLS,
    MEM_FROM,
    ctx,
    fail,
    like,
    project_id,
)
from ctc.server.schemas import (
    BackfillRequest,
    Capability,
    CapabilityDetail,
    CapabilityPatch,
    DedupPair,
    DedupResolve,
    Graph,
    ImportRequest,
    JobRef,
    Kind,
    Memory,
    MemoryDetail,
    MemoryKind,
    MemoryPatch,
    MemoryWrite,
    NewCapability,
    NewMemory,
    Ok,
    Override,
    OverrideSet,
    Scope,
    WorkflowSettings,
    to_decision,
    to_memory,
)

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api")

FILES = {"skill": "skills/{}/SKILL.md", "agent": "agents/{}.md", "command": "commands/{}.md", "workflow": "ctc-workflows/{}.yaml"}
# 30-day usage per cap: unnest each decision's steps once, then hash-join (a per-cap jsonb @> scan is caps x decisions)
CAP_SQL = """
with used as (
  select s->>'cap_id' as cap_id, count(distinct d.id) as calls, count(distinct d.id) filter (where d.followed) as fol
  from decisions d, jsonb_array_elements(d.bundle->'steps') s
  where d.user_id = %(u)s and d.at > now() - interval '30 days' group by 1
)
select c.id, c.kind, c.namespace, c.description, c.cluster_id, o.action as override,
  coalesce(used.calls, 0) as calls_30d, coalesce(used.fol, 0) as followed_30d{extra}
from capabilities c
left join used on used.cap_id = c.id
left join lateral (select action from overrides where user_id = %(u)s and cap_id = c.id and project in (%(p)s, '*')
                   order by project = '*' limit 1) o on true
where (%(id)s::text is null or c.id = %(id)s) and (%(kind)s::text is null or c.kind = %(kind)s)
  and (%(ns)s::text is null or c.namespace = %(ns)s) and (%(ovr)s::text is null or o.action = %(ovr)s)
  and (%(q)s::text is null or c.id ilike %(q)s or c.description ilike %(q)s or array_to_string(c.triggers, ' ') ilike %(q)s)
order by c.updated_at desc, c.id limit %(n)s
"""
DETAIL_COLS = ", c.name, c.invoke, c.path, c.body, c.summary, c.triggers, (select count(*) from cap_vectors v where v.cap_id = c.id) as vectors"


async def _caps(st, u: str, pid: str | None, cap_id: str | None = None, detail: bool = False, kind=None, ns=None, ovr=None,
                q=None, n: int = 1) -> list[dict]:
    return await st.store.fetch(CAP_SQL.format(extra=DETAIL_COLS if detail else ""),
                                {"u": u, "p": pid, "id": cap_id, "kind": kind, "ns": ns, "ovr": ovr, "q": like(q), "n": n})


async def _cap(st, u: str, cap_id: str, pid: str | None = None) -> dict:
    rows = await _caps(st, u, pid, cap_id)
    return rows[0] if rows else fail(404, "not_found", f"no capability {cap_id}")


def _known(st, cap_id: str) -> dict:
    return st.store.catalog.get(cap_id) or fail(404, "not_found", f"no capability {cap_id}")


def _inside(path: Path, root: Path) -> None:
    """Refuse a path whose resolved form (symlinks followed) is not strictly inside the resolved root, or that lands in
    the real ~/.claude before H3 (PLAN.md Constraints: the daemon writes a temp HOME until then)."""
    if root.resolve() not in path.resolve().parents:
        fail(403, "forbidden", f"{path} resolves outside {root}")
    if path.resolve().is_relative_to(Path("~/.claude").expanduser().resolve()) and os.environ.get("CTC_ALLOW_REAL_CLAUDE_HOME") != "1":
        fail(403, "forbidden", f"{path} is in the real ~/.claude: set CTC_CLAUDE_HOME to a temp dir (or CTC_ALLOW_REAL_CLAUDE_HOME=1 after H3)")


def _local_only(st, what: str = "capability files can only be edited") -> None:
    if st.cfg["mode"] != "local":  # shared mode: never write files (or run workflows) on the daemon host for a remote client
        fail(403, "forbidden", f"{what} in local mode")


def _cap_root(st, c: dict) -> Path:
    _local_only(st)
    if c["namespace"] == "user":
        return Path(st.cfg["claude_home"])
    if c["namespace"].startswith("project@"):  # the project dir is the ancestor whose hash is the namespace
        for parent in Path(c["path"]).parents:
            if project_namespace(parent) == c["namespace"]:
                return parent / ".claude"
        fail(403, "forbidden", f"{c['path']} is not inside its project")
    fail(403, "read_only", f"managed by plugin {c['namespace']}; use an override")


def _render(meta: dict, body: str) -> str:
    return "---\n" + yaml.safe_dump(meta, sort_keys=False, allow_unicode=True) + "---\n" + (f"\n{body}" if body else "")


def _yaml(meta: dict) -> str:  # a ctc-workflows file: no frontmatter, no body; leaf lists inline (pos: [0, 160])
    return yaml.safe_dump(meta, sort_keys=False, allow_unicode=True, default_flow_style=None)


def check_graph(g: dict) -> dict:
    """ctc.runner.graph.validate; its first error -> 422 invalid_graph {message, node_id}."""
    try:
        errs = validate(g)
    except (AttributeError, TypeError, KeyError) as e:  # not the shape the walker reads (a hand-edited file)
        errs = [{"message": f"malformed workflow: {e!r}", "node_id": None}]
    if errs:
        raise HTTPException(422, {"code": "invalid_graph", **errs[0]})
    return g


def _wf_meta(graph: Graph | None, settings: WorkflowSettings | None) -> dict:
    """The workflow file keys a save writes: settings; nodes + edges (validated) and the router's steps derived from them."""
    meta = {"settings": settings.model_dump()} if settings else {}
    if graph:
        g = check_graph(load(graph.model_dump(by_alias=True, exclude_none=True)))
        meta |= {"nodes": g["nodes"], "edges": g["edges"], "steps": derived_steps(g)}
    return meta


def _wf_doc(path: str) -> dict:
    try:
        return load(path)
    except (OSError, yaml.YAMLError, TypeError, ValueError):  # unreadable, or not a mapping: no graph to show
        return {"nodes": [], "edges": []}


async def _reindex(st, path: Path, kind: str, ns: str) -> None:
    cap = _make_capability(path, kind, ns, path.parent.name if kind == "skill" else path.stem)
    await st.store.upsert([cap], [])  # namespaces=[]: upsert deletes missing caps of the namespaces it is given
    try:
        await build_index(st.store, st.embedder)
    except httpx.HTTPError as e:  # file + row are written; the next index job embeds it
        log.warning("embedding %s failed: %s", cap.id, e)
    await st.cache.publish_inval("lib")


# ---- capabilities ----

@router.get("/capabilities", response_model=list[Capability])
async def capabilities(request: Request, project: str | None = None, q: str | None = None, kind: Kind | None = None,
                       namespace: str | None = None, override: Override | None = None, limit: int = 200):
    st, u = ctx(request)
    return await _caps(st, u, await project_id(st, u, project), kind=kind, ns=namespace, ovr=override, q=q, n=max(1, min(limit, 500)))


@router.get("/capabilities/{cap_id}", response_model=CapabilityDetail)
async def capability(cap_id: str, request: Request, project: str | None = None):
    st, u = ctx(request)
    rows = await _caps(st, u, await project_id(st, u, project), cap_id, detail=True)
    c = rows[0] if rows else fail(404, "not_found", f"no capability {cap_id}")
    decs = await st.store.fetch(f"select {DEC_COLS} from {DEC_FROM} where d.user_id = %s and d.bundle->'steps' @> %s"
                                " order by d.at desc limit 20", (u, Jsonb([{"cap_id": cap_id}])))
    cl, wf = c["cluster_id"], c["kind"] == "workflow"
    doc = _wf_doc(c["path"]) if wf else {}
    sched = None
    if wf and st.cfg["mode"] == "local" and (o := await owner()):  # this login's (PUT /api/workflows/{id}/schedule)
        sched = schedule.view(await st.store.fetchrow("select * from wf_schedules where owner = %s and workflow = %s", (o, cap_id)), o)
    return {**c, "editable": c["namespace"] == "user" or c["namespace"].startswith("project@"), "schedule": sched,
            "cluster_members": sorted(i for i, x in st.store.catalog.items() if cl and x["cluster_id"] == cl and i != cap_id),
            "recent_decisions": [to_decision(r) for r in decs],
            "steps": [s for s in _workflow_steps(c["path"]) if isinstance(s.get("cap"), str)] if wf else None,
            "graph": {k: doc[k] for k in ("nodes", "edges", "defaults") if k in doc} if wf and doc["nodes"] else None,
            "settings": SETTINGS | (doc.get("settings") or {}) if wf else None}


@router.post("/capabilities", response_model=Capability, status_code=201)
async def create_capability(b: NewCapability, request: Request):
    st, u = ctx(request)
    _local_only(st)
    if not b.description.strip():
        fail(422, "invalid", "description must not be blank")
    if b.scope == "user":
        ns, root = "user", Path(st.cfg["claude_home"])
    else:
        r = b.project and await st.store.fetchrow("select id, path from projects where user_id = %s and name = %s", (u, b.project))
        if not r:
            fail(422, "invalid", "project scope needs an existing project")
        ns, root = f"project@{r['id']}", Path(r["path"]) / ".claude"
    path = root / FILES[b.kind].format(b.name)
    _inside(path, root)
    if f"{ns}:{b.name}" in st.store.catalog:
        fail(409, "conflict", f"{ns}:{b.name} already exists")
    meta = {"name": b.name, "description": b.description}
    if b.kind == "workflow":
        meta |= _wf_meta(b.graph, b.settings)
        if not b.graph:
            meta["steps"] = [s.model_dump(exclude_none=True) for s in b.steps or []]
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("x", encoding="utf-8") as f:
            f.write(_yaml(meta) if b.kind == "workflow" else _render(meta, b.body or ""))
    except FileExistsError:
        fail(409, "conflict", f"{path} already exists")
    await _reindex(st, path, b.kind, ns)
    return await _cap(st, u, f"{ns}:{b.name}", await project_id(st, u, b.project))


@router.patch("/capabilities/{cap_id}", response_model=Capability)
async def update_capability(cap_id: str, b: CapabilityPatch, request: Request):
    st, u = ctx(request)
    c = _known(st, cap_id)
    if b.description is not None and not b.description.strip():
        fail(422, "invalid", "description must not be blank")
    path = Path(c["path"])
    _inside(path, _cap_root(st, c))
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        fail(404, "not_found", f"{path} is gone; reindex")
    plain = c["kind"] == "workflow" and not text.startswith("---")  # ctc-workflows/*.yaml: plain YAML
    try:
        meta, body = (yaml.safe_load(text), "") if plain else _split_frontmatter(text, lenient=True) or (None, "")
    except yaml.YAMLError:
        meta = None
    if not isinstance(meta, dict):  # never overwrite a file we could not read
        fail(422, "invalid", f"{path} has no YAML {'mapping' if plain else 'frontmatter'} to edit")
    if b.description is not None:
        meta["description"] = b.description
    if c["kind"] == "workflow":
        old = meta["settings"] if isinstance(meta.get("settings"), dict) else {}
        meta |= _wf_meta(b.graph, b.settings)
        if b.settings:  # the editor sends only WorkflowSettings' fields: keep YAML-only keys (settings.notify)
            meta["settings"] = old | b.settings.model_dump()
        if b.steps is not None and not b.graph:
            meta["steps"] = [s.model_dump(exclude_none=True) for s in b.steps]
    path.write_text(_yaml(meta) if plain else _render(meta, body if b.body is None else b.body), encoding="utf-8")
    await _reindex(st, path, c["kind"], c["namespace"])
    return await _cap(st, u, cap_id)


@router.delete("/capabilities/{cap_id}", response_model=Ok)
async def delete_capability(cap_id: str, request: Request):
    st, _ = ctx(request)
    c = _known(st, cap_id)
    target = Path(c["path"]).parent if c["kind"] == "skill" else Path(c["path"])  # a skill is its whole directory
    _inside(target, _cap_root(st, c))
    if target.exists():
        trash = Path(st.cfg["trash_dir"]) / datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
        trash.mkdir(parents=True)
        shutil.move(target, trash / target.name)
    await st.store.execute("delete from capabilities where id = %s", (cap_id,))  # vectors cascade
    await st.store.refresh_catalog()
    await st.cache.publish_inval("lib")
    return Ok()


@router.put("/capabilities/{cap_id}/override", response_model=Capability)
async def set_override(cap_id: str, b: OverrideSet, request: Request):
    st, u = ctx(request)
    _known(st, cap_id)
    pid = await project_id(st, u, b.project)
    await st.store.set_override(pid or "*", cap_id, b.action, u)
    ids = [pid] if pid else [r["id"] for r in await st.store.fetch("select id from projects where user_id = %s", (u,))]
    await st.cache.delete(*(f"ovr:{u}:{i}" for i in ids))
    await st.cache.publish_inval("ovr", user=u, project=pid or "*")
    return await _cap(st, u, cap_id, pid)


@router.post("/capabilities/{cap_id}/enrich", response_model=JobRef)
async def enrich(cap_id: str, request: Request):
    st, u = ctx(request)
    _known(st, cap_id)
    return {"job_id": await jobs.submit(st, "enrich", {"cap_ids": [cap_id]}, u)}


@router.get("/dedup", response_model=list[DedupPair])
async def dedup(request: Request, status: str = "open"):
    st, _ = ctx(request)
    return await st.store.fetch("select id, a, b, similarity, status from dedup_review where status = %s order by id desc", (status,))


@router.post("/dedup/{pair_id}", response_model=Ok)
async def resolve_dedup(pair_id: int, b: DedupResolve, request: Request):
    st, _ = ctx(request)
    status = "merged" if b.action == "merge" else "kept_apart"
    r = await st.store.fetchrow("update dedup_review set status = %s where id = %s returning a, b", (status, pair_id))
    if not r:
        fail(404, "not_found", f"no pair {pair_id}")
    if status == "merged":  # the next enrich dedup pass unions 'merged' pairs into the full cluster
        for i in (r["a"], r["b"]):
            await st.store.set_cluster(i, min(r["a"], r["b"]))
        await st.cache.publish_inval("lib")
    return Ok()


# ---- memories ----

async def _mem(st, u: str, mid: str) -> dict:
    try:
        uuid.UUID(mid)
    except ValueError:
        fail(404, "not_found", f"no memory {mid}")
    r = await st.store.fetchrow(f"select {MEM_COLS}, m.project_id from {MEM_FROM} where m.id = %s and m.user_id = %s", (mid, u))
    return r or fail(404, "not_found", f"no memory {mid}")


@router.get("/memories", response_model=list[Memory])
async def memories(request: Request, project: str | None = None, q: str | None = None, kind: MemoryKind | None = None,
                   scope: Scope | None = None, pinned: bool | None = None, include_deleted: bool = False, limit: int = 200):
    st, u = ctx(request)
    rows = await st.store.fetch(
        f"""select {MEM_COLS} from {MEM_FROM}
        where m.user_id = %(u)s and (%(p)s::text is null or m.scope = 'global' or m.project_id = %(p)s)
          and (%(del)s or m.deleted_at is null) and (%(kind)s::text is null or m.kind = %(kind)s)
          and (%(scope)s::text is null or m.scope = %(scope)s) and (%(pin)s::bool is null or m.pinned = %(pin)s)
          and (%(q)s::text is null or m.text ilike %(q)s or m.kind ilike %(q)s)
        order by m.updated_at desc limit %(n)s""",
        {"u": u, "p": await project_id(st, u, project), "del": include_deleted, "kind": kind, "scope": scope, "pin": pinned,
         "q": like(q), "n": max(1, min(limit, 500))})
    return [to_memory(r) for r in rows]


@router.get("/memories/{mid}", response_model=MemoryDetail)
async def memory(mid: str, request: Request):
    st, u = ctx(request)
    m = to_memory(await _mem(st, u, mid))
    hist = await st.store.fetch(
        f"""with recursive h(id, depth) as (
          select supersedes, 1 from memories where id = %(id)s and user_id = %(u)s
          union all select m.supersedes, h.depth + 1 from memories m join h on m.id = h.id where h.depth < 100
        ) select {MEM_COLS} from {MEM_FROM} join h on h.id = m.id where m.user_id = %(u)s order by h.depth""",
        {"id": mid, "u": u})
    return MemoryDetail(**m.model_dump(), history=[to_memory(r) for r in hist])


@router.post("/memories", response_model=MemoryWrite)
async def create_memory(b: NewMemory, request: Request):
    st, u = ctx(request)
    if b.scope == "project" and not b.project:
        fail(422, "invalid", "a project memory needs a project")
    pid = await project_id(st, u, b.project) if b.scope == "project" else None
    action, row = await write_memory(MemoryRow(b.scope, b.kind, b.text, pid, pinned=b.pinned, source={"kind": "manual"}),
                                     st.store, st.embedder, u)
    return {"action": action, "memory": to_memory(await _mem(st, u, row["id"]))}


@router.patch("/memories/{mid}", response_model=Memory)
async def update_memory(mid: str, b: MemoryPatch, request: Request):
    st, u = ctx(request)
    r = await _mem(st, u, mid)
    if b.scope == "project" and not r["project_id"]:
        fail(422, "invalid", "a global memory has no project to move to")
    new_text = b.text is not None and b.text != r["text"]
    await st.store.execute(
        """update memories set text = coalesce(%(text)s, text), hash = coalesce(%(hash)s, hash), embedding = coalesce(%(v)s, embedding),
          pinned = coalesce(%(pin)s, pinned), kind = coalesce(%(kind)s, kind), scope = coalesce(%(scope)s, scope),
          project_id = case when %(scope)s::text = 'global' then null else project_id end, updated_at = now()
        where id = %(id)s and user_id = %(u)s""",
        {"text": b.text if new_text else None, "hash": hashlib.sha256(b.text.encode()).hexdigest() if new_text else None,
         "v": _unit((await st.embedder.embed([b.text], "doc"))[0]) if new_text else None,
         "pin": b.pinned, "kind": b.kind, "scope": b.scope, "id": mid, "u": u})
    return to_memory(await _mem(st, u, mid))


@router.delete("/memories/{mid}", response_model=Ok)
async def delete_memory(mid: str, request: Request):
    st, u = ctx(request)
    await _mem(st, u, mid)
    await st.store.execute("update memories set deleted_at = coalesce(deleted_at, now()) where id = %s and user_id = %s", (mid, u))
    return Ok()


@router.post("/memories/{mid}/restore", response_model=Memory)
async def restore_memory(mid: str, request: Request):
    st, u = ctx(request)
    await _mem(st, u, mid)
    await st.store.execute("update memories set deleted_at = null where id = %s and user_id = %s", (mid, u))
    return to_memory(await _mem(st, u, mid))


@router.post("/memories/import", response_model=JobRef)
async def import_memories(b: ImportRequest, request: Request):
    st, u = ctx(request)
    return {"job_id": await jobs.submit(st, "import_memory", {"dirs": b.dirs, "user_id": u}, u)}


@router.post("/memories/backfill", response_model=JobRef)
async def backfill(b: BackfillRequest, request: Request):
    st, u = ctx(request)
    return {"job_id": await jobs.submit(st, "backfill", {"sessions": b.sessions, "user_id": u}, u)}
