import { useEffect, type ReactNode } from 'react'
import { Area, AreaChart, ResponsiveContainer } from 'recharts'
import { usingMock } from './api'

export const PALETTE = ['#7c8cff', '#3ddc97', '#f59e42', '#ff6fae', '#b38cff', '#2dd4bf', '#facc15']
// Sidebar projects keep their slot; any other name (mock data, a project created after the sidebar loaded) gets the
// next free slot instead of all falling onto slot 0. ponytail: 7 colours, so the 8th project repeats the 1st.
const extra: string[] = []
export const colorOf = (projects: string[], p: string) => {
  const i = projects.indexOf(p)
  if (i >= 0) return PALETTE[i % PALETTE.length]
  if (!extra.includes(p)) extra.push(p)
  return PALETTE[(projects.length + extra.indexOf(p)) % PALETTE.length]
}

export const fmtInt = (n: number) => n.toLocaleString('en-US')
export const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`
export const fmtMs = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${n.toFixed(0)} ms`)
export const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n))
export const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })

export function Segmented<T extends string>({ options, value, onChange }: { options: readonly T[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map(o => (
        <button key={o} className={o === value ? 'on' : ''} onClick={() => onChange(o)}>
          {(o[0].toUpperCase() + o.slice(1)).replace('_', ' ')}
        </button>
      ))}
    </div>
  )
}

export function Search({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="search">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} />
    </label>
  )
}

export function Sparkline({ data, color }: { data: number[]; color: string }) {
  const rows = data.map((v, i) => ({ i, v }))
  const gid = 'sp' + color.slice(1)
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={rows} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.6} fill={`url(#${gid})`} isAnimationActive={false}
          style={{ filter: `drop-shadow(0 0 6px ${color}88)` }} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

export function KpiCard({ label, color, value, delta, spark, lowerIsBetter }: {
  label: string; color: string; value: string; delta: number | null; spark: number[]; lowerIsBetter?: boolean
}) {
  const good = delta === null ? null : lowerIsBetter ? delta <= 0 : delta >= 0
  return (
    <div className="card kpi">
      <div className="label"><span className="dot" style={{ background: color }} />{label}</div>
      <div className="value">
        {value}
        {delta !== null && Number.isFinite(delta) && (
          <span className={'delta ' + (good ? 'up' : 'down')}>{delta >= 0 ? '↑' : '↓'}{Math.abs(delta * 100).toFixed(0)}%</span>
        )}
      </div>
      <div className="vs">vs previous period</div>
      <div className="spark"><Sparkline data={spark} color={color} /></div>
    </div>
  )
}

const HEX = ['var(--hex-0)', '#3b2470', '#6a2c8f', '#a8327f', '#e0504f', '#f59e42', '#fcd34d']

export function Hexmap({ days }: { days: { day: string; count: number }[] }) {
  const max = Math.max(1, ...days.map(d => d.count))
  const level = (c: number) => (c === 0 ? 0 : Math.min(6, 1 + Math.floor((c / max) * 5.999)))
  // Pad the front so the first column starts on Monday.
  const lead = (new Date(days[0].day).getDay() + 6) % 7
  const cells = [...Array(lead).fill(null), ...days]
  return (
    <>
      <div className="hexwrap">
        <div className="hexdays">{['Mon', '', 'Wed', '', 'Fri', '', ''].map((d, i) => <span key={i}>{d}</span>)}</div>
        <div className="hexgrid">
          {cells.map((d, i) => (
            <div key={i} className={'hex' + ((i % 7) % 2 ? ' odd' : '')} title={d ? `${d.day}: ${d.count} routes` : ''}
              style={{ background: d ? HEX[level(d.count)] : 'transparent' }} />
          ))}
        </div>
      </div>
      <div className="legend">Less {HEX.slice(1).map(c => <span key={c} className="hex" style={{ background: c }} />)} More</div>
    </>
  )
}

export function Drawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true">
        <button className="iconbtn" style={{ alignSelf: 'flex-end' }} onClick={onClose} aria-label="Close">✕</button>
        {children}
      </aside>
    </>
  )
}

export function Header({ crumb, title, sub, children }: { crumb: string; title: string; sub: string; children?: ReactNode }) {
  return (
    <div className="head">
      <div>
        <div className="crumb">Board / <b>{crumb}</b></div>
        <h1>{title}</h1>
        <div className="card-sub">{sub}</div>
      </div>
      <div className="head-actions">
        {usingMock() && <span className="pill mock" title="The daemon's /api is not running; showing sample data">mock data</span>}
        {children}
      </div>
    </div>
  )
}
