import { handle } from './mock'
import type { Activity, Capability, Decision, Kpis, Memory, Metric, Override, Project, Range, Session, Timeline } from './types'

// ponytail: falls back to mock data until the daemon (PLAN.md B5) serves /api; drop the fallback then.
let mock = false
export const usingMock = () => mock

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  try {
    const r = await fetch('/api' + path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(1500),
    })
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) throw new Error(String(r.status))
    mock = false
    return (await r.json()) as T
  } catch {
    mock = true
    return handle(method, path, body) as T
  }
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
