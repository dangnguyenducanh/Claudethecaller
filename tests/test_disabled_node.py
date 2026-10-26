"""Disabled nodes (US6 / ticket 08, FR-016, FR-050): `disabled: true` on any node but trigger, IF and Switch passes the
run straight through it (output = upstream output), and a native export does the same. Graph and export cases need no
DB; engine-seam cases (tests/conftest.py) skip when CTC_DATABASE_URL is unset or Supabase.
Run: `CTC_DATABASE_URL=<scratch> uv run pytest -q tests/test_disabled_node.py`.
"""

from pathlib import Path

import pytest
import yaml

from ctc.runner import engine, export, graph

WORKFLOWS = Path(__file__).resolve().parents[1] / ".claude" / "ctc-workflows"


def g_of(text: str) -> dict:
    return graph.load(yaml.safe_load(text))


def errors_at(g: dict) -> list[tuple]:
    return [(e["node_id"], e["message"]) for e in graph.validate(g)]


BRANCHING = """
nodes:
- {id: start, type: trigger, disabled: true}
- {id: gate, type: if, path: input, op: eq, value: a, disabled: true}
- {id: verdict, type: switch, cases: [{name: big, conditions: [{path: input, op: eq, value: b}]}], disabled: true}
- {id: y, type: shell, command: 'true'}
- {id: z, type: shell, command: 'true'}
edges:
- {from: start, to: gate}
- {from: gate, to: verdict, handle: 'true'}
- {from: gate, to: y, handle: 'false'}
- {from: verdict, to: y, handle: big}
- {from: verdict, to: z, handle: default}
"""


def test_trigger_if_and_switch_cannot_be_disabled():
    errs = errors_at(g_of(BRANCHING))
    assert [nid for nid, _ in errs] == ["start", "gate", "verdict"], errs
    assert all("disabled" in m for _, m in errs), errs
    assert errors_at(g_of(BRANCHING.replace("disabled: true", "disabled: false"))) == []


def chain(x: str) -> dict:
    """trigger -> a -> x -> b, x given as a YAML flow mapping."""
    return g_of(f"""
nodes:
- {{id: start, type: trigger}}
- {{id: a, type: shell, command: echo A}}
- {x}
- {{id: b, type: shell, command: 'true'}}
edges:
- {{from: start, to: a}}
- {{from: a, to: x}}
- {{from: x, to: b}}
""")


def test_disabled_must_be_a_bool():
    assert errors_at(chain("{id: x, type: shell, command: 'true', disabled: 'yes'}")) == [
        ("x", "disabled must be true or false")]


@pytest.mark.parametrize("x", [
    "{id: x, type: shell, command: 'true', disabled: true}",
    "{id: x, type: agent, prompt: hi, disabled: true}",
    "{id: x, type: approval, message: 'ok?', disabled: true}",
    "{id: x, type: merge, disabled: true}",
])
def test_other_nodes_can_be_disabled(x):
    assert errors_at(chain(x)) == []


def test_a_disabled_approval_gates_no_push():
    g = chain("{id: x, type: approval, message: 'push?', disabled: true}")
    g["nodes"][3]["command"] = "git push -u origin HEAD"
    assert errors_at(g) == [("b", "git push / gh pr create|merge must sit behind an approval node")]
    g["nodes"][2].pop("disabled")
    assert errors_at(g) == []


def test_passthrough_is_the_upstream_output():
    g, st = chain("{id: x, type: shell, command: 'true', disabled: true}"), {}
    ctx = {"input": "", "start": {"input": ""}, "a": {"exit_code": 0, "stdout_tail": "A\n"}}
    for n in ("start", "a"):
        assert graph.ready(g, st) == [n]
        graph.complete(g, st, n, ctx[n])
    assert graph.ready(g, st) == ["x"]
    assert graph.passthrough(g, st, "x", ctx) == {"exit_code": 0, "stdout_tail": "A\n"}


CHAIN = """
name: disabled-chain
nodes:
- {id: start, type: trigger}
- {id: a, type: shell, command: echo A}
- {id: x, type: shell, command: echo X, disabled: true}
- {id: b, type: shell, command: "echo got {{x.stdout_tail}}"}
edges:
- {from: start, to: a}
- {from: a, to: x}
- {from: x, to: b}
"""


def test_export_passes_a_disabled_node_through():
    js = export.to_js(g_of(CHAIN), "disabled-chain")
    assert 'set("x", out[[' in js and 'sh("x"' not in js, js


def by_node(steps: list[dict]) -> dict[str, dict]:
    return {s["node_id"]: s for s in steps}


def test_disabled_shell_passes_the_previous_output_on(run_yaml):
    run, steps = run_yaml(CHAIN)
    s = by_node(steps)
    assert run["status"] == "done", run["error"]
    assert (s["x"]["status"], s["x"]["marker"]) == ("skipped", "disabled")
    assert s["x"]["output"] == s["a"]["output"] and "A" in s["a"]["output"]["stdout_tail"]
    assert (s["x"]["pre_sha"], s["x"]["post_sha"], s["x"]["log_path"]) == (None, None, None)
    assert "got A" in s["b"]["output"]["stdout_tail"]


def test_disabled_agent_runs_no_session(run_yaml):
    run, steps = run_yaml(CHAIN.replace("{id: x, type: shell, command: echo X, disabled: true}",
                                        "{id: x, type: agent, prompt: never, disabled: true}"))
    s = by_node(steps)
    assert run["status"] == "done", run["error"]
    assert (s["x"]["status"], s["x"]["marker"], s["x"]["session_id"]) == ("skipped", "disabled", None)
    assert run["tokens"] == 0 and "got A" in s["b"]["output"]["stdout_tail"]


def test_disabled_approval_never_waits(run_yaml):
    run, steps = run_yaml(CHAIN.replace("{id: x, type: shell, command: echo X, disabled: true}",
                                        "{id: x, type: approval, message: 'ok?', disabled: true}"))
    assert run["status"] == "done", run["error"]
    assert "waiting" not in {s["status"] for s in steps}
    assert (by_node(steps)["x"]["status"], by_node(steps)["x"]["marker"]) == ("skipped", "disabled")


def test_resumed_run_still_reads_a_disabled_output(run_yaml, in_store, walk_run):
    run, _ = run_yaml(CHAIN.replace("- {from: x, to: b}", "- {from: x, to: gate}\n- {from: gate, to: b}")
                      .replace("edges:", "- {id: gate, type: approval, message: 'go?'}\nedges:"))
    assert run["status"] == "waiting", run["error"]

    async def ok(st):
        return await engine.approve(st, run["id"], await engine.owner(), True, None)
    assert in_store(ok)
    run, steps = walk_run(run["id"])  # a new claim: ctx is read back from the step rows
    assert run["status"] == "done", run["error"]
    assert "got A" in by_node(steps)["b"]["output"]["stdout_tail"]


def test_demo_workflows_still_validate():
    for f in sorted(WORKFLOWS.glob("*.yaml")):
        if f.name != "bad-push.yaml":
            assert graph.validate(graph.load(f)) == [], f.name
