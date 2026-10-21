import { ApiError } from './api'
import type { Activity, Capability, Decision, Kind, Kpis, Memory, Override, Project, Session, StageRow, Step, Timeline } from './types'

// Deterministic fake data with the exact shapes of the daemon's /api responses (types.ts).
let seed = 20261021
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
const pick = <T,>(a: T[]): T => a[Math.floor(rand() * a.length)]
const DAY = 86_400_000
const now = new Date()
now.setHours(18, 0, 0, 0)
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10)

// Names are the key everywhere; the backend suffixes ~2, ~3 on folder-name collisions, so the mock has one.
const PROJECTS = ['claudethecaller', 'storefront', 'billing-api', 'docs-site', 'infra', 'storefront~2']

const CAPS: [string, Kind, string][] = [
  ['superpowers:systematic-debugging', 'skill', 'Find the root cause of a bug before proposing a fix'],
  ['superpowers:test-driven-development', 'skill', 'Write the failing test first, then the code'],
  ['superpowers:brainstorming', 'skill', 'Turn a rough idea into a design before building'],
  ['superpowers:writing-plans', 'skill', 'Write an implementation plan from a spec'],
  ['ecc:tdd-workflow', 'skill', 'Red-green-refactor loop with coverage targets'],
  ['dataviz', 'skill', 'Design charts and dashboards that read as one system'],
  ['graphify', 'skill', 'Build and query a code knowledge graph'],
  ['ponytail:ponytail', 'skill', 'Force the shortest working solution'],
  ['n8n-mcp-skills:n8n-workflow-patterns', 'skill', 'Proven n8n workflow architectures'],
  ['ecc:code-reviewer', 'agent', 'Review code for quality, security and maintainability'],
  ['ecc:python-reviewer', 'agent', 'Python review: idioms, types, security'],
  ['ecc:database-reviewer', 'agent', 'PostgreSQL schema and query review'],
  ['ecc:security-reviewer', 'agent', 'Find secrets, injection and OWASP issues'],
  ['ecc:build-error-resolver', 'agent', 'Fix build and type errors with minimal diffs'],
  ['voltagent-qa-sec:debugger', 'agent', 'Diagnose bugs from logs and stack traces'],
  ['voltagent-core-dev:frontend-developer', 'agent', 'Build React, Vue and Angular frontends'],
  ['voltagent-data-ai:postgres-pro', 'agent', 'Tune PostgreSQL performance'],
  ['ecc:plan', 'command', 'Plan a feature before writing code'],
  ['ecc:code-review', 'command', 'Review local changes or a pull request'],
  ['ecc:python-review', 'command', 'Run a Python code review'],
  ['user:deploy-staging', 'workflow', 'Build, migrate and deploy to staging'],
  ['project@3f2a9c1e:release-checklist', 'workflow', 'Changelog, version bump, tag and publish'],
]
const CAP = new Map(CAPS.map(([id, kind, d]) => [id, { kind, d }]))

const PROMPTS: [string, string[]][] = [
  ['fix the flaky checkout test', ['superpowers:systematic-debugging', 'superpowers:test-driven-development']],
  ['why does the webhook retry twice?', ['voltagent-qa-sec:debugger', 'superpowers:systematic-debugging']],
  ['add pagination to /orders', ['superpowers:writing-plans', 'ecc:tdd-workflow']],
  ['review my migration before I push', ['ecc:database-reviewer', 'ecc:code-review']],
  ['build a settings page', ['voltagent-core-dev:frontend-developer', 'superpowers:brainstorming']],
  ['the build fails with a type error', ['ecc:build-error-resolver']],
  ['make this report query faster', ['voltagent-data-ai:postgres-pro', 'ecc:database-reviewer']],
  ['plan the auth refactor', ['superpowers:brainstorming', 'superpowers:writing-plans', 'ecc:plan']],
  ['check this PR for leaked secrets', ['ecc:security-reviewer']],
  ['ship v0.4 to staging', ['user:deploy-staging']],
  ['cut the 1.2 release', ['project@3f2a9c1e:release-checklist']],
  ['chart weekly signups by plan', ['dataviz']],
  ['where is the retry logic?', ['graphify']],
  ['simplify this service, it is too big', ['ponytail:ponytail', 'ecc:code-reviewer']],
  ['viết test cho hàm tính thuế', ['superpowers:test-driven-development']],
  ['review the python ingestion module', ['ecc:python-reviewer', 'ecc:python-review']],
  ['automate the invoice email with n8n', ['n8n-mcp-skills:n8n-workflow-patterns']],
  ['rename this variable', []],
  ['what does this error message mean?', []],
  ['thanks, looks good', []],
]
const MODELS = ['Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5']

