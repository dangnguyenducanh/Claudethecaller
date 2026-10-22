import { handle } from './mock'
import type {
  Activity, ApiKey, Capability, CapabilityDetail, CapabilityPatch, Decision, DedupPair, Diff, Health, HistoryFile, HistoryStatus,
  Job, Kind, Kpis, Memory, MemoryDetail, MemoryKind, MemoryPatch, MemoryWrite, Metric, NewCapability, NewMemory, Ok, Override,
  Project, ProjectDetail, Range, Run, RunDetail, RunStatus, RunTrigger, Session, SessionDetail, Source, StepLog, Timeline,
} from './types'

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public node_id: string | null = null) { // node_id: 422 invalid_graph
    super(message)
  }
}

/** One-line text for an error shown next to the action that caused it. */
export function errText(e: unknown, ctx: { ns?: string } = {}): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : String(e)
  if (e.code === 'read_only') return `Managed by plugin ${ctx.ns ?? ''}; use an override instead.`.replace('plugin ;', 'a plugin;')
  if (e.status === 409) return 'Name already exists.'
  if (e.status === 404) return 'Not found; it may have been deleted.'
  return e.message || `Request failed (${e.status}).`
}

// ponytail: mock data only while the daemon (PLAN.md B5) is unreachable, or with VITE_MOCK=1; delete with mock.ts once it runs.
const FORCE_MOCK = import.meta.env.VITE_MOCK === '1'
let mock = FORCE_MOCK
export const usingMock = () => mock
// ponytail: the mock has no runner, so run pages say this instead of showing sample runs.
export const NEED_DAEMON = 'The runner needs the daemon: start it with uv run ctc daemon start.'

// Shared mode: the dashboard sends the stored API key; a 401 asks App for one. Local mode never sees a 401.
export const getKey = () => { try { return localStorage.getItem('ctc-key') ?? '' } catch { return '' } }
export const setKey = (k: string) => { try { k ? localStorage.setItem('ctc-key', k) : localStorage.removeItem('ctc-key') } catch { /* private mode */ } }
let onUnauthorized: () => void = () => {}
export const setAuthListener = (cb: () => void) => { onUnauthorized = cb }
const unauthorized = (): never => {
  onUnauthorized()
  throw new ApiError(401, 'unauthorized', 'An API key is required.')
}

function fromMock<T>(method: string, path: string, body: unknown): T {
  mock = true
  if (import.meta.env.VITE_MOCK_MODE === 'shared' && !getKey()) unauthorized() // the mock plays shared mode too
  return handle(method, path, body) as T
}

// A write that times out may still have been applied by the daemon (a capability save writes a file, then re-indexes
// and embeds it: seconds, not ms). So once the daemon has answered, a failed write is an error, never a mock answer.
const lost = () => new ApiError(0, 'unreachable', 'The daemon did not answer in time; the change may still have been saved. Reload to check.')

async function req<T>(method: string, path: string, body?: unknown, prefix = '/api'): Promise<T> {
  if (FORCE_MOCK) return fromMock<T>(method, path, body)
  const write = method !== 'GET'
  let r: Response
  try {
    const key = getKey()
    r = await fetch(prefix + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(write ? 15000 : 1500),
    })
  } catch {
    if (write && !mock) throw lost()
    return fromMock<T>(method, path, body) // network error or timeout: daemon not running
  }
  const isJson = (r.headers.get('content-type') ?? '').includes('json')
  // The Vite dev proxy answers 5xx without JSON when nothing listens on :18310; the daemon always sends JSON errors.
  if (!r.ok && !isJson && r.status >= 500) {
    if (write && !mock) throw lost()
    return fromMock<T>(method, path, body)
  }
  mock = false
  if (r.status === 401) unauthorized()
  const data: unknown = isJson ? await r.json() : undefined
  if (!r.ok) {
    const err = (data as { error?: { code?: string; message?: string; node_id?: string } } | undefined)?.error
    throw new ApiError(r.status, err?.code ?? `http_${r.status}`, err?.message ?? r.statusText, err?.node_id ?? null)
  }
  return data as T
}

type Param = string | number | boolean | null | undefined
const qs = (o: Record<string, Param>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? '?' + s : ''
}
const seg = encodeURIComponent

/** Lists come back newest first, `limit` default 200 (max 500); pass the last row's id as `before` for the next page. */
export const PAGE = 200
export const CAP_MAX = 500
type Page = { limit?: number; before?: number | string }

