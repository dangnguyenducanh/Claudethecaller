"""Notify hook (spec FR-020, US3): one shell command per run status change to failed, waiting, quota or done, with the
run in env; a failing or hanging command never changes the run.

DB-free cases call ctc.runner.notify.fire on a fake run; engine-seam cases (tests/conftest.py, skip when
CTC_DATABASE_URL is unset or Supabase) walk real runs and count the calls.
Run: `CTC_DATABASE_URL=<scratch> uv run pytest -q tests/test_notify_hook.py`.
"""

import json
import time
from types import SimpleNamespace

import pytest
import yaml

from ctc.config import cfg
from ctc.runner import engine, graph, notify


def dump(path) -> str:
    """The notify command: one JSON line of its CTC_RUN* and ANTHROPIC* env per call."""
    return ("python3 -c \"import json,os; print(json.dumps({k: v for k, v in os.environ.items()"
            f" if k.startswith(('CTC_RUN', 'ANTHROPIC'))}}))\" >> {path}")


def calls(path, n: int, settle: float = 0.5) -> list[dict]:
    """Wait up to 5 s for n lines, then settle (a late extra call would show), and return them parsed."""
    end = time.monotonic() + 5
    while time.monotonic() < end and (not path.exists() or len(path.read_text().splitlines()) < n):
        time.sleep(0.05)
    time.sleep(settle)
    return [json.loads(ln) for ln in path.read_text().splitlines()] if path.exists() else []


@pytest.fixture
def hook(tmp_path, monkeypatch):
    """The daemon-wide notify command writes to tmp/calls.jsonl; notify logs go to tmp/runs."""
    monkeypatch.setitem(cfg()["runner"], "notify", dump(tmp_path / "calls.jsonl"))
    monkeypatch.setattr("ctc.runner.notify.RUNS", tmp_path / "runs")
    return tmp_path


RUN = {"id": 7, "workflow": "p:wf", "graph": {"nodes": [], "edges": []}}


