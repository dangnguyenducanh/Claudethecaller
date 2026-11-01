"""Coding graph from graphify (m6, research.md R1): graph.json's code + rationale nodes and the links among them.

graphify keeps running as installed (post-commit hook); we only read its output, and re-import when its
built_at_commit differs from the version stored in graph_sources.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from ctc.graph import db

GRAPH = Path("graphify-out") / "graph.json"


def read_graphify(path: Path) -> tuple[list[db.Node], list[db.Edge], str]:
    """(nodes, edges, built_at_commit); pure. A missing or unreadable file raises FileNotFoundError / ValueError (one line).
    A code node's text = the labels of the rationale nodes explaining it + its file (db embeds label + text)."""
    try:
        g = json.loads(Path(path).read_text())
        keep = {n["id"]: n for n in g["nodes"] if n.get("file_type") in ("code", "rationale")}
        links = [x for x in g["links"] if x["source"] in keep and x["target"] in keep]
        why: dict[str, list[str]] = {}
        for x in links:
            if x["relation"] == "rationale_for":
                why.setdefault(x["target"], []).append(keep[x["source"]]["label"])
        nodes = []
        for i, n in keep.items():
            f = n.get("source_file") or None  # '' on unresolved imports (ndarray, Path)
            line = re.match(r"L(\d+)", n.get("source_location") or "")
            nodes.append({"id": f"code:{i}", "kind": "coding", "type": n["file_type"], "label": n["label"],
                          "text": "\n".join(why.get(i, []) + ([f] if f else [])), "source_file": f,
                          "source_line": int(line[1]) if line else None, "origin": "graphify",
                          "meta": {"community": n["community_name"]} if n.get("community_name") else {}})
        edges = {(x["source"], x["target"], x["relation"]): {
            "src": f"code:{x['source']}", "dst": f"code:{x['target']}", "relation": x["relation"],
            "confidence": "EXTRACTED" if x.get("confidence", "EXTRACTED") == "EXTRACTED" else "INFERRED",  # AMBIGUOUS too
            "score": float(x.get("confidence_score", 1.0)), "origin": "graphify"} for x in links}
        return nodes, list(edges.values()), g["built_at_commit"]
    except FileNotFoundError:
        raise FileNotFoundError(f"{path} not found: run `graphify update .` first") from None
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as e:
        raise ValueError(f"{path} is not a readable graphify graph: {type(e).__name__} {e}") from None


async def import_graphify(store, user_id: str, project_id: str, repo: Path, force: bool = False) -> dict:
    """Replace origin graphify with repo's graph.json unless its built_at_commit is already imported (or force)."""
    nodes, edges, built = read_graphify(Path(repo) / GRAPH)
    res = {"nodes": len(nodes), "edges": len(edges), "built_at": built, "skipped": False}
    if not force and (src := await db.get_source(store, user_id, project_id, "graphify")) and src["version"] == built:
        return {**res, "skipped": True}
    await db.replace_origin(store, user_id, project_id, "graphify", nodes, edges)
    await db.set_source(store, user_id, project_id, "graphify", built, {"nodes": len(nodes), "edges": len(edges)})
    return res


def graphify_stale(repo: Path, known: str | None) -> bool:
    """False only when graph.json's built_at_commit equals `known`. Reads the last 4 KB only (graphify writes the key last);
    a key not found there counts as stale, and import_graphify's full read then decides."""
    p = Path(repo) / GRAPH
    try:
        with p.open("rb") as f:
            f.seek(max(0, p.stat().st_size - 4096))
            m = re.search(rb'"built_at_commit":\s*"([^"]*)"', f.read())
    except OSError:
        return True
    return m is None or m[1].decode() != known
