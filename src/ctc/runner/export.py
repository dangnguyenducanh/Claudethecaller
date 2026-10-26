"""Native export (PLAN.md m5 WB16): a workflow graph -> a Claude Code workflow script for `.claude/workflows/<name>.js`
(https://code.claude.com/docs/en/workflows), which runs the same nodes as subagents of the user's own session.

Each node is one guarded statement, in topological order: it runs when one of its in-edges is live (its source ran
and, for an IF or switch, took that handle), which is walker rules 2-4 as plain `if`s. agent -> agent(prompt, {label,
...}); shell -> an agent told to run exactly that command, answering {exit_code, stdout_tail}; a shell with retry ->
up to max_tries such runs until exit 0 (`sleep <wait_s>; ` before each later one), the last non-zero exit failing the
script as it fails the run; on_error: continue -> a shell's exit stays data (as by default), an agent's thrown error
becomes {result, is_error: true}; IF -> {value} over its conditions (every/some for combine and/or; the JS test()
mirrors graph._test: Python ==, `in` and json.dumps text), switch -> {case} via a chain of ?: over its cases, both
tested by the nodes after them; merge -> {inputs}; a loop (the back-edges into one node) -> a `while` capped at that
node's max_visits; readonly nodes side by side -> await parallel([...]); a disabled node -> a pass-through of its first
live input's output (graph.passthrough); stop -> throw new Error(<its message>); pin and notes -> ignored (a native run
is never a pinned run). Templates fill at run time: {{input}} is the
workflow's `args` (else the trigger's input), {{vars.x}} the file's vars:, {{now}} the time, {{node.x}} that node's
output, shell values single-quoted like shlex.quote. With declared trigger `inputs`, `args` (an object or its JSON
text) fills {{input.<name>}} over the declared defaults, and a missing required input throws; values are not coerced.
Every string from the graph is embedded with json.dumps, so no
prompt or command can break out into code.
Refused, each as ValueError("<code>: <node ids or field>...") (the API's 422 not_exportable): approval nodes (has_approval:
a native run can't pause for a sign-off), for-each nodes (has_foreach: no native equivalent yet), {{run.id}},
{{run.visit}} and {{run.trigger}} (uses_run_root: no native run record), settings.max_run_minutes (has_run_timeout: no
native wall clock), error edges (error_edge: on_error: error_output; a native agent's failure is not a branch), regex
conditions (regex_condition: Python re and JS RegExp differ, so a script could branch where the walker would not) and
a loop whose nodes can't form one block (loop_not_one_block).
Not exported (ignored): settings.notify (the session shows a workflow's end itself), settings.approval_timeout_minutes
(approval nodes are refused), and per-node permissions, tools, MCP, max_turns and timeouts: the session's own
permission rules apply.
"""

from __future__ import annotations

import json

from ctc.runner.graph import NUM, TPL, back_edges, conditions, loop_body, max_visits
from ctc.runner.proc import _name

