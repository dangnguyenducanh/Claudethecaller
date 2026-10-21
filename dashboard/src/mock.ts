import { ApiError } from './api'
import type {
  Activity, Capability, CapabilityDetail, Decision, DedupPair, Job, Kind, Kpis, Memory, MemoryDetail, MemoryKind,
  MemoryWrite, Project, ProjectDetail, Session, SessionDetail, StageRow, Step, Timeline, WorkflowStep,
} from './types'

// Deterministic fake backend with the exact shapes and rules of PLAN.md "API design → Dashboard + CRUD".
// ponytail: in-memory and per page load; delete once the daemon (B5) serves /api.
let seed = 20261021
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
const pick = <T,>(a: T[]): T => a[Math.floor(rand() * a.length)]
const DAY = 86_400_000
const now = new Date()
now.setHours(18, 0, 0, 0)
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10)
const hash8 = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0).toString(16).padStart(8, '0') }
const fail = (status: number, code: string, message: string): never => { throw new ApiError(status, code, message) }

// Names are the key everywhere; the backend suffixes ~2, ~3 on folder-name collisions, so the mock has one.
let projects: { name: string; path: string }[] = ['claudethecaller', 'storefront', 'billing-api', 'docs-site', 'infra', 'storefront~2']
  .map(name => ({ name, path: name === 'storefront~2' ? '~/work/client-b/storefront' : `~/code/${name}` }))
const nsOf = (project: string) => `project@${hash8(projects.find(p => p.name === project)?.path ?? project)}`

// ---- capabilities ----
type Cap = { id: string; kind: Kind; namespace: string; name: string; description: string; body: string; path: string; cluster_id: string | null; steps?: WorkflowStep[] }
const editable = (ns: string) => ns === 'user' || ns.startsWith('project@')
const invokeOf = (c: Cap) => (editable(c.namespace) ? c.name : c.id)
const rootOf = (ns: string, project?: string) => (ns === 'user' ? '~/.claude' : `${projects.find(p => p.name === project)?.path ?? '~/code/' + project}/.claude`)
const fileOf = (kind: Kind, name: string) => ({ skill: `skills/${name}/SKILL.md`, agent: `agents/${name}.md`, command: `commands/${name}.md`, workflow: `workflows/${name}.yaml` })[kind]
const bodyOf = (c: Pick<Cap, 'kind' | 'name' | 'description' | 'steps'>) => c.kind === 'workflow'
  ? `name: ${c.name}\ndescription: ${c.description}\nsteps:\n` + (c.steps ?? []).map(s => `  - cap: ${s.cap}` + (s.agent ? `\n    agent: ${s.agent}` : '')).join('\n')
  : `---\nname: ${c.name}\ndescription: ${c.description}\n---\n\n# ${c.name}\n\n${c.description}.\n\n## When to use\n\n- Use it when the task matches the description above.\n`
const SEED_CAPS: [string, Kind, string][] = [
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
  ['user:changelog', 'command', 'Draft a changelog entry from the last commits'],
  [`${nsOf('claudethecaller')}:release-checklist`, 'workflow', 'Changelog, version bump, tag and publish'],
]
let caps: Cap[] = SEED_CAPS.map(([id, kind, description]) => {
  const [namespace, name] = id.includes(':') ? [id.slice(0, id.lastIndexOf(':')), id.slice(id.lastIndexOf(':') + 1)] : [id, id]
  const steps = kind === 'workflow' ? (name === 'deploy-staging'
    ? [{ cap: 'ecc:build-error-resolver' }, { cap: 'ecc:database-reviewer', agent: 'ecc:database-reviewer' }, { cap: 'user:changelog' }]
    : [{ cap: 'user:changelog' }, { cap: 'ecc:code-review', agent: 'ecc:code-reviewer' }]) : undefined
  const path = editable(namespace) ? `${rootOf(namespace, 'claudethecaller')}/${fileOf(kind, name)}` : `~/.claude/plugins/cache/${namespace}/${fileOf(kind, name)}`
  const cap: Cap = { id, kind, namespace, name, description, path, cluster_id: null, steps, body: '' }
  cap.body = bodyOf(cap)
  return cap
})
const capById = (id: string) => caps.find(c => c.id === id) ?? fail(404, 'not_found', `no capability ${id}`)

