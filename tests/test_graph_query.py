"""m6 G5: pull queries (search, explain, affected, path), graphify export and the four MCP tools, over an in-memory
graph (no DB, no embedder)."""

import asyncio
import json
import re
import shutil
import subprocess
from types import SimpleNamespace

import numpy as np
import pytest
from mcp.server.mcpserver.exceptions import ToolError

from ctc.graph import core, export, query
from ctc.server import mcp as mcp_mod

STORY, US2, TASK, DEC = "ctx:specs/009-demo:US1", "ctx:specs/009-demo:US2", "ctx:specs/009-demo:T001", "ctx:CLAUDE:decision:2026-10-20:1"
FILE, RETRY, WHY, CLAIM, MAIN = "code:src_engine", "code:src_engine_retry", "code:src_engine_rationale_121", "code:src_engine_claim", "code:src_engine_main"
T002, RUN, APP, TEST, LONELY = "ctx:specs/009-demo:T002", "code:src_cli_run", "code:src_cli_app", "code:tests_test_engine_test_retry", "code:src_lonely"
QV = np.eye(8, dtype=np.float32)[0]
PID = "abcd1234"


def node(i, type_, label, f, line):
    kind = "coding" if i.startswith("code:") else "context"
    return {"id": i, "kind": kind, "type": type_, "label": label, "text": f"{label} body", "source_file": f,
            "source_line": line, "origin": "test", "meta": {}}


NODES = [
    node(STORY, "story", "Retry a failed run", "specs/009-demo/spec.md", 10),
    node(US2, "story", "Dashboard colours", "specs/009-demo/spec.md", 30),
    node(TASK, "task", "Add retry() to src/engine.py", "specs/009-demo/tasks.md", 5),
    node(T002, "task", "Tidy src/engine.py", "specs/009-demo/tasks.md", 6),
    node(DEC, "decision", "Never re-run a side effect", "CLAUDE.md", 90),
    node(FILE, "code", "engine.py", "src/engine.py", 1),
    node(RETRY, "code", "retry()", "src/engine.py", 120),
    node(WHY, "rationale", "Retry resets the worktree first", "src/engine.py", 121),
    node(CLAIM, "code", "claim()", "src/engine.py", 180),
    node(MAIN, "code", "main()", "src/engine.py", 300),
    node(RUN, "code", "run()", "src/cli.py", 10),
    node(APP, "code", "app()", "src/cli.py", 40),
    node(TEST, "code", "test_retry()", "tests/test_engine.py", 3),
    node(LONELY, "code", "lonely()", "src/lonely.py", 1),
    *(node(f"code:src_h{i}_helper", "code", "helper()", f"src/h{i}.py", 2) for i in range(7)),
]
EDGES = [
    (TASK, STORY, "serves", "EXTRACTED", 1.0), (DEC, TASK, "constrains", "EXTRACTED", 1.0),
    (TASK, CLAIM, "implemented_in", "INFERRED", 0.9), (TASK, RETRY, "implemented_in", "EXTRACTED", 1.0),
    (TASK, TEST, "tested_by", "CONFIRMED", 1.0), (T002, FILE, "implemented_in", "EXTRACTED", 1.0),  # file-level link
    (FILE, RETRY, "contains", "EXTRACTED", 1.0), (FILE, CLAIM, "contains", "EXTRACTED", 1.0), (FILE, MAIN, "contains", "EXTRACTED", 1.0),
    (WHY, RETRY, "rationale_for", "EXTRACTED", 1.0),
    (CLAIM, RETRY, "calls", "EXTRACTED", 1.0), (MAIN, CLAIM, "calls", "EXTRACTED", 1.0), (RUN, MAIN, "calls", "EXTRACTED", 1.0),
    (APP, RUN, "calls", "EXTRACTED", 1.0), (TEST, RETRY, "calls", "EXTRACTED", 1.0),
]
E = np.eye(8, dtype=np.float32)
VECS = {TASK: E[0], RETRY: 0.9 * E[0] + 0.436 * E[1], STORY: 0.6 * E[0] + 0.8 * E[2], CLAIM: 0.5 * E[0] + 0.866 * E[3],
        DEC: E[4], MAIN: E[5], US2: E[6]}


