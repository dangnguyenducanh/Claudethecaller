"""Workflow walker (PLAN.md m5 "Walker rules"): pure functions over a graph dict and a JSON-able state dict, no I/O.

Graph = {nodes: [{id, type, pos, ...}], edges: [{from, to, handle?}]}. Types: trigger|agent|shell|if|approval|merge,
loops (back-edges, rule 5), ready readonly nodes in one batch (rule 7).
State (wf_runs.state, `{}` = not started): {inbox: {node: {"<edge#>": "data"|"skip"}}, deferred: [edge#], ready: [node],
visits: {node: n}, execs: n, skipped: [node]}; edge# is the edge's index in graph["edges"]. visits counts runs and skips.
Engine loop: `while (r := ready(g, st)): run batch(g, r) together (visit = visits.get(id, 0) + 1; a merge's output is
merge_output() before its complete()), then complete(g, st, id, output) for each`;
complete() returns the run's error when a loop passes its cap; a node that lands in `skipped` gets a skipped step row
(visit = visits[id]).
"""

from __future__ import annotations

import json
import re
import shlex
from pathlib import Path

import yaml

TYPES = {"trigger", "agent", "shell", "if", "approval", "merge"}
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


def _reach(start: str, edges: list[tuple], stop=frozenset()) -> set:
    """Nodes reachable from start over (from, to) pairs, not walking on past a node in stop."""
    seen, todo = set(), [start]
    while todo:
        if (n := todo.pop()) not in seen:
            seen.add(n)
            if n not in stop:
                todo += [b for a, b in edges if a == n]
    return seen


def loop_body(g: dict, i: int, back: set[int]) -> set[str]:
    """Rule 5: the nodes of back-edge i's loop, reachable forward from its target and reaching its source forward."""
    fwd = [(e.get("from"), e.get("to")) for j, e in enumerate(g["edges"]) if j not in back]
    e = g["edges"][i]
    return _reach(e.get("to"), fwd) & _reach(e.get("from"), [(b, a) for a, b in fwd])


def max_visits(g: dict, node_id: str) -> int:
    """A node's max_visits ?? the graph's defaults.max_visits ?? 3."""
    n = next((n for n in g["nodes"] if n.get("id") == node_id), {})
    return next(v for v in (n.get("max_visits"), (g.get("defaults") or {}).get("max_visits"), 3) if v is not None)


def _open_quote(prefix: str) -> bool:
    """True when a shell command cut at `prefix` sits inside '...' or "..." (render's own quoting would nest there)."""
    try:
        shlex.split(prefix)
    except ValueError:  # "No closing quotation" (or a trailing backslash: also not a safe spot)
        return True
    return False


