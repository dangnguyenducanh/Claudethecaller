"""Workflow walker (PLAN.md m5 "Walker rules"): pure functions over a graph dict and a JSON-able state dict, no I/O.

Graph = {nodes: [{id, type, pos, ...}], edges: [{from, to, handle?}]}. M1 subset: trigger|agent|shell|if, one node at a time.
State (wf_runs.state, `{}` = not started): {inbox: {node: {"<edge#>": "data"|"skip"}}, deferred: [edge#], ready: [node],
visits: {node: n}, execs: n, skipped: [node]}; edge# is the edge's index in graph["edges"].
Engine loop: `while (r := ready(g, st)): run r[0] (visit = visits.get(id, 0) + 1); complete(g, st, r[0], output)`;
nodes that land in `skipped` get a skipped step row.
"""

from __future__ import annotations

import json
import re
import shlex
from pathlib import Path

import yaml

TYPES = {"trigger", "agent", "shell", "if"}
LATER = {"merge": "M3", "approval": "M2"}
OPS = {"eq", "ne", "contains", "truthy"}
PERMS = (None, "acceptEdits", "dontAsk", "plan")  # never bypassPermissions/auto on the host (Permissions decision)
PUSH = re.compile(r"\b(git\s+push|gh\s+pr\s+(create|merge))\b")
SLUG = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]*")
TPL = re.compile(r"\{\{\s*([\w.-]+)\s*\}\}")
ROOTS = {"input", "run"}  # template roots that are not node ids, so not allowed as ids
_MISSING = object()


def load(src) -> dict:
    """A workflow file (path) or dict -> the dict, with `nodes` and `edges` lists. A file's first YAML document is the
    workflow: legacy `workflows/*.yaml|md` files are frontmatter plus a body."""
    g = (next(yaml.safe_load_all(Path(src).read_text()), None) if isinstance(src, (str, Path)) else dict(src)) or {}
    return g | {"nodes": g.get("nodes") or [], "edges": g.get("edges") or []}


def _handle(e: dict) -> str:
    return str(e.get("handle")).lower()  # YAML `handle: true` (bool) and "true" are the same handle


def back_edges(g: dict) -> set[int]:
    """Rule 1: indices of edges that point at a node on the DFS stack, walking from the trigger."""
    out: dict = {}
    for i, e in enumerate(g["edges"]):
        out.setdefault(e.get("from"), []).append((i, e.get("to")))
    back, seen, stack = set(), set(), set()

    def dfs(n):
        seen.add(n)
        stack.add(n)
        for i, to in out.get(n, []):
            if to in stack:
                back.add(i)
            elif to not in seen:
                dfs(to)
        stack.discard(n)

    if trig := next((n.get("id") for n in g["nodes"] if n.get("type") == "trigger"), None):
        dfs(trig)
    return back


def _open_quote(prefix: str) -> bool:
    """True when a shell command cut at `prefix` sits inside '...' or "..." (render's own quoting would nest there)."""
    try:
        shlex.split(prefix)
    except ValueError:  # "No closing quotation" (or a trailing backslash: also not a safe spot)
        return True
    return False


def validate(g: dict) -> list[dict]:
    """Rules 1 and 6, M1 subset: [{message, node_id}], empty when the graph can run."""
    errs: list[dict] = []

    def err(message, node_id=None):
        errs.append({"message": message, "node_id": node_id})

    ids = [n.get("id") for n in g["nodes"]]
    known = set(ids)
    triggers = [n.get("id") for n in g["nodes"] if n.get("type") == "trigger"]
    if len(triggers) != 1:
        err(f"a workflow needs exactly one trigger, found {len(triggers)}", triggers[1] if len(triggers) > 1 else None)
    for n in g["nodes"]:
        nid, t = n.get("id"), n.get("type")
        if not isinstance(nid, str) or not SLUG.fullmatch(nid) or nid in ROOTS:
            err(f"bad node id {nid!r}: use letters, digits, - or _ (not input/run)", nid)
        elif ids.count(nid) > 1:
            err(f"duplicate node id {nid}", nid)
        if t in LATER:
            err(f"{t} nodes arrive in {LATER[t]}", nid)
        elif t not in TYPES:
            err(f"unknown node type {t!r}", nid)
        if t == "agent" and not (n.get("prompt") or n.get("cap")):
            err("an agent node needs a prompt or a cap", nid)
        if t == "agent" and n.get("permission_mode") not in PERMS:
            err("permission_mode must be acceptEdits, dontAsk or plan: no bypass on the host", nid)
        if t == "shell" and not n.get("command"):
            err("a shell node needs a command", nid)
        if t == "shell" and PUSH.search(str(n.get("command"))):
            err("git push / gh pr create|merge must sit behind an approval node (M2)", nid)  # M1: no approval yet
        cmd = str(n.get("command") or "")
        if t == "shell" and any(_open_quote(cmd[:m.start()]) for m in TPL.finditer(cmd)):
            err("leave {{...}} unquoted in a shell command: the runner shell-quotes it", nid)
        if t == "if":
            if n.get("op") not in OPS or not n.get("path"):
                err(f"an if node needs a path and an op in {sorted(OPS)}", nid)
            if {_handle(e) for e in g["edges"] if e.get("from") == nid} != {"true", "false"}:
                err("an if node needs exactly its true and false edges", nid)
        refs = TPL.findall(f"{n.get('prompt') or ''} {n.get('command') or ''}") + ([n["path"]] if t == "if" and n.get("path") else [])
        for ref in refs:
            if ref.split(".")[0] not in known | ROOTS:
                err(f"{ref} names no node", nid)
    for e in g["edges"]:
        if e.get("from") not in known or e.get("to") not in known:
            err(f"edge {e.get('from')} -> {e.get('to')} points at a missing node",
                next((x for x in (e.get("from"), e.get("to")) if x in known), None))
    if len(triggers) == 1:
        for i in sorted(back_edges(g)):
            err("loops arrive in M2", g["edges"][i]["from"])
    return errs


