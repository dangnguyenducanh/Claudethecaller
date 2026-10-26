import '@xyflow/react/dist/style.css'
import {
  Background, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, addEdge, useEdgesState, useNodeConnections, useNodesState, useReactFlow,
  useUpdateNodeInternals,
  type Connection, type Edge, type Node, type NodeProps,
} from '@xyflow/react'
import { createContext, useContext, useEffect, useRef, useState, type DragEvent } from 'react'
import { ApiError, NEED_DAEMON, api, errText, usingMock } from './api'
import type { ViewProps } from './App'
import { parseSteps } from './parts'
import type { Capability, CapabilityDetail, Condition, Graph, GraphIssue, Kind, NodeType, Op, RunDetail, RunInput, Schedule, SwitchCase, WfNode, WorkflowSettings, WorkflowStep } from './types'
import { Header, Search, fmtTime } from './ui'

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const KIND_COLOR: Record<Kind, string> = { skill: '#7c8cff', agent: '#b38cff', command: '#f59e42', workflow: '#3ddc97' }
const TYPE_COLOR: Record<NodeType, string> = { trigger: '#3ddc97', agent: '#b38cff', shell: '#f59e42', if: '#7c8cff', switch: '#c77dff', approval: '#f5b14a', merge: '#4ac9f5', stop: '#f25f5c', foreach: '#5ec4b6' }
const OPS: Op[] = ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'contains', 'not_contains', 'regex', 'exists', 'truthy']
const CASE_RE = /^[a-z0-9][a-z0-9_-]*$/ // graph.CASE: switch case names are their output handles
const DND = 'application/ctc-cap'
const DEFAULT_SETTINGS: WorkflowSettings = { permission: 'worktree', allow_extra_usage: false, auto_resume: true, max_run_tokens: null, max_run_minutes: null, approval_timeout_minutes: null }
const arrow = { type: MarkerType.ArrowClosed }

export type WfData = Omit<WfNode, 'id' | 'type' | 'pos'>
export type FlowNode = Node<WfData, NodeType>
const TRIGGER: FlowNode = { id: 'start', type: 'trigger', position: { x: 0, y: 0 }, data: {}, deletable: false }

/** `bad`: the node a 422 names (editor). `status`: each node's latest step status; `runs`: how often it ran (run page). */
export const NodeCtx = createContext<{ bad: string | null; status: Record<string, string>; runs?: Record<string, number> }>({ bad: null, status: {} })
const NO_STATUS = { bad: null, status: {} }

const firstLine = (s?: string) => (s ?? '').split('\n')[0]
const condText = (c: Partial<Condition>) => `${c.path || '?'} ${c.op ?? 'eq'} ${c.op === 'truthy' || c.op === 'exists' ? '' : JSON.stringify(c.value ?? null)}`
/** An IF's conditions: `conditions`, else the old single path/op/value form (graph.conditions). */
const ifConds = (d: WfData): Condition[] => d.conditions ?? (d.path ? [{ path: d.path, op: d.op ?? 'eq', ...(d.value !== undefined ? { value: d.value } : {}) }] : [])

function NodeView({ id, type, data, selected }: NodeProps<FlowNode>) {
  const { bad, status, runs } = useContext(NodeCtx)
  const inbound = useNodeConnections({ handleType: 'target' }).length
  const cases = data.cases ?? []
  const errOut = (type === 'agent' || type === 'shell') && data.on_error === 'error_output' // 'ok' = the id-less default handle
  const outs = type === 'if' ? ['true', 'false'] : type === 'switch' ? [...cases.map(c => c.name), 'default'] : type === 'foreach' ? ['body', 'done'] : errOut ? ['ok', 'error'] : null
  const updateInternals = useUpdateNodeInternals()
  const outKey = outs?.join('\n')
  useEffect(() => updateInternals(id), [id, outKey, updateInternals]) // React Flow caches handle positions
  const sub = type === 'trigger' ? (data.inputs?.length ? `inputs: ${data.inputs.map(i => i.name).join(', ')}` : data.input ? `input: ${data.input}` : 'run input → {{input}}')
    : type === 'agent' ? data.cap ?? data.agent ?? firstLine(data.prompt)
    : type === 'shell' ? firstLine(data.command)
    : type === 'approval' || type === 'stop' ? firstLine(data.message)
    : type === 'merge' ? `waits for ${inbound} input${inbound === 1 ? '' : 's'}`
    : type === 'switch' ? `${cases.length} case${cases.length === 1 ? '' : 's'} + default`
    : type === 'foreach' ? `each ${data.items || '?'} (≤ ${data.max_items ?? 50})`
    : data.conditions ? `${condText(data.conditions[0] ?? {})}${data.conditions.length > 1 ? ` +${data.conditions.length - 1}` : ''}`
    : condText(data)
  // the run page's status is the latest visit's marker ?? status, so a disabled step arrives as 'disabled'
  const kind = data.disabled && (status[id] === 'disabled' || status[id] === 'skipped') ? 'skipped (disabled)'
    : status[id] ?? (data.disabled ? `${type} · disabled` : type)
  return (
    <div className={`wfnode${selected ? ' sel' : ''}${bad === id ? ' bad' : ''}${status[id] ? ' st-' + status[id] : ''}`} title={data.notes} style={data.disabled ? { opacity: 0.45 } : undefined}>
      {type !== 'trigger' && <Handle type="target" position={Position.Left} />}
      <div className="mono wf-id"><span className="dot" style={{ background: TYPE_COLOR[type] }} />{id}<span className="wf-kind">{kind}</span>{(runs?.[id] ?? 0) > 1 && <span className="tag warn">×{runs![id]}</span>}{data.pin && <span className="tag" title="Pinned output: used by runs started with Use pins">pin</span>}{data.notes && <span className="tag">note</span>}</div>
      <div className="wf-sub mono">{sub || '—'}</div>
      {outs
        ? outs.map(h => <div key={h} className="wf-out">{h}<Handle type="source" position={Position.Right} id={errOut && h === 'ok' ? undefined : h}
          style={errOut && h === 'error' ? { background: 'var(--bad)' } : undefined} /></div>)
        : type !== 'stop' && <Handle type="source" position={Position.Right} />}
    </div>
  )
}
export const nodeTypes = { trigger: NodeView, agent: NodeView, shell: NodeView, if: NodeView, switch: NodeView, approval: NodeView, merge: NodeView, stop: NodeView, foreach: NodeView }

