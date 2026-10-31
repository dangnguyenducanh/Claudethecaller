/**
 * Step lifecycle core of the F4 runner: the step transition table, the one `transitionStep` every status write goes through, attempts with
 * retry and circuit break, stages, the runner job id. Called from: `apps/web/src/runs` (retry, fail, cancel, report routes) and, later, the
 * T6.2 worker cold path and the T6.3 walker. Why: one place decides which status changes are legal and how a failed attempt is retried.
 * Deliberately NOT done: any I/O (every function calls only the `port` it is given; no `node:*` import, `@ctc/shared` only as types),
 * claiming attempts, killing processes, the walker and the run status derivation (T6.3), enqueueing a retried attempt (the route does).
 * Untrusted: every value a caller passes from a request; `ctx` is trusted. Errors: `RunnerError`, or a repository error unchanged.
 */
import type { Ctx, Repositories } from '@ctc/shared/repositories';

export type RunnerPort = Pick<
  Repositories['runner'],
  'getRun' | 'setRunStatus' | 'getStep' | 'listSteps' | 'insertStep' | 'transition' | 'setStepFields'
>;
type Step = NonNullable<Awaited<ReturnType<RunnerPort['getStep']>>>;
type Run = NonNullable<Awaited<ReturnType<RunnerPort['getRun']>>>;

