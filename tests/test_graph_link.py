"""m6 G3: placeholder resolution, commit links, inferred links, review, task ticks, claude-mem. DB cases run on the
scratch Postgres only (conftest)."""

import functools
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import httpx
import numpy as np
import pytest
from psycopg.types.json import Jsonb
from typer.testing import CliRunner

from ctc import cli
from ctc.config import cfg
from ctc.graph import build, claudemem, core, db, link
from ctc.ingestion.scanner import project_id
from ctc.storage.store import Store

TAGS = {".scratch/n8n-parity": r"\(n8n parity (\d{2})\)$"}
B_PY = '"""b."""\n\n\ndef first():\n    return 1\n\n\ndef second():\n    x = 1\n    return x\n'  # first L4, second L8
NODES = [("src_a", "a.py", "src/a.py", 1), ("src_a_retry", "retry()", "src/a.py", 3), ("src_b", "b.py", "src/b.py", 1),
         ("src_b_first", "first()", "src/b.py", 4), ("src_b_second", "second()", "src/b.py", 8)]
FILES = {
    "specs/009-demo/spec.md": "# Feature Specification: Demo\n\n### User Story 1 - Do a (Priority: P1)\n\nStory body.\n\n"
                              "## Requirements\n\n- **FR-001**: The system MUST retry.\n",
    "specs/009-demo/tasks.md": "# Tasks: Demo\n\n## Phase 3: User Story 1\n\n- [ ] T001 [US1] Change `src/b.py::second` and"
                               " src/missing.py\n- [ ] T002 [US1] Something else\n",
    ".scratch/n8n-parity/issues/01-x.md": "# 01 — x\n\nStatus: ready-for-agent\n\n## What to build\n\nX.\n",
}
_Client = httpx.AsyncClient


def code_nodes() -> list[dict]:
    return [{"id": f"code:{i}", "type": "code", "label": label, "source_file": f, "source_line": line} for i, label, f, line in NODES]


def make_repo(repo: Path) -> Path:
    for rel, text in FILES.items():
        (repo / rel).parent.mkdir(parents=True, exist_ok=True)
        (repo / rel).write_text(text)
    g = {"nodes": [{"id": i, "label": label, "file_type": "code", "source_file": f, "source_location": f"L{line}"}
                   for i, label, f, line in NODES],
         "links": [{"source": "src_a", "target": "src_a_retry", "relation": "contains"},
                   {"source": "src_b", "target": "src_b_first", "relation": "contains"}], "built_at_commit": "abc1234"}
    (repo / "graphify-out").mkdir(exist_ok=True)
    (repo / "graphify-out/graph.json").write_text(json.dumps(g))
    return repo


def mock_mem(monkeypatch, handler) -> None:
    monkeypatch.setattr(httpx, "AsyncClient", functools.partial(_Client, transport=httpx.MockTransport(handler)))


@pytest.fixture(autouse=True)
def no_mem(monkeypatch):
    """No test reaches a real claude-mem worker: by default it has no observations."""
    mock_mem(monkeypatch, lambda r: httpx.Response(200, json={"items": []}))


class FakeEmbedder:
    """The requirement and retry() at cosine 0.9, first() at 0.1; every other text gets its own orthogonal axis."""

    def __init__(self):
        self.axes: dict[str, int] = {}

    def vec(self, t: str) -> np.ndarray:
        v = np.zeros(1024, np.float32)
        if "MUST retry" in t:
            v[0] = 1
        elif t.startswith("retry()"):
            v[0], v[1] = 0.9, np.sqrt(1 - 0.81)
        elif t.startswith("first()"):
            v[0], v[2] = 0.1, np.sqrt(1 - 0.01)
        else:
            v[3 + self.axes.setdefault(t, len(self.axes))] = 1
        return v

    async def embed(self, texts, kind):
        assert kind == "doc"
        return np.stack([self.vec(t) for t in texts])

    async def aclose(self):
        pass


def edges_of(s, pid: str, origin: str | None = None):
    return s.fetch("select src, dst, relation, confidence, score, origin from graph_edges where project_id = %s"
                   " and (%s::text is null or origin = %s) order by src, dst", (pid, origin, origin))


def test_resolve_placeholders():
    e = {"src": "ctx:t", "relation": "implemented_in", "confidence": "EXTRACTED", "score": 1.0, "origin": "parser"}
    nodes = [*code_nodes(), {"id": "code:src_b_run", "type": "code", "label": "run()", "source_file": "src/b.py", "source_line": 20},
             {"id": "code:tests_test_a", "type": "code", "label": "test_a.py", "source_file": "tests/test_a.py", "source_line": 1}]
    edges, unresolved = link.resolve([{**e, "dst": "file:src/a.py"}, {**e, "dst": "file:src/b.py::run"},
                                      {**e, "dst": "file:src/missing.py"}, {**e, "dst": "file:tests/test_a.py"},
                                      {**e, "dst": "ctx:other", "relation": "part_of"}], nodes)
    assert [(x["dst"], x["relation"]) for x in edges] == [
        ("code:src_a", "implemented_in"), ("code:src_b_run", "implemented_in"), ("code:tests_test_a", "tested_by"), ("ctx:other", "part_of")]
    assert unresolved == 1


