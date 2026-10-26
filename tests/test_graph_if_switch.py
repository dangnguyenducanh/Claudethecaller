"""US11: richer IF (conditions + combine, more ops) and a Switch node. Pure graph tests, no DB."""

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from ctc.runner.export import to_js
from ctc.runner.graph import complete, eval_if, eval_switch, load, ready, validate

ROOT = Path(__file__).resolve().parents[1] / ".claude" / "ctc-workflows"


def test_shipped_workflows_still_validate():
    files = [p for p in sorted(ROOT.glob("*.yaml")) if p.name != "bad-push.yaml"]
    assert files
    for p in files:
        assert validate(load(p)) == [], p.name


def test_old_single_condition_if_is_unchanged():
    assert eval_if({"path": "t.code", "op": "eq", "value": "0"}, {"t": {"code": 0}})
    assert not eval_if({"path": "t.nope", "op": "ne", "value": 1}, {"t": {}})
    assert eval_if({"path": "t.out", "op": "contains", "value": "PASS"}, {"t": {"out": "3 PASS"}})
    assert not eval_if({"path": "t.out", "op": "contains", "value": [1]}, {"t": {"out": {"a": 1}}})


def one(op, value, v):
    """eval_if of a single condition `t.v <op> value` over ctx {t: {v: v}}."""
    return eval_if({"conditions": [{"path": "t.v", "op": op, "value": value}]}, {"t": {"v": v}})


@pytest.mark.parametrize("v, op, value, want", [
    ("10", "gt", 9, True), ("9.5", "le", "9.5", True), (" 3 ", "lt", 4, True), (3, "ge", 3, True),
    ("1e3", "gt", 999, True), (-2, "lt", "-1", True), (2, "gt", 2, False),
    ("abc", "gt", 1, False), (True, "gt", 0, False), (None, "ge", 0, False), (5, "lt", "x", False),
    (["a", "b"], "contains", "a", True), (["a", "b"], "not_contains", "c", True), (["a", "b"], "not_contains", "a", False),
    ("3 PASS", "contains", "PASS", True), ("3 PASS", "not_contains", "FAIL", True), ("3 PASS", "not_contains", "PASS", False),
    ("3 passed", "regex", r"^\d+ passed$", True), ("3 failed", "regex", r"^\d+ passed$", False), (42, "regex", "^4", True),
    (0, "exists", None, True), (None, "exists", None, False),
    ([1], "truthy", None, True), ([], "truthy", None, False), (0, "truthy", None, False),
    (0, "eq", "0", True), (0, "ne", "0", False), (1, "ne", "0", True), ("ok", "eq", "ok", True),
])
def test_each_op(v, op, value, want):
    assert one(op, value, v) is want


@pytest.mark.parametrize("op", ["eq", "ne", "gt", "ge", "lt", "le", "contains", "not_contains", "regex", "exists", "truthy"])
def test_every_op_is_false_on_a_missing_path(op):
    assert eval_if({"conditions": [{"path": "t.nope", "op": op, "value": "x"}]}, {"t": {}}) is False


def test_combine_and_is_the_default_and_or_needs_one():
    ctx = {"test": {"exit_code": 1, "stdout_tail": "3 PASS"}}
    conds = [{"path": "test.exit_code", "op": "eq", "value": 0}, {"path": "test.stdout_tail", "op": "regex", "value": "PASS"}]
    assert eval_if({"conditions": conds}, ctx) is False
    assert eval_if({"conditions": conds, "combine": "and"}, ctx) is False
    assert eval_if({"conditions": conds, "combine": "or"}, ctx) is True
    assert eval_if({"conditions": conds, "combine": "or"}, {"test": {"exit_code": 1, "stdout_tail": "FAIL"}}) is False
    assert eval_if({"conditions": conds}, {"test": {"exit_code": 0, "stdout_tail": "PASS"}}) is True


def if_graph(**node) -> dict:
    """trigger -> test(shell) -> green(if, **node) -> ok / ko."""
    return load({"nodes": [
        {"id": "start", "type": "trigger"}, {"id": "test", "type": "shell", "command": "pytest -q"},
        {"id": "green", "type": "if", **node},
        {"id": "ok", "type": "shell", "command": "true"}, {"id": "ko", "type": "shell", "command": "false"},
    ], "edges": [
        {"from": "start", "to": "test"}, {"from": "test", "to": "green"},
        {"from": "green", "to": "ok", "handle": "true"}, {"from": "green", "to": "ko", "handle": "false"},
    ]})


def errors(g: dict) -> str:
    return " | ".join(e["message"] for e in validate(g))


def test_if_conditions_validate():
    ok = [{"path": "test.exit_code", "op": "eq", "value": 0}, {"path": "test.stdout_tail", "op": "regex", "value": "PASS"}]
    assert errors(if_graph(conditions=ok, combine="or")) == ""
    assert errors(if_graph(conditions=ok)) == ""
    assert errors(if_graph(path="test.exit_code", op="eq", value=0)) == ""  # the old form