export const STEP_STATUSES = [
  'queued', 'running', 'waiting', 'done', 'failed', 'timeout', 'start_unknown', 'quota', 'skipped', 'cancelled', 'circuit_broken',
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/** The "any non-final" of the cancel row (spec:636): `failed` and `timeout` are final records and only move on to `circuit_broken`. */
export const NON_FINAL: readonly StepStatus[] = Object.freeze(['queued', 'running', 'waiting', 'quota', 'start_unknown'] as const);

/** The 19 legal `from → to` pairs (spec:624-638); same-status moves are not in it. Deep-frozen. */
export const TRANSITIONS: Readonly<Record<StepStatus, readonly StepStatus[]>> = Object.freeze({
  queued: Object.freeze(['running', 'skipped', 'cancelled'] as const),
  running: Object.freeze(['done', 'waiting', 'failed', 'timeout', 'start_unknown', 'quota', 'cancelled'] as const),
  quota: Object.freeze(['queued', 'cancelled'] as const),
  waiting: Object.freeze(['done', 'cancelled'] as const),
  start_unknown: Object.freeze(['failed', 'cancelled', 'circuit_broken'] as const),
  failed: Object.freeze(['circuit_broken'] as const),
  timeout: Object.freeze(['circuit_broken'] as const),
  done: Object.freeze([] as const),
  skipped: Object.freeze([] as const),
  cancelled: Object.freeze([] as const),
  circuit_broken: Object.freeze([] as const),
});

/** Never throws: an unknown status name is `false`. */
export function canTransition(from: string, to: string): boolean {
  return Object.hasOwn(TRANSITIONS, from) && (TRANSITIONS[from as StepStatus] as readonly string[]).includes(to);
}

/** `code` is the web error code of the same name. */
export class RunnerError extends Error {
  readonly code: 'conflict' | 'stale_attempt' | 'not_found';
  constructor(code: 'conflict' | 'stale_attempt' | 'not_found', message: string) {
    super(message);
    this.name = 'RunnerError';
    this.code = code;
  }
}

/** spec:615 stage list, in order. */
export const STAGES = ['worktree', 'setup', 'spawn', 'stream', 'report'] as const;
export type Stage = (typeof STAGES)[number];

/** Forward only (skips allowed, same stage allowed); a backward move or an unknown name is `false`. `current` is `null` before the first stage. */
export function canEnterStage(current: string | null, next: string): boolean {
  const n = (STAGES as readonly string[]).indexOf(next);
  if (n < 0) return false;
  return current === null || n >= (STAGES as readonly string[]).indexOf(current);
}

/** Read at call time so a test can change it. `maxFailures = 3`: spec:640 and `runner.max_failures`. */
export const runnerLimits = { maxFailures: 3 };

/** Longest `error` text written by `failStep`; chosen by judgment, same number as the web `reasonMax` (D2). */
const ERROR_MAX = 2000;

/** The failure of this attempt is the `max`-th one: `failureCount` counts the failed attempts before it. */
export const isExhausted = (step: { failureCount: number }, max: number = runnerLimits.maxFailures): boolean => step.failureCount + 1 >= max;

type AttemptKey = { runId: number; nodeId: string; visit: number; attempt: number };
/** True when no step of `steps` has the same run, node and visit and a higher attempt. */
export const isCurrentAttempt = (step: AttemptKey, steps: readonly AttemptKey[]): boolean =>
  !steps.some((s) => s.runId === step.runId && s.nodeId === step.nodeId && s.visit === step.visit && s.attempt > step.attempt);

/** `run:<runId>:node:<nodeId>:visit:<visit>:attempt:<attempt>`; `%` and `:` in the node id are escaped so the id stays injective (D19). */
export const runnerJobId = (k: AttemptKey): string =>
  `run:${k.runId}:node:${k.nodeId.replaceAll('%', '%25').replaceAll(':', '%3A')}:visit:${k.visit}:attempt:${k.attempt}`;

const FINAL_RUN = ['done', 'failed', 'cancelled'];
const isConflict = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === 'conflict';

/**
 * The only status write of a step (spec:622): an illegal or unknown pair throws `RunnerError('conflict')` before any port call; otherwise
 * `port.transition` runs (its `ConflictError` when the row left `from`, and `not_found`, propagate).
 */
export async function transitionStep(
  port: RunnerPort, ctx: Ctx, o: { stepId: number; from: string; to: string; patch?: Record<string, unknown> },
): Promise<Step> {
  if (!canTransition(o.from, o.to)) throw new RunnerError('conflict', `illegal transition ${o.from} -> ${o.to}`);
  return port.transition(ctx, { stepId: o.stepId, from: o.from, to: o.to, ...(o.patch === undefined ? {} : { patch: o.patch }) });
}

/** Writes `stage` before the side effect of that stage. Only while `running`, only forward; no write otherwise. */
export async function advanceStage(port: RunnerPort, ctx: Ctx, step: Step, next: string): Promise<Step> {
  if (!canEnterStage(step.stage, next)) throw new RunnerError('conflict', `cannot enter stage ${next} from ${step.stage ?? 'none'}`);
  if (step.status !== 'running') throw new RunnerError('conflict', 'step is not running');
  const row = await port.setStepFields(ctx, step.id, { stage: next });
  if (row === null) throw new RunnerError('not_found', 'step not found');
  return row;
}

/** Run → `failed` unless it is already final. A concurrent change is re-read once; if the run is still not final it is tried once more. */
async function failRun(port: RunnerPort, ctx: Ctx, runId: number): Promise<void> {
  let run: Run | null = await port.getRun(ctx, runId);
  for (let tries = 0; tries < 2 && run !== null && !FINAL_RUN.includes(run.status); tries++) {
    try {
      await port.setRunStatus(ctx, runId, { from: run.status, to: 'failed', patch: { endedAt: new Date() } });
      return;
    } catch (e) {
      if (!isConflict(e)) throw e;
      run = await port.getRun(ctx, runId);
    }
  }
}

/** `<failed|timeout|start_unknown> → circuit_broken` and the run → `failed`. A concurrent move of the step is re-read and left alone. */
async function breakCircuit(port: RunnerPort, ctx: Ctx, step: Step): Promise<Step> {
  let broken: Step;
  try {
    broken = await transitionStep(port, ctx, { stepId: step.id, from: step.status, to: 'circuit_broken' });
  } catch (e) {
    if (!isConflict(e)) throw e;
    // judgment: another writer moved the step first; report what is stored instead of failing the caller.
    return (await port.getStep(ctx, step.id)) ?? step;
  }
  await failRun(port, ctx, step.runId);
  return broken;
}

/**
 * `running`/`start_unknown` → `failed` or `running` → `timeout` (error cut to 2,000, `endedAt` now), then `circuit_broken` and the run `failed`
 * when this was the `maxFailures`-th failure. Returns the final row. A `to` outside failed/timeout or an illegal pair throws `conflict`.
 */
export async function failStep(
  port: RunnerPort, ctx: Ctx, o: { step: Step; to: 'failed' | 'timeout'; error?: string; patch?: Record<string, unknown>; maxFailures?: number },
): Promise<Step> {
  if (o.to !== 'failed' && o.to !== 'timeout') throw new RunnerError('conflict', `cannot fail a step into ${String(o.to)}`);
  const patch = { ...o.patch, ...(o.error === undefined ? {} : { error: o.error.slice(0, ERROR_MAX) }), endedAt: new Date() };
  const failed = await transitionStep(port, ctx, { stepId: o.step.id, from: o.step.status, to: o.to, patch });
  return isExhausted(o.step, o.maxFailures) ? breakCircuit(port, ctx, failed) : failed;
}

const RETRYABLE = ['failed', 'timeout', 'start_unknown'];

/**
 * Inserts attempt n+1 as `queued` (D13c). Order of refusals: not visible `not_found`, not the current attempt `stale_attempt`, wrong status or
 * finished run `conflict`, exhausted: the step goes `circuit_broken`, the run `failed`, then `conflict`. `created: false` when a concurrent
 * retry inserted the attempt first. A `start_unknown` attempt is first made `failed` ("superseded by retry") so every older attempt is final.
 */
export async function retryStep(
  port: RunnerPort, ctx: Ctx, o: { stepId: number; maxFailures?: number },
): Promise<{ step: Step; created: boolean }> {
  const step = await port.getStep(ctx, o.stepId);
  if (step === null) throw new RunnerError('not_found', 'step not found');
  if (!isCurrentAttempt(step, await port.listSteps(ctx, step.runId))) throw new RunnerError('stale_attempt', 'a newer attempt exists');
  if (!RETRYABLE.includes(step.status)) throw new RunnerError('conflict', 'step is not retryable');
  const run = await port.getRun(ctx, step.runId);
  if (run === null) throw new RunnerError('not_found', 'run not found');
  if (FINAL_RUN.includes(run.status)) throw new RunnerError('conflict', 'run is finished');
  if (isExhausted(step, o.maxFailures)) {
    await breakCircuit(port, ctx, step);
    throw new RunnerError('conflict', 'retry limit reached');
  }
  if (step.status === 'start_unknown') {
    try {
      await transitionStep(port, ctx, { stepId: step.id, from: 'start_unknown', to: 'failed', patch: { error: 'superseded by retry', endedAt: new Date() } });
    } catch (e) {
      // judgment: a concurrent retry already superseded it; go on and let the unique attempt key make the insert a repeat.
      if (!isConflict(e) || (await port.getStep(ctx, step.id))?.status !== 'failed') throw e;
    }
  }
  return port.insertStep(ctx, {
    runId: step.runId, nodeId: step.nodeId, visit: step.visit, attempt: step.attempt + 1, retryOfStepId: step.id,
    failureCount: step.failureCount + 1, parentStepId: step.parentStepId, status: 'queued',
  });
}

/**
 * What the agent reported (D15). Not the current attempt `stale_attempt`; current but not `running` is `applied: false` with no write;
 * `done` → `running → done`; `failed` → `failStep`. Losing a race (`ConflictError`) re-reads and returns `applied: false`.
 */
export async function reportStep(
  port: RunnerPort, ctx: Ctx, o: { stepId: number; outcome: 'done' | 'failed'; summary?: string },
): Promise<{ applied: boolean; step: Step }> {
  const step = await port.getStep(ctx, o.stepId);
  if (step === null) throw new RunnerError('not_found', 'step not found');
  if (!isCurrentAttempt(step, await port.listSteps(ctx, step.runId))) throw new RunnerError('stale_attempt', 'a newer attempt exists');
  if (step.status !== 'running') return { applied: false, step };
  const output = { outcome: o.outcome, summary: o.summary ?? null };
  try {
    const next =
      o.outcome === 'done'
        ? await transitionStep(port, ctx, { stepId: step.id, from: 'running', to: 'done', patch: { stage: 'report', output, endedAt: new Date() } })
        : await failStep(port, ctx, { step, to: 'failed', error: o.summary ?? 'reported failed', patch: { stage: 'report', output } });
    return { applied: true, step: next };
  } catch (e) {
    if (!isConflict(e)) throw e;
    return { applied: false, step: (await port.getStep(ctx, step.id)) ?? step };
  }
}

/**
 * Moves every non-final step of the run, then the run, to `cancelled` (D17). A finished run is returned with `cancelled: 0` and no write.
 * Nothing is killed here; the worker stops on its next `transitionStep` conflict (T6.2).
 */
export async function cancelRun(port: RunnerPort, ctx: Ctx, runId: number): Promise<{ run: Run; cancelled: number }> {
  let run = await port.getRun(ctx, runId);
  if (run === null) throw new RunnerError('not_found', 'run not found');
  if (FINAL_RUN.includes(run.status)) return { run, cancelled: 0 };
  let cancelled = 0;
  for (const listed of await port.listSteps(ctx, runId)) {
    let step: Step | null = listed;
    for (let tries = 0; tries < 2 && step !== null && NON_FINAL.includes(step.status as StepStatus); tries++) {
      try {
        await transitionStep(port, ctx, { stepId: step.id, from: step.status, to: 'cancelled', patch: { endedAt: new Date() } });
        cancelled++;
        break;
      } catch (e) {
        if (!isConflict(e)) throw e;
        step = await port.getStep(ctx, step.id);
      }
    }
  }
  for (let tries = 0; tries < 2 && run !== null && !FINAL_RUN.includes(run.status); tries++) {
    try {
      run = await port.setRunStatus(ctx, runId, { from: run.status, to: 'cancelled', patch: { endedAt: new Date() } });
      break;
    } catch (e) {
      if (!isConflict(e)) throw e;
      run = await port.getRun(ctx, runId);
    }
  }
  if (run === null) throw new RunnerError('not_found', 'run not found');
  return { run, cancelled };
}

export {
  AGENTS, PERMISSIONS, agentArgv, buildPreamble, emptyStream, exitOutcome, parseRepoSetup, readStreamLine, runnerExecLimits, sweepAction, worktreeRecipe,
} from './exec.ts';
export type { AgentNode, StreamState, SweepProbe } from './exec.ts';
