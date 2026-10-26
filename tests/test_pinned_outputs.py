"""Pinned node outputs (ticket 12, spec User Story 2): `pin: {output: {...}}` on agent and shell nodes, applied only
by runs started with pinned (editor and CLI). Graph and export cases need no DB; engine-seam cases (tests/conftest.py)
skip when CTC_DATABASE_URL is unset or Supabase.
Run: `CTC_DATABASE_URL=<scratch> uv run pytest -q tests/test_pinned_outputs.py`.
"""

from pathlib import Path

import httpx
import pytest
import yaml
from fastapi import FastAPI, HTTPException

from ctc.runner import engine, export, graph
from ctc.server import runs

WORKFLOWS = Path(__file__).resolve().parents[1] / ".claude" / "ctc-workflows"


def g_of(text: str) -> dict:
    return graph.load(yaml.safe_load(text))


def errors(nodes: str) -> list[str]:
    """validate() messages of a trigger -> x graph, x given as a YAML flow mapping."""
    return [e["message"] for e in graph.validate(g_of(f"""
nodes:
- {{id: start, type: trigger}}
- {nodes}
edges:
- {{from: start, to: x}}
"""))]


@pytest.mark.parametrize("node", [
    "{id: x, type: agent, prompt: hi, pin: {output: {result: ok}}}",
    "{id: x, type: shell, command: 'true', pin: {output: {result: ok, n: [1, {a: null}]}}}",
])
def test_pin_on_agent_and_shell_validates(node):
    assert errors(node) == []


def test_pin_only_on_agent_and_shell():
    for t in ("approval", "merge"):
        assert "only agent and shell nodes can be pinned" in errors(f"{{id: x, type: {t}, pin: {{output: {{}}}}}}"), t
    g = g_of("""
nodes:
- {id: start, type: trigger, pin: {output: {input: x}}}
- {id: x, type: if, path: input, op: eq, value: a, pin: {output: {value: true}}}
- {id: y, type: shell, command: 'true'}
edges:
- {from: start, to: x}
- {from: x, to: y, handle: 'true'}
- {from: x, to: y, handle: 'false'}
""")
    assert [(e["node_id"], e["message"]) for e in graph.validate(g)] == [
        ("start", "only agent and shell nodes can be pinned"), ("x", "only agent and shell nodes can be pinned")]


@pytest.mark.parametrize("pin", ["{output: [1]}", "{output: x}", "{result: 1}", "{output: {a: 1}, extra: 1}", "x"])
def test_pin_must_be_one_json_object(pin):
    assert errors(f"{{id: x, type: shell, command: 'true', pin: {pin}}}") == ["pin must be {output: {...}}: one JSON object"]


def test_pin_output_must_be_plain_json():
    assert errors("{id: x, type: agent, prompt: hi, pin: {output: {when: 2026-10-26}}}") == [
        "pin.output must be plain JSON (no dates or binary)"]


def test_demo_workflows_still_validate():
    for f in sorted(WORKFLOWS.glob("*.yaml")):
        if f.name != "bad-push.yaml":
            assert graph.validate(graph.load(f)) == [], f.name


PINNED = """
name: pinned
nodes:
- {id: start, type: trigger}
- {id: plan, type: agent, prompt: "plan {{input}}", pin: {output: {result: GO}}}
- {id: gate, type: if, path: plan.result, op: eq, value: GO}
- {id: impl, type: agent, prompt: "build it", pin: {output: {result: built}}}
- {id: report, type: shell, command: "echo {{impl.result}}"}
- {id: nope, type: shell, command: "echo no"}
edges:
- {from: start, to: plan}
- {from: plan, to: gate}
- {from: gate, to: impl, handle: "true"}
- {from: impl, to: report}
- {from: gate, to: nope, handle: "false"}
"""


def unpinned(text: str) -> dict:
    g = g_of(text)
    for n in g["nodes"]:
        n.pop("pin", None)
    return g


def test_pins_never_reach_a_native_run():
    assert export.to_js(g_of(PINNED), "x") == export.to_js(unpinned(PINNED), "x")


def by_node(steps: list[dict]) -> dict[str, dict]:
    return {s["node_id"]: s for s in steps}


def test_pinned_run_spends_no_tokens_and_branches_on_the_pins(run_yaml):
    run, steps = run_yaml(PINNED, "x", pinned=True)
    s = by_node(steps)
    assert run["status"] == "done", run["error"]
    assert run["tokens"] == 0 and run["pinned"] is True
    for n, out in (("plan", {"result": "GO"}), ("impl", {"result": "built"})):
        assert (s[n]["marker"], s[n]["status"], s[n]["output"]) == ("pinned", "done", out), n
        assert (s[n]["session_id"], s[n]["pre_sha"], s[n]["post_sha"], s[n]["usage"]) == (None, None, None, None), n
        assert s[n]["log_path"] is None, n
    assert s["plan"]["input"] == "plan x"  # the rendered prompt it would have run
    assert "built" in s["report"]["output"]["stdout_tail"] and s["report"]["marker"] is None
    assert s["nope"]["status"] == "skipped"


def test_pinned_run_takes_the_false_branch_on_a_no_pin(run_yaml):
    run, steps = run_yaml(PINNED.replace("{result: GO}", "{result: 'NO'}"), pinned=True)
    s = by_node(steps)
    assert run["status"] == "done", run["error"]
    assert s["plan"]["output"] == {"result": "NO"}
    assert s["nope"]["status"] == "done" and "no" in s["nope"]["output"]["stdout_tail"]
    assert s["impl"]["status"] == s["report"]["status"] == "skipped"


def test_without_pinned_the_pins_are_ignored(run_yaml):
    run, steps = run_yaml(PINNED, claude_script={"result": "GO"})
    s = by_node(steps)
    assert run["status"] == "done", run["error"]
    assert run["tokens"] > 0 and run["pinned"] is False
    for n in ("plan", "impl"):
        assert (s[n]["marker"], s[n]["output"]["result"]) == (None, "GO"), n
        assert s[n]["post_sha"] and s[n]["session_id"], n
    assert "GO" in s["report"]["output"]["stdout_tail"]  # the fake's output, not impl's pin


def test_schedule_and_mcp_starts_refuse_pinned(in_store):
    async def go(st):
        o = await engine.owner()
        codes = []
        for trigger in ("mcp", "schedule", "cli"):  # cli passes the gate, then finds no such workflow
            try:
                await runs.submit_run(st, "local", o, "any:wf", "", None, trigger, pinned=True)
            except HTTPException as e:
                codes.append((e.status_code, e.detail["code"]))
        app = FastAPI()
        app.include_router(runs.router)
        app.state.st = st
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://ctc") as h:
            r = await h.post("/api/workflows/any:wf/runs", json={"pinned": True, "trigger": "schedule"})
        return codes, r
    codes, r = in_store(go)
    assert codes == [(422, "pinned_not_allowed"), (422, "pinned_not_allowed"), (404, "not_found")]
    assert r.status_code == 422 and r.json()["detail"]["code"] == "pinned_not_allowed", r.text