/** An error edge (on_error: error_output) is drawn red. ponytail: a switch case named 'error' is red too. */
const errStyle = (h?: string | null) => (h === 'error' ? { style: { stroke: 'var(--bad)' } } : {})
export const toFlow = (g: Graph): { nodes: FlowNode[]; edges: Edge[] } => ({
  nodes: g.nodes.map(({ id, type, pos, ...data }) => ({ id, type, position: { x: pos[0], y: pos[1] }, data, deletable: type !== 'trigger' })),
  edges: g.edges.map((e, i) => ({ id: `e${i}`, source: e.from, target: e.to, sourceHandle: e.handle ?? null, label: e.handle, markerEnd: arrow, ...errStyle(e.handle) })),
})
const toGraph = (nodes: FlowNode[], edges: Edge[]): Graph => ({
  nodes: nodes.map(n => ({ id: n.id, type: n.type!, pos: [Math.round(n.position.x), Math.round(n.position.y)], ...n.data })),
  edges: edges.map(e => ({ from: e.source, to: e.target, ...(e.sourceHandle ? { handle: e.sourceHandle } : {}) })),
})

/** Ids of edges that point at a node on the DFS stack from the trigger. Display only (dashed); the walker decides for real. */
export function backEdges(nodes: { id: string; type?: string }[], edges: { id: string; source: string; target: string }[]): Set<string> {
  const back = new Set<string>(), seen = new Set<string>(), stack = new Set<string>()
  const visit = (id: string) => {
    seen.add(id); stack.add(id)
    for (const e of edges) {
      if (e.source !== id) continue
      if (stack.has(e.target)) back.add(e.id)
      else if (!seen.has(e.target)) visit(e.target)
    }
    stack.delete(id)
  }
  const t = nodes.find(n => n.type === 'trigger')
  if (t) visit(t.id)
  return back
}
if (import.meta.env.DEV) console.assert([...backEdges([{ id: 's', type: 'trigger' }, { id: 'a' }, { id: 'b' }],
  [{ id: '1', source: 's', target: 'a' }, { id: '2', source: 'a', target: 'b' }, { id: '3', source: 'b', target: 'a' }])].join() === '3', 'backEdges self-check failed')
/** Back-edges dashed and labelled with the target's cap: its max_visits, else the graph default, else 3 (the walker's default);
 *  a for-each body's way back with its max_items (default 50). */
export const dashBack = (nodes: FlowNode[], edges: Edge[], max = 3) => {
  const b = backEdges(nodes, edges)
  const cap = (id: string) => {
    const n = nodes.find(x => x.id === id)
    return n?.type === 'foreach' ? `each ≤ ${n.data.max_items ?? 50}` : `loop ≤ ${n?.data.max_visits ?? max}`
  }
  return edges.map(e => (b.has(e.id) ? { ...e, className: 'back', label: `${e.label ? e.label + ' · ' : ''}${cap(e.target)}` } : e))
}

/** A workflow saved before graphs (`steps:` only) → the trigger chained to one Agent node per step. */
const fromSteps = (steps: WorkflowStep[]): Graph => {
  const nodes: WfNode[] = [{ id: 'start', type: 'trigger', pos: [0, 0] },
    ...steps.map((s, i): WfNode => ({ id: `step-${i + 1}`, type: 'agent', pos: [(i + 1) * 240, 0], cap: s.cap, prompt: '{{input}}', ...(s.agent ? { agent: s.agent } : {}) }))]
  return { nodes, edges: nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id })) }
}
/** `base` as a slug, or `base-2`, `base-3`… when taken. */
const freeId = (base: string, taken: string[]) => {
  const b = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'node'
  let id = b
  for (let i = 2; taken.includes(id); i++) id = `${b}-${i}`
  return id
}
const TPL = /\{\{\s*([\w.-]+)\s*\}\}/g // graph.TPL
/** A rename's references: every {{from…}} at any depth and every `path` / `resume_from` / `items` value naming `from` now
 *  names `to`, spacing and tail kept. Port of rename_node in src/ctc/runner/graph.py: keep the two in sync. */
export function renameRefs(data: WfData, from: string, to: string): WfData {
  const ref = (s: string) => (s.split('.')[0] === from ? to + s.slice(from.length) : s)
  const walk = (v: unknown, key?: string): unknown => {
    if (Array.isArray(v)) return v.map(x => walk(x))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]))
    if (typeof v !== 'string') return v
    const s = v.replace(TPL, (m, r: string) => m.replace(r, ref(r)))
    return key === 'path' || key === 'resume_from' || key === 'items' ? ref(s) : s
  }
  return walk(data) as WfData
}
if (import.meta.env.DEV) {
  const r = renameRefs({ command: 'echo {{fix.result}} {{ fixer.x }}', path: 'fix.exit_code', items: 'fix.structured_output' }, 'fix', 'repair')
  console.assert(r.command === 'echo {{repair.result}} {{ fixer.x }}' && r.path === 'repair.exit_code' && r.items === 'repair.structured_output',
    'renameRefs self-check failed')
}
const snap = (g: Graph, s: WorkflowSettings, desc: string) => JSON.stringify([g, s, desc.trim()])
const json = (v: unknown) => (v === undefined ? '' : JSON.stringify(v, null, 2))
const parseJson = (s: string) => (s.trim() ? JSON.parse(s) : undefined)
const jsonOrText = (s: string) => { try { return JSON.parse(s) } catch { return s } }

/** A field that commits on blur (and Enter in one-line fields): `commit` turns the text into the value, or throws to reject it. */
function BlurField({ label, init, commit, area }: { label: string; init: string; commit: (s: string) => void; area?: boolean }) {
  const [s, setS] = useState(init)
  const [err, setErr] = useState('')
  useEffect(() => setS(init), [init])
  const done = () => {
    if (s === init) return setErr('')
    try { commit(s); setErr('') } catch (e) { setErr(errText(e)) }
  }
  return (
    <label>{label}
      {area ? <textarea value={s} onChange={e => setS(e.target.value)} onBlur={done} />
        : <input value={s} onChange={e => setS(e.target.value)} onBlur={done} onKeyDown={e => e.key === 'Enter' && done()} />}
      {err && <span className="err">{err}</span>}
    </label>
  )
}