def git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


def test_commit_links(tmp_path, in_store):
    repo = make_repo(tmp_path)
    git(repo, "init", "-q", "-b", "main")
    for k, v in (("user.name", "t"), ("user.email", "t@x"), ("commit.gpgsign", "false"), ("core.hooksPath", "/dev/null")):
        git(repo, "config", k, v)
    b = repo / "src/b.py"
    b.parent.mkdir()
    b.write_text(B_PY)
    git(repo, "add", "src/b.py")
    git(repo, "commit", "-qm", "init")
    git(repo, "checkout", "-qb", "side")
    b.write_text(B_PY.replace("return 1", "return 2"))
    git(repo, "commit", "-qam", "side change")
    git(repo, "checkout", "-q", "main")
    b.write_text(B_PY.replace("return x", "return x + 1"))  # line 10, inside second()
    git(repo, "commit", "-qam", "feat: x (n8n parity 01)")
    git(repo, "merge", "-q", "--no-ff", "--no-commit", "side")
    b.write_text(B_PY.replace("return 1", "return 3").replace("return x", "return x + 1"))  # an evil merge touching first()
    git(repo, "commit", "-qam", "merge: y (n8n parity 01)")

    assert link.commit_links(repo, code_nodes(), TAGS) == [{
        "src": "ctx:.scratch/n8n-parity:ticket-01", "dst": "code:src_b_second", "relation": "implemented_in",
        "confidence": "EXTRACTED", "score": 1.0, "origin": "commit"}]
    pid = project_id(repo)

    async def go(s):
        await build.build(s, None, repo, embed=False)
        on = await edges_of(s, pid, "commit")
        await build.build(s, None, repo, commits=False, embed=False)
        return on, await edges_of(s, pid, "commit"), await edges_of(s, pid, "parser")

    on, off, parser = in_store(go)
    assert [(e["src"], e["dst"]) for e in on] == [("ctx:.scratch/n8n-parity:ticket-01", "code:src_b_second")]
    assert off == []
    assert ("ctx:specs/009-demo:T001", "code:src_b_second", "implemented_in") in [(e["src"], e["dst"], e["relation"]) for e in parser]


def test_inferred_links_and_review(tmp_path, in_store, scratch, monkeypatch):
    repo = make_repo(tmp_path)
    pid = project_id(repo)
    fr, retry = "ctx:specs/009-demo:FR-001", "code:src_a_retry"
    monkeypatch.chdir(repo)
    monkeypatch.setattr(cli, "Store", SimpleNamespace(open=lambda dsn, pool_max=1: Store.open(dsn, scratch[1], pool_max=pool_max)))

    def confirm(*args):
        return CliRunner().invoke(cli.app, ["graph", "confirm", *args])

    async def run_build(s):
        return await build.build(s, FakeEmbedder(), repo)

    r = in_store(run_build)
    inferred = in_store(lambda s: edges_of(s, pid, "embed"))
    assert [(e["src"], e["dst"], e["relation"], e["confidence"]) for e in inferred] == [(fr, retry, "implemented_in", "INFERRED")]
    assert abs(inferred[0]["score"] - 0.9) < 1e-3
    assert r["summary"]["by_feature"]["specs/009-demo"]["requirements"] == 1
    assert r["links"] == {"extracted": 1, "inferred": 1, "confirmed": 0, "unresolved": 1}  # T001 -> second(); missing.py
    assert r["tasks_linked"] == 0.5 and r["info"]["embedded"] > 0

    kept = confirm(fr, retry, "implemented_in", "keep")
    assert kept.exit_code == 0 and "kept" in kept.output
    assert confirm(fr, "code:src_b_first", "implemented_in", "keep").exit_code == 1  # no such edge
    in_store(run_build)  # a rebuild keeps the review
    assert [(e["confidence"], e["origin"]) for e in in_store(lambda s: edges_of(s, pid)) if e["src"] == fr] == [("CONFIRMED", "review")]

    dropped = confirm(fr, retry, "implemented_in", "drop")
    assert dropped.exit_code == 0 and "dropped" in dropped.output
    in_store(run_build)
    assert [(e["confidence"], e["origin"]) for e in in_store(lambda s: edges_of(s, pid)) if e["src"] == fr] == [("DROPPED", "review")]
    g = in_store(lambda s: core.load(s, "local", pid))
    assert retry not in [d for d, *_ in g.out.get(fr, [])] and fr in g.nodes


