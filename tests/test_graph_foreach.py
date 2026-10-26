"""For-each (US14 / ticket 13, FR-032): a foreach node's `body` handle enters a sub-graph that returns to it; the body
runs once per item of its `items` JSON array (max_items, default 50), in order, with {{item}} and {{index}}; the `done`
handle carries {items: [body outputs in order]}. Pure graph tests, no DB."""

import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from ctc.runner import export
from ctc.runner.graph import (
    batch,
    complete,
    current_item,
    eval_if,
    foreach_body,
    foreach_step,
    load,
    ready,
    rename_node,
    validate,
    warnings,
)

NAMES = '["ann","bob","cy"]'
BASE = {"nodes": [
    {"id": "start", "type": "trigger"},
    {"id": "names", "type": "shell", "command": "list-names"},
    {"id": "each", "type": "foreach", "items": "names.stdout_tail"},
    {"id": "fix", "type": "agent", "prompt": "fix {{item}} #{{index}}"},
    {"id": "report", "type": "shell", "command": "echo {{each.items}}"},
], "edges": [
    {"from": "start", "to": "names"}, {"from": "names", "to": "each"},
    {"from": "each", "to": "fix", "handle": "body"}, {"from": "fix", "to": "each"},
    {"from": "each", "to": "report", "handle": "done"},
]}


def base(change=None) -> dict:
    g = copy.deepcopy(BASE)
    if change:
        change(g)
    return load(g)


def walk(g: dict, names: str = NAMES, code=lambda nid, visit: 0) -> SimpleNamespace:
    """The engine loop without I/O (as graph.py's __main__ walk): a foreach's output is foreach_step(), a body node
    records current_item(), names prints `names`, other shells exit code(id, visit), an agent answers '<id>#<visit>'.
    -> ran (ids in order), items ([(id, current_item)] per body run), outs (each's outputs), st, err."""
    st, ctx = {}, {"input": "go"}
    w = SimpleNamespace(ran=[], items=[], outs=[], st=st, err=None)
    while r := ready(g, st):
        b = batch(g, r)
        for nid in b:
            node = next(n for n in g["nodes"] if n["id"] == nid)
            t, visit = node["type"], st["visits"].get(nid, 0) + 1
            if cur := current_item(g, st, nid):
                w.items.append((nid, cur))
            ctx[nid] = (foreach_step(g, st, node, ctx) if t == "foreach" else {"input": "go"} if t == "trigger"
                        else {"value": eval_if(node, ctx)} if t == "if" else {"result": f"{nid}#{visit}"} if t == "agent"
                        else {"exit_code": 0, "stdout_tail": names} if nid == "names"
                        else {"exit_code": code(nid, visit), "stdout_tail": nid})
            if t == "foreach":
                w.outs.append(ctx[nid])
        for nid in b:
            w.ran.append(nid)
            if e := complete(g, st, nid, ctx[nid]):
                w.err = e
                return w
        st = json.loads(json.dumps(st))  # the engine checkpoints state to Postgres after every batch
        w.st = st
    return w


def messages(g: dict) -> str:
    return " | ".join(e["message"] for e in validate(g))


def test_base_graph_validates_and_its_body_is_fix():
    g = base()
    assert validate(g) == []
    assert foreach_body(g, "each") == {"fix"}


def test_body_runs_once_per_item_in_order_then_done():
    w = walk(base())
    assert w.err is None
    assert w.ran == ["start", "names", *["each", "fix"] * 3, "each", "report"]
    assert w.items == [("fix", {"item": "ann", "index": 0}), ("fix", {"item": "bob", "index": 1}),
                       ("fix", {"item": "cy", "index": 2})]
    assert w.st["visits"]["each"] == 4  # 3 body passes + done; the item list bounds it, not max_visits 3
    assert w.outs[-1] == {"items": [{"result": "fix#1"}, {"result": "fix#2"}, {"result": "fix#3"}]}
    assert w.st["skipped"] == ["fix"] and "each" not in w.st["each"]  # the untaken body edge after the last item


def test_max_items_truncates_and_says_so():
    w = walk(base(lambda g: g["nodes"][2].update(max_items=2)))
    assert w.err is None and w.ran.count("fix") == 2
    assert w.outs[-1] == {"items": [{"result": "fix#1"}, {"result": "fix#2"}], "truncated_from": 3}


def test_empty_list_skips_the_body_and_runs_done():
    w = walk(base(), names="[]")
    assert w.err is None and "fix" not in w.ran and w.st["skipped"] == ["fix"]
    assert w.outs == [{"items": []}] and w.ran[-1] == "report"


@pytest.mark.parametrize("ctx", [{"names": {"stdout_tail": "oops"}}, {"names": {"stdout_tail": '{"a": 1}'}}, {"names": {}}])
def test_items_that_are_not_a_json_array_fail_the_foreach(ctx):
    with pytest.raises(ValueError, match="JSON array"):
        foreach_step(base(), {}, BASE["nodes"][2], ctx)


def test_items_already_a_list_need_no_parsing():
    assert foreach_step(base(), {}, BASE["nodes"][2], {"names": {"stdout_tail": ["x"]}}) == {"item": "x", "index": 0}


