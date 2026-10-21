import { handle } from './mock'
import type { Activity, Capability, Decision, Kpis, Memory, Metric, Override, Project, Range, Session, Timeline } from './types'

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
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

function fromMock<T>(method: string, path: string, body: unknown): T {
  mock = true
  return handle(method, path, body) as T
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (FORCE_MOCK) return fromMock<T>(method, path, body)
  let r: Response
  try {
    r = await fetch('/api' + path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(1500),
    })
  } catch {
    return fromMock<T>(method, path, body) // network error or timeout: daemon not running
  }
  const isJson = (r.headers.get('content-type') ?? '').includes('json')
  // The Vite dev proxy answers 5xx without JSON when nothing listens on :18310; the daemon always sends JSON errors.
  if (!r.ok && !isJson && r.status >= 500) return fromMock<T>(method, path, body)
  mock = false
  const data: unknown = isJson ? await r.json() : undefined
  if (!r.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | undefined)?.error
    throw new ApiError(r.status, err?.code ?? `http_${r.status}`, err?.message ?? r.statusText)
  }
  return data as T
}

const qs = (o: Record<string, string | null | undefined>) =>
  '?' + new URLSearchParams(Object.entries(o).filter(([, v]) => v) as [string, string][]).toString()

export const api = {
  projects: () => req<Project[]>('GET', '/projects'),
  kpis: (range: Range, project: string | null) => req<Kpis>('GET', '/kpis' + qs({ range, project })),
  timeline: (range: Range, metric: Metric, project: string | null) => req<Timeline>('GET', '/timeline' + qs({ range, metric, project })),
  decisions: (range: Range, project: string | null, q: string) => req<Decision[]>('GET', '/decisions' + qs({ range, project, q })),
  activity: (project: string | null) => req<Activity>('GET', '/activity' + qs({ project })),
  capabilities: (project: string | null, q: string) => req<Capability[]>('GET', '/capabilities' + qs({ project, q })),
  setOverride: (id: string, project: string | null, action: Override | null) =>
    req<Capability>('PUT', `/capabilities/${encodeURIComponent(id)}/override`, { project, action }),
  sessions: (project: string | null, q: string) => req<Session[]>('GET', '/sessions' + qs({ project, q })),
  memories: (project: string | null, q: string) => req<Memory[]>('GET', '/memories' + qs({ project, q })),
  updateMemory: (id: string, patch: Partial<Pick<Memory, 'text' | 'pinned'>>) => req<Memory>('PATCH', `/memories/${id}`, patch),
  deleteMemory: (id: string) => req<{ ok: boolean }>('DELETE', `/memories/${id}`),
}
