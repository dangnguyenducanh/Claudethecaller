"""US10: runner defects caught by the graph validator (resume_from, shell readonly) and batch(). Pure graph tests, no DB."""

import copy
from pathlib import Path

import pytest

from ctc.runner.graph import batch, load, validate

ROOT = Path(__file__).resolve().parents[1] / ".claude" / "ctc-workflows"

# start -> plan -> build -> test -> green?; true -> ship, doc; false -> fix -> test (back-edge)
BASE = {
    "nodes": [
        {"id": "start", "type": "trigger"},
        {"id": "plan", "type": "agent", "prompt": "p"},
        {"id": "build", "type": "agent", "prompt": "b"},
        {"id": "test", "type": "shell", "command": "pytest -q"},
        {"id": "green", "type": "if", "path": "test.exit_code", "op": "eq", "value": 0},
        {"id": "ship", "type": "shell", "command": "echo ok"},
        {"id": "doc", "type": "agent", "prompt": "d"},
        {"id": "fix", "type": "agent", "prompt": "f"},
    ],
    "edges": [
        {"from": "start", "to": "plan"}, {"from": "plan", "to": "build"}, {"from": "build", "to": "test"},
        {"from": "test", "to": "green"}, {"from": "green", "to": "ship", "handle": "true"},
        {"from": "green", "to": "doc", "handle": "true"}, {"from": "green", "to": "fix", "handle": "false"},
        {"from": "fix", "to": "test"},
    ],
}

# start -> a -> b -> chk?; false -> a (back-edge), true -> end
LOOP = {
    "nodes": [
        {"id": "start", "type": "trigger"}, {"id": "a", "type": "agent", "prompt": "a"},
        {"id": "b", "type": "agent", "prompt": "b"}, {"id": "chk", "type": "if", "path": "b.x", "op": "truthy"},
        {"id": "end", "type": "shell", "command": "echo done"},
    ],
    "edges": [
        {"from": "start", "to": "a"}, {"from": "a", "to": "b"}, {"from": "b", "to": "chk"},
        {"from": "chk", "to": "a", "handle": "false"}, {"from": "chk", "to": "end", "handle": "true"},
    ],
}


def with_fields(g: dict, nid: str, **fields) -> list[dict]:
    """validate() of a copy of g where node nid also carries fields."""
    g2 = copy.deepcopy(g)
    next(n for n in g2["nodes"] if n["id"] == nid).update(fields)
    return validate(load(g2))


def test_base_graphs_validate():
    assert validate(load(BASE)) == []
    assert validate(load(LOOP)) == []


@pytest.mark.parametrize("nid, rf", [("build", "plan"), ("fix", "build")])  # fix: ancestor through test and green
def test_resume_from_an_agent_that_runs_before(nid, rf):
    assert with_fields(BASE, nid, resume_from=rf) == []


@pytest.mark.parametrize("nid, rf", [
    ("build", "fix"),  # downstream
    ("plan", "build"),  # downstream
    ("build", "build"),  # itself
    ("build", "ghost"),  # missing
    ("build", "test"),  # a shell has no session
    ("fix", "doc"),  # the other IF branch
    ("build", ["plan"]),  # not a node id: an error, not a raise
])
def test_resume_from_that_cannot_run_before_is_rejected(nid, rf):
    errs = with_fields(BASE, nid, resume_from=rf)
    assert len(errs) == 1 and errs[0]["node_id"] == nid and "resume_from" in errs[0]["message"], errs


def test_resume_from_across_a_back_edge():
    errs = with_fields(LOOP, "a", resume_from="b")  # b runs before a only over the back-edge
    assert len(errs) == 1 and errs[0]["node_id"] == "a" and "resume_from" in errs[0]["message"], errs
    assert with_fields(LOOP, "b", resume_from="a") == []


def test_readonly_on_a_shell_is_rejected():
    errs = with_fields(BASE, "test", readonly=True)
    assert len(errs) == 1 and errs[0]["node_id"] == "test" and "readonly" in errs[0]["message"], errs
    errs = validate(load(BASE | {"defaults": {"readonly": True}}))  # defaults reach every node
    assert {e["node_id"] for e in errs} == {"test", "ship"} and all("readonly" in e["message"] for e in errs), errs


def test_readonly_on_an_agent_validates():
    assert with_fields(BASE, "doc", readonly=True) == []


def test_only_readonly_agents_batch():
    g = {"nodes": [  # raw, not validated: the shells still carry readonly
        {"id": "ra", "type": "agent", "readonly": True}, {"id": "rb", "type": "agent", "readonly": True},
        {"id": "s1", "type": "shell", "readonly": True}, {"id": "s2", "type": "shell", "readonly": True},
    ], "edges": []}
    assert batch(g, ["s1", "s2", "ra", "rb"]) == ["ra", "rb"]
    assert batch(g, ["s1", "s2"]) == ["s1"]  # one shell at a time


def test_example_workflows_validate():
    files = sorted(ROOT.glob("*.yaml"))
    for p in files:
        g = load(p)
        assert not [n["id"] for n in g["nodes"] if n.get("type") == "shell" and n.get("readonly")], p.name
        if p.name != "bad-push.yaml":
            assert validate(g) == [], (p.name, validate(g))
    assert "approval" in validate(load(ROOT / "bad-push.yaml"))[0]["message"]
