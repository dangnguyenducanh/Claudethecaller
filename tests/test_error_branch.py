"""Error branch (US8 / ticket 10, FR-014, FR-050): an agent or shell node picks `on_error: stop | continue |
error_output` (default stop; the old editor's `fail` reads as stop). With error_output a failure sends
{error, output_tail, exit_code} down its `error` edge only; continue goes on down the normal edges with the step failed.
Graph cases need no DB; engine-seam cases (tests/conftest.py) skip when CTC_DATABASE_URL is unset or Supabase.
Run: `CTC_DATABASE_URL=<scratch> uv run pytest -q tests/test_error_branch.py`.
"""

from pathlib import Path

import pytest
import yaml

from ctc.runner import export, graph

WORKFLOWS = Path(__file__).resolve().parents[1] / ".claude" / "ctc-workflows"
FIXER = """name: fixer
nodes:
- {id: start, type: trigger}
- {id: test, type: shell, command: TEST, on_error: error_output}
- {id: ship, type: shell, command: 'echo shipped'}
- {id: fix, type: agent, prompt: 'Fix: {{test.output_tail}} exit {{test.exit_code}}'}
edges:
- {from: start, to: test}
- {from: test, to: ship}
- {from: test, to: fix, handle: error}
- {from: fix, to: test}
"""


def fixer(cmd: str = "pytest -q") -> dict:
    """start -> test (shell, on_error: error_output) -> ship; test --error--> fix (agent) -> test: a loop."""
    return graph.load(yaml.safe_load(FIXER.replace("TEST", yaml.safe_dump(cmd, default_style='"').strip())))


def errors(g: dict) -> list[tuple[str, str]]:
    return [(e["node_id"], e["message"]) for e in graph.validate(g)]


def one(x: str, edge: str = "{from: x, to: end}") -> list[tuple[str, str]]:
    """Validation errors of trigger -> x -> end (a shell), x a YAML flow mapping with id x, plus `edge`."""
    return errors(graph.load(yaml.safe_load(f"""
nodes:
- {{id: start, type: trigger}}
- {x}
- {{id: end, type: shell, command: 'true'}}
edges:
- {{from: start, to: x}}
- {edge}
""")))


def test_error_edge_needs_error_output_on_its_source():
    assert one("{id: x, type: shell, command: 'true'}", "{from: x, to: end, handle: error}") == [
        ("x", "edge x -> end: an error edge needs on_error: error_output on x")]
    assert one("{id: x, type: agent, prompt: hi, on_error: continue}", "{from: x, to: end, handle: error}") == [
        ("x", "edge x -> end: an error edge needs on_error: error_output on x")]


def test_error_output_needs_an_error_edge():
    assert one("{id: x, type: shell, command: 'true', on_error: error_output}") == [
        ("x", "on_error: error_output needs an error edge (the red error handle)")]


ONLY = [("x", "on_error is for agent and shell nodes only")]


@pytest.mark.parametrize("x", ["{id: x, type: approval, message: go, on_error: continue}",
                               "{id: x, type: merge, on_error: stop}"])
def test_on_error_is_for_agent_and_shell_only(x):
    assert one(x) == ONLY


def test_on_error_on_an_if_is_rejected():
    assert one("{id: x, type: if, path: start.input, op: truthy, on_error: continue}",
               "{from: x, to: end, handle: 'true'}\n- {from: x, to: end, handle: 'false'}") == ONLY


def test_on_error_on_a_trigger_is_rejected():
    g = graph.load(yaml.safe_load("""
nodes:
- {id: start, type: trigger, on_error: continue}
- {id: end, type: shell, command: 'true'}
edges:
- {from: start, to: end}
"""))
    assert errors(g) == [("start", "on_error is for agent and shell nodes only")]


def test_unknown_on_error_is_rejected():
    assert one("{id: x, type: shell, command: 'true', on_error: retry-me}") == [
        ("x", "on_error must be stop, continue or error_output, not 'retry-me'")]


@pytest.mark.parametrize("v", ["stop", "continue", "fail"])  # fail: written by the old editor, read as stop
def test_known_on_error_values_validate(v):
    assert one(f"{{id: x, type: agent, prompt: hi, on_error: {v}}}") == []


def test_fixer_loop_validates():
    assert errors(fixer()) == []


def test_error_output_node_branches_once_each_way_in_a_loop():
    g = fixer()
    g["edges"].append({"from": "test", "to": "fix"})  # a second normal edge out of test, inside the loop
    assert ("test", "only an IF or Switch may branch inside a loop (fix -> test)") in errors(g)


def test_switch_case_named_error_is_still_a_case():
    g = graph.load(yaml.safe_load("""
nodes:
- {id: start, type: trigger}
- {id: sw, type: switch, cases: [{name: error, conditions: [{path: start.input, op: truthy}]}]}
- {id: a, type: shell, command: 'true'}
- {id: b, type: shell, command: 'true'}
edges:
- {from: start, to: sw}
- {from: sw, to: a, handle: error}
- {from: sw, to: b, handle: default}
"""))
    assert errors(g) == []


def test_demo_workflows_still_validate():
    for f in sorted(WORKFLOWS.glob("*.yaml")):
        if f.name != "bad-push.yaml":
            assert graph.validate(graph.load(f)) == [], f.name


def walk_to_test() -> tuple[dict, dict]:
    """The fixer graph with start done: test is ready."""
    g, st = fixer(), {}
    assert graph.ready(g, st) == ["start"]
    graph.complete(g, st, "start", {"input": ""})
    assert graph.ready(g, st) == ["test"]
    return g, st