// overrides keyed `${project | '*'}|${cap_id}`; a project row beats '*'.
const overrides = new Map<string, 'pin' | 'block' | 'disable'>([['*|ecc:python-review', 'disable'], ['*|ponytail:ponytail', 'pin']])
const overrideOf = (id: string, project: string | null) => (project && overrides.get(`${project}|${id}`)) || overrides.get(`*|${id}`) || null

let dedup: DedupPair[] = [
  { id: 1, a: 'ecc:code-review', b: 'ecc:code-reviewer', similarity: 0.94, status: 'merged' },
  { id: 2, a: 'ecc:tdd-workflow', b: 'superpowers:test-driven-development', similarity: 0.91, status: 'open' },
  { id: 3, a: 'ecc:plan', b: 'superpowers:writing-plans', similarity: 0.88, status: 'open' },
  { id: 4, a: 'superpowers:systematic-debugging', b: 'voltagent-qa-sec:debugger', similarity: 0.86, status: 'kept_apart' },
]
const applyMerge = (p: DedupPair) => { const cid = p.a < p.b ? p.a : p.b; for (const c of caps) if (c.id === p.a || c.id === p.b) c.cluster_id = cid }
dedup.filter(p => p.status === 'merged').forEach(applyMerge)

// ---- decisions + sessions ----
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
const makeSteps = (ids: string[]): Step[] => ids.map((id, i) => {
  const c = capById(id)
  return {
    order: i + 1, cap_id: id, invoke: invokeOf(c), kind: c.kind, agent: c.kind !== 'agent' && i === 0 && rand() < 0.4 ? 'ecc:code-reviewer' : null,
    reason: `rerank ${(0.55 + rand() * 0.4).toFixed(2)} · matched "${c.description.split(' ').slice(0, 4).join(' ').toLowerCase()}"`,
  }
})
const makeStages = (ids: string[]): StageRow[] => {
  const decoys = caps.map(c => c.id).filter(id => !ids.includes(id)).sort(() => rand() - 0.5).slice(0, 4)
  return [...ids, ...decoys].map((id, i) => ({
    cap_id: id, dense_rank: rand() < 0.9 ? i + 1 + Math.floor(rand() * 3) : null, sparse_rank: rand() < 0.7 ? i + 1 + Math.floor(rand() * 6) : null,
    rrf: +(0.033 - i * 0.002 - rand() * 0.001).toFixed(4),
    rerank: i < ids.length ? +(0.95 - i * 0.12 - rand() * 0.05).toFixed(2) : +(0.25 - i * 0.02).toFixed(2),
    dropped: i === ids.length + 1 ? 'blocked in this project' : i === ids.length + 2 ? 'same cluster as a better hit' : null,
  }))
}
let decisions: Decision[] = []
let sessions: Session[] = []
let nextId = 1
for (let d = 89; d >= 0; d--) {
  const day = now.getTime() - d * DAY
  const weekday = new Date(day).getDay()
  const busy = (weekday === 0 || weekday === 6 ? 0.35 : 1) * (0.5 + (89 - d) / 120)
  for (const [pi, { name: project }] of projects.entries()) {
    const n = Math.floor(rand() * 7 * busy * (1 - pi * 0.12))
    if (!n) continue
    const sid = `${hash8(project + day).slice(0, 8)}-${dayKey(day).replaceAll('-', '')}`
    let followed = 0
    for (let k = 0; k < n; k++) {
      const [prompt, ids] = pick(PROMPTS)
      const abstained = ids.length === 0
      const fol = !abstained && rand() < 0.35 + (89 - d) / 200
      followed += +fol
      decisions.push({
        id: nextId++, at: new Date(day - (n - k) * 1_500_000).toISOString(), session_id: sid, project, prompt, abstained, followed: fol,
        latency_ms: rand() < 0.45 ? +(2 + rand() * 7).toFixed(1) : +(70 + rand() * 90 + (rand() < 0.08 ? 120 : 0)).toFixed(1),
        difficulty: pick(['trivial', 'standard', 'standard', 'complex', 'critical']), model_tier: pick(['haiku', 'sonnet', 'sonnet', 'opus']),
        confidence: abstained ? 0.18 : +(0.6 + rand() * 0.35).toFixed(2), steps: abstained ? [] : makeSteps(ids), stages: makeStages(ids),
      })
    }
    const first = decisions[decisions.length - n]
    sessions.push({
      id: sid, project, title: first.prompt.slice(0, 80), model: pick(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']),
      started_at: first.at, turns: n + Math.floor(rand() * 12), tokens: Math.floor((n + 2) * (300_000 + rand() * 900_000)), decisions: n, followed, memories: 0,
    })
  }
}
decisions.reverse() // newest first, ids descending
sessions.reverse()

// ---- memories ----
const memText = (m: Memory) => `${m.id} (${m.text.slice(0, 40)})`
let memories: Memory[] = ([
  ['global', null, 'preference', 'Prefers the shortest working solution; no abstractions with one implementation.', 0.92, true, 41],
  ['global', null, 'preference', 'Tests come later; the owner guides testing. Do not add test suites unasked.', 0.85, false, 17],
  ['project', 'claudethecaller', 'fact', 'Database is the Supabase project claudethecaller (ap-southeast-1), schema ctc, via the IPv4 pooler.', 0.95, true, 23],
  ['project', 'claudethecaller', 'convention', 'Python 3.12 with uv, src/ layout, package ctc; dashboard is React + Vite in dashboard/.', 0.9, false, 12],
  ['project', 'claudethecaller', 'fact', 'Local models stay ≤ 3B and ≤ 7 GB GPU on the shared host.', 0.88, false, 9],
  ['project', 'storefront', 'skill_outcome', 'For flaky-test prompts, superpowers:systematic-debugging was followed 9 of 10 times.', 0.8, false, 14],
  ['project', 'storefront', 'convention', 'Checkout tests run against the Stripe test clock, never live keys.', 0.77, false, 6],
  ['project', 'billing-api', 'fact', 'Invoices are generated by a nightly job; never mutate posted invoices.', 0.83, false, 8],
  ['project', 'billing-api', 'skill_outcome', 'ecc:database-reviewer caught 3 missing indexes in migrations this month.', 0.72, false, 5],
  ['project', 'docs-site', 'convention', 'Docs are MDX; every page needs a description frontmatter field.', 0.7, false, 3],
  ['project', 'infra', 'fact', 'Staging deploys go through deploy-staging; prod needs a human approval.', 0.86, true, 11],
  ['global', null, 'skill_outcome', 'superpowers:brainstorming is skipped for one-line changes; suggest it only for new features.', 0.66, false, 4],
  ['project', 'claudethecaller', 'fact', 'Local models stay ≤ 3B and ≤ 10 GB GPU on the shared host.', 0.6, false, 2],
] as const).map(([scope, project, kind, text, confidence, pinned, use], i): Memory => ({
  id: `m${i + 1}`, scope, project, kind, text, confidence, pinned, use_count: use,
  updated_at: new Date(now.getTime() - i * 2.7 * DAY).toISOString(),
  source: i % 3 === 0 ? 'claude-memory · memory/MEMORY.md' : i === 4 ? 'manual' : `session ${sessions[i * 3]?.id ?? 'unknown'}`,
  supersedes: null, deleted_at: null,
}))
const old = memories[12] // the older GPU-budget note, superseded by m5
old.deleted_at = new Date(now.getTime() - 20 * DAY).toISOString()
memories[4].supersedes = memText(old)
for (const s of sessions) s.memories = memories.filter(m => m.source === `session ${s.id}`).length
const memById = (id: string) => memories.find(m => m.id === id) ?? fail(404, 'not_found', `no memory ${id}`)
const words = (t: string) => new Set(t.toLowerCase().match(/\w+/g) ?? [])
const overlap = (a: string, b: string) => { const A = words(a), B = words(b); return [...A].filter(w => B.has(w)).length / Math.max(1, Math.min(A.size, B.size)) }

// ---- jobs ----
const jobs = new Map<string, { kind: string; created: number; result: Record<string, unknown> }>()
const jobView = (id: string): Job => {
  const j = jobs.get(id) ?? fail(404, 'not_found', `no job ${id}`)
  const t = Date.now() - j.created
  const status = t < 600 ? 'queued' : t < 3000 ? 'running' : 'done'
  return { id, kind: j.kind, status, progress: status === 'done' ? 1 : status === 'queued' ? 0 : +((t - 600) / 2400).toFixed(2),
    result: status === 'done' ? j.result : null, error: null, created_at: new Date(j.created).toISOString() }
}

// ---- reads ----
const DAYS: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90, all: 90 }
const p95 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))] : 0)
const inRange = <T extends { at?: string; started_at?: string }>(rows: T[], days: number, offset = 0) => {
  const end = now.getTime() + DAY - offset * DAY
  return rows.filter(x => { const t = Date.parse(x.at ?? x.started_at ?? ''); return t <= end && t > end - days * DAY })
}
const stats = (ds: Decision[]) => {
  const sug = ds.filter(d => !d.abstained), fol = sug.filter(d => d.followed).length
  return { routing_calls: ds.length, adoption_rate: sug.length ? fol / sug.length : 0, lazy_misses: sug.length - fol, p95_ms: p95(ds.map(d => d.latency_ms)) }
}
const dayList = (days: number) => Array.from({ length: days }, (_, i) => dayKey(now.getTime() - (days - 1 - i) * DAY))
const ofProject = <T extends { project: string | null }>(rows: T[], project: string | null) => rows.filter(r => !project || r.project === project)
const match = (q: string, ...xs: (string | null | undefined)[]) => !q || xs.some(x => x?.toLowerCase().includes(q.toLowerCase()))
const bool = (v: string | null) => (v === null ? null : v === 'true')
const page = <T extends { id: number | string }>(rows: T[], p: URLSearchParams) => {
  const limit = Math.min(500, Number(p.get('limit') ?? 200))
  const before = p.get('before')
  // ponytail: string ids (sessions) page by position here; see the report about sortable keys.
  const start = before === null ? 0 : typeof rows[0]?.id === 'number' ? rows.findIndex(r => (r.id as number) < Number(before)) : rows.findIndex(r => String(r.id) === before) + 1
  return start < 0 ? [] : rows.slice(start, start + limit)
}

