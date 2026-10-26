"""US16 (ticket 17): typed run inputs on the trigger, `ctc workflow validate`, and the builder skill's example.
Graph, export and CLI cases are DB-free; the engine seam and the API/MCP cases use tests/conftest.py and skip
without a scratch Postgres."""

import json
from pathlib import Path

import pytest
import yaml
from fastapi import HTTPException
from mcp.server.mcpserver.exceptions import ToolError
from typer.testing import CliRunner

import ctc.cli
from ctc.ingestion.scanner import _make_capability, project_namespace
from ctc.runner import engine, graph
from ctc.runner.export import to_js
from ctc.server import mcp, runs

ROOT = Path(__file__).resolve().parents[1]
TRIG ={"id": "start", "type": "trigger", "inputs": [
    {"name": "topic", "type": "string", "required": True, "description": "what to echo"},
    {"name": "count", "type": "number", "default": 2},
    {"name": "dry_run", "type": "bool", "default": True},
    {"name": "extra", "type": "json"},
]}


def coerce(given: dict, trig: dict = TRIG):
    return graph.coerce_inputs(trig, given)


def test_coerce_inputs_converts_each_type_and_fills_defaults():
    assert coerce({"topic": "x"}) == {"topic": "x", "count": 2, "dry_run": True}  # optional json without default: omitted
    assert coerce({"topic": 7, "count": "3"})["topic"] == "7"
    assert coerce({"topic": "x", "count": "3"})["count"] == 3
    assert coerce({"topic": "x", "count": "2.5"})["count"] == 2.5
    assert coerce({"topic": "x", "count": 4})["count"] == 4
    for raw, want in (("true", True), ("0", False), ("yes", True), (True, True), ("OFF", False)):
        assert coerce({"topic": "x", "dry_run": raw})["dry_run"] is want, raw
    assert coerce({"topic": "x", "extra": '{"a":1}'})["extra"] == {"a": 1}
    assert coerce({"topic": "x", "extra": [1, 2]})["extra"] == [1, 2]  # not a str: passes as is
    assert coerce({"topic": "x", "count": None, "dry_run": ""}) == {"topic": "x", "count": 2, "dry_run": True}  # empty = absent


@pytest.mark.parametrize("given, msg", [
    ({"topic": "x", "count": "abc"}, "input count must be a number, got 'abc'"),
    ({"topic": "x", "count": True}, "input count must be a number, got True"),
    ({"topic": "x", "dry_run": "maybe"}, "input dry_run must be a bool"),
    ({"topic": "x", "extra": "{bad"}, "input extra is not valid JSON"),
    ({}, "topic is required"),
    ({"topic": ""}, "topic is required"),  # the run dialog sends an empty field as ""
    ({"topic": "x", "nope": 1}, "unknown input nope; declared: topic, count, dry_run, extra"),
])
def test_coerce_inputs_rejects_with_a_clear_message(given, msg):
    with pytest.raises(ValueError, match=msg.replace("(", r"\(").replace(")", r"\)")):
        coerce(given)


def test_coerce_inputs_reports_every_problem_in_one_message():
    with pytest.raises(ValueError) as e:
        coerce({"count": "many"})
    assert str(e.value) == "topic is required; input count must be a number, got 'many'"


def wf(trig: dict = TRIG, command: str = "echo {{input.topic}} x {{input.count}}") -> dict:
    return graph.load({"nodes": [trig, {"id": "say", "type": "shell", "command": command}],
                       "edges": [{"from": "start", "to": "say"}]})


def test_validate_accepts_a_trigger_declaring_every_input_type():
    assert graph.validate(wf()) == []
    assert graph.warnings(wf()) == []


