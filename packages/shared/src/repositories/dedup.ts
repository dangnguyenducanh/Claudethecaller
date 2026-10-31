/** Possible duplicate pairs awaiting review, per user. Pairs are stored sorted, so `[a, b]` and `[b, a]` are the same pair. */
import { sql } from 'kysely';
import type { Ctx } from './ctx.ts';
import { first, type Db } from './db.ts';
import { RepoError } from './errors.ts';
import { keyset, type Page } from './page.ts';

export type DedupRow = { id: number; userId: string; a: string; b: string; similarity: number; status: string; at: Date };
const COLS = sql.raw('id, user_id, a, b, similarity, status, at');
const STATUSES = ['merged', 'kept_apart', 'open'];

function sorted(pair: unknown): [string, string] {
  if (!Array.isArray(pair) || pair.length !== 2 || pair.some((x) => typeof x !== 'string' || x === '')) throw new RepoError('invalid', 'pair must be [string, string]');
  const [a, b] = pair as [string, string];
  return a <= b ? [a, b] : [b, a];
}

export const dedupRepo = (db: Db) => {
  const k = db.kysely;
  return {
    /** The status of an existing pair stays; only `similarity` is refreshed. */
    async upsertPair(ctx: Ctx, input: { pair: [string, string]; similarity: number }): Promise<DedupRow> {
      const [a, b] = sorted(input?.pair);
      const row = await first<DedupRow>(
        k,
        sql`insert into dedup_review (user_id, a, b, similarity) values (${ctx.userId}, ${a}, ${b}, ${input.similarity})
            on conflict (user_id, a, b) do update set similarity = excluded.similarity returning ${COLS}`,
      );
      return row as DedupRow;
    },
    async listOpen(ctx: Ctx, o: { limit?: number; cursor?: string } | null = {}): Promise<Page<DedupRow>> {
      o ??= {};
      return keyset<DedupRow>(k, sql`select ${COLS}, at as page_ts, id::text as page_id from dedup_review where user_id = ${ctx.userId} and status = 'open'`, o);
    },
    async setStatus(ctx: Ctx, pair: [string, string], status: 'merged' | 'kept_apart' | 'open'): Promise<DedupRow | null> {
      if (!STATUSES.includes(status)) throw new RepoError('invalid', 'bad status');
      const [a, b] = sorted(pair);
      return first<DedupRow>(
        k,
        sql`update dedup_review set status = ${status} where user_id = ${ctx.userId} and a = ${a} and b = ${b} returning ${COLS}`,
      );
    },
  };
};