function kpis(range: string, project: string | null): Kpis {
  const days = DAYS[range] ?? 30, all = ofProject(decisions, project)
  const cur = stats(inRange(all, days)), prev = stats(inRange(all, days, days))
  const delta = (k: keyof typeof cur) => (range === 'all' || !prev[k] ? null : (cur[k] - prev[k]) / prev[k])
  const per = dayList(days).map(day => stats(all.filter(d => d.at.slice(0, 10) === day)))
  return {
    ...cur, delta: { routing_calls: delta('routing_calls'), adoption_rate: delta('adoption_rate'), lazy_misses: delta('lazy_misses'), p95_ms: delta('p95_ms') },
    spark: { routing_calls: per.map(s => s.routing_calls), adoption_rate: per.map(s => s.adoption_rate), lazy_misses: per.map(s => s.lazy_misses), p95_ms: per.map(s => s.p95_ms) },
  }
}
function timeline(range: string, metric: string, project: string | null): Timeline {
  const days = dayList(DAYS[range] ?? 30)
  return { days, series: projects.filter(p => !project || p.name === project).map(({ name }) => ({
    project: name,
    values: days.map(day => { const s = stats(decisions.filter(d => d.project === name && d.at.slice(0, 10) === day)); return metric === 'adoption' ? +(s.adoption_rate * 100).toFixed(1) : metric === 'latency' ? s.p95_ms : s.routing_calls }),
  })) }
}
function activity(project: string | null): Activity {
  const counts = new Map<string, number>()
  for (const d of ofProject(decisions, project)) counts.set(d.at.slice(0, 10), (counts.get(d.at.slice(0, 10)) ?? 0) + 1)
  const days = dayList(84).map(day => ({ day, count: counts.get(day) ?? 0 }))
  let streak = 0, longest = 0, run = 0
  for (const d of days) { run = d.count ? run + 1 : 0; longest = Math.max(longest, run) }
  for (let i = days.length - 1; i >= 0 && days[i].count; i--) streak++
  const active = days.filter(d => d.count)
  return { days, active_days: active.length, streak, longest_streak: longest, busiest: days.reduce((a, b) => (b.count > a.count ? b : a), days[0]),
    per_active_day: active.length ? +(active.reduce((s, d) => s + d.count, 0) / active.length).toFixed(1) : 0 }
}
function capRow(c: Cap, project: string | null): Capability {
  const used = inRange(decisions, 30).filter(d => d.steps.some(s => s.cap_id === c.id))
  return { id: c.id, kind: c.kind, namespace: c.namespace, description: c.description, override: overrideOf(c.id, project),
    calls_30d: used.length, followed_30d: used.filter(d => d.followed).length, cluster_id: c.cluster_id }
}
function capDetail(c: Cap, project: string | null): CapabilityDetail {
  return { ...capRow(c, project), name: c.name, invoke: invokeOf(c), path: c.path, body: c.body, summary: null, triggers: [],
    editable: editable(c.namespace), vectors: 1, cluster_members: c.cluster_id ? caps.filter(x => x.cluster_id === c.cluster_id && x.id !== c.id).map(x => x.id) : [],
    recent_decisions: decisions.filter(d => d.steps.some(s => s.cap_id === c.id)).slice(0, 20) }
}
function memDetail(m: Memory): MemoryDetail {
  const history: Memory[] = []
  for (let s = m.supersedes; s; ) { const prev = memories.find(x => x.id === s!.split(' ')[0]); if (!prev) break; history.push(prev); s = prev.supersedes }
  return { ...m, history }
}

