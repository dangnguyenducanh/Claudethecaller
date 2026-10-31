# Task: build the F2 read and change surface of the skill library: the MCP tools `get_capability` and `load_capability_resource`, the `/api` capability routes (list, get, versions, version, diff, labels, restore, project override, index), the per-project served-version resolver, and the weekly `cleanup.blobs` job.

Callers (built later or in parallel): the ctc-web bootstrap mounts `libraryRoutes(deps)` on Fastify and registers `libraryTools(deps)` on the MCP server at `/mcp` (it supplies `ctx` from auth and the project); the dashboard Library page calls the routes; Claude Code agents call the two MCP tools; T5.1/T3.3 call `servedVersion` for project overrides; the worker main binds `blobCleanupHandlers` into `startWorkers({handlers})` and calls `startBlobCleanup`. All SQL goes through `repos.library` / `repos.projects` / `repos.system.cleanup` (T1.3). Untrusted: every route param, query and body, every MCP argument, and every path-like string read back from the database (`root_path`, manifest paths: rows may come from `ctc migrate --from-python`). The gates are the Vitest tests `library.mcp` (reads stay on the returned version after a new version lands) and `library.override` (pin by label and by version change the served version for that project only).

Public names (TypeScript strict; exact shapes in DECISIONS.md D3, D9-D21):

    packages/shared/src/schemas/library  (`@ctc/shared/schemas/library`, Zod only, no I/O):
      libraryApiLimits, CapabilityListQuery, VersionParams, DiffQuery, LabelsBody, RestoreBody, OverrideParams, OverrideBody,
      GetCapabilityArgs, LoadResourceArgs, parseVersionNumber
    apps/web/src/library  (routes, MCP tools, served version, restore):
      libraryRoutes(deps: LibraryApiDeps): Route[]
      libraryTools(deps: LibraryApiDeps): McpTool[]
      servedVersion(deps: LibraryApiDeps, ctx: Ctx, capId: string): Promise<number | null>
      types LibraryApiDeps, Route, McpTool, McpResult
    apps/worker/src/library/blobs.ts (exported from apps/worker/src/library/index.ts):
      blobCleanupHandlers({ repos, log? }): { 'cleanup.blobs': Handler }
      blobCleanupJobId(now: Date): string
      startBlobCleanup({ submit, everyMs?, now?, log? }): { close(): void }
    packages/core/src/library/index.ts:  + mainPathOf(paths), bodyOf(kind, mainPath, content)   (moved out of the worker, D21)
    packages/shared/src/repositories/library.ts:  + listByName(ctx, name): Promise<Capability[]>   (D11, with its tenancy case)
    packages/shared/src/repositories/system.ts:   cleanup.deleteUnreferencedBlobs takes a table lock first (D20)

## How to work
1. `agent/t3-2-library-api/DECISIONS.md` is the behaviour contract. Implement exactly that.
2. `agent/t3-2-library-api/PROCESS.md` is the order of work.
3. Change only:
   - `apps/web/src/library/` (source and `*.test.ts`),
   - `packages/shared/src/schemas/library/` (source and `*.test.ts`),
   - `apps/worker/src/library/blobs.ts`, `apps/worker/src/library/index.ts` (one export line), `apps/worker/src/library/handlers.ts` (only D21: import
     `mainPathOf`/`bodyOf` from core instead of the private copy; no other change), new `*.test.ts` files in `apps/worker/src/library/`,
   - `packages/core/src/library/index.ts` (only the two D21 functions; new `*.test.ts` files in that directory are allowed),
   - `packages/shared/src/repositories/library.ts` (only `listByName`), `packages/shared/src/repositories/tenancy.cases.ts` (only its case),
     `packages/shared/src/repositories/system.ts` (only the D20 lock in `cleanup.deleteUnreferencedBlobs`); new `*.test.ts` files in that directory.
   No new dependency, no `package.json` or lockfile change: `zod` is reached through `@ctc/shared/schemas/library`, queues through
   `@ctc/shared/queues`, the cache through `@ctc/shared/cache`, SQL through `@ctc/shared/repositories` (never import `pg`/`kysely` outside
   `packages/shared/src/repositories`; ESLint bans it). No Fastify and no MCP SDK: routes and tools are plain objects (D9).
   Preconditions the orchestrator provides, because you have no network: dependencies installed; the scratch Postgres `127.0.0.1:18304`
   (env `CTC_SCRATCH_PG_URL`) is running; `migrate({url, schema})` from `@ctc/shared/repositories/admin` builds a scratch schema. Dev runs use
   `CTC_HOME=$PWD/.ctc-dev`. Never read or write the real `~/.claude`, `~/.claudethecaller`, port 18310 or any other service: every test uses a
   temp directory as `claude_home` and as every `root_path` it restores into.

Test naming (the self-check's `--fast` skips slow files by name): tests that need the scratch Postgres are `*.int.test.ts` (and `tenancy.test.ts`);
pure tests (fakes, temp dirs only) are `*.test.ts`. Scratch schemas are named `ctc_t32_<random>` and dropped in `afterAll`.

## Done
The gate test files exist with exactly these names (DECISIONS.md D22):
- `apps/web/src/library/library.mcp.int.test.ts`: `describe('library.mcp')` with
  `it('get_capability and load_capability_resource stay on the returned version after a new version lands')`;
- `apps/web/src/library/library.override.int.test.ts`: `describe('library.override')` with
  `it('pin by label changes the served version for that project only')` and `it('pin by version changes the served version for that project only')`.

`python3 agent/t3-2-library-api/selfcheck.py` prints `SELFCHECK: DONE`.
