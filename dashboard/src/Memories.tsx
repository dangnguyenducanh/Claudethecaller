import { useEffect, useState } from 'react'
import { api, errText } from './api'
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
  const [errs, setErrs] = useState<Record<string, string>>({})

  const [pinnedOnly, setPinnedOnly] = useState(false)
  const [showDeleted, setShowDeleted] = useState(false)
  useEffect(() => {
    api.memories({ project, q, kind: kind === 'all' ? undefined : kind, pinned: pinnedOnly || undefined, include_deleted: showDeleted || undefined }).then(setMems)
  }, [project, q, kind, pinnedOnly, showDeleted])

  const attempt = async (m: Memory, fn: () => Promise<void>) => {
    try {
      await fn()
      setErrs(({ [m.id]: _, ...rest }) => rest)
    } catch (e) {
      setErrs(es => ({ ...es, [m.id]: errText(e) }))
    }
  }
  const update = (m: Memory, patch: Partial<Pick<Memory, 'text' | 'pinned'>>) => attempt(m, async () => {
    const next = await api.updateMemory(m.id, patch)
    setMems(ms => ms.map(x => (x.id === m.id ? next : x)))
  })
  // Soft delete: the card stays as an Undo bar instead of a confirm() dialog.
  const remove = (m: Memory) => attempt(m, async () => {
    await api.deleteMemory(m.id)
    setMems(ms => ms.map(x => (x.id === m.id ? { ...x, deleted_at: new Date().toISOString() } : x)))
  })
  const restore = (m: Memory) => attempt(m, async () => {
    const back = await api.restoreMemory(m.id)
    setMems(ms => ms.map(x => (x.id === m.id ? back : x)))
  })

  const shown = mems
  return (
    <>
      <Header crumb="Memories" title="Memories" sub={`${shown.length} long-term memories${project ? ' for ' + project + ' + global' : ''}`}>
        <Search value={q} onChange={setQ} placeholder="Search memories" />
      </Header>
      <div className="toolbar">
        <Segmented options={KINDS} value={kind} onChange={setKind} />
        <label className="toggle"><input type="checkbox" checked={pinnedOnly} onChange={e => setPinnedOnly(e.target.checked)} /> Pinned only</label>
        <label className="toggle"><input type="checkbox" checked={showDeleted} onChange={e => setShowDeleted(e.target.checked)} /> Show deleted</label>
      </div>
      <div className="memlist">
        {shown.map(m => m.deleted_at ? (
          <div key={m.id} className="card pad mem undo">
            <span><span className="tag bad">deleted</span> {m.text.slice(0, 60)}{m.text.length > 60 ? '…' : ''}</span>
            <button className="btn" onClick={() => restore(m)}>{showDeleted ? 'Restore' : 'Undo'}</button>
            {errs[m.id] && <div className="err">{errs[m.id]}</div>}
          </div>
        ) : (
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
            {errs[m.id] && <div className="err">{errs[m.id]}</div>}
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
