"""US12 (ticket 07): a scheduled run of a project workflow walks the file as committed at HEAD; enabling a schedule
validates the graph. Tmp git repos; the DB case runs only against a scratch Postgres (CTC_DATABASE_URL, never Supabase)."""

import asyncio
import hashlib
import logging
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException

from ctc.config import cfg
from ctc.ingestion.scanner import _make_capability, project_namespace
from ctc.runner import engine, schedule
from ctc.server import runs
from ctc.server.schemas import ScheduleSet
from ctc.storage.store import Store

V1 = "description: v1\nnodes:\n- {id: start, type: trigger}\nedges: []\n"
V2 = "description: v2\nnodes:\n- {id: start, type: trigger}\n- {id: go, type: shell, command: echo}\nedges: []\n"


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), "-c", "user.email=t@t", "-c", "user.name=t", *args], check=True, capture_output=True)


def _repo(root: Path, sub: str = "") -> tuple[Path, Path]:
    """(project dir, its workflow file path, not written yet); the git repo is root, the project root/sub."""
    root.mkdir(parents=True, exist_ok=True)
    _git(root, "init", "-q")
    proj = root / sub if sub else root
    f = proj / ".claude" / "ctc-workflows" / "w.yaml"
    f.parent.mkdir(parents=True)
    return proj, f


def _commit(repo: Path, f: Path, text: str) -> None:
    f.write_text(text)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "wf")


def test_committed_returns_head_version_not_the_edited_file(tmp_path):
    repo, f = _repo(tmp_path / "r")
    _commit(repo, f, V1)
    f.write_text(V2)
    g, sha = asyncio.run(schedule.committed(str(repo), str(f)))
    assert g["description"] == "v1" and [n["id"] for n in g["nodes"]] == ["start"] and g["edges"] == []
    assert sha == hashlib.sha256(V1.encode()).hexdigest()


def test_committed_ignores_staged_changes(tmp_path):
    repo, f = _repo(tmp_path / "r")
    _commit(repo, f, V1)
    f.write_text(V2)
    _git(repo, "add", "-A")
    assert asyncio.run(schedule.committed(str(repo), str(f)))[0]["description"] == "v1"


def test_committed_is_none_without_a_committed_version(tmp_path):
    repo, f = _repo(tmp_path / "empty")  # no commit at all: no HEAD
    f.write_text(V1)
    assert asyncio.run(schedule.committed(str(repo), str(f))) is None
    repo, f = _repo(tmp_path / "r")
    _commit(repo, repo / "README", "x")
    f.write_text(V1)  # a new workflow, never committed
    assert asyncio.run(schedule.committed(str(repo), str(f))) is None


def test_committed_resolves_a_project_below_the_git_top_level(tmp_path):
    proj, f = _repo(tmp_path / "top", "sub")
    _commit(tmp_path / "top", f, V1)
    f.write_text(V2)
    assert asyncio.run(schedule.committed(str(proj), str(f)))[1] == hashlib.sha256(V1.encode()).hexdigest()


def _st(cap_id: str, repo: Path, f: Path) -> SimpleNamespace:
    cap = {"kind": "workflow", "namespace": project_namespace(repo), "path": str(f)}
    return SimpleNamespace(store=SimpleNamespace(catalog={cap_id: cap}), cfg={"mode": "local"})


def test_submit_run_head_uses_the_committed_file_and_others_the_saved_one(tmp_path, monkeypatch):
    repo, f = _repo(tmp_path / "r")
    _commit(repo, f, V1)
    f.write_text(V2)
    got = []

    async def submit(st, o, w, g, sha, repo_, pid, trigger, text, pinned=False):
        got.append((g["description"], sha, trigger))
        return len(got)

    monkeypatch.setattr(engine, "submit", submit)
    st = _st("p:w", repo, f)
    asyncio.run(runs.submit_run(st, "local", "me@x", "p:w", "", None, "schedule", head=True))
    asyncio.run(runs.submit_run(st, "local", "me@x", "p:w", "", None, "api"))
    assert got == [("v1", hashlib.sha256(V1.encode()).hexdigest(), "schedule"),
                   ("v2", hashlib.sha256(V2.encode()).hexdigest(), "api")]


