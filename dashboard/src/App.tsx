import { useEffect, useState } from 'react'
import { api } from './api'
import Library from './Library'
import Memories from './Memories'
import Overview from './Overview'
import Sessions from './Sessions'
import type { Project, Range } from './types'
import { colorOf } from './ui'

const VIEWS = ['overview', 'library', 'sessions', 'memories'] as const
type View = (typeof VIEWS)[number]
export type ViewProps = { project: string | null; range: Range; setRange: (r: Range) => void; projects: string[] }

const ICONS: Record<View, string> = {
  overview: 'M3 13h4v8H3zM10 3h4v18h-4zM17 9h4v12h-4z',
  library: 'M4 4h6v16H4zM14 4h6v16h-6z',
  sessions: 'M4 6h16M4 12h16M4 18h10',
  memories: 'M12 3a6 6 0 0 0-6 6c0 2.4 1.3 3.7 2.5 4.8.8.7 1.5 1.6 1.5 2.7V18h4v-1.5c0-1.1.7-2 1.5-2.7C16.7 12.7 18 11.4 18 9a6 6 0 0 0-6-6zM10 21h4',
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

  useEffect(() => { api.projects().then(setProjects) }, [])
  useEffect(() => { location.hash = view }, [view])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem('ctc-theme', theme) } catch { /* private mode */ }
  }, [theme])

  const names = projects.map(p => p.name)
  const props: ViewProps = { project, range, setRange, projects: names }

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
            <button key={p.id} className={'navitem' + (project === p.name ? ' on' : '')} onClick={() => setProject(p.name)}>
              <span className="dot" style={{ background: colorOf(names, p.name) }} />
              {p.name}
              <span className="count">{p.sessions}</span>
            </button>
          ))}
        </div>
        <div className="side-foot">
          <div>Local board<br />{new Date().toISOString().slice(0, 10)}</div>
          <button className="iconbtn" aria-label="Toggle theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              {theme === 'dark'
                ? <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
                : <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>}
            </svg>
          </button>
        </div>
      </nav>
      <main className="main">
        {view === 'overview' && <Overview {...props} />}
        {view === 'library' && <Library {...props} />}
        {view === 'sessions' && <Sessions {...props} />}
        {view === 'memories' && <Memories {...props} />}
      </main>
    </div>
  )
}
