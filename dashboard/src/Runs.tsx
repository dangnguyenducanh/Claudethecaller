import { Background, Controls, ReactFlow } from '@xyflow/react'
import { Fragment, useEffect, useState } from 'react'
import { NEED_DAEMON, api, errText, usingMock } from './api'
import type { Diff, RunDetail, RunStatus, Step } from './types'
import { Header, Segmented, fmtMs, fmtTime, fmtTokens } from './ui'
import { NodeCtx, dashBack, nodeTypes, toFlow } from './Workflows'

const PILL: Record<string, string> = { running: 'warn', waiting: 'warn', quota: 'warn', done: 'good', failed: 'bad', timeout: 'bad' } // run and step statuses
// ponytail: polls every 1.5 s through a quota window (can be hours); slow quota polling if DB load shows, SSE is the upgrade path (PLAN.md:505)
const ACTIVE: RunStatus[] = ['queued', 'running', 'waiting', 'quota']
const POLL_MS = 1500 // config/server.yaml runner.poll_s
const MAX_ROWS = 1000
const TABS = ['output', 'log', 'diff', 'meta'] as const
type RetryBody = { from_node?: string; to_node?: string }
/** engine.fresh_tokens: every count but cache reads, as wf_runs.tokens adds them up. */
const freshTokens = (t: Record<string, number>) => Object.entries(t).reduce((n, [k, v]) => (k === 'cache_read_input_tokens' ? n : n + v), 0)
const took = (s: Step) => (s.status === 'running' ? 'running' : s.status === 'skipped' || !s.ended_at ? '—' : fmtMs(Date.parse(s.ended_at) - Date.parse(s.started_at)))

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

/** `compare`: '<a>/<b>[/<node>]' from the '#compare/…' route. */
export default function Runs({ runId, compare, onRun, theme }: { runId: number | null; compare: string | null; onRun: (id: number | null) => void; theme: string }) {
  if (compare) { const [a, b, node] = compare.split('/'); return <Compare a={Number(a)} b={Number(b)} node={node ?? ''} /> }
  return runId ? <RunPage key={runId} id={runId} theme={theme} onBack={() => onRun(null)} /> : <RunList onOpen={onRun} />
}