// ---- writes ----
function createCap(b: { kind: Kind; scope: 'user' | 'project'; project?: string; name: string; description: string; body?: string; steps?: WorkflowStep[] }): Capability {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(b.name ?? '')) fail(422, 'invalid', 'name must match ^[a-z0-9][a-z0-9-]{0,63}$')
  if (b.scope === 'project' && !projects.some(p => p.name === b.project)) fail(422, 'invalid', 'project scope needs an existing project')
  const namespace = b.scope === 'user' ? 'user' : nsOf(b.project!)
  const id = `${namespace}:${b.name}`
  if (caps.some(c => c.id === id)) fail(409, 'conflict', `${id} already exists`)
  const cap: Cap = { id, kind: b.kind, namespace, name: b.name, description: b.description, steps: b.steps, cluster_id: null,
    path: `${rootOf(namespace, b.project)}/${fileOf(b.kind, b.name)}`, body: '' }
  cap.body = b.kind === 'workflow' ? bodyOf(cap) : b.body || bodyOf(cap)
  caps = [cap, ...caps]
  return capRow(cap, b.project ?? null)
}
function writeMemory(b: { scope: Memory['scope']; project?: string; kind: MemoryKind; text: string; pinned?: boolean }): MemoryWrite {
  const live = memories.filter(m => !m.deleted_at && m.scope === b.scope && (b.scope === 'global' || m.project === b.project))
  const same = live.find(m => m.text.trim().toLowerCase() === b.text.trim().toLowerCase())
  if (same) { same.use_count++; return { action: 'NOOP', memory: same } }
  const near = live.find(m => m.kind === b.kind && overlap(m.text, b.text) >= 0.6)
  if (near) { Object.assign(near, { text: b.text, confidence: Math.min(1, +(near.confidence + 0.1).toFixed(2)), updated_at: new Date().toISOString() }); return { action: 'UPDATE', memory: near } }
  const m: Memory = { id: `m${memories.length + 1}`, scope: b.scope, project: b.scope === 'project' ? b.project ?? null : null, kind: b.kind, text: b.text,
    confidence: 0.7, pinned: !!b.pinned, use_count: 0, updated_at: new Date().toISOString(), source: 'manual', supersedes: null, deleted_at: null }
  memories = [m, ...memories]
  return { action: 'ADD', memory: m }
}