@pytest.mark.parametrize("inputs, msg", [
    ({"topic": "string"}, "trigger inputs must be a list of {name, type, required, default, description}"),
    (["topic"], "trigger inputs must be a list of {name, type, required, default, description}"),
    ([{"name": "a b"}], "bad input name 'a b': use letters, digits, - or _"),
    ([{"type": "string"}], "bad input name None: use letters, digits, - or _"),
    ([{"name": "a"}, {"name": "a", "type": "number"}], "duplicate input a"),
    ([{"name": "n", "type": "int"}], "input n: type must be string, number, bool or json, not 'int'"),
    ([{"name": "n", "required": "yes"}], "input n: required must be true or false"),
    ([{"name": "n", "description": 3}], "input n: description must be text"),
    ([{"name": "n", "type": "number", "default": "abc"}], "input n: bad default: input n must be a number, got 'abc'"),
])
def test_validate_rejects_bad_trigger_inputs_on_the_trigger(inputs, msg):
    errs = graph.validate(wf({"id": "start", "type": "trigger", "inputs": inputs}, "echo hi"))
    assert errs == [{"message": msg, "node_id": "start"}], errs


def test_an_undeclared_input_ref_warns_only_when_the_trigger_declares_inputs():
    g = wf(command="echo {{input.nope}}")
    assert graph.validate(g) == []
    assert graph.warnings(g) == [{"message": "input.nope: no declared input nope (topic, count, dry_run, extra)",
                                  "node_id": "say"}]
    free = wf({"id": "start", "type": "trigger"}, "echo {{input.nope}} {{input}}")
    assert graph.validate(free) == [] and graph.warnings(free) == []


def test_export_fills_declared_defaults_and_throws_on_a_missing_required_input():
    js = to_js(wf(), "inputs")
    assert ("const input = Object.assign({\"count\": 2, \"dry_run\": true}, typeof args === 'string' ? "
            "JSON.parse(args || '{}') : (args ?? {}))\n") in js
    assert 'if (input["topic"] === undefined) throw new Error("missing input topic")\n' in js
    assert js.count("throw new Error(\"missing input") == 1
    assert "const input = args ?? \"\"" in to_js(wf({"id": "start", "type": "trigger"}, "echo {{input}}"), "free")


TYPED = """
name: typed
nodes:
- id: start
  type: trigger
  inputs:
  - {name: topic, type: string, required: true}
  - {name: count, type: number}
- {id: say, type: shell, command: "echo {{input.topic}}-{{input.count}}"}
edges:
- {from: start, to: say}
"""


def test_engine_renders_typed_inputs_and_the_trigger_outputs_them(run_yaml):
    run, steps = run_yaml(TYPED, input=json.dumps({"topic": "x", "count": 3}))
    s = {x["node_id"]: x for x in steps}
    assert run["status"] == "done", run["error"]
    assert s["say"]["output"]["stdout_tail"].strip() == "x-3"
    assert s["start"]["output"] == {"input": {"topic": "x", "count": 3}}
    assert json.loads(s["start"]["input"]) == {"topic": "x", "count": 3}


def test_engine_keeps_free_text_input_without_declared_inputs(run_yaml):
    free = TYPED.replace("  inputs:\n  - {name: topic, type: string, required: true}\n  - {name: count, type: number}\n", "")
    run, steps = run_yaml(free.replace("{{input.topic}}-{{input.count}}", "{{input}}"), input="free text")
    s = {x["node_id"]: x for x in steps}
    assert (run["status"], s["say"]["output"]["stdout_tail"].strip()) == ("done", "free text")
    assert s["start"]["output"] == {"input": "free text"}


DEMO = """
name: demo
description: demo desc
nodes:
- id: start
  type: trigger
  inputs:
  - {name: topic, type: string, required: true}
  - {name: count, type: number, default: 2}
  - {name: dry_run, type: bool, default: true}
- {id: say, type: shell, command: "echo {{input.topic}} x {{input.count}}"}
edges:
- {from: start, to: say}
"""
FREE = "name: free\ndescription: free desc\nnodes:\n- {id: start, type: trigger}\nedges: []\n"


