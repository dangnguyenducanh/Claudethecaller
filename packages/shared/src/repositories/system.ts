/**
 * The only cross-user functions (D13). Called from auth (before a ctx exists), the worker poll loop (T1.4 binds
 * `(id) => repos.system.jobs.markRunning(sctx, id)`), the restart sweep and the cleanup queue.
 * Deliberately NOT done: anything that reads a user's content; every function here returns ids, states and counts.
 */
import { sql } from 'kysely';
import type { SystemCtx } from './ctx.ts';
import { changed, first, jsonb, rows, type Db } from './db.ts';
import { clampLimit } from './limits.ts';
import { JOB_COLS, type Job } from './jobs.ts';
import { RUN_COLS, STEP_COLS, type Run, type Step } from './runner.ts';

const STEP_WITH_USER = sql.raw('r.user_id as user_id');
const FINISHED_RUNS = sql.raw("('done', 'failed', 'cancelled')");

const days = (n: unknown, fallback: number): number => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : fallback);

export const systemRepo = (db: Db) => {
  const k = db.kysely;
  return {
    apiKeys: {
      /** Not-revoked keys only. */
      async findByHash(_sctx: SystemCtx, keyHash: string): Promise<{ id: number; userId: string } | null> {
        return first(k, sql<{ id: number; userId: string }>`select id, user_id from api_keys where key_hash = ${String(keyHash)} and revoked_at is null`);
      },
    },
    jobs: {
      /** Queued jobs of all users, oldest first. */
      async listQueued(_sctx: SystemCtx, limit: number): Promise<Job[]> {
        return rows<Job>(k, sql`select ${JOB_COLS} from jobs where status = 'queued' order by created_at, id limit ${clampLimit(limit)}`);
      },
      /** `true` when the job went `queued|failed|running` to `running` (attempts + 1); `false` for `done|dead` or no row. */
      async markRunning(_sctx: SystemCtx, id: string): Promise<boolean> {
        const r = await first(k, sql`update jobs set status = 'running', attempts = attempts + 1, updated_at = now() where id = ${String(id)} and status in ('queued', 'failed', 'running') returning id`);
        return r !== null;
      },
      // judgment: a job cancelled while its handler ran stays dead; a late result does not resurrect it.
      async markDone(_sctx: SystemCtx, id: string, result?: unknown): Promise<void> {
        await changed(k, sql`update jobs set status = 'done', progress = 1, result = ${jsonb(result ?? null)}, updated_at = now() where id = ${String(id)} and status <> 'dead'`);
      },
      async markFailed(_sctx: SystemCtx, id: string, error: string): Promise<void> {
        await changed(k, sql`update jobs set status = 'failed', error = ${String(error)}, updated_at = now() where id = ${String(id)} and status not in ('done', 'dead')`);
      },
      async markDead(_sctx: SystemCtx, id: string, error: string): Promise<void> {
        await changed(k, sql`update jobs set status = 'dead', error = ${String(error)}, updated_at = now() where id = ${String(id)} and status <> 'done'`);
      },
      /** Any status except `done` goes back to `queued`; `error` stays. */
      async markQueued(_sctx: SystemCtx, id: string): Promise<void> {
        await changed(k, sql`update jobs set status = 'queued', updated_at = now() where id = ${String(id)} and status <> 'done'`);
      },
      /** `progress` is clamped to 0..1; NaN is 0. */
      async setProgress(_sctx: SystemCtx, id: string, progress: number): Promise<void> {
        const p = Number.isFinite(progress) ? Math.min(Math.max(progress, 0), 1) : 0;
        await changed(k, sql`update jobs set progress = ${p}, updated_at = now() where id = ${String(id)}`);
      },
    },
    runner: {
      /** Restart sweep: steps in `running` of all users. */
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async listRunningSteps(_sctx: SystemCtx): Promise<Step[]> {
        return rows<Step>(k, sql`select ${STEP_COLS}, ${STEP_WITH_USER} from wf_steps s join wf_runs r on r.id = s.run_id where s.status = 'running' order by s.id`);
      },
      /** Engine tick: runs of all users that are not final (`queued`, `running`, `waiting`, `quota`), ordered by id. */
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async listActiveRuns(_sctx: SystemCtx): Promise<Run[]> {
        return rows<Run>(k, sql`select ${RUN_COLS} from wf_runs r where r.status in ('queued', 'running', 'waiting', 'quota') order by r.id`);
      },
    },
    cleanup: {
      /** Worktree cleanup candidates: runs finished more than `olderThanDays` days ago. */
      async listFinishedRuns(_sctx: SystemCtx, olderThanDays: number): Promise<Run[]> {
        return rows<Run>(
          k,
          sql`select ${RUN_COLS} from wf_runs r where r.status in ${FINISHED_RUNS} and r.ended_at < now() - (${days(olderThanDays, 0)}::float8 * interval '1 day') order by r.id`,
        );
      },
      /** The only deleter of `cap_blobs`: blobs that no file of the owner's versions references. */
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async deleteUnreferencedBlobs(_sctx: SystemCtx): Promise<number> {
        // The table lock conflicts with the ROW EXCLUSIVE lock of every open createVersion insert, so the delete waits for it and sees its cap_files.
        return k.transaction().execute(async (trx) => {
          await sql`set local lock_timeout = '5s'`.execute(trx);
          await sql`lock table cap_blobs in share row exclusive mode`.execute(trx);
          return changed(
            trx,
            sql`delete from cap_blobs b where not exists (
                  select 1 from cap_files f join capability_versions v on v.id = f.version_id join capabilities c on c.id = v.cap_id
                  where f.blob_hash = b.hash and c.user_id = b.user_id)`,
          );
        });
      },
      async pruneIdempotencyKeys(_sctx: SystemCtx, olderThanDays = 30): Promise<number> {
        return changed(k, sql`delete from idempotency_keys where created_at < now() - (${days(olderThanDays, 30)}::float8 * interval '1 day')`);
      },
    },
  };
};