def validate(g: dict) -> list[dict]:
    """Rules 1 and 6: [{message, node_id}], empty when the graph can run."""
    errs: list[dict] = []

    def err(message, node_id=None):
        errs.append({"message": message, "node_id": node_id})

    nodes = [(g.get("defaults") or {}) | n for n in g["nodes"]]  # as the engine and the exporter see them
    ids = [n.get("id") for n in nodes]
    known = set(ids)
    triggers = [n.get("id") for n in nodes if n.get("type") == "trigger"]
    if len(triggers) != 1:
        err(f"a workflow needs exactly one trigger, found {len(triggers)}", triggers[1] if len(triggers) > 1 else None)
    if (g.get("settings") or {}).get("permission", "worktree") not in ("worktree", "container"):
        err("settings.permission must be worktree or container")
    for n in nodes:
        nid, t = n.get("id"), n.get("type")
        if not isinstance(nid, str) or not SLUG.fullmatch(nid) or nid in ROOTS:
            err(f"bad node id {nid!r}: use letters, digits, - or _ (not input/run)", nid)
        elif ids.count(nid) > 1:
            err(f"duplicate node id {nid}", nid)
        if t not in TYPES:
            err(f"unknown node type {t!r}", nid)
        if t == "agent" and not (n.get("prompt") or n.get("cap")):
            err("an agent node needs a prompt or a cap", nid)
        if t == "agent" and n.get("permission_mode") not in PERMS:
            err("permission_mode must be acceptEdits, dontAsk or plan: no bypass on the host", nid)
        if t == "shell" and not n.get("command"):
            err("a shell node needs a command", nid)
        if (v := n.get("max_visits")) is not None and not (type(v) is int and v >= 1):
            err("max_visits must be a whole number >= 1", nid)
        cmd = str(n.get("command") or "")
        if t == "shell" and any(_open_quote(cmd[:m.start()]) for m in TPL.finditer(cmd)):
            err("leave {{...}} unquoted in a shell command: the runner shell-quotes it", nid)
        if t == "if":
            if n.get("op") not in OPS or not n.get("path"):
                err(f"an if node needs a path and an op in {sorted(OPS)}", nid)
            if {_handle(e) for e in g["edges"] if e.get("from") == nid} != {"true", "false"}:
                err("an if node needs exactly its true and false edges", nid)
        refs = TPL.findall(f"{n.get('prompt') or ''} {n.get('command') or ''} {n.get('message') or ''}") + (
            [n["path"]] if t == "if" and n.get("path") else [])
        for ref in refs:
            if ref.split(".")[0] not in known | ROOTS:
                err(f"{ref} names no node", nid)
    for e in g["edges"]:
        if e.get("from") not in known or e.get("to") not in known:
            err(f"edge {e.get('from')} -> {e.get('to')} points at a missing node",
                next((x for x in (e.get("from"), e.get("to")) if x in known), None))
    if len(triggers) == 1:
        byid = {n.get("id"): n for n in nodes}
        gates = {nid for nid, n in byid.items() if n.get("type") == "approval"}
        ungated = _reach(triggers[0], [(e.get("from"), e.get("to")) for e in g["edges"]], gates)
        for nid in sorted(ungated - gates):
            if byid.get(nid, {}).get("type") == "shell" and PUSH.search(str(byid[nid].get("command"))):
                err("git push / gh pr create|merge must sit behind an approval node", nid)
        back = back_edges(g)
        for i in sorted(back):
            loop = f"{g['edges'][i].get('from')} -> {g['edges'][i].get('to')}"
            for nid in sorted(loop_body(g, i, back)):
                t = byid.get(nid, {}).get("type")
                if t in ("merge", "approval"):
                    err(f"no {t} node inside a loop ({loop})", nid)
                elif t != "if" and sum(e.get("from") == nid for e in g["edges"]) > 1:
                    err(f"only an IF may branch inside a loop ({loop})", nid)
    return errs


def ready(g: dict, st: dict) -> list[str]:
    """Rules 2 and 4. Nodes that may run now; call when nothing is running. Starts a fresh state (`{}`) and, when
    nothing is ready, turns deferred IF edges into skip tokens (quiescence; never on a back-edge). [] means the run is
    done. Mutates st."""
    if not st:
        trig = next(n["id"] for n in g["nodes"] if n["type"] == "trigger")
        st.update(inbox={}, deferred=[], ready=[trig], visits={}, execs=0, skipped=[])
    back = back_edges(g)
    while not st["ready"] and st["deferred"]:
        deferred, st["deferred"] = st["deferred"], []
        for i in deferred:
            if i not in back:
                _send(g, st, i, "skip", back)
    return list(st["ready"])


def batch(g: dict, r: list[str]) -> list[str]:
    """Rule 7: which of the ready nodes r run together: every readonly agent or shell node, else only the first by id
    (a writer, IF, merge, approval or trigger runs alone)."""
    byid = {n["id"]: n for n in g["nodes"]}
    return sorted(n for n in r if byid[n]["type"] in ("agent", "shell") and byid[n].get("readonly")) or [min(r)]


