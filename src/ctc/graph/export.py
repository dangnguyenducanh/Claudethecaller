"""The RAM graph in graphify's graph.json shape (m6 G5), so `graphify query --graph <file>` and graphify's viewers work on
the context graph too. Generated files stay uncommitted (graphify-out/ is gitignored).

    uv run python -m ctc.graph.export --kind context|coding|both [--out PATH]   # default graphify-out/ctc-<kind>.json
"""

from __future__ import annotations

import json
from pathlib import Path

from ctc.graph import core, db
from ctc.ingestion.scanner import project_id


def to_graphify(g, kind: str, commit: str = "") -> dict:
    """kind: context | coding | both. Coding ids lose their `code:` prefix (graphify's own ids); context nodes are
    file_type `document`; links only among the nodes kept."""
    ids = {i: i.removeprefix("code:") if n["kind"] == "coding" else i for i, n in g.nodes.items() if kind in ("both", n["kind"])}
    nodes = [{"id": ids[i], "label": n["label"], "file_type": n["type"] if n["kind"] == "coding" else "document",
              "source_file": n["source_file"], "source_location": f"L{n['source_line'] or 1}"}
             for i, n in g.nodes.items() if i in ids]
    links = [{"source": ids[s], "target": ids[d], "relation": r, "confidence": c, "confidence_score": sc}
             for s, es in g.out.items() if s in ids for d, r, c, sc in es if d in ids]
    return {"directed": False, "multigraph": False, "graph": {}, "nodes": nodes, "links": links, "built_at_commit": commit}


async def write(store, repo: Path, kind: str, out: Path | None = None, user_id: str = "local") -> tuple[Path, dict]:
    """Load repo's graph from the DB and write it to out; built_at_commit = the imported graphify commit."""
    pid = project_id(repo)
    g = await core.load(store, user_id, pid)
    src = await db.get_source(store, user_id, pid, "graphify")
    d = to_graphify(g, kind, src["version"] if src else "")
    out = out or repo / "graphify-out" / f"ctc-{kind}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(d))
    return out, d


if __name__ == "__main__":
    import argparse
    import asyncio

    from ctc.config import cfg
    from ctc.storage.store import Store

    ap = argparse.ArgumentParser(prog="python -m ctc.graph.export", description="Write the graph as graphify graph.json.")
    ap.add_argument("--kind", choices=("context", "coding", "both"), default="both")
    ap.add_argument("--out", type=Path)
    a = ap.parse_args()

    async def main() -> tuple[Path, dict]:
        s = await Store.open(cfg()["database_url"], pool_max=1)
        try:
            return await write(s, Path.cwd(), a.kind, a.out)
        finally:
            await s.close()

    path, d = asyncio.run(main())
    print(f"{path}: {len(d['nodes'])} nodes, {len(d['links'])} links ({a.kind}, built_at {d['built_at_commit'][:8] or 'none'})")
