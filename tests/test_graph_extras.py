"""US13 (ticket 14) at the engine seam (tests/conftest.py): template roots in a real run, the stop node, and the
max_run_minutes / approval_timeout_minutes limits with tiny values. Skips when CTC_DATABASE_URL is unset or Supabase.
Run: `CTC_DATABASE_URL=<scratch> uv run pytest -q tests/test_graph_extras.py`."""

import time
from datetime import UTC, datetime

from ctc.runner import engine

ROOTS = """name: roots
vars: {greeting: hi}
nodes:
- {id: start, type: trigger}
- {id: roots, type: shell, command: 'echo {{run.id}} {{run.visit}} {{run.trigger}} {{vars.greeting}}'}
- {id: first, type: if, conditions: [{path: run.visit, op: eq, value: 1}, {path: vars.greeting, op: eq, value: hi}]}
- {id: clock, type: shell, command: 'echo {{now}}'}
- {id: never, type: shell, command: 'echo never'}
edges:
- {from: start, to: roots}
- {from: roots, to: first}
- {from: first, to: clock, handle: 'true'}
- {from: first, to: never, handle: 'false'}
"""


def by_node(steps) -> dict:
    return {s["node_id"]: s for s in steps}


def test_roots_render_in_a_run(run_yaml):
    run, steps = run_yaml(ROOTS)
    s = by_node(steps)
    assert run["status"] == "done", run["error"]
    assert s["roots"]["output"]["stdout_tail"].strip() == f"{run['id']} 1 {run['trigger']} hi"
    assert s["first"]["output"] == {"value": True} and s["never"]["status"] == "skipped"  # IF tests the same roots
    now = datetime.fromisoformat(s["clock"]["output"]["stdout_tail"].strip())
    assert abs((now - datetime.now(UTC)).total_seconds()) < 60


def test_stop_node_fails_the_run_with_its_message(run_yaml):
    run, steps = run_yaml("""
nodes:
- {id: start, type: trigger}
- {id: check, type: shell, command: 'echo boom'}
- {id: halt, type: stop, message: 'halt: {{check.stdout_tail}}'}
edges:
- {from: start, to: check}
- {from: check, to: halt}
""")
    s = by_node(steps)
    assert run["status"] == "failed" and "halt: boom" in run["error"], run["error"]
    assert s["check"]["status"] == "done"
    assert s["halt"]["status"] == "failed" and "halt: boom" in s["halt"]["error"], s["halt"]


def test_max_run_minutes_kills_the_batch(run_yaml):
    t0 = time.monotonic()
    run, steps = run_yaml("""
settings: {max_run_minutes: 0.02}
nodes:
- {id: start, type: trigger}
- {id: sleeper, type: shell, command: 'sleep 5'}
- {id: after, type: shell, command: 'echo after'}
edges:
- {from: start, to: sleeper}
- {from: sleeper, to: after}
""")
    assert time.monotonic() - t0 < 4  # the sleep was killed at the deadline (1.2 s), not waited for
    assert run["status"] == "failed" and "max_run_minutes (0.02) reached during sleeper" in run["error"], run["error"]
    assert "after" not in by_node(steps)


GATED = """
SETTINGS
nodes:
- {id: start, type: trigger}
- {id: gate, type: approval, message: 'Go?'}
- {id: after, type: shell, command: 'echo after'}
edges:
- {from: start, to: gate}
- {from: gate, to: after}
"""


def test_approval_timeout_fails_a_waiting_run(run_yaml, in_store):
    async def expire(st):
        return await engine.expire_approvals(st, await engine.owner())

    async def rows(st, rid):
        return (await st.store.fetchrow("select * from wf_runs where id = %s", (rid,)),
                by_node(await st.store.fetch("select * from wf_steps where run_id = %s order by id", (rid,))))

    run, _ = run_yaml(GATED.replace("SETTINGS", "settings: {approval_timeout_minutes: 0.001}"))
    plain, _ = run_yaml(GATED.replace("SETTINGS", ""))  # no timeout: waits forever
    assert (run["status"], plain["status"]) == ("waiting", "waiting")
    time.sleep(0.2)
    assert in_store(expire) == [run["id"]]
    run, s = in_store(lambda st: rows(st, run["id"]))
    assert run["status"] == "failed" and "approval_timeout_minutes" in run["error"], run["error"]
    assert s["gate"]["status"] == "failed" and s["gate"]["error"] == run["error"] and "after" not in s
    assert in_store(lambda st: rows(st, plain["id"]))[0]["status"] == "waiting"


def test_max_run_minutes_counts_only_running_time(run_yaml, in_store, walk_run):
    run, _ = run_yaml(GATED.replace("SETTINGS", "settings: {max_run_minutes: 0.5}"))
    assert run["status"] == "waiting"

    async def wait_long_then_approve(st):  # an hour-long approval wait: the run was claimed an hour ago
        await st.store.execute("update wf_runs set started_at = now() - interval '1 hour' where id = %s", (run["id"],))
        return await engine.approve(st, run["id"], run["owner"], True, None)
    assert in_store(wait_long_then_approve)
    run, steps = walk_run(run["id"])
    assert run["status"] == "done", run["error"]
    assert by_node(steps)["after"]["status"] == "done" and 0 < run["active_s"] < 30
