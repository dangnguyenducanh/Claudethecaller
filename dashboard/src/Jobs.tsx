import { Fragment, useEffect, useState } from 'react'
import { api, errText } from './api'
import type { ViewProps } from './App'
import { useJob } from './parts'
import type { HistoryStatus, IndexResult, Job } from './types'
import { Header, Segmented, fmtTime } from './ui'

const STATUS = ['all', 'queued', 'running', 'done', 'failed'] as const
const KINDS = ['all', 'index', 'enrich', 'import_memory', 'backfill', 'extract', 'history', 'distill'] as const // the daemon's job kinds (jobs.py HANDLERS)
const PILL: Record<Job['status'], string> = { queued: '', running: 'warn', done: 'good', failed: 'bad' }
const active = (j: Job) => j.status === 'queued' || j.status === 'running'

export default function Jobs({ project }: ViewProps) {
  const [jobs, setJobs] = useState<Job[]>([])
  const [status, setStatus] = useState<(typeof STATUS)[number]>('all')
  const [kind, setKind] = useState<(typeof KINDS)[number]>('all')
  const [open, setOpen] = useState<string | null>(null)
  const [rev, setRev] = useState(0)
  const [jobId, setJobId] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [hist, setHist] = useState<HistoryStatus | null>(null)
  const job = useJob(jobId)
  const histBusy = !!hist?.last_job && active(hist.last_job)

  // Poll every 2 s only while some job (or the last history job) is queued or running; otherwise one fetch per filter change.
  useEffect(() => {
    let alive = true
    let timer = 0
    const load = async () => {
      try {
        const [rows, h] = await Promise.all([
          api.jobs({ status: status === 'all' ? undefined : status, kind: kind === 'all' ? undefined : kind }),
          api.history().catch(() => null), // a daemon without B9 just hides the card
        ])
        if (!alive) return
        setJobs(rows)
        setHist(h)
        if (rows.some(active) || (h?.last_job && active(h.last_job))) timer = window.setTimeout(load, 2000)
      } catch (e) { if (alive) setErr(errText(e)) }
    }
    load()
    return () => { alive = false; clearTimeout(timer) }
  }, [status, kind, rev])
  useEffect(() => { if (job?.status === 'done' || job?.status === 'failed') setRev(r => r + 1) }, [job?.status])

  const reindex = async () => {
    try { setErr(''); setJobId((await api.reindex(project)).job_id); setRev(r => r + 1) } catch (e) { setErr(errText(e)) }
  }
  const importHistory = async () => {
    try { setErr(''); await api.importHistory(); setRev(r => r + 1) } catch (e) { setErr(errText(e)) }
  }
  const r = job?.result as IndexResult | null | undefined

  return (
    <>
      <Header crumb="Jobs" title="Jobs" sub={`${jobs.length} jobs${jobs.some(active) ? ' · refreshing every 2 s' : ''}`}>
        <button className="btn" onClick={importHistory} disabled={histBusy}>Import Claude history</button>
        <button className="btn" onClick={reindex} disabled={job?.status === 'queued' || job?.status === 'running'}>Reindex</button>
      </Header>
      {job && (
        <div className={job.status === 'failed' ? 'err' : job.status === 'done' ? 'okmsg' : 'muted'}>
          {job.status === 'done' && r ? `Reindexed: +${r.added} added · ${r.changed} changed · ${r.removed} removed · ${r.vectors} vectors`
            : job.status === 'failed' ? `Reindex failed: ${job.error}` : `Reindexing… ${Math.round(job.progress * 100)}%`}
        </div>
      )}
      {err && <div className="err">{err}</div>}
      {hist && (
        <div className="card pad">
          <div className="card-title">Claude history</div>
          <div className="card-sub mono">{hist.root} · read-only; only summaries, intents and memories are stored</div>
          <div className="rows">
            <div className="row"><span className="muted">Transcript files</span><span className="mono">{hist.imported}/{hist.files} imported</span></div>
            <div className="row"><span className="muted">Sessions pending</span><span className="mono">{hist.pending}</span></div>
            <div className="row"><span className="muted">Sessions processed</span><span className="mono">{hist.processed}</span></div>
            <div className="row"><span className="muted">Sessions failed</span><span className={'mono' + (hist.failed ? ' err' : '')}>{hist.failed}</span></div>
            <div className="row"><span className="muted">Last import</span><span className="mono">{hist.last_job
              ? `${hist.last_job.status}${histBusy ? ` · ${Math.round(hist.last_job.progress * 100)}%` : ''} · ${fmtTime(hist.last_job.created_at)}` : 'never'}</span></div>
          </div>
          {hist.last_job?.error && <div className="err">{hist.last_job.error}</div>}
        </div>
      )}
      <div className="toolbar"><Segmented options={STATUS} value={status} onChange={setStatus} /><Segmented options={KINDS} value={kind} onChange={setKind} /></div>
      <div className="card tablewrap">
        <table>
          <thead><tr><th>Job</th><th>Status</th><th>Progress</th><th>Created</th></tr></thead>
          <tbody>
            {jobs.map(j => (
              <Fragment key={j.id}>
                <tr className="click" onClick={() => setOpen(open === j.id ? null : j.id)}>
                  <td><div className="title">{j.kind.replace('_', ' ')}</div><div className="subline mono">{j.id}</div></td>
                  <td>
                    <span className={'tag ' + PILL[j.status]}>{j.status}</span>
                    {j.error && <div className="err" style={{ marginTop: 4 }}>{j.error}</div>}
                  </td>
                  <td style={{ width: 160 }}><div className="pbar"><div style={{ width: `${Math.round(j.progress * 100)}%`, background: j.status === 'failed' ? 'var(--bad)' : j.status === 'done' ? 'var(--good)' : 'var(--accent)' }} /></div></td>
                  <td className="muted">{fmtTime(j.created_at)}</td>
                </tr>
                {open === j.id && (
                  <tr><td colSpan={4}><pre className="code">{j.result ? JSON.stringify(j.result, null, 2) : j.error ?? 'No result yet.'}</pre></td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {!jobs.length && <div className="empty">No jobs match. Reindex, enrich, memory and history imports show up here.</div>}
      </div>
    </>
  )
}
