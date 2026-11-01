/**
 * The one run-status write of the engine (D6a, D13d): `writeRunStatus` moves a run to the status the walker derived and saves the walker state.
 * Called from: ./engine.ts (end of every `advanceRun`). Why: "every status write goes through one place" is only checkable if the writes live in
 * one file; the T6.2 cold path has its own `parkRun` (waiting, quota) and the T6.1 core has `cancelRun`. Deliberately NOT done: any other
 * decision (what the status is), step writes, a status change away from a final run.
 */
import type { Ctx, Repositories } from '@ctc/shared/repositories';
import { isConflict, type Run } from './types.ts';

const FINAL = ['done', 'failed', 'cancelled'];

/**
 * `from` is read from the run, so a repeat is a no-op. A run that is final, gone, or already in `to` with an empty `patch` is left alone. A
 * `ConflictError` is re-read once; when the status did not move, the conflict is the owner's one-running-run index and the run stays as it is.
 * Returns the stored run, or `null` when it is not visible.
 */
export async function writeRunStatus(
  port: Pick<Repositories['runner'], 'getRun' | 'setRunStatus'>, ctx: Ctx, runId: number, to: string, patch: Record<string, unknown> = {},
): Promise<Run | null> {
  let run = await port.getRun(ctx, runId);
  for (let tries = 0; tries < 2 && run !== null; tries++) {
    if (FINAL.includes(run.status)) return run;
    if (run.status === to && Object.keys(patch).length === 0) return run;
    try {
      return await port.setRunStatus(ctx, runId, { from: run.status, to, patch });
    } catch (e) {
      if (!isConflict(e)) throw e;
      const again = await port.getRun(ctx, runId);
      if (again === null || again.status === run.status) return again;
      run = again;
    }
  }
  return run;
}
