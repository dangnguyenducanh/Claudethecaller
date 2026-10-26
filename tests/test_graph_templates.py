"""US13 (ticket 14, FR-033/034/035/050): template roots run.id/run.visit/run.trigger/now/vars and a workflow `vars:`
block, reference warnings (never blocking), the stop node and the minute settings, at the graph and export seams.
Pure tests, no DB. Engine-seam cases are in tests/test_graph_extras.py."""

import copy
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest
from fastapi import HTTPException

from ctc.runner.export import to_js
from ctc.runner.graph import load, render, validate, warnings
from ctc.server.library import check_graph

ROOT = Path(__file__).resolve().parents[1] / ".claude" / "ctc-workflows"
# start -> test -> green? true -> verdict (switch) -default-> gate -> ship; verdict -minor-> note; green false -> fix -> test
BASE = {"vars": {"greeting": "hi"}, "nodes": [
    {"id": "start", "type": "trigger"},
    {"id": "test", "type": "shell", "command": "pytest -q"},
    {"id": "green", "type": "if", "path": "test.exit_code", "op": "eq", "value": 0},
    {"id": "fix", "type": "agent", "prompt": "Fix: {{test.stdout_tail}}"},
    {"id": "verdict", "type": "switch", "cases": [{"name": "minor", "conditions": [{"path": "test.exit_code", "op": "eq", "value": 0}]}]},
    {"id": "note", "type": "shell", "command": "echo minor"},
    {"id": "gate", "type": "approval", "message": "Ship {{run.branch}}?"},
    {"id": "ship", "type": "shell", "command": "echo shipped"},
], "edges": [
    {"from": "start", "to": "test"}, {"from": "test", "to": "green"},
    {"from": "green", "to": "verdict", "handle": "true"}, {"from": "green", "to": "fix", "handle": "false"},
    {"from": "fix", "to": "test"}, {"from": "verdict", "to": "note", "handle": "minor"},
    {"from": "verdict", "to": "gate", "handle": "default"}, {"from": "gate", "to": "ship"},
]}


def g_with(**fields) -> dict:
    """BASE with node fields changed: g_with(ship={"command": ...}); a None value drops the field."""
    g = copy.deepcopy(BASE)
    for n in g["nodes"]:
        for k, v in fields.get(n["id"], {}).items():
            n.pop(k, None) if v is None else n.update({k: v})
    return load(g)


def warns(g: dict) -> list[tuple[str, str]]:
    assert validate(g) == [], validate(g)  # warnings never block
    return [(w["node_id"], w["message"]) for w in warnings(g)]


def errors(g: dict) -> str:
    return " | ".join(e["message"] for e in validate(load(g)))


# (1) roots and vars

def test_new_roots_validate_and_are_not_node_ids():
    g = g_with(ship={"command": "echo {{run.id}} {{run.visit}} {{run.trigger}} {{now}} {{vars.greeting}}"})
    assert validate(g) == []
    for bad in ("now", "vars"):
        assert f"bad node id {bad!r}" in errors(BASE | {"nodes": BASE["nodes"] + [{"id": bad, "type": "shell", "command": "true"}]})


def test_vars_must_be_a_mapping_of_slugs():
    assert "vars must be a mapping of name: value" in errors(BASE | {"vars": [1]})
    assert "vars must be a mapping of name: value" in errors(BASE | {"vars": {"bad key": 1}})
    assert errors(BASE | {"vars": {"ok_key-2": [1, {"a": None}]}}) == ""


# (2) render

def test_render_fills_each_root():
    ctx = {"run": {"id": 7, "visit": 2, "trigger": "cli", "branch": "b"}, "now": "2026-10-26T09:00:00+00:00",
           "vars": {"greeting": "hi", "list": [1]}}
    assert render("{{run.id}}/{{run.visit}}/{{run.trigger}}/{{now}}/{{vars.greeting}}/{{vars.list}}", ctx) == \
        "7/2/cli/2026-10-26T09:00:00+00:00/hi/[1]"
    assert render("echo {{vars.greeting}} {{now}} {{vars.list}}", ctx | {"vars": {"greeting": "a b", "list": [1]}},
                  shell=True) == "echo 'a b' 2026-10-26T09:00:00+00:00 '[1]'"


