import { useEffect, useState } from 'react'
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts'
import { PAGE, api, errText } from './api'
import type { ViewProps } from './App'
import type { Activity, Decision, Kpis, Metric, Range, Timeline } from './types'
import { DecisionDetail, DecisionTable } from './parts'
import { Drawer, Header, Hexmap, KpiCard, Search, Segmented, colorOf, fmtDay, fmtInt, fmtMs, fmtPct } from './ui'

const RANGES = ['7d', '30d', '90d', 'all'] as const satisfies readonly Range[]
const METRICS = ['calls', 'adoption', 'latency'] as const satisfies readonly Metric[]
const RESULTS = { all: {}, followed: { followed: true }, ignored: { followed: false, abstained: false }, abstained: { abstained: true } } as const

export default function Overview({ project, range, setRange, projects, decisionId, onDecision }: ViewProps & { decisionId: number | null; onDecision: (id: number | null) => void }) {
  const [kpis, setKpis] = useState<Kpis | null>(null)
  const [metric, setMetric] = useState<Metric>('calls')
  const [tl, setTl] = useState<Timeline | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [result, setResult] = useState<keyof typeof RESULTS>('all')
  const [more, setMore] = useState(false)
  const [act, setAct] = useState<Activity | null>(null)
  const [open, setOpen] = useState<Decision | null>(null)
  const [linkErr, setLinkErr] = useState('')

  useEffect(() => { api.kpis(range, project).then(setKpis); api.activity(project).then(setAct) }, [range, project])
  useEffect(() => { api.timeline(range, metric, project).then(setTl) }, [range, metric, project])
  // The URL hash (#decision/<id>) is the source of truth for the drawer: rows set it, close clears it, pasted links open it.
  useEffect(() => {
    setLinkErr('')
    if (decisionId === null) return setOpen(null)
    setOpen(o => (o?.id === decisionId ? o : null))
    api.decision(decisionId).then(setOpen).catch(e => setLinkErr(errText(e)))
  }, [decisionId])
  const loadDecisions = (before?: number) =>
    api.decisions({ range, project, q, ...RESULTS[result], before }).then(rows => {
      setDecisions(ds => (before ? [...ds, ...rows] : rows))
      setMore(rows.length === PAGE)
    })
  useEffect(() => { loadDecisions() }, [range, project, q, result]) // eslint-disable-line react-hooks/exhaustive-deps

  const rows = tl ? tl.days.map((day, i) => ({ day, ...Object.fromEntries(tl.series.map(s => [s.project, s.values[i]])) })) : []
  const big = !kpis ? '—' : metric === 'calls' ? fmtInt(kpis.routing_calls) : metric === 'adoption' ? fmtPct(kpis.adoption_rate) : fmtMs(kpis.p95_ms)
  const metricLabel = { calls: 'Routing calls', adoption: 'Adoption (followed %)', latency: 'Route p95' }[metric]
  const toggle = (p: string) => setHidden(h => { const n = new Set(h); if (n.has(p)) n.delete(p); else n.add(p); return n })

  return (
    <>
      <Header crumb={project ?? 'All projects'} title={project ?? 'All projects'}
        sub={kpis ? `${fmtInt(kpis.routing_calls)} routed prompts, ${range === 'all' ? 'all time' : 'last ' + range}` : 'Loading…'}>
        <Segmented options={RANGES} value={range} onChange={setRange} />
      </Header>

      {kpis && (
        <div className="kpis">
          <KpiCard label="Routing calls" color="#7c8cff" value={fmtInt(kpis.routing_calls)} delta={kpis.delta.routing_calls} spark={kpis.spark.routing_calls} />
          <KpiCard label="Adoption" color="#3ddc97" value={fmtPct(kpis.adoption_rate)} delta={kpis.delta.adoption_rate} spark={kpis.spark.adoption_rate} />
          <KpiCard label="Lazy misses" color="#f59e42" value={fmtInt(kpis.lazy_misses)} delta={kpis.delta.lazy_misses} spark={kpis.spark.lazy_misses} lowerIsBetter />
          <KpiCard label="Route p95" color="#b38cff" value={fmtMs(kpis.p95_ms)} delta={kpis.delta.p95_ms} spark={kpis.spark.p95_ms} lowerIsBetter />
        </div>
      )}

      <div className="card pad">
        <div className="chart-head">
          <div>
            <div className="card-sub">{metricLabel}, {range === 'all' ? 'all time' : 'last ' + range}</div>
            <div className="big">{big}</div>
          </div>
          <Segmented options={METRICS} value={metric} onChange={setMetric} />
        </div>
        <div style={{ height: 300, marginTop: 8 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={rows} margin={{ top: 10, right: 16, left: 16, bottom: 0 }}>
              <defs>
                {projects.map(p => (
                  <linearGradient key={p} id={'g-' + p} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={colorOf(projects, p)} stopOpacity={0.9} />
                    <stop offset="100%" stopColor={colorOf(projects, p)} stopOpacity={0.25} />
                  </linearGradient>
                ))}
              </defs>
              <XAxis dataKey="day" padding={{ left: 12, right: 12 }} tickFormatter={fmtDay} interval="preserveStartEnd" minTickGap={40}
                tick={{ fill: 'var(--faint)', fontSize: 10, fontFamily: 'var(--mono)' }} axisLine={{ stroke: 'var(--line)' }} tickLine={false} />
              <Tooltip labelFormatter={l => fmtDay(String(l))}
                contentStyle={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, fontSize: 12 }} />
              {tl?.series.filter(s => !hidden.has(s.project)).map(s => (
                <Area key={s.project} type="monotone" dataKey={s.project} stackId={metric === 'calls' ? 'a' : undefined}
                  stroke={colorOf(projects, s.project)} strokeWidth={1.4}
                  fill={metric === 'calls' ? `url(#g-${s.project})` : 'transparent'} isAnimationActive={false} />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="chips">
          {tl?.series.map(s => (
            <button key={s.project} className={'chip' + (hidden.has(s.project) ? ' off' : '')} onClick={() => toggle(s.project)}>
              <span className="dot" style={{ background: colorOf(projects, s.project) }} />{s.project}<span className="x">×</span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid2">
        <div className="card">
          <div className="pad chart-head">
            <div className="card-title">Decisions <span className="faint mono">{decisions.length}</span></div>
            <div className="toolbar">
              {(Object.keys(RESULTS) as (keyof typeof RESULTS)[]).map(r => (
                <button key={r} className={'chip' + (r === result ? ' on' : '')} onClick={() => setResult(r)}>{r}</button>
              ))}
              <Search value={q} onChange={setQ} placeholder="Search prompts or skills" />
            </div>
          </div>
          <div className="tablewrap">
            <DecisionTable rows={decisions} projects={projects} onOpen={d => onDecision(d.id)} />
            {!decisions.length && <div className="empty">No decisions match.</div>}
            {more && <button className="btn more" onClick={() => loadDecisions(decisions[decisions.length - 1].id)}>Load more</button>}
          </div>
        </div>

        {act && (
          <div className="card pad">
            <div className="card-title">Activity</div>
            <div className="card-sub">Routed prompts per day, last 12 weeks</div>
            <Hexmap days={act.days} />
            <div className="stats">
              <div className="stat"><div className="card-sub">✦ Active days</div><div className="v">{act.active_days}</div><div className="card-sub"><span className="up">{Math.round((act.active_days / 84) * 100)}%</span> of the last 84 days</div></div>
              <div className="stat"><div className="card-sub">◆ Streak</div><div className="v">{act.streak} days</div><div className="card-sub">longest {act.longest_streak} days</div></div>
            </div>
            <div className="rows">
              <div className="row"><span className="muted">Busiest day</span><span className="mono">{fmtDay(act.busiest.day)} · {act.busiest.count} routes</span></div>
              <div className="row"><span className="muted">Per active day</span><span className="mono">{act.per_active_day}</span></div>
              <div className="row"><span className="muted">Adoption</span><span className="mono">{kpis ? fmtPct(kpis.adoption_rate) : '—'}</span></div>
            </div>
          </div>
        )}
      </div>

      {open && (
        <Drawer onClose={() => onDecision(null)}>
          <DecisionDetail d={open} onDeleted={id => { setDecisions(ds => ds.filter(x => x.id !== id)); onDecision(null) }} />
        </Drawer>
      )}
      {linkErr && !open && <Drawer onClose={() => onDecision(null)}><div className="err">Decision #{decisionId}: {linkErr}</div></Drawer>}
    </>
  )
}
