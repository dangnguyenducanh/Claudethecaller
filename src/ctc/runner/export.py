"""Native export (PLAN.md m5 WB16): a workflow graph -> a Claude Code workflow script for `.claude/workflows/<name>.js`
(https://code.claude.com/docs/en/workflows), which runs the same nodes as subagents of the user's own session.

Each node is one guarded statement, in topological order: it runs when one of its in-edges is live (its source ran
and, for an IF or switch, took that handle), which is walker rules 2-4 as plain `if`s. agent -> agent(prompt, {label,
...}); shell -> an agent told to run exactly that command, answering {exit_code, stdout_tail}; IF -> {value} over its
conditions (every/some for combine and/or), switch -> {case} via a chain of ?: over its cases, both tested by the nodes
after them; merge -> {inputs}; a loop (the back-edges into one node) -> a `while` capped at that node's max_visits;
readonly nodes side by side -> await parallel([...]); a disabled node -> a pass-through of its first live input's
output (graph.passthrough). Templates fill at run time: {{input}} is the workflow's `args`
(else the trigger's input), {{node.x}} that node's output, shell values single-quoted like shlex.quote. Every string
from the graph is embedded with json.dumps, so no prompt or command can break out into code.
Not exported: approval nodes (a native run can't pause for a sign-off: the caller refuses them), error edges
(on_error: error_output; a native agent's failure is not a branch, so they are refused), regex conditions
(Python re and JS RegExp differ, so a script could branch where the walker would not), and per-node
permissions, tools, MCP, max_turns and timeouts: the session's own permission rules apply.
"""

from __future__ import annotations

import json

from ctc.runner.graph import NUM, TPL, back_edges, conditions, loop_body, max_visits
from ctc.runner.proc import _name

J = json.dumps
PRELUDE = r"""const SHELL = {type: 'object', properties: {exit_code: {type: 'number'}, stdout_tail: {type: 'string'}}, required: ['exit_code', 'stdout_tail']}
const out = {}, ran = new Set(), visits = {}
const get = (v, path) => path.reduce((x, k) => x == null ? undefined : x[k], v)
const txt = v => v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v)
const q = s => "'" + s.replaceAll("'", "'\\''") + "'"
const on = (id, handle) => ran.has(id) && (handle === undefined || (out[id].case ?? out[id].value) === handle)
const set = (id, v) => { out[id] = v; ran.add(id); visits[id] = (visits[id] || 0) + 1 }
const NUM = new RegExp(NUM_PATTERN)
const num = v => typeof v === 'number' ? v : typeof v === 'string' && NUM.test(v) ? Number(v) : NaN  // booleans: NaN, as graph._num
const cmp = (a, op, b) => !isNaN(a) && !isNaN(b) && (op === 'gt' ? a > b : op === 'ge' ? a >= b : op === 'lt' ? a < b : a <= b)
const has = (v, want) => Array.isArray(v) ? v.includes(want) : txt(v).includes(txt(want))
const test = (v, op, want) => v !== undefined && (op === 'truthy' ? Boolean(v) && (typeof v !== 'object' || Object.keys(v).length > 0)
  : op === 'exists' ? v !== null
  : op === 'contains' ? has(v, want) : op === 'not_contains' ? !has(v, want)
  : ['gt', 'ge', 'lt', 'le'].includes(op) ? cmp(num(v), op, num(want))
  : (v === want || txt(v) === txt(want)) === (op === 'eq'))
const ag = async (prompt, opts) => { const r = await agent(prompt, opts); return typeof r === 'string' ? {result: r} : {result: txt(r), structured_output: r} }
const sh = (id, cmd) => agent('Run exactly this shell command in the repo and report the exit code and the last lines of output: ' + cmd, {label: id, schema: SHELL})
""".replace("NUM_PATTERN", J(f"^(?:{NUM.pattern})$"))


def _ref(path: str) -> str:
    """A template path -> the JS lookup: {{input...}} reads `input`, {{node.x}} reads out[node].x."""
    root, *rest = path.split(".")
    return f"get(input, {J(rest)})" if root == "input" else f"get(out, {J([root, *rest])})"


