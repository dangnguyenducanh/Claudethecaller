export const meta = { name: "edit-demo", description: "Screenshot demo - a shell node writes a file, a second checks it, an IF reports" }

// Exported by claudethecaller (ctc) from its canvas workflow "edit-demo"; export again after editing it there.
const SHELL = {type: 'object', properties: {exit_code: {type: 'number'}, stdout_tail: {type: 'string'}}, required: ['exit_code', 'stdout_tail']}
const out = {}, ran = new Set(), visits = {}
const get = (v, path) => path.reduce((x, k) => x == null ? undefined : x[k], v)
const txt = v => v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v)
const q = s => "'" + s.replaceAll("'", "'\\''") + "'"
const on = (id, handle) => ran.has(id) && (handle === undefined || out[id].value === handle)
const set = (id, v) => { out[id] = v; ran.add(id); visits[id] = (visits[id] || 0) + 1 }
const test = (v, op, want) => v !== undefined && (op === 'truthy' ? Boolean(v)
  : op === 'contains' ? (Array.isArray(v) ? v.includes(want) : txt(v).includes(txt(want)))
  : (v === want || txt(v) === txt(want)) === (op === 'eq'))
const ag = async (prompt, opts) => { const r = await agent(prompt, opts); return typeof r === 'string' ? {result: r} : {result: txt(r), structured_output: r} }
const sh = (id, cmd) => agent('Run exactly this shell command in the repo and report the exit code and the last lines of output: ' + cmd, {label: id, schema: SHELL})
const input = args ?? ""

set("start", {input})
if (on("start")) set("write", await sh("write", "printf 'hello from ctc\\ninput: %s\\n' " + q(txt(get(input, []))) + " > hello.txt && cat hello.txt"))
if (on("write")) set("check", await sh("check", "grep -q hello hello.txt"))
if (on("check")) set("ok", {value: test(get(out, ["check", "exit_code"]), "eq", 0)})
if (on("ok", true)) set("green", await sh("green", "echo green"))
if (on("ok", false)) set("red", await sh("red", "echo red"))
return out