J = json.dumps
PRELUDE = r"""const SHELL = {type: 'object', properties: {exit_code: {type: 'number'}, stdout_tail: {type: 'string'}}, required: ['exit_code', 'stdout_tail']}
const out = {}, ran = new Set(), visits = {}
const obj = v => v !== null && typeof v === 'object'
const get = (v, path) => path.reduce((x, k) => Array.isArray(x) ? (/^\d+$/.test(k) && +k < x.length ? x[+k] : undefined)
  : obj(x) && Object.hasOwn(x, k) ? x[k] : undefined, v)  // as graph.lookup: own keys and list indexes only
// as graph._text: Python's json.dumps ("[1, 2]", non-ASCII as \uXXXX). ponytail: 1.0 prints as 1 and integer-like keys
// come first in JS, so a text compare can still differ there
const dumps = v => Array.isArray(v) ? '[' + v.map(dumps).join(', ') + ']'
  : obj(v) ? '{' + Object.entries(v).map(([k, x]) => JSON.stringify(k) + ': ' + dumps(x)).join(', ') + '}' : JSON.stringify(v)
const txt = v => v == null ? '' : typeof v === 'string' ? v
  : dumps(v).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
const q = s => "'" + s.replaceAll("'", "'\\''") + "'"
const on = (id, handle) => ran.has(id) && (handle === undefined || (out[id].case ?? out[id].value) === handle)
const set = (id, v) => { out[id] = v; ran.add(id); visits[id] = (visits[id] || 0) + 1 }
const NUM = new RegExp(NUM_PATTERN)
const num = v => typeof v === 'number' ? v : typeof v === 'string' && NUM.test(v) ? Number(v) : NaN  // booleans: NaN, as graph._num
const cmp = (a, op, b) => !isNaN(a) && !isNaN(b) && (op === 'gt' ? a > b : op === 'ge' ? a >= b : op === 'lt' ? a < b : a <= b)
const nb = v => typeof v === 'number' || typeof v === 'boolean'
const peq = (a, b) => obj(a) && obj(b) ? Array.isArray(a) === Array.isArray(b) && Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every(k => Object.hasOwn(b, k) && peq(a[k], b[k]))
  : nb(a) && nb(b) ? Number(a) === Number(b) : a === b  // Python ==: structural, True == 1
const has = (v, want) => Array.isArray(v) ? v.some(x => peq(x, want)) : obj(v) ? typeof want === 'string' && Object.hasOwn(v, want)
  : txt(v).includes(txt(want))  // Python `in`: a list's items, a dict's keys, else text
const test = (v, op, want) => v !== undefined && (op === 'truthy' ? Boolean(v) && (typeof v !== 'object' || Object.keys(v).length > 0)
  : op === 'exists' ? v !== null
  : op === 'contains' || op === 'not_contains'  // a dict tested for a list or dict: Python's TypeError, false for both
    ? !(obj(v) && !Array.isArray(v) && obj(want)) && has(v, want) === (op === 'contains')
  : ['gt', 'ge', 'lt', 'le'].includes(op) ? cmp(num(v), op, num(want))
  : (peq(v, want) || txt(v) === txt(want)) === (op === 'eq'))
const ag = async (prompt, opts) => { const r = await agent(prompt, opts); return typeof r === 'string' ? {result: r} : {result: txt(r), structured_output: r} }
const sh = (id, cmd) => agent('Run exactly this shell command in the repo and report the exit code and the last lines of output: ' + cmd, {label: id, schema: SHELL})
const retry = async (id, cmd, n, wait, cont) => {  // as engine._spawn: until exit 0 or n tries; then a non-zero exit fails the run
  for (let k = 1; ; k++) {
    const r = await sh(id, k > 1 && wait ? `sleep ${wait}; ` + cmd : cmd)
    if (r.exit_code === 0 || (k === n && cont)) return r
    if (k === n) throw new Error(`exit ${r.exit_code} on try ${k}/${n}: ${r.stdout_tail}`)
  }
}
""".replace("NUM_PATTERN", J(f"^(?:{NUM.pattern})$"))


def _ref(path: str) -> str:
    """A template path -> the JS lookup: {{input...}} reads `input`, {{vars.x}} `vars`, {{now}} the time (the engine's
    isoformat(timespec='seconds') in UTC), {{node.x}} out[node].x. ValueError for run.id / run.visit / run.trigger."""
    root, *rest = path.split(".")
    if root == "run" and rest[:1] and rest[0] in ("id", "visit", "trigger"):
        raise ValueError(f"uses_run_root: {{{{{path}}}}} has no native equivalent; remove it to export")
    if root == "now" and not rest:
        return r"new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00')"
    return f"get({root}, {J(rest)})" if root in ("input", "vars") else f"get(out, {J([root, *rest])})"


def _tpl(s: str, shell: bool = False) -> str:
    """A template -> a JS string expression filled at run time (shell=True quotes each value)."""
    parts, last = [], 0
    for m in TPL.finditer(s):
        v = f"txt({_ref(m.group(1))})"
        parts += [J(s[last:m.start()]), f"q({v})" if shell else v]
        last = m.end()
    return " + ".join(p for p in [*parts, J(s[last:])] if p != '""') or '""'