const GROUP = { display: 'grid', gap: 8, paddingTop: 8, borderTop: '1px solid var(--line)' }
const valueText = (v: unknown) => (v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v))

/** An IF's (or a switch case's) condition rows and their and/or. */
function Conditions({ conds, combine, onChange }: { conds: Condition[]; combine?: 'and' | 'or'; onChange: (conds: Condition[], combine?: 'and' | 'or') => void }) {
  const put = (i: number, patch: Partial<Condition>) => onChange(conds.map((c, j) => {
    if (j !== i) return c
    const { value, ...rest } = { ...c, ...patch }
    return value === undefined ? rest : { ...rest, value }
  }), combine)
  return (
    <>
      {conds.map((c, i) => (
        <div key={i} style={GROUP}>
          <label>Path, e.g. test.exit_code (missing = false)<input value={c.path} onChange={e => put(i, { path: e.target.value })} /></label>
          <div className="row2">
            <label>Op<select value={c.op} onChange={e => put(i, { op: e.target.value as Op })}>{OPS.map(o => <option key={o}>{o}</option>)}</select></label>
            {c.op !== 'exists' && c.op !== 'truthy' && <BlurField label="Value (JSON or text)" init={valueText(c.value)} commit={s => put(i, { value: s === '' ? undefined : jsonOrText(s) })} />}
          </div>
          <div className="actions"><button type="button" className="btn" onClick={() => onChange(conds.filter((_, j) => j !== i), combine)}>Remove condition</button></div>
        </div>
      ))}
      <div className="actions">
        <button type="button" className="btn" onClick={() => onChange([...conds, { path: '', op: 'eq' }], combine)}>+ Condition</button>
        {conds.length > 1 && <select aria-label="Combine" value={combine ?? 'and'} onChange={e => onChange(conds, e.target.value as 'and' | 'or')}>
          <option value="and">and: all match</option><option value="or">or: any matches</option></select>}
      </div>
    </>
  )
}

/** A switch's cases: each name is its output handle, so a rename or removal also moves or drops that handle's edges. */
function Cases({ cases, set, renameHandle, dropHandle }: { cases: SwitchCase[]; set: (c: SwitchCase[]) => void; renameHandle: (from: string, to: string) => void; dropHandle: (h: string) => void }) {
  const put = (i: number, c: SwitchCase) => set(cases.map((x, j) => (j === i ? c : x)))
  const free = () => { let k = cases.length + 1; while (cases.some(c => c.name === `case-${k}`)) k++; return `case-${k}` }
  return (
    <>
      {cases.map((c, i) => (
        <div key={i} style={GROUP}>
          <BlurField label={`Case ${i + 1}: name (its output)`} init={c.name} commit={s => {
            if (!CASE_RE.test(s)) throw new Error('Lowercase letters, digits, - or _; start with a letter or digit.')
            if (s === 'default') throw new Error('default is the output when no case matches.')
            if (cases.some((x, j) => j !== i && x.name === s)) throw new Error('Another case has this name.')
            put(i, { ...c, name: s }); renameHandle(c.name, s)
          }} />
          <Conditions conds={c.conditions} combine={c.combine} onChange={(conds, combine) => put(i, { name: c.name, conditions: conds, ...(combine ? { combine } : {}) })} />
          <div className="actions"><button type="button" className="btn" onClick={() => { set(cases.filter((_, j) => j !== i)); dropHandle(c.name) }}>Remove case {c.name}</button></div>
        </div>
      ))}
      <div className="actions"><button type="button" className="btn" onClick={() => set([...cases, { name: free(), conditions: [{ path: '', op: 'eq' }] }])}>+ Case</button></div>
      <div className="muted">The first case whose conditions match fires its output; when none does, default fires.</div>
    </>
  )
}