function makeSteps(caps: string[]): Step[] {
  return caps.map((c, i) => {
    const { kind } = CAP.get(c)!
    return {
      order: i + 1, cap_id: c, invoke: c.startsWith('user:') || c.startsWith('project@') ? c.split(':')[1] : c, kind,
      agent: kind === 'agent' ? null : i === 0 && rand() < 0.4 ? 'ecc:code-reviewer' : null,
      reason: `rerank ${(0.55 + rand() * 0.4).toFixed(2)} · matched "${CAP.get(c)!.d.split(' ').slice(0, 4).join(' ').toLowerCase()}"`,
    }
  })
}

function makeStages(caps: string[]): StageRow[] {
  const decoys = CAPS.map(c => c[0]).filter(c => !caps.includes(c)).sort(() => rand() - 0.5).slice(0, 4)
  return [...caps, ...decoys].map((c, i) => ({
    cap_id: c,
    dense_rank: rand() < 0.9 ? i + 1 + Math.floor(rand() * 3) : null,
    sparse_rank: rand() < 0.7 ? i + 1 + Math.floor(rand() * 6) : null,
    rrf: +(0.033 - i * 0.002 - rand() * 0.001).toFixed(4),
    rerank: i < caps.length ? +(0.95 - i * 0.12 - rand() * 0.05).toFixed(2) : +(0.25 - i * 0.02).toFixed(2),
    dropped: i === caps.length + 1 ? 'blocked in this project' : i === caps.length + 2 ? 'same cluster as a better hit' : null,
  }))
}

const decisions: Decision[] = []
const sessions: Session[] = []
let id = 1
for (let d = 89; d >= 0; d--) {
  const day = now.getTime() - d * DAY
  const weekday = new Date(day).getDay()
  const busy = (weekday === 0 || weekday === 6 ? 0.35 : 1) * (0.5 + (89 - d) / 120) // weekends quiet, busier lately
  for (const [pi, project] of PROJECTS.entries()) {
    const n = Math.floor(rand() * 7 * busy * (1 - pi * 0.12))
    if (!n) continue
    const sid = `s-${dayKey(day)}-${pi}`
    let followed = 0
    for (let k = 0; k < n; k++) {
      const [prompt, caps] = pick(PROMPTS)
      const abstained = caps.length === 0
      const fol = !abstained && rand() < 0.35 + (89 - d) / 200 // adoption climbs over the quarter
      followed += +fol
      const prefetch = rand() < 0.45
      decisions.push({
        id: id++, at: new Date(day - (n - k) * 1_500_000).toISOString(), session_id: sid, project, prompt,
        abstained, followed: fol, latency_ms: prefetch ? +(2 + rand() * 7).toFixed(1) : +(70 + rand() * 90 + (rand() < 0.08 ? 120 : 0)).toFixed(1),
        difficulty: pick(['trivial', 'standard', 'standard', 'complex', 'critical']), model_tier: pick(['haiku', 'sonnet', 'sonnet', 'opus']),
        confidence: abstained ? 0.18 : +(0.6 + rand() * 0.35).toFixed(2),
        steps: abstained ? [] : makeSteps(caps), stages: makeStages(caps),
      })
    }
    sessions.push({
      id: sid, project, title: decisions[decisions.length - n].prompt.replace(/^./, c => c.toUpperCase()), model: pick(MODELS),
      started_at: decisions[decisions.length - n].at, turns: n + Math.floor(rand() * 12), tokens: Math.floor((n + 2) * (300_000 + rand() * 900_000)),
      decisions: n, followed, memories: Math.floor(rand() * 3),
    })
  }
}
decisions.reverse()
sessions.reverse()

