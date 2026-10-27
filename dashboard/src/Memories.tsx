import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, errText } from './api'
import type { ViewProps } from './App'
import { MemoryCard, ObservationCard, PromptCard, SummaryCard, useJob } from './parts'
import type { FeedCounts, FeedItem, Memory, MemoryKind, MemoryWrite, NewMemory } from './types'
import { Drawer, Header, Search, Segmented, fmtInt } from './ui'

type MemoriesProps = ViewProps & { session: string | null; onClearSession: () => void }
const TABS = ['timeline', 'long-term'] as const

const KINDS = ['all', 'preference', 'convention', 'fact', 'skill_outcome'] as const
const SAID: Record<MemoryWrite['action'], string> = { ADD: 'Added.', UPDATE: 'Merged into an existing memory.', NOOP: 'Already known; nothing new saved.' }

export default function Memories(props: MemoriesProps) {
  const [tab, setTab] = useState<(typeof TABS)[number]>('timeline')
  const seg = <Segmented options={TABS} value={tab} onChange={setTab} />
  return tab === 'timeline' ? <Timeline {...props} seg={seg} /> : <LongTerm project={props.project} projects={props.projects} seg={seg} />
}

// ---- Timeline: observations, summaries and prompts in one feed (m7) ----
const LIMIT = 50
const CHIPS = ['prompt', 'summary', 'discovery', 'decision', 'bugfix', 'feature', 'refactor', 'change', 'security_alert', 'security_note'] as const
const chipLabel = (k: string) => k[0].toUpperCase() + k.slice(1).replace('_', ' ')
const keyOf = (i: FeedItem) => `${i.item_type}-${i.id}`
const curOf = (i: FeedItem) => `${i.created_at},${i.item_type},${i.id}`
// The memory.context defaults of config/server.yaml, shown read-only next to the preview.
const KNOBS: [string, string][] = [['observations', '50 newest observations'], ['sessions', '10 session summaries'], ['full_count', '0 shown in full'], ['limit_chars', '10,000 characters'], ['ttl_s', 'cached for 600 s']]