def graph(extra: int = 0) -> core.Graph:
    """The demo graph; `extra` adds that many long-label tasks that match the question and serve the story."""
    nodes = NODES + [node(f"ctx:specs/009-demo:T{100 + i}", "task", f"T{100 + i} " + "x" * 190, "specs/009-demo/tasks.md", 50 + i)
                     for i in range(extra)]
    edges = EDGES + [(n["id"], STORY, "serves", "EXTRACTED", 1.0) for n in nodes[len(NODES):]]
    vecs = VECS | {n["id"]: E[0] for n in nodes[len(NODES):]}
    by = {n["id"]: n for n in nodes}
    out, inc, files = {}, {}, {}
    for n in nodes:
        files.setdefault(n["source_file"], []).append(n["id"])
    for s, d, r, c, sc in edges:
        out.setdefault(s, []).append((d, r, c, sc))
        inc.setdefault(d, []).append((s, r, c, sc))
        if by[s]["kind"] == "context" and by[d]["kind"] == "coding":  # like core.load: context linked to a file's code
            files[by[d]["source_file"]].append(s)
    ids = list(vecs)
    v = np.stack([vecs[i] for i in ids]).astype(np.float32)
    v /= np.linalg.norm(v, axis=1, keepdims=True)
    return core.Graph("v1", by, out, inc, files, np.array(ids, dtype=object), v)


def test_search_both_ranks_bridge_links():
    r = query.search(graph(), QV, "both", 2)
    assert [h["id"] for h in r["hits"]] == [TASK, RETRY] and r["truncated"] == 0
    assert [(x["id"], x["confidence"]) for x in r["hits"][0]["links"]] == [(TEST, "CONFIRMED"), (RETRY, "EXTRACTED"), (CLAIM, "INFERRED")]
    assert [x["id"] for x in r["hits"][1]["links"]] == [TASK]  # code -> context, reverse
    assert "retry()" in r["text"] and "src/engine.py:120" in r["text"] and "truncated" not in r["text"]


def test_search_one_graph_and_budget():
    r = query.search(graph(), QV, "coding", 8)
    assert r["hits"] and r["hits"][0]["id"] == RETRY
    assert all(i.startswith("code:") for h in r["hits"] for i in [h["id"], *(x["id"] for x in h["links"])])
    assert {h["id"] for h in query.search(graph(), QV, "context", 8)["hits"]} <= {n["id"] for n in NODES if n["kind"] == "context"}
    big = query.search(graph(60), QV, "both", 60)
    assert big["truncated"] > 0 and len(big["hits"]) + big["truncated"] == 60
    assert len(big["text"]) <= 6000 and big["text"].endswith(f"(truncated: {big['truncated']} more)")


def test_explain_resolves_names():
    r = query.explain(graph(), "retry")  # label without ()
    assert r["node"]["id"] == RETRY and "retry() body" in r["text"]
    got = {(n["id"], n["relation"], n["direction"]) for n in r["neighbours"]}
    assert {(CLAIM, "calls", "in"), (TASK, "implemented_in", "in"), (FILE, "contains", "in"), (WHY, "rationale_for", "in")} <= got
    assert query.explain(graph(), RETRY)["node"]["id"] == RETRY  # exact id
    assert query.explain(graph(), "engine.py")["node"]["id"] == FILE  # exact label
    assert query.explain(graph(), "src/engine.py")["node"]["id"] == FILE  # source_file -> its file node
    with pytest.raises(LookupError, match="no node matching 'nope'"):
        query.explain(graph(), "nope")
    with pytest.raises(LookupError) as e:
        query.explain(graph(), "helper")
    assert len(re.findall(r"code:src_h\d_helper", str(e.value))) == 5
    big = query.explain(graph(40), STORY)
    assert len(big["neighbours"]) == 20 and big["truncated"] == 21 and big["text"].endswith("(truncated: 21 more)")


