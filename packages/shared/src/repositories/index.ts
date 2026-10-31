/**
 * The only module with SQL (Kysely on `pg`). One file per domain; every function is `(ctx, input?) => Promise<…>`.
 *
 * Called from: `apps/web` routes and hooks, `apps/worker` job handlers, the T1.4 jobs wiring. They pass `ctx = {userId, projectId?}`;
 * `userId` comes from the verified API key (or `local`), never from a request body. Everything else a caller passes is untrusted.
 * Why: one place enforces "a user can never read or change another user's rows" (the `tenancy` test is the gate).
 * Deliberately NOT done: HTTP codes and Zod schemas (apps/web), Redis caches and epochs (T1.4), embedding calls and RRF (packages/core),
 * scanning and hashing (T3.1), the retry rule and the walker (T6.1), schema creation (T1.2, `admin/`), reading `.env`.
 */
import { createSystemCtx, isSystemCtx, requireUser } from './ctx.ts';
import { createDb, type Db } from './db.ts';
import { StoreTimeoutError } from './errors.ts';
import { apiKeysRepo } from './api-keys.ts';
import { dedupRepo } from './dedup.ts';
import { graphRepo } from './graph.ts';
import { historyRepo } from './history.ts';
import { idempotencyRepo } from './idempotency.ts';
import { jobsRepo } from './jobs.ts';
import { libraryRepo } from './library.ts';
import { memoryRepo } from './memory.ts';
import { projectsRepo } from './projects.ts';
import { runnerRepo } from './runner.ts';
import { sessionsRepo } from './sessions.ts';
import { systemRepo } from './system.ts';

export { createDb, createSystemCtx };
export type { Database, Db } from './db.ts';
export type { Ctx, SystemCtx } from './ctx.ts';
export { ConflictError, RepoError, StoreTimeoutError } from './errors.ts';
export type { RepoErrorCode } from './errors.ts';
export { limits } from './limits.ts';
export type { Page } from './page.ts';

const QUERY_CANCELED = '57014';

/** Rewrites a Postgres statement timeout into `StoreTimeoutError`; everything else is rethrown unchanged. */
function mapError(error: unknown): unknown {
  return (error as { code?: string } | null)?.code === QUERY_CANCELED ? new StoreTimeoutError() : error;
}

/**
 * Wraps every function of a domain object so that the first argument is checked before any SQL is sent
 * (`TypeError('ctx.userId required')`, or a missing `SystemCtx`) and statement timeouts become `StoreTimeoutError`.
 */
function guard<O extends object>(domain: O, check: (ctx: unknown) => void): O {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(domain)) {
    if (typeof value === 'function') {
      out[name] = async (ctx: unknown, ...args: unknown[]) => {
        check(ctx);
        try {
          return await (value as (...a: unknown[]) => unknown)(ctx, ...args);
        } catch (error) {
          throw mapError(error);
        }
      };
    } else out[name] = value;
  }
  return out as O;
}

const checkUser = (ctx: unknown): void => requireUser(ctx);
const checkSystem = (ctx: unknown): void => {
  if (!isSystemCtx(ctx)) throw new TypeError('system ctx required');
};

const guardSystem = <S extends Record<string, object>>(system: S): S =>
  Object.fromEntries(Object.entries(system).map(([name, domain]) => [name, guard(domain, checkSystem)])) as S;

export type Repositories = ReturnType<typeof createRepositories>;

/** Builds every domain object on one `Db`. The `system` object takes a `SystemCtx` first; all others take a `Ctx`. */
export function createRepositories(db: Db) {
  return {
    projects: guard(projectsRepo(db), checkUser),
    sessions: guard(sessionsRepo(db), checkUser),
    history: guard(historyRepo(db), checkUser),
    jobs: guard(jobsRepo(db), checkUser),
    idempotency: guard(idempotencyRepo(db), checkUser),
    apiKeys: guard(apiKeysRepo(db), checkUser),
    dedup: guard(dedupRepo(db), checkUser),
    graph: guard(graphRepo(db), checkUser),
    library: guard(libraryRepo(db), checkUser),
    memory: guard(memoryRepo(db), checkUser),
    runner: guard(runnerRepo(db), checkUser),
    system: guardSystem(systemRepo(db)),
  };
}

