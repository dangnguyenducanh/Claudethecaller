import { useEffect, useState } from 'react'
import { api, errText } from './api'
import type { ViewProps } from './App'
import { CapabilityForm, DecisionTable, useJob } from './parts'
import type { Capability, CapabilityDetail, DedupPair, IndexResult, Override } from './types'
import { Drawer, Header, Search, Segmented, fmtInt } from './ui'

const KINDS = ['all', 'skill', 'agent', 'command', 'workflow'] as const
const TABS = ['capabilities', 'duplicates'] as const
const ACTIONS: Override[] = ['pin', 'block', 'disable']

export default function Library({ project, projects }: ViewProps) {
  const [tab, setTab] = useState<(typeof TABS)[number]>('capabilities')
  const [caps, setCaps] = useState<Capability[]>([])
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<(typeof KINDS)[number]>('all')
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [open, setOpen] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [jobId, setJobId] = useState<string | null>(null)
  const [rev, setRev] = useState(0)
  const job = useJob(jobId)

  useEffect(() => { api.capabilities({ project, q, kind: kind === 'all' ? undefined : kind }).then(setCaps) }, [project, q, kind, rev])
  useEffect(() => { if (job?.status === 'done') setRev(r => r + 1) }, [job?.status])

  async function setOverride(c: Capability, action: Override) {
    const next = c.override === action ? null : action
    try {
      const updated = await api.setOverride(c.id, project, next)
      setCaps(cs => cs.map(x => (x.id === c.id ? { ...x, ...updated } : x)))
      setErrs(({ [c.id]: _, ...rest }) => rest)
    } catch (e) {
      setErrs(es => ({ ...es, [c.id]: errText(e, { ns: c.namespace }) }))
    }
  }
  const reindex = async () => {
    try { setJobId((await api.reindex(project)).job_id) } catch (e) { setErrs(es => ({ ...es, _index: errText(e) })) }
  }
  const r = job?.result as IndexResult | null | undefined

  return (
    <>
      <Header crumb="Library" title="Library" sub={`${fmtInt(caps.length)} capabilities · overrides apply to ${project ?? 'all projects'} on the next route`}>
        <Search value={q} onChange={setQ} placeholder="Search capabilities" />
        <button className="btn" onClick={() => setCreating(true)}>New capability</button>
        <button className="btn" onClick={reindex} disabled={job?.status === 'queued' || job?.status === 'running'}>Reindex</button>
      </Header>
      {job && (
        <div className={job.status === 'failed' ? 'err' : job.status === 'done' ? 'okmsg' : 'muted'}>
          {job.status === 'done' && r ? `Reindexed: +${r.added} added · ${r.changed} changed · ${r.removed} removed · ${fmtInt(r.vectors)} vectors`
            : job.status === 'failed' ? `Reindex failed: ${job.error}` : `Reindexing… ${Math.round(job.progress * 100)}%`}
        </div>
      )}
      {errs._index && <div className="err">{errs._index}</div>}
      <div className="toolbar">
        <Segmented options={TABS} value={tab} onChange={setTab} />
        {tab === 'capabilities' && <Segmented options={KINDS} value={kind} onChange={setKind} />}
      </div>

      {tab === 'duplicates' ? <Duplicates /> : (
        <div className="card tablewrap">
          <table>
            <thead><tr><th>Capability</th><th>Kind</th><th className="num">Suggested 30d</th><th className="num">Followed</th><th>Override</th></tr></thead>
            <tbody>
              {caps.map(c => (
                <tr key={c.id} className="click" onClick={() => setOpen(c.id)}>
                  <td>
                    <div className="title mono">{c.id}</div>
                    <div className="subline">{c.description}</div>
                    {c.cluster_id && <span className="tag warn">cluster: {c.cluster_id}</span>}
                  </td>
                  <td><span className="tag">{c.kind}</span></td>
                  <td className="num">{c.calls_30d}</td>
                  <td className="num">{c.calls_30d ? `${Math.round((c.followed_30d / c.calls_30d) * 100)}%` : '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
                    {ACTIONS.map(a => (
                      <button key={a} className={'btn' + (a !== 'pin' ? ' danger' : '')} style={{ marginRight: 4, ...(c.override === a ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}) }}
                        onClick={() => setOverride(c, a)}>{a}</button>
                    ))}
                    {errs[c.id] && <div className="err">{errs[c.id]}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!caps.length && <div className="empty">No capabilities match.</div>}
        </div>
      )}

      {open && <CapabilityDrawer id={open} project={project} projects={projects} onClose={() => setOpen(null)} onChanged={() => setRev(r => r + 1)} />}
      {creating && (
        <Drawer onClose={() => setCreating(false)}>
          <div className="card-title" style={{ fontSize: 16 }}>New capability</div>
          <div className="card-sub">Written to disk, then indexed. Plugin capabilities can't be created here.</div>
          <CapabilityForm projects={projects} project={project} onCancel={() => setCreating(false)} onDone={() => { setCreating(false); setRev(r => r + 1) }} />
        </Drawer>
      )}
    </>
  )
}

function CapabilityDrawer({ id, project, projects, onClose, onChanged }: {
  id: string; project: string | null; projects: string[]; onClose: () => void; onChanged: () => void
}) {
  const [cap, setCap] = useState<CapabilityDetail | null>(null)
  const [editing, setEditing] = useState(false)
  const [err, setErr] = useState('')
  const load = () => api.capability(id, project).then(setCap).catch(e => setErr(errText(e)))
  useEffect(() => { load() }, [id, project]) // eslint-disable-line react-hooks/exhaustive-deps

  const remove = async () => {
    if (!cap || !confirm(`Delete ${cap.id}? Its file moves to ~/.claudethecaller/trash/ (restorable from there) and it leaves the index.`)) return
    try { await api.deleteCapability(cap.id); onChanged(); onClose() } catch (e) { setErr(errText(e, { ns: cap.namespace })) }
  }

  return (
    <Drawer onClose={onClose}>
      {!cap ? <div className={err ? 'err' : 'empty'}>{err || 'Loading…'}</div> : editing ? (
        <>
          <div className="card-title mono" style={{ fontSize: 15 }}>Edit {cap.id}</div>
          <CapabilityForm edit={cap} projects={projects} project={project} onCancel={() => setEditing(false)} onDone={() => { setEditing(false); load(); onChanged() }} />
        </>
      ) : (
        <>
          <div>
            <div className="card-sub">{cap.namespace}</div>
            <h2 className="mono" style={{ margin: '4px 0 6px', fontSize: 17 }}>{cap.id}</h2>
            <span className="tag">{cap.kind}</span>
            {cap.editable ? <span className="tag good">editable</span> : <span className="tag">plugin-managed</span>}
            {cap.override && <span className="tag warn">{cap.override}</span>}
          </div>
          <div>{cap.description}</div>
          <dl className="kv">
            <dt>invoke</dt><dd>{cap.invoke}</dd>
            <dt>path</dt><dd>{cap.path}</dd>
            <dt>vectors</dt><dd>{cap.vectors}</dd>
            <dt>last 30 days</dt><dd>{cap.calls_30d} suggested · {cap.followed_30d} followed</dd>
            <dt>cluster</dt><dd>{cap.cluster_members.length ? cap.cluster_members.join(', ') : '—'}</dd>
          </dl>
          <div className="card-title">Summary</div>
          <div className={cap.summary ? '' : 'faint'}>{cap.summary ?? 'No summary yet (enrichment comes with A1).'}</div>
          {cap.triggers.length > 0 && <div>{cap.triggers.map(t => <span key={t} className="tag">{t}</span>)}</div>}
          <div className="card-title">File</div>
          <pre className="code">{cap.body}</pre>
          <div className="card-title">Recent decisions <span className="faint mono">{cap.recent_decisions.length}</span></div>
          {cap.recent_decisions.length ? <div className="card tablewrap"><DecisionTable rows={cap.recent_decisions} projects={projects} /></div> : <div className="faint">Not suggested yet.</div>}
          {cap.editable ? (
            <div className="actions">
              <button className="btn" onClick={() => setEditing(true)}>Edit</button>
              <button className="btn danger" onClick={remove}>Delete</button>
              {err && <span className="err">{err}</span>}
            </div>
          ) : <div className="faint">Plugin-managed: change it in its plugin, or pin / block / disable it from the table.</div>}
        </>
      )}
    </Drawer>
  )
}

function Duplicates() {
  const [pairs, setPairs] = useState<DedupPair[]>([])
  const [errs, setErrs] = useState<Record<number, string>>({})
  useEffect(() => { api.dedup('open').then(setPairs) }, [])
  const resolve = async (p: DedupPair, action: 'merge' | 'keep_apart') => {
    try { await api.resolveDedup(p.id, action); setPairs(ps => ps.filter(x => x.id !== p.id)) } catch (e) { setErrs(es => ({ ...es, [p.id]: errText(e) })) }
  }
  return (
    <div className="card tablewrap">
      <table>
        <thead><tr><th>Possible duplicates</th><th className="num">Similarity</th><th /></tr></thead>
        <tbody>
          {pairs.map(p => (
            <tr key={p.id}>
              <td className="mono">{p.a} <span className="faint">↔</span> {p.b}</td>
              <td className="num">{p.similarity.toFixed(2)}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button className="btn" onClick={() => resolve(p, 'merge')}>Merge</button>{' '}
                <button className="btn" onClick={() => resolve(p, 'keep_apart')}>Keep apart</button>
                {errs[p.id] && <div className="err">{errs[p.id]}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!pairs.length && <div className="empty">No open duplicate pairs. Merged pairs share a cluster and show as one hit.</div>}
    </div>
  )
}