export function handle(method: string, path: string, body: unknown): unknown {
  const url = new URL(path, 'http://mock')
  const p = url.searchParams
  const seg = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const project = p.get('project'), q = p.get('q') ?? '', range = p.get('range') ?? '30d'
  const b = (body ?? {}) as Record<string, unknown>
  const route = `${method} /${seg[0] ?? ''}${seg.length > 1 ? '/:id' : ''}${seg[2] ? '/' + seg[2] : ''}`
  const id = seg[1]

  switch (route) {
    case 'GET /projects': return projects.map(({ name }) => ({ id: hash8(name), name, sessions: sessions.filter(s => s.project === name).length })) satisfies Project[]
    case 'GET /projects/:id': {
      const pr = projects.find(x => x.name === id) ?? fail(404, 'not_found', `no project ${id}`)
      const ds = decisions.filter(d => d.project === id)
      return { id: hash8(id), name: id, sessions: sessions.filter(s => s.project === id).length, path: pr.path, decisions: ds.length,
        memories: memories.filter(m => m.project === id && !m.deleted_at).length, overrides: [...overrides.keys()].filter(k => k.startsWith(id + '|')).length,
        last_active: ds[0]?.at ?? null } satisfies ProjectDetail
    }
    case 'PATCH /projects/:id': {
      const pr = projects.find(x => x.name === id) ?? fail(404, 'not_found', `no project ${id}`)
      const to = String(b.name ?? '').trim()
      if (!to) fail(422, 'invalid', 'name is required')
      if (projects.some(x => x.name === to && x !== pr)) fail(409, 'conflict', `project ${to} already exists`)
      pr.name = to
      for (const rows of [decisions, sessions, memories] as { project: string | null }[][]) for (const r of rows) if (r.project === id) r.project = to
      for (const [k, v] of [...overrides]) if (k.startsWith(id + '|')) { overrides.delete(k); overrides.set(to + k.slice(id.length), v) }
      return { id: hash8(to), name: to, sessions: sessions.filter(s => s.project === to).length } satisfies Project
    }
    case 'DELETE /projects/:id': {
      if (!projects.some(x => x.name === id)) fail(404, 'not_found', `no project ${id}`)
      projects = projects.filter(x => x.name !== id)
      decisions = decisions.filter(d => d.project !== id)
      sessions = sessions.filter(s => s.project !== id)
      memories = memories.filter(m => m.project !== id)
      for (const k of [...overrides.keys()]) if (k.startsWith(id + '|')) overrides.delete(k)
      return { ok: true }
    }

    case 'GET /kpis': return kpis(range, project)
    case 'GET /timeline': return timeline(range, p.get('metric') ?? 'calls', project)
    case 'GET /activity': return activity(project)
    case 'GET /decisions': {
      const followed = bool(p.get('followed')), abstained = bool(p.get('abstained')), sid = p.get('session_id')
      return page(inRange(ofProject(decisions, project), DAYS[range] ?? 30).filter(d =>
        (!sid || d.session_id === sid) && (followed === null || d.followed === followed) && (abstained === null || d.abstained === abstained) &&
        match(q, d.prompt, ...d.steps.map(s => s.cap_id))), p)
    }
    case 'GET /decisions/:id': return decisions.find(d => d.id === Number(id)) ?? fail(404, 'not_found', `no decision ${id}`)
    case 'DELETE /decisions/:id': {
      if (!decisions.some(d => d.id === Number(id))) fail(404, 'not_found', `no decision ${id}`)
      decisions = decisions.filter(d => d.id !== Number(id))
      return { ok: true }
    }

    case 'GET /capabilities': {
      const kind = p.get('kind'), ns = p.get('namespace'), ovr = p.get('override')
      return caps.filter(c => (!kind || c.kind === kind) && (!ns || c.namespace === ns) && match(q, c.id, c.description))
        .map(c => capRow(c, project)).filter(c => !ovr || c.override === ovr).slice(0, Math.min(500, Number(p.get('limit') ?? 200)))
    }
    case 'GET /capabilities/:id': return capDetail(capById(id), project)
    case 'POST /capabilities': return createCap(b as never)
    case 'PATCH /capabilities/:id': {
      const c = capById(id)
      if (!editable(c.namespace)) fail(403, 'read_only', `managed by plugin ${c.namespace}; use an override`)
      if (typeof b.description === 'string') c.description = b.description
      if (Array.isArray(b.steps)) c.steps = b.steps as WorkflowStep[]
      c.body = typeof b.body === 'string' && c.kind !== 'workflow' ? b.body : bodyOf(c)
      return capRow(c, null)
    }
    case 'DELETE /capabilities/:id': {
      const c = capById(id)
      if (!editable(c.namespace)) fail(403, 'read_only', `managed by plugin ${c.namespace}; use an override`)
      caps = caps.filter(x => x !== c)
      return { ok: true }
    }
    case 'PUT /capabilities/:id/override': {
      const c = capById(id), key = `${(b.project as string | null) ?? '*'}|${id}`
      if (b.action) overrides.set(key, b.action as 'pin'); else overrides.delete(key)
      return capRow(c, (b.project as string | null) ?? null)
    }
    case 'GET /dedup': return dedup.filter(x => x.status === (p.get('status') ?? 'open'))
    case 'POST /dedup/:id': {
      const pair = dedup.find(x => x.id === Number(id)) ?? fail(404, 'not_found', `no pair ${id}`)
      pair.status = b.action === 'merge' ? 'merged' : 'kept_apart'
      if (pair.status === 'merged') applyMerge(pair)
      return { ok: true }
    }

    case 'GET /sessions': return page(sessions.filter(s => (!project || s.project === project) && match(q, s.title, s.model) && (!p.get('range') || inRange([s], DAYS[range]).length)), p)
    case 'GET /sessions/:id': {
      const s = sessions.find(x => x.id === id) ?? fail(404, 'not_found', `no session ${id}`)
      return { ...s, decisions: decisions.filter(d => d.session_id === id), memories: memories.filter(m => m.source === `session ${id}`) } satisfies SessionDetail
    }
    case 'DELETE /sessions/:id': {
      if (!sessions.some(s => s.id === id)) fail(404, 'not_found', `no session ${id}`)
      sessions = sessions.filter(s => s.id !== id)
      decisions = decisions.filter(d => d.session_id !== id) // memories stay; their source keeps the id as text
      return { ok: true }
    }

    case 'GET /memories': {
      const kind = p.get('kind'), scope = p.get('scope'), pinned = bool(p.get('pinned')), withDeleted = p.get('include_deleted') === 'true'
      return memories.filter(m => (!project || m.project === project || m.scope === 'global') && (withDeleted || !m.deleted_at) &&
        (!kind || m.kind === kind) && (!scope || m.scope === scope) && (pinned === null || m.pinned === pinned) && match(q, m.text, m.kind))
        .slice(0, Math.min(500, Number(p.get('limit') ?? 200)))
    }
    case 'GET /memories/:id': return memDetail(memById(id))
    case 'POST /memories': return writeMemory(b as never)
    case 'PATCH /memories/:id': {
      const m = memById(id)
      for (const k of ['text', 'pinned', 'kind', 'scope'] as const) if (b[k] !== undefined) Object.assign(m, { [k]: b[k] })
      if (m.scope === 'global') m.project = null
      m.updated_at = new Date().toISOString()
      return m
    }
    case 'DELETE /memories/:id': { memById(id).deleted_at = new Date().toISOString(); return { ok: true } }
    case 'POST /memories/:id/restore': { const m = memById(id); m.deleted_at = null; return m }

    case 'POST /index': {
      const jid = `job-${jobs.size + 1}`
      jobs.set(jid, { kind: 'index', created: Date.now(), result: { added: 2, changed: 5, removed: 0, vectors: caps.length, library_version: hash8(String(caps.length)) } })
      return { job_id: jid }
    }
    case 'GET /jobs': return [...jobs.keys()].reverse().map(jobView).filter(j => (!p.get('status') || j.status === p.get('status')) && (!p.get('kind') || j.kind === p.get('kind')))
    case 'GET /jobs/:id': return jobView(id)
  }
  return fail(404, 'not_found', `mock: no route for ${method} ${path}`)
}
