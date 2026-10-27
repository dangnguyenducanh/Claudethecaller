"""m7 O4: POST /v1/hook/start (the SessionStart context) through ASGI over a stub State, and the SessionStart group in
`ctc install` / `uninstall` over a temp Claude home. No DB, no Redis, no model."""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from ctc import cli
from ctc.config import cfg
from ctc.ingestion.scanner import project_id
from ctc.memory import observations
from ctc.server import hooks

CWD = "/home/dev/proj"
PID = project_id(CWD)
ROW = {"item_type": "observation", "id": 7, "project": "demo", "session_id": "s1", "prompt_number": 1, "type": "discovery",
       "title": "Daemon waits 140ms", "subtitle": "", "narrative": "", "facts": [], "concepts": [], "files_read": [],
       "files_modified": [], "discovery_tokens": 1000, "created_at": "2026-10-26T12:00:30Z", "deleted_at": None}
BODY = observations.render_context([ROW], [], "demo")
EMPTY = observations.render_context([], [], "demo")  # a project without memory: the welcome text, no Stats line
LINK = f"http://127.0.0.1:{cfg()['port']}/#memories"


def _st(body=BODY, enabled=True, skip=()):
    keys = []

    class Cache:
        async def get_json(self, key):
            keys.append(key)
            return body

    c = {**cfg(), "memory": {**cfg()["memory"], "enabled": enabled}, "history": {**cfg()["history"], "skip_projects": list(skip)}}
    return SimpleNamespace(cfg=c, cache=Cache(), names={("local", PID): "demo"}, keys=keys)


def _start(st, **body):
    app = FastAPI()
    app.include_router(hooks.router)
    app.state.ctc = st
    r = TestClient(app).post("/v1/hook/start", content=json.dumps(
        {"session_id": "s1", "cwd": CWD, "hook_event_name": "SessionStart", "source": "startup", **body}))
    assert r.status_code == 200
    return r


def test_start_returns_context_and_message(monkeypatch):
    async def no(*a, **k):
        raise AssertionError("a SessionStart hook creates no rows and queues no jobs")

    monkeypatch.setattr(hooks, "submit", no)
    st = _st()
    j = _start(st).json()
    ctx = j["hookSpecificOutput"]
    assert ctx["hookEventName"] == "SessionStart"
    assert ctx["additionalContext"].startswith("<ctc-memory-context>\n# [demo] recent context, ")
    assert ctx["additionalContext"].endswith("\n</ctc-memory-context>") and "Daemon waits 140ms" in ctx["additionalContext"]
    assert j["systemMessage"] == f"ctc memory: 1 observations · {LINK}"
    assert st.keys == [f"ctx:local:{PID}"]


def test_start_name_falls_back_to_folder():
    st = _st()
    st.names.clear()
    assert "# [proj] recent context, " in _start(st).json()["hookSpecificOutput"]["additionalContext"]


def test_start_project_without_memory_has_no_system_message():
    j = _start(_st(EMPTY)).json()
    assert j["hookSpecificOutput"]["hookEventName"] == "SessionStart" and "no memory yet" in j["hookSpecificOutput"]["additionalContext"]
    assert "systemMessage" not in j


def test_start_cache_miss_renders_once(monkeypatch):
    async def refresh(st, user_id, project_id):
        return BODY

    monkeypatch.setattr(observations, "refresh_context", refresh)
    assert "Daemon waits 140ms" in _start(_st(None)).json()["hookSpecificOutput"]["additionalContext"]


def test_start_skips_are_empty_200_without_touching_the_cache():
    runs = str(Path(cfg()["graph_extract"]["dir"]).expanduser() / "x")
    for st, body in [(_st(enabled=False), {}), (_st(), {"source": "resume"}), (_st(skip=["demo"]), {}), (_st(skip=["proj"]), {}),
                     (_st(), {"cwd": runs})]:
        r = _start(st, **body)
        assert r.content == b"" and st.keys == [], body
    assert _start(_st(), source="clear").content and _start(_st(), source="compact").content


def test_start_fails_open(monkeypatch):
    async def boom(*a):
        raise RuntimeError("redis and db are both down")

    async def slow(*a):
        await asyncio.sleep(1)

    monkeypatch.setattr(observations, "context_text", boom)
    assert _start(_st()).content == b""
    monkeypatch.setattr(observations, "context_text", slow)
    monkeypatch.setattr(hooks, "START_BUDGET_S", 0.01)
    assert _start(_st()).content == b""


def _ours(event, route, t):
    cmd = f"LC_ALL=C curl -sf -m {t} --unix-socket $HOME/.claudethecaller/ctc.sock --data-binary @- http://ctc/v1/hook/{route} || true"
    return [{**({"matcher": cli.MATCHERS[event]} if event in cli.MATCHERS else {}), "hooks": [{"type": "command", "command": cmd}]}]


def test_install_adds_session_start_and_uninstall_removes_it(tmp_path, monkeypatch):
    monkeypatch.setenv("CTC_CLAUDE_HOME", str(tmp_path))
    cfg.cache_clear()  # without this the test would rewrite the owner's real ~/.claude/settings.json
    try:
        assert cfg()["claude_home"] == str(tmp_path)
        foreign = {"Notification": [{"hooks": [{"type": "command", "command": "echo mine"}]}]}
        pre = {"theme": "dark", "hooks": {**foreign, **{e: _ours(e, r, t) for e, (r, t) in cli.HOOKS.items() if e != "SessionStart"}}}
        (tmp_path / "settings.json").write_text(json.dumps(pre))
        assert CliRunner().invoke(cli.app, ["install"]).exit_code == 0
        now = json.loads((tmp_path / "settings.json").read_text())
        start = [{"matcher": "startup|clear|compact", "hooks": [{"type": "command", "command": (
            "LC_ALL=C curl -sf -m 1 --unix-socket $HOME/.claudethecaller/ctc.sock --data-binary @- http://ctc/v1/hook/start || true")}]}]
        assert now == {**pre, "hooks": {**pre["hooks"], "SessionStart": start}}
        assert CliRunner().invoke(cli.app, ["uninstall"]).exit_code == 0
        assert json.loads((tmp_path / "settings.json").read_text()) == {"theme": "dark", "hooks": foreign}
    finally:
        cfg.cache_clear()
