"""Context -> code links (m6 G3, design.md 5.5): placeholder resolution, commit links, by-meaning links, embeddings.

All three kinds are `implemented_in` edges (`tested_by` when the code lives under tests/); they differ by confidence and
origin: EXTRACTED parser / commit, INFERRED embed. Pure except embed_missing (DB + embedder) and commit_links (git).
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import numpy as np

from ctc.graph import db

CTX = {"story", "requirement", "task", "ticket", "decision", "constraint", "observation"}  # context types linked by meaning
HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)")


def _edge(src: str, dst: str, path: str, confidence: str, score: float, origin: str) -> dict:
    rel = "tested_by" if path.startswith("tests/") else "implemented_in"
    return {"src": src, "dst": dst, "relation": rel, "confidence": confidence, "score": score, "origin": origin}


def resolve(edges: list[dict], code_nodes: list[dict]) -> tuple[list[dict], int]:
    """Rewrite `file:<path>` dsts to the file's graphify node (label = basename) and `file:<path>::<sym>` to the node in
    that file labelled sym(), sym or .sym(); (kept edges, number of placeholders dropped as unresolved)."""
    files: dict[str, str] = {}
    syms: dict[tuple[str, str], str] = {}
    for n in sorted(code_nodes, key=lambda n: n["source_line"] or 0):  # a repeated name resolves to its first definition
        f = n["source_file"]
        if n["label"] == f.rsplit("/", 1)[-1]:
            files.setdefault(f, n["id"])
        syms.setdefault((f, n["label"].lstrip(".").removesuffix("()")), n["id"])
    out, missed = [], 0
    for e in edges:
        if not e["dst"].startswith("file:"):
            out.append(e)
            continue
        path, _, sym = e["dst"][5:].partition("::")
        if (dst := syms.get((path, sym)) if sym else files.get(path)) is None:
            missed += 1
            continue
        rel = "tested_by" if e["relation"] == "implemented_in" and path.startswith("tests/") else e["relation"]
        out.append({**e, "dst": dst, "relation": rel})
    return out, missed


def commit_links(repo: Path, code_nodes: list[dict], tags: dict[str, str]) -> list[dict]:
    """Ticket -> code edges from commits whose subject matches a feature's tag regex (group 1 = ticket number), research.md
    R6: each `git show -U0` hunk maps to the code node with the greatest start line <= the hunk's first new line, else the
    file node. Merge commits (and the stash's helper commits) are left out.
    ponytail: line numbers are the current graph's, the hunks the commit's; a file reshaped since then maps loosely."""
    def git(*args: str) -> str:  # not a git repo / no commits -> ""
        return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=False).stdout

    by_file: dict[str, list[dict]] = {}
    for n in sorted(code_nodes, key=lambda n: n["source_line"] or 0):
        by_file.setdefault(n["source_file"], []).append(n)
    out: dict[tuple[str, str], dict] = {}
    for ln in git("log", "--exclude=refs/stash", "--all", "--no-merges", "--format=%H%x09%s").splitlines():
        sha, _, subject = ln.partition("\t")
        tickets = [f"ctx:{feat}:ticket-{m[1]}" for feat, rx in tags.items() if (m := re.search(rx, subject))]
        if not tickets:
            continue
        f = None
        for d in git("show", "-U0", "--format=", sha).splitlines():
            if d.startswith("+++ "):
                f = d[6:] if d.startswith("+++ b/") else None  # /dev/null: a deleted file
            elif f in by_file and (m := HUNK.match(d)):
                before = [n for n in by_file[f] if (n["source_line"] or 0) <= int(m[1])]
                node = before[-1] if before else next((n for n in by_file[f] if n["label"] == f.rsplit("/", 1)[-1]), None)
                if node:
                    out.update({(t, node["id"]): _edge(t, node["id"], f, "EXTRACTED", 1.0, "commit") for t in tickets})
    return list(out.values())


def inferred_links(graph_nodes: list[dict], vectors: list[tuple[str, np.ndarray]], floor: float, k: int) -> list[dict]:
    """INFERRED edges from each context node of a CTX type to its top-k repo code nodes with cosine >= floor."""
    vec = dict(vectors)
    ctx = [n for n in graph_nodes if n["type"] in CTX and n["id"] in vec]
    code = [n for n in graph_nodes if n["type"] == "code" and n["source_file"] and n["id"] in vec]
    if not ctx or not code:
        return []
    a, b = (np.stack([vec[n["id"]] for n in ns]).astype(np.float32) for ns in (ctx, code))
    a /= np.maximum(np.linalg.norm(a, axis=1, keepdims=True), 1e-9)
    b /= np.maximum(np.linalg.norm(b, axis=1, keepdims=True), 1e-9)
    sims = a @ b.T
    out = []
    for r, n in enumerate(ctx):
        for j in np.argsort(-sims[r])[:k]:
            if sims[r, j] < floor:
                break
            out.append(_edge(n["id"], code[j]["id"], code[j]["source_file"], "INFERRED", round(float(sims[r, j]), 4), "embed"))
    return out


async def embed_missing(store, embedder, user_id: str, project_id: str, batch: int) -> int:
    """Embed every node without a vector (new or changed content) as a doc; returns how many."""
    todo = await db.need_embedding(store, user_id, project_id)
    for i in range(0, len(todo), batch):
        part = todo[i:i + batch]
        vecs = await embedder.embed([t for _, t in part], "doc")
        await db.set_embeddings(store, user_id, project_id, [(n, v) for (n, _), v in zip(part, vecs, strict=True)])
    return len(todo)