const overrides = new Map<string, Override>([['ecc:python-review', 'disable'], ['ponytail:ponytail', 'pin']])

let memories: Memory[] = [
  ['global', null, 'preference', 'Prefers the shortest working solution; no abstractions with one implementation.', 0.92, true, 41],
  ['global', null, 'preference', 'Tests come later; owner guides testing. Do not add test suites unasked.', 0.85, false, 17],
  ['project', 'claudethecaller', 'fact', 'Database is the Supabase project claudethecaller (ap-southeast-1), schema ctc, via the IPv4 pooler.', 0.95, true, 23],
  ['project', 'claudethecaller', 'convention', 'Python 3.12 with uv, src/ layout, package ctc; dashboard is React + Vite in dashboard/.', 0.9, false, 12],
  ['project', 'claudethecaller', 'fact', 'Local models stay ≤ 3B and ≤ 7 GB GPU on the shared host.', 0.88, false, 9],
  ['project', 'storefront', 'skill_outcome', 'For flaky-test prompts, superpowers:systematic-debugging was followed 9 of 10 times.', 0.8, false, 14],
  ['project', 'storefront', 'convention', 'Checkout tests run against the Stripe test clock, never live keys.', 0.77, false, 6],
  ['project', 'billing-api', 'fact', 'Invoices are generated by a nightly job; never mutate posted invoices.', 0.83, false, 8],
  ['project', 'billing-api', 'skill_outcome', 'ecc:database-reviewer caught 3 missing indexes in migrations this month.', 0.72, false, 5],
  ['project', 'docs-site', 'convention', 'Docs are MDX; every page needs a description frontmatter field.', 0.7, false, 3],
  ['project', 'infra', 'fact', 'Staging deploys go through user:deploy-staging; prod needs a human approval.', 0.86, true, 11],
  ['global', null, 'skill_outcome', 'superpowers:brainstorming is skipped for one-line changes; suggest it only for new features.', 0.66, false, 4],
].map(([scope, project, kind, text, confidence, pinned, use], i) => ({
  id: `m${i + 1}`, scope, project, kind, text, confidence, pinned, use_count: use,
  updated_at: new Date(now.getTime() - i * 2.7 * DAY).toISOString(),
  source: i % 3 === 0 ? 'claude-memory · memory/MEMORY.md' : `session s-${dayKey(now.getTime() - (i + 1) * DAY)}-0`, supersedes: i === 4 ? 'm0 (older GPU budget note)' : null,
} as Memory))

// ---- helpers ----
const DAYS: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90, all: 90 }
const p95 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))] : 0)
const inRange = (ds: Decision[], days: number, offset = 0) => {
  const end = now.getTime() + DAY - offset * DAY
  return ds.filter(x => { const t = Date.parse(x.at); return t <= end && t > end - days * DAY })
}
const byProject = (project: string | null) => decisions.filter(d => !project || d.project === project)
const stats = (ds: Decision[]) => {
  const sug = ds.filter(d => !d.abstained)
  const fol = sug.filter(d => d.followed).length
  return { routing_calls: ds.length, adoption_rate: sug.length ? fol / sug.length : 0, lazy_misses: sug.length - fol, p95_ms: p95(ds.map(d => d.latency_ms)) }
}
const dayList = (days: number) => Array.from({ length: days }, (_, i) => dayKey(now.getTime() - (days - 1 - i) * DAY))

function kpis(range: string, project: string | null): Kpis {
  const days = DAYS[range] ?? 30
  const all = byProject(project)
  const cur = stats(inRange(all, days)), prev = stats(inRange(all, days, days))
  const delta = (k: keyof typeof cur) => (prev[k] ? (cur[k] - prev[k]) / prev[k] : null)
  const per = dayList(days).map(day => stats(all.filter(d => d.at.slice(0, 10) === day)))
  return {
    ...cur,
    delta: { routing_calls: delta('routing_calls'), adoption_rate: delta('adoption_rate'), lazy_misses: delta('lazy_misses'), p95_ms: delta('p95_ms') },
    spark: { routing_calls: per.map(s => s.routing_calls), adoption_rate: per.map(s => s.adoption_rate), lazy_misses: per.map(s => s.lazy_misses), p95_ms: per.map(s => s.p95_ms) },
  }
}

