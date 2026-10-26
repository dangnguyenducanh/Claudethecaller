"""Polish T164 (FR-050, SC-007): every example workflow validates and either exports or is refused with a
`<code>: <node ids>` reason; every n8n-parity node type and setting either translates or is refused, never another
exception; the native script branches and retries as the walker does. (1) and (2) are DB-free; (3) runs parity-demo
at the engine seam and skips without a scratch DB."""

import itertools
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from ctc.runner.export import to_js
from ctc.runner.graph import eval_if, load, validate, warnings

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = sorted((ROOT / ".claude" / "ctc-workflows").glob("*.yaml"))
REASON = re.compile(r"^[a-z_]+: ")
needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")


def run_js(js: str, codes: dict | None = None, args=None, throws=()) -> dict:
    """node --check, then the script under a stub agent() wrapped as export.py's __main__ run() does: shells answer
    exit codes from codes[label] (else 0) and stdout_tail = label, agents 'ok', agents labelled in `throws` throw."""
    stub = (f"const calls = [], codes = {json.dumps(codes or {})}, throws = {json.dumps(list(throws))}\n"
            "const agent = async (p, o) => { calls.push([o.label, p]); if (throws.includes(o.label)) throw new Error('boom ' + o.label)\n"
            "  return o.schema ? {exit_code: (codes[o.label] || []).shift() ?? 0, stdout_tail: o.label} : 'ok' }\n"
            "const parallel = ts => Promise.all(ts.map(t => t()))\n")
    src = (stub + "async function workflow(args) {\n" + js.replace("export const meta", "const meta", 1) + "}\n"
           f"workflow({json.dumps(args)}).then(out => console.log(JSON.stringify({{out, calls}})), "
           "e => console.log(JSON.stringify({error: e.message, calls})))\n")
    with tempfile.NamedTemporaryFile("w", suffix=".js") as f:
        f.write(src)
        f.flush()
        chk = subprocess.run(["node", "--check", f.name], capture_output=True, text=True, check=False)
        assert chk.returncode == 0, chk.stderr
        return json.loads(subprocess.run(["node", f.name], capture_output=True, text=True, check=True).stdout)


def exported(g: dict, name: str) -> str | None:
    """to_js -> the script (node --check'ed when node is installed), or None for a refusal with a reason code."""
    try:
        js = to_js(g, name)
    except ValueError as e:
        assert REASON.match(str(e)), f"refusal without a `<code>: ` reason: {e}"
        return None
    assert js.startswith("export const meta"), js[:80]
    if shutil.which("node"):
        with tempfile.NamedTemporaryFile("w", suffix=".js") as f:
            f.write("async function workflow(args) {\n" + js.replace("export const meta", "const meta", 1) + "}\n")
            f.flush()
            chk = subprocess.run(["node", "--check", f.name], capture_output=True, text=True, check=False)
            assert chk.returncode == 0, chk.stderr
    return js


# (1) the shipped examples


@pytest.mark.parametrize("p", EXAMPLES, ids=lambda p: p.stem)
def test_example_validates_and_exports_or_is_refused(p):
    g = load(p)
    if p.name == "bad-push.yaml":  # a deliberate negative example
        assert validate(g) == [{"message": "git push / gh pr create|merge must sit behind an approval node", "node_id": "push"}]
        return
    assert validate(g) == []
    exported(g, p.stem)


def test_parity_demo_has_no_warnings_and_is_refused_for_its_foreach():
    g = load(ROOT / ".claude" / "ctc-workflows" / "parity-demo.yaml")
    assert validate(g) == [] and warnings(g) == []
    with pytest.raises(ValueError, match=r"^has_foreach: "):
        to_js(g, "parity-demo")


# (2) the feature matrix: one small graph per node type / setting

def chain(*mid: dict, edges: list | None = None, **extra) -> dict:
    """trigger `start` -> the given nodes in a line (unless edges are given) -> nothing."""
    nodes = [{"id": "start", "type": "trigger"}, *mid]
    return load({"nodes": nodes, "edges": edges if edges is not None else [
        {"from": a["id"], "to": b["id"]} for a, b in itertools.pairwise(nodes)]} | extra)


SH = {"type": "shell", "command": "true"}
FLAKY = {"id": "flaky", "type": "shell", "command": "make test", "idempotent": True, "retry": {"max_tries": 3, "wait_s": 0}}
IFOR = {"id": "ok", "type": "if", "combine": "or", "conditions": [
    {"path": "a.exit_code", "op": "eq", "value": 0}, {"path": "a.stdout_tail", "op": "contains", "value": "PASS"}]}
SWITCH = {"id": "sev", "type": "switch", "cases": [
    {"name": "major", "conditions": [{"path": "a.exit_code", "op": "ge", "value": 2}]},
    {"name": "minor", "conditions": [{"path": "a.exit_code", "op": "eq", "value": 1}]}]}
