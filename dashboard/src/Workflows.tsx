import '@xyflow/react/dist/style.css'
import {
  Background, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, addEdge, useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type Node, type NodeProps,
} from '@xyflow/react'
import { createContext, useContext, useEffect, useState, type DragEvent } from 'react'
import { ApiError, NEED_DAEMON, api, errText, usingMock } from './api'
import type { ViewProps } from './App'
import { parseSteps } from './parts'
import type { Capability, CapabilityDetail, Graph, Kind, NodeType, WfNode, WorkflowSettings, WorkflowStep } from './types'
import { Header, Search } from './ui'

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const KIND_COLOR: Record<Kind, string> = { skill: '#7c8cff', agent: '#b38cff', command: '#f59e42', workflow: '#3ddc97' }
const TYPE_COLOR: Record<NodeType, string> = { trigger: '#3ddc97', agent: '#b38cff', shell: '#f59e42', if: '#7c8cff', approval: '#f5b14a' }
const DND = 'application/ctc-cap'
const DEFAULT_SETTINGS: WorkflowSettings = { permission: 'worktree', allow_extra_usage: false, auto_resume: true, max_run_tokens: null }
const arrow = { type: MarkerType.ArrowClosed }

export type WfData = Omit<WfNode, 'id' | 'type' | 'pos'>
export type FlowNode = Node<WfData, NodeType>
const TRIGGER: FlowNode = { id: 'start', type: 'trigger', position: { x: 0, y: 0 }, data: {}, deletable: false }

/** `bad`: the node a 422 names (editor). `status`: each node's latest step status; `runs`: how often it ran (run page). */
export const NodeCtx = createContext<{ bad: string | null; status: Record<string, string>; runs?: Record<string, number> }>({ bad: null, status: {} })
const NO_STATUS = { bad: null, status: {} }

const firstLine = (s?: string) => (s ?? '').split('\n')[0]

function NodeView({ id, type, data, selected }: NodeProps<FlowNode>) {
  const { bad, status, runs } = useContext(NodeCtx)
  const sub = type === 'trigger' ? (data.input ? `input: ${data.input}` : 'run input → {{input}}')
    : type === 'agent' ? data.cap ?? data.agent ?? firstLine(data.prompt)
    : type === 'shell' ? firstLine(data.command)
    : type === 'approval' ? firstLine(data.message)
    : `${data.path ?? '?'} ${data.op ?? 'eq'} ${data.op === 'truthy' ? '' : JSON.stringify(data.value ?? null)}`
  return (
    <div className={`wfnode${selected ? ' sel' : ''}${bad === id ? ' bad' : ''}${status[id] ? ' st-' + status[id] : ''}`}>
      {type !== 'trigger' && <Handle type="target" position={Position.Left} />}
      <div className="mono wf-id"><span className="dot" style={{ background: TYPE_COLOR[type] }} />{id}<span className="wf-kind">{status[id] ?? type}</span>{(runs?.[id] ?? 0) > 1 && <span className="tag warn">×{runs![id]}</span>}</div>
      <div className="wf-sub mono">{sub || '—'}</div>
      {type === 'if'
        ? (['true', 'false'] as const).map(h => <div key={h} className="wf-out">{h}<Handle type="source" position={Position.Right} id={h} /></div>)
        : <Handle type="source" position={Position.Right} />}
    </div>
  )
}
export const nodeTypes = { trigger: NodeView, agent: NodeView, shell: NodeView, if: NodeView, approval: NodeView }