# (3) stop node

STOP = {"id": "halt", "type": "stop", "message": "tests failed: {{test.stdout_tail}}"}


def stop_graph(stop: dict, extra_edges=()) -> dict:
    return BASE | {"nodes": BASE["nodes"] + [stop], "edges": BASE["edges"] + [{"from": "note", "to": "halt"}, *extra_edges]}


def test_stop_node():
    assert errors(stop_graph(STOP)) == ""
    assert "a stop node needs a message" in errors(stop_graph(STOP | {"message": ""}))
    assert "a stop node needs a message" in errors(stop_graph({k: v for k, v in STOP.items() if k != "message"}))
    assert "a stop node has no out-edges" in errors(stop_graph(STOP, [{"from": "halt", "to": "ship"}]))


# (4) minute settings

@pytest.mark.parametrize("key", ["max_run_minutes", "approval_timeout_minutes"])
def test_minute_settings(key):
    for ok in (1, 0.01):
        assert errors(BASE | {"settings": {key: ok}}) == ""
    for bad in (0, -1, "5", True):
        assert f"settings.{key} must be a number > 0" in errors(BASE | {"settings": {key: bad}}), bad
    assert errors(BASE | {"settings": {key: None}}) == ""  # an editor save writes null for "no limit"


# (5) warnings

def test_no_warnings_for_refs_that_resolve():
    refs = ("{{test.stdout_tail}} {{test.exit_code}} {{test.stderr_tail}} {{green.value}} {{fix.result}}"
            " {{fix.structured_output.x}} {{verdict.case}} {{gate.approved}} {{gate.note}} {{start.input}} {{vars.greeting}}"
            " {{run.id}} {{run.visit}} {{run.trigger}} {{run.branch}} {{now}} {{input}}")
    assert warns(g_with(ship={"command": f"echo {refs}"})) == []
    assert warns(g_with(test={"command": "pytest -q {{fix.result}}"})) == []  # fix runs before test over the back-edge
    assert warns(load(BASE)) == []


@pytest.mark.parametrize("fields, want", [
    ({"fix": {"prompt": "Shipped? {{ship.stdout_tail}}"}}, ("fix", "ship.stdout_tail: ship cannot run before fix")),
    ({"ship": {"command": "echo {{ship.stdout_tail}}"}}, ("ship", "ship.stdout_tail: ship cannot run before ship")),
    ({"ship": {"command": "echo {{test.stdout}}"}}, ("ship", "test.stdout: a shell node has no field stdout")),
    ({"ship": {"command": "echo {{green.result}}"}}, ("ship", "green.result: a if node has no field result")),
    ({"ship": {"command": "echo {{fix.nope}}"}}, ("ship", "fix.nope: a agent node has no field nope")),
    ({"ship": {"command": "echo {{run.nope}}"}}, ("ship", "run.nope: run has no field nope (branch, id, trigger, visit)")),
    ({"ship": {"command": "echo {{vars.missing}}"}}, ("ship", "vars.missing: no vars entry missing")),
    ({"green": {"path": "test.stdout"}}, ("green", "test.stdout: a shell node has no field stdout")),  # IF paths
    ({"verdict": {"cases": [{"name": "minor", "conditions": [{"path": "gate.approved", "op": "truthy"}]}]}},
     ("verdict", "gate.approved: gate cannot run before verdict")),  # switch case paths
    ({"gate": {"message": "{{note.exit_code}}"}}, ("gate", "note.exit_code: note cannot run before gate")),
])
def test_warnings(fields, want):
    assert warns(g_with(**fields)) == [want]


def test_pinned_and_error_output_fields_do_not_warn():
    assert warns(g_with(test={"pin": {"output": {"foo": 1}}}, ship={"command": "echo {{test.foo}} {{test.exit_code}}"})) == []
    g = load({"nodes": [
        {"id": "start", "type": "trigger"}, {"id": "x", "type": "agent", "prompt": "hi", "on_error": "error_output"},
        {"id": "ok", "type": "shell", "command": "echo {{x.result}}"},
        {"id": "bad", "type": "shell", "command": "echo {{x.error}} {{x.output_tail}} {{x.exit_code}}"},
    ], "edges": [{"from": "start", "to": "x"}, {"from": "x", "to": "ok"}, {"from": "x", "to": "bad", "handle": "error"}]})
    assert warns(g) == []