export const api = {
  // Projects
  projects: () => req<Project[]>('GET', '/projects'),
  project: (name: string) => req<ProjectDetail>('GET', `/projects/${seg(name)}`),
  renameProject: (name: string, to: string) => req<Project>('PATCH', `/projects/${seg(name)}`, { name: to }),
  deleteProject: (name: string) => req<Ok>('DELETE', `/projects/${seg(name)}`),

  // Overview
  kpis: (range: Range, project: string | null) => req<Kpis>('GET', '/kpis' + qs({ range, project })),
  timeline: (range: Range, metric: Metric, project: string | null) => req<Timeline>('GET', '/timeline' + qs({ range, metric, project })),
  activity: (project: string | null) => req<Activity>('GET', '/activity' + qs({ project })),
  decisions: (o: { range: Range; project: string | null; q?: string; session_id?: string; followed?: boolean; abstained?: boolean; source?: Source } & Page) =>
    req<Decision[]>('GET', '/decisions' + qs(o)),
  decision: (id: number) => req<Decision>('GET', `/decisions/${id}`),
  deleteDecision: (id: number) => req<Ok>('DELETE', `/decisions/${id}`),

  // Capabilities
  // No `before` paging on this list (PLAN.md): ask for the max; a full page means more exist (narrow with q/kind).
  capabilities: (o: { project: string | null; q?: string; kind?: Kind; namespace?: string; override?: Override; limit?: number }) =>
    req<Capability[]>('GET', '/capabilities' + qs({ limit: CAP_MAX, ...o })),
  capability: (id: string, project: string | null) => req<CapabilityDetail>('GET', `/capabilities/${seg(id)}` + qs({ project })),
  createCapability: (body: NewCapability) => req<Capability>('POST', '/capabilities', body),
  updateCapability: (id: string, patch: CapabilityPatch) => req<Capability>('PATCH', `/capabilities/${seg(id)}`, patch),
  deleteCapability: (id: string) => req<Ok>('DELETE', `/capabilities/${seg(id)}`),
  enrich: (id: string) => req<{ job_id: string }>('POST', `/capabilities/${seg(id)}/enrich`), // A1: summary + triggers from the LLM
  setOverride: (id: string, project: string | null, action: Override | null) =>
    req<Capability>('PUT', `/capabilities/${seg(id)}/override`, { project, action }),
  dedup: (status: DedupPair['status'] = 'open') => req<DedupPair[]>('GET', '/dedup' + qs({ status })),
  resolveDedup: (id: number, action: 'merge' | 'keep_apart') => req<Ok>('POST', `/dedup/${id}`, { action }),

  // Sessions
  sessions: (o: { project: string | null; q?: string; range?: Range; source?: Source } & Page) => req<Session[]>('GET', '/sessions' + qs(o)),
  session: (id: string) => req<SessionDetail>('GET', `/sessions/${seg(id)}`),
  deleteSession: (id: string) => req<Ok>('DELETE', `/sessions/${seg(id)}`),

  // Memories
  memories: (o: { project: string | null; q?: string; kind?: MemoryKind; scope?: Memory['scope']; pinned?: boolean; include_deleted?: boolean; limit?: number }) =>
    req<Memory[]>('GET', '/memories' + qs(o)),
  memory: (id: string) => req<MemoryDetail>('GET', `/memories/${seg(id)}`),
  createMemory: (body: NewMemory) => req<MemoryWrite>('POST', '/memories', body),
  updateMemory: (id: string, patch: MemoryPatch) => req<Memory>('PATCH', `/memories/${seg(id)}`, patch),
  deleteMemory: (id: string) => req<Ok>('DELETE', `/memories/${seg(id)}`),
  restoreMemory: (id: string) => req<Memory>('POST', `/memories/${seg(id)}/restore`),
  importMemories: () => req<{ job_id: string }>('POST', '/memories/import', {}), // Claude's own memory files, read-only
  backfillMemories: (sessions: number) => req<{ job_id: string }>('POST', '/memories/backfill', { sessions }), // A3 over recent transcripts

  // Health (outside /api, unversioned dashboard routes don't apply: it is the machine-facing /v1 route)
  health: () => req<Health>('GET', '/health', undefined, '/v1'),

  // Keys (shared mode only; 404 in local mode)
  keys: () => req<ApiKey[]>('GET', '/keys'),
  createKey: (name: string) => req<ApiKey>('POST', '/keys', { name }),
  revokeKey: (id: number) => req<Ok>('DELETE', `/keys/${id}`),

  // Index + jobs
  reindex: (project: string | null) => req<{ job_id: string }>('POST', '/index', { project }),
  jobs: (o: { status?: Job['status']; kind?: string; limit?: number } = {}) => req<Job[]>('GET', '/jobs' + qs(o)),
  job: (id: string) => req<Job>('GET', `/jobs/${seg(id)}`),

  // Claude history import (B9): scan ~/.claude/projects read-only, then distill pending sessions with the local LLM
  history: () => req<HistoryStatus>('GET', '/history'),
  importHistory: (o: { process?: boolean; projects?: string[] } = {}) => req<{ job_id: string }>('POST', '/history/import', o),
  historyFiles: (status?: string) => req<HistoryFile[]>('GET', '/history/files' + qs({ status })),
  // Workflow runs (PLAN.md "Workflow runner (m5)" → API; M1 endpoints). The daemon only: the mock has no runs.
  startRun: (capId: string, body: { input?: string; project?: string; trigger?: RunTrigger }) => req<{ run_id: number }>('POST', `/workflows/${seg(capId)}/runs`, body),
  runs: (o: { workflow?: string; status?: RunStatus; trigger?: RunTrigger } & Page = {}) => req<Run[]>('GET', '/runs' + qs(o)),
  run: (id: number) => req<RunDetail>('GET', `/runs/${id}`),
  stepLog: (id: number, sid: number, offset: number) => req<StepLog>('GET', `/runs/${id}/steps/${sid}/log` + qs({ offset })),
  stepDiff: (id: number, sid: number) => req<Diff>('GET', `/runs/${id}/steps/${sid}/diff`),
  runDiff: (id: number) => req<Diff>('GET', `/runs/${id}/diff`),
  cancelRun: (id: number) => req<Run>('POST', `/runs/${id}/cancel`),
}
