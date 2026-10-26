"""Planned stop (spec FR-015, US9), simulated in-process with ctc.runner.engine.stop_runner: the running batch lands
within the grace and the run goes back to `queued` with its walker state; a batch past the grace is killed and the run
fails as today; a hard crash (sweep) keeps 'daemon stopped mid-run'.

Engine-seam cases (tests/conftest.py, skip when CTC_DATABASE_URL is unset or Supabase), each inside one event loop.
Run: `CTC_DATABASE_URL=<scratch> uv run pytest -q tests/test_graceful_shutdown.py`.
"""

import asyncio
import hashlib
import time
from pathlib import Path

import pytest
import yaml

from ctc.runner import engine, graph


@pytest.fixture(autouse=True)
def stopping(monkeypatch):
    """A fresh STOPPING per test (in_store gives each loop a fresh WAKE): a set event must not leak into the next."""
    monkeypatch.setattr(engine, "STOPPING", asyncio.Event())


async def submit(st, seam, text: str) -> int:
    g = graph.load(yaml.safe_load(text))
    assert graph.validate(g) == [], graph.validate(g)
    return await engine.submit(st, await engine.owner(), f"test:{g['name']}", g, hashlib.sha256(text.encode()).hexdigest(),
                               str(seam.repo), None, "cli", "")


async def wait_step(st, rid: int, node: str, status: str, timeout: float = 10) -> None:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if await st.store.fetchval("select 1 from wf_steps where run_id = %s and node_id = %s and status = %s",
                                   (rid, node, status)):
            return
        await asyncio.sleep(0.05)
    raise AssertionError(f"{node} never {status}")


async def rows(st, rid: int):
    return (await st.store.fetchrow("select * from wf_runs where id = %s", (rid,)),
            await st.store.fetch("select * from wf_steps where run_id = %s order by id", (rid,)))


def test_stop_between_batches_resumes_without_rerunning(seam, in_store):
    mark = seam.tmp / "mark"
    text = (f"name: two\nnodes:\n- {{id: start, type: trigger}}\n"
            f"- {{id: a, type: shell, command: 'sleep 2; echo a >> {mark}', timeout_s: 30}}\n"
            f"- {{id: b, type: shell, command: 'echo b >> {mark}'}}\n"
            "edges:\n- {from: start, to: a}\n- {from: a, to: b}\n")

    async def go(st):
        rid = await submit(st, seam, text)
        task = asyncio.create_task(engine.run_runner(st))  # the daemon's runner claims it
        await wait_step(st, rid, "a", "running")
        run = await st.store.fetchrow("select * from wf_runs where id = %s", (rid,))
        t0 = time.monotonic()
        await engine.stop_runner(st, task, grace_s=15)
        assert time.monotonic() - t0 < 10 and task.done()  # a landed, the runner claimed nothing more
        r, steps = await rows(st, rid)
        assert r["status"] == "queued" and r["error"] is None
        assert r["state"] and (r["worktree"], r["branch"]) == (run["worktree"], run["branch"])
        assert [(s["node_id"], s["status"]) for s in steps] == [("start", "done"), ("a", "done")]  # no row for b
        engine.STOPPING.clear()  # the restart: the next daemon's runner claims it and walks on
        await engine.execute(st, await engine.claim(st, rid))
        return await rows(st, rid)

    r, steps = in_store(go)
    assert r["status"] == "done", r["error"]
    assert [(s["node_id"], s["visit"]) for s in steps] == [("start", 1), ("a", 1), ("b", 1)]
    assert mark.read_text() == "a\nb\n"  # no step ran twice


def node_procs(rid: int) -> list[str]:
    """pids whose environ holds CTC_RUN=<rid>: the same scan engine.kill_run uses."""
    tag, out = f"CTC_RUN={rid}".encode(), []
    for env in Path("/proc").glob("[0-9]*/environ"):
        try:
            if tag in env.read_bytes().split(b"\0"):
                out.append(env.parent.name)
        except OSError:
            pass
    return out


def test_batch_past_the_grace_is_killed_and_fails(seam, in_store):
    text = ("name: slow\nnodes:\n- {id: start, type: trigger}\n- {id: x, type: shell, command: 'sleep 60', timeout_s: 120}\n"
            "edges:\n- {from: start, to: x}\n")

    async def go(st):
        rid = await submit(st, seam, text)
        task = asyncio.create_task(engine.execute(st, await engine.claim(st, rid)))
        await wait_step(st, rid, "x", "running")
        t0 = time.monotonic()
        await engine.stop_runner(st, task, grace_s=1)
        assert time.monotonic() - t0 < 15 and task.done()
        return rid, *await rows(st, rid)

    rid, r, steps = in_store(go)
    assert (r["status"], r["error"]) == ("failed", "daemon stopped mid-run")
    assert [(s["node_id"], s["status"]) for s in steps] == [("start", "done"), ("x", "failed")]
    assert node_procs(rid) == []


def test_no_active_run_stops_at_once_and_changes_nothing(seam, in_store, run_yaml):
    waiting, _ = run_yaml("name: gate\nnodes:\n- {id: start, type: trigger}\n- {id: x, type: approval, message: 'ok?'}\n"
                          "edges:\n- {from: start, to: x}\n")
    quota, _ = run_yaml("name: q\nnodes:\n- {id: start, type: trigger}\n- {id: x, type: agent, prompt: hi}\n"
                        "edges:\n- {from: start, to: x}\n", claude_script="scripts/fake_claude_quota.sh")
    assert (waiting["status"], quota["status"]) == ("waiting", "quota")

    async def go(st):
        task = asyncio.create_task(engine.run_runner(st))
        await asyncio.sleep(0.5)  # startup sweep, requeue, tick, claim: then it idles on WAKE
        t0 = time.monotonic()
        await engine.stop_runner(st, task, grace_s=30)
        assert time.monotonic() - t0 < 3 and task.done()
        return [await st.store.fetchrow("select status, state from wf_runs where id = %s", (r["id"],)) for r in (waiting, quota)]

    w, q = in_store(go)
    assert (w["status"], w["state"]) == ("waiting", waiting["state"])
    assert (q["status"], q["state"]) == ("quota", quota["state"])


def test_hard_crash_keeps_failing_the_run(seam, in_store):
    text = "name: crash\nnodes:\n- {id: start, type: trigger}\n- {id: x, type: shell, command: 'true'}\nedges:\n- {from: start, to: x}\n"

    async def go(st):
        rid = await submit(st, seam, text)
        assert await engine.claim(st, rid)  # left `running` with no walker: the daemon died
        await engine.sweep(st)  # the next start
        return await st.store.fetchrow("select status, error from wf_runs where id = %s", (rid,))

    r = in_store(go)
    assert (r["status"], r["error"]) == ("failed", "daemon stopped mid-run")
