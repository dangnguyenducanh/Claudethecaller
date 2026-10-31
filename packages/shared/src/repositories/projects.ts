/**
 * Projects of one user. Called from apps/web routes and apps/worker handlers through `repos.projects`.
 * Deliberately NOT done: cache epochs in Redis (T1.4); this file only owns the Postgres counters.
 */
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { Ctx } from './ctx.ts';
import { first, type Db } from './db.ts';
import { ConflictError, RepoError } from './errors.ts';
import { keyset, type Page } from './page.ts';

export type Project = { userId: string; id: string; root: string; profileHash: string | null; name: string; createdAt: Date; lastActive: Date };

const COLS = sql.raw('user_id, id, root, profile_hash, name, created_at, last_active');
const EPOCH_COL = { graph: sql.raw('graph_epoch'), mem: sql.raw('mem_epoch') } as const;

/** First 8 hex of sha256(root): the project id (D14). */
export const projectId = (root: string): string => createHash('sha256').update(root).digest('hex').slice(0, 8);

export const projectsRepo = (db: Db) => {
  const k = db.kysely;
  return {
    /** Creates the project of `root` or, when it exists, updates `profileHash` only (a missing hash never clears the stored one). */
    async upsert(ctx: Ctx, input: { root: string; profileHash?: string | null }): Promise<Project> {
      if (typeof input?.root !== 'string' || input.root === '') throw new RepoError('invalid', 'root required');
      const id = projectId(input.root);
      // judgment: `name` is NOT NULL and unique per user in the schema; the root path is the only value that is unique per project.
      const row = await first<Project>(
        k,
        sql`insert into projects (user_id, id, root, profile_hash, name)
            values (${ctx.userId}, ${id}, ${input.root}, ${input.profileHash ?? null}, ${input.root})
            on conflict (user_id, id) do update set profile_hash = coalesce(excluded.profile_hash, projects.profile_hash)
            where projects.root = excluded.root
            returning ${COLS}`,
      );
      if (!row) throw new ConflictError('project id collision');
      return row;
    },
    async get(ctx: Ctx, id: string): Promise<Project | null> {
      return first<Project>(k, sql`select ${COLS} from projects where user_id = ${ctx.userId} and id = ${String(id)}`);
    },
    async byRoot(ctx: Ctx, root: string): Promise<Project | null> {
      return first<Project>(k, sql`select ${COLS} from projects where user_id = ${ctx.userId} and root = ${String(root)}`);
    },
    async list(ctx: Ctx, o: { limit?: number; cursor?: string } | null = {}): Promise<Page<Project>> {
      o ??= {};
      return keyset<Project>(
        k,
        sql`select ${COLS}, created_at as page_ts, id as page_id from projects where user_id = ${ctx.userId}`,
        o,
      );
    },
    async epochs(ctx: Ctx, id: string): Promise<{ graph: number; mem: number } | null> {
      return first<{ graph: number; mem: number }>(
        k,
        sql`select graph_epoch as graph, mem_epoch as mem from projects where user_id = ${ctx.userId} and id = ${String(id)}`,
      );
    },
    /** Atomic `epoch + 1`; returns the new value, or `null` when the project is not the user's. */
    async bumpEpoch(ctx: Ctx, id: string, which: 'graph' | 'mem'): Promise<number | null> {
      const col = EPOCH_COL[which];
      if (!col) throw new RepoError('invalid', 'epoch must be graph or mem');
      const r = await first<{ epoch: number }>(
        k,
        sql`update projects set ${col} = ${col} + 1 where user_id = ${ctx.userId} and id = ${String(id)} returning ${col} as epoch`,
      );
      return r ? r.epoch : null;
    },
  };
};