export const toFlow = (g: Graph): { nodes: FlowNode[]; edges: Edge[] } => ({
  nodes: g.nodes.map(({ id, type, pos, ...data }) => ({ id, type, position: { x: pos[0], y: pos[1] }, data, deletable: type !== 'trigger' })),
  edges: g.edges.map((e, i) => ({ id: `e${i}`, source: e.from, target: e.to, sourceHandle: e.handle ?? null, label: e.handle, markerEnd: arrow })),
})
const toGraph = (nodes: FlowNode[], edges: Edge[]): Graph => ({
  nodes: nodes.map(n => ({ id: n.id, type: n.type!, pos: [Math.round(n.position.x), Math.round(n.position.y)], ...n.data })),
  edges: edges.map(e => ({ from: e.source, to: e.target, ...(e.sourceHandle ? { handle: e.sourceHandle as 'true' | 'false' } : {}) })),
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
/** Back-edges dashed and labelled with the target's cap: its max_visits, else the graph default, else 3 (the walker's default). */
export const dashBack = (nodes: FlowNode[], edges: Edge[], max = 3) => {
  const b = backEdges(nodes, edges)
  const cap = (id: string) => nodes.find(n => n.id === id)?.data.max_visits ?? max
  return edges.map(e => (b.has(e.id) ? { ...e, className: 'back', label: `${e.label ? e.label + ' · ' : ''}loop ≤ ${cap(e.target)}` } : e))
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

type SetField = (k: keyof WfData, v: unknown) => void
function NodeForm({ n, ids, agents, set, rename }: { n: FlowNode; ids: string[]; agents: string[]; set: SetField; rename: (to: string) => void }) {
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
  return (
    <>
      <div className="card-title"><span className="dot" style={{ background: TYPE_COLOR[n.type!] }} />{n.type} node</div>
      <BlurField label="Id (templates use {{id.field}})" init={n.id} commit={s => {
        if (!NAME_RE.test(s)) throw new Error('Lowercase letters, digits and dashes; start with a letter or digit.')
        if (ids.includes(s)) throw new Error('Another node has this id.')
        rename(s) // ponytail: templates that name the old id are not rewritten; the daemon's 422 points at them
      }} />
      {n.type === 'trigger' && area('input', 'Default input')}
      {n.type === 'agent' && <>
        {area('prompt', 'Prompt: {{input}}, {{node.field}}, {{run.branch}}')}
        {text('cap', 'Capability (prefixes the prompt with /<invoke>)')}
        {pick('agent', 'Agent', agents, 'none')}
        <div className="row2">{text('model', 'Model')}{text('effort', 'Effort')}</div>
        <div className="row2">{pick('permission_mode', 'Permission mode', ['acceptEdits', 'dontAsk'])}{pick('on_error', 'On error', ['fail', 'continue'])}</div>
        <BlurField area label="Allowed tools (one per line)" init={(d.allowed_tools ?? []).join('\n')}
          commit={s => { const t = s.split('\n').map(x => x.trim()).filter(Boolean); set('allowed_tools', t.length ? t : undefined) }} />
        <BlurField area label="JSON schema (structured output)" init={json(d.json_schema)} commit={s => set('json_schema', parseJson(s))} />
        <BlurField area label="MCP config (JSON)" init={json(d.mcp_config)} commit={s => set('mcp_config', parseJson(s))} />
        {text('resume_from', 'Resume the session of node')}
        <div className="row2">{num('max_turns', 'Max turns')}{num('timeout_s', 'Timeout (s)')}</div>
        {check('readonly', 'Read-only (read tools, dontAsk)')}
      </>}
      {n.type === 'shell' && <>
        {area('command', 'Command (bash -c; template values are shell-quoted)')}
        {num('timeout_s', 'Timeout (s)')}
        {check('readonly', 'Read-only')}
      </>}
      {n.type === 'approval' && area('message', 'Message (shown on the run page while it waits)')}
      {n.type === 'if' && <>
        {text('path', 'Path, e.g. test.exit_code (missing = false)')}
        <div className="row2">
          <label>Op<select value={d.op ?? 'eq'} onChange={e => set('op', e.target.value)}>{['eq', 'ne', 'contains', 'truthy'].map(o => <option key={o}>{o}</option>)}</select></label>
          <BlurField label="Value (JSON or text)" init={d.value === undefined ? '' : typeof d.value === 'string' ? d.value : JSON.stringify(d.value)}
            commit={s => set('value', s === '' ? undefined : jsonOrText(s))} />
        </div>
      </>}
      {num('max_visits', 'Max visits')}
    </>
  )
}

function SettingsForm({ s, set }: { s: WorkflowSettings; set: (s: WorkflowSettings) => void }) {
  return (
    <>
      <div className="card-title">Workflow settings</div>
      <label>Permission<select value={s.permission} onChange={e => set({ ...s, permission: e.target.value as WorkflowSettings['permission'] })}>
        <option value="worktree">worktree: acceptEdits in a git worktree</option></select></label>
      <label className="toggle"><input type="checkbox" checked={s.allow_extra_usage} onChange={e => set({ ...s, allow_extra_usage: e.target.checked })} />Allow extra usage (paid overage)</label>
      <label className="toggle"><input type="checkbox" checked={s.auto_resume} onChange={e => set({ ...s, auto_resume: e.target.checked })} />Auto-resume when the quota resets</label>
      <label>Max run tokens (empty: no cap)<input type="number" min={1} value={s.max_run_tokens ?? ''}
        onChange={e => set({ ...s, max_run_tokens: e.target.value === '' ? null : Number(e.target.value) })} /></label>
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
  const flow = useReactFlow()

  useEffect(() => { api.capabilities({ project, q }).then(setPalette).catch(e => setErr(errText(e))) }, [project, q])
  useEffect(() => { api.capabilities({ project, kind: 'agent' }).then(rows => setAgents(rows.map(r => r.id))).catch(() => {}) }, [project])
  useEffect(() => { if (!loaded) setScope(project ? 'project' : 'user') }, [project]) // eslint-disable-line react-hooks/exhaustive-deps -- a new workflow follows the sidebar

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
  const onConnect = (c: Connection) => setEdges(es => addEdge({ ...c, label: c.sourceHandle ?? undefined, markerEnd: arrow }, es))
  const setField = (id: string, k: keyof WfData, v: unknown) => setNodes(ns => ns.map(n => {
    if (n.id !== id) return n
    const data: Record<string, unknown> = { ...n.data, [k]: v }
    if (v === '' || v === undefined || v === null) delete data[k]
    return { ...n, data: data as WfData }
  }))
  const rename = (from: string, to: string) => {
    setNodes(ns => ns.map(n => (n.id === from ? { ...n, id: to } : n)))
    setEdges(es => es.map(e => ({ ...e, source: e.source === from ? to : e.source, target: e.target === from ? to : e.target })))
  }

  const reset = () => {
    setNodes([TRIGGER]); setEdges([]); setSettings(DEFAULT_SETTINGS); setLoaded(null); setSaved(''); setName(''); setDesc('')
    setErr(''); setOk(''); setReadOnly(''); setBad(null); setScope(project ? 'project' : 'user')
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
  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.node_id) setBad(e.node_id)
    setErr(errText(e, { ns: loaded?.namespace }))
  }
  const save = async () => {
    setOk(''); setBad(null)
    if (!loaded && (!name || nameErr)) return setErr(nameErr || 'Name the workflow.')
    if (!desc.trim()) return setErr('Add a description (what Claude matches against).')
    if (scope === 'project' && !project && !loaded) return setErr('Select a project in the sidebar first, or save to user scope.')
    try {
      setErr('')
      if (loaded) {
        await api.updateCapability(loaded.id, { description: desc.trim(), graph, settings })
        setSaved(snap(graph, settings, desc)); setOk(`Saved ${loaded.id}.`)
      } else {
        const c = await api.createCapability({ kind: 'workflow', scope, project: scope === 'project' ? project ?? undefined : undefined, name, description: desc.trim(), graph, settings })
        await open(c.id)
        setOk(`Created ${c.id}.`)
      }
    } catch (e) { fail(e) }
  }
  const run = async () => {
    if (!loaded) return
    try {
      setErr(''); setOk(''); setBad(null)
      const r = await api.startRun(loaded.id, { input, project: project ?? undefined, trigger: 'button' })
      location.hash = `run/${r.run_id}`
    } catch (e) { if (usingMock()) setErr(NEED_DAEMON); else fail(e) }
  }
  const locked = !!readOnly
  const sel = nodes.find(n => n.selected)

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
        <button className="btn" style={{ borderColor: 'var(--accent)' }} onClick={save} disabled={locked}>{loaded ? 'Save' : 'Create'}</button>
        <button className="btn" onClick={reset}>New</button>
        <button className="btn" onClick={async () => setExisting(existing ? null : await api.capabilities({ project, kind: 'workflow' }))}>Open existing</button>
        <input className="inline-input" placeholder="Run input, fills {{input}}" aria-label="Run input" value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && canRun && run()} />
        <button className="btn" onClick={run} disabled={!canRun} title={canRun ? 'Run on its own git branch and worktree' : 'Save the workflow first'}>Run</button>
        <div className="wf-msg">
          {nameErr && <span className="err">{nameErr}</span>}
          {err && <span className="err">{err}{bad && ` (node ${bad})`}</span>}
          {readOnly && <span className="muted">{readOnly}</span>}
          {ok && <span className="okmsg">{ok}</span>}
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
            <button className="btn" disabled={locked} onClick={() => add('if', { op: 'eq' })}>+ IF</button>
            <button className="btn" disabled={locked} onClick={() => add('approval', { message: 'Approve and continue?' })}>+ Approval</button>
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
          {nodes.length <= 1 && <div className="wf-hint">Drag capabilities here (each becomes an Agent node) or add Shell, IF and Approval nodes,<br />then connect them from the trigger. Edges that loop back are drawn dashed.</div>}
        </div>
        <aside className="wf-panel card pad">
          <fieldset className="form" disabled={locked}>
            {sel
              ? <NodeForm key={sel.id} n={sel} ids={nodes.map(n => n.id)} agents={agents} set={(k, v) => setField(sel.id, k, v)} rename={to => rename(sel.id, to)} />
              : <div className="muted">Select a node to edit it.</div>}
          </fieldset>
          <fieldset className="form" disabled={locked}><SettingsForm s={settings} set={setSettings} /></fieldset>
        </aside>
      </div>
    </div>
  )
}

export default function Workflows(props: ViewProps & { theme: string }) {
  return <><Header crumb="Workflows" title="Workflow editor" sub="Agent, Shell, IF and Approval nodes on a canvas; each run gets its own git branch and worktree" /><ReactFlowProvider><Editor {...props} /></ReactFlowProvider></>
}
