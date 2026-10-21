import '@xyflow/react/dist/style.css'
import {
  Background, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, addEdge, useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type Node, type NodeProps,
} from '@xyflow/react'
import { createContext, useContext, useEffect, useRef, useState, type DragEvent } from 'react'
import { ApiError, api, errText } from './api'
import type { ViewProps } from './App'
import { parseSteps } from './parts'
import type { Capability, CapabilityDetail, Kind, WorkflowStep } from './types'
import { Header, Search } from './ui'

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const KIND_COLOR: Record<Kind, string> = { skill: '#7c8cff', agent: '#b38cff', command: '#f59e42', workflow: '#3ddc97' }
const DND = 'application/ctc-cap'

type CapNode = Node<{ capId: string; kind: Kind }, 'cap'>
const Ctx = createContext<{ agents: string[]; locked: boolean; setAgent: (nodeId: string, agent: string) => void; agentOf: Record<string, string> }>(
  { agents: [], locked: false, setAgent: () => {}, agentOf: {} },
)

function CapNodeView({ id, data, selected }: NodeProps<CapNode>) {
  const { agents, locked, setAgent, agentOf } = useContext(Ctx)
  return (
    <div className={'wfnode' + (selected ? ' sel' : '')}>
      <Handle type="target" position={Position.Top} />
      <div className="mono wf-id"><span className="dot" style={{ background: KIND_COLOR[data.kind] }} />{data.capId}</div>
      <div className="wf-kind">{data.kind}</div>
      {data.kind !== 'agent' && (
        <select className="nodrag" aria-label="Agent for this step" disabled={locked} value={agentOf[id] ?? ''} onChange={e => setAgent(id, e.target.value)}>
          <option value="">no agent</option>
          {agents.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}
const nodeTypes = { cap: CapNodeView }

/** Follow edges from the one node with no incoming edge. Returns the ordered node ids, or why the graph isn't a single chain. */
export function chainOrder(nodes: { id: string }[], edges: Edge[]): { order: string[]; error: string } {
  if (!nodes.length) return { order: [], error: 'Add at least one capability.' }
  const next = new Map<string, string>()
  const hasIn = new Set<string>()
  for (const e of edges) {
    if (next.has(e.source) || hasIn.has(e.target)) return { order: [], error: 'Each step can have only one next step and one previous step.' }
    next.set(e.source, e.target)
    hasIn.add(e.target)
  }
  const starts = nodes.filter(n => !hasIn.has(n.id))
  if (starts.length !== 1) return { order: [], error: starts.length ? `Not a single chain: ${starts.length} steps have nothing before them. Connect them in order.` : 'The steps form a loop.' }
  const order: string[] = []
  for (let cur: string | undefined = starts[0].id; cur; cur = next.get(cur)) order.push(cur)
  return order.length === nodes.length ? { order, error: '' } : { order: [], error: 'Not a single chain: some steps are not connected.' }
}

function Editor({ project, projects, theme }: ViewProps & { theme: string }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<CapNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [agentOf, setAgentOf] = useState<Record<string, string>>({})
  const [agents, setAgents] = useState<string[]>([])
  const [palette, setPalette] = useState<Capability[]>([])
  const [q, setQ] = useState('')
  const [existing, setExisting] = useState<Capability[] | null>(null)
  const [loaded, setLoaded] = useState<CapabilityDetail | null>(null) // set while editing an existing workflow
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [scope, setScope] = useState<'user' | 'project'>(project ? 'project' : 'user')
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')
  const [readOnly, setReadOnly] = useState('') // why Save is off, shown instead of an error
  const seq = useRef(0)
  const flow = useReactFlow()

  useEffect(() => { api.capabilities({ project, q }).then(setPalette).catch(e => setErr(errText(e))) }, [project, q])
  useEffect(() => { api.capabilities({ project, kind: 'agent' }).then(rows => setAgents(rows.map(r => r.id))).catch(() => {}) }, [project])

  const add = (c: { id: string; kind: Kind }, at?: { x: number; y: number }) => {
    const id = `n${++seq.current}`
    setNodes(ns => [...ns, { id, type: 'cap', position: at ?? { x: 0, y: ns.length * 120 }, data: { capId: c.id, kind: c.kind } }])
    setOk('')
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    const c = palette.find(x => x.id === e.dataTransfer.getData(DND))
    if (c && !readOnly) add(c, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }))
  }
  const isValid = (c: Edge | Connection) => c.source !== c.target && !edges.some(e => e.source === c.source || e.target === c.target)
  const onConnect = (c: Connection) => setEdges(es => addEdge({ ...c, markerEnd: { type: MarkerType.ArrowClosed } }, es))

  const reset = () => {
    setNodes([]); setEdges([]); setAgentOf({}); setLoaded(null); setName(''); setDesc(''); setErr(''); setOk(''); setReadOnly('')
    setScope(project ? 'project' : 'user'); seq.current = 0
  }
  const open = async (id: string) => {
    try {
      const d = await api.capability(id, project)
      reset()
      // ponytail: until the API returns `steps`, read them from the YAML body; if that yields nothing, Save stays off rather than overwrite.
      const steps: WorkflowStep[] = d.steps ?? parseSteps(d.body)
      const ns: CapNode[] = steps.map((s, i) => ({ id: `n${++seq.current}`, type: 'cap', position: { x: 0, y: i * 120 }, data: { capId: s.cap, kind: palette.find(p => p.id === s.cap)?.kind ?? 'skill' } }))
      setNodes(ns)
      setEdges(ns.slice(1).map((n, i) => ({ id: `e${i}`, source: ns[i].id, target: n.id, markerEnd: { type: MarkerType.ArrowClosed } })))
      setAgentOf(Object.fromEntries(steps.flatMap((s, i) => (s.agent ? [[ns[i].id, s.agent]] : []))))
      setLoaded(d); setName(d.name); setDesc(d.description); setScope(d.namespace === 'user' ? 'user' : 'project'); setExisting(null)
      if (!d.editable) setReadOnly(errText(new ApiError(403, 'read_only', ''), { ns: d.namespace }))
      else if (!steps.length) setReadOnly('Could not read this workflow\'s steps from the API, so Save is off to avoid overwriting them.')
    } catch (e) { setErr(errText(e)) }
  }

  const nameErr = !loaded && name && !NAME_RE.test(name) ? 'Lowercase letters, digits and dashes; start with a letter or digit; up to 64 characters.' : ''
  const chain = chainOrder(nodes, edges)
  const save = async () => {
    setOk('')
    if (!loaded && (!name || nameErr)) return setErr(nameErr || 'Name the workflow.')
    if (!desc.trim()) return setErr('Add a description (what Claude matches against).')
    if (chain.error) return setErr(chain.error)
    if (scope === 'project' && !project && !loaded) return setErr('Select a project in the sidebar first, or save to user scope.')
    const steps = chain.order.map(id => {
      const cap = nodes.find(n => n.id === id)!.data.capId
      return agentOf[id] ? { cap, agent: agentOf[id] } : { cap }
    })
    try {
      setErr('')
      if (loaded) { await api.updateCapability(loaded.id, { description: desc.trim(), steps }); setOk(`Saved ${loaded.id}.`) }
      else {
        const c = await api.createCapability({ kind: 'workflow', scope, project: scope === 'project' ? project ?? undefined : undefined, name, description: desc.trim(), steps })
        setOk(`Created ${c.id}.`)
        await open(c.id)
        setOk(`Created ${c.id}.`)
      }
    } catch (e) { setErr(errText(e, { ns: loaded?.namespace })) }
  }
  const locked = !!readOnly

  return (
    <Ctx.Provider value={{ agents, locked, agentOf, setAgent: (id, a) => setAgentOf(m => ({ ...m, [id]: a })) }}>
      <div className="wf">
        <div className="wf-top card pad">
          <input className="inline-input" placeholder="workflow-name" aria-label="Workflow name" value={name} disabled={!!loaded} onChange={e => setName(e.target.value)} />
          <input className="inline-input wf-desc" placeholder="Description: when should Claude use this workflow?" aria-label="Description" value={desc} disabled={locked} onChange={e => setDesc(e.target.value)} />
          <select className="inline-input" aria-label="Scope" value={scope} disabled={!!loaded} onChange={e => setScope(e.target.value as 'user' | 'project')}>
            <option value="user">user (~/.claude)</option><option value="project">project{project ? `: ${project}` : ' (select one)'}</option>
          </select>
          <button className="btn" style={{ borderColor: 'var(--accent)' }} onClick={save} disabled={locked}>{loaded ? 'Save' : 'Create'}</button>
          <button className="btn" onClick={reset}>New</button>
          <button className="btn" onClick={async () => setExisting(existing ? null : await api.capabilities({ project, kind: 'workflow' }))}>Open existing</button>
          <div className="wf-msg">
            {nameErr && <span className="err">{nameErr}</span>}
            {err && <span className="err">{err}</span>}
            {!err && chain.error && nodes.length > 0 && <span className="err">{chain.error}</span>}
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
            <div className="pad"><Search value={q} onChange={setQ} placeholder="Find a capability" /></div>
            <div className="wf-list">
              {palette.map(c => (
                <div key={c.id} className="wf-item" draggable={!locked} onDragStart={e => e.dataTransfer.setData(DND, c.id)} onClick={() => !locked && add(c)} title="Drag onto the canvas, or click to append">
                  <span className="dot" style={{ background: KIND_COLOR[c.kind] }} /><span className="mono">{c.id}</span>
                </div>
              ))}
            </div>
          </aside>
          <div className="wf-canvas card" onDragOver={e => e.preventDefault()} onDrop={onDrop}>
            <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
              isValidConnection={isValid} colorMode={theme === 'light' ? 'light' : 'dark'} fitView fitViewOptions={{ maxZoom: 1 }} nodesDraggable={!locked} nodesConnectable={!locked}
              elementsSelectable={!locked} deleteKeyCode={locked ? null : ['Backspace', 'Delete']} proOptions={{ hideAttribution: true }}>
              <Background gap={20} />
              <Controls showInteractive={false} />
            </ReactFlow>
            {!nodes.length && <div className="wf-hint">Drag capabilities here, then connect them top to bottom.<br />The order of the chain is the order Claude is told to follow.</div>}
          </div>
        </div>
      </div>
    </Ctx.Provider>
  )
}

export default function Workflows(props: ViewProps & { theme: string }) {
  return <><Header crumb="Workflows" title="Workflow editor" sub="Compose skills, agents and commands into an ordered workflow" /><ReactFlowProvider><Editor {...props} /></ReactFlowProvider></>
}
