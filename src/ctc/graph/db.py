"""Graph store (m6, specs/002-context-coding-graph/data-model.md): nodes, edges and sources in Postgres, and the write rules.

A rebuild replaces rows by origin (optionally only for some source files). Edges with origin review or session are never
deleted or overwritten by a rebuild; any edge whose src or dst is gone is deleted at the end of each replace.
"""

from __future__ import annotations

import hashlib

import numpy as np
from psycopg.types.json import Jsonb

Node = dict  # {id, kind, type, label, text, source_file, source_line, origin, meta}  (content_hash filled here)
Edge = dict  # {src, dst, relation, confidence, score, origin}

# an unchanged content_hash keeps the embedding; an unchanged row is not rewritten
NODE_SQL = """
insert into graph_nodes (user_id, project_id, id, kind, type, label, text, source_file, source_line, content_hash, origin, meta)
values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
on conflict (user_id, project_id, id) do update set kind = excluded.kind, type = excluded.type, label = excluded.label,
  text = excluded.text, source_file = excluded.source_file, source_line = excluded.source_line, origin = excluded.origin,
  meta = excluded.meta, content_hash = excluded.content_hash, updated_at = now(),
  embedding = case when graph_nodes.content_hash = excluded.content_hash then graph_nodes.embedding end
where (graph_nodes.kind, graph_nodes.type, graph_nodes.source_file, graph_nodes.source_line, graph_nodes.content_hash,
       graph_nodes.origin, graph_nodes.meta)
  is distinct from (excluded.kind, excluded.type, excluded.source_file, excluded.source_line, excluded.content_hash,
       excluded.origin, excluded.meta)
"""

EDGE_SQL = """
insert into graph_edges (user_id, project_id, src, dst, relation, confidence, score, origin) values (%s, %s, %s, %s, %s, %s, %s, %s)
on conflict (user_id, project_id, src, dst, relation) do update set confidence = excluded.confidence, score = excluded.score,
  origin = excluded.origin, updated_at = now()
where graph_edges.origin not in ('review', 'session')
  and (graph_edges.confidence, graph_edges.score, graph_edges.origin) is distinct from (excluded.confidence, excluded.score, excluded.origin)
"""

# this origin's edges in scope: all of them, or (with files) those leaving a node of those files
DEL_EDGES_SQL = """
delete from graph_edges e where e.user_id = %(u)s and e.project_id = %(p)s and e.origin = %(o)s and (%(f)s::text[] is null
  or e.src in (select n.id from graph_nodes n where n.user_id = %(u)s and n.project_id = %(p)s and n.source_file = any(%(f)s::text[])))
"""
DEL_NODES_SQL = """
delete from graph_nodes where user_id = %(u)s and project_id = %(p)s and origin = %(o)s
  and (%(f)s::text[] is null or source_file = any(%(f)s::text[])) and id <> all(%(keep)s::text[])
"""
DANGLING_SQL = """
delete from graph_edges e where e.user_id = %(u)s and e.project_id = %(p)s and (
  not exists (select 1 from graph_nodes n where n.user_id = e.user_id and n.project_id = e.project_id and n.id = e.src)
  or not exists (select 1 from graph_nodes n where n.user_id = e.user_id and n.project_id = e.project_id and n.id = e.dst))
"""

TASKS_LINKED_SQL = """
select avg((exists (select 1 from graph_edges e where e.user_id = n.user_id and e.project_id = n.project_id and e.src = n.id
  and e.relation in ('implemented_in', 'tested_by') and e.confidence <> 'DROPPED'))::int)::float
from graph_nodes n where n.user_id = %s and n.project_id = %s and n.type = 'task'
"""


async def replace_origin(store, user_id: str, project_id: str, origin: str, nodes: list[Node], edges: list[Edge],
                         files: list[str] | None = None) -> None:
    """Make `origin`'s rows (only those of `files` when given) equal `nodes` + `edges`; then drop dangling edges.
    Edges are scoped by their own origin, so edge-only origins (commit, embed) replace with nodes=[].
    ponytail: separate statements, no transaction; a reader in between sees a half-replaced graph until its next refresh."""
    a = {"u": user_id, "p": project_id, "o": origin, "f": files, "keep": [n["id"] for n in nodes]}
    await store.execute(DEL_EDGES_SQL, a)
    await store.execute(DEL_NODES_SQL, a)
    rows = []
    for n in nodes:
        label, text = n["label"][:200], (n.get("text") or "")[:2000]
        rows.append((user_id, project_id, n["id"], n["kind"], n["type"], label, text, n.get("source_file"), n.get("source_line"),
                     hashlib.sha256(f"{label}\n{text}".encode()).hexdigest()[:16], origin, Jsonb(n.get("meta") or {})))
    if rows:
        await store.executemany(NODE_SQL, rows)
    await upsert_edges(store, user_id, project_id, edges)
    await store.execute(DANGLING_SQL, a)