MATRIX = {  # name -> (graph, the reason code when refused, else None)
    "disabled": (chain({"id": "a", **SH, "disabled": True}, {"id": "b", **SH}), None),
    "error_output": (chain({"id": "a", **SH, "on_error": "error_output"}, {"id": "b", **SH}, {"id": "fix", **SH}, edges=[
        {"from": "start", "to": "a"}, {"from": "a", "to": "b"}, {"from": "a", "to": "fix", "handle": "error"}]), "error_edge"),
    "on_error_continue": (chain({"id": "a", **SH, "on_error": "continue"}, {"id": "ag", "type": "agent", "prompt": "x",
                                                                           "on_error": "continue"}, {"id": "b", **SH}), None),
    "retry": (chain(FLAKY, {"id": "b", **SH}), None),
    "pin": (chain({"id": "a", **SH, "pin": {"output": {"exit_code": 0, "stdout_tail": "pinned"}}}), None),
    "notes": (chain({"id": "a", **SH, "notes": "why this runs"}), None),
    "if_conditions_or": (chain({"id": "a", **SH}, IFOR, {"id": "y", **SH}, {"id": "n", **SH}, edges=[
        {"from": "start", "to": "a"}, {"from": "a", "to": "ok"}, {"from": "ok", "to": "y", "handle": "true"},
        {"from": "ok", "to": "n", "handle": "false"}]), None),
    "switch": (chain({"id": "a", **SH}, SWITCH, *({"id": h, **SH} for h in ("hi", "lo", "dflt")), edges=[
        {"from": "start", "to": "a"}, {"from": "a", "to": "sev"}, {"from": "sev", "to": "hi", "handle": "major"},
        {"from": "sev", "to": "lo", "handle": "minor"}, {"from": "sev", "to": "dflt", "handle": "default"}]), None),
    "foreach": (chain({"id": "list", "type": "shell", "command": "echo '[1]'"}, {"id": "each", "type": "foreach", "items": "list.stdout_tail"},
                      {"id": "body", "type": "shell", "command": "echo {{item}}"}, edges=[
        {"from": "start", "to": "list"}, {"from": "list", "to": "each"}, {"from": "each", "to": "body", "handle": "body"},
        {"from": "body", "to": "each"}]), "has_foreach"),
    "stop": (chain({"id": "a", **SH}, {"id": "halt", "type": "stop", "message": "halted: {{a.stdout_tail}}"}), None),
    "vars": (chain({"id": "a", "type": "shell", "command": "echo {{vars.x}}"}, vars={"x": "hi"}), None),
    "run_id": (chain({"id": "a", "type": "shell", "command": "echo {{run.id}}"}), "uses_run_root"),
    "inputs": (chain({"id": "a", "type": "shell", "command": "echo {{input.name}}"}) | {"nodes": [
        {"id": "start", "type": "trigger", "inputs": [{"name": "name", "type": "string", "default": "x"}]},
        {"id": "a", "type": "shell", "command": "echo {{input.name}}"}]}, None),
    "max_run_minutes": (chain({"id": "a", **SH}, settings={"max_run_minutes": 5}), "has_run_timeout"),
    "approval_timeout_minutes": (chain({"id": "a", **SH}, settings={"approval_timeout_minutes": 5}), None),
    "notify": (chain({"id": "a", **SH}, settings={"notify": "notify-send done"}), None),
    "loop_not_one_block": (chain({"id": "a", **SH}, {"id": "x", **SH}, {"id": "b", **SH}, edges=[
        {"from": "start", "to": "a"}, {"from": "start", "to": "x"}, {"from": "a", "to": "b"}, {"from": "x", "to": "b"},
        {"from": "b", "to": "a"}]), "loop_not_one_block"),
}


@pytest.mark.parametrize("name", MATRIX)
def test_every_feature_translates_or_is_refused_with_a_reason(name):
    g, code = MATRIX[name]
    assert validate(g) == [], validate(g)
    js = exported(g, name)  # any other exception fails here
    if code:
        with pytest.raises(ValueError, match=rf"^{code}: "):
            to_js(g, name)
    else:
        assert js is not None


@needs_node
def test_a_retried_shell_runs_again_until_it_exits_0():
    r = run_js(to_js(MATRIX["retry"][0], "retry"), {"flaky": [1, 1, 0]})
    assert "error" not in r and [c[0] for c in r["calls"]] == ["flaky"] * 3 + ["b"], r
    assert r["out"]["flaky"]["exit_code"] == 0


@needs_node
def test_a_retried_shell_that_never_exits_0_fails_the_run_as_the_walker_does():
    r = run_js(to_js(MATRIX["retry"][0], "retry"), {"flaky": [1, 1, 1, 0]})
    assert r["error"].startswith("exit 1 on try 3/3") and [c[0] for c in r["calls"]] == ["flaky"] * 3, r


