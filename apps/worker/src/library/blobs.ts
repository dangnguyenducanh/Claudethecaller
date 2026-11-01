/**
 * Weekly `cleanup.blobs` job: deletes the library blobs that no file of any version references (spec:427).
 * Called from: apps/worker main (`blobCleanupHandlers` into `startWorkers({ handlers })`, `startBlobCleanup` once).
 * Why: versions share blobs by hash and nothing else deletes them. Deliberately NOT done: SQL (repos.system.cleanup owns it, with the
 * table lock that keeps a concurrent createVersion safe), BullMQ repeatable jobs (they bypass the `jobs` row, so runAttempt would skip them).
 */
import { createSystemCtx, type Repositories } from '@ctc/shared/repositories';
import type { Handler } from '../jobs/index.ts';

type Log = (message: string, fields?: Record<string, unknown>) => void;
type Submit = (input: { queue: string; kind: string; payload: unknown; id?: string }) => Promise<unknown>;

/** Handler for `cleanup.blobs` (payload `{}`). Returns `{ deleted }`; errors propagate so the job framework retries. */
export function blobCleanupHandlers(deps: { repos: Repositories; log?: Log }): { 'cleanup.blobs': Handler } {
  const { repos, log } = deps;
  return {
    'cleanup.blobs': async () => {
      const deleted = await repos.system.cleanup.deleteUnreferencedBlobs(createSystemCtx('cleanup.blobs'));
      log?.('cleanup.blobs', { deleted });
      return { deleted };
    },
  };
}

/** `cleanup.blobs:<ISO week-year>-W<ISO week>` in UTC: one job id per ISO week, so a week's job runs at most once. */
export function blobCleanupJobId(now: Date): string {
  const thursday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  thursday.setUTCDate(thursday.getUTCDate() - ((thursday.getUTCDay() + 6) % 7) + 3);
  const year = thursday.getUTCFullYear();
  const week = 1 + Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / 604_800_000);
  return `cleanup.blobs:${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * Submits the weekly job at once and every `everyMs` (6 h by default: after a restart the week's job is still submitted within hours;
 * an existing `done` row with the same id is not claimed again). A failing submit is logged, never thrown. `close()` is idempotent.
 */
export function startBlobCleanup(opts: { submit: Submit; everyMs?: number; now?: () => Date; log?: Log }): { close(): void } {
  const { submit, everyMs = 21_600_000, now = () => new Date(), log } = opts;
  const tick = async (): Promise<void> => {
    try {
      await submit({ queue: 'cleanup', kind: 'blobs', payload: {}, id: blobCleanupJobId(now()) });
    } catch (e) {
      log?.('cleanup.blobs submit failed', { error: e instanceof Error ? e.constructor.name : typeof e });
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref();
  return { close: () => clearInterval(timer) };
}
