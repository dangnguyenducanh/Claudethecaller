import { useEffect, useState } from 'react'
import { api, errText, setAuthListener, setKey } from './api'
import Library from './Library'
import Memories from './Memories'
import Overview from './Overview'
import Sessions from './Sessions'
import type { Health, Project, ProjectDetail, Range } from './types'
import { colorOf, fmtTime } from './ui'

const VIEWS = ['overview', 'library', 'sessions', 'memories'] as const
type View = (typeof VIEWS)[number]
export type ViewProps = { project: string | null; range: Range; setRange: (r: Range) => void; projects: string[] }

const ICONS: Record<View, string> = {
  overview: 'M3 13h4v8H3zM10 3h4v18h-4zM17 9h4v12h-4z',
  library: 'M4 4h6v16H4zM14 4h6v16h-6z',
  sessions: 'M4 6h16M4 12h16M4 18h10',
  memories: 'M12 3a6 6 0 0 0-6 6c0 2.4 1.3 3.7 2.5 4.8.8.7 1.5 1.6 1.5 2.7V18h4v-1.5c0-1.1.7-2 1.5-2.7C16.7 12.7 18 11.4 18 9a6 6 0 0 0-6-6zM10 21h4',
}

const SERVICES = ['db', 'redis', 'embedder', 'reranker', 'llm'] as const
function HealthDots({ h }: { h: Health }) {
  return (
    <div className="health" aria-label="Service health">
      {SERVICES.map(n => (
        <span key={n} className="dot" title={`${n}: ${h[n]}`} style={{ background: h[n] === 'ok' ? 'var(--good)' : 'var(--bad)' }} />
      ))}
      <span className="faint">{h.mode}</span>
    </div>
  )
}

function readTheme() {
  try { return localStorage.getItem('ctc-theme') ?? 'dark' } catch { return 'dark' }
}

export default function App() {
  const initial = location.hash.slice(1) as View
  const [view, setView] = useState<View>(VIEWS.includes(initial) ? initial : 'overview')
  const [project, setProject] = useState<string | null>(null)
  const [range, setRange] = useState<Range>('30d')
  const [projects, setProjects] = useState<Project[]>([])
  const [theme, setTheme] = useState(readTheme)
  const [menu, setMenu] = useState<string | null>(null)
  const [rev, setRev] = useState(0) // bumps after a project rename/delete so every view refetches

  const [needKey, setNeedKey] = useState(false)
  const [health, setHealth] = useState<Health | null>(null)
  useEffect(() => { // once at start, then every 30 s; failures keep the last value (the dots only change when the daemon says so)
    const load = () => api.health().then(setHealth).catch(() => {})
    load()
    const t = window.setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => { setAuthListener(() => setNeedKey(true)) }, [])

  const loadProjects = () => api.projects().then(setProjects).catch(() => {}) // a 401 is handled by the key panel
  useEffect(() => { loadProjects() }, [])
  const afterProjectChange = (from: string, to: string | null) => {
    setMenu(null)
    if (project === from) setProject(to)
    loadProjects()
    setRev(r => r + 1)
  }
  useEffect(() => { location.hash = view }, [view])
  useEffect(() => { // back/forward and pasted #links switch views
    const onHash = () => { const h = location.hash.slice(1) as View; if (VIEWS.includes(h)) setView(h) }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem('ctc-theme', theme) } catch { /* private mode */ }
  }, [theme])

  const names = projects.map(p => p.name)
  const props: ViewProps = { project, range, setRange, projects: names }

  if (needKey) return <KeyPanel />

  return (
    <div className="app">
      <nav className="side">
        <div className="brand">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2">
            <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3.2" fill="var(--accent)" />
          </svg>
          claudethecaller
        </div>
        {VIEWS.map(v => (
          <button key={v} className={'navitem' + (v === view ? ' on' : '')} onClick={() => setView(v)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d={ICONS[v]} /></svg>
            {v[0].toUpperCase() + v.slice(1)}
          </button>
        ))}
        <div className="projlist">
          <h6>Projects</h6>
          <button className={'navitem' + (project === null ? ' on' : '')} onClick={() => setProject(null)}>
            All projects<span className="count">{projects.reduce((s, p) => s + p.sessions, 0)}</span>
          </button>
          {projects.map(p => (
            <div key={p.id}>
              <div className="navrow">
                <button className={'navitem' + (project === p.name ? ' on' : '')} onClick={() => setProject(p.name)}>
                  <span className="dot" style={{ background: colorOf(names, p.name) }} />
                  {p.name}
                  <span className="count">{p.sessions}</span>
                </button>
                <button className={'dots' + (menu === p.name ? ' open' : '')} aria-label={`Project ${p.name} menu`} onClick={() => setMenu(menu === p.name ? null : p.name)}>⋯</button>
              </div>
              {menu === p.name && <ProjectMenu name={p.name} onChanged={afterProjectChange} />}
            </div>
          ))}
        </div>
        <div className="side-foot">
          <div>
            {health ? <HealthDots h={health} /> : <span>Local board</span>}
            <div>{health ? `lib ${health.library_version.slice(0, 8)}` : new Date().toISOString().slice(0, 10)}</div>
          </div>
          <button className="iconbtn" aria-label="Toggle theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              {theme === 'dark'
                ? <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
                : <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>}
            </svg>
          </button>
        </div>
      </nav>
      <main className="main" key={rev}>
        {view === 'overview' && <Overview {...props} />}
        {view === 'library' && <Library {...props} />}
        {view === 'sessions' && <Sessions {...props} />}
        {view === 'memories' && <Memories {...props} />}
      </main>
    </div>
  )
}

