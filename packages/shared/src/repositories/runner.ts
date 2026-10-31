/**
 * Workflow runs, steps and schedules of one user. Called from the runner worker (T6.1 walker) and the web routes through `repos.runner`.
 * Steps have no `user_id`: every step statement joins `wf_runs` and filters `wf_runs.user_id` (D11).
 * Deliberately NOT done: the retry rule (`failure_count < 3`) and the walker (T6.1); this module only offers `insertStep` and `transition`.
 */
import { sql } from 'kysely';
import type { Ctx } from './ctx.ts';
import { changed, first, jsonb, pick, rows, setList, type Cols, type Db } from './db.ts';
import { ConflictError, RepoError } from './errors.ts';
import { keyset, type Page } from './page.ts';

export type Run = {
  id: number; userId: string; owner: string; workflowCapId: string | null; workflowVersion: number; status: string; state: unknown;
  trigger: string; inputs: unknown; repo: string | null; baseBranch: string | null; createdAt: Date; startedAt: Date | null; endedAt: Date | null;
};
export type Step = {
  id: number; runId: number; nodeId: string; visit: number; attempt: number; retryOfStepId: number | null; failureCount: number; parentStepId: number | null;
  status: string; stage: string | null; liveness: string | null; pid: number | null; pidStartedAt: Date | null; tokenHash: string | null; worktree: string | null;
  branch: string | null; options: unknown; resolution: string | null; promptOutcome: string | null; output: unknown; usage: unknown; costUsd: number | null;
  error: string | null; logPath: string | null; startedAt: Date; endedAt: Date | null;
};
export type Schedule = { userId: string; owner: string; workflow: string; cron: string; input: string; enabled: boolean; lastFiredAt: Date | null };

export const RUN_COLS = sql.raw('r.id, r.user_id, r.owner, r.workflow_cap_id, r.workflow_version, r.status, r.state, r.trigger, r.inputs, r.repo, r.base_branch, r.created_at, r.started_at, r.ended_at');
export const STEP_COLS = sql.raw(
  's.id, s.run_id, s.node_id, s.visit, s.attempt, s.retry_of_step_id, s.failure_count, s.parent_step_id, s.status, s.stage, s.liveness, s.pid, s.pid_started_at, s.token_hash, s.worktree, s.branch, s.options, s.resolution, s.prompt_outcome, s.output, s.usage, s.cost_usd, s.error, s.log_path, s.started_at, s.ended_at',
);
const SCHEDULE_COLS = sql.raw('user_id, owner, workflow, cron, input, enabled, last_fired_at');

const RUN_STATUSES = ['queued', 'running', 'waiting', 'done', 'failed', 'cancelled', 'quota'];
const STEP_STATUSES = ['queued', 'running', 'waiting', 'done', 'failed', 'timeout', 'start_unknown', 'quota', 'skipped', 'cancelled', 'circuit_broken'];
const TRIGGERS = ['button', 'cli', 'api', 'schedule', 'mcp'];

const RUN_PATCH: Cols = {
  state: { col: 'state', type: 'jsonb' }, inputs: { col: 'inputs', type: 'jsonb' }, repo: { col: 'repo' }, baseBranch: { col: 'base_branch' },
  startedAt: { col: 'started_at', type: 'timestamptz' }, endedAt: { col: 'ended_at', type: 'timestamptz' },
};
/** Everything `insertStep` and `transition` may carry; `status` is set only by them. `setStepFields` takes the narrower `STEP_SET_FIELDS`. */
const STEP_FIELDS: Cols = {
  stage: { col: 'stage' }, liveness: { col: 'liveness' }, pid: { col: 'pid', type: 'int' }, pidStartedAt: { col: 'pid_started_at', type: 'timestamptz' },
  tokenHash: { col: 'token_hash' }, worktree: { col: 'worktree' }, branch: { col: 'branch' }, options: { col: 'options', type: 'jsonb' },
  resolution: { col: 'resolution' }, promptOutcome: { col: 'prompt_outcome' }, output: { col: 'output', type: 'jsonb' }, usage: { col: 'usage', type: 'jsonb' },
  costUsd: { col: 'cost_usd', type: 'real' }, error: { col: 'error' }, logPath: { col: 'log_path' }, failureCount: { col: 'failure_count', type: 'int' },
  startedAt: { col: 'started_at', type: 'timestamptz' }, endedAt: { col: 'ended_at', type: 'timestamptz' },
};
const STEP_SET_FIELDS: Cols = Object.fromEntries(Object.entries(STEP_FIELDS).filter(([name]) => !['failureCount', 'startedAt', 'endedAt'].includes(name)));
const ONE_RUNNING = 'wf_runs_one_running';

const isId = (v: unknown): boolean => Number.isSafeInteger(Number(v)) && v !== null && v !== '';

const oneOf = (list: string[], v: unknown, what: string): string => {
  if (typeof v !== 'string' || !list.includes(v)) throw new RepoError('invalid', `bad ${what}`);
  return v;
};