function RunList({ onOpen }: { onOpen: (id: number) => void }) {
  const [runs, err] = usePoll(() => api.runs(), rs => rs.some(r => ACTIVE.includes(r.status)), [])
  const [picked, setPicked] = useState<number[]>([])
  const pick = (id: number, on: boolean) => setPicked(p => (on ? [...p, id] : p.filter(x => x !== id)))
  return (
    <>
      <Header crumb="Runs" title="Workflow runs" sub={runs ? `${runs.length} runs${runs.some(r => ACTIVE.includes(r.status)) ? ' · refreshing every 1.5 s' : ''}` : 'Runs of your workflows on this machine'}>
        <button className="btn" disabled={picked.length !== 2} title="Tick two runs of the same repo" onClick={() => { location.hash = `compare/${[...picked].sort((x, y) => x - y).join('/')}` }}>Compare</button>
      </Header>
      {err && <div className={usingMock() ? 'muted' : 'err'}>{err}</div>}
      <div className="card tablewrap">
        <table>
          <thead><tr><th /><th>Run</th><th>Status</th><th>Progress</th><th>Trigger</th><th className="num">Tokens</th><th>Created</th></tr></thead>
          <tbody>
            {(runs ?? []).map(r => (
              <tr key={r.id} className="click" onClick={() => onOpen(r.id)}>
                <td onClick={e => e.stopPropagation()}><input type="checkbox" aria-label={`Compare run ${r.id}`} checked={picked.includes(r.id)} onChange={e => pick(r.id, e.target.checked)} /></td>
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
  const [visit, setVisit] = useState(0) // 0: the latest visit of the selected node
  const [whole, setWhole] = useState(false)
  const [msg, setMsg] = useState('')
  const [note, setNote] = useState('')
  if (!run) return <><Header crumb="Runs" title={`Run #${id}`} sub="" /><div className={usingMock() ? 'muted' : 'err'}>{err}</div></>

  const visits: Record<string, Step[]> = {} // every visit per node, in visit order
  for (const s of [...run.steps].sort((a, b) => a.visit - b.visit)) (visits[s.node_id] ??= []).push(s)
  const status = Object.fromEntries(Object.entries(visits).map(([n, vs]) => [n, vs[vs.length - 1].marker ?? vs[vs.length - 1].status])) // reused / pinned label the node
  const runs = Object.fromEntries(Object.entries(visits).map(([n, vs]) => [n, vs.filter(s => s.status !== 'skipped').length]))
  const f = toFlow(run.graph) // read once by the uncontrolled canvas below
  const vs = sel ? visits[sel] ?? [] : []
  const step = vs.find(s => s.visit === visit) ?? vs[vs.length - 1]
  const act = (call: () => Promise<unknown>) => async () => { try { setMsg(''); await call(); setRev(r => r + 1) } catch (e) { setMsg(errText(e)) } }
  const cancel = act(() => api.cancelRun(run.id))
  const retry = async (body: RetryBody) => { // a new run linked to this one; open it
    try { setMsg(''); const r = await api.retryRun(run.id, { ...body, trigger: 'button' }); location.hash = `run/${r.run_id}` } catch (e) { setMsg(errText(e)) }
  }
  const ended = !ACTIVE.includes(run.status)
  const wait = run.steps.find(s => s.status === 'waiting')

  return (
    <>
      <Header crumb="Runs" title={`#${run.id} ${run.workflow}`}
        sub={`${run.trigger} · ${fmtTime(run.created_at)} · ${run.nodes_done}/${run.nodes_total} nodes · ${fmtTokens(run.tokens)} tokens${run.input ? ' · input: ' + run.input : ''}`}>
        <button className="btn" onClick={onBack}>All runs</button>
        <button className="btn" onClick={() => setWhole(!whole)}>{whole ? 'Hide' : 'Show'} run diff</button>
        {ACTIVE.includes(run.status) && <button className="btn danger" onClick={cancel}>Cancel</button>}
        {run.status === 'failed' && <button className="btn" title="A new run from the failed step, reusing the earlier outputs" onClick={() => retry({})}>Retry</button>}
      </Header>
      <div className="toolbar">
        <span className={'tag ' + (PILL[run.status] ?? '')}>{run.status}</span>
        {run.branch && <span className="mono">{run.branch}</span>}
        {run.parent_run_id && <a href={`#run/${run.parent_run_id}`}>from run #{run.parent_run_id}{run.from_node ? ` at ${run.from_node}` : ''}{run.to_node ? `, up to ${run.to_node}` : ''}</a>}
        {run.pr_url && <a href={run.pr_url} target="_blank" rel="noreferrer">{run.pr_url}</a>}
        {run.error && <span className="err">{run.error}</span>}
        {(msg || err) && <span className="err">{msg || err}</span>}
      </div>
      {run.status === 'waiting' && (
        <div className="card pad form st-waiting">
          <div className="card-title">Waiting at {wait?.node_id ?? 'an approval'}: {wait?.input || 'approve to go on'}</div>{/* input: the message, templates filled */}
          {/* one row + a folded diff: the full diff here pushed the canvas below the fold (run 58) */}
          <div className="actions">
            <input className="inline-input" placeholder="Note (optional)" aria-label="Note" value={note} onChange={e => setNote(e.target.value)} />
            <button className="btn" style={{ borderColor: 'var(--accent)' }} onClick={act(() => api.approveRun(run.id, { approve: true, note: note || undefined }))}>Approve</button>
            <button className="btn danger" onClick={act(() => api.approveRun(run.id, { approve: false, note: note || undefined }))}>Reject</button>
          </div>
          <details><summary className="muted">Run diff so far</summary><DiffOf load={() => api.runDiff(run.id)} dep={run.status} /></details>
        </div>
      )}
      {run.status === 'quota' && (
        <div className="card pad form st-quota">
          <div className="card-title">Out of usage, resets at {run.quota_resets_at ? fmtTime(run.quota_resets_at) : 'an unknown time'}{run.auto_resume ? ', then continues by itself' : ''}</div>
          <div className="actions">
            <button className="btn" onClick={act(() => api.continueRun(run.id, 'reset'))}>Continue when reset</button>
            <button className="btn" onClick={act(() => api.continueRun(run.id, 'now'))}>Continue now</button>
          </div>
        </div>
      )}
      {whole && <div className="card pad"><DiffOf load={() => api.runDiff(run.id)} dep={run.status} /></div>}
      <div className="run-body">
        <div className="wf-canvas card">
          <NodeCtx.Provider value={{ bad: null, status, runs }}>
            <ReactFlow defaultNodes={f.nodes} defaultEdges={dashBack(f.nodes, f.edges, run.graph.defaults?.max_visits)} nodeTypes={nodeTypes}
              onNodeClick={(_, n) => { setSel(n.id); setVisit(0) }} onPaneClick={() => setSel(null)}
              nodesDraggable={false} nodesConnectable={false} deleteKeyCode={null} colorMode={theme === 'light' ? 'light' : 'dark'} fitView fitViewOptions={{ maxZoom: 1 }} minZoom={0.2}
              proOptions={{ hideAttribution: true }}>
              <Background gap={20} />
              <Controls showInteractive={false} />
            </ReactFlow>
          </NodeCtx.Provider>
        </div>
        <aside className="wf-panel card pad">
          {step ? <StepPanel run={run} step={step} visits={vs.length > 1 ? vs : []} onVisit={setVisit} onRetry={ended ? retry : undefined} />
            : <div className="muted">{sel ? `${sel} has not run yet.` : 'Click a node to see its output, log, diff and session.'}</div>}
        </aside>
      </div>
      <div className="card tablewrap">
        <table>
          <thead><tr><th>Node</th><th className="num">Visit</th><th>Status</th><th className="num">Duration</th><th className="num">Tokens</th><th>Error</th></tr></thead>
          <tbody>
            {run.steps.map(s => ( // the API's order: s.id, which is start order
              <tr key={s.id} className="click" onClick={() => { setSel(s.node_id); setVisit(s.visit) }}>
                <td className="mono">{s.node_id}</td>
                <td className="num">{s.visit}</td>
                <td><span className={'tag ' + (PILL[s.status] ?? '')}>{s.status}</span>{s.marker && <span className="tag">{s.marker}</span>}</td>
                <td className="num">{took(s)}</td>
                <td className="num">{s.tokens ? fmtTokens(freshTokens(s.tokens)) : '—'}</td>
                <td className="err">{(s.error ?? '').split('\n')[0]}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!run.steps.length && <div className="empty">No steps yet.</div>}
      </div>
    </>
  )
}

/** Two runs' diff: whole runs (`git diff <a.branch>..<b.branch>`) or one node's latest visit in each. */
function Compare({ a, b, node }: { a: number; b: number; node: string }) {
  const [ra, setRa] = useState<RunDetail | null>(null)
  useEffect(() => { api.run(a).then(setRa, () => {}) }, [a]) // the node list only; the diff below shows any error
  const go = (n: string) => { location.hash = `compare/${a}/${b}${n ? '/' + n : ''}` }
  return (
    <>
      <Header crumb="Runs" title={`Compare #${a} and #${b}`} sub={ra ? `${ra.workflow}${ra.branch ? ' · ' + ra.branch : ''}` : ''}>
        <button className="btn" onClick={() => { location.hash = 'runs' }}>All runs</button>
      </Header>
      <div className="card pad form">
        <label>Node<select value={node} onChange={e => go(e.target.value)}>
          <option value="">whole run</option>
          {ra?.graph.nodes.filter(n => n.type === 'agent' || n.type === 'shell').map(n => <option key={n.id}>{n.id}</option>)}{/* only these commit */}
        </select></label>
        <DiffOf key={node} load={() => api.compareRuns(a, b, node || undefined)} dep={node} />
      </div>
    </>
  )
}

/** onRetry: set once the run has ended; starts a new run from / up to this step's node. */
function StepPanel({ run, step, visits, onVisit, onRetry }: { run: RunDetail; step: Step; visits: Step[]; onVisit: (v: number) => void; onRetry?: (b: RetryBody) => void }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>('output') // kept while switching nodes
  const trig = run.graph.nodes.find(n => n.type === 'trigger')?.id
  return (
    <div className="form">
      <div className="card-title mono">{step.node_id}<span className={'tag ' + (PILL[step.status] ?? '')}>{step.status}</span>
        {step.marker && <span className="tag">{step.marker}</span>}
        {visits.length > 0 && <select aria-label="Visit" value={step.visit} onChange={e => onVisit(Number(e.target.value))}>
          {visits.map(s => <option key={s.visit} value={s.visit}>visit {s.visit}</option>)}</select>}</div>
      {step.marker === 'reused' && <div className="muted">Output reused from run #{run.parent_run_id}</div>}
      {onRetry && step.status !== 'skipped' && <div className="actions">
        <button className="btn" title="A new run from this node, reusing the earlier outputs" onClick={() => onRetry({ from_node: step.node_id })}>Run from here</button>
        <button className="btn" title="A new run from the start that stops after this node" onClick={() => onRetry({ from_node: trig, to_node: step.node_id })}>Run to here</button>
      </div>}
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
