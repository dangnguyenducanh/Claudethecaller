/**
 * Gates and continue of the F4 runner (D16, D20): `approveStep` answers a waiting approval (or setup) step with one of its options, and
 * `continueRun` puts a `quota` or `waiting` run back to work. Called from: `apps/web/src/runs/workflows.ts` (the approve and continue routes) and
 * `apps/worker/src/runner/engine.ts` (the tick resumes a quota run whose reset time has passed). Why: both are status writes of steps and runs, so
 * they live next to `transitionStep` and go through it. Deliberately NOT done: I/O beyond the `port`, enqueueing a resumed step (the caller
 * does), the walker. Untrusted: the option id and the ids a route passes. Errors are `RunnerError`; a repository error passes through.
 */
import type { Ctx } from '@ctc/shared/repositories';
import { RunnerError, isCurrentAttempt, transitionStep, type RunnerPort } from './index.ts';

/** The default option id of an approval node; answering with it cancels the run (D16d). */
export const REJECT_OPTION = 'reject';

type Step = NonNullable<Awaited<ReturnType<RunnerPort['getStep']>>>;
type Run = NonNullable<Awaited<ReturnType<RunnerPort['getRun']>>>;
const isConflict = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === 'conflict';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The ids of a step's `options` list. */
export function optionIds(options: unknown): string[] {
  return Array.isArray(options) ? options.flatMap((o) => (isObj(o) && typeof o['id'] === 'string' ? [o['id']] : [])) : [];
}

/** A fan-out row only waits for its children (D17b): it has children, or its output has the fan-out shape. */
export function isBookkeeping(step: Step, steps: readonly Step[]): boolean {
  const o = isObj(step.output) ? step.output : {};
  return steps.some((s) => s.parentStepId === step.id) || (Array.isArray(o['items']) && typeof o['total'] === 'number');
}

/**
 * `waiting → done` with `resolution = optionId`. Not visible `not_found`; not the current attempt `stale_attempt`; an option the step does not
 * have, another resolution of a done step, or any status but `waiting` is `conflict`. The same answer twice is `applied: false`.
 */
export async function approveStep(
  port: RunnerPort, ctx: Ctx, o: { stepId: number; optionId: string },
): Promise<{ step: Step; applied: boolean }> {
  const step = await port.getStep(ctx, o.stepId);
  if (step === null) throw new RunnerError('not_found', 'step not found');
  if (!isCurrentAttempt(step, await port.listSteps(ctx, step.runId))) throw new RunnerError('stale_attempt', 'a newer attempt exists');
  if (!optionIds(step.options).includes(o.optionId)) throw new RunnerError('conflict', 'unknown option');
  const settled = (now: Step): { step: Step; applied: false } => {
    if (now.status === 'done' && now.resolution === o.optionId) return { step: now, applied: false };
    throw new RunnerError('conflict', now.status === 'done' ? 'step was answered with another option' : 'step is not waiting');
  };
  if (step.status !== 'waiting') return settled(step);
  const prior = isObj(step.output) ? step.output : {};
  try {
    const next = await transitionStep(port, ctx, {
      stepId: step.id, from: 'waiting', to: 'done',
      patch: { resolution: o.optionId, output: { ...prior, outcome: 'done', summary: o.optionId, choice: o.optionId }, endedAt: new Date() },
    });
    return { step: next, applied: true };
  } catch (e) {
    if (!isConflict(e)) throw e;
    return settled((await port.getStep(ctx, step.id)) ?? step);
  }
}

/**
 * Run `done`/`failed`/`cancelled`: `conflict`. `queued`/`running`: no-op. `quota`: the run goes to `running` first (a second running run of the
 * owner is `conflict`, nothing else changes), then every current `quota` step goes to `queued` with `error`, `stage` and `pid` cleared (the attempt starts its stages again). `waiting`: `conflict`
 * while a step waits for an answer or is `start_unknown`, else the run goes to `running`.
 */
export async function continueRun(
  port: RunnerPort, ctx: Ctx, o: { runId: number },
): Promise<{ run: Run; resumed: Step[] }> {
  let run = await port.getRun(ctx, o.runId);
  if (run === null) throw new RunnerError('not_found', 'run not found');
  if (['done', 'failed', 'cancelled'].includes(run.status)) throw new RunnerError('conflict', 'run is finished');
  if (run.status === 'queued' || run.status === 'running') return { run, resumed: [] };
  const steps = await port.listSteps(ctx, run.id);
  const current = steps.filter((s) => isCurrentAttempt(s, steps));
  if (run.status === 'waiting') {
    if (current.some((s) => s.status === 'waiting' && !isBookkeeping(s, steps))) throw new RunnerError('conflict', 'run has an open gate');
    if (current.some((s) => s.status === 'start_unknown')) throw new RunnerError('conflict', 'run has a start_unknown step');
  }
  try {
    run = await port.setRunStatus(ctx, run.id, { from: run.status, to: 'running' });
  } catch (e) {
    if (!isConflict(e)) throw e;
    throw new RunnerError('conflict', 'owner already has a running run');
  }
  const resumed: Step[] = [];
  for (const s of current.filter((c) => c.status === 'quota')) {
    try {
      resumed.push(await transitionStep(port, ctx, { stepId: s.id, from: 'quota', to: 'queued', patch: { error: null, stage: null, pid: null, pidStartedAt: null } }));
    } catch (e) {
      if (!isConflict(e)) throw e;
    }
  }
  return { run, resumed };
}