@pytest.mark.parametrize("node, want", [
    ({"conditions": [{"path": "test.exit_code", "op": "between", "value": 1}]}, "unknown op 'between'"),
    ({"conditions": []}, "conditions must be a non-empty list"),
    ({"conditions": [{"op": "eq", "value": 0}]}, "condition 1 needs a path"),
    ({"conditions": [{"path": "test.stdout_tail", "op": "regex", "value": "("}]}, "bad regex '('"),
    ({"conditions": [{"path": "test.stdout_tail", "op": "regex"}]}, "a regex needs a value"),
    ({"conditions": [{"path": "test.exit_code", "op": "eq", "value": 0}], "combine": "xor"}, "combine must be and or or"),
    ({"conditions": [{"path": "test.exit_code", "op": "eq", "value": 0}], "path": "test.exit_code", "op": "eq"},
     "use either path/op/value or conditions, not both"),
    ({"conditions": ["test.exit_code"]}, "condition 1 must be a mapping"),
    ({"conditions": "test.exit_code eq 0"}, "conditions must be a non-empty list"),
    ({"conditions": [{"path": "nobody.x", "op": "truthy"}]}, "nobody.x names no node"),
    ({"path": "test.exit_code", "op": "between"}, "an if node needs a path and an op"),
])
def test_bad_if_conditions_are_rejected(node, want):
    msg = errors(if_graph(**node))
    assert want in msg, msg


CASES = [  # a review verdict: major when 2+ blockers or the word BLOCKER, minor at 1, nit when the summary says so
    {"name": "major", "combine": "or", "conditions": [{"path": "review.blockers", "op": "ge", "value": 2},
                                                      {"path": "review.summary", "op": "contains", "value": "BLOCKER"}]},
    {"name": "minor", "conditions": [{"path": "review.blockers", "op": "eq", "value": 1}]},
    {"name": "nit", "conditions": [{"path": "review.summary", "op": "contains", "value": "nit"}]},
]


@pytest.mark.parametrize("review, want", [
    ({"blockers": 3, "summary": "nit: naming"}, "major"),  # major and nit both match: the first case wins
    ({"blockers": "0", "summary": "a BLOCKER"}, "major"),
    ({"blockers": 1, "summary": "nit"}, "minor"),
    ({"blockers": 0, "summary": "one nit"}, "nit"),
    ({"blockers": 0, "summary": "lgtm"}, "default"),
    ({}, "default"),
])
def test_eval_switch_first_match_else_default(review, want):
    assert eval_switch({"type": "switch", "cases": CASES}, {"review": review}) == want


def switch_graph(cases=CASES, extra_edges=()) -> dict:
    """trigger -> review(agent) -> verdict(switch) -> a / b / c / d over major, minor, nit and default."""
    return load({"nodes": [
        {"id": "start", "type": "trigger"}, {"id": "review", "type": "agent", "prompt": "Review"},
        {"id": "verdict", "type": "switch", "cases": cases},
        *({"id": x, "type": "shell", "command": "true"} for x in "abcd"),
    ], "edges": [
        {"from": "start", "to": "review"}, {"from": "review", "to": "verdict"},
        {"from": "verdict", "to": "a", "handle": "major"}, {"from": "verdict", "to": "b", "handle": "minor"},
        {"from": "verdict", "to": "c", "handle": "nit"}, {"from": "verdict", "to": "d", "handle": "default"},
        *extra_edges,
    ]})


def test_switch_fires_exactly_one_handle():
    g, st = switch_graph(), {}
    assert validate(g) == []
    for nid, out in (("start", {}), ("review", {"result": "ok"}), ("verdict", {"case": "minor"})):
        assert ready(g, st) == [nid], st
        assert complete(g, st, nid, out) is None
    assert st["inbox"] == {"b": {"3": "data"}} and sorted(st["deferred"]) == [2, 4, 5], st
    assert ready(g, st) == ["b"]
    complete(g, st, "b", {"exit_code": 0})
    assert ready(g, st) == [] and sorted(st["skipped"]) == ["a", "c", "d"], st  # quiescence: deferred edges skip


def test_switch_default_fires_when_no_case_matched():
    g, st = switch_graph(), {}
    for nid, out in (("start", {}), ("review", {}), ("verdict", {"case": "default"})):
        ready(g, st)
        complete(g, st, nid, out)
    assert ready(g, st) == ["d"]


def renamed(i, **case):
    return [c | case if j == i else c for j, c in enumerate(CASES)]


