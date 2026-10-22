import { useEffect, useState } from 'react'
import { PAGE, api, errText } from './api'
import type { ViewProps } from './App'
import { DecisionDetail, DecisionTable, MemoryCard } from './parts'
import type { Decision, Session, SessionDetail } from './types'
import { Drawer, Header, Search, colorOf, fmtInt, fmtTime, fmtTokens } from './ui'

const CLAMP = { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } as const
/** Imported sessions wait for the local LLM to distil them; processed ones need no badge. */
const statusTag = (s: Pick<Session, 'status'>) => s.status !== 'processed' && <span className={'tag ' + (s.status === 'failed' ? 'bad' : 'warn')} style={{ marginLeft: 6 }}>{s.status}</span>

export default function Sessions({ project, projects }: ViewProps) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [q, setQ] = useState('')
  const [more, setMore] = useState(false)
  const [open, setOpen] = useState<string | null>(null)

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
              <tr key={s.id} className="click" onClick={() => setOpen(s.id)}>
                <td>
                  <div className="title">{s.title}{statusTag(s)}</div>
                  {s.summary && <div className="subline" style={CLAMP}>{s.summary}</div>}
                  <div className="subline">{s.project}{s.git_branch && ` @ ${s.git_branch}`} · {fmtTime(s.started_at)} · {s.model || 'model unknown'}</div>
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
      {open && <SessionDrawer id={open} projects={projects} onClose={() => setOpen(null)}
        onDeleted={() => { setSessions(ss => ss.filter(s => s.id !== open)); setOpen(null) }} />}
    </>
  )
}

function SessionDrawer({ id, projects, onClose, onDeleted }: { id: string; projects: string[]; onClose: () => void; onDeleted: () => void }) {
  const [s, setS] = useState<SessionDetail | null>(null)
  const [decision, setDecision] = useState<Decision | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => { api.session(id).then(setS).catch(e => setErr(errText(e))) }, [id])

  const remove = async () => {
    if (!s || !confirm(`Delete this session and its ${s.decisions.length} decisions? Its memories stay.`)) return
    try { await api.deleteSession(id); onDeleted() } catch (e) { setErr(errText(e)) }
  }

  return (
    <Drawer onClose={onClose}>
      {!s ? <div className={err ? 'err' : 'empty'}>{err || 'Loading…'}</div> : decision ? (
        <>
          <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setDecision(null)}>← {s.title}</button>
          <DecisionDetail d={decision} onDeleted={did => { setS({ ...s, decisions: s.decisions.filter(x => x.id !== did) }); setDecision(null) }} />
        </>
      ) : (
        <>
          <div>
            <div className="card-sub">{s.project}{s.git_branch && ` @ ${s.git_branch}`} · {fmtTime(s.started_at)} · {s.model || 'model unknown'}</div>
            <h2 style={{ margin: '6px 0 0', fontSize: 18 }}>{s.title}{statusTag(s)}</h2>
          </div>
          {s.summary ? <div>{s.summary}</div> : s.status === 'pending' && <div className="faint">Not distilled yet: summary, intents and memories come from the next history job.</div>}
          <div><span className="tag">{s.source === 'history' ? 'from history' : 'live'}</span><span className="tag">{s.turns} turns</span><span className="tag">{fmtTokens(s.tokens)} tokens</span><span className="tag">{s.followed}/{s.decisions.length} followed</span></div>
          <div className="card-title">Decisions <span className="faint mono">{s.decisions.length}</span></div>
          {s.decisions.length ? <div className="card tablewrap"><DecisionTable rows={s.decisions} projects={projects} onOpen={setDecision} /></div> : <div className="faint">No routed prompts.</div>}
          <div className="card-title">Memories from this session <span className="faint mono">{s.memories.length}</span></div>
          {s.memories.length ? s.memories.map(m => (
            <MemoryCard key={m.id} m={m} onChange={next => setS({ ...s, memories: s.memories.map(x => (x.id === next.id ? next : x)) })} />
          )) : <div className="faint">None extracted.</div>}
          <div className="actions"><button className="btn danger" onClick={remove}>Delete session</button>{err && <span className="err">{err}</span>}</div>
        </>
      )}
    </Drawer>
  )
}