def _tpl(s: str, shell: bool = False) -> str:
    """A template -> a JS string expression filled at run time (shell=True quotes each value)."""
    parts, last = [], 0
    for m in TPL.finditer(s):
        v = f"txt({_ref(m.group(1))})"
        parts += [J(s[last:m.start()]), f"q({v})" if shell else v]
        last = m.end()
    return " + ".join(p for p in [*parts, J(s[last:])] if p != '""') or '""'


def to_js(g: dict, name: str, description: str = "") -> str:
    """A validated graph -> the workflow script. ValueError for an approval node, a regex condition or a loop the
    script can't nest."""
    nodes = {n["id"]: (g.get("defaults") or {}) | n for n in g["nodes"]}
    if gate := next((i for i, n in nodes.items() if n["type"] == "approval"), None):
        raise ValueError(f"has_approval: {gate}")
    if e := next((e for e in g["edges"] if str(e.get("handle")).lower() == "error"
                  and nodes[e["from"]]["type"] != "switch"), None):  # a switch's "error" is a case name
        raise ValueError(f"error_edge: {e['from']} -> {e['to']}: a native workflow has no error branch")
    for nid, n in nodes.items():
        conds = [c for k in n["cases"] for c in k["conditions"]] if n["type"] == "switch" else (
            conditions(n) if n["type"] == "if" else [])
        if any(c.get("op") == "regex" for c in conds):
            raise ValueError(f"regex_condition: {nid} uses op regex; Python re and JS RegExp differ, so it is not exported")
    back = back_edges(g)
    fwd = [e for i, e in enumerate(g["edges"]) if i not in back]
    loops: dict[str, tuple[set, list]] = {}  # target -> (loop body, back-edges into it)
    for i in sorted(back):
        body, bes = loops.get(to := g["edges"][i]["to"], (set(), []))
        loops[to] = (body | loop_body(g, i, back), [*bes, g["edges"][i]])
    idx = {nid: k for k, nid in enumerate(nodes)}
    indeg = {nid: sum(e["to"] == nid for e in fwd) for nid in nodes}
    todo = [nid for nid in nodes if not indeg[nid]]
    lines, batch, stack, emitted = [], [], [], set()  # stack: open loops [(target, body, back-edges)]

    def on(e: dict) -> str:  # an edge is live: its source ran and, for an IF or switch, took this edge's handle
        t, h = nodes[e["from"]]["type"], str(e.get("handle")).lower()
        return f"on({J(e['from'])}{', ' + h if t == 'if' else ', ' + J(h) if t == 'switch' else ''})"

    def tests(n: dict) -> str:  # an IF's (or a switch case's) conditions as one JS boolean
        ts = ", ".join(f"test({_ref(str(c['path']))}, {J(c['op'])}, {J(c.get('value'))})" for c in conditions(n))
        return f"[{ts}].{'some' if n.get('combine') == 'or' else 'every'}(Boolean)"

    def stmt(nid: str) -> str:
        n, t = nodes[nid], nodes[nid]["type"]
        if t == "trigger":
            return f"set({J(nid)}, {{input}})"
        if n.get("disabled"):  # the first live input's output, as graph.passthrough: nothing runs
            v = f"out[[{', '.join(f'{on(e)} && {J(e['from'])}' for e in fwd if e['to'] == nid)}].find(Boolean)]"
        elif t == "agent":
            opts = {"label": nid, **{k: n[f] for k, f in (("model", "model"), ("effort", "effort"), ("schema", "json_schema"))
                                    if n.get(f)}, **({"agentType": _name(n["agent"])} if n.get("agent") else {})}
            prompt = (f"/{_name(n['cap'])} " if n.get("cap") else "") + (n.get("prompt") or "")
            v = f"await ag({_tpl(prompt)}, {J(opts)})"
        elif t == "shell":
            v = f"await sh({J(nid)}, {_tpl(n['command'], shell=True)})"
        elif t == "if":
            v = f"{{value: {tests(n)}}}"
        elif t == "switch":  # the first matching case, else default
            v = "{case: " + "".join(f"{tests(k)} ? {J(k['name'])} : " for k in n["cases"]) + '"default"}'
        else:  # merge: the outputs of its live inputs
            ins = ", ".join(f"{on(e)} && [{J(e['from'])}, out[{J(e['from'])}]]" for e in fwd if e["to"] == nid)
            v = f"{{inputs: Object.fromEntries([{ins}].filter(Boolean))}}"
        guard = " || ".join(on(e) for e in fwd if e["to"] == nid)
        return f"if ({guard}) set({J(nid)}, {v})" if guard else f"/* {nid}: no in-edge, never runs */"

    def pad() -> str:
        return "  " * len(stack)

    def flush() -> None:
        if len(batch) == 1:
            lines.append(pad() + stmt(batch[0]))
        elif batch:  # rule 7: readonly nodes ready together run together
            lines.extend([pad() + "await parallel([", *(f"{pad()}  async () => {{ {stmt(n)} }}," for n in batch), pad() + "])"])
        batch.clear()

    while todo:  # Kahn's order: an open loop's nodes first (so its body stays in one block), readonly first, then file order
        nid = min(todo, key=lambda n: (-sum(n in b for _, b, _ in stack), not nodes[n].get("readonly"), idx[n]))
        todo.remove(nid)
        if any(nid not in b for _, b, _ in stack):
            raise ValueError(f"the loop at {stack[-1][0]} can't be one block: {nid} sits between its nodes")
        ro = nodes[nid]["type"] in ("agent", "shell") and nodes[nid].get("readonly") and nid not in loops
        if not (ro and batch and not {e["from"] for e in fwd if e["to"] == nid} & set(batch)):
            flush()
        if nid in loops:
            body, bes = loops[nid]
            lines.append(pad() + f"while (true) {{  // loop back to {nid}, at most {max_visits(g, nid)} visits")
            stack.append((nid, body, bes))
            lines.append(pad() + f"for (const k of {J(sorted(body))}) ran.delete(k)  // a new pass")
        if ro:
            batch.append(nid)
        else:
            lines.append(pad() + stmt(nid))
        emitted.add(nid)
        for e in fwd:
            if e["from"] == nid:
                indeg[e["to"]] -= 1
                if not indeg[e["to"]]:
                    todo.append(e["to"])
        while stack and stack[-1][1] <= emitted:  # the loop's last node: go round again if a back-edge is live
            flush()
            t, _, bes = stack[-1]
            lines += [pad() + f"if (!({' || '.join(on(e) for e in bes)})) break",
                      pad() + f"if (visits[{J(t)}] >= {max_visits(g, t)}) throw new Error({J(f'loop cap reached at {t}')})"]
            stack.pop()
            lines.append(pad() + "}")
    flush()
    trig = next((n for n in nodes.values() if n["type"] == "trigger"), {})
    return (f"export const meta = {{ name: {J(name)}, description: {J(description)} }}\n\n"
            f"// Exported by claudethecaller (ctc) from its canvas workflow {J(name)}; export again after editing it there.\n"
            f"{PRELUDE}const input = args ?? {J(trig.get('input') or '')}\n\n" + "\n".join(lines) + "\nreturn out\n")