async def upsert_edges(store, user_id: str, project_id: str, edges: list[Edge]) -> None:
    """Insert or update edges; an existing review/session row wins."""
    if edges:
        await store.executemany(EDGE_SQL, [(user_id, project_id, e["src"], e["dst"], e["relation"], e["confidence"],
                                            float(e.get("score", 1.0)), e["origin"]) for e in edges])


async def set_confidence(store, user_id: str, project_id: str, src: str, dst: str, relation: str, confidence: str,
                         origin: str) -> bool:
    """False when the edge does not exist."""
    return await store.execute(
        "update graph_edges set confidence = %s, origin = %s, updated_at = now()"
        " where user_id = %s and project_id = %s and src = %s and dst = %s and relation = %s",
        (confidence, origin, user_id, project_id, src, dst, relation)) > 0


async def need_embedding(store, user_id: str, project_id: str) -> list[tuple[str, str]]:
    rows = await store.fetch("select id, label || E'\\n' || text as t from graph_nodes"
                             " where user_id = %s and project_id = %s and embedding is null order by id", (user_id, project_id))
    return [(r["id"], r["t"]) for r in rows]


async def set_embeddings(store, user_id: str, project_id: str, rows: list[tuple[str, np.ndarray]]) -> None:
    if rows:
        await store.executemany("update graph_nodes set embedding = %s where user_id = %s and project_id = %s and id = %s",
                                [(np.asarray(v, dtype=np.float32), user_id, project_id, i) for i, v in rows])


async def get_source(store, user_id: str, project_id: str, source: str) -> dict | None:
    return await store.fetchrow("select version, info, updated_at from graph_sources where user_id = %s and project_id = %s"
                                " and source = %s", (user_id, project_id, source))


async def set_source(store, user_id: str, project_id: str, source: str, version: str, info: dict | None = None) -> None:
    await store.execute(
        "insert into graph_sources (user_id, project_id, source, version, info) values (%s, %s, %s, %s, %s)"
        " on conflict (user_id, project_id, source) do update set version = excluded.version, info = excluded.info, updated_at = now()",
        (user_id, project_id, source, version, Jsonb(info or {})))


async def counts(store, user_id: str, project_id: str) -> dict:
    """{nodes: {kind: {type: n}}, edges: {confidence: n}, tasks_linked: share of tasks with a live code link, None without tasks}."""
    p = (user_id, project_id)
    nodes: dict[str, dict[str, int]] = {}
    for r in await store.fetch("select kind, type, count(*) as n from graph_nodes where user_id = %s and project_id = %s"
                               " group by 1, 2", p):
        nodes.setdefault(r["kind"], {})[r["type"]] = r["n"]
    edges = {r["confidence"]: r["n"] for r in await store.fetch(
        "select confidence, count(*) as n from graph_edges where user_id = %s and project_id = %s group by 1", p)}
    return {"nodes": nodes, "edges": edges, "tasks_linked": await store.fetchval(TASKS_LINKED_SQL, p)}


async def load_rows(store, user_id: str, project_id: str) -> tuple[list[dict], list[dict], list[tuple[str, np.ndarray]]]:
    """(nodes without embeddings, non-DROPPED edges, (id, vector) pairs). Vectors go binary in keyset chunks of 2,000 so each
    statement stays under the pool's 2 s timeout (like Store._load_vectors)."""
    p = (user_id, project_id)
    nodes = await store.fetch("select id, kind, type, label, text, source_file, source_line, origin, meta from graph_nodes"
                              " where user_id = %s and project_id = %s", p)
    edges = await store.fetch("select src, dst, relation, confidence, score, origin from graph_edges"
                              " where user_id = %s and project_id = %s and confidence <> 'DROPPED'", p)
    vecs, last = [], ""
    async with store.pool.connection() as conn, conn.cursor(binary=True) as cur:
        while True:
            await cur.execute("select id, embedding from graph_nodes where user_id = %s and project_id = %s"
                              " and embedding is not null and id > %s order by id limit 2000", (*p, last))
            rows = await cur.fetchall()
            if not rows:
                break
            vecs += [(r["id"], np.asarray(r["embedding"].to_numpy(), dtype=np.float32)) for r in rows]
            last = rows[-1]["id"]
    return nodes, edges, vecs