def test_submit_run_head_refuses_a_never_committed_workflow(tmp_path, monkeypatch):
    repo, f = _repo(tmp_path / "r")
    _commit(repo, repo / "README", "x")
    f.write_text(V1)

    async def submit(*a):
        raise AssertionError("no run for a never-committed workflow")

    monkeypatch.setattr(engine, "submit", submit)
    with pytest.raises(HTTPException) as e:
        asyncio.run(runs.submit_run(_st("p:w", repo, f), "local", "me@x", "p:w", "", None, "schedule", head=True))
    assert e.value.status_code == 422 and e.value.detail["code"] == "not_committed"


def test_enabling_a_schedule_validates_the_graph_and_disabling_does_not(tmp_path, monkeypatch):
    repo, f = _repo(tmp_path / "r")
    f.write_text("description: two\nnodes:\n- {id: a, type: trigger}\n- {id: b, type: trigger}\nedges: []\n")
    saved = []

    async def fetchrow(sql, params):
        saved.append(params)
        return {"workflow": "p:w", "cron": params[2], "input": params[3], "enabled": params[4], "last_fired_at": None}

    async def owner():
        return "me@x"

    monkeypatch.setattr(engine, "owner", owner)
    st = _st("p:w", repo, f)
    st.store.fetchrow = fetchrow
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(st=st)), state=SimpleNamespace(user_id="local"))
    with pytest.raises(HTTPException) as e:
        asyncio.run(runs.set_schedule("p:w", ScheduleSet(cron="0 9 * * *", enabled=True), request))
    assert e.value.status_code == 422 and e.value.detail["code"] == "invalid_graph"
    assert e.value.detail["message"] == "a workflow needs exactly one trigger, found 2" and saved == []
    r = asyncio.run(runs.set_schedule("p:w", ScheduleSet(cron="0 9 * * *", enabled=False), request))
    assert r["enabled"] is False and r["next_at"] is None and len(saved) == 1


DSN = os.environ.get("CTC_DATABASE_URL") or ""


@pytest.mark.skipif(not DSN or "supabase" in DSN, reason="needs a scratch Postgres in CTC_DATABASE_URL (never Supabase)")
def test_tick_fires_the_committed_version_and_skips_a_never_committed_one(tmp_path, monkeypatch, caplog):
    monkeypatch.setenv("CTC_IDLE_WAIT_MIN", "0")
    caplog.set_level(logging.INFO, logger="ctc.runner.schedule")
    repo, f = _repo(tmp_path / "r")
    _commit(repo, repo / "README", "x")
    f.write_text(V1)  # saved, never committed
    ns = project_namespace(repo)
    cap_id = f"{ns}:w"

    async def go():
        store = await Store.open(DSN, schema=f"ctc_sched_{uuid4().hex[:8]}")
        try:
            c = cfg()
            st = SimpleNamespace(store=store, cfg=c | {"mode": "local", "runner": c["runner"] | {"idle_wait_min": 0}})
            await store.upsert([_make_capability(f, "workflow", ns, "w")], [ns])
            await store.execute("insert into wf_schedules (owner, workflow, cron, input, enabled, last_fired_at)"
                                " values ('me@x', %s, '* * * * *', '', true, now() - interval '5 min')", (cap_id,))
            before = await store.fetchval("select last_fired_at from wf_schedules")
            await schedule.tick(st, "me@x")
            assert await store.fetchval("select count(*) from wf_runs") == 0
            assert await store.fetchval("select last_fired_at from wf_schedules") > before
            assert "not_committed" in caplog.text
            _commit(repo, f, V1)
            f.write_text(V2)
            await store.execute("update wf_schedules set last_fired_at = now() - interval '5 min'")
            await schedule.tick(st, "me@x")
            return await store.fetch("select trigger, graph, file_sha from wf_runs")
        finally:
            await store.execute(f"drop schema {store.schema} cascade")
            await store.close()

    [r] = asyncio.run(go())
    assert r["trigger"] == "schedule" and r["graph"]["description"] == "v1"
    assert r["file_sha"] == hashlib.sha256(V1.encode()).hexdigest()