def ready(g: dict, st: dict) -> list[str]:
    """Rules 2 and 4. Nodes that may run now; call when nothing is running. Starts a fresh state (`{}`) and, when
    nothing is ready, turns deferred IF edges into skip tokens (quiescence). [] means the run is done. Mutates st."""
    if not st:
        trig = next(n["id"] for n in g["nodes"] if n["type"] == "trigger")
        st.update(inbox={}, deferred=[], ready=[trig], visits={}, execs=0, skipped=[])
    while not st["ready"] and st["deferred"]:
        deferred, st["deferred"] = st["deferred"], []
        for i in deferred:
            _send(g, st, i, "skip")
    return list(st["ready"])


def complete(g: dict, st: dict, node_id: str, output: dict | None) -> None:
    """Record a finished node: data on every out-edge; an IF ({value}) sends data on the taken handle and defers
    the rest (rule 3). Mutates st."""
    st["ready"].remove(node_id)
    st["inbox"].pop(node_id, None)
    st["visits"][node_id] = st["visits"].get(node_id, 0) + 1
    st["execs"] += 1
    is_if = next(n for n in g["nodes"] if n["id"] == node_id)["type"] == "if"
    taken = str(bool((output or {}).get("value"))).lower()
    for i, e in enumerate(g["edges"]):
        if e["from"] == node_id:
            if is_if and _handle(e) != taken:
                st["deferred"].append(i)
            else:
                _send(g, st, i, "data")


def _send(g: dict, st: dict, i: int, tok: str) -> None:
    """Put a token on edge i. Once every in-edge of its target holds one: any data -> ready; all skip -> skipped,
    and skip goes on downstream (rule 4).
    ponytail: every edge counts as forward; validate rejects back-edges until loops land (M2, rule 5)."""
    to = g["edges"][i]["to"]
    box = st["inbox"].setdefault(to, {})
    box[str(i)] = tok
    if any(str(j) not in box for j, e in enumerate(g["edges"]) if e["to"] == to):
        return
    if "data" in box.values():
        if to not in st["ready"]:
            st["ready"].append(to)
        return
    del st["inbox"][to]
    st["skipped"].append(to)
    for j, e in enumerate(g["edges"]):
        if e["from"] == to:
            _send(g, st, j, "skip")


def lookup(ctx: dict, path: str):
    """Dotted lookup in ctx = {input, run: {branch}, <node_id>: output}; _MISSING when any part is absent."""
    v = ctx
    for k in path.split("."):
        if isinstance(v, dict) and k in v:
            v = v[k]
        elif isinstance(v, list) and k.isdigit() and int(k) < len(v):
            v = v[int(k)]
        else:
            return _MISSING
    return v


def _text(v) -> str:
    return "" if v is _MISSING or v is None else v if isinstance(v, str) else json.dumps(v, default=str)


def render(tpl: str, ctx: dict, shell: bool = False) -> str:
    """Fill {{input}}, {{<node>.<dotted.path>}}, {{run.branch}}; missing or skipped -> "". shell=True quotes each value."""
    def one(m):
        s = _text(lookup(ctx, m.group(1)))
        return shlex.quote(s) if shell else s
    return TPL.sub(one, tpl or "")


def eval_if(node: dict, ctx: dict) -> bool:
    """IF node {path, op, value}; eq/ne also match by rendered text (0 == "0", True == "true"). Missing path = False."""
    v, want, op = lookup(ctx, str(node.get("path") or "")), node.get("value"), node.get("op")
    if v is _MISSING:
        return False
    try:
        if op == "truthy":
            return bool(v)
        if op in ("eq", "ne"):
            return (v == want or _text(v) == _text(want)) == (op == "eq")
        if op == "contains":
            return want in v if isinstance(v, (list, dict)) else _text(want) in _text(v)
    except TypeError:  # e.g. an unhashable value tested against a dict
        pass
    return False


def derived_steps(g: dict) -> list[dict]:
    """The router's `steps:` list (read by decision.bundle._workflow_steps): {cap, agent?} per agent node naming one."""
    return [s for n in g["nodes"] if n.get("type") == "agent" and (s := {k: n[k] for k in ("cap", "agent") if n.get(k)})]