def test_affected_and_path():
    r = query.affected(graph(), RETRY)
    assert {(c["id"], c["depth"]) for c in r["code"]} == {(CLAIM, 1), (TEST, 1), (MAIN, 2), (RUN, 3)}  # app() is depth 4
    assert {c["id"] for c in r["context"]} == {TASK, STORY, T002}
    assert "claim()" in r["text"]
    p = query.path(graph(), STORY, "claim")
    assert [(h["from"], h["relation"], h["to"], h["forward"]) for h in p["hops"]] == [
        (STORY, "serves", TASK, False), (TASK, "implemented_in", CLAIM, True)]
    assert "<-serves-" in p["text"] and "-implemented_in->" in p["text"]
    assert query.path(graph(), STORY, LONELY) is None


def test_export_graphify(tmp_path):
    g = graph()
    d = export.to_graphify(g, "context", "abc123")
    assert set(d) == {"directed", "multigraph", "graph", "nodes", "links", "built_at_commit"} and d["built_at_commit"] == "abc123"
    assert {n["id"] for n in d["nodes"]} == {STORY, US2, TASK, T002, DEC} and {n["file_type"] for n in d["nodes"]} == {"document"}
    assert {(x["source"], x["target"], x["relation"]) for x in d["links"]} == {(TASK, STORY, "serves"), (DEC, TASK, "constrains")}
    c = {n["id"]: n for n in export.to_graphify(g, "coding")["nodes"]}
    assert c["src_engine_retry"] == {"id": "src_engine_retry", "label": "retry()", "file_type": "code",
                                     "source_file": "src/engine.py", "source_location": "L120"}
    assert c["src_engine_rationale_121"]["file_type"] == "rationale" and not any(i.startswith(("ctx:", "code:")) for i in c)
    both = export.to_graphify(g, "both")
    assert len(both["nodes"]) == len(NODES) and {"source": TASK, "target": "src_engine_retry", "relation": "implemented_in",
                                                 "confidence": "EXTRACTED", "confidence_score": 1.0} in both["links"]
    if not shutil.which("graphify"):
        pytest.skip("graphify not installed")
    p = tmp_path / "ctc-context.json"
    p.write_text(json.dumps(d))
    r = subprocess.run(["graphify", "query", "retry a failed run", "--graph", str(p)], check=False, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0 and "Retry a failed run" in r.stdout, r.stdout + r.stderr


@pytest.fixture
def call(monkeypatch):
    """call(tool, **args) -> CallToolResult, through the MCP server, with a stub State holding the demo graph."""
    async def fetchval(sql, params):  # the most recent session's project / a project name
        return PID

    st = SimpleNamespace(graphs={("local", PID): graph()}, names={("local", PID): "demo"}, store=SimpleNamespace(fetchval=fetchval))
    monkeypatch.setattr(mcp_mod, "state", st)

    async def embed(st, texts):
        return [QV for _ in texts]
    monkeypatch.setattr(mcp_mod, "_embed", embed)
    return lambda name, **args: asyncio.run(mcp_mod.mcp.call_tool(name, args))


def test_mcp_tools(call):
    r = call("graph_search", question="retry a failed run", k=2, project="demo")
    assert [h["id"] for h in r.structured_content["hits"]] == [TASK, RETRY] and "retry()" in r.content[0].text
    r = call("graph_explain", node="retry")  # no project: the latest session's
    assert r.structured_content["node"]["id"] == RETRY and len(r.content[0].text) <= 6000
    assert CLAIM in {c["id"] for c in call("graph_affected", node=RETRY).structured_content["code"]}
    assert "-implemented_in->" in call("graph_path", a=STORY, b="claim").content[0].text
    assert call("graph_path", a=STORY, b=LONELY).content[0].text == "no path within 6 hops"
    with pytest.raises(ToolError, match="no node matching 'nope'"):
        call("graph_explain", node="nope")
    mcp_mod.state.graphs[("local", PID)] = graph(60)
    t = call("graph_search", question="x", k=60).content[0].text
    assert len(t) <= 6000 and re.search(r"\(truncated: \d+ more\)$", t)
