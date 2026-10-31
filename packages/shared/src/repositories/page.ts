/** Keyset paging on `(timestamp, id)` descending. The cursor is base64url JSON `{t: ISO time, id}`; `t` keeps microseconds from Postgres. */
import { sql, type RawBuilder } from 'kysely';
import { rows, type K } from './db.ts';
import { RepoError } from './errors.ts';
import { clampLimit } from './limits.ts';

export type Page<R> = { rows: R[]; next: string | null };

const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export const encodeCursor = (t: string, id: string): string => Buffer.from(JSON.stringify({ t, id })).toString('base64url');

export function decodeCursor(cursor: string): { t: string; id: string } {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t?: unknown; id?: unknown };
    if (typeof v.t === 'string' && typeof v.id === 'string' && CURSOR_TIME.test(v.t)) return { t: v.t, id: v.id };
  } catch {
    // falls through to the error below
  }
  throw new RepoError('invalid', 'invalid cursor');
}

/**
 * Runs `inner`, a select that returns the row columns plus `page_ts` (timestamptz) and `page_id` (text), newest first.
 * `inner` carries every tenancy filter; this function only adds the cursor condition, the order and the limit.
 */
export async function keyset<R extends object>(k: K, inner: RawBuilder<unknown>, o: { limit?: unknown; cursor?: unknown }): Promise<Page<R>> {
  const limit = clampLimit(o.limit);
  const after = o.cursor === undefined || o.cursor === null ? null : decodeCursor(String(o.cursor));
  const cond = after ? sql`where (p.page_ts, p.page_id) < (${after.t}::timestamptz, ${after.id}::text)` : sql``;
  const got = await rows<Record<string, unknown> & { pageCursor: string; pageId: string }>(
    k,
    sql`select p.*, to_char(p.page_ts at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as page_cursor
        from (${inner}) p ${cond} order by p.page_ts desc, p.page_id desc limit ${limit + 1}`,
  );
  const more = got.length > limit;
  const page = got.slice(0, limit);
  const last = page.at(-1);
  const out = page.map((row) => {
    const r = { ...row } as Record<string, unknown>;
    delete r['pageTs'];
    delete r['pageId'];
    delete r['pageCursor'];
    return r as R;
  });
  return { rows: out, next: more && last ? encodeCursor(last.pageCursor, last.pageId) : null };
}
