// Shapes of the daemon's /api/* responses, field for field with PLAN.md "API design → Dashboard + CRUD".
// ponytail: hand-written until B5 runs; then `pnpm gen:types` writes src/api-types.ts from /openapi.json and replaces this file.
export type Range = '7d' | '30d' | '90d' | 'all'
export type Metric = 'calls' | 'adoption' | 'latency'
export type Kind = 'skill' | 'agent' | 'command' | 'workflow'
export type Override = 'pin' | 'block' | 'disable'
export type MemoryKind = 'preference' | 'convention' | 'fact' | 'skill_outcome'
export type Ok = { ok: true }
export type Source = 'hook' | 'history' // live hooks vs imported Claude history (PLAN.md "History import design")

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

// The router's bundle step (PLAN.md `Step`); renamed here because `Step` is the workflow run step below.
export interface DecisionStep { order: number; cap_id: string; invoke: string; kind: Kind; agent: string | null; reason: string }
export interface StageRow { cap_id: string; dense_rank: number | null; sparse_rank: number | null; rrf: number; rerank: number | null; dropped: string | null }
export interface Decision {
  id: number; at: string; session_id: string; project: string; prompt: string
  abstained: boolean; followed: boolean; latency_ms: number
  difficulty: string; model_tier: string; confidence: number
  steps: DecisionStep[]; stages: StageRow[]
  source: Source // history rows store the distilled intent as `prompt`, never the raw text
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
  graph?: Graph | null; settings?: WorkflowSettings | null // workflows only (null otherwise)
}
export interface WorkflowStep { cap: string; agent?: string | null } // the daemon reads `agent: null` back
export interface NewCapability {
  kind: Kind; scope: 'user' | 'project'; project?: string; name: string; description: string; body?: string; steps?: WorkflowStep[]
  graph?: Graph; settings?: WorkflowSettings // workflows: `graph` replaces `steps`
}
export type CapabilityPatch = { description?: string; body?: string; steps?: WorkflowStep[]; graph?: Graph; settings?: WorkflowSettings }
export interface DedupPair { id: number; a: string; b: string; similarity: number; status: 'open' | 'merged' | 'kept_apart' }

export interface Session {
  id: string; project: string; title: string; model: string; started_at: string
  turns: number; tokens: number; decisions: number; followed: number; memories: number
  source: Source; summary: string | null; status: 'pending' | 'processed' | 'failed'; git_branch: string | null
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
export interface HistoryStatus { root: string; files: number; imported: number; pending: number; processed: number; failed: number; last_job: Job | null }
export interface HistoryFile { path: string; session_id: string | null; size: number; status: string; error: string | null; imported_at: string | null }
export interface IndexResult { added: number; changed: number; removed: number; vectors: number; embedded: number; library_version: string }

export type Svc = 'ok' | 'down'
export interface Health { db: Svc; redis: Svc; embedder: Svc; reranker: Svc; llm: Svc; library_version: string; mode: 'local' | 'shared' }
export interface ApiKey { id: number; name: string; created_at: string; revoked_at: string | null; key?: string } // key only on create, shown once
export interface NewApiKey { name: string }

// Workflow runner, PLAN.md "Workflow runner (m5)" → Workflow file and API. Merge arrives in M3.
export type NodeType = 'trigger' | 'agent' | 'shell' | 'if' | 'approval'
export interface WfNode {
  id: string; type: NodeType; pos: [number, number]; max_visits?: number
  input?: string // trigger
  prompt?: string; cap?: string; agent?: string; model?: string; effort?: string; permission_mode?: 'acceptEdits' | 'dontAsk' // agent
  allowed_tools?: string[]; mcp_config?: unknown; json_schema?: unknown; resume_from?: string; max_turns?: number; on_error?: 'fail' | 'continue'
  command?: string // shell
  timeout_s?: number; readonly?: boolean // agent and shell
  path?: string; op?: 'eq' | 'ne' | 'contains' | 'truthy'; value?: unknown // if
  message?: string // approval
}
export interface Graph { nodes: WfNode[]; edges: { from: string; to: string; handle?: 'true' | 'false' }[]; defaults?: { max_visits?: number } } // a run's snapshot carries `defaults`
export interface WorkflowSettings { permission: 'worktree'; allow_extra_usage: boolean; auto_resume: boolean; max_run_tokens: number | null }

export type RunStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled' | 'quota'
export type RunTrigger = 'button' | 'cli' | 'api' | 'schedule' | 'mcp'
export interface Run {
  id: number; workflow: string; project: string | null; status: RunStatus; trigger: RunTrigger; input: string
  branch: string | null; worktree: string | null; pr_url: string | null; error: string | null
  quota_resets_at: string | null; auto_resume: boolean; created_at: string; started_at: string | null; ended_at: string | null
  tokens: number; nodes_done: number; nodes_total: number
}
export interface DiffFile { path: string; added: number | null; deleted: number | null } // git numstat; null for binary files
export interface Step {
  id: number; node_id: string; visit: number; kind: string
  status: 'running' | 'waiting' | 'done' | 'failed' | 'timeout' | 'cancelled' | 'quota' | 'skipped'
  input: string | null; output: Record<string, unknown> | null; error: string | null
  session_id: string | null; num_turns: number | null; tokens: Record<string, number> | null; cost_usd: number | null // cost is notional
  permission_denials: unknown[] | null; overage: boolean | null; files: DiffFile[] | null; started_at: string; ended_at: string | null
}
export interface RunDetail extends Run { graph: Graph; file_sha: string; auth: { authMethod: string; email: string; claude_version: string } | null; steps: Step[] }
export interface StepLog { text: string; offset: number; done: boolean }
export interface Diff { diff: string; files: DiffFile[]; truncated: boolean }