@pytest.mark.parametrize("g, want", [
    (switch_graph(renamed(1, name="major")), "duplicate case name major"),
    (switch_graph(renamed(2, name="Bad Name")), "bad case name 'Bad Name'"),
    (switch_graph(renamed(2, name="Major")), "bad case name 'Major'"),
    (switch_graph(renamed(2, name="default")), "bad case name 'default'"),
    (switch_graph([]), "a switch node needs cases"),
    (switch_graph(renamed(2, conditions=[])), "case nit: conditions must be a non-empty list"),
    (switch_graph(renamed(2, conditions=[{"path": "review.summary", "op": "regex", "value": "("}])), "bad regex"),
    (switch_graph(renamed(0, conditions=[{"path": "nobody.x", "op": "truthy"}])), "nobody.x names no node"),
    (switch_graph(extra_edges=[{"from": "verdict", "to": "a", "handle": "huge"}]), "switch edge handle huge is not a case name"),
    (switch_graph(extra_edges=[{"from": "verdict", "to": "a"}]), "switch edge handle none is not a case name"),
])
def test_bad_switches_are_rejected(g, want):
    msg = errors(g)
    assert want in msg, msg


def test_a_switch_may_branch_inside_a_loop():
    g = load({"nodes": [
        {"id": "start", "type": "trigger"}, {"id": "test", "type": "shell", "command": "pytest -q"},
        {"id": "verdict", "type": "switch", "cases": [{"name": "red", "conditions": [{"path": "test.exit_code", "op": "ne", "value": 0}]}]},
        {"id": "fix", "type": "agent", "prompt": "fix {{test.stdout_tail}}"}, {"id": "done", "type": "shell", "command": "true"},
    ], "edges": [
        {"from": "start", "to": "test"}, {"from": "test", "to": "verdict"},
        {"from": "verdict", "to": "fix", "handle": "red"}, {"from": "fix", "to": "test"},
        {"from": "verdict", "to": "done", "handle": "default"},
    ]})
    assert validate(g) == []


def run_js(js: str, codes: dict) -> dict:
    """node --check, then run the exported script with a stub agent(): shells answer exit codes from codes[label]
    (else 0) and stdout_tail = their label, agents 'ok'. Same stub as export.py's __main__ run()."""
    stub = (f"const calls = [], codes = {json.dumps(codes)}\n"
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


def verdict_graph(verdict: dict, handles: list[str]) -> dict:
    """trigger -> test(shell) -> verdict -> one shell per handle, named after it."""
    return load({"nodes": [
        {"id": "start", "type": "trigger"}, {"id": "test", "type": "shell", "command": "pytest -q"},
        {"id": "verdict", **verdict}, *({"id": f"on-{h}", "type": "shell", "command": "true"} for h in handles),
    ], "edges": [
        {"from": "start", "to": "test"}, {"from": "test", "to": "verdict"},
        *({"from": "verdict", "to": f"on-{h}", "handle": h} for h in handles),
    ]})


needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
GREEN = [{"path": "test.exit_code", "op": "eq", "value": 0}, {"path": "test.stdout_tail", "op": "contains", "value": "PASS"}]


@needs_node
@pytest.mark.parametrize("combine, code, want", [("or", 1, "false"), ("or", 0, "true"), ("and", 0, "false"), (None, 0, "false")])
def test_export_if_conditions(combine, code, want):
    g = verdict_graph({"type": "if", "conditions": GREEN, **({"combine": combine} if combine else {})}, ["true", "false"])
    assert validate(g) == []
    ctx = {"test": {"exit_code": code, "stdout_tail": "test"}}  # what the stub's shell answers
    assert str(eval_if(g["nodes"][2], ctx)).lower() == want  # the walker's pick
    r = run_js(to_js(g, "if-conds"), {"test": [code]})
    assert [c[0] for c in r["calls"]] == ["test", f"on-{want}"], r


SEVERITY = [{"name": "major", "conditions": [{"path": "test.exit_code", "op": "ge", "value": "2"}]},
            {"name": "minor", "conditions": [{"path": "test.exit_code", "op": "eq", "value": 1}]}]


@needs_node
@pytest.mark.parametrize("code, want", [(1, "minor"), (3, "major"), (0, "default")])
def test_export_switch(code, want):
    g = verdict_graph({"type": "switch", "cases": SEVERITY}, ["major", "minor", "default"])
    assert validate(g) == []
    assert eval_switch(g["nodes"][2], {"test": {"exit_code": code, "stdout_tail": "test"}}) == want  # the walker's pick
    r = run_js(to_js(g, "severity"), {"test": [code]})
    assert [c[0] for c in r["calls"]] == ["test", f"on-{want}"] and r["out"]["verdict"] == {"case": want}, r


@pytest.mark.parametrize("verdict, handles", [
    ({"type": "if", "conditions": [{"path": "test.stdout_tail", "op": "regex", "value": "PASS"}]}, ["true", "false"]),
    ({"type": "switch", "cases": [{"name": "red", "conditions": [{"path": "test.stdout_tail", "op": "regex", "value": "FAIL"}]}]},
     ["red", "default"]),
])
def test_export_refuses_regex_conditions(verdict, handles):
    g = verdict_graph(verdict, handles)
    assert validate(g) == []
    with pytest.raises(ValueError, match="regex"):
        to_js(g, "re")