def to_js(g: dict, name: str, description: str = "") -> str:
    """A validated graph -> the workflow script. ValueError("<code>: ...") for a refused feature (module docstring)."""
    if (g.get("settings") or {}).get("max_run_minutes") is not None:
        raise ValueError("has_run_timeout: settings.max_run_minutes has no native equivalent; remove it to export")
    nodes = {n["id"]: (g.get("defaults") or {}) | n for n in g["nodes"]}
    if gate := next((i for i, n in nodes.items() if n["type"] == "approval"), None):
        raise ValueError(f"has_approval: {gate}")
    if fe := next((i for i, n in nodes.items() if n["type"] == "foreach"), None):
        raise ValueError(f"has_foreach: {fe}: for-each has no native equivalent yet; remove it to export")
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
            if n.get("on_error") == "continue":  # its error becomes its output and the run walks on
                v += ".catch(e => ({result: String(e?.message ?? e), is_error: true}))"
        elif t == "shell" and (rt := n.get("retry")):  # graph.validate: idempotent shells only
            v = (f"await retry({J(nid)}, {_tpl(n['command'], shell=True)}, {rt['max_tries']}, {J(rt.get('wait_s', 0))}, "
                 f"{J(n.get('on_error') == 'continue')})")
        elif t == "shell":  # on_error continue alike: a non-zero exit is data, the run walks on
            v = f"await sh({J(nid)}, {_tpl(n['command'], shell=True)})"
        elif t == "if":
            v = f"{{value: {tests(n)}}}"
        elif t == "switch":  # the first matching case, else default
            v = "{case: " + "".join(f"{tests(k)} ? {J(k['name'])} : " for k in n["cases"]) + '"default"}'
        elif t == "stop":  # the run fails with its rendered message, as engine._spawn
            v = None
        else:  # merge: the outputs of its live inputs
            ins = ", ".join(f"{on(e)} && [{J(e['from'])}, out[{J(e['from'])}]]" for e in fwd if e["to"] == nid)
            v = f"{{inputs: Object.fromEntries([{ins}].filter(Boolean))}}"
        act = f"throw new Error(({_tpl(n['message'])}) || {J(f'stopped at {nid}')})" if v is None else f"set({J(nid)}, {v})"
        guard = " || ".join(on(e) for e in fwd if e["to"] == nid)
        return f"if ({guard}) {act}" if guard else f"/* {nid}: no in-edge, never runs */"

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
            raise ValueError(f"loop_not_one_block: {stack[-1][0]}: {nid} sits between its nodes, so the loop can't be one block")
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
    head = f"const input = args ?? {J(trig.get('input') or '')}\n"
    if decl := trig.get("inputs"):  # ponytail: no type coercion in the native script
        head = (f"const input = Object.assign({J({i['name']: i['default'] for i in decl if i.get('default') is not None})}, "
                "typeof args === 'string' ? JSON.parse(args || '{}') : (args ?? {}))\n"
                + "".join(f"if (input[{J(i['name'])}] === undefined) throw new Error({J('missing input ' + i['name'])})\n"
                          for i in decl if i.get("required")))
    return (f"export const meta = {{ name: {J(name)}, description: {J(description)} }}\n\n"
            f"// Exported by claudethecaller (ctc) from its canvas workflow {J(name)}; export again after editing it there.\n"
            f"{PRELUDE}{head}const vars = {J(g.get('vars') or {})}\n\n"
            + "\n".join(lines) + "\nreturn out\n")


if __name__ == "__main__":
    import copy
    import itertools
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

    # every refusal is "<code>: ...", one graph per code (the API's 422 not_exportable)
    def line(*mid: dict, edges=None, **extra) -> dict:
        ns = [{"id": "start", "type": "trigger"}, *mid]
        return {"nodes": ns, "edges": edges or [{"from": a["id"], "to": b["id"]} for a, b in itertools.pairwise(ns)]} | extra
    sh = {"type": "shell", "command": "true"}
    refused = {
        "has_approval": line({"id": "gate", "type": "approval", "message": "ok?"}),
        "has_foreach": line({"id": "ls", "type": "shell", "command": "echo []"}, {"id": "each", "type": "foreach", "items": "ls.stdout_tail"},
                            {"id": "body", **sh}, edges=[{"from": "start", "to": "ls"}, {"from": "ls", "to": "each"},
                                                         {"from": "each", "to": "body", "handle": "body"}, {"from": "body", "to": "each"}]),
        "error_edge": line({"id": "a", **sh, "on_error": "error_output"}, {"id": "b", **sh},
                           edges=[{"from": "start", "to": "a"}, {"from": "a", "to": "b", "handle": "error"}]),
        "regex_condition": line({"id": "a", **sh}, {"id": "ok", "type": "if", "conditions": [{"path": "a.stdout_tail", "op": "regex", "value": "x"}]},
                                {"id": "y", **sh}, edges=[{"from": "start", "to": "a"}, {"from": "a", "to": "ok"},
                                                          {"from": "ok", "to": "y", "handle": "true"}, {"from": "ok", "to": "y", "handle": "false"}]),
        "uses_run_root": line({"id": "a", "type": "shell", "command": "echo {{run.id}}"}),
        "has_run_timeout": line({"id": "a", **sh}, settings={"max_run_minutes": 5}),
        "loop_not_one_block": line({"id": "a", **sh}, {"id": "x", **sh}, {"id": "b", **sh}, edges=[
            {"from": "start", "to": "a"}, {"from": "start", "to": "x"}, {"from": "a", "to": "b"}, {"from": "x", "to": "b"}, {"from": "b", "to": "a"}]),
    }
    for code, g in refused.items():
        assert validate(g) == [], (code, validate(g))
        try:
            to_js(g, code)
            raise AssertionError(f"{code}: exported")
        except ValueError as e:
            assert str(e).startswith(code + ": "), e
    print("export ok")