@pytest.fixture
def wfs(seam, in_store):
    """The project workflows demo (declares inputs) and free (does not), indexed like `ctc index`: their cap ids."""
    async def go(st):
        d, ns = seam.repo / ".claude" / "ctc-workflows", project_namespace(seam.repo)
        d.mkdir(parents=True, exist_ok=True)
        caps = []
        for name, text in (("demo", DEMO), ("free", FREE)):
            (f := d / f"{name}.yaml").write_text(text)
            caps.append(_make_capability(f, "workflow", ns, name))
        await st.store.upsert(caps, [ns])
        return {c.name: c.id for c in caps}
    return in_store(go)


@pytest.mark.parametrize("text, inputs, msg", [
    ("", {"count": "3"}, "topic is required"),
    ("", {"topic": "x", "count": "many"}, "input count must be a number, got 'many'"),
    ("not json", None, "declares inputs (topic, count, dry_run): pass inputs as {name: value}"),
])
def test_submit_run_rejects_bad_inputs_with_422_bad_input(in_store, wfs, text, inputs, msg):
    async def go(st):
        with pytest.raises(HTTPException) as e:
            await runs.submit_run(st, "local", await engine.owner(), wfs["demo"], text, inputs=inputs)
        return e.value
    e = in_store(go)
    assert (e.status_code, e.detail["code"]) == (422, "bad_input") and msg in e.detail["message"], e.detail


def test_submit_run_stores_coerced_inputs_and_takes_a_json_text_from_schedules(in_store, wfs):
    async def go(st):
        o = await engine.owner()
        a = await runs.submit_run(st, "local", o, wfs["demo"], inputs={"topic": "x", "count": "3"})
        b = await runs.submit_run(st, "local", o, wfs["demo"], '{"topic": "y"}', None, "schedule")
        return [await st.store.fetchval("select input from wf_runs where id = %s", (r,)) for r in (a, b)]
    assert in_store(go) == [json.dumps({"topic": "x", "count": 3, "dry_run": True}),
                            json.dumps({"topic": "y", "count": 2, "dry_run": True})]


def test_submit_run_keeps_free_text_and_refuses_inputs_without_declared_ones(in_store, wfs):
    async def go(st):
        o = await engine.owner()
        rid = await runs.submit_run(st, "local", o, wfs["free"], "some text")
        with pytest.raises(HTTPException) as e:
            await runs.submit_run(st, "local", o, wfs["free"], inputs={"topic": "x"})
        return await st.store.fetchval("select input from wf_runs where id = %s", (rid,)), e.value.detail
    text, detail = in_store(go)
    assert text == "some text"
    assert detail == {"code": "bad_input", "message": f"{wfs['free']} declares no inputs: pass input text"}


def test_mcp_run_workflow_checks_typed_inputs_and_list_workflows_shows_them(in_store, wfs, monkeypatch):
    def tool(name, **args):
        async def go(st):
            monkeypatch.setattr(mcp, "state", st)
            return (await mcp.mcp.call_tool(name, args)).structured_content
        return in_store(go)
    with pytest.raises(ToolError, match="run_workflow: topic is required$"):
        tool("run_workflow", workflow=wfs["demo"], inputs={"count": 3})
    rid = tool("run_workflow", workflow=wfs["demo"], inputs={"topic": "x", "dry_run": False})["run_id"]
    row = in_store(lambda st: st.store.fetchrow("select input, trigger, pinned from wf_runs where id = %s", (rid,)))
    assert row == {"input": json.dumps({"topic": "x", "count": 2, "dry_run": False}), "trigger": "mcp", "pinned": False}
    got = {w["id"]: w["inputs"] for w in tool("list_workflows")["workflows"]}  # earlier tests' caps stay indexed
    assert got[wfs["free"]] == [] and [i["name"] for i in got[wfs["demo"]]] == ["topic", "count", "dry_run"]
    assert got[wfs["demo"]][0] == {"name": "topic", "type": "string", "required": True}


