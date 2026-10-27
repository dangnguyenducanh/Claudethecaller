"""Indexer (PLAN.md B3): scan → upsert → embed only the vector texts not stored yet → drop stale ones."""

from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path

from ctc.config import cfg
from ctc.embedding.embedder import Embedder
from ctc.ingestion.scanner import default_roots, scan_library
from ctc.storage.cache import Cache
from ctc.storage.store import Store


def texts(cap: dict, mode: str | None = None) -> list[str]:
    """What gets a vector. `current` (config embed.text): the doc text (name, description, summary once A1 enriched it)
    and each trigger. `skillret`: the one string SkillRet's embedder was trained on, name | description | body, body cut
    at embed.skillret_body_chars (no body, e.g. a catalog row, = name | description)."""
    e = cfg()["embed"]
    if (mode or e["text"]) == "skillret":
        body = (cap.get("body") or "")[: e["skillret_body_chars"]]
        return [f"{cap['name']} | {cap['description']} | {body}" if body else f"{cap['name']} | {cap['description']}"]
    doc =f"{cap['name']}: {cap['description']}"[:1000] + (f" {cap['summary']}" if cap.get("summary") else "")
    return [doc, *(t for t in cap.get("triggers") or [] if t.strip())]  # TEI rejects a whole batch with one empty input


async def catalog_bodies(store: Store) -> dict[str, str]:
    """{cap id: body cut at embed.skillret_body_chars} when embed.text is skillret, else {}. The catalog carries no body
    (RAM on the hot path), so whoever rebuilds the stored vector text (build_index, enrich.dedup) fetches it for one pass,
    200 ids per statement so a remote database stays under the 2 s statement timeout."""
    if cfg()["embed"]["text"] != "skillret":
        return {}
    n, ids, out = cfg()["embed"]["skillret_body_chars"], list(store.catalog), {}
    for i in range(0, len(ids), 200):
        out.update({r["id"]: r["body"] for r in await store.fetch("select id, left(body, %s) as body from capabilities where id = any(%s)", (n, ids[i : i + 200]))})
    return out


async def build_index(store: Store, embedder: Embedder, progress=None) -> int:
    """Embed the (cap_id, text_hash) pairs the catalog wants and the DB lacks; delete the ones it no longer wants.
    text_hash = sha256(model + text), so a model change re-embeds everything. Returns how many were embedded."""
    await store.refresh_catalog()  # this worker's catalog may predate another process's upsert
    if not embedder.model_version:
        await embedder.embed(["warmup"], "doc")  # learns the model id for the hash
    model = embedder.model_version
    bodies = await catalog_bodies(store)
    want = {(c["id"], hashlib.sha256((model + t).encode()).hexdigest()): t
            for c in store.catalog.values() for t in texts({**c, "body": bodies.get(c["id"])})}
    have = await store.vector_keys()
    missing = [key for key in want if key not in have]
    for start in range(0, len(missing), 32):  # TEI max_client_batch_size = 32
        batch = missing[start : start + 32]
        vecs = await embedder.embed([want[key] for key in batch], "doc")
        await store.insert_vectors([(c, h, model, want[(c, h)], v) for (c, h), v in zip(batch, vecs)])
        if progress:
            await progress((start + len(batch)) / len(missing))
    # removed caps cascade; this catches changed texts and old models. Caps outside our catalog were added after the
    # refresh by another process: their vectors are theirs, not stale.
    if stale := [key for key in have - want.keys() if key[0] in store.catalog]:
        await store.delete_vectors(stale)
    return len(missing)


async def index_library(store: Store, embedder: Embedder, project_dir: Path | None = None, claude_home: Path | None = None,
                        progress=None) -> dict:
    """project_dir None = user + plugin roots only (the daemon's startup job): no project namespace is scanned or deleted."""
    proj = Path(project_dir).resolve() if project_dir else None  # absolute paths in rows
    roots = default_roots(proj or Path.cwd(), Path(claude_home) if claude_home else None)
    if not proj or (proj / ".claude").resolve() == roots[0][0].resolve():  # a project at $HOME: its .claude is the user root
        roots = [r for r in roots if not r[1].startswith("project@")]
    caps, _ = await asyncio.to_thread(scan_library, roots)  # ~1k file reads: off the event loop (the daemon's 20 ms Redis timeout)
    if proj:  # a cloned repo is untrusted: its .claude-plugin manifest must not pull in files from outside the project
        caps = [c for c in caps if not c.namespace.startswith("project@") or Path(c.path).is_relative_to(proj / ".claude")]
    # The user + plugin scan owns every non-project namespace: one that is no longer installed is deleted (an uninstalled
    # plugin). ponytail: a half-written installed_plugins.json drops its plugins (and their A1 enrichment) until the next index.
    owned = {c["namespace"] for c in store.catalog.values() if not c["namespace"].startswith("project@")}
    diff = await store.upsert(caps, sorted(owned | {ns for _, ns in roots}))  # refreshes the catalog and library_version
    n = await build_index(store, embedder, progress)
    return {"added": len(diff.added), "changed": len(diff.changed), "removed": len(diff.removed),
            "vectors": (await store.counts())["vectors"], "embedded": n, "library_version": store.library_version}


async def run_job(st, payload: dict, progress) -> dict:
    """Job kind `index`, payload {cwd?} (no cwd = user + plugin roots). Own embedder: batches need batch_timeout_s."""
    # shared mode: cwd comes from a remote client and would name a path on the server's disk; never scan it
    cwd = payload.get("cwd") if st.cfg["mode"] != "shared" else None
    embedder = Embedder(st.cfg["embed_url"], st.cfg["batch_timeout_s"])
    try:
        return await index_library(st.store, embedder, Path(cwd) if cwd else None, Path(st.cfg["claude_home"]), progress)
    finally:  # also after a failed embed pass: the upsert may have committed, other workers must reload their catalog
        await embedder.aclose()
        await st.cache.publish_inval("lib")


async def run(project_dir: Path) -> dict:
    """`ctc index` / `python -m ctc.ingestion.indexer` without a daemon: index into the configured DB, tell daemons."""
    c = cfg()
    store, embedder = await Store.open(c["database_url"]), Embedder(c["embed_url"], c["batch_timeout_s"])
    try:
        return await index_library(store, embedder, project_dir)
    finally:
        await store.close()
        await embedder.aclose()
        cache = Cache(c["redis_url"], c["cache"])  # never raises: a running daemon reloads its catalog, also after a failure
        await cache.start()
        await cache.publish_inval("lib")
        await cache.close()


if __name__ == "__main__":
    print(asyncio.run(run(Path.cwd())))
