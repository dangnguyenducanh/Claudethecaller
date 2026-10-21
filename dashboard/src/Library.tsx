import { useEffect, useState } from 'react'
import { api } from './api'
import type { ViewProps } from './App'
import type { Capability, Kind, Override } from './types'
import { Header, Search, Segmented, fmtInt } from './ui'

const KINDS = ['all', 'skill', 'agent', 'command', 'workflow'] as const
const ACTIONS: Override[] = ['pin', 'block', 'disable']

export default function Library({ project }: ViewProps) {
  const [caps, setCaps] = useState<Capability[]>([])
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<(typeof KINDS)[number]>('all')

  useEffect(() => { api.capabilities(project, q).then(setCaps) }, [project, q])

  async function setOverride(c: Capability, action: Override) {
    const next = c.override === action ? null : action
    const updated = await api.setOverride(c.id, project, next)
    setCaps(cs => cs.map(x => (x.id === c.id ? { ...x, ...updated } : x)))
  }

  const shown = caps.filter(c => kind === 'all' || c.kind === (kind as Kind))
  return (
    <>
      <Header crumb="Library" title="Library" sub={`${fmtInt(caps.length)} capabilities indexed · overrides apply to ${project ?? 'all projects'} on the next route`}>
        <Search value={q} onChange={setQ} placeholder="Search capabilities" />
      </Header>
      <div><Segmented options={KINDS} value={kind} onChange={setKind} /></div>
      <div className="card tablewrap">
        <table>
          <thead><tr><th>Capability</th><th>Kind</th><th className="num">Suggested 30d</th><th className="num">Followed</th><th>Override</th></tr></thead>
          <tbody>
            {shown.map(c => (
              <tr key={c.id}>
                <td>
                  <div className="title mono">{c.id}</div>
                  <div className="subline">{c.description}</div>
                  {c.cluster_id && <span className="tag warn">duplicate cluster: {c.cluster_id}</span>}
                </td>
                <td><span className="tag">{c.kind}</span></td>
                <td className="num">{c.calls_30d}</td>
                <td className="num">{c.calls_30d ? `${Math.round((c.followed_30d / c.calls_30d) * 100)}%` : '—'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {ACTIONS.map(a => (
                    <button key={a} className={'btn' + (a !== 'pin' ? ' danger' : '')} style={{ marginRight: 4, ...(c.override === a ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}) }}
                      onClick={() => setOverride(c, a)}>{a}</button>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!shown.length && <div className="empty">No capabilities match.</div>}
      </div>
    </>
  )
}
