"""`ctc graph build` and the `graph_build` job (m6 G3): graphify import when stale -> parse the docs -> claude-mem ->
commit links -> embeddings + by-meaning links. Each step replaces only its own origin's rows (graph/db.py), so review and
session links survive every rebuild.
"""

from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path

from ctc.config import cfg
from ctc.embedding.embedder import Embedder
from ctc.graph import claudemem, core, db, importer, link, parse
from ctc.ingestion.scanner import project_id
from ctc.server.writer import write

BRIDGE = "relation in ('implemented_in', 'tested_by', 'mentions')"  # context -> code
# files the session edited since its previous tick (FR-020); events.id orders rows applied in one writer batch too
TICK_SQL = """
select distinct payload->>'file_path' as f from events where session_id = %(s)s and type = 'tool'
  and payload->>'tool' in ('Edit', 'Write', 'MultiEdit') and payload->>'file_path' is not null
  and id > coalesce((select max(id) from events where session_id = %(s)s and type = 'graph_tick'), 0)
"""


def _rel(repo: Path, path: str) -> str:
    p = Path(path)
    return p.relative_to(repo).as_posix() if p.is_absolute() and p.is_relative_to(repo) else path


def _key(e: dict) -> tuple[str, str, str]:
    return e["src"], e["dst"], e["relation"]


async def _code(store, u: str, p: str) -> list[dict]:
    return await store.fetch("select id, label, source_file, source_line from graph_nodes where user_id = %s and project_id = %s"
                             " and type = 'code' and source_file is not null", (u, p))


async def _taken(store, u: str, p: str, mine: list[str]) -> set[tuple[str, str, str]]:
    """Bridge edges owned by other origins: a commit or by-meaning link never takes over a parser/review/session row."""
    return {_key(r) for r in await store.fetch(
        f"select src, dst, relation from graph_edges where user_id = %s and project_id = %s and origin <> all(%s) and {BRIDGE}",
        (u, p, mine))}


async def _claude_mem(store, u: str, p: str, repo: Path, code: list[dict]) -> tuple[str, int]:
    """Observations newer than the last one read -> ('<n> new' | 'down', unresolved file placeholders)."""
    src = await db.get_source(store, u, p, "claude-mem")
    after = int(src["version"]) if src else 0
    items = await claudemem.fetch(cfg(), repo, after)
    if items is None:
        return "down", 0
    nodes, edges = claudemem.to_graph(items, repo)
    edges, missed = link.resolve(edges, code)
    await db.replace_origin(store, u, p, "claude-mem", nodes, edges, files=[])  # an empty file scope deletes nothing: append
    await db.set_source(store, u, p, "claude-mem", str(max([after, *(i["id"] for i in items)])), {"new": len(nodes)})
    return f"{len(nodes)} new", missed