if __name__ == "__main__":
    import copy

    good = {
        "nodes": [
            {"id": "start", "type": "trigger", "pos": [0, 0]},
            {"id": "fix", "type": "agent", "cap": "user:tdd-fix", "prompt": "Goal: {{input}}", "pos": [1, 0]},
            {"id": "test", "type": "shell", "command": "pytest -q", "pos": [2, 0]},
            {"id": "green", "type": "if", "path": "test.exit_code", "op": "eq", "value": 0, "pos": [3, 0]},
            {"id": "ship", "type": "shell", "command": "echo {{fix.result}}", "pos": [4, 0]},
            {"id": "blame", "type": "agent", "agent": "debugger", "prompt": "{{test.stderr_tail}}", "pos": [4, 1]},
            {"id": "note", "type": "shell", "command": "echo sorry", "pos": [5, 1]},
        ],
        "edges": [
            {"from": "start", "to": "fix"}, {"from": "fix", "to": "test"}, {"from": "test", "to": "green"},
            {"from": "green", "to": "ship", "handle": "true"}, {"from": "green", "to": "blame", "handle": "false"},
            {"from": "blame", "to": "note"},
        ],
    }
    g = load(good)
    assert validate(g) == [], validate(g)
    for code, want_ran, want_skipped in ((0, ["ship"], ["blame", "note"]), (1, ["blame", "note"], ["ship"])):
        st, ctx, ran = {}, {"input": "go", "run": {"branch": "ctc/demo-1"}}, []
        while r := ready(g, st):
            node = next(n for n in g["nodes"] if n["id"] == r[0])
            out = {"trigger": {"input": "go"}, "agent": {"result": "ok"}, "shell": {"exit_code": code}}.get(node["type"])
            out = {"value": eval_if(node, ctx)} if node["type"] == "if" else out
            ctx[node["id"]] = out
            ran.append(node["id"])
            complete(g, st, node["id"], out)
            st = json.loads(json.dumps(st))  # the engine checkpoints state to Postgres after every node
        assert ran == ["start", "fix", "test", "green", *want_ran], ran
        assert st["skipped"] == want_skipped and not st["deferred"] and st["execs"] == len(ran), st

    def bad(change) -> str:
        g2 = copy.deepcopy(good)
        change(g2)
        return " | ".join(e["message"] for e in validate(load(g2)))

    assert "exactly one trigger" in bad(lambda x: x["nodes"].append({"id": "t2", "type": "trigger"}))
    assert "missing node" in bad(lambda x: x["edges"].append({"from": "ship", "to": "ghost"}))
    assert "true and false" in bad(lambda x: x["edges"].pop(4))
    assert "approval" in bad(lambda x: x["nodes"][4].update(command="git push -u origin HEAD"))
    assert "approval" in bad(lambda x: x["nodes"][4].update(command="gh  pr create --draft"))
    assert "loops arrive in M2" in bad(lambda x: x["edges"].append({"from": "blame", "to": "test"}))
    assert "merge nodes arrive in M3" in bad(lambda x: x["nodes"].append({"id": "join", "type": "merge"}))
    assert "names no node" in bad(lambda x: x["nodes"][4].update(command="echo {{nobody.result}}"))
    assert "duplicate" in bad(lambda x: x["nodes"].append({"id": "fix", "type": "shell", "command": "true"}))
    assert "unquoted" in bad(lambda x: x["nodes"][4].update(command='echo "it is {{fix.result}}"'))
    assert "unquoted" in bad(lambda x: x["nodes"][4].update(command="gh issue comment 1 --body '{{fix.result}}'"))
    assert bad(lambda x: x["nodes"][4].update(command='echo "it\'s" {{fix.result}}')) == ""
    assert "no bypass" in bad(lambda x: x["nodes"][1].update(permission_mode="bypassPermissions"))

    ctx = {"input": "it's", "run": {"branch": "ctc/x-1"}, "fix": {"result": "a b; rm -rf ~", "so": {"k": [1]}}}
    assert render("echo {{fix.result}} {{ nope.x }} {{input}}", ctx, shell=True) == "echo 'a b; rm -rf ~' '' 'it'\"'\"'s'"
    assert render("{{run.branch}}:{{fix.so}}:{{fix.so.k.0}}:{{missing}}", ctx) == 'ctc/x-1:{"k": [1]}:1:'
    assert eval_if({"path": "t.code", "op": "eq", "value": "0"}, {"t": {"code": 0}})
    assert not eval_if({"path": "t.nope", "op": "ne", "value": 1}, {"t": {}})  # missing path is false, even for ne
    assert eval_if({"path": "t.out", "op": "contains", "value": "PASS"}, {"t": {"out": "3 PASS"}})
    assert not eval_if({"path": "t.out", "op": "contains", "value": [1]}, {"t": {"out": {"a": 1}}})  # no raise
    assert derived_steps(g) == [{"cap": "user:tdd-fix"}, {"agent": "debugger"}]
    print("graph ok")
