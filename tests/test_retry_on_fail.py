"""Retry-on-fail (US7 / ticket 09, FR-003, FR-013): a shell node with `idempotent: true` and `retry: {max_tries 1..5,
wait_s 0..300}` re-runs in the same worktree until it exits 0 or runs out of tries; agents never auto-retry. Graph cases
need no DB; engine-seam cases (tests/conftest.py) skip when CTC_DATABASE_URL is unset or Supabase.
Run: `CTC_DATABASE_URL=<scratch> uv run pytest -q tests/test_retry_on_fail.py`.
"""

import asyncio
import time
from pathlib import Path

import pytest
import yaml

from ctc.runner import engine, graph

WORKFLOWS = Path(__file__).resolve().parents[1] / ".claude" / "ctc-workflows"


def errors(x: str) -> list[str]:
    """Validation messages of trigger -> x, x a YAML flow mapping with id x."""
    g = graph.load(yaml.safe_load(f"""
nodes:
- {{id: start, type: trigger}}
- {x}
edges:
- {{from: start, to: x}}
"""))
    return [e["message"] for e in graph.validate(g) if e["node_id"] == "x"]


def test_agents_never_auto_retry():
    assert errors("{id: x, type: agent, prompt: hi, retry: {max_tries: 3}}") == [
        "retry is for idempotent shell nodes only: agents never auto-retry"]


def test_retry_needs_an_idempotent_shell():
    msg = ["retry needs idempotent: true: the command is re-run as is"]
    assert errors("{id: x, type: shell, command: 'true', retry: {max_tries: 3}}") == msg
    assert errors("{id: x, type: shell, command: 'true', idempotent: false, retry: {max_tries: 3}}") == msg


def test_idempotent_is_a_shell_bool():
    assert errors("{id: x, type: agent, prompt: hi, idempotent: true}") == ["idempotent is for shell nodes only"]
    assert errors("{id: x, type: shell, command: 'true', idempotent: 'yes'}") == ["idempotent must be true or false"]


SHAPE = ["retry must be {max_tries: 1-5, wait_s: 0-300 (seconds)}"]


@pytest.mark.parametrize("retry", [
    "{max_tries: 0}", "{max_tries: 6}", "{max_tries: '3'}", "{max_tries: true}", "{wait_s: 1}",  # max_tries: int 1..5
    "{max_tries: 3, wait_s: -1}", "{max_tries: 3, wait_s: 301}", "{max_tries: 3, wait_s: '1'}",  # wait_s: number 0..300
    "{max_tries: 3, wait: 1}", "3", "[3]",  # unknown key, not a mapping
])
def test_retry_shape(retry):
    assert errors(f"{{id: x, type: shell, command: 'true', idempotent: true, retry: {retry}}}") == SHAPE


@pytest.mark.parametrize("retry", ["{max_tries: 3}", "{max_tries: 5, wait_s: 300}", "{max_tries: 1, wait_s: 0.5}"])
def test_idempotent_shell_may_retry(retry):
    assert errors(f"{{id: x, type: shell, command: 'true', idempotent: true, retry: {retry}}}") == []


def test_demo_workflows_still_validate():
    for f in sorted(WORKFLOWS.glob("*.yaml")):
        if f.name != "bad-push.yaml":
            assert graph.validate(graph.load(f)) == [], f.name


def one_shell(x: str) -> str:
    """trigger -> x (a YAML flow mapping with id x, type shell)."""
    return f"name: retry\nnodes:\n- {{id: start, type: trigger}}\n- {x}\nedges:\n- {{from: start, to: x}}\n"


def step_x(steps) -> dict:
    return next(s for s in steps if s["node_id"] == "x")


def test_flaky_shell_succeeds_on_its_third_try(seam, run_yaml):
    c = seam.tmp / "count"  # outside the worktree: every try runs in the same one, the count survives between tries
    cmd = f'n=$(( $(cat {c} 2>/dev/null || echo 0) + 1 )); echo $n > {c}; [ $n -ge 3 ]'
    run, steps = run_yaml(one_shell(f"{{id: x, type: shell, command: {cmd!r}, idempotent: true,"
                                    " retry: {max_tries: 3, wait_s: 0}}"))
    x = step_x(steps)
    assert (run["status"], x["status"], x["tries"], x["error"], x["output"]["exit_code"]) == ("done", "done", 3, None, 0)
    assert c.read_text().strip() == "3"


def test_always_failing_shell_fails_after_max_tries_with_the_last_error(run_yaml):
    run, steps = run_yaml(one_shell("{id: x, type: shell, command: 'echo boom >&2; exit 7', idempotent: true,"
                                    " retry: {max_tries: 2, wait_s: 0}}"))
    x = step_x(steps)
    assert (run["status"], x["status"], x["tries"]) == ("failed", "failed", 2)
    assert "exit 7" in x["error"] and "boom" in x["error"] and "try 2/2" in x["error"], x["error"]
    assert "boom" in run["error"], run["error"]


def test_shell_without_retry_keeps_a_non_zero_exit_as_data(run_yaml):
    run, steps = run_yaml(one_shell("{id: x, type: shell, command: 'exit 1'}"))
    x = step_x(steps)
    assert (run["status"], x["status"], x["tries"], x["error"], x["output"]["exit_code"]) == ("done", "done", 1, None, 1)


def test_cancel_during_the_wait_stops_the_retries(seam, in_store):
    g = graph.load(yaml.safe_load(one_shell("{id: x, type: shell, command: 'exit 1', idempotent: true,"
                                            " retry: {max_tries: 5, wait_s: 2}}")))

    async def go(st):
        o = await engine.owner()
        rid = await engine.submit(st, o, "test:retry", g, "sha", str(seam.repo), None, "cli", "")
        task = asyncio.create_task(engine.execute(st, await engine.claim(st, rid)))
        t0 = time.monotonic()
        while not await st.store.fetchval("select 1 from wf_steps where run_id = %s and node_id = 'x'", (rid,)):
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.5)  # the first try exited at once: the engine sits in its 2 s wait
        await engine.cancel(st, rid, o)
        await task
        return (time.monotonic() - t0, await st.store.fetchrow("select * from wf_runs where id = %s", (rid,)),
                await st.store.fetch("select * from wf_steps where run_id = %s order by id", (rid,)))

    took, run, steps = in_store(go)
    x = step_x(steps)
    assert (run["status"], x["status"], x["tries"]) == ("cancelled", "cancelled", 1)
    assert took < 6, took  # 5 tries would sit through 4 waits of 2 s