def test_fire_done_sets_run_env(hook, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("CTC_RUN", "99")  # e.g. pytest inside a run's shell node: the notify must not look like a node
    notify.fire(RUN, "done", None).join(5)
    assert calls(hook / "calls.jsonl", 1) == [{
        "CTC_RUN_ID": "7", "CTC_RUN_STATUS": "done", "CTC_RUN_WORKFLOW": "p:wf",
        "CTC_RUN_URL": f"http://127.0.0.1:{cfg()['port']}/#run/7", "CTC_RUN_ERROR": ""}]


@pytest.mark.parametrize("status", ["cancelled", "queued", "running"])
def test_fire_ignores_non_events(hook, status):
    assert notify.fire(RUN, status, None) is None  # no thread: nothing can write later
    assert not (hook / "runs").exists()


def test_fire_without_a_command_does_nothing(hook, monkeypatch):
    monkeypatch.setitem(cfg()["runner"], "notify", "")
    assert notify.fire(RUN, "failed", "boom") is None
    assert not (hook / "runs").exists()


def test_workflow_settings_notify_overrides_runner_notify(hook):
    mine = hook / "mine.jsonl"
    notify.fire(RUN | {"graph": {"settings": {"notify": dump(mine)}}}, "waiting", None).join(5)
    assert [c["CTC_RUN_STATUS"] for c in calls(mine, 1)] == ["waiting"]
    assert not (hook / "calls.jsonl").exists()
    assert notify.fire(RUN | {"graph": {"settings": {"notify": ""}}}, "done", None) is None  # "" = off for this workflow


def test_failing_command_is_logged_not_raised(hook):
    notify.fire(RUN, "failed", "x" * 5000).join(5)
    notify.fire(RUN | {"graph": {"settings": {"notify": "echo hello-notify; exit 1"}}}, "failed", "boom").join(5)
    log = (hook / "runs" / "7" / "notify.log").read_text()
    assert "hello-notify" in log and "exit 1" in log
    assert len(calls(hook / "calls.jsonl", 1)[0]["CTC_RUN_ERROR"]) == 4096


def test_hanging_command_is_killed_at_the_timeout(hook, monkeypatch):
    monkeypatch.setattr(notify, "TIMEOUT_S", 0.5)
    late = hook / "late"
    t = notify.fire(RUN | {"graph": {"settings": {"notify": f"sleep 3; echo late >> {late}"}}}, "done", None)
    t.join(2)
    assert not t.is_alive()
    assert "timeout after 0.5 s" in (hook / "runs" / "7" / "notify.log").read_text()
    time.sleep(3)
    assert not late.exists()  # the whole process group was killed, not just bash


# ---- engine seam: one call per committed transition ----------------------------------------------------------------

def wf(name: str, node: str, settings: str = "") -> str:
    return f"name: {name}\n{settings}nodes:\n- {{id: start, type: trigger}}\n- {node}\nedges:\n- {{from: start, to: x}}\n"


OK = wf("ok", "{id: x, type: shell, command: 'true'}")


def one(path, status: str, run: dict) -> dict:
    [c] = calls(path, 1)
    assert (c["CTC_RUN_STATUS"], c["CTC_RUN_ID"], c["CTC_RUN_WORKFLOW"]) == (status, str(run["id"]), run["workflow"])
    return c


def test_engine_done_fires_once(hook, run_yaml):
    run, _ = run_yaml(OK)
    assert run["status"] == "done"
    assert one(hook / "calls.jsonl", "done", run)["CTC_RUN_ERROR"] == ""


def test_engine_failed_fires_once(hook, run_yaml):
    run, _ = run_yaml(wf("slow", "{id: x, type: shell, command: 'sleep 5', timeout_s: 1}"))
    assert run["status"] == "failed"
    assert "timed out" in one(hook / "calls.jsonl", "failed", run)["CTC_RUN_ERROR"]


def test_engine_waiting_then_approved_done(hook, run_yaml, in_store, walk_run):
    run, _ = run_yaml(wf("gate", "{id: x, type: approval, message: 'ok?'}"))
    assert run["status"] == "waiting"
    one(hook / "calls.jsonl", "waiting", run)

    async def ok(st):
        return await engine.approve(st, run["id"], await engine.owner(), True, None)
    assert in_store(ok)  # -> queued: not an event
    assert walk_run(run["id"])[0]["status"] == "done"  # approved with nothing left to run
    assert [c["CTC_RUN_STATUS"] for c in calls(hook / "calls.jsonl", 2)] == ["waiting", "done"]


def test_engine_quota_fires_once_and_the_gate_too(hook, run_yaml):
    run, _ = run_yaml(wf("q", "{id: x, type: agent, prompt: hi}"), claude_script="scripts/fake_claude_quota.sh")
    assert run["status"] == "quota"
    assert "limit" in one(hook / "calls.jsonl", "quota", run)["CTC_RUN_ERROR"]
    gated, _ = run_yaml(OK)  # the owner's usage window is still closed: parked at the claim, no spawn
    assert gated["status"] == "quota"
    c = calls(hook / "calls.jsonl", 2)
    assert len(c) == 2 and c[1]["CTC_RUN_STATUS"] == "quota" and c[1]["CTC_RUN_ID"] == str(gated["id"])
    assert c[1]["CTC_RUN_ERROR"].startswith("usage limit: waiting for the reset at")


@pytest.mark.parametrize("cmd", ["echo nope; exit 1", "sleep 5"])
def test_engine_bad_notify_leaves_the_run_done(hook, run_yaml, in_store, monkeypatch, cmd):
    monkeypatch.setitem(cfg()["runner"], "notify", cmd)
    monkeypatch.setattr(notify, "TIMEOUT_S", 1)
    run, _ = run_yaml(OK)
    log = hook / "runs" / str(run["id"]) / "notify.log"
    end = time.monotonic() + 5
    while time.monotonic() < end and not (log.exists() and ("exit 1" in log.read_text() or "timeout" in log.read_text())):
        time.sleep(0.05)
    assert "exit 1" in log.read_text() or "timeout after 1 s" in log.read_text()

    async def status(st):
        return await st.store.fetchval("select status from wf_runs where id = %s", (run["id"],))
    assert in_store(status) == "done"


def test_engine_without_notify_changes_nothing(run_yaml, tmp_path, monkeypatch):
    monkeypatch.setattr(notify, "RUNS", tmp_path / "runs")  # the shipped config: runner.notify ""
    run, _ = run_yaml(OK)
    assert run["status"] == "done"
    time.sleep(0.5)
    assert not (tmp_path / "runs" / str(run["id"]) / "notify.log").exists()


def test_engine_workflow_settings_notify_wins(hook, run_yaml):
    mine = hook / "mine.jsonl"
    run, _ = run_yaml(wf("own", "{id: x, type: shell, command: 'true'}", f"settings: {{notify: {json.dumps(dump(mine))}}}\n"))
    one(mine, "done", run)
    assert not (hook / "calls.jsonl").exists()


def test_sweep_fails_a_stranded_run_once(hook, seam, in_store):
    g = graph.load(yaml.safe_load(OK))

    async def strand(st):  # claimed, never executed: what a daemon crash leaves
        rid = await engine.submit(st, await engine.owner(), "test:ok", g, "sha", str(seam.repo), None, "cli", "")
        assert await engine.claim(st, rid)
        await engine.sweep(st)
        await engine.sweep(st)  # nothing left running: no second call
        return await st.store.fetchrow("select * from wf_runs where id = %s", (rid,))
    run = in_store(strand)
    assert run["status"] == "failed"
    assert one(hook / "calls.jsonl", "failed", run)["CTC_RUN_ERROR"] == "daemon stopped mid-run"


# ---- editor save keeps a hand-written settings.notify ----------------------------------------------------------------

def test_editor_save_keeps_settings_notify(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from ctc.server import library

    wf_path = tmp_path / "ctc-workflows" / "demo.yaml"
    wf_path.parent.mkdir()
    wf_path.write_text(yaml.safe_dump({"name": "demo", "settings": {"permission": "worktree", "notify": "echo hi"},
                                       "nodes": [{"id": "start", "type": "trigger"}], "edges": []}))
    app = FastAPI()
    app.include_router(library.router)
    app.state.st = SimpleNamespace(cfg={"mode": "local", "claude_home": str(tmp_path)}, store=SimpleNamespace(catalog={
        "user:demo": {"id": "user:demo", "path": str(wf_path), "kind": "workflow", "namespace": "user"}}))

    async def reindex(*a):
        pass

    async def cap(st, u, cap_id, pid=None):
        return {"id": cap_id, "kind": "workflow", "namespace": "user", "description": "", "override": None,
                "calls_30d": 0, "followed_30d": 0, "cluster_id": None}
    monkeypatch.setattr(library, "_reindex", reindex)
    monkeypatch.setattr(library, "_cap", cap)
    r = TestClient(app).patch("/api/capabilities/user:demo", json={
        "graph": {"nodes": [{"id": "start", "type": "trigger"}, {"id": "x", "type": "shell", "command": "true"}],
                  "edges": [{"from": "start", "to": "x"}]},
        "settings": {"permission": "worktree", "allow_extra_usage": True, "auto_resume": True, "max_run_tokens": None}})
    assert r.status_code == 200, r.text
    s = yaml.safe_load(wf_path.read_text())["settings"]
    assert s["notify"] == "echo hi" and s["allow_extra_usage"] is True  # the editor's fields still win
