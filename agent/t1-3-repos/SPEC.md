# Task: build `packages/shared/src/repositories`, the only module with SQL, where every function takes `ctx` first and a user can never read or change another user's rows.

Callers (all built later): `apps/web` routes and hooks, `apps/worker` job handlers, the T1.4 jobs wiring. They pass `ctx = {userId, projectId?}`; `userId` comes from the verified API key (or `local`), never from a request body. Everything else a caller passes is untrusted. The gate is the Vitest test `tenancy`: user B's ctx reads and changes zero of user A's rows on every repository function.

Public names (TypeScript, strict; exact shapes in DECISIONS.md D9, D14):

    type Ctx = { userId: string; projectId?: string }
    createDb(opts: { url: string; schema?: string; max?: number; statementTimeoutMs?: number }): Db   // Db = { kysely, close() }
    createRepositories(db: Db): Repositories      // { projects, sessions, history, jobs, idempotency, apiKeys, dedup, graph, library, memory, runner, system }
    createSystemCtx(reason: string): SystemCtx    // only for the allowlisted cross-user functions in `system`
    limits                                        // module constants, read at call time
    class RepoError { code } ; ConflictError ; StoreTimeoutError

## How to work
1. `agent/t1-3-repos/DECISIONS.md` is the behaviour contract. Implement exactly that.
2. `agent/t1-3-repos/PROCESS.md` is the order of work.
3. Change only `packages/shared/src/repositories/` (source and its `*.test.ts` files). Preconditions the orchestrator provides, because you have no network: the dependencies `kysely`, `pg`, `@types/pg`, `vitest` are installed; `migrate({url, schema})` from `packages/shared/src/repositories/admin/index.ts` (T1.2; do not edit `admin/`) builds the schema in a scratch Postgres; env `CTC_SCRATCH_PG_URL` points at the scratch Postgres (`127.0.0.1:18304` only).

Test naming (the self-check's `--fast` skips slow files by name): tests that need the scratch Postgres are `tenancy.test.ts`, `schema-assumptions.test.ts` and `*.int.test.ts`; pure unit tests are `*.test.ts`.

## Done
`python3 agent/t1-3-repos/selfcheck.py` prints `SELFCHECK: DONE`.
