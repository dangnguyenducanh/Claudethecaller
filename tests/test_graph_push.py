"""m6 G6: the prompt line and the PreToolUse file note over a synthetic RAM graph (core.load with db.load_rows stubbed),
both hooks through ASGI, decision.graph_line in the writer, and the PreToolUse group in `ctc install` (temp home)."""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from ctc import cli
from ctc.config import cfg
from ctc.decision.bundle import Bundle, Step, suggestion_line
from ctc.graph import core, db, push
from ctc.ingestion.scanner import project_id
from ctc.server import hooks, writer

S = "ctx:specs/009-demo"
DEC = "Never re-run a side effect that already succeeded once in the same run, whatever the retry mode says"


def _n(id, kind, type, label, file, line, **meta):
    return {"id": id, "kind": kind, "type": type, "label": label, "text": "", "source_file": file, "source_line": line,
            "origin": "parser" if kind == "context" else "graphify", "meta": meta}


def _e(src, dst, relation, confidence="EXTRACTED", score=1.0):
    return {"src": src, "dst": dst, "relation": relation, "confidence": confidence, "score": score}


def _v(*xs):
    v = np.zeros(8, np.float32)
    v[:len(xs)] = xs
    return v / np.linalg.norm(v)


NODES = [
    _n(f"{S}:US1", "context", "story", "Retry a failed run", "specs/009-demo/spec.md", 10, priority="P1"),
    _n(f"{S}:T012", "context", "task", "Retry a run from the failed node", "specs/009-demo/tasks.md", 20, story="US1"),
    _n(f"{S}:T013", "context", "task", "Write the retry docs", "specs/009-demo/tasks.md", 21, story="US1"),
    _n(f"{S}:T014", "context", "task", "Claim queued nodes", "specs/009-demo/tasks.md", 22, story=None),
    _n(f"{S}:FR-001", "context", "requirement", "The system MUST retry from a node", "specs/009-demo/spec.md", 30),
    _n("ctx:CLAUDE:decision:2026-10-20:1", "context", "decision", DEC, "CLAUDE.md", 5),
    _n("code:x_retry", "coding", "code", "retry()", "src/x.py", 10),
    _n("code:x_claim", "coding", "code", "claim()", "src/x.py", 20),
    _n("code:y_run", "coding", "code", "run()", "src/y.py", 5),
    _n("code:z_old", "coding", "code", "old()", "src/z.py", 7),
]
EDGES = [  # pointers deliberately out of rank order
    _e(f"{S}:T012", "code:z_old", "implemented_in", "INFERRED", 0.5),
    _e(f"{S}:T012", "code:x_retry", "implemented_in", "INFERRED", 0.8),
    _e(f"{S}:T012", "code:x_claim", "implemented_in"),
    _e(f"{S}:T012", "code:y_run", "tested_by", "CONFIRMED"),
    _e(f"{S}:T012", f"{S}:US1", "serves"),
    _e(f"{S}:T013", f"{S}:US1", "serves"),
    _e("ctx:CLAUDE:decision:2026-10-20:1", f"{S}:T012", "constrains", "INFERRED"),
    _e(f"{S}:US1", "code:x_retry", "mentions"),
    _e(f"{S}:T014", "code:x_retry", "implemented_in"),
    _e(f"{S}:FR-001", "code:x_claim", "implemented_in", "INFERRED", 0.7),
]
PAIRS = [(f"{S}:T013", _v(1)), (f"{S}:T012", _v(0.9, 0.436)), (f"{S}:US1", _v(0, 0, 1)), (f"{S}:FR-001", _v(0, 0, 0, 1)),
         (f"{S}:T014", _v(0, 0, 0, 0, 1)), ("ctx:CLAUDE:decision:2026-10-20:1", _v(1))]
CLOSE, FAR = _v(1), _v(0, 0, 0, 0, 0, 0, 0, 1)
C = cfg()
LINE = (f"ctc graph: T012 [US1] Retry a run from the failed node → src/y.py:5 run(), src/x.py:20 claim(), "
        f"src/x.py:10 retry() · decision: {DEC[:59]}…")


@pytest.fixture
def g(monkeypatch):
    async def rows(store, user_id, project_id):
        return [dict(n) for n in NODES], EDGES, PAIRS

    async def version(sql, args):
        return "v1"

    monkeypatch.setattr(db, "load_rows", rows)
    return asyncio.run(core.load(SimpleNamespace(fetchval=version), "local", "p"))


def test_config_block():
    assert set(C["graph_push"]) >= {"floor", "max_pointers", "max_chars", "note_max"}
    assert (C["graph_push"]["max_pointers"], C["graph_push"]["max_chars"], C["graph_push"]["note_max"]) == (3, 400, 3)


def test_prompt_line(g):
    line = push.prompt_line(g, CLOSE, C)  # T013 is nearest but has no code: skipped for T012 (cos 0.9)
    assert line == LINE and len(line) <= C["graph_push"]["max_chars"]
    assert push.prompt_line(g, FAR, C) == ""  # every context node under the floor
    short = push.prompt_line(g, CLOSE, {"graph_push": {**C["graph_push"], "max_chars": 100}})
    assert len(short) == 100 and short.endswith("…") and short.startswith("ctc graph: T012 [US1]")