def test_tick_confirms_session_edits(tmp_path, in_store, monkeypatch):
    repo = make_repo(tmp_path)
    pid = project_id(repo)
    monkeypatch.setattr(build, "Embedder", lambda *a: FakeEmbedder())

    async def no_redis(*a):
        return False

    def payload(task):
        return {"cwd": str(repo), "tick": {"session_id": "s1", "file": "specs/009-demo/tasks.md", "tasks": [task]}}

    async def go(s):
        st = SimpleNamespace(store=s, cfg={**cfg(), "mode": "local"}, cache=SimpleNamespace(enqueue=no_redis), graphs={})
        await s.execute("insert into projects (id, name, path) values (%s, %s, %s)", (pid, f"demo-{pid}", str(repo)))
        await s.execute("insert into sessions (id, project_id) values ('s1', %s)", (pid,))
        for p in ({"tool": "Edit", "file_path": "src/a.py"}, {"tool": "Read", "file_path": "src/b.py"},
                  {"tool": "Edit", "file_path": "specs/009-demo/tasks.md"}):
            await s.execute("insert into events (session_id, type, payload) values ('s1', 'tool', %s)", (Jsonb(p),))
        first = await build.run_job(st, payload("T001"), None)
        second = await build.run_job(st, payload("T002"), None)  # no edits since the last tick
        ticks = await s.fetch("select payload from events where session_id = 's1' and type = 'graph_tick' order by id")
        with pytest.raises(RuntimeError):  # shared mode: cwd would name a path on the server's disk
            await build.run_job(SimpleNamespace(**{**vars(st), "cfg": {**st.cfg, "mode": "shared"}}), payload("T001"), None)
        return first, second, ticks, await edges_of(s, pid, "session")

    first, second, ticks, session = in_store(go)
    assert [(e["src"], e["dst"], e["relation"], e["confidence"]) for e in session] == [
        ("ctx:specs/009-demo:T001", "code:src_a", "implemented_in", "CONFIRMED")]
    assert (first["ticked"], second["ticked"]) == (1, 0)
    assert [t["payload"]["tasks"] for t in ticks] == [["T001"], ["T002"]]


OBS = {"id": 7, "type": "decision", "title": "t", "subtitle": "s", "narrative": "n", "facts": "[\"f1\"]",
       "files_read": "[]", "files_modified": "[\"src/a.py\"]", "created_at": "2026-10-26T00:00:00Z"}


def test_claude_mem(tmp_path, in_store, monkeypatch):
    repo = make_repo(tmp_path)
    pid = project_id(repo)
    nodes, edges = claudemem.to_graph([OBS, {**OBS, "id": 8, "type": "change"}, {**OBS, "id": 9, "files_modified": ["/x/y.py"]}])
    assert [n["id"] for n in nodes] == ["ctx:claude-mem:obs-7", "ctx:claude-mem:obs-9"]
    assert nodes[0]["type"] == "observation" and nodes[0]["meta"]["obs_type"] == "decision" and "f1" in nodes[0]["text"]
    assert {(e["src"], e["dst"], e["relation"], e["origin"]) for e in edges} == {
        ("ctx:claude-mem:obs-7", "file:src/a.py", "mentions", "claude-mem"), ("ctx:claude-mem:obs-9", "file:/x/y.py", "mentions", "claude-mem")}

    seen = []

    def up(req):
        assert req.method == "GET" and req.url.path == "/api/observations"
        seen.append(dict(req.url.params))
        return httpx.Response(200, json={"items": [OBS]})

    def down(req):
        raise httpx.ConnectError("refused", request=req)

    async def go(s):
        mock_mem(monkeypatch, up)
        a = await build.build(s, None, repo, embed=False)
        b = await build.build(s, None, repo, embed=False)  # incremental: id 7 already read
        mock_mem(monkeypatch, down)
        c = await build.build(s, None, repo, embed=False)
        node = await s.fetchrow("select type, meta from graph_nodes where project_id = %s and id = 'ctx:claude-mem:obs-7'", (pid,))
        return a, b, c, node, await edges_of(s, pid, "claude-mem"), await db.get_source(s, "local", pid, "claude-mem")

    a, b, c, node, mem_edges, src = in_store(go)
    assert seen[0]["limit"] == "200" and seen[0]["project"]
    assert (a["info"]["claude_mem"], b["info"]["claude_mem"], c["info"]["claude_mem"]) == ("1 new", "0 new", "down")
    assert node == {"type": "observation", "meta": {"obs_type": "decision"}}
    assert [(e["dst"], e["relation"], e["confidence"]) for e in mem_edges] == [("code:src_a", "mentions", "EXTRACTED")]
    assert src["version"] == "7"
