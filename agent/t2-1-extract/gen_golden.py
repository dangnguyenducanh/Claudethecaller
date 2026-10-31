#!/usr/bin/env python3
"""Regenerate agent/t2-1-extract/golden/ids.json from graphify 0.9.93 (orchestrator only; the coder never runs this).

    /home/aiface/.local/share/uv/tools/graphifyy/bin/python -I agent/t2-1-extract/gen_golden.py

Runs graphify's own extractor on every file under golden/src (root = golden/src, so ids equal the ids those files get in
the repo) and keeps, per file, the nodes DECISIONS D3 says ctc must reproduce: file_type code or document, source_file
equal to the fixture. Everything graphify emits and ctc does not model is listed under `excluded` with the reason.
Then writes golden/MANIFEST.sha256 (sources + ids.json), which checks.mjs verifies.
"""
import hashlib
import importlib.metadata as md
import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "golden" / "src"
OUT = HERE / "golden" / "ids.json"
PARENT_RELATIONS = ("contains", "method", "case_of", "defines")  # graphify relations that mean "declared inside"; ctc writes all as `contains`
MAKE_ID_INPUTS = [
    ["src/ctc/decision/bundle", "suggestion_line"], ["Größe"], ["İslemYap"], ["ΣΑΣ ὅς"], ["ﬁle ﬀ"], ["ſtraße"], ["ᏣᎳᎩ"], ["数据_处理"],
    ["مرحبا بك"], ["हिन्दी"], ["e\u0301cole"], ["emoji 🙂 here"], ["__init__"], ["._a.b_."], ["a..b--c"], ["", "x"], ["x", ""],
    ["Ⅻ ½ ²"], ["CamelCase", "HTTPServer"], ["a", "b", "c"], ["___"], ["tab\tnew\nline"], ["ǅungla"], ["ΐ"], ["\u1f80"],
]
LANG = {".ts": "ts", ".tsx": "tsx", ".js": "js", ".mjs": "js", ".py": "python", ".sh": "bash", ".json": "json", ".md": "markdown"}


def main() -> None:
    from graphify.extract import extract
    from graphify.ids import make_id

    if md.version("graphifyy") != "0.9.93":
        sys.exit(f"need graphify 0.9.93, found {md.version('graphifyy')}")
    files = sorted(p for p in SRC.rglob("*") if p.is_file())
    with tempfile.TemporaryDirectory() as cache:
        res = extract(files, cache_root=Path(cache), root=SRC, parallel=False)
    by_file: dict[str, dict] = {}
    for p in files:
        rel = p.relative_to(SRC).as_posix()
        by_file[rel] = {"lang": LANG[p.suffix], "nodes": [], "excluded": []}
    in_file_ids: dict[str, str] = {}
    for n in res["nodes"]:
        sf = n.get("source_file") or ""
        if sf not in by_file:
            continue
        ft = n.get("file_type")
        if ft not in ("code", "document"):
            by_file[sf]["excluded"].append({"id": n["id"], "reason": f"file_type {ft}"})
            continue
        in_file_ids[n["id"]] = sf
        by_file[sf]["nodes"].append({"id": n["id"], "label": n.get("label"), "line": n.get("source_location")})
    parent: dict[str, str] = {}
    for e in res["edges"]:
        s, t = e.get("source"), e.get("target")
        if e.get("relation") in PARENT_RELATIONS and s in in_file_ids and t in in_file_ids and in_file_ids[s] == in_file_ids[t]:
            parent.setdefault(t, s)
    for f in by_file.values():
        for n in f["nodes"]:
            n["parent"] = parent.get(n["id"])
        f["nodes"].sort(key=lambda n: n["id"])
        f["excluded"].sort(key=lambda n: n["id"])
    grammars = {d.metadata["Name"]: d.version for d in md.distributions()
                if d.metadata["Name"] in ("tree-sitter", "tree-sitter-typescript", "tree-sitter-javascript", "tree-sitter-python",
                                          "tree-sitter-bash", "tree-sitter-json")}
    doc = {"graphify": "0.9.93", "python_grammars": dict(sorted(grammars.items())), "root": "golden/src", "files": by_file}
    doc["make_id"] = [{"parts": parts, "id": make_id(*parts)} for parts in MAKE_ID_INPUTS]
    OUT.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n")
    lines = [f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(HERE / 'golden').as_posix()}" for p in [*files, OUT]]
    (HERE / "golden" / "MANIFEST.sha256").write_text("\n".join(lines) + "\n")
    print(f"{len(files)} files, {sum(len(f['nodes']) for f in by_file.values())} ids -> {OUT}")


if __name__ == "__main__":
    main()