@needs_node
def test_retry_waits_wait_s_before_each_later_try():
    g = chain(FLAKY | {"retry": {"max_tries": 2, "wait_s": 7}})
    r = run_js(to_js(g, "retry"), {"flaky": [1, 0]})
    assert r["calls"][0][1].endswith(": make test") and r["calls"][1][1].endswith(": sleep 7; make test"), r["calls"]


@needs_node
def test_on_error_continue_walks_on_after_a_failure():
    g = chain(FLAKY | {"on_error": "continue"}, {"id": "ag", "type": "agent", "prompt": "x", "on_error": "continue"},
              {"id": "b", **SH})
    r = run_js(to_js(g, "cont"), {"flaky": [1, 1, 1]}, throws=["ag"])
    assert "error" not in r and [c[0] for c in r["calls"]] == ["flaky"] * 3 + ["ag", "b"], r
    assert r["out"]["flaky"]["exit_code"] == 1 and r["out"]["ag"]["is_error"] is True, r
    r = run_js(to_js(chain({"id": "ag", "type": "agent", "prompt": "x"}, {"id": "b", **SH}), "stop"), throws=["ag"])
    assert r["error"] == "boom ag" and [c[0] for c in r["calls"]] == ["ag"], r  # default stop: the run fails


# the walker's condition semantics, Python -> JS: (path under input, value at that path, op, condition value)
PARITY = [
    ("x", {"a": 1}, "contains", "a"),  # a dict: key membership, not text
    ("x", {"a": 1}, "contains", "1"),
    ("x", {"ab": 1}, "contains", "b"),
    ("x", {"a": 1}, "contains", None),
    ("x", {"a": 1}, "not_contains", "1"),
    ("x", {"a": 1}, "not_contains", ["a"]),  # Python's TypeError: false for both ops
    ("x", [{"a": 1}, 2], "contains", {"a": 1}),  # a list: Python == per item
    ("x", [1, 2], "contains", True),
    ("x", ["a", "b"], "not_contains", "c"),
    ("x", "abc", "contains", "b"),
    ("x", {"a": 1, "b": 2}, "eq", {"b": 2, "a": 1}),  # objects: structural, key order free
    ("x", {"a": 1}, "ne", {"a": 2}),
    ("x", [1, 2], "eq", "[1, 2]"),  # rendered text as Python's json.dumps
    ("x", [1, 2], "eq", "[1,2]"),
    ("x", {"k": "é"}, "eq", '{"k": "\\u00e9"}'),
    ("x", True, "eq", 1),
    ("x", 0, "eq", False),
    ("x", True, "eq", "true"),
    ("x", 5, "gt", "3"),
    ("x", None, "exists", None),
    ("x", {}, "truthy", None),
    ("x.length", [1, 2], "exists", None),  # no JS-only properties
    ("x.constructor", {"a": 1}, "exists", None),
    ("x.0", "ab", "exists", None),
    ("x.1", [5, 6], "eq", 6),
]


@needs_node
def test_conditions_branch_as_the_walker_does():
    n = len(PARITY)
    ifs = [{"id": f"c{i}", "type": "if", "conditions": [{"path": f"input.{path}", "op": op, "value": want}]}
           for i, (path, _, op, want) in enumerate(PARITY)]
    edges = [{"from": "start", "to": "c0"}] + [{"from": f"c{i}", "to": f"c{i + 1}" if i + 1 < n else "end", "handle": h}
                                               for i in range(n) for h in ("true", "false")]
    g = chain(*ifs, {"id": "end", "type": "merge"}, edges=edges)
    assert validate(g) == [], validate(g)
    for k, (path, v, op, want) in enumerate(PARITY):  # one run per value: each sets input.x
        py = eval_if(ifs[k], {"input": {"x": v}})
        r = run_js(to_js(g, "parity"), args={"x": v})
        assert r["out"][f"c{k}"]["value"] is py, (PARITY[k], py, r["out"][f"c{k}"])


# (3) the engine seam


def test_parity_demo_runs_to_done(run_yaml):
    run, steps = run_yaml((ROOT / ".claude" / "ctc-workflows" / "parity-demo.yaml").read_text())
    assert run["status"] == "done", (run["error"], [(s["node_id"], s["status"], s["error"]) for s in steps])
    by = {}
    for s in steps:
        by.setdefault(s["node_id"], []).append(s)
    assert by["flaky"][0]["tries"] == 2 and by["skipped"][0]["marker"] == "disabled", by
    assert [s["output"]["stdout_tail"].strip() for s in by["greet"] if s["status"] == "done"] == ["a 0", "b 1", "c 2"]
    assert {s["status"] for s in by.get("halt", []) + by.get("other", [])} <= {"skipped"}, by  # IF true, case go
    assert by["bye"][0]["output"]["stdout_tail"].strip() == f"hi {run['id']}"
