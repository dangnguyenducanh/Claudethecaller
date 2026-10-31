/** Job rows of one user (the user's view). The worker-side transitions live in `system.ts`. Called from apps/web routes through `repos.jobs`. */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Ctx } from './ctx.ts';
import { first, jsonb, type Db } from './db.ts';
import { ConflictError, RepoError } from './errors.ts';
import { keyset, type Page } from './page.ts';

export type Job = {
  id: string; userId: string; queue: string; kind: string; status: string; progress: number;
  payload: unknown; result: unknown; error: string | null; attempts: number; createdAt: Date; updatedAt: Date;
};
export const JOB_COLS = sql.raw('id, user_id, queue, kind, status, progress, payload, result, error, attempts, created_at, updated_at');

export const jobsRepo = (db: Db) => {
  const k = db.kysely;
  const byId = (ctx: Ctx, id: string) => first<Job>(k, sql`select ${JOB_COLS} from jobs where user_id = ${ctx.userId} and id = ${id}`);
  return {
    /** An existing id of this user gives `{created: false}`; an id that belongs to another user gives `ConflictError` without data. */
    async create(ctx: Ctx, input: { id?: string; queue: string; kind: string; payload?: unknown }): Promise<{ job: Job; created: boolean }> {
      const id = typeof input?.id === 'string' && input.id !== '' ? input.id : randomUUID();
      const row = await first<Job>(
        k,
        sql`insert into jobs (id, user_id, queue, kind, payload) values (${id}, ${ctx.userId}, ${input.queue}, ${input.kind}, ${jsonb(input.payload ?? {})})
            on conflict (id) do nothing returning ${JOB_COLS}`,
      );
      if (row) return { job: row, created: true };
      const existing = await byId(ctx, id);
      if (!existing) throw new ConflictError('job id already in use');
      return { job: existing, created: false };
    },
    get: byId,
    async list(ctx: Ctx, o: { queue?: string; status?: string; limit?: number; cursor?: string } | null = {}): Promise<Page<Job>> {
      o ??= {};
      const queue = o.queue === undefined ? sql`` : sql`and queue = ${String(o.queue)}`;
      const status = o.status === undefined ? sql`` : sql`and status = ${String(o.status)}`;
      return keyset<Job>(k, sql`select ${JOB_COLS}, created_at as page_ts, id as page_id from jobs where user_id = ${ctx.userId} ${queue} ${status}`, o);
    },
    /** Seconds since the oldest queued job was created, or `null` when nothing is queued. */
    async oldestQueuedAgeS(ctx: Ctx): Promise<number | null> {
      const r = await first<{ age: number | null }>(
        k,
        sql`select extract(epoch from now() - min(created_at))::float8 as age from jobs where user_id = ${ctx.userId} and status = 'queued'`,
      );
      return r?.age ?? null;
    },
    /** `queued|failed` become `dead` with error `cancelled`; any other state gives `null`. */
    async cancel(ctx: Ctx, id: string): Promise<Job | null> {
      if (typeof id !== 'string') throw new RepoError('invalid', 'id required');
      return first<Job>(
        k,
        sql`update jobs set status = 'dead', error = 'cancelled', updated_at = now()
            where user_id = ${ctx.userId} and id = ${id} and status in ('queued', 'failed') returning ${JOB_COLS}`,
      );
    },
  };
};