type SetField = (k: keyof WfData, v: unknown) => void
type NodeFormProps = {
  n: FlowNode; ids: string[]; agents: string[]; set: SetField; rename: (to: string) => void
  renameHandle: (from: string, to: string) => void; dropHandle: (h: string) => void // this node's out-edges, by handle
  lastOut?: { run: number; output: Record<string, unknown> } // this node's output in the workflow's latest run
}
function NodeForm({ n, ids, agents, set, rename, renameHandle, dropHandle, lastOut }: NodeFormProps) {
  const d = n.data
  const str = (k: keyof WfData) => (d[k] as string | undefined) ?? ''
  const text = (k: keyof WfData, label: string) => <label>{label}<input value={str(k)} onChange={e => set(k, e.target.value)} /></label>
  const area = (k: keyof WfData, label: string) => <label>{label}<textarea value={str(k)} onChange={e => set(k, e.target.value)} /></label>
  const num = (k: keyof WfData, label: string) => (
    <label>{label}<input type="number" min={1} value={(d[k] as number | undefined) ?? ''} onChange={e => set(k, e.target.value === '' ? undefined : Number(e.target.value))} /></label>
  )
  const pick = (k: keyof WfData, label: string, opts: string[], none = 'default') => (
    <label>{label}<select value={str(k)} onChange={e => set(k, e.target.value)}><option value="">{none}</option>{opts.map(o => <option key={o}>{o}</option>)}</select></label>
  )
  const check = (k: keyof WfData, label: string) => <label className="toggle"><input type="checkbox" checked={!!d[k]} onChange={e => set(k, e.target.checked || undefined)} />{label}</label>
  const pin = <>
    <BlurField area label="Pinned output (JSON object; used only when Use pins is on)" init={json(d.pin?.output)} commit={s => {
      if (!s.trim()) return set('pin', undefined)
      const output = JSON.parse(s)
      if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('Pin a JSON object, e.g. {"result": "ok"}')
      set('pin', { output })
    }} />
    {lastOut && <div className="actions"><button type="button" className="btn" onClick={() => set('pin', { output: lastOut.output })}>Pin output of run #{lastOut.run}</button></div>}
  </>
  return (
    <>
      <div className="card-title"><span className="dot" style={{ background: TYPE_COLOR[n.type!] }} />{n.type} node</div>
      <BlurField label="Id (templates use {{id.field}})" init={n.id} commit={s => {
        if (!NAME_RE.test(s)) throw new Error('Lowercase letters, digits and dashes; start with a letter or digit.')
        if (ids.includes(s)) throw new Error('Another node has this id.')
        rename(s)
      }} />
      {n.type === 'trigger' && area('input', 'Default input')}
      {n.type === 'agent' && <>
        {area('prompt', 'Prompt: {{input}}, {{node.field}}, {{run.branch}}, {{run.id}}, {{run.visit}}, {{now}}, {{vars.name}}; in a for-each body {{item}}, {{index}}')}
        {text('cap', 'Capability (prefixes the prompt with /<invoke>)')}
        {pick('agent', 'Agent', agents, 'none')}
        <div className="row2">{text('model', 'Model')}{text('effort', 'Effort')}</div>
        <div className="row2">{pick('permission_mode', 'Permission mode', ['acceptEdits', 'dontAsk', 'plan'])}{pick('on_error', 'On error', ['continue', 'error_output'], 'stop (default)')}</div>
        <BlurField area label="Allowed tools (one per line)" init={(d.allowed_tools ?? []).join('\n')}
          commit={s => { const t = s.split('\n').map(x => x.trim()).filter(Boolean); set('allowed_tools', t.length ? t : undefined) }} />
        <BlurField area label="JSON schema (structured output)" init={json(d.json_schema)} commit={s => set('json_schema', parseJson(s))} />
        <BlurField area label="MCP config (JSON)" init={json(d.mcp_config)} commit={s => set('mcp_config', parseJson(s))} />
        {text('resume_from', 'Resume the session of node')}
        <div className="row2">{num('max_turns', 'Max turns')}{num('timeout_s', 'Timeout (s)')}</div>
        {check('readonly', 'Read-only (read tools, dontAsk)')}
        {pin}
      </>}
      {n.type === 'shell' && <>
        {area('command', 'Command (bash -c; template values are shell-quoted)')}
        <div className="row2">{num('timeout_s', 'Timeout (s)')}{pick('on_error', 'On error', ['continue', 'error_output'], 'stop (default)')}</div>
        {d.readonly && check('readonly', 'Read-only (not allowed on shells: untick to save)')}
        <label className="toggle"><input type="checkbox" checked={!!d.idempotent} onChange={e => {
          set('idempotent', e.target.checked || undefined); if (!e.target.checked) set('retry', undefined)
        }} />Idempotent: safe to re-run (allows automatic retry)</label>
        {d.idempotent && <div className="row2">
          <label>Retry tries (1-5)<input type="number" min={1} max={5} value={d.retry?.max_tries ?? ''}
            onChange={e => set('retry', e.target.value === '' ? undefined : { ...d.retry, max_tries: Number(e.target.value) })} /></label>
          <label>Wait between tries (s, 0-300)<input type="number" min={0} max={300} disabled={!d.retry} value={d.retry?.wait_s ?? ''}
            onChange={e => d.retry && set('retry', { ...d.retry, wait_s: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
        </div>}
        {pin}
      </>}
      {n.type === 'approval' && area('message', 'Message (shown on the run page while it waits)')}
      {n.type === 'stop' && area('message', 'Message: fails the run (templates allowed)')}
      {n.type === 'merge' && <div className="muted">Runs once every inbound edge has arrived and at least one input ran (skipped branches count as arrived); output {'{inputs: {node: output}}'} over the inputs that ran. Not allowed inside a loop.</div>}
      {n.type === 'if' && <Conditions conds={ifConds(d)} combine={d.combine} onChange={(conds, combine) => {
        set('conditions', conds); set('combine', combine)
        set('path', undefined); set('op', undefined); set('value', undefined) // the old single form becomes conditions
      }} />}
      {n.type === 'switch' && <Cases cases={d.cases ?? []} set={c => set('cases', c)} renameHandle={renameHandle} dropHandle={dropHandle} />}
      {n.type === 'foreach' && <>
        {text('items', 'Items: path to a JSON array, e.g. names.stdout_tail')}
        {num('max_items', 'Max items (default 50)')}
        <div className="muted">body → nodes → back here, once per item, in order; {'{{item}}'} and {'{{index}}'} inside the body; done → {'{items: [...]}'}</div>
      </>}
      {!['trigger', 'if', 'switch', 'foreach'].includes(n.type!) && check('disabled', 'Disabled: runs pass straight through (output = upstream output)')}
      {num('max_visits', 'Max visits')}
      {area('notes', 'Notes (shown on hover)')}
    </>
  )
}

/** The trigger's cron schedule. It is the owner's `wf_schedules` row, not part of the workflow file, so it saves on its own. */
function ScheduleForm({ cap, set }: { cap: CapabilityDetail; set: (s: Schedule | null) => void }) {
  const s = cap.schedule
  const [cron, setCron] = useState(s?.cron ?? '')
  const [enabled, setEnabled] = useState(s?.enabled ?? true)
  const [ok, setOk] = useState('')
  const [err, setErr] = useState('') // the 422 bad_cron message, among others
  const call = async (f: () => Promise<string>) => {
    setOk(''); setErr('')
    try { setOk(await f()) } catch (e) { setErr(usingMock() ? NEED_DAEMON : errText(e)) }
  }
  const save = () => call(async () => { set(await api.setSchedule(cap.id, { cron: cron.trim(), input: s?.input, enabled })); return '' })
  const remove = () => call(async () => { await api.deleteSchedule(cap.id); set(null); setCron(''); setEnabled(true); return 'Removed.' })
  return (
    <>
      <div className="card-title">Schedule</div>
      <label>Cron: min hour dom mon dow, daemon local time
        <input className="mono" value={cron} placeholder="0 9 * * 1-5" onChange={e => setCron(e.target.value)} onKeyDown={e => e.key === 'Enter' && cron.trim() && save()} /></label>
      <label className="toggle"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />Enabled</label>
      <div className="actions">
        <button className="btn" disabled={!cron.trim()} onClick={save}>Save schedule</button>
        <button className="btn" disabled={!s} onClick={remove}>Remove</button>
      </div>
      {err ? <span className="err">{err}</span>
        : ok ? <span className="okmsg">{ok}</span>
        : s && <span className="muted">{s.enabled && s.next_at ? `Next run ${fmtTime(s.next_at)}` : 'Disabled'}{s.last_fired_at && ` · last fired ${fmtTime(s.last_fired_at)}`}</span>}
    </>
  )
}

function SettingsForm({ s, set }: { s: WorkflowSettings; set: (s: WorkflowSettings) => void }) {
  return (
    <>
      <div className="card-title">Workflow settings</div>
      <label>Permission<select value={s.permission} onChange={e => set({ ...s, permission: e.target.value as WorkflowSettings['permission'] })}>
        <option value="worktree">worktree: acceptEdits in a git worktree</option>
        <option value="container">container: full bypass inside Docker, your login mounted</option></select></label>
      <label className="toggle"><input type="checkbox" checked={s.allow_extra_usage} onChange={e => set({ ...s, allow_extra_usage: e.target.checked })} />Allow extra usage (paid overage)</label>
      <label className="toggle"><input type="checkbox" checked={s.auto_resume} onChange={e => set({ ...s, auto_resume: e.target.checked })} />Auto-resume when the quota resets</label>
      <label>Max run tokens (empty: no cap)<input type="number" min={1} value={s.max_run_tokens ?? ''}
        onChange={e => set({ ...s, max_run_tokens: e.target.value === '' ? null : Number(e.target.value) })} /></label>
      <label>Max run minutes (empty: no limit)<input type="number" min={0} step="any" value={s.max_run_minutes ?? ''}
        onChange={e => set({ ...s, max_run_minutes: e.target.value === '' ? null : Number(e.target.value) })} /></label>
      <label>Approval timeout minutes (empty: wait forever)<input type="number" min={0} step="any" value={s.approval_timeout_minutes ?? ''}
        onChange={e => set({ ...s, approval_timeout_minutes: e.target.value === '' ? null : Number(e.target.value) })} /></label>
    </>
  )
}

function Editor({ project, theme }: ViewProps & { theme: string }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([TRIGGER])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [settings, setSettings] = useState<WorkflowSettings>(DEFAULT_SETTINGS)
  const [agents, setAgents] = useState<string[]>([])
  const [palette, setPalette] = useState<Capability[]>([])
  const [q, setQ] = useState('')
  const [existing, setExisting] = useState<Capability[] | null>(null)
  const [loaded, setLoaded] = useState<CapabilityDetail | null>(null) // set while editing an existing workflow
  const [saved, setSaved] = useState('') // snap() of the last saved state: Run stays off while the canvas differs
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [scope, setScope] = useState<'user' | 'project'>(project ? 'project' : 'user')
  const [input, setInput] = useState('')
  const [bad, setBad] = useState<string | null>(null) // node named by a 422 invalid_graph
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')
  const [readOnly, setReadOnly] = useState('') // why Save is off, shown instead of an error
  const [pinned, setPinned] = useState(false) // Run with pins: pinned nodes return their pinned output
  const [last, setLast] = useState<RunDetail | null>(null) // the loaded workflow's latest run, for 'Pin output of run #N'
  const [conflict, setConflict] = useState(false) // a save hit 409 changed_on_disk: Reload or Overwrite
  const [warns, setWarns] = useState<GraphIssue[]>([]) // the last save's graph warnings (refs that would render empty)
  const dlg = useRef<HTMLDialogElement>(null) // the run dialog, for a trigger that declares inputs
  const [vals, setVals] = useState<Record<string, string>>({}) // its fields, sent as strings: the daemon coerces them
  const [dlgErr, setDlgErr] = useState('') // a 422 bad_input, shown in the dialog
  // Undo/redo history: JSON of toGraph() (no selection, settings or description); cur = the last recorded canvas
  const hist = useRef({ past: [] as string[], future: [] as string[], cur: JSON.stringify(toGraph([TRIGGER], [])) })
  const [, setTick] = useState(0) // re-renders Undo/Redo after a history change
  const flow = useReactFlow()
  const loadedId = loaded?.id

  useEffect(() => { api.capabilities({ project, q }).then(setPalette).catch(e => setErr(errText(e))) }, [project, q])
  useEffect(() => { api.capabilities({ project, kind: 'agent' }).then(rows => setAgents(rows.map(r => r.id))).catch(() => {}) }, [project])
  useEffect(() => { if (!loaded) setScope(project ? 'project' : 'user') }, [project]) // eslint-disable-line react-hooks/exhaustive-deps -- a new workflow follows the sidebar
  useEffect(() => {
    setLast(null)
    if (loadedId) api.runs({ workflow: loadedId, limit: 1 }).then(rs => (rs[0] ? api.run(rs[0].id) : null)).then(setLast).catch(() => {})
  }, [loadedId])

  const add = (type: NodeType, data: WfData, at?: { x: number; y: number }) => {
    const pos = at ?? { x: Math.max(0, ...nodes.map(n => n.position.x)) + 240, y: 0 }
    setNodes(ns => [...ns.map(n => ({ ...n, selected: false })), {
      id: freeId(data.cap?.split(':').pop() ?? type, ns.map(n => n.id)), type, data, selected: true, position: pos,
    }])
    if (!at) flow.setCenter(pos.x + 90, pos.y + 30, { zoom: flow.getZoom(), duration: 200 }) // a button add lands where you can see it
    setOk('')
  }
  const addCap = (c: Capability, at?: { x: number; y: number }) => add('agent', c.kind === 'agent' ? { agent: c.id, prompt: '{{input}}' } : { cap: c.id, prompt: '{{input}}' }, at)
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    const c = palette.find(x => x.id === e.dataTransfer.getData(DND))
    if (c && !readOnly) addCap(c, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }))
  }
  // Any shape is allowed (branches, loops); the daemon's validator has the last word. Only self-loops and duplicates are blocked here.
  const isValid = (c: Edge | Connection) => c.source !== c.target
    && !edges.some(e => e.source === c.source && e.target === c.target && (e.sourceHandle ?? null) === (c.sourceHandle ?? null))
  const onConnect = (c: Connection) => setEdges(es => addEdge({ ...c, label: c.sourceHandle ?? undefined, markerEnd: arrow, ...errStyle(c.sourceHandle) }, es))
  const setField = (id: string, k: keyof WfData, v: unknown) => setNodes(ns => ns.map(n => {
    if (n.id !== id) return n
    const data: Record<string, unknown> = { ...n.data, [k]: v }
    if (v === '' || v === undefined || v === null) delete data[k]
    return { ...n, data: data as WfData }
  }))
  const rename = (from: string, to: string) => {
    setNodes(ns => ns.map(n => ({ ...n, id: n.id === from ? to : n.id, data: renameRefs(n.data, from, to) })))
    setEdges(es => es.map(e => ({ ...e, source: e.source === from ? to : e.source, target: e.target === from ? to : e.target })))
  }
  const renameHandle = (node: string, from: string, to: string) =>
    setEdges(es => es.map(e => (e.source === node && e.sourceHandle === from ? { ...e, sourceHandle: to, label: to } : e)))
  const dropHandle = (node: string, h: string) => setEdges(es => es.filter(e => !(e.source === node && e.sourceHandle === h)))

  const reset = () => {
    setNodes([TRIGGER]); setEdges([]); setSettings(DEFAULT_SETTINGS); setLoaded(null); setSaved(''); setName(''); setDesc('')
    setErr(''); setOk(''); setReadOnly(''); setBad(null); setScope(project ? 'project' : 'user'); setConflict(false); setWarns([])
    hist.current = { past: [], future: [], cur: JSON.stringify(toGraph([TRIGGER], [])) }; setTick(t => t + 1)
  }
  const open = async (id: string) => {
    try {
      const d = await api.capability(id, project)
      reset()
      // ponytail: a workflow saved before graphs has only `steps` (or only the YAML body), so chain them; Run needs a Save first.
      // If that yields nothing, Save stays off rather than overwrite.
      const steps: WorkflowStep[] = d.steps ?? parseSteps(d.body)
      const g = d.graph ?? (steps.length ? fromSteps(steps) : null)
      const s = d.settings ?? DEFAULT_SETTINGS
      if (g) {
        const f = toFlow(g)
        setNodes(f.nodes); setEdges(f.edges)
        hist.current.cur = JSON.stringify(toGraph(f.nodes, f.edges)) // the opened graph is the history's start
        if (d.graph) setSaved(snap(toGraph(f.nodes, f.edges), s, d.description))
      }
      setSettings(s)
      setLoaded(d); setName(d.name); setDesc(d.description); setScope(d.namespace === 'user' ? 'user' : 'project'); setExisting(null)
      if (!d.editable) setReadOnly(errText(new ApiError(403, 'read_only', ''), { ns: d.namespace }))
      else if (!g) setReadOnly('Could not read this workflow\'s graph from the API, so Save is off to avoid overwriting it.')
      setTimeout(() => flow.fitView({ maxZoom: 1 }), 50) // once React Flow has measured the new nodes
    } catch (e) { setErr(errText(e)) }
  }

  const nameErr = !loaded && name && !NAME_RE.test(name) ? 'Lowercase letters, digits and dashes; start with a letter or digit; up to 64 characters.' : ''
  const graph = toGraph(nodes, edges)
  const canRun = !!loaded && snap(graph, settings, desc) === saved
  const graphJson = JSON.stringify(graph)
  const record = (json: string) => { // one entry per settled change: a drag or a typed prompt is one step
    const h = hist.current
    if (json === h.cur) return
    h.past = [...h.past, h.cur].slice(-100); h.future = []; h.cur = json; setTick(t => t + 1)
  }
  useEffect(() => { const t = setTimeout(() => record(graphJson), 300); return () => clearTimeout(t) }, [graphJson]) // eslint-disable-line react-hooks/exhaustive-deps -- record reads only the ref
  const show = (json: string) => { const f = toFlow(JSON.parse(json)); setNodes(f.nodes); setEdges(f.edges) }
  const undo = () => {
    record(graphJson) // an edit still inside the 300 ms window is its own step
    const h = hist.current, prev = h.past.pop()
    if (prev === undefined) return
    h.future.push(h.cur); h.cur = prev; show(prev)
  }
  const redo = () => {
    record(graphJson) // a fresh edit drops the redo stack, as it would 300 ms later
    const h = hist.current, next = h.future.pop()
    if (next === undefined) return
    h.past.push(h.cur); h.cur = next; show(next)
  }
  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.node_id) setBad(e.node_id)
    setErr(errText(e, { ns: loaded?.namespace }))
  }
  const save = async (overwrite = false) => { // overwrite: no base_hash, so the daemon writes over an on-disk edit
    setOk(''); setBad(null); setConflict(false); setWarns([])
    if (!loaded && (!name || nameErr)) return setErr(nameErr || 'Name the workflow.')
    if (!desc.trim()) return setErr('Add a description (what Claude matches against).')
    if (scope === 'project' && !project && !loaded) return setErr('Select a project in the sidebar first, or save to user scope.')
    try {
      setErr('')
      if (loaded) {
        const c = await api.updateCapability(loaded.id, { description: desc.trim(), graph, settings, base_hash: overwrite ? undefined : loaded.file_hash ?? undefined })
        setLoaded(l => l && { ...l, file_hash: c.file_hash ?? null })
        setSaved(snap(graph, settings, desc)); setOk(`Saved ${loaded.id}.`); setWarns(c.warnings ?? [])
      } else {
        const c = await api.createCapability({ kind: 'workflow', scope, project: scope === 'project' ? project ?? undefined : undefined, name, description: desc.trim(), graph, settings })
        await open(c.id) // reset()s the warnings, so they are set after it
        setOk(`Created ${c.id}.`); setWarns(c.warnings ?? [])
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'changed_on_disk') setConflict(true) // before fail(): errText reads every 409 as a name clash
      else fail(e)
    }
  }
  const reload = () => { if (loaded && confirm('Drop your unsaved canvas edits?')) open(loaded.id) }
  const decl = (nodes.find(n => n.type === 'trigger')?.data.inputs ?? []) as RunInput[]
  const run = async (inputs?: Record<string, string>) => {
    if (!loaded) return
    if (decl.length && !inputs) { // typed inputs: ask for them first, starting from their defaults
      setVals(Object.fromEntries(decl.map(i => [i.name, i.type === 'bool' ? String(i.default ?? false)
        : i.default == null ? '' : typeof i.default === 'string' ? i.default : JSON.stringify(i.default)])))
      setDlgErr('')
      return dlg.current?.showModal()
    }
    try {
      setErr(''); setOk(''); setBad(null); setWarns([])
      const r = await api.startRun(loaded.id, { ...(inputs ? { inputs } : { input }), project: project ?? undefined, trigger: 'button', pinned })
      dlg.current?.close()
      location.hash = `run/${r.run_id}`
    } catch (e) {
      if (inputs) setDlgErr(usingMock() ? NEED_DAEMON : errText(e))
      else if (usingMock()) setErr(NEED_DAEMON)
      else fail(e)
    }
  }
  const exportWf = async () => {
    if (!loaded) return
    try {
      setErr(''); setOk(''); setBad(null)
      setOk(`Exported to ${(await api.exportWorkflow(loaded.id)).path}`)
    } catch (e) {
      if (usingMock()) setErr(NEED_DAEMON)
      else if (e instanceof ApiError && e.code === 'has_approval') setErr('Approval nodes have no native equivalent: remove them to export.')
      else if (e instanceof ApiError && e.status === 409) setErr(`A different file is already at the export path; move it away first. ${e.message}`)
      else fail(e)
    }
  }
  const locked = !!readOnly
  const sel = nodes.find(n => n.selected)
  const lastStep = last?.steps.filter(s => s.node_id === sel?.id && s.status === 'done' && s.output && s.marker !== 'pinned').at(-1)
  const lastOut = last && lastStep?.output ? { run: last.id, output: lastStep.output } : undefined

  useEffect(() => { // re-bound every render, so the handlers see the current canvas; fields keep their native undo and clipboard
    const inField = (e: Event) => {
      const t = e.target as HTMLElement | null
      return !!t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable)
    }
    const onKey = (e: KeyboardEvent) => {
      if (locked || inField(e) || !(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) undo()
      else if (k === 'z' || (k === 'y' && e.ctrlKey)) redo()
      else return
      e.preventDefault()
    }
    const onCopy = (e: ClipboardEvent) => { // read-only workflows too
      const picked = nodes.filter(n => n.selected && n.type !== 'trigger')
      if (inField(e) || !picked.length || !e.clipboardData || window.getSelection()?.toString()) return
      const ids = new Set(picked.map(n => n.id))
      // ponytail: JSON is valid YAML; no YAML lib in the dashboard, so block-style YAML pasted from a file is refused
      e.clipboardData.setData('text/plain', JSON.stringify(toGraph(picked, edges.filter(x => ids.has(x.source) && ids.has(x.target))), null, 2))
      e.preventDefault()
    }
    const onPaste = (e: ClipboardEvent) => {
      if (locked || inField(e)) return
      e.preventDefault()
      try {
        const g = JSON.parse(e.clipboardData?.getData('text/plain') ?? '') as Graph
        if (!Array.isArray(g?.nodes)) throw new Error('no nodes')
        const picked = g.nodes.filter(n => n.type !== 'trigger' && Object.hasOwn(TYPE_COLOR, n.type)) // one trigger per workflow
        const taken = nodes.map(n => n.id), ids = new Map<string, string>()
        for (const n of picked) { const id = freeId(n.id, taken); ids.set(n.id, id); taken.push(id) }
        const f = toFlow({
          nodes: picked.map(n => ({ ...n, id: ids.get(n.id)!, pos: [(n.pos?.[0] ?? 0) + 40, (n.pos?.[1] ?? 0) + 40] })),
          edges: (g.edges ?? []).filter(x => ids.has(x.from) && ids.has(x.to)).map(x => ({ ...x, from: ids.get(x.from)!, to: ids.get(x.to)! })),
        })
        const renames = [...ids].filter(([a, b]) => a !== b).reverse() // a new id can equal a later pasted node's old id, never an earlier one's
        const stamp = Date.now()
        setNodes(ns => [...ns.map(n => ({ ...n, selected: false })),
          ...f.nodes.map(n => ({ ...n, selected: true, data: renames.reduce((d, [a, b]) => renameRefs(d, a, b), n.data) }))])
        setEdges(es => [...es.map(x => ({ ...x, selected: false })), ...f.edges.map((x, i) => ({ ...x, id: `p${stamp}-${i}` }))])
        setErr('')
      } catch { setErr('Paste expects nodes copied from this editor.') }
    }
    window.addEventListener('keydown', onKey); window.addEventListener('copy', onCopy); window.addEventListener('paste', onPaste)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('copy', onCopy); window.removeEventListener('paste', onPaste) }
  })

  return (
    <div className="wf">
      <div className="wf-top card pad">
        <input className="inline-input" placeholder="workflow-name" aria-label="Workflow name" value={name} disabled={!!loaded} onChange={e => setName(e.target.value)} />
        <input className="inline-input wf-desc" placeholder="Description: when should Claude use this workflow?" aria-label="Description" value={desc} disabled={locked} onChange={e => setDesc(e.target.value)} />
        {loaded
          ? <span className="tag" title="Where this workflow lives">{loaded.namespace}</span>
          : (
            <select className="inline-input" aria-label="Scope" value={scope} onChange={e => setScope(e.target.value as 'user' | 'project')}>
              <option value="user">user (~/.claude)</option><option value="project">project{project ? `: ${project}` : ' (select one)'}</option>
            </select>
          )}
        <button className="btn" style={{ borderColor: 'var(--accent)' }} onClick={() => save()} disabled={locked}>{loaded ? 'Save' : 'Create'}</button>
        <button className="btn" onClick={reset}>New</button>
        <button className="btn" onClick={undo} title="Undo (Ctrl+Z)" disabled={locked || !(hist.current.past.length || graphJson !== hist.current.cur)}>Undo</button>
        <button className="btn" onClick={redo} title="Redo (Ctrl+Shift+Z)" disabled={locked || !hist.current.future.length || graphJson !== hist.current.cur}>Redo</button>
        <button className="btn" onClick={async () => setExisting(existing ? null : await api.capabilities({ project, kind: 'workflow' }))}>Open existing</button>
        {!decl.length && <input className="inline-input" placeholder="Run input, fills {{input}}" aria-label="Run input" value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && canRun && run()} />}
        <label className="toggle" title="Pinned nodes return their pinned output: no agent runs, no commit"><input type="checkbox" checked={pinned} onChange={e => setPinned(e.target.checked)} />Use pins</label>
        <button className="btn" onClick={() => run()} disabled={!canRun} title={canRun ? 'Run on its own git branch and worktree' : 'Save the workflow first'}>Run</button>
        <dialog ref={dlg} className="card pad" style={{ color: 'inherit', minWidth: 360 }} aria-label={`Run ${loaded?.name ?? ''}`}>
          <form className="form" noValidate onSubmit={e => { e.preventDefault(); run(vals) }}>
            <div className="card-title">Run {loaded?.name}</div>
            {decl.map(i => {
              const v = vals[i.name] ?? '', put = (x: string) => setVals(o => ({ ...o, [i.name]: x }))
              const label = <span className="mono">{i.name}{i.required ? ' *' : ''}</span>
              const hint = i.description && <span className="muted">{i.description}</span>
              return i.type === 'bool'
                ? <label key={i.name} className="toggle"><input type="checkbox" checked={/^(true|1|yes|on)$/i.test(v)} onChange={e => put(String(e.target.checked))} />{label}{hint}</label>
                : <label key={i.name}>{label}{i.type === 'json'
                  ? <textarea className="mono" value={v} onChange={e => put(e.target.value)} />
                  : <input type={i.type === 'number' ? 'number' : 'text'} step="any" value={v} onChange={e => put(e.target.value)} />}{hint}</label>
            })}
            {dlgErr && <span className="err">{dlgErr}</span>}
            <div className="actions"><button type="button" className="btn" onClick={() => dlg.current?.close()}>Cancel</button><button className="btn" style={{ borderColor: 'var(--accent)' }}>Run</button></div>
          </form>
        </dialog>
        <button className="btn" onClick={exportWf} disabled={!canRun} title={canRun ? 'Write .claude/workflows/<name>.js in Claude Code\'s native format' : 'Save the workflow first'}>Export</button>
        <div className="wf-msg">
          {nameErr && <span className="err">{nameErr}</span>}
          {err && <span className="err">{err}{bad && ` (node ${bad})`}</span>}
          {conflict && <span className="err">The file changed on disk since you opened it.{' '}
            <button className="btn" onClick={reload}>Reload</button> <button className="btn" onClick={() => save(true)}>Overwrite</button></span>}
          {readOnly && <span className="muted">{readOnly}</span>}
          {ok && <span className="okmsg">{ok}</span>}
          {warns.map((w, i) => <span key={i} className="tag warn">{w.node_id}: {w.message}</span>)}
        </div>
        {existing && (
          <div className="menu wf-open">
            {existing.length ? existing.map(c => <button key={c.id} className="navitem" onClick={() => open(c.id)}><span className="mono">{c.id}</span></button>) : <span>No workflows yet.</span>}
          </div>
        )}
      </div>
      <div className="wf-body">
        <aside className="wf-palette card">
          <div className="pad actions">
            <button className="btn" disabled={locked} onClick={() => add('agent', { prompt: '{{input}}' })}>+ Agent</button>
            <button className="btn" disabled={locked} onClick={() => add('shell', {})}>+ Shell</button>
            <button className="btn" disabled={locked} onClick={() => add('if', { conditions: [{ path: '', op: 'eq' }] })}>+ IF</button>
            <button className="btn" disabled={locked} onClick={() => add('switch', { cases: [{ name: 'case-1', conditions: [{ path: '', op: 'eq' }] }] })}>+ Switch</button>
            <button className="btn" disabled={locked} onClick={() => add('approval', { message: 'Approve and continue?' })}>+ Approval</button>
            <button className="btn" disabled={locked} onClick={() => add('merge', {})}>+ Merge</button>
            <button className="btn" disabled={locked} onClick={() => add('stop', { message: 'Stopped: {{input}}' })}>+ Stop</button>
            <button className="btn" disabled={locked} onClick={() => add('foreach', { items: '' })}>+ For-each</button>
            <Search value={q} onChange={setQ} placeholder="Find a capability" />
          </div>
          <div className="wf-list">
            {palette.map(c => (
              <div key={c.id} className="wf-item" draggable={!locked} onDragStart={e => e.dataTransfer.setData(DND, c.id)} onClick={() => !locked && addCap(c)} title="Drag onto the canvas, or click to add as an Agent node">
                <span className="dot" style={{ background: KIND_COLOR[c.kind] }} /><span className="mono">{c.id}</span>
              </div>
            ))}
          </div>
        </aside>
        <div className="wf-canvas card" onDragOver={e => e.preventDefault()} onDrop={onDrop}>
          <NodeCtx.Provider value={bad ? { bad, status: {} } : NO_STATUS}>
            <ReactFlow nodes={nodes} edges={dashBack(nodes, edges, loaded?.graph?.defaults?.max_visits)} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
              isValidConnection={isValid} colorMode={theme === 'light' ? 'light' : 'dark'} fitView fitViewOptions={{ maxZoom: 1 }} minZoom={0.2} nodesDraggable={!locked} nodesConnectable={!locked}
              elementsSelectable deleteKeyCode={locked ? null : ['Backspace', 'Delete']} proOptions={{ hideAttribution: true }}>
              <Background gap={20} />
              <Controls showInteractive={false} />
            </ReactFlow>
          </NodeCtx.Provider>
          {nodes.length <= 1 && <div className="wf-hint">Drag capabilities here (each becomes an Agent node) or add Shell, IF, Switch, Approval, Merge, Stop and For-each nodes,<br />then connect them from the trigger. Edges that loop back are drawn dashed.</div>}
        </div>
        <aside className="wf-panel card pad">
          <fieldset className="form" disabled={locked}>
            {sel
              ? <NodeForm key={sel.id} n={sel} ids={nodes.map(n => n.id)} agents={agents} set={(k, v) => setField(sel.id, k, v)} rename={to => rename(sel.id, to)}
                renameHandle={(from, to) => renameHandle(sel.id, from, to)} dropHandle={h => dropHandle(sel.id, h)} lastOut={lastOut} />
              : <div className="muted">Select a node to edit it.</div>}
          </fieldset>
          {sel?.type === 'trigger' && <fieldset className="form">{/* not locked: the schedule is the owner's DB row, not the file */}
            {loaded ? <ScheduleForm key={loaded.id} cap={loaded} set={s => setLoaded(l => l && { ...l, schedule: s })} />
              : <div className="muted">Save the workflow to schedule it.</div>}
          </fieldset>}
          <fieldset className="form" disabled={locked}><SettingsForm s={settings} set={setSettings} /></fieldset>
        </aside>
      </div>
    </div>
  )
}

export default function Workflows(props: ViewProps & { theme: string }) {
  return <><Header crumb="Workflows" title="Workflow editor" sub="Agent, Shell, IF, Switch, Approval, Merge, Stop and For-each nodes on a canvas; each run gets its own git branch and worktree" /><ReactFlowProvider><Editor {...props} /></ReactFlowProvider></>
}
