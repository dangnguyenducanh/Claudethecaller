"""US15: the editor's rename rewrites every reference to the old id, and node notes are validated. Pure graph tests, no DB."""

import copy

from ctc.runner.graph import load, rename_node, validate


def wf() -> dict:
    return load({"nodes": [
        {"id": "start", "type": "trigger"},
        {"id": "fix", "type": "agent", "prompt": "Goal {{input}}"},
        {"id": "test", "type": "shell", "command": "pytest; echo {{fix.result}} {{ fix.so.k.0 }}"},
        {"id": "green", "type": "if", "path": "fix.result", "op": "truthy"},
        {"id": "ship", "type": "shell", "command": "echo {{fix}} {{run.branch}}"},
        {"id": "gate", "type": "approval", "message": "{{fix.result}} ok?"},
        {"id": "again", "type": "agent", "prompt": "x", "resume_from": "fix"},
    ], "edges": [
        {"from": "start", "to": "fix"}, {"from": "fix", "to": "test"}, {"from": "test", "to": "green"},
        {"from": "green", "to": "ship", "handle": "true"}, {"from": "green", "to": "gate", "handle": "false"},
        {"from": "ship", "to": "again"},
    ]})


def node(g: dict, nid: str) -> dict:
    return next(n for n in g["nodes"] if n["id"] == nid)


def test_rename_rewrites_id_edges_templates_and_paths():
    g = wf()
    before = copy.deepcopy(g)
    g2 = rename_node(g, "fix", "repair")
    assert g == before  # the input is not mutated
    ids = [n["id"] for n in g2["nodes"]]
    assert "repair" in ids and "fix" not in ids
    assert [(e["from"], e["to"], e.get("handle")) for e in g2["edges"]] == [
        ("start", "repair", None), ("repair", "test", None), ("test", "green", None),
        ("green", "ship", "true"), ("green", "gate", "false"), ("ship", "again", None)]
    assert node(g2, "test")["command"] == "pytest; echo {{repair.result}} {{ repair.so.k.0 }}"  # spacing and tail kept
    assert node(g2, "ship")["command"] == "echo {{repair}} {{run.branch}}"
    assert node(g2, "gate")["message"] == "{{repair.result}} ok?"
    assert node(g2, "repair")["prompt"] == "Goal {{input}}"
    assert node(g2, "green")["path"] == "repair.result"
    assert node(g2, "again")["resume_from"] == "repair"
    assert validate(g2) == []


def test_rename_walks_nested_condition_paths_and_leaves_lookalikes():
    g = wf()
    node(g, "green").pop("path")
    node(g, "green").pop("op")
    node(g, "green")["conditions"] = [{"path": "fix.result", "op": "eq", "value": 1}]
    node(g, "ship")["command"] = "echo {{fixer.x}} {{fix.y}}"
    g2 = rename_node(g, "fix", "repair")
    assert node(g2, "green")["conditions"] == [{"path": "repair.result", "op": "eq", "value": 1}]
    assert node(g2, "ship")["command"] == "echo {{fixer.x}} {{repair.y}}"  # {{fixer.x}} names another node


def test_notes_must_be_text():
    g = wf()
    node(g, "test")["notes"] = "why this step"
    assert validate(g) == []
    node(g, "test")["notes"] = 3
    assert [e for e in validate(g) if e["node_id"] == "test" and "notes" in e["message"]], validate(g)