function timeline(range: string, metric: string, project: string | null): Timeline {
  const days = dayList(DAYS[range] ?? 30)
  return {
    days,
    series: PROJECTS.filter(p => !project || p === project).map(p => ({
      project: p,
      values: days.map(day => {
        const s = stats(decisions.filter(d => d.project === p && d.at.slice(0, 10) === day))
        return metric === 'adoption' ? +(s.adoption_rate * 100).toFixed(1) : metric === 'latency' ? s.p95_ms : s.routing_calls
      }),
    })),
  }
}

function activity(project: string | null): Activity {
  const counts = new Map<string, number>()
  for (const d of byProject(project)) counts.set(d.at.slice(0, 10), (counts.get(d.at.slice(0, 10)) ?? 0) + 1)
  const days = dayList(84).map(day => ({ day, count: counts.get(day) ?? 0 }))
  let streak = 0, longest = 0, run = 0
  for (const d of days) { run = d.count ? run + 1 : 0; longest = Math.max(longest, run) }
  for (let i = days.length - 1; i >= 0 && days[i].count; i--) streak++
  const active = days.filter(d => d.count)
  const busiest = days.reduce((a, b) => (b.count > a.count ? b : a), days[0])
  return { days, active_days: active.length, streak, longest_streak: longest, busiest, per_active_day: active.length ? +(active.reduce((s, d) => s + d.count, 0) / active.length).toFixed(1) : 0 }
}

function capabilities(q: string): Capability[] {
  const recent = inRange(decisions, 30)
  return CAPS.filter(([cid, , desc]) => !q || (cid + ' ' + desc).toLowerCase().includes(q.toLowerCase())).map(([cid, kind, description]) => {
    const used = recent.filter(d => d.steps.some(s => s.cap_id === cid))
    return {
      id: cid, kind, namespace: cid.split(':')[0], description, override: overrides.get(cid) ?? null,
      calls_30d: used.length, followed_30d: used.filter(d => d.followed).length,
      cluster_id: cid === 'ecc:code-review' || cid === 'ecc:code-reviewer' ? 'review' : null,
    }
  })
}

const match = (q: string, ...xs: (string | null)[]) => !q || xs.some(x => x?.toLowerCase().includes(q.toLowerCase()))

export function handle(method: string, path: string, body: unknown): unknown {
  const url = new URL(path, 'http://mock')
  const p = url.searchParams
  const project = p.get('project'), q = p.get('q') ?? '', range = p.get('range') ?? '30d'
  const seg = url.pathname.split('/').filter(Boolean)
  if (method === 'GET') {
    switch (seg[0]) {
      case 'projects': return PROJECTS.map(name => ({ id: name, name, sessions: sessions.filter(s => s.project === name).length })) satisfies Project[]
      case 'kpis': return kpis(range, project)
      case 'timeline': return timeline(range, p.get('metric') ?? 'calls', project)
      case 'decisions': return inRange(byProject(project), DAYS[range] ?? 30).filter(d => match(q, d.prompt, ...d.steps.map(s => s.cap_id))).slice(0, 200)
      case 'activity': return activity(project)
      case 'capabilities': return capabilities(q)
      case 'sessions': return sessions.filter(s => (!project || s.project === project) && match(q, s.title, s.model)).slice(0, 200)
      case 'memories': return memories.filter(m => (!project || m.project === project || m.scope === 'global') && match(q, m.text, m.kind))
    }
  }
  if (method === 'PUT' && seg[0] === 'capabilities') {
    const cid = decodeURIComponent(seg[1]), action = (body as { action: Override | null }).action
    if (action) overrides.set(cid, action); else overrides.delete(cid)
    return capabilities('').find(c => c.id === cid)
  }
  if (seg[0] === 'memories' && method === 'PATCH') {
    memories = memories.map(m => (m.id === seg[1] ? { ...m, ...(body as object), updated_at: new Date().toISOString() } : m))
    return memories.find(m => m.id === seg[1])
  }
  if (seg[0] === 'memories' && method === 'DELETE') { memories = memories.filter(m => m.id !== seg[1]); return { ok: true } }
  throw new ApiError(404, 'not_found', `mock: no route for ${method} ${path}`)
}
