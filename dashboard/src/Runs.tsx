import { Background, Controls, ReactFlow } from '@xyflow/react'
import { Fragment, useEffect, useState } from 'react'
import { NEED_DAEMON, api, errText, usingMock } from './api'
import type { Diff, RunDetail, RunStatus, Step } from './types'
import { Header, Segmented, fmtTime, fmtTokens } from './ui'
import { NodeCtx, dashBack, nodeTypes, toFlow } from './Workflows'

const PILL: Record<string, string> = { running: 'warn', waiting: 'warn', quota: 'warn', done: 'good', failed: 'bad', timeout: 'bad' } // run and step statuses
const ACTIVE: RunStatus[] = ['queued', 'running', 'waiting']
const POLL_MS = 1500 // config/server.yaml runner.poll_s
const MAX_ROWS = 1000
const TABS = ['output', 'log', 'diff', 'meta'] as const

/** Loads, then reloads every 1.5 s while `again(result)` holds; stops on unmount or when `deps` change. */
function usePoll<T>(load: () => Promise<T>, again: (t: T) => boolean, deps: unknown[]): [T | null, string] {
  const [data, setData] = useState<T | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let alive = true
    let timer = 0
    const tick = async () => {
      try {
        const t = await load()
        if (!alive) return
        setData(t); setErr('')
        if (again(t)) timer = window.setTimeout(tick, POLL_MS)
      } catch (e) { if (alive) setErr(usingMock() ? NEED_DAEMON : errText(e)) }
    }
    tick()
    return () => { alive = false; clearTimeout(timer) }
  }, deps)
  return [data, err]
}

export default function Runs({ runId, onRun, theme }: { runId: number | null; onRun: (id: number | null) => void; theme: string }) {
  return runId ? <RunPage key={runId} id={runId} theme={theme} onBack={() => onRun(null)} /> : <RunList onOpen={onRun} />
}