def test_file_note(g):
    # T012, T014, FR-001 and US1 link to src/x.py: tasks then requirements, cap 3; the decision constraining T012
    assert push.file_note(g, "src/x.py", C) == f"ctc graph: src/x.py implements T012 [US1], T014; FR-001 · decision: {DEC[:59]}…"
    assert push.file_note(g, "src/y.py", C) == f"ctc graph: src/y.py implements T012 [US1] · decision: {DEC[:59]}…"
    assert push.file_note(g, "src/none.py", C) == ""
    assert push.file_note(g, "specs/009-demo/tasks.md", C) == ""  # nodes written in a file are not linked to it


# ---- hooks through ASGI ---------------------------------------------------------------------------------------------

def _app(st):
    app = FastAPI()
    app.include_router(hooks.router)
    app.state.ctc = st
    return TestClient(app)


def _pre(c, cwd, path, tool="Read"):
    r = c.post("/v1/hook/pre", content=json.dumps({"session_id": "s1", "cwd": cwd, "tool_name": tool,
                                                     "tool_input": {"file_path": path}}))
    assert r.status_code == 200
    return r


def test_hook_pre(g, tmp_path, monkeypatch):
    run = str(Path.home() / ".claudethecaller/extract/x")
    st = SimpleNamespace(cfg=C, graphs={("local", project_id(d)): g for d in (str(tmp_path), run)})
    c = _app(st)
    r = _pre(c, str(tmp_path), f"{tmp_path}/src/x.py")
    assert r.json() == {"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                               "additionalContext": push.file_note(g, "src/x.py", C)}}
    assert "permissionDecision" not in r.text and r.headers["content-type"] == "application/json"
    assert _pre(c, str(tmp_path), f"{tmp_path}/src/none.py", "Edit").content == b""  # nothing links
    assert _pre(c, run, f"{run}/src/x.py").content == b""  # the extractor's own claude

    def boom(*a, **k):
        raise RuntimeError("no graph")

    monkeypatch.setattr(core, "graph_for", boom)
    assert _pre(c, str(tmp_path), f"{tmp_path}/src/x.py").content == b""


def test_hook_prompt_adds_graph_line(g, tmp_path, monkeypatch):
    b = Bundle(ref="abcd1234", intent="retry", abstained=False,
               steps=[Step(order=1, cap_id="skill:retry", invoke="/retry", kind="skill", reason="r")])
    rows = []

    async def route(st, prompt, sid, cwd, user_id="local", k=None):
        return b

    async def embed(st, texts):
        return [CLOSE for _ in texts]

    async def write(st, kind, row):
        rows.append((kind, row))

    monkeypatch.setattr(hooks, "route", route)
    monkeypatch.setattr(hooks, "_embed", embed)
    monkeypatch.setattr(hooks, "write", write)
    key = ("local", project_id(str(tmp_path)))
    st = SimpleNamespace(cfg=C, graphs={key: g}, names={key: "demo"})
    body = json.dumps({"prompt": "retry a failed run from a node", "session_id": "s1", "cwd": str(tmp_path)})
    r = _app(st).post("/v1/hook/prompt", content=body)
    assert r.text == suggestion_line(b) + "\n" + LINE
    assert [row["graph_line"] for kind, row in rows if kind == "decision"] == [LINE]

    async def none(*a, **k):
        return None

    rows.clear()
    monkeypatch.setattr(core, "graph_for", none)
    r = _app(st).post("/v1/hook/prompt", content=body)
    assert r.text == suggestion_line(b)
    assert [row["graph_line"] for kind, row in rows if kind == "decision"] == [None]


# ---- writer + install -----------------------------------------------------------------------------------------------

def test_writer_stores_graph_line(in_store, tmp_path):
    async def go(s):
        pid = project_id(tmp_path)
        await s.ensure_project(str(tmp_path), "local")
        row = {"session_id": "s-push", "project_id": pid, "ref": "r1", "prompt": "p", "abstained": False,
               "bundle": {}, "graph_line": LINE}
        await writer.apply(SimpleNamespace(store=s), [("decision", row), ("decision", {**row, "ref": "r2", "graph_line": None}),
                                                       ("decision", {k: v for k, v in row.items() if k != "graph_line"} | {"ref": "r3"})])
        return await s.fetch("select ref, graph_line from decisions where session_id = 's-push' order by ref", ())

    assert [(r["ref"], r["graph_line"]) for r in in_store(go)] == [("r1", LINE), ("r2", None), ("r3", None)]


def test_install_adds_pre_tool_use(tmp_path, monkeypatch):
    monkeypatch.setenv("CTC_CLAUDE_HOME", str(tmp_path))
    cfg.cache_clear()
    try:
        assert CliRunner().invoke(cli.app, ["install"]).exit_code == 0
        hs = json.loads((tmp_path / "settings.json").read_text())["hooks"]
        assert hs["PreToolUse"] == [{"matcher": "Read|Edit|Write|MultiEdit", "hooks": [{"type": "command", "command": (
            "LC_ALL=C curl -sf -m 0.05 --unix-socket $HOME/.claudethecaller/ctc.sock --data-binary @- "
            "http://ctc/v1/hook/pre || true")}]}]
        assert hs["PostToolUse"][0]["matcher"] == "*" and "matcher" not in hs["UserPromptSubmit"][0]
        assert CliRunner().invoke(cli.app, ["uninstall"]).exit_code == 0
        assert json.loads((tmp_path / "settings.json").read_text()) == {}
    finally:
        cfg.cache_clear()