export const runnerRepo = (db: Db) => {
  const k = db.kysely;
  const stepOf = (ctx: Ctx, id: number) =>
    !isId(id) ? Promise.resolve(null) : first<Step>(k, sql`select ${STEP_COLS} from wf_steps s join wf_runs r on r.id = s.run_id where r.user_id = ${ctx.userId} and s.id = ${Number(id)}`);
  const getRun = (ctx: Ctx, id: number) => !isId(id) ? Promise.resolve(null) : first<Run>(k, sql`select ${RUN_COLS} from wf_runs r where r.user_id = ${ctx.userId} and r.id = ${Number(id)}`);
  return {
    /** A second `running` run for the same `owner` is a `ConflictError` (partial unique index). */
    async createRun(
      ctx: Ctx,
      run: { owner: string; workflowCapId?: string | null; workflowVersion?: number; status?: string; trigger: string; inputs?: unknown; repo?: string | null; baseBranch?: string | null; state?: unknown },
    ): Promise<Run> {
      if (typeof run?.owner !== 'string' || run.owner === '') throw new RepoError('invalid', 'owner required');
      const status = oneOf(RUN_STATUSES, run.status ?? 'queued', 'status');
      const trigger = oneOf(TRIGGERS, run.trigger, 'trigger');
      const cap = run.workflowCapId ?? null;
      try {
        const row = await first<Run>(
          k,
          sql`insert into wf_runs (user_id, owner, workflow_cap_id, workflow_version, status, trigger, inputs, state, repo, base_branch)
              select ${ctx.userId}, ${run.owner}, ${cap}::uuid, ${run.workflowVersion ?? 1}, ${status}, ${trigger}, ${jsonb(run.inputs ?? {})}, ${jsonb(run.state ?? {})}, ${run.repo ?? null}, ${run.baseBranch ?? null}
              where ${cap}::uuid is null or exists (select 1 from capabilities c where c.id = ${cap}::uuid and c.user_id = ${ctx.userId})
              returning ${sql.raw('id, user_id, owner, workflow_cap_id, workflow_version, status, state, trigger, inputs, repo, base_branch, created_at, started_at, ended_at')}`,
        );
        if (!row) throw new RepoError('not_found', 'workflow not found');
        return row;
      } catch (error) {
        const e = error as { code?: string; constraint?: string };
        if (e.code === '23505' && e.constraint === ONE_RUNNING) throw new ConflictError('owner already has a running run');
        throw error;
      }
    },
    getRun,
    async listRuns(ctx: Ctx, o: { limit?: number; cursor?: string } | null = {}): Promise<Page<Run>> {
      o ??= {};
      return keyset<Run>(k, sql`select ${RUN_COLS}, r.created_at as page_ts, r.id::text as page_id from wf_runs r where r.user_id = ${ctx.userId}`, o);
    },
    /** `update … where status = from`. No change: `not_found` when the run is not the user's, else `ConflictError`. */
    async setRunStatus(ctx: Ctx, id: number, o: { from: string; to: string; patch?: Record<string, unknown> }): Promise<Run> {
      const from = oneOf(RUN_STATUSES, o?.from, 'from');
      const to = oneOf(RUN_STATUSES, o?.to, 'to');
      const set = [sql`status = ${to}`, ...setList(o.patch, RUN_PATCH)];
      if (!isId(id)) throw new RepoError('not_found', 'run not found');
      try {
        const row = await first<Run>(
          k,
          sql`update wf_runs r set ${sql.join(set)} where r.user_id = ${ctx.userId} and r.id = ${Number(id)} and r.status = ${from} returning ${RUN_COLS}`,
        );
        if (row) return row;
      } catch (error) {
        const e = error as { code?: string; constraint?: string };
        if (e.code === '23505' && e.constraint === ONE_RUNNING) throw new ConflictError('owner already has a running run');
        throw error;
      }
      if (!(await getRun(ctx, id))) throw new RepoError('not_found', 'run not found');
      throw new ConflictError('run is not in the expected status');
    },
    /** A repeat of `(runId, nodeId, visit, attempt)` returns the existing row with `created: false`. */
    async insertStep(
      ctx: Ctx,
      step: { runId: number; nodeId: string; visit: number; attempt?: number; retryOfStepId?: number | null; parentStepId?: number | null; status: string } & Record<string, unknown>,
    ): Promise<{ step: Step; created: boolean }> {
      const status = oneOf(STEP_STATUSES, step?.status, 'status');
      const attempt = step.attempt ?? 1;
      const retry = step.retryOfStepId ?? null;
      const parent = step.parentStepId ?? null;
      const extra = pick(step, STEP_FIELDS);
      if (![step.runId, ...(retry === null ? [] : [retry]), ...(parent === null ? [] : [parent])].every(isId)) throw new RepoError('not_found', 'run or parent step not found');
      const cols = sql.join([sql`run_id, node_id, visit, attempt, retry_of_step_id, parent_step_id, status`, ...extra.map((e) => e.col)]);
      const vals = sql.join([sql`r.id, ${String(step.nodeId)}, ${Number(step.visit)}, ${attempt}, ${retry}::bigint, ${parent}::bigint, ${status}`, ...extra.map((e) => e.value)]);
      const owned = (id: unknown) => sql`(${id}::bigint is null or exists (select 1 from wf_steps s2 join wf_runs r2 on r2.id = s2.run_id where s2.id = ${id}::bigint and r2.user_id = ${ctx.userId}))`;
      const row = await first<{ id: number }>(
        k,
        sql`insert into wf_steps (${cols})
            select ${vals} from wf_runs r where r.id = ${Number(step.runId)} and r.user_id = ${ctx.userId} and ${owned(retry)} and ${owned(parent)}
            on conflict (run_id, node_id, visit, attempt) do nothing returning id`,
      );
      if (row) return { step: (await stepOf(ctx, row.id)) as Step, created: true };
      const existing = await first<Step>(
        k,
        sql`select ${STEP_COLS} from wf_steps s join wf_runs r on r.id = s.run_id
            where r.user_id = ${ctx.userId} and s.run_id = ${Number(step.runId)} and s.node_id = ${String(step.nodeId)} and s.visit = ${Number(step.visit)} and s.attempt = ${attempt}`,
      );
      if (!existing) throw new RepoError('not_found', 'run or parent step not found');
      return { step: existing, created: false };
    },
    getStep: stepOf,
    /** All attempts, oldest first. */
    async listSteps(ctx: Ctx, runId: number): Promise<Step[]> {
      if (!isId(runId)) return [];
      return rows<Step>(
        k,
        sql`select ${STEP_COLS} from wf_steps s join wf_runs r on r.id = s.run_id where r.user_id = ${ctx.userId} and s.run_id = ${Number(runId)} order by s.started_at, s.id`,
      );
    },
    /** `update wf_steps … where id = stepId and status = from`. No change: `not_found` when the step is not visible to the user, else `ConflictError`. */
    async transition(ctx: Ctx, o: { stepId: number; from: string; to: string; patch?: Record<string, unknown> }): Promise<Step> {
      const from = oneOf(STEP_STATUSES, o?.from, 'from');
      const to = oneOf(STEP_STATUSES, o?.to, 'to');
      const set = [sql`status = ${to}`, ...setList(o.patch, STEP_FIELDS)];
      if (!isId(o.stepId)) throw new RepoError('not_found', 'step not found');
      const row = await first<{ id: number }>(
        k,
        sql`update wf_steps s set ${sql.join(set)} from wf_runs r
            where s.id = ${Number(o.stepId)} and s.status = ${from} and r.id = s.run_id and r.user_id = ${ctx.userId} returning s.id`,
      );
      if (row) return (await stepOf(ctx, row.id)) as Step;
      if (!(await stepOf(ctx, o.stepId))) throw new RepoError('not_found', 'step not found');
      throw new ConflictError('step is not in the expected status');
    },
    /** Never touches `status`. An empty patch returns the current row. */
    async setStepFields(ctx: Ctx, stepId: number, patch: Record<string, unknown>): Promise<Step | null> {
      if (!isId(stepId)) return null;
      const set = setList(patch, STEP_SET_FIELDS);
      if (set.length === 0) return stepOf(ctx, stepId);
      const row = await first<{ id: number }>(
        k,
        sql`update wf_steps s set ${sql.join(set)} from wf_runs r where s.id = ${Number(stepId)} and r.id = s.run_id and r.user_id = ${ctx.userId} returning s.id`,
      );
      return row ? stepOf(ctx, row.id) : null;
    },
    async listSchedules(ctx: Ctx): Promise<Schedule[]> {
      return rows<Schedule>(k, sql`select ${SCHEDULE_COLS} from wf_schedules where user_id = ${ctx.userId} order by owner, workflow`);
    },
    async upsertSchedule(ctx: Ctx, s: { owner: string; workflow: string; cron: string; input?: string; enabled?: boolean }): Promise<Schedule> {
      for (const v of [s?.owner, s?.workflow, s?.cron]) if (typeof v !== 'string' || v === '') throw new RepoError('invalid', 'owner, workflow and cron required');
      const row = await first<Schedule>(
        k,
        sql`insert into wf_schedules (user_id, owner, workflow, cron, input, enabled)
            values (${ctx.userId}, ${s.owner}, ${s.workflow}, ${s.cron}, ${s.input ?? ''}, ${s.enabled ?? true})
            on conflict (user_id, owner, workflow) do update set cron = excluded.cron, input = excluded.input, enabled = excluded.enabled
            returning ${SCHEDULE_COLS}`,
      );
      return row as Schedule;
    },
    // judgment: wf_schedules has no id column, a schedule is identified by (owner, workflow).
    async deleteSchedule(ctx: Ctx, id: { owner: string; workflow: string }): Promise<number> {
      return changed(k, sql`delete from wf_schedules where user_id = ${ctx.userId} and owner = ${String(id?.owner)} and workflow = ${String(id?.workflow)}`);
    },
  };
};
