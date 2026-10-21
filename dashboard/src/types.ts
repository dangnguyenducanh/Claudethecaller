// Shapes of the daemon's /api/* responses (PLAN.md B5). The mock in mock.ts returns the same shapes.
export type Range = '7d' | '30d' | '90d' | 'all'
export type Metric = 'calls' | 'adoption' | 'latency'
export type Kind = 'skill' | 'agent' | 'command' | 'workflow'
export type Override = 'pin' | 'block' | 'disable'

export interface Project { id: string; name: string; sessions: number }

export interface Kpis {
  routing_calls: number
  adoption_rate: number // 0..1, followed / suggested
  lazy_misses: number // suggested but not followed
  p95_ms: number
  delta: Record<'routing_calls' | 'adoption_rate' | 'lazy_misses' | 'p95_ms', number | null> // vs previous period, fraction
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

export interface Session {
  id: string; project: string; title: string; model: string; started_at: string
  turns: number; tokens: number; decisions: number; followed: number; memories: number
}

export interface Memory {
  id: string; scope: 'global' | 'project'; project: string | null
  kind: 'preference' | 'convention' | 'fact' | 'skill_outcome'
  text: string; confidence: number; pinned: boolean; use_count: number
  updated_at: string; source: string; supersedes: string | null
}
