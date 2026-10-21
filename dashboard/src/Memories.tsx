import { useEffect, useState } from 'react'
import { api, errText } from './api'
import type { ViewProps } from './App'
import { MemoryCard } from './parts'
import type { Memory, MemoryKind, MemoryWrite, NewMemory } from './types'
import { Header, Search, Segmented } from './ui'

const KINDS = ['all', 'preference', 'convention', 'fact', 'skill_outcome'] as const
const SAID: Record<MemoryWrite['action'], string> = { ADD: 'Added.', UPDATE: 'Merged into an existing memory.', NOOP: 'Already known; nothing new saved.' }

export default function Memories({ project, projects }: ViewProps) {
  const [mems, setMems] = useState<Memory[]>([])
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<(typeof KINDS)[number]>('all')
  const [pinnedOnly, setPinnedOnly] = useState(false)
  const [showDeleted, setShowDeleted] = useState(false)
  const [adding, setAdding] = useState(false)
  const [rev, setRev] = useState(0)

  useEffect(() => {
    api.memories({ project, q, kind: kind === 'all' ? undefined : kind, pinned: pinnedOnly || undefined, include_deleted: showDeleted || undefined }).then(setMems)
  }, [project, q, kind, pinnedOnly, showDeleted, rev])

  return (
    <>
      <Header crumb="Memories" title="Memories" sub={`${mems.filter(m => !m.deleted_at).length} long-term memories${project ? ' for ' + project + ' + global' : ''}`}>
        <Search value={q} onChange={setQ} placeholder="Search memories" />
        <button className="btn" onClick={() => setAdding(a => !a)}>Add memory</button>
      </Header>
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