function RunList({ onOpen }: { onOpen: (id: number) => void }) {
  const [runs, err] = usePoll(() => api.runs(), rs => rs.some(r => ACTIVE.includes(r.status)), [])
  return (
    <>
      <Header crumb="Runs" title="Workflow runs" sub={runs ? `${runs.length} runs${runs.some(r => ACTIVE.includes(r.status)) ? ' · refreshing every 1.5 s' : ''}` : 'Runs of your workflows on this machine'} />
      {err && <div className={usingMock() ? 'muted' : 'err'}>{err}</div>}
      <div className="card tablewrap">
        <table>
          <thead><tr><th>Run</th><th>Status</th><th>Progress</th><th>Trigger</th><th className="num">Tokens</th><th>Created</th></tr></thead>
          <tbody>
            {(runs ?? []).map(r => (
              <tr key={r.id} className="click" onClick={() => onOpen(r.id)}>
                <td><div className="title mono">{r.workflow}</div><div className="subline">#{r.id}{r.branch && ` · ${r.branch}`}{r.input && ` · ${r.input}`}</div></td>
                <td><span className={'tag ' + (PILL[r.status] ?? '')}>{r.status}</span>{r.error && <div className="err" style={{ marginTop: 4 }}>{r.error}</div>}</td>
                <td style={{ width: 160 }}>
                  <div className="pbar"><div style={{ width: `${Math.round((100 * r.nodes_done) / Math.max(1, r.nodes_total))}%`, background: r.status === 'failed' ? 'var(--bad)' : r.status === 'done' ? 'var(--good)' : 'var(--accent)' }} /></div>
                  <div className="subline">{r.nodes_done}/{r.nodes_total} nodes</div>
                </td>
                <td><span className="tag">{r.trigger}</span></td>
                <td className="num">{fmtTokens(r.tokens)}</td>
                <td className="muted">{fmtTime(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {runs && !runs.length && <div className="empty">No runs yet. Open a workflow in the editor, save it, then press Run.</div>}
      </div>
    </>
  )
}

function RunPage({ id, theme, onBack }: { id: number; theme: string; onBack: () => void }) {
  const [rev, setRev] = useState(0)
  const [run, err] = usePoll(() => api.run(id), r => ACTIVE.includes(r.status), [id, rev])
  const [sel, setSel] = useState<string | null>(null)
  const [whole, setWhole] = useState(false)
  const [msg, setMsg] = useState('')
  if (!run) return <><Header crumb="Runs" title={`Run #${id}`} sub="" /><div className={usingMock() ? 'muted' : 'err'}>{err}</div></>

  // ponytail: one visit per node is shown (the last); loops get a visit selector in WF7.
  const latest: Record<string, Step> = {}
  for (const s of run.steps) if (!latest[s.node_id] || s.visit >= latest[s.node_id].visit) latest[s.node_id] = s
  const status = Object.fromEntries(Object.values(latest).map(s => [s.node_id, s.status]))
  const f = toFlow(run.graph) // read once by the uncontrolled canvas below
  const step = sel ? latest[sel] : undefined
  const cancel = async () => { try { await api.cancelRun(run.id); setRev(r => r + 1) } catch (e) { setMsg(errText(e)) } }

  return (
    <>
      <Header crumb="Runs" title={`#${run.id} ${run.workflow}`}
        sub={`${run.trigger} · ${fmtTime(run.created_at)} · ${run.nodes_done}/${run.nodes_total} nodes · ${fmtTokens(run.tokens)} tokens${run.input ? ' · input: ' + run.input : ''}`}>
        <button className="btn" onClick={onBack}>All runs</button>
        <button className="btn" onClick={() => setWhole(!whole)}>{whole ? 'Hide' : 'Show'} run diff</button>
        {ACTIVE.includes(run.status) && <button className="btn danger" onClick={cancel}>Cancel</button>}
      </Header>
      <div className="toolbar">
        <span className={'tag ' + (PILL[run.status] ?? '')}>{run.status}</span>
        {run.status === 'quota' && <span className="tag warn">quota, resets at {run.quota_resets_at ? fmtTime(run.quota_resets_at) : 'unknown'}</span>}
        {run.branch && <span className="mono">{run.branch}</span>}
        {run.pr_url && <a href={run.pr_url} target="_blank" rel="noreferrer">{run.pr_url}</a>}
        {run.error && <span className="err">{run.error}</span>}
        {(msg || err) && <span className="err">{msg || err}</span>}
      </div>
      {whole && <div className="card pad"><DiffOf load={() => api.runDiff(run.id)} dep={run.status} /></div>}
      <div className="run-body">
        <div className="wf-canvas card">
          <NodeCtx.Provider value={{ bad: null, status }}>
            <ReactFlow defaultNodes={f.nodes} defaultEdges={dashBack(f.nodes, f.edges)} nodeTypes={nodeTypes} onNodeClick={(_, n) => setSel(n.id)} onPaneClick={() => setSel(null)}
              nodesDraggable={false} nodesConnectable={false} deleteKeyCode={null} colorMode={theme === 'light' ? 'light' : 'dark'} fitView fitViewOptions={{ maxZoom: 1 }} minZoom={0.2}
              proOptions={{ hideAttribution: true }}>
              <Background gap={20} />
              <Controls showInteractive={false} />
            </ReactFlow>
          </NodeCtx.Provider>
        </div>
        <aside className="wf-panel card pad">
          {step ? <StepPanel run={run} step={step} />
            : <div className="muted">{sel ? `${sel} has not run yet.` : 'Click a node to see its output, log, diff and session.'}</div>}
        </aside>
      </div>
    </>
  )
}

function StepPanel({ run, step }: { run: RunDetail; step: Step }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>('output') // kept while switching nodes
  return (
    <div className="form">
      <div className="card-title mono">{step.node_id}<span className={'tag ' + (PILL[step.status] ?? '')}>{step.status}</span>{step.visit > 1 && <span className="tag">visit {step.visit}</span>}</div>
      <Segmented options={TABS} value={tab} onChange={setTab} />
      {tab === 'output' && <>
        {step.error && <div className="err">{step.error}</div>}
        {step.input && <label>input<pre className="code">{step.input}</pre></label>}
        {Object.entries(step.output ?? {}).map(([k, v]) => <label key={k}>{k}<pre className="code">{typeof v === 'string' ? v : JSON.stringify(v, null, 2)}</pre></label>)}
        {!step.output && !step.error && <div className="muted">No output yet.</div>}
      </>}
      {tab === 'log' && <LogView key={step.id} runId={run.id} stepId={step.id} />}
      {tab === 'diff' && <DiffOf key={step.id} load={() => api.stepDiff(run.id, step.id)} dep={step.status} />}
      {tab === 'meta' && <Meta run={run} step={step} />}
    </div>
  )
}

function Meta({ run, step }: { run: RunDetail; step: Step }) {
  const [copied, setCopied] = useState(false)
  const cmd = run.worktree && step.session_id ? `cd ${run.worktree} && claude --resume ${step.session_id}` : ''
  const rows: [string, unknown][] = [
    ['kind', step.kind], ['visit', step.visit], ['session', step.session_id], ['turns', step.num_turns],
    ['tokens', step.tokens && JSON.stringify(step.tokens)], ['cost (notional)', step.cost_usd != null && `$${step.cost_usd.toFixed(4)}`],
    ['denials', step.permission_denials?.length && JSON.stringify(step.permission_denials)], ['overage', step.overage != null && String(step.overage)],
    ['files', step.files?.length], ['started', fmtTime(step.started_at)], ['ended', step.ended_at && fmtTime(step.ended_at)],
  ]
  return (
    <>
      <dl className="kv">{rows.filter(([, v]) => v != null && v !== false && v !== '').map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{String(v)}</dd></Fragment>)}</dl>
      {cmd && <>
        <code className="code">{cmd}</code>
        <div className="actions"><button className="btn" onClick={() => navigator.clipboard.writeText(cmd).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy resume command'}</button></div>
      </>}
    </>
  )
}

type LogPart = { type: string; text?: string; name?: string; input?: unknown; content?: unknown; is_error?: boolean }
type LogLine = { type?: string; subtype?: string; result?: unknown; message?: { content?: string | LogPart[] } }
const parseLine = (s: string): LogLine | null => { try { const j = JSON.parse(s); return j && typeof j === 'object' ? j : null } catch { return null } }

/** One stream-json line: text and tool calls inline; tool results and other events folded into <details>. Non-JSON lines as text. */
function LogRow({ line }: { line: string }) {
  const j = parseLine(line)
  if (!j) return <div className="logrow">{line}</div>
  const c = j.message?.content
  const parts = Array.isArray(c) ? c : []
  const results = parts.filter(p => p.type === 'tool_result')
  if (results.length) return (
    <details className="logrow"><summary><span className="tag">tool result</span>{results.some(r => r.is_error) && <span className="tag bad">error</span>}</summary>
      <pre>{results.map(r => (typeof r.content === 'string' ? r.content : JSON.stringify(r.content, null, 2))).join('\n')}</pre></details>
  )
  const text = j.type === 'result' ? String(j.result ?? '') : typeof c === 'string' ? c
    : parts.map(p => (p.type === 'text' ? p.text : p.type === 'tool_use' ? `→ ${p.name} ${JSON.stringify(p.input)}` : `(${p.type})`)).join('\n')
  const tag = <span className="tag">{j.type}{j.subtype ? ` ${j.subtype}` : ''}</span>
  if (!text) return <details className="logrow"><summary>{tag}</summary><pre>{JSON.stringify(j, null, 2)}</pre></details>
  return <div className="logrow">{tag}{text}</div>
}

/** Reads a step's log by byte offset every 1.5 s until the daemon says it is done. */
function LogView({ runId, stepId }: { runId: number; stepId: number }) {
  const [rows, setRows] = useState<string[]>([])
  const [err, setErr] = useState('')
  useEffect(() => {
    let alive = true
    let timer = 0
    let offset = 0
    let rest = ''
    const tick = async () => {
      try {
        const r = await api.stepLog(runId, stepId, offset)
        if (!alive) return
        const lines = (rest + r.text).split('\n')
        rest = r.done ? '' : lines.pop() ?? '' // a chunk can end mid-line
        offset = r.offset
        const add = lines.filter(Boolean)
        if (add.length) setRows(rs => [...rs, ...add].slice(-MAX_ROWS)) // ponytail: the last 1000 rows only; page by offset if longer logs matter
        if (!r.done) timer = window.setTimeout(tick, POLL_MS)
      } catch (e) { if (alive) setErr(errText(e)) }
    }
    tick()
    return () => { alive = false; clearTimeout(timer) }
  }, [runId, stepId])
  return (
    <div className="log">
      {rows.map((l, i) => <LogRow key={i} line={l} />)}
      {!rows.length && !err && <div className="muted">No log yet.</div>}
      {err && <div className="err">{err}</div>}
    </div>
  )
}

const lineClass = (l: string) => (/^(diff |index |\+\+\+|---)/.test(l) ? 'meta' : l.startsWith('@@') ? 'hunk' : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : undefined)

/** Loads a diff (again whenever `dep` changes) and shows it as coloured lines above the file list. */
function DiffOf({ load, dep }: { load: () => Promise<Diff>; dep: string }) {
  const [d, setD] = useState<Diff | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => { load().then(setD, e => setErr(errText(e))) }, [dep])
  if (err) return <div className="err">{err}</div>
  if (!d) return <div className="muted">Loading diff…</div>
  return (
    <>
      {d.diff ? <pre className="code diff">{d.diff.split('\n').map((l, i) => <span key={i} className={lineClass(l)}>{l || ' '}</span>)}</pre> : <div className="muted">No changes.</div>}
      {d.truncated && <div className="muted">Cut at 64 KB; git show on the run's branch has the rest.</div>}
      <div className="rows">
        {d.files.map(f => <div key={f.path} className="row"><span className="mono">{f.path}</span><span className="mono"><span className="up">+{f.added ?? '-'}</span> <span className="down">-{f.deleted ?? '-'}</span></span></div>)}
      </div>
    </>
  )
}
