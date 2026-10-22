import { useEffect, useState } from 'react'
import { api, errText } from './api'
import type { CapabilityDetail, Decision, Job, Kind, Memory, MemoryKind, NewCapability, WorkflowStep } from './types'
import { Segmented, colorOf, fmtDay, fmtMs, fmtTime } from './ui'

export const resultTag = (d: Decision) =>
  d.abstained ? <span className="tag">abstained</span> : d.followed ? <span className="tag good">followed</span> : <span className="tag warn">ignored</span>

export function DecisionTable({ rows, projects, onOpen }: { rows: Decision[]; projects: string[]; onOpen?: (d: Decision) => void }) {
  return (
    <table>
      <thead><tr><th>Prompt</th><th>Suggested</th><th>Result</th><th className="num">Latency</th></tr></thead>
      <tbody>
        {rows.map(d => (
          <tr key={d.id} className={onOpen ? 'click' : ''} onClick={() => onOpen?.(d)}>
            <td>
              <div className="title">{d.prompt}</div>
              <div className="subline">{d.project} · {fmtTime(d.at)} · {d.model_tier}</div>
              <div className="bar" style={{ width: `${Math.round(d.confidence * 60)}%`, background: colorOf(projects, d.project) }} />
            </td>
            <td>{d.steps.slice(0, 2).map(s => <span key={s.cap_id} className="tag">{s.invoke}</span>)}{d.steps.length > 2 && <span className="faint">+{d.steps.length - 2}</span>}</td>
            <td>{resultTag(d)}</td>
            <td className="num">{fmtMs(d.latency_ms)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function DecisionDetail({ d, onDeleted }: { d: Decision; onDeleted: (id: number) => void }) {
  const [err, setErr] = useState('')
  const remove = async () => {
    if (!confirm('Delete this stored prompt? It is removed from claudethecaller for good.')) return
    try { await api.deleteDecision(d.id); onDeleted(d.id) } catch (e) { setErr(errText(e)) }
  }
  return (
    <>
      <div>
        <div className="card-sub">{d.project} · {fmtTime(d.at)} · session {d.session_id}</div>
        <h2 style={{ margin: '6px 0 0', fontSize: 18 }}>{d.prompt}</h2>
      </div>
      <div>
        <span className="tag">{d.source === 'history' ? 'from history · intent' : 'live'}</span><span className="tag">{d.difficulty}</span><span className="tag">model: {d.model_tier}</span>
        <span className="tag">confidence {d.confidence.toFixed(2)}</span><span className="tag">{fmtMs(d.latency_ms)}</span>{resultTag(d)}
      </div>
      <div className="card-title">Bundle</div>
      {d.steps.length ? (
        <div className="steps">
          {d.steps.map(s => (
            <div key={s.order} className="step">
              <div className="n">{s.order}</div>
              <div>
                <div className="title mono">{s.invoke} <span className="tag">{s.kind}</span>{s.agent && <span className="tag">agent: {s.agent}</span>}</div>
                <div className="subline">{s.reason}</div>
              </div>
            </div>
          ))}
        </div>
      ) : <div className="empty">Router abstained: no capability scored above the threshold.</div>}
      <div className="card-title">Why these (search stages)</div>
      <div className="card tablewrap">
        <table>
          <thead><tr><th>Capability</th><th className="num">Dense</th><th className="num">Keyword</th><th className="num">RRF</th><th className="num">Rerank</th></tr></thead>
          <tbody>
            {d.stages.map(r => (
              <tr key={r.cap_id}>
                <td><span className="mono">{r.cap_id}</span>{r.dropped && <div className="subline">dropped: {r.dropped}</div>}</td>
                <td className="num">{r.dense_rank ?? '—'}</td><td className="num">{r.sparse_rank ?? '—'}</td>
                <td className="num">{r.rrf.toFixed(4)}</td><td className="num">{r.rerank?.toFixed(2) ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="actions"><button className="btn danger" onClick={remove}>Delete this prompt</button>{err && <span className="err">{err}</span>}</div>
    </>
  )
}

const MEMORY_KINDS: MemoryKind[] = ['preference', 'convention', 'fact', 'skill_outcome']

/** One memory: pin, edit (text, kind, project → global), soft delete with Undo, supersede history. */
export function MemoryCard({ m, onChange }: { m: Memory; onChange: (m: Memory) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({ text: m.text, kind: m.kind, scope: m.scope })
  const [history, setHistory] = useState<Memory[] | null>(null)
  const [err, setErr] = useState('')
  const run = async (fn: () => Promise<void>) => { try { await fn(); setErr('') } catch (e) { setErr(errText(e)) } }

  if (m.deleted_at) return (
    <div className="card pad mem undo">
      <span><span className="tag bad">deleted</span> {m.text.slice(0, 60)}{m.text.length > 60 ? '…' : ''}</span>
      <button className="btn" onClick={() => run(async () => onChange(await api.restoreMemory(m.id)))}>Undo</button>
      {err && <div className="err">{err}</div>}
    </div>
  )
  return (
    <div className="card pad mem">
      <div>
        <span className="tag">{m.kind.replace('_', ' ')}</span>
        <span className="tag">{m.scope === 'global' ? 'global' : m.project}</span>
        {m.pinned && <span className="tag good">pinned</span>}
      </div>
      {editing ? (
        <div className="form">
          <textarea value={draft.text} onChange={e => setDraft({ ...draft, text: e.target.value })} autoFocus />
          <div className="row2">
            <label>Kind<select value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value as MemoryKind })}>{MEMORY_KINDS.map(k => <option key={k}>{k}</option>)}</select></label>
            {/* ponytail: PATCH has no `project`, so a global memory can't be moved into a project yet (reported). */}
            <label>Scope<select value={draft.scope} disabled={m.scope === 'global'} onChange={e => setDraft({ ...draft, scope: e.target.value as Memory['scope'] })}>
              <option value="project">project</option><option value="global">global</option></select></label>
          </div>
        </div>
      ) : <div>{m.text}</div>}
      {m.supersedes && <div className="subline">replaces {m.supersedes}</div>}
      {history && (
        <div className="history">
          {history.length ? history.map(h => <div key={h.id}><span className="mono faint">{h.id} · {fmtDay(h.updated_at)}</span> {h.text}</div>) : <span>No earlier versions.</span>}
        </div>
      )}
      {err && <div className="err">{err}</div>}
      <div className="mem-meta">
        <span className="mono">conf {m.confidence.toFixed(2)}</span>
        <span className="mono">used {m.use_count}×</span>
        <span title={m.source}>{fmtDay(m.updated_at)} · {m.source}</span>
      </div>
      <div className="actions">
        {editing ? (
          <>
            <button className="btn" onClick={() => run(async () => { onChange(await api.updateMemory(m.id, draft)); setEditing(false) })}>Save</button>
            <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
          </>
        ) : (
          <>
            <button className="btn" onClick={() => run(async () => onChange(await api.updateMemory(m.id, { pinned: !m.pinned })))}>{m.pinned ? 'Unpin' : 'Pin'}</button>
            <button className="btn" onClick={() => run(async () => setHistory(history ? null : (await api.memory(m.id)).history))}>History</button>
            <button className="btn" onClick={() => { setDraft({ text: m.text, kind: m.kind, scope: m.scope }); setEditing(true) }}>Edit</button>
            <button className="btn danger" onClick={() => run(async () => { await api.deleteMemory(m.id); onChange({ ...m, deleted_at: new Date().toISOString() }) })}>Delete</button>
          </>
        )}
      </div>
    </div>
  )
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const KINDS: Kind[] = ['skill', 'agent', 'command', 'workflow']
/** Workflow YAML written by the backend/mock (`steps: - cap: x / agent: y`) → steps; the detail has no `steps` field (reported). */
export const parseSteps = (yaml: string): WorkflowStep[] =>
  [...yaml.matchAll(/-\s+cap:\s*(\S+)(?:\s*\n\s+agent:\s*(\S+))?/g)].map(([, cap, agent]) => (agent ? { cap, agent } : { cap }))

/** Create (any editable scope) or edit (description, body or steps) a capability. Ready for F5's workflow steps. */
export function CapabilityForm({ edit, projects, project, onDone, onCancel }: {
  edit?: CapabilityDetail; projects: string[]; project: string | null; onDone: () => void; onCancel: () => void
}) {
  const [f, setF] = useState<NewCapability>(() => edit
    ? { kind: edit.kind, scope: edit.namespace === 'user' ? 'user' : 'project', name: edit.name, description: edit.description, body: edit.body, steps: edit.kind === 'workflow' ? parseSteps(edit.body) : undefined }
    : { kind: 'skill', scope: project ? 'project' : 'user', project: project ?? projects[0], name: '', description: '', body: '', steps: [{ cap: '' }] })
  const [err, setErr] = useState('')
  const nameErr = !edit && f.name && !NAME_RE.test(f.name) ? 'Lowercase letters, digits and dashes; must start with a letter or digit; up to 64 characters.' : ''
  const steps = f.steps ?? []
  const setStep = (i: number, s: WorkflowStep) => setF({ ...f, steps: steps.map((x, j) => (j === i ? s : x)) })
  const cleanSteps = steps.filter(s => s.cap.trim()).map(s => (s.agent?.trim() ? { cap: s.cap.trim(), agent: s.agent.trim() } : { cap: s.cap.trim() }))

  const submit = async () => {
    if (nameErr || !f.description.trim() || (!edit && !f.name)) return setErr('Name and description are required.')
    try {
      if (edit) await api.updateCapability(edit.id, f.kind === 'workflow' ? { description: f.description, steps: cleanSteps } : { description: f.description, body: f.body })
      else await api.createCapability(f.kind === 'workflow' ? { ...f, body: undefined, steps: cleanSteps } : { ...f, steps: undefined, project: f.scope === 'project' ? f.project : undefined })
      onDone()
    } catch (e) { setErr(errText(e)) }
  }

  return (
    <div className="form">
      {!edit && (
        <>
          <Segmented options={KINDS} value={f.kind} onChange={kind => setF({ ...f, kind })} />
          <div className="row2">
            <label>Scope<select value={f.scope} onChange={e => setF({ ...f, scope: e.target.value as 'user' | 'project' })}>
              <option value="user">user (~/.claude)</option><option value="project">project (.claude in the repo)</option></select></label>
            <label>Project<select value={f.project} disabled={f.scope === 'user'} onChange={e => setF({ ...f, project: e.target.value })}>
              {projects.map(p => <option key={p}>{p}</option>)}</select></label>
          </div>
          <label>Name<input value={f.name} placeholder="release-notes" onChange={e => setF({ ...f, name: e.target.value })} />{nameErr && <span className="err">{nameErr}</span>}</label>
        </>
      )}
      <label>Description (what Claude matches against)<input value={f.description} onChange={e => setF({ ...f, description: e.target.value })} /></label>
      {f.kind === 'workflow' ? (
        <label>Steps (capability, optional agent)
          {steps.map((s, i) => (
            <div key={i} className="steprow">
              <input value={s.cap} placeholder="superpowers:writing-plans" onChange={e => setStep(i, { ...s, cap: e.target.value })} />
              <input value={s.agent ?? ''} placeholder="agent (optional)" onChange={e => setStep(i, { ...s, agent: e.target.value })} />
              <button className="iconbtn" aria-label="Remove step" onClick={() => setF({ ...f, steps: steps.filter((_, j) => j !== i) })}>✕</button>
            </div>
          ))}
          <button className="btn" style={{ justifySelf: 'start' }} onClick={() => setF({ ...f, steps: [...steps, { cap: '' }] })}>+ step</button>
        </label>
      ) : (
        <label>Body (Markdown; frontmatter is written for you)<textarea value={f.body} onChange={e => setF({ ...f, body: e.target.value })} /></label>
      )}
      <div className="actions">
        <button className="btn" style={{ borderColor: 'var(--accent)' }} onClick={submit}>{edit ? 'Save' : 'Create'}</button>
        <button className="btn" onClick={onCancel}>Cancel</button>
        {err && <span className="err">{err}</span>}
      </div>
    </div>
  )
}

/** Polls GET /jobs/{id} every second until done or failed; stops on unmount or when `id` changes. */
export function useJob(id: string | null): Job | null {
  const [job, setJob] = useState<Job | null>(null)
  useEffect(() => {
    if (!id) return
    let timer = 0
    let alive = true
    const tick = async () => {
      try {
        const j = await api.job(id)
        if (!alive) return
        setJob(j)
        if (j.status !== 'done' && j.status !== 'failed') timer = window.setTimeout(tick, 1000)
      } catch (e) {
        if (alive) setJob({ id, kind: 'index', status: 'failed', progress: 0, result: null, error: errText(e), created_at: new Date().toISOString() })
      }
    }
    setJob(null)
    tick()
    return () => { alive = false; clearTimeout(timer) }
  }, [id])
  return job
}