function Timeline({ project, range, session, onClearSession, seg }: MemoriesProps & { seg: ReactNode }) {
  const [q, setQ] = useState('')
  const [types, setTypes] = useState<string[]>([])
  const [items, setItems] = useState<FeedItem[]>([])
  const [counts, setCounts] = useState<FeedCounts>({})
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true) // the first load starts in the effect below
  const [error, setError] = useState('')
  const [rev, setRev] = useState(0) // bumps the chip counts after a delete, an undo or new items
  const [extracting, setExtracting] = useState(0)
  const [preview, setPreview] = useState(false)
  const gen = useRef(0) // a filter change bumps it, so late answers of the old filters are dropped
  const itemsRef = useRef(items)
  itemsRef.current = items
  const typesKey = types.join(',')
  const filters = { project, session_id: session, types: typesKey, q, range }

  const load = async (before?: string) => {
    const g = gen.current
    setLoading(true)
    setError('')
    try {
      const rows = await api.memFeed({ ...filters, before, limit: LIMIT })
      if (g !== gen.current) return
      setItems(xs => (before ? [...xs, ...rows.filter(r => !xs.some(x => keyOf(x) === keyOf(r)))] : rows))
      setHasMore(!q && rows.length === LIMIT) // a search is one page
    } catch (e) {
      if (g === gen.current) setError(errText(e))
    } finally {
      if (g === gen.current) setLoading(false)
    }
  }
  const more = useRef(() => {})
  more.current = () => { const last = items[items.length - 1]; if (last) load(curOf(last)) }

  useEffect(() => { gen.current++; setItems([]); setHasMore(false); load() }, [project, range, session, q, typesKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.memFeedCounts({ project, session_id: session, q, range }).then(setCounts).catch(() => {}) }, [project, range, session, q, rev])

  const sentinel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = sentinel.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting && hasMore && !loading && !error) more.current() }, { threshold: 0.1 })
    io.observe(el)
    return () => io.disconnect() // a new observer per state change re-fires, so a short page keeps loading until the sentinel scrolls out
  }, [hasMore, loading, error])

  // ponytail: polling, SSE later. Every 3 s while the tab is visible; a search is one page, so it is not polled.
  useEffect(() => {
    if (q) return
    const g = gen.current
    const t = window.setInterval(async () => {
      const newest = itemsRef.current[0]
      if (document.visibilityState !== 'visible' || !newest) return
      try {
        const rows = await api.memFeed({ ...filters, after: curOf(newest), limit: LIMIT })
        if (g !== gen.current) return
        setItems(xs => { const seen = new Set(xs.map(keyOf)); const fresh = rows.filter(r => !seen.has(keyOf(r))); return fresh.length ? [...fresh, ...xs] : xs })
        if (rows.length) setRev(r => r + 1)
      } catch { /* the next tick retries */ }
    }, 3000)
    return () => clearInterval(t)
  }, [project, range, session, q, typesKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { // the "extracting N…" pill: observe jobs still queued or running
    let alive = true
    const tick = () => api.jobs({ kind: 'observe', limit: 50 }).then(js => alive && setExtracting(js.filter(j => j.status === 'queued' || j.status === 'running').length)).catch(() => {})
    tick()
    const t = window.setInterval(tick, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const change = (i: FeedItem) => (next: object) => {
    setItems(xs => xs.map(x => (keyOf(x) === keyOf(i) ? ({ ...x, ...next } as FeedItem) : x)))
    setRev(r => r + 1)
  }
  const total = Object.values(counts).reduce((a, n) => a + (n ?? 0), 0)
  const toggle = (k: string) => setTypes(t => (t.includes(k) ? t.filter(x => x !== k) : [...t, k]))

  return (
    <>
      <Header crumb="Memories" title="Memories" sub={`${fmtInt(total)} items in the timeline${project ? ' for ' + project : ''}`}>
        {seg}
        <Search value={q} onChange={setQ} placeholder="Search memories" />
        {extracting > 0 && <span className="pill" title="Captures still being turned into observations">extracting {extracting}…</span>}
        <button className="btn" disabled={!project} onClick={() => setPreview(true)}
          title={project ? 'What a new session in this project receives' : 'Pick a project in the sidebar first: the context is per project'}>Preview context</button>
      </Header>
      <div className="chips row">
        {session && <span className="chip on">session {session.slice(0, 8)} <button className="x" aria-label="Clear the session filter" onClick={onClearSession}>✕</button></span>}
        {CHIPS.map(k => (
          <button key={k} className={'chip' + (types.includes(k) ? ' on' : '')} aria-pressed={types.includes(k)} onClick={() => toggle(k)}>{chipLabel(k)} ({counts[k] ?? 0})</button>
        ))}
      </div>
      <div className="feed">
        {items.map(i => i.item_type === 'observation' ? <ObservationCard key={keyOf(i)} o={i} onChange={change(i)} />
          : i.item_type === 'summary' ? <SummaryCard key={keyOf(i)} x={i} onChange={change(i)} /> : <PromptCard key={keyOf(i)} p={i} />)}
        <div ref={sentinel} className="sentinel" />
        {loading && <div className="feed-note">Loading more…</div>}
        {error && <div className="feed-note err">{error} <button className="btn" onClick={() => load(items.length ? curOf(items[items.length - 1]) : undefined)}>Retry</button></div>}
        {!loading && !error && !items.length && <div className="empty">No memories to show. Memories appear here as you work. If a filter is selected, try another project or category.</div>}
        {!loading && !error && !hasMore && items.length > 0 && <div className="feed-note">No more items to load</div>}
      </div>
      {preview && project && <ContextPreview project={project} onClose={() => setPreview(false)} />}
    </>
  )
}

function ContextPreview({ project, onClose }: { project: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => { api.memContext(project).then(setText).catch(e => setErr(errText(e))) }, [project])
  return (
    <Drawer onClose={onClose}>
      <div>
        <div className="card-sub">What a new session in {project} receives</div>
        <h2 style={{ margin: '6px 0 0', fontSize: 18 }}>Session-start context</h2>
      </div>
      {err ? <div className="err">{err}</div> : text === null ? <div className="empty">Loading…</div> : <pre className="code pre-ctx">{text}</pre>}
      <div className="card-title">Settings <span className="faint">read-only, memory.context in config/server.yaml</span></div>
      <dl className="kv">{KNOBS.map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    </Drawer>
  )
}

// ---- Long-term: the original page ----
function LongTerm({ project, projects, seg }: Pick<ViewProps, 'project' | 'projects'> & { seg: ReactNode }) {
  const [mems, setMems] = useState<Memory[]>([])
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<(typeof KINDS)[number]>('all')
  const [pinnedOnly, setPinnedOnly] = useState(false)
  const [showDeleted, setShowDeleted] = useState(false)
  const [adding, setAdding] = useState(false)
  const [rev, setRev] = useState(0)
  const [jobId, setJobId] = useState<string | null>(null)
  const [jobErr, setJobErr] = useState('')
  const job = useJob(jobId)
  const busy = job?.status === 'queued' || job?.status === 'running'
  useEffect(() => { if (job?.status === 'done') setRev(r => r + 1) }, [job?.status])
  const run = async (start: () => Promise<{ job_id: string }>) => {
    setJobErr('')
    try { setJobId((await start()).job_id) } catch (e) { setJobErr(errText(e)) }
  }

  useEffect(() => {
    api.memories({ project, q, kind: kind === 'all' ? undefined : kind, pinned: pinnedOnly || undefined, include_deleted: showDeleted || undefined }).then(setMems)
  }, [project, q, kind, pinnedOnly, showDeleted, rev])

  return (
    <>
      <Header crumb="Memories" title="Memories" sub={`${mems.filter(m => !m.deleted_at).length} long-term memories${project ? ' for ' + project + ' + global' : ''}`}>
        {seg}
        <Search value={q} onChange={setQ} placeholder="Search memories" />
        <button className="btn" onClick={() => setAdding(a => !a)}>Add memory</button>
        <button className="btn" disabled={busy} onClick={() => run(api.importMemories)} title="Read ~/.claude/projects/*/memory/*.md (never written)">Import Claude memories</button>
        <button className="btn" disabled={busy} onClick={() => run(() => api.backfillMemories(20))} title="Extract memories from the 20 most recent sessions with the local LLM">Backfill from sessions</button>
      </Header>
      {job && (
        <div className={job.status === 'failed' ? 'err' : job.status === 'done' ? 'okmsg' : 'muted'}>
          {job.status === 'failed' ? `${job.kind.replace('_', ' ')} failed: ${job.error}`
            : job.status === 'done' ? `${job.kind.replace('_', ' ')} done: ${Object.entries(job.result ?? {}).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${v} ${k}`).join(' · ')}`
            : `${job.kind.replace('_', ' ')}… ${Math.round(job.progress * 100)}%`}
        </div>
      )}
      {jobErr && <div className="err">{jobErr}</div>}
      {adding && <AddMemory project={project} projects={projects} onSaved={() => setRev(r => r + 1)} />}
      <div className="toolbar">
        <Segmented options={KINDS} value={kind} onChange={setKind} />
        <label className="toggle"><input type="checkbox" checked={pinnedOnly} onChange={e => setPinnedOnly(e.target.checked)} /> Pinned only</label>
        <label className="toggle"><input type="checkbox" checked={showDeleted} onChange={e => setShowDeleted(e.target.checked)} /> Show deleted</label>
      </div>
      <div className="memlist">
        {mems.map(m => <MemoryCard key={m.id} m={m} onChange={next => setMems(ms => ms.map(x => (x.id === next.id ? next : x)))} />)}
      </div>
      {!mems.length && <div className="empty">No memories match.</div>}
    </>
  )
}

function AddMemory({ project, projects, onSaved }: { project: string | null; projects: string[]; onSaved: () => void }) {
  const [f, setF] = useState<NewMemory>({ scope: project ? 'project' : 'global', project: project ?? projects[0], kind: 'preference', text: '', pinned: false })
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const save = async () => {
    if (!f.text.trim()) return setMsg({ ok: false, text: 'Write the memory first.' })
    try {
      const res = await api.createMemory({ ...f, text: f.text.trim(), project: f.scope === 'project' ? f.project : undefined })
      setMsg({ ok: true, text: SAID[res.action] })
      if (res.action === 'ADD') setF({ ...f, text: '' })
      onSaved()
    } catch (e) { setMsg({ ok: false, text: errText(e) }) }
  }
  return (
    <div className="card pad form">
      <div className="row2">
        <label>Scope<select value={f.scope} onChange={e => setF({ ...f, scope: e.target.value as NewMemory['scope'] })}>
          <option value="global">global (every project)</option><option value="project">one project</option></select></label>
        <label>Project<select value={f.project} disabled={f.scope === 'global'} onChange={e => setF({ ...f, project: e.target.value })}>
          {projects.map(p => <option key={p}>{p}</option>)}</select></label>
      </div>
      <div className="row2">
        <label>Kind<select value={f.kind} onChange={e => setF({ ...f, kind: e.target.value as MemoryKind })}>
          {KINDS.slice(1).map(k => <option key={k}>{k}</option>)}</select></label>
        <label className="toggle" style={{ alignSelf: 'end' }}><input type="checkbox" checked={!!f.pinned} onChange={e => setF({ ...f, pinned: e.target.checked })} /> Pinned (never fades)</label>
      </div>
      <textarea value={f.text} placeholder="e.g. Staging deploys need a migration dry run first." onChange={e => setF({ ...f, text: e.target.value })} />
      <div className="actions"><button className="btn" style={{ borderColor: 'var(--accent)' }} onClick={save}>Save</button>{msg && <span className={msg.ok ? 'okmsg' : 'err'}>{msg.text}</span>}</div>
    </div>
  )
}
