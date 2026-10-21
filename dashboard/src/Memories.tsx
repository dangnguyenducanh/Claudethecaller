import { useEffect, useState } from 'react'
import { api } from './api'
import type { ViewProps } from './App'
import type { Memory } from './types'
import { Header, Search, Segmented, fmtDay } from './ui'

const KINDS = ['all', 'preference', 'convention', 'fact', 'skill_outcome'] as const

export default function Memories({ project }: ViewProps) {
  const [mems, setMems] = useState<Memory[]>([])
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<(typeof KINDS)[number]>('all')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  useEffect(() => { api.memories(project, q).then(setMems) }, [project, q])

  const update = async (m: Memory, patch: Partial<Pick<Memory, 'text' | 'pinned'>>) => {
    const next = await api.updateMemory(m.id, patch)
    setMems(ms => ms.map(x => (x.id === m.id ? next : x)))
  }
  const remove = async (m: Memory) => {
    if (!confirm('Delete this memory? It stops shaping routing right away.')) return
    await api.deleteMemory(m.id)
    setMems(ms => ms.filter(x => x.id !== m.id))
  }

  const shown = mems.filter(m => kind === 'all' || m.kind === kind)
  return (
    <>
      <Header crumb="Memories" title="Memories" sub={`${shown.length} long-term memories${project ? ' for ' + project + ' + global' : ''}`}>
        <Search value={q} onChange={setQ} placeholder="Search memories" />
      </Header>
      <div><Segmented options={KINDS} value={kind} onChange={setKind} /></div>
      <div className="memlist">
        {shown.map(m => (
          <div key={m.id} className="card pad mem">
            <div>
              <span className="tag">{m.kind.replace('_', ' ')}</span>
              <span className="tag">{m.scope === 'global' ? 'global' : m.project}</span>
              {m.pinned && <span className="tag good">pinned</span>}
            </div>
            {editing === m.id
              ? <textarea value={draft} onChange={e => setDraft(e.target.value)} autoFocus />
              : <div>{m.text}</div>}
            {m.supersedes && <div className="subline">replaces {m.supersedes}</div>}
            <div className="mem-foot">
              <span className="mono">conf {m.confidence.toFixed(2)}</span>
              <span className="mono">used {m.use_count}×</span>
              <span title={m.source}>{fmtDay(m.updated_at)}</span>
              <span className="sp">
                {editing === m.id ? (
                  <>
                    <button className="btn" onClick={() => { update(m, { text: draft }); setEditing(null) }}>Save</button>
                    <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <button className="btn" onClick={() => update(m, { pinned: !m.pinned })}>{m.pinned ? 'Unpin' : 'Pin'}</button>
                    <button className="btn" onClick={() => { setEditing(m.id); setDraft(m.text) }}>Edit</button>
                    <button className="btn danger" onClick={() => remove(m)}>Delete</button>
                  </>
                )}
              </span>
            </div>
          </div>
        ))}
      </div>
      {!shown.length && <div className="empty">No memories match.</div>}
    </>
  )
}