def merge_output(g: dict, st: dict, node_id: str, ctx: dict) -> dict:
    """A ready merge's output, {inputs: {node_id: output}} over its data in-edges (ctx = finished nodes' outputs).
    Call it before complete(), which clears the merge's inbox."""
    box = st["inbox"].get(node_id, {})
    srcs = [g["edges"][int(i)]["from"] for i in sorted(box, key=int) if box[i] == "data"]
    return {"inputs": {n: ctx.get(n) for n in srcs}}


def complete(g: dict, st: dict, node_id: str, output: dict | None) -> str | None:
    """Record a finished node: data on every out-edge; an IF ({value}) sends data on the taken handle and defers
    the rest (rule 3); a back-edge fires last (rule 5). Returns the run's error when a loop passes its cap. Mutates st."""
    st["ready"].remove(node_id)
    st["inbox"].pop(node_id, None)
    st["visits"][node_id] = st["visits"].get(node_id, 0) + 1
    st["execs"] += 1
    back = back_edges(g)
    is_if = next(n for n in g["nodes"] if n["id"] == node_id)["type"] == "if"
    taken = str(bool((output or {}).get("value"))).lower()
    outs = [i for i, e in enumerate(g["edges"]) if e["from"] == node_id]
    for i in sorted(outs, key=lambda i: i in back):  # defer before a fire, so the fire clears this pass's deferrals
        if is_if and _handle(g["edges"][i]) != taken:
            st["deferred"].append(i)
        elif i not in back:
            _send(g, st, i, "data", back)
        elif err := _fire(g, st, i, back):
            return err
    return None


def _fire(g: dict, st: dict, i: int, back: set[int]) -> str | None:
    """Rule 5: back-edge i carries data. Its loop body's inbox and deferred edges are cleared and its target is ready
    for its next visit; an error when that visit passes the target's max_visits, or runs pass the backstop."""
    to = g["edges"][i]["to"]
    if st["visits"].get(to, 0) >= max_visits(g, to):
        return f"loop cap reached at {to}"
    if st["execs"] >= sum(max_visits(g, n["id"]) for n in g["nodes"]) + len(g["nodes"]):
        return f"loop backstop reached at {to}: {st['execs']} node runs"
    body = loop_body(g, i, back)
    st["inbox"] = {n: box for n, box in st["inbox"].items() if n not in body}
    st["deferred"] = [j for j in st["deferred"] if g["edges"][j]["from"] not in body]
    if to not in st["ready"]:
        st["ready"].append(to)
    return None


