"""RAM copy of one project's graph (m6, data-model.md "RAM graph"): adjacency dicts both ways + one unit-length float32 matrix.

One copy per worker and (user_id, project_id), in State.graphs. graph_for() never waits for the DB: a missing or 30 s old
copy schedules one background reload (only a version check when graph_sources did not change) and the caller gets
whatever is cached.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field

import numpy as np

from ctc.graph import db
from ctc.ingestion import scanner

log = logging.getLogger(__name__)

RANK = {"CONFIRMED": 0, "EXTRACTED": 1, "INFERRED": 2}  # code pointer order, then score
MAX_AGE_S = 30
VERSION_SQL = "select coalesce(max(updated_at)::text, '') from graph_sources where user_id = %s and project_id = %s"
_LOADING: dict[tuple[str, str], asyncio.Task] = {}  # in-flight background loads by key; also keeps the tasks referenced


@dataclass
class Graph:
    version: str                                          # max(graph_sources.updated_at) when loaded
    nodes: dict[str, dict]                                # id -> row without embedding
    out: dict[str, list[tuple[str, str, str, float]]]    # src -> (dst, relation, confidence, score), DROPPED left out
    inc: dict[str, list[tuple[str, str, str, float]]]    # dst -> (src, relation, confidence, score)
    by_file: dict[str, list[str]]                         # source_file -> its nodes + context nodes linked to its code
    ids: np.ndarray                                       # node id per row of vecs
    vecs: np.ndarray                                      # (n, 1024) float32, unit length; nodes without embedding left out
    loaded_at: float = field(default_factory=time.monotonic)

    def nearest(self, qv: np.ndarray, k: int, kind: str | None = None, types: set[str] | None = None) -> list[tuple[str, float]]:
        """Top-k (id, cosine), optionally only one kind / some types.
        ponytail: brute force over every vector plus a full argsort; fine to ~100k nodes, past that a HNSW library."""
        if not len(self.ids):
            return []
        qv = np.asarray(qv, dtype=np.float32)
        sims = self.vecs @ (qv / (np.linalg.norm(qv) or 1.0))
        hits = []
        for i in np.argsort(-sims):
            n = self.nodes[self.ids[i]]
            if (kind is None or n["kind"] == kind) and (types is None or n["type"] in types):
                hits.append((self.ids[i], float(sims[i])))
                if len(hits) == k:
                    break
        return hits

    def neighbours(self, node_id: str, relations: set[str] | None = None, direction: str = "both") -> list[tuple[str, str, str, float]]:
        """(other id, relation, confidence, score); direction out | in | both."""
        sides = {"out": (self.out,), "in": (self.inc,), "both": (self.out, self.inc)}[direction]
        return [e for side in sides for e in side.get(node_id, ()) if relations is None or e[1] in relations]

    def code_for(self, ctx_id: str, k: int = 3) -> list[tuple[str, str, float]]:
        """(code id, confidence, score) of implemented_in/tested_by targets: CONFIRMED > EXTRACTED > INFERRED, then score,
        then id (load_rows has no order: ties must not flip between loads)."""
        best: dict[str, tuple[str, str, float]] = {}
        for d, c, s in sorted(((d, c, s) for d, r, c, s in self.out.get(ctx_id, ()) if r in ("implemented_in", "tested_by")),
                              key=lambda h: (RANK.get(h[1], 3), -h[2], h[0])):
            best.setdefault(d, (d, c, s))
        return list(best.values())[:k]

    def context_for_file(self, path: str) -> list[str]:
        """Context nodes linked to a node of `path` (not the ones merely written in that file)."""
        return [i for i in self.by_file.get(path, ()) if self.nodes[i]["kind"] == "context" and self.nodes[i]["source_file"] != path]


async def load(store, user_id: str, project_id: str) -> Graph:
    version = await store.fetchval(VERSION_SQL, (user_id, project_id))  # read first: a write racing the load forces a reload
    rows, edges, pairs = await db.load_rows(store, user_id, project_id)
    nodes = {r["id"]: r for r in rows}
    out: dict[str, list] = {}
    inc: dict[str, list] = {}
    files: dict[str, dict[str, None]] = {}  # ordered sets
    for r in rows:
        if r["source_file"]:
            files.setdefault(r["source_file"], {})[r["id"]] = None
    for e in edges:
        a, b = nodes.get(e["src"]), nodes.get(e["dst"])
        if a is None or b is None:  # written between the selects
            continue
        out.setdefault(e["src"], []).append((e["dst"], e["relation"], e["confidence"], e["score"]))
        inc.setdefault(e["dst"], []).append((e["src"], e["relation"], e["confidence"], e["score"]))
        for ctx, code in ((a, b), (b, a)):
            if ctx["kind"] == "context" and code["kind"] == "coding" and code["source_file"]:
                files.setdefault(code["source_file"], {})[ctx["id"]] = None
    pairs = [(i, v) for i, v in pairs if i in nodes]
    vecs = np.stack([v for _, v in pairs]) if pairs else np.zeros((0, 1024), np.float32)
    vecs /= np.maximum(np.linalg.norm(vecs, axis=1, keepdims=True), 1e-9)
    return Graph(version, nodes, out, inc, {f: list(ids) for f, ids in files.items()}, np.array([i for i, _ in pairs], dtype=object), vecs)


async def _refresh(st, key: tuple[str, str]) -> None:
    try:
        g = st.graphs.get(key)
        if g is not None and await st.store.fetchval(VERSION_SQL, key) == g.version:
            g.loaded_at = time.monotonic()
        else:
            st.graphs[key] = await load(st.store, *key)
    except Exception:  # keep the old copy; the next call after it went stale tries again
        log.warning("graph load failed for %s", key, exc_info=True)
    finally:
        _LOADING.pop(key, None)


async def graph_for(st, cwd: str, user_id: str = "local") -> Graph | None:
    """The cached graph for cwd's project (None until loaded, or when it has no rows); never awaits the DB.
    ponytail: freshness across workers is the 30 s version check; a load in flight when a build calls invalidate() can put
    the old copy back for one period. Redis invalidation when that matters."""
    key = (user_id, scanner.project_id(cwd))
    g = st.graphs.get(key)
    if (g is None or time.monotonic() - g.loaded_at > MAX_AGE_S) and key not in _LOADING:
        _LOADING[key] = asyncio.create_task(_refresh(st, key))
    return g if g is not None and g.nodes else None


def invalidate(st, user_id: str, project_id: str) -> None:
    st.graphs.pop((user_id, project_id), None)