DEMO_FILE = ROOT / ".claude" / "ctc-workflows" / "inputs-demo.yaml"


def test_the_builder_skills_inputs_demo_validates():
    g = graph.load(DEMO_FILE)
    assert graph.validate(g) == [] and graph.warnings(g) == []
    trig = next(n for n in g["nodes"] if n["type"] == "trigger")
    assert graph.coerce_inputs(trig, {"topic": "x"}) == {"topic": "x", "count": 2, "dry_run": True}


def validate_cli(path):
    return CliRunner().invoke(ctc.cli.app, ["workflow", "validate", str(path)])


def test_workflow_validate_prints_errors_and_warnings(tmp_path):
    ok = validate_cli(DEMO_FILE)
    assert (ok.exit_code, ok.output.strip().splitlines()[-1]) == (0, "valid"), ok.output
    bad = tmp_path / "bad.yaml"
    bad.write_text(yaml.safe_dump(wf({"id": "start", "type": "trigger", "inputs": [{"name": "n", "type": "int"}]}, "echo hi")))
    r = validate_cli(bad)
    assert r.exit_code == 1 and "error: input n: type must be string, number, bool or json, not 'int'" in r.output, r.output
    assert "node start" in r.output and "1 error, 0 warnings" in r.output, r.output
    warn = tmp_path / "warn.yaml"
    warn.write_text(yaml.safe_dump(wf(command="echo {{input.nope}}")))
    r = validate_cli(warn)
    assert r.exit_code == 0 and "warning: input.nope: no declared input nope" in r.output and "node say" in r.output, r.output
    assert "0 errors, 1 warning" in r.output, r.output
    junk = tmp_path / "junk.yaml"
    junk.write_text("nodes: [1, 2]\n")
    r = validate_cli(junk)
    assert r.exit_code == 1 and "malformed workflow" in r.output, r.output


@pytest.fixture
def cli_api(monkeypatch):
    """ctc.cli._api recorded: GET /capabilities/<id> returns a graph whose trigger declares topic and count unless
    `free`; POSTs are kept in calls."""
    calls, state = [], {"free": False}

    def api(method, path, **kw):
        if method == "GET" and path.startswith("/capabilities/"):
            trig = {"id": "start", "type": "trigger"} | ({} if state["free"] else {"inputs": [
                {"name": "topic", "type": "string", "required": True}, {"name": "count", "type": "number"}]})
            return {"graph": {"nodes": [trig], "edges": []}}
        calls.append((method, path, kw.get("json")))
        return {"run_id": 7}
    monkeypatch.setattr(ctc.cli, "_api", api)
    return calls, state


def test_ctc_run_posts_typed_inputs_as_strings(cli_api):
    calls, _ = cli_api
    r = CliRunner().invoke(ctc.cli.app, ["run", "p:wf", "--input", "topic=x", "-i", "count=3"])
    assert r.exit_code == 0, r.output
    assert calls == [("POST", "/workflows/p:wf/runs", {"input": "", "inputs": {"topic": "x", "count": "3"}, "project": None,
                                                       "trigger": "cli", "pinned": False})]
    r = CliRunner().invoke(ctc.cli.app, ["run", "p:wf", "--input", "topic"])
    assert r.exit_code == 1 and "use --input name=value; p:wf takes: topic, count" in r.output, r.output


def test_ctc_run_without_declared_inputs_posts_one_free_text(cli_api):
    calls, state = cli_api
    state["free"] = True
    r = CliRunner().invoke(ctc.cli.app, ["run", "p:wf", "--input", "a=b c"])
    assert r.exit_code == 0 and calls[-1][2] == {"input": "a=b c", "project": None, "trigger": "cli", "pinned": False}
    r = CliRunner().invoke(ctc.cli.app, ["run", "p:wf", "-i", "a", "-i", "b"])
    assert r.exit_code == 1 and "p:wf declares no inputs: pass one --input text" in r.output, r.output
