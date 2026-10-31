/**
 * The one run-status write of the runner cold path (D20): the run goes to `waiting` or `quota` when one of its steps parks.
 * Called from: ./follow.ts, ./index.ts. Why: spec:684 and spec:721 say the run follows a parked step; every other run status is the walker's (T6.3).
 * Deliberately NOT done: `running`, `done`, `failed`, `cancelled`; a run that is already final is never touched.
 */
import type { Ctx } from '@ctc/shared/repositories';
import type { RunnerExecDeps } from './types.ts';
import { isConflict } from './types.ts';

const MOVABLE = ['queued', 'running', 'waiting', 'quota'];

export async function parkRun(deps: RunnerExecDeps, ctx: Ctx, runId: number, to: 'waiting' | 'quota'): Promise<void> {
  const port = deps.repos.runner;
  for (let tries = 0; tries < 2; tries++) {
    const run = await port.getRun(ctx, runId);
    if (run === null || run.status === to || !MOVABLE.includes(run.status)) return;
    try {
      await port.setRunStatus(ctx, runId, { from: run.status, to });
      return;
    } catch (e) {
      if (!isConflict(e)) throw e;
    }
  }
}
