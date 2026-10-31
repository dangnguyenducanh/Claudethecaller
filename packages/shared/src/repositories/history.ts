/** Imported transcript files of one user. Called from the history importer through `repos.history`. */
import { sql } from 'kysely';
import type { Ctx } from './ctx.ts';
import { changed, first, rows, type Db } from './db.ts';
import { RepoError } from './errors.ts';
import { clampLimit } from './limits.ts';

export type HistoryFile = { userId: string; path: string; size: number; mtime: number; status: string };
const COLS = sql.raw('user_id, path, size, mtime, status');

const MAX_PATHS = 500;

const need = (v: unknown, what: string): void => {
  if (typeof v !== 'string' || v === '') throw new RepoError('invalid', `${what} required`);
};

export const historyRepo = (db: Db) => {
  const k = db.kysely;
  return {
    async upsert(ctx: Ctx, input: { path: string; size: number; mtime: number; status: string }): Promise<HistoryFile> {
      need(input?.path, 'path');
      const row = await first<HistoryFile>(
        k,
        sql`insert into history_files (user_id, path, size, mtime, status)
            values (${ctx.userId}, ${input.path}, ${input.size}, ${input.mtime}, ${input.status})
            on conflict (user_id, path) do update set size = excluded.size, mtime = excluded.mtime, status = excluded.status
            returning ${COLS}`,
      );
      return row as HistoryFile;
    },
    /** Oldest `mtime` first. */
    async listByStatus(ctx: Ctx, o: { status: string; limit?: number }): Promise<HistoryFile[]> {
      return rows<HistoryFile>(
        k,
        sql`select ${COLS} from history_files where user_id = ${ctx.userId} and status = ${String(o?.status)}
            order by mtime asc, path asc limit ${clampLimit(o?.limit)}`,
      );
    },
    /** The user's own rows for these paths (at most 500), by path; entries that are not strings are ignored. */
    async byPaths(ctx: Ctx, paths: string[]): Promise<HistoryFile[]> {
      if (!Array.isArray(paths)) throw new RepoError('invalid', 'paths must be an array');
      if (paths.length > MAX_PATHS) throw new RepoError('invalid', `at most ${MAX_PATHS} paths`);
      const valid = paths.filter((p): p is string => typeof p === 'string');
      if (valid.length === 0) return [];
      return rows<HistoryFile>(k, sql`select ${COLS} from history_files where user_id = ${ctx.userId} and path = any(${valid}::text[]) order by path`);
    },
    async setStatus(ctx: Ctx, path: string, status: string): Promise<number> {
      return changed(k, sql`update history_files set status = ${status} where user_id = ${ctx.userId} and path = ${String(path)}`);
    },
  };
};