function ProjectMenu({ name, onChanged }: { name: string; onChanged: (from: string, to: string | null) => void }) {
  const [info, setInfo] = useState<ProjectDetail | null>(null)
  const [to, setTo] = useState(name)
  const [err, setErr] = useState('')
  useEffect(() => { api.project(name).then(setInfo).catch(e => setErr(errText(e))) }, [name])

  const rename = async () => {
    if (!to.trim() || to === name) return
    try { const p = await api.renameProject(name, to.trim()); onChanged(name, p.name) } catch (e) { setErr(errText(e)) }
  }
  const forget = async () => {
    if (!confirm(`Forget project ${name}? This deletes its sessions, decisions, events, project memories and overrides from claudethecaller. Files on disk are untouched.`)) return
    try { await api.deleteProject(name); onChanged(name, null) } catch (e) { setErr(errText(e)) }
  }
  return (
    <div className="menu">
      {info && <div className="mono">{info.path}<br />{info.decisions} decisions · {info.memories} memories · {info.overrides} overrides
        {info.last_active && <><br />last active {fmtTime(info.last_active)}</>}</div>}
      <input value={to} aria-label="New project name" onChange={e => setTo(e.target.value)} onKeyDown={e => e.key === 'Enter' && rename()} />
      <div className="actions"><button className="btn" onClick={rename}>Rename</button><button className="btn danger" onClick={forget}>Forget</button></div>
      {err && <div className="err">{err}</div>}
    </div>
  )
}

/** Shared mode: the daemon answered 401, so ask for an API key and reload with it. */
function KeyPanel() {
  const [k, setK] = useState('')
  const save = () => { if (k.trim()) { setKey(k.trim()); location.reload() } }
  return (
    <div className="keypanel">
      <div className="card pad form">
        <div className="brand" style={{ padding: 0 }}>claudethecaller</div>
        <div className="card-title">Enter API key</div>
        <div className="card-sub">This daemon runs in shared mode. Create a key with <span className="mono">ctc keys new</span> or ask its owner.</div>
        <input type="password" autoFocus value={k} placeholder="ctc_…" aria-label="API key" onChange={e => setK(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()} />
        <div className="actions"><button className="btn" style={{ borderColor: 'var(--accent)' }} onClick={save}>Save and reload</button></div>
      </div>
    </div>
  )
}