def body_with_retry(g: dict) -> None:
    """The body becomes fix (max_visits 2) -> check -> ok (IF check.exit_code eq 0): true -> each, false -> fix."""
    g["nodes"][3]["max_visits"] = 2
    g["nodes"] += [{"id": "check", "type": "shell", "command": "pytest -q"},
                   {"id": "ok", "type": "if", "path": "check.exit_code", "op": "eq", "value": 0}]
    g["edges"][3] = {"from": "fix", "to": "check"}
    g["edges"] += [{"from": "check", "to": "ok"}, {"from": "ok", "to": "each", "handle": "true"},
                   {"from": "ok", "to": "fix", "handle": "false"}]


def test_max_visits_count_per_item():
    g = base(body_with_retry)
    assert validate(g) == [] and foreach_body(g, "each") == {"fix", "check", "ok"}
    w = walk(g, code=lambda nid, visit: visit % 2)  # every item: check fails once, then passes
    assert w.err is None and w.ran.count("fix") == 6 and len(w.outs[-1]["items"]) == 3
    assert [i["index"] for n, i in w.items if n == "fix"] == [0, 0, 1, 1, 2, 2]
    w = walk(g, code=lambda nid, visit: 1)  # check never passes: the first item hits fix's cap
    assert w.err == "loop cap reached at fix" and w.ran.count("fix") == 2 and w.ran.count("each") == 1


def node(g: dict, nid: str) -> dict:
    return next(n for n in g["nodes"] if n["id"] == nid)


def nested(g: dict) -> None:
    """each sits in the body of another foreach, outer: names -> outer -body-> each ... report -> outer -done-> fin."""
    g["nodes"] += [{"id": "outer", "type": "foreach", "items": "names.stdout_tail"},
                   {"id": "fin", "type": "shell", "command": "true"}]
    g["edges"][1] = {"from": "names", "to": "outer"}
    g["edges"] += [{"from": "outer", "to": "each", "handle": "body"}, {"from": "report", "to": "outer"},
                   {"from": "outer", "to": "fin", "handle": "done"}]


def in_a_loop(g: dict) -> None:
    """each's done side -> again (IF), whose false edge goes back to names."""
    g["nodes"] += [{"id": "again", "type": "if", "path": "report.exit_code", "op": "eq", "value": 0},
                   {"id": "fin", "type": "shell", "command": "true"}]
    g["edges"] += [{"from": "report", "to": "again"}, {"from": "again", "to": "names", "handle": "false"},
                   {"from": "again", "to": "fin", "handle": "true"}]


@pytest.mark.parametrize("change, want", [
    (lambda g: node(g, "each").pop("items"), "items must be a field of a node that runs before each"),
    (lambda g: node(g, "each").update(items="report.stdout_tail"), "items must be a field of a node that runs before each"),
    (lambda g: node(g, "each").update(items="ghost.x"), "items must be a field of a node that runs before each"),
    (lambda g: node(g, "each").update(items="each.items"), "items must be a field of a node that runs before each"),
    (lambda g: node(g, "each").update(max_items=0), "max_items must be a whole number >= 1"),
    (lambda g: node(g, "each").update(max_items="5"), "max_items must be a whole number >= 1"),
    (lambda g: g["edges"].pop(2), "a foreach node needs exactly one body edge"),
    (lambda g: g["edges"].append({"from": "each", "to": "report", "handle": "body"}), "a foreach node needs exactly one body edge"),
    (lambda g: g["edges"][4].update(handle="true"), "foreach edge handle true must be body or done"),
    (lambda g: g["edges"][4].pop("handle"), "foreach edge handle none must be body or done"),
    (lambda g: g["edges"].append({"from": "fix", "to": "report"}), "report never returns to each"),  # leaves the body
    (lambda g: (g["nodes"].append({"id": "dead", "type": "shell", "command": "true"}),
                g["edges"].append({"from": "fix", "to": "dead"})), "dead never returns to each"),
    (lambda g: g["edges"].append({"from": "names", "to": "fix"}), "names -> fix enters the body of each from outside"),
    (lambda g: g["edges"].__setitem__(2, {"from": "each", "to": "each", "handle": "body"}), "a foreach body needs at least one node"),
    (in_a_loop, "no foreach inside a loop"),
    (nested, "no foreach inside a loop"),
    (lambda g: node(g, "report").update(command="echo {{item}}"), "{{item}} is only set inside a for-each body"),
    (lambda g: node(g, "report").update(command="echo {{index}}"), "{{index}} is only set inside a for-each body"),
    (lambda g: node(g, "each").update(disabled=True), "a foreach node cannot be disabled"),
])
def test_validate_rejects(change, want):
    assert want in messages(base(change))


def test_item_and_index_are_reserved_roots():
    assert "bad node id 'item'" in messages(base(lambda g: g["nodes"].append({"id": "item", "type": "shell", "command": "x"})))
    assert validate(base(lambda g: node(g, "fix").update(prompt="fix {{item.name}} #{{index}}"))) == []


def test_export_refuses_a_foreach():
    with pytest.raises(ValueError, match="has_foreach: each"):
        export.to_js(base(), "fe")


def test_foreach_demo_workflow_is_clean_and_greets_each_name():
    g = load(Path(__file__).resolve().parents[1] / ".claude" / "ctc-workflows" / "foreach-demo.yaml")
    assert validate(g) == [] and warnings(g) == []
    w = walk(g)
    assert w.err is None and w.ran.count("greet") == 3 and len(w.outs[-1]["items"]) == 3


def test_rename_follows_items():
    g = rename_node(base(), "names", "people")
    assert node(g, "each")["items"] == "people.stdout_tail" and validate(g) == []
