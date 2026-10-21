import { useEffect, useState } from 'react'
import { PAGE, api } from './api'
import type { ViewProps } from './App'
import type { Session } from './types'
import { Header, Search, colorOf, fmtInt, fmtTime, fmtTokens } from './ui'

export default function Sessions({ project, projects }: ViewProps) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [q, setQ] = useState('')

  const [more, setMore] = useState(false)
  const load = (before?: string) =>
    api.sessions({ project, q, before }).then(rows => {
      setSessions(ss => (before ? [...ss, ...rows] : rows))
      setMore(rows.length === PAGE)
    })
  useEffect(() => { load() }, [project, q]) // eslint-disable-line react-hooks/exhaustive-deps
  const maxTurns = Math.max(1, ...sessions.map(s => s.turns))

  return (
    <>
      <Header crumb="Sessions" title="Sessions" sub={`${fmtInt(sessions.length)} Claude Code sessions${project ? ' in ' + project : ''}`}>
        <Search value={q} onChange={setQ} placeholder="Search sessions" />
      </Header>
      <div className="card tablewrap">
        <table>
          <thead><tr><th>Session</th><th className="num">Turns</th><th className="num">Tokens</th><th className="num">Routes</th><th className="num">Followed</th><th className="num">Memories</th></tr></thead>
          <tbody>
            {sessions.map(s => (
              <tr key={s.id}>
                <td>
                  <div className="title">{s.title}</div>
                  <div className="subline">{s.project} · {fmtTime(s.started_at)} · {s.model}</div>
                  <div className="bar" style={{ width: `${(s.turns / maxTurns) * 70}%`, background: colorOf(projects, s.project) }} />
                </td>
                <td className="num">{s.turns}</td>
                <td className="num">{fmtTokens(s.tokens)}</td>
                <td className="num">{s.decisions}</td>
                <td className="num">{s.followed}/{s.decisions}</td>
                <td className="num">{s.memories}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!sessions.length && <div className="empty">No sessions match.</div>}
        {more && <button className="btn more" onClick={() => load(sessions[sessions.length - 1].id)}>Load more</button>}
      </div>
    </>
  )
}