def _send(g: dict, st: dict, i: int, tok: str, back: set[int]) -> None:
    """Put a token on forward edge i. Once every forward in-edge of its target holds one: any data -> ready; all
    skip -> skipped (a visit too), and skip goes on downstream, never over a back-edge (rule 4)."""
    to = g["edges"][i]["to"]
    box = st["inbox"].setdefault(to, {})
    box[str(i)] = tok
    if any(str(j) not in box for j, e in enumerate(g["edges"]) if e["to"] == to and j not in back):
        return
    if "data" in box.values():
        if to not in st["ready"]:
            st["ready"].append(to)
        return
    del st["inbox"][to]
    st["skipped"].append(to)
    st["visits"][to] = st["visits"].get(to, 0) + 1  # a node skipped in one loop pass and run in the next: new visit
    for j, e in enumerate(g["edges"]):
        if e["from"] == to and j not in back:
            _send(g, st, j, "skip", back)


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
    def walk(g: dict, code, ctx: dict | None = None, batches: list | None = None) -> tuple[list, dict, str | None]:
        """The engine loop without I/O: (nodes run in order, final state, run error); code(node_id) = a shell's exit.
        Pass ctx / batches to read the outputs / the batches that ran together afterwards."""
        st, ran = {}, []
        ctx = {"input": "go", "run": {"branch": "ctc/demo-1"}} if ctx is None else ctx
        while r := ready(g, st):
            b = batch(g, r)
            batches is not None and batches.append(b)
            for nid in b:  # the whole batch runs before any of it completes, as in the engine
                node = next(n for n in g["nodes"] if n["id"] == nid)
                out = {"trigger": {"input": "go"}, "agent": {"result": "ok"}, "approval": {"approved": True, "note": None},
                       "shell": {"exit_code": code(nid), "stdout_tail": nid} if node["type"] == "shell" else None,
                       "if": {"value": eval_if(node, ctx)} if node["type"] == "if" else None,
                       "merge": merge_output(g, st, nid, ctx) if node["type"] == "merge" else None}[node["type"]]
                ctx[nid] = out
            for nid in b:
                ran.append(nid)
                if e := complete(g, st, nid, ctx[nid]):
                    return ran, st, e
            st = json.loads(json.dumps(st))  # the engine checkpoints state to Postgres after every batch
        return ran, st, None

    g = load(good)
    assert validate(g) == [], validate(g)
    for code, want_ran, want_skipped in ((0, ["ship"], ["blame", "note"]), (1, ["blame", "note"], ["ship"])):
        ran, st, e = walk(g, lambda _, c=code: c)
        assert ran == ["start", "fix", "test", "green", *want_ran] and e is None, ran
        assert st["skipped"] == want_skipped and not st["deferred"] and st["execs"] == len(ran), st

    # fix-tests (PLAN.md m5 "Workflow file"): test -> green? -> fix -> test is a loop; reviewers + join + gate after it
    fix_tests = load({"nodes": [
        {"id": "start", "type": "trigger"}, {"id": "test", "type": "shell", "command": "pytest -x -q"},
        {"id": "green", "type": "if", "path": "test.exit_code", "op": "eq", "value": 0},
        {"id": "fix", "type": "agent", "prompt": "Tests fail: {{test.stdout_tail}}"},
        {"id": "review-a", "type": "agent", "readonly": True, "prompt": "Review"},
        {"id": "review-b", "type": "agent", "readonly": True, "prompt": "Security review"},
        {"id": "join", "type": "merge"}, {"id": "gate", "type": "approval", "message": "Push {{run.branch}}?"},
        {"id": "pr", "type": "shell", "command": "git push -u origin HEAD && gh pr create --draft --fill"},
    ], "edges": [
        {"from": "start", "to": "test"}, {"from": "test", "to": "green"},
        {"from": "green", "to": "review-a", "handle": "true"}, {"from": "green", "to": "review-b", "handle": "true"},
        {"from": "green", "to": "fix", "handle": "false"}, {"from": "fix", "to": "test"},
        {"from": "review-a", "to": "join"}, {"from": "review-b", "to": "join"}, {"from": "join", "to": "gate"},
        {"from": "gate", "to": "pr"},
    ]})
    assert back_edges(fix_tests) == {5} and loop_body(fix_tests, 5, {5}) == {"test", "green", "fix"}
    assert validate(fix_tests) == [], validate(fix_tests)  # push gated
    assert batch(fix_tests, ["test", "review-b", "fix", "review-a"]) == ["review-a", "review-b"]  # rule 7: readonly first
    assert batch(fix_tests, ["test", "fix"]) == ["fix"]  # no readonly node ready: the first writer by id, alone
    results = iter([1, 1, 0])  # red, red, green
    ran, st, e = walk(fix_tests, lambda n: next(results) if n == "test" else 0)
    assert e is None and ran == ["start", *["test", "green", "fix"] * 2, "test", "green", "review-a", "review-b", "join",
                                 "gate", "pr"], ran
    assert st["visits"] == {"start": 1, "test": 3, "green": 3, "fix": 3, "review-a": 1, "review-b": 1, "join": 1,
                            "gate": 1, "pr": 1} and st["skipped"] == ["fix"] and not st["deferred"], st  # fix#3 skipped
    ran, st, e = walk(fix_tests, lambda n: 1)  # red forever: the 4th test visit is over its cap
    assert e == "loop cap reached at test" and ran.count("test") == 3 and "review-a" not in ran, (e, ran)
    ran, _, e = walk(fix_tests | {"defaults": {"max_visits": 2}}, lambda n: 1)
    assert e == "loop cap reached at test" and ran.count("test") == 2, (e, ran)  # graph defaults.max_visits honoured
    ran, _, e = walk(fix_tests | {"nodes": [n | ({"max_visits": 5} if n["id"] == "test" else {}) for n in fix_tests["nodes"]],
                                  "defaults": {"max_visits": 2}}, lambda n: 1)
    assert e == "loop cap reached at test" and ran.count("test") == 5, (e, ran)  # the node's own max_visits wins

    def bad_ft(change) -> str:
        g2 = copy.deepcopy(fix_tests)
        change(g2)
        return " | ".join(e["message"] for e in validate(load(g2)))

    no_gate = bad_ft(lambda x: (x["nodes"].pop(7), x["edges"].pop(), x["edges"][8].update(to="pr")))  # join -> pr
    assert no_gate == "git push / gh pr create|merge must sit behind an approval node", no_gate
    assert "no merge node inside a loop (join -> test)" in bad_ft(lambda x: x["edges"].append({"from": "join", "to": "test"}))
    assert "no approval node inside a loop" in bad_ft(lambda x: x["edges"][5].update(to="gate") or x["edges"].append(
        {"from": "gate", "to": "test"}))  # fix -> gate -> test: an approval in the loop body
    assert "only an IF may branch inside a loop" in bad_ft(lambda x: x["edges"].append({"from": "fix", "to": "review-a"}))
    assert "max_visits" in bad_ft(lambda x: x["nodes"][1].update(max_visits="3"))
    assert "nobody.x names no node" in bad_ft(lambda x: x["nodes"][7].update(message="Push {{nobody.x}}?"))  # approval message
    root = Path(__file__).resolve().parents[3] / ".claude" / "ctc-workflows"
    for name in ("loop-demo", "gate", "smoke", "three-reviewers"):
        assert validate(load(root / f"{name}.yaml")) == [], (name, validate(load(root / f"{name}.yaml")))
    ctx3, b3 = {"input": "", "run": {"branch": "ctc/three-1"}}, []
    ran, _, e = walk(load(root / "three-reviewers.yaml"), lambda _: 0, ctx3, b3)
    assert e is None and b3 == [["start"], ["r1", "r2", "r3"], ["join"], ["merged"]], b3  # the 3 shells run together
    assert ctx3["join"] == {"inputs": {n: {"exit_code": 0, "stdout_tail": n} for n in ("r1", "r2", "r3")}}, ctx3["join"]
    assert "approval" in validate(load(root / "bad-push.yaml"))[0]["message"]
    checks = iter([1, 1, 0])  # loop-demo: the counter reaches 3 on its third visit
    ran, st, e = walk(load(root / "loop-demo.yaml"), lambda n: next(checks) if n == "check" else 0)
    assert e is None and ran.count("count") == 3 and ran[-1] == "finish" and st["skipped"] == ["again"], (e, ran)

    def bad(change) -> str:
        g2 = copy.deepcopy(good)
        change(g2)
        return " | ".join(e["message"] for e in validate(load(g2)))

    assert "exactly one trigger" in bad(lambda x: x["nodes"].append({"id": "t2", "type": "trigger"}))
    assert "missing node" in bad(lambda x: x["edges"].append({"from": "ship", "to": "ghost"}))
    assert "true and false" in bad(lambda x: x["edges"].pop(4))
    assert "approval" in bad(lambda x: x["nodes"][4].update(command="git push -u origin HEAD"))
    assert "approval" in bad(lambda x: x["nodes"][4].update(command="gh  pr create --draft"))
    assert "only an IF may branch" in bad(lambda x: x["edges"].append({"from": "blame", "to": "test"}))
    # a merge after an IF: ready once both in-edges hold a token (the untaken side's skip arrives at quiescence), and
    # its output holds only the data inputs; with every input skipped it is skipped too
    gm = load(copy.deepcopy(good) | {"nodes": good["nodes"] + [{"id": "join", "type": "merge"}],
                                     "edges": good["edges"] + [{"from": "ship", "to": "join"}, {"from": "note", "to": "join"}]})
    assert validate(gm) == [], validate(gm)
    st = {}
    for n, out in (("start", {}), ("fix", {}), ("test", {"exit_code": 0}), ("green", {"value": True}), ("ship", {})):
        assert ready(gm, st) == [n], (n, st)
        complete(gm, st, n, out)
    assert st["inbox"]["join"] == {"6": "data"} and ready(gm, st) == ["join"] and st["skipped"] == ["blame", "note"], st
    assert merge_output(gm, st, "join", {"ship": {"exit_code": 0}, "note": None}) == {"inputs": {"ship": {"exit_code": 0}}}
    ctxm = {"input": "go", "run": {"branch": "b"}}
    ran, st, e = walk(gm | {"edges": gm["edges"][:-2] + [{"from": "blame", "to": "join"}, {"from": "note", "to": "join"}]},
                      lambda _: 0, ctxm)  # green: both merge inputs are on the skipped side
    assert e is None and "join" not in ran and st["skipped"] == ["blame", "note", "join"], (ran, st)
    assert "names no node" in bad(lambda x: x["nodes"][4].update(command="echo {{nobody.result}}"))
    assert "duplicate" in bad(lambda x: x["nodes"].append({"id": "fix", "type": "shell", "command": "true"}))
    assert "unquoted" in bad(lambda x: x["nodes"][4].update(command='echo "it is {{fix.result}}"'))
    assert "unquoted" in bad(lambda x: x["nodes"][4].update(command="gh issue comment 1 --body '{{fix.result}}'"))
    assert bad(lambda x: x["nodes"][4].update(command='echo "it\'s" {{fix.result}}')) == ""
    assert "no bypass" in bad(lambda x: x["nodes"][1].update(permission_mode="bypassPermissions"))
    assert "no bypass" in bad(lambda x: x.update(defaults={"permission_mode": "bypassPermissions"}))  # defaults reach nodes
    assert "max_visits" in bad(lambda x: x.update(defaults={"max_visits": "3"}))
    assert "approval" in bad(lambda x: (x["nodes"][4].pop("command"), x.update(defaults={"command": "git push"})))
    assert "worktree or container" in bad(lambda x: x.update(settings={"permission": "host"}))
    assert bad(lambda x: x.update(settings={"permission": "container"})) == ""

    ctx = {"input": "it's", "run": {"branch": "ctc/x-1"}, "fix": {"result": "a b; rm -rf ~", "so": {"k": [1]}}}
    assert render("echo {{fix.result}} {{ nope.x }} {{input}}", ctx, shell=True) == "echo 'a b; rm -rf ~' '' 'it'\"'\"'s'"
    assert render("{{run.branch}}:{{fix.so}}:{{fix.so.k.0}}:{{missing}}", ctx) == 'ctc/x-1:{"k": [1]}:1:'
    assert eval_if({"path": "t.code", "op": "eq", "value": "0"}, {"t": {"code": 0}})
    assert not eval_if({"path": "t.nope", "op": "ne", "value": 1}, {"t": {}})  # missing path is false, even for ne
    assert eval_if({"path": "t.out", "op": "contains", "value": "PASS"}, {"t": {"out": "3 PASS"}})
    assert not eval_if({"path": "t.out", "op": "contains", "value": [1]}, {"t": {"out": {"a": 1}}})  # no raise
    assert derived_steps(g) == [{"cap": "user:tdd-fix"}, {"agent": "debugger"}]
    print("graph ok")
