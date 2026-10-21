// Shapes of the daemon's /api/* responses, field for field with PLAN.md "API design → Dashboard + CRUD".
// ponytail: hand-written until B5 runs; then `pnpm gen:types` writes src/api-types.ts from /openapi.json and replaces this file.
export type Range = '7d' | '30d' | '90d' | 'all'
export type Metric = 'calls' | 'adoption' | 'latency'
export type Kind = 'skill' | 'agent' | 'command' | 'workflow'
export type Override = 'pin' | 'block' | 'disable'
export type MemoryKind = 'preference' | 'convention' | 'fact' | 'skill_outcome'
export type Ok = { ok: true }

export interface Project { id: string; name: string; sessions: number }
export interface ProjectDetail extends Project { path: string; decisions: number; memories: number; overrides: number; last_active: string | null }

export interface Kpis {
  routing_calls: number
  adoption_rate: number // 0..1, followed / non-abstained
  lazy_misses: number // non-abstained − followed
  p95_ms: number
  delta: Record<'routing_calls' | 'adoption_rate' | 'lazy_misses' | 'p95_ms', number | null> // vs previous window; null for range=all
  spark: Record<'routing_calls' | 'adoption_rate' | 'lazy_misses' | 'p95_ms', number[]>
}

export interface Timeline { days: string[]; series: { project: string; values: number[] }[] }

export interface Step { order: number; cap_id: string; invoke: string; kind: Kind; agent: string | null; reason: string }
export interface StageRow { cap_id: string; dense_rank: number | null; sparse_rank: number | null; rrf: number; rerank: number | null; dropped: string | null }
export interface Decision {
  id: number; at: string; session_id: string; project: string; prompt: string
  abstained: boolean; followed: boolean; latency_ms: number
  difficulty: string; model_tier: string; confidence: number
  steps: Step[]; stages: StageRow[]
}

export interface Activity {
  days: { day: string; count: number }[] // last 84 days, oldest first
  active_days: number; streak: number; longest_streak: number
  busiest: { day: string; count: number }; per_active_day: number
}

export interface Capability {
  id: string; kind: Kind; namespace: string; description: string
  override: Override | null; calls_30d: number; followed_30d: number; cluster_id: string | null
}
export interface CapabilityDetail extends Capability {
  name: string; invoke: string; path: string; body: string; summary: string | null; triggers: string[]
  editable: boolean; vectors: number; cluster_members: string[]; recent_decisions: Decision[]
  steps?: WorkflowStep[] | null // workflows only (null otherwise)
}
export interface WorkflowStep { cap: string; agent?: string | null } // the daemon reads `agent: null` back
export interface NewCapability {
  kind: Kind; scope: 'user' | 'project'; project?: string; name: string; description: string; body?: string; steps?: WorkflowStep[]
}
export type CapabilityPatch = { description?: string; body?: string; steps?: WorkflowStep[] }
export interface DedupPair { id: number; a: string; b: string; similarity: number; status: 'open' | 'merged' | 'kept_apart' }

export interface Session {
  id: string; project: string; title: string; model: string; started_at: string
  turns: number; tokens: number; decisions: number; followed: number; memories: number
}
// Contract says `Session + {decisions: Decision[], memories: Memory[]}`; those names clash with Session's counts, so the arrays win here.
export type SessionDetail = Omit<Session, 'decisions' | 'memories'> & { decisions: Decision[]; memories: Memory[] }

export interface Memory {
  id: string; scope: 'global' | 'project'; project: string | null; kind: MemoryKind
  text: string; confidence: number; pinned: boolean; use_count: number
  updated_at: string; source: string; supersedes: string | null
  deleted_at?: string | null // not in PLAN's field list yet; needed to show "Restore" when include_deleted=true
}
export interface MemoryDetail extends Memory { history: Memory[] }
export interface NewMemory { scope: 'global' | 'project'; project?: string; kind: MemoryKind; text: string; pinned?: boolean }
export type MemoryPatch = Partial<Pick<Memory, 'text' | 'pinned' | 'kind' | 'scope'>>
export interface MemoryWrite { action: 'ADD' | 'UPDATE' | 'NOOP'; memory: Memory }

export interface Job {
  id: string; kind: string; status: 'queued' | 'running' | 'done' | 'failed'; progress: number
  result: Record<string, unknown> | null; error: string | null; created_at: string
}
export interface IndexResult { added: number; changed: number; removed: number; vectors: number; embedded: number; library_version: string }

export type Svc = 'ok' | 'down'
export interface Health { db: Svc; redis: Svc; embedder: Svc; reranker: Svc; llm: Svc; library_version: string; mode: 'local' | 'shared' }
export interface ApiKey { id: number; name: string; created_at: string; revoked_at: string | null; key?: string } // key only on create, shown once
export interface NewApiKey { name: string }