if __name__ == "__main__":
    import copy
    import subprocess
    import tempfile
    from pathlib import Path

    from ctc.runner.graph import load, validate

    def run(js: str, codes: dict, args=None) -> dict:
        """node --check, then run the script with a stub agent(): shells answer exit codes from codes[label] (else 0),
        agents 'ok'. The runtime wraps the body in an async function (top-level await and return), and so does this."""
        stub = (f"const calls = [], codes = {J(codes)}\n"
                "const agent = async (p, o) => (calls.push([o.label, p]), o.schema ? {exit_code: (codes[o.label] || []).shift() ?? 0, stdout_tail: o.label} : 'ok')\n"
                "const parallel = ts => Promise.all(ts.map(t => t()))\n")
        src = (stub + "async function workflow(args) {\n" + js.replace("export const meta", "const meta", 1) + "}\n"
               f"workflow({J(args)}).then(out => console.log(JSON.stringify({{out, calls}})), e => console.log(JSON.stringify({{error: e.message, calls}})))\n")
        with tempfile.NamedTemporaryFile("w", suffix=".js") as f:
            f.write(src)
            f.flush()
            chk = subprocess.run(["node", "--check", f.name], check=False, capture_output=True, text=True)
            assert chk.returncode == 0, chk.stderr
            res = subprocess.run(["node", f.name], capture_output=True, text=True, check=True)
        return json.loads(res.stdout)

    root = Path(__file__).resolve().parents[3] / ".claude" / "ctc-workflows"
    edit = load(root / "edit-demo.yaml")
    js = to_js(edit, "edit-demo", edit["description"])
    assert js.startswith('export const meta = { name: "edit-demo", description: "Screenshot demo') and "await parallel" not in js
    r = run(js, {}, "it's; rm -rf ~")
    assert [c[0] for c in r["calls"]] == ["write", "check", "green"] and "red" not in r["out"], r
    assert "'it'\\''s; rm -rf ~' > hello.txt" in r["calls"][0][1], r["calls"][0]  # args shell-quoted at run time
    assert [c[0] for c in run(js, {"check": [1]})["calls"]] == ["write", "check", "red"]

    loop = load(root / "loop-demo.yaml")
    js = to_js(loop, "loop-demo", loop["description"])
    assert "while (true)" in js
    r = run(js, {"check": [1, 1, 0]})
    assert [c[0] for c in r["calls"]] == ["count", "check", "again"] * 2 + ["count", "check", "finish"], r["calls"]
    assert "error" not in r and r["out"]["enough"] == {"value": True}, r
    r = run(js, {"check": [1, 1, 1, 1]})  # red forever: the walker's cap, with no 4th visit of count
    assert r["error"] == "loop cap reached at count" and [c[0] for c in r["calls"]].count("count") == 3, r

    # fix-tests without its gate: a loop, then two readonly reviewers in parallel and a merge; quotes stay text
    evil = 'Review `${process.exit(1)}` "); x("\n*/'
    ft = load({"defaults": {"model": "haiku"}, "nodes": [
        {"id": "start", "type": "trigger", "input": "make it green"}, {"id": "test", "type": "shell", "command": "pytest -x -q"},
        {"id": "green", "type": "if", "path": "test.exit_code", "op": "eq", "value": 0},
        {"id": "fix", "type": "agent", "cap": "user:tdd-fix", "prompt": "Tests fail:\n{{test.stdout_tail}}\nGoal: {{input}}"},
        {"id": "review-a", "type": "agent", "readonly": True, "prompt": evil},
        {"id": "review-b", "type": "agent", "readonly": True, "agent": "security-reviewer", "prompt": "{{fix.result}}"},
        {"id": "join", "type": "merge"}, {"id": "gate", "type": "approval", "message": "Push?"},
    ], "edges": [
        {"from": "start", "to": "test"}, {"from": "test", "to": "green"},
        {"from": "green", "to": "review-a", "handle": "true"}, {"from": "green", "to": "review-b", "handle": True},
        {"from": "green", "to": "fix", "handle": "false"}, {"from": "fix", "to": "test"},
        {"from": "review-a", "to": "join"}, {"from": "review-b", "to": "join"}, {"from": "join", "to": "gate"},
    ]})
    assert validate(ft) == [], validate(ft)
    try:
        to_js(ft, "fix-tests")
        raise AssertionError("an approval node must not export")
    except ValueError as e:
        assert str(e) == "has_approval: gate", e
    ft2 = copy.deepcopy(ft)
    ft2["nodes"].pop()
    ft2["edges"].pop()
    js = to_js(ft2, "fix-tests", "Run tests, fix until green")
    assert "await parallel([" in js and '"model": "haiku"' in js and '"agentType": "security-reviewer"' in js, js
    r = run(js, {"test": [1, 0]})
    assert [c[0] for c in r["calls"]] == ["test", "fix", "test", "review-a", "review-b"], r["calls"]
    assert r["calls"][1][1] == "/tdd-fix Tests fail:\ntest\nGoal: make it green" and r["calls"][3][1] == evil, r["calls"]
    assert r["calls"][4][1] == "ok" and set(r["out"]["join"]["inputs"]) == {"review-a", "review-b"}, r
    print("export ok")