def test_warnings_never_raise_on_a_broken_graph():
    assert isinstance(warnings(load({"vars": [1], "nodes": [{"id": "a", "type": "shell", "command": "{{nobody.x}} {{run}}"}],
                                     "edges": [{"from": "a", "to": "ghost"}]})), list)


# (6) shipped workflows

def test_shipped_workflows_have_no_errors_or_warnings():
    files = [p for p in sorted(ROOT.glob("*.yaml")) if p.name != "bad-push.yaml"]
    assert files
    for p in files:
        g = load(p)
        assert (validate(g), warnings(g)) == ([], []), p.name


# (7) check_graph

def test_check_graph_returns_warnings_and_puts_them_in_the_422():
    g = g_with(ship={"command": "echo {{test.stdout}}"})
    want = [{"message": "test.stdout: a shell node has no field stdout", "node_id": "ship"}]
    assert check_graph(g) == want
    g["nodes"][1]["command"] = ""  # now also invalid
    with pytest.raises(HTTPException) as e:
        check_graph(g)
    assert e.value.status_code == 422
    assert e.value.detail == {"code": "invalid_graph", "message": "a shell node needs a command", "node_id": "test",
                              "warnings": want}


# (8) export

needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")


def run_js(js: str) -> dict:
    """The exported script under a stub agent(): shells answer exit 0 and stdout_tail = their label, agents 'ok'.
    Same stub as export.py's __main__ run()."""
    stub = ("const calls = [], codes = {}\n"
            "const agent = async (p, o) => (calls.push([o.label, p]), o.schema ? {exit_code: (codes[o.label] || []).shift() ?? 0, stdout_tail: o.label} : 'ok')\n"
            "const parallel = ts => Promise.all(ts.map(t => t()))\n")
    src = (stub + "async function workflow(args) {\n" + js.replace("export const meta", "const meta", 1) + "}\n"
           "workflow(null).then(out => console.log(JSON.stringify({out, calls})), e => console.log(JSON.stringify({error: e.message, calls})))\n")
    with tempfile.NamedTemporaryFile("w", suffix=".js") as f:
        f.write(src)
        f.flush()
        chk = subprocess.run(["node", "--check", f.name], capture_output=True, text=True, check=False)
        assert chk.returncode == 0, chk.stderr
        return json.loads(subprocess.run(["node", f.name], capture_output=True, text=True, check=True).stdout)


def chain(cmd: str, **extra) -> dict:
    """trigger -> a (shell cmd) -> halt (stop 'halted: {{a.stdout_tail}}')."""
    return load({"nodes": [{"id": "start", "type": "trigger"}, {"id": "a", "type": "shell", "command": cmd},
                           {"id": "halt", "type": "stop", "message": "halted: {{a.stdout_tail}}"}],
                 "edges": [{"from": "start", "to": "a"}, {"from": "a", "to": "halt"}]} | extra)


@needs_node
def test_export_vars_now_and_stop():
    g = chain("echo {{vars.greeting}} {{now}} {{run.branch}}", vars={"greeting": "it's"})
    assert validate(g) == [] and warnings(g) == []
    r = run_js(to_js(g, "x"))
    assert r["error"] == "halted: a", r  # the stop node threw its rendered message
    cmd = r["calls"][0][1]
    # vars filled and shell-quoted, now an ISO string in the engine's format, run.branch empty as before
    assert re.fullmatch(r"Run exactly .*: echo 'it'\\''s' '\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00' ''", cmd), cmd


@pytest.mark.parametrize("ref", ["run.id", "run.visit", "run.trigger"])
def test_export_refuses_run_roots(ref):
    with pytest.raises(ValueError, match=ref.replace(".", r"\.")):
        to_js(chain(f"echo {{{{{ref}}}}}"), "x")


def test_export_refuses_max_run_minutes():
    with pytest.raises(ValueError, match="max_run_minutes"):
        to_js(chain("true", settings={"max_run_minutes": 5}), "x")
    assert to_js(chain("true", settings={"approval_timeout_minutes": 5, "max_run_minutes": None}), "x")