async def build(store, embedder, repo: Path, user_id: str = "local", files: list[str] | None = None, commits: bool = True,
                embed: bool = True) -> dict:
    """Build repo's graph; `files` = only these repo-relative docs (claude-mem is read on full builds only). commits=False
    also clears earlier commit links (the eval's graph); embed=False needs no embedder and keeps the by-meaning links.
    Returns {summary, links: {extracted, inferred, confirmed, unresolved}, tasks_linked, info}."""
    repo, gl, u, info = Path(repo), cfg()["graph_links"], user_id, {}
    p = project_id(repo)
    known = await db.get_source(store, u, p, "graphify")
    if importer.graphify_stale(repo, known and known["version"]):
        try:
            r = await importer.import_graphify(store, u, p, repo)
            info["graphify"] = f"{r['nodes']} nodes, {r['edges']} edges @ {r['built_at'][:8]}"
        except (FileNotFoundError, ValueError) as e:  # no coding graph: the context graph still builds
            info["graphify"] = str(e)
    code = await _code(store, u, p)
    nodes, edges = await asyncio.to_thread(parse.parse_repo, repo, files)
    edges, unresolved = link.resolve(edges, code)
    parsed = sorted({n["source_file"] for n in nodes})
    await db.replace_origin(store, u, p, "parser", nodes, edges, files=None if files is None else sorted({*parsed, *files}))
    for f in parsed:
        await db.set_source(store, u, p, f"parse:{f}", hashlib.sha256((repo / f).read_bytes()).hexdigest()[:16])
    if files is None:
        info["claude_mem"], missed = await _claude_mem(store, u, p, repo, code)
        unresolved += missed
    found = await asyncio.to_thread(link.commit_links, repo, code, gl["commit_tags"]) if commits else []
    taken = await _taken(store, u, p, ["commit", "embed"])
    await db.replace_origin(store, u, p, "commit", [], [e for e in found if _key(e) not in taken])
    if embed:
        info["embedded"] = await link.embed_missing(store, embedder, u, p, gl["embed_batch"])
        rows, _, vecs = await db.load_rows(store, u, p)
        taken = await _taken(store, u, p, ["embed"])
        inferred = link.inferred_links(rows, vecs, gl["inferred_floor"], gl["inferred_k"])
        await db.replace_origin(store, u, p, "embed", [], [e for e in inferred if _key(e) not in taken])
    n = {r["confidence"].lower(): r["n"] for r in await store.fetch(
        f"select confidence, count(*) as n from graph_edges where user_id = %s and project_id = %s and {BRIDGE} group by 1", (u, p))}
    return {"summary": parse.summary(nodes),
            "links": {k: n.get(k, 0) for k in ("extracted", "inferred", "confirmed")} | {"unresolved": unresolved},
            "tasks_linked": await store.fetchval(db.TASKS_LINKED_SQL, (u, p)), "info": info}


async def _tick(st, repo: Path, p: str, tick: dict) -> int:
    """US7: files the session edited since its previous tick become CONFIRMED links (origin session) of each ticked task;
    then a graph_tick event so the next tick counts only later edits. Returns the number of links written.
    ponytail: tool events still in the writer stream (< writer.interval_s old) count toward the next tick instead."""
    sid, feature = tick["session_id"], Path(_rel(repo, tick["file"])).parent.as_posix()
    files = [_rel(repo, r["f"]) for r in await st.store.fetch(TICK_SQL, {"s": sid})]
    edges, _ = link.resolve([{"src": f"ctx:{feature}:{t}", "dst": f"file:{f}", "relation": "implemented_in",
                              "confidence": "CONFIRMED", "score": 1.0, "origin": "session"}
                             for t in tick["tasks"] for f in files], await _code(st.store, "local", p))
    await db.upsert_edges(st.store, "local", p, edges)
    await write(st, "event", {"session_id": sid, "type": "graph_tick", "payload": {"file": tick["file"], "tasks": tick["tasks"]}})
    return len(edges)


async def run_job(st, payload: dict, progress) -> dict:
    """Job kind `graph_build`, payload {cwd, files?, tick?: {session_id, file, tasks}, commits?, embed?}
    (contracts/modules.md). A tick re-parses its tasks.md first, so a task it confirms exists."""
    if st.cfg["mode"] == "shared":  # like the indexer: cwd comes from a remote client and names a path on the server's disk
        raise RuntimeError("graph_build runs in local mode only")
    repo, tick = Path(payload["cwd"]), payload.get("tick")
    p = project_id(repo)
    embedder = Embedder(st.cfg["embed_url"], st.cfg["batch_timeout_s"])
    try:
        res = await build(st.store, embedder, repo, files=payload.get("files") or ([_rel(repo, tick["file"])] if tick else None),
                          commits=payload.get("commits", True), embed=payload.get("embed", True))
        if tick:
            res["ticked"] = await _tick(st, repo, p, tick)
        return res
    finally:
        await embedder.aclose()
        core.invalidate(st, "local", p)  # graph_build is local-only, so this worker is the only one holding the graph