def test_a_failed_node_sends_data_only_down_its_error_edge():
    g, st = walk_to_test()
    assert graph.complete(g, st, "test", {"error": "exit 1", "output_tail": "FAIL", "exit_code": 1}, failed=True) is None
    assert st["inbox"] == {"fix": {"2": "data"}} and st["deferred"] == [1] and st["ready"] == ["fix"], st  # 1: test -> ship


def test_a_node_that_succeeds_defers_its_error_edge():
    g, st = walk_to_test()
    assert graph.complete(g, st, "test", {"exit_code": 0}) is None
    assert st["inbox"] == {"ship": {"1": "data"}} and st["deferred"] == [2] and st["ready"] == ["ship"], st
    graph.complete(g, st, "ship", {"exit_code": 0})
    assert graph.ready(g, st) == [] and st["skipped"] == ["fix"], st  # quiescence: the error side is skipped


def test_export_refuses_an_error_edge():
    with pytest.raises(ValueError) as e:
        export.to_js(fixer(), "fixer")
    assert str(e.value) == "error_edge: test -> fix: a native workflow has no error branch"


def fixer_yaml(cmd: str) -> str:
    return FIXER.replace("TEST", yaml.safe_dump(cmd, default_style='"').strip())


def order(steps) -> list[tuple[str, int, str]]:
    return [(s["node_id"], s["visit"], s["status"]) for s in steps if s["node_id"] != "start"]


def test_fixer_loop_runs_until_the_test_passes(seam, run_yaml):
    c = seam.tmp / "count"  # outside the worktree: the count survives between visits
    cmd = f"n=$(( $(cat {c} 2>/dev/null || echo 0) + 1 )); echo $n > {c}; [ $n -ge 3 ] || {{ echo FAIL $n; exit 1; }}"
    run, steps = run_yaml(fixer_yaml(cmd), claude_script={"result": "fixed"})
    assert run["status"] == "done", run["error"]
    assert order(steps) == [("test", 1, "failed"), ("fix", 1, "done"), ("test", 2, "failed"), ("fix", 2, "done"),
                            ("test", 3, "done"), ("ship", 1, "done"), ("fix", 3, "skipped")], order(steps)
    t1, f1 = steps[1], steps[2]
    assert set(t1["output"]) == {"error", "output_tail", "exit_code"} and t1["output"]["exit_code"] == 1, t1["output"]
    assert "exit 1" in t1["output"]["error"] and "FAIL 1" in t1["output"]["output_tail"], t1["output"]
    assert "FAIL 1" in f1["input"] and "exit 1" in f1["input"], f1["input"]


def test_fixer_loop_is_capped_by_max_visits(run_yaml):
    run, steps = run_yaml(fixer_yaml("echo FAIL; exit 1"))
    assert (run["status"], run["error"]) == ("failed", "loop cap reached at test"), run["error"]
    assert [s["status"] for s in steps if s["node_id"] == "test"] == ["failed"] * 3  # default max_visits 3
    assert not any(s["node_id"] == "ship" for s in steps)


def test_a_failed_agent_routes_its_result_and_exit_code(run_yaml):
    run, steps = run_yaml("""name: agent-err
nodes:
- {id: start, type: trigger}
- {id: a, type: agent, prompt: hi, on_error: error_output}
- {id: ok, type: shell, command: 'true'}
- {id: report, type: shell, command: 'echo {{a.output_tail}}'}
edges:
- {from: start, to: a}
- {from: a, to: ok}
- {from: a, to: report, handle: error}
""", claude_script={"is_error": True, "result": "model refused"})
    assert run["status"] == "done", run["error"]
    assert order(steps) == [("a", 1, "failed"), ("report", 1, "done"), ("ok", 1, "skipped")], order(steps)
    out = steps[1]["output"]
    assert (out["output_tail"], out["exit_code"]) == ("model refused", 1) and "model refused" in out["error"], out


def test_continue_goes_on_with_the_failed_steps_output(run_yaml):
    run, steps = run_yaml("""name: cont
nodes:
- {id: start, type: trigger}
- {id: bad, type: shell, command: 'echo out; exit 3', on_error: continue}
- {id: next, type: shell, command: 'echo got {{bad.stdout_tail}}'}
edges:
- {from: start, to: bad}
- {from: bad, to: next}
""")
    bad, nxt = steps[1], steps[2]
    assert (run["status"], bad["status"], bad["output"]["exit_code"], nxt["status"]) == ("done", "failed", 3, "done")
    assert "got out" in nxt["output"]["stdout_tail"], nxt["output"]


def two_shells(cmd: str, more: str = "") -> str:
    return f"""name: stop
nodes:
- {{id: start, type: trigger}}
- {{id: x, type: shell, command: {cmd!r}{more}}}
- {{id: after, type: shell, command: 'true'}}
edges:
- {{from: start, to: x}}
- {{from: x, to: after}}
"""


def test_default_stop_keeps_a_non_zero_exit_as_data(run_yaml):
    run, steps = run_yaml(two_shells("exit 1"))
    assert (run["status"], steps[1]["status"], steps[1]["output"]["exit_code"]) == ("done", "done", 1)
    assert steps[2]["node_id"] == "after" and steps[2]["status"] == "done"


def test_default_stop_fails_the_run_on_a_timeout(run_yaml):
    run, steps = run_yaml(two_shells("sleep 5", ", timeout_s: 1"))
    assert (run["status"], steps[1]["status"]) == ("failed", "timeout")
    assert not any(s["node_id"] == "after" for s in steps)
