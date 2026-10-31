# Task: build F3 recall (RRF × recency × reinforcement), the SessionStart hook `POST /v1/hook/start` (a ≤ 10,000-char block within 1,200 ms, fixed drop order), the four MCP memory tools, the `/api` memory routes, the `memory.import` and `memory.distill` jobs, and the hand-labelled memory eval set.

Callers (built later): the web bootstrap mounts `hookStartRoute` and `memoryRoutes` and registers `memoryTools` on `/mcp`; Claude Code's SessionStart hook posts to `/v1/hook/start`; the worker main binds `memoryJobHandlers` and `watchMemoryFiles`. They reuse what is merged: `repos.memory`, `repos.sessions`, `repos.projects`, `repos.history` (T1.3), the cache keys and epochs (T1.4), the queue payloads (T1.4), `sanitize`, `applyBands` and the model clients (T4.2), and the `Route` / `McpTool` plumbing of `apps/web/src/library/http.ts` (T3.2). Untrusted: the hook body, every MCP argument and `/api` input, every Claude memory file and transcript under `claude_home`, every string read back from the database, the embedder. The gates are the Vitest tests `memory.context` (500 memories → block ≤ 10,000 chars, drop order as specified) and `memory.recall` (the eval set: RRF Recall@5 ≥ vector-only Recall@5).

Public names (TypeScript strict; exact shapes in DECISIONS.md D9):

    packages/core/src/memory          (`@ctc/core/memory`, pure; T4.2 exports unchanged) adds:
      recallLimits, rrf, recallScore, rankRecall, cleanLine, indexRow, renderStartBlock, fitStartBlock, bandPorts,
      parseMemoryFile, projectDirName; types RecallRow, StartInput, BandPortDeps
    packages/shared/src/schemas/memory (`@ctc/shared/schemas/memory`, Zod): memoryApiLimits, HookStartBody, MemSearchArgs,
      MemTimelineArgs, MemGetArgs, SaveMemoryArgs, MemoryListQuery, MemoryIdParams, MemoryPatchBody, SummaryParams,
      HistoryListQuery, HistoryImportBody
    packages/shared/src/repositories  memory.recallLegs accepts queryVector null; new history.byPaths (D17)
    apps/web/src/memory               hookStartRoute(deps): Route, memoryRoutes(deps): Route[], memoryTools(deps): McpTool[]; type MemoryApiDeps
    apps/worker/src/memory            adds memoryJobHandlers(deps): { 'memory.import': Handler; 'memory.distill': Handler },
                                      watchMemoryFiles(opts): { close(): void }; type MemoryJobDeps (memoryHandlers keeps its 2 keys)
    .claude/metric/eval/memory/       the eval set, copied byte for byte from agent/t4-3-recall/eval/ (D18)

## How to work
1. `agent/t4-3-recall/DECISIONS.md` is the behaviour contract. Implement exactly that.
2. `agent/t4-3-recall/PROCESS.md` is the order of work.
3. Change only these paths (source, `*.test.ts`, and `fixtures/` under them):
   - `packages/core/src/memory/`
   - `packages/shared/src/schemas/memory/`
   - `apps/web/src/memory/`
   - `apps/worker/src/memory/`
   - `.claude/metric/eval/memory/` (copy of `agent/t4-3-recall/eval/`, nothing else)
   - `packages/shared/src/repositories/memory.ts`, `packages/shared/src/repositories/history.ts`, `packages/shared/src/repositories/tenancy.cases.ts` (D17 only)
   - new test files (`*.test.ts`) anywhere.
   No new dependency, no `package.json` or lockfile change (`zod` is in `@ctc/shared`, `yaml` in `@ctc/core`; `node:fs`, `node:crypto`, `node:path` are enough). Do not edit `apps/web/src/library/` (import from `../library/http.ts`), `apps/web/src/spool`, `apps/worker/src/jobs`, `apps/worker/src/library`, `packages/shared/src/cache`, `queues`, `env`, `models`, `packages/core/src/sanitize`, or the migrations.
   Preconditions the orchestrator provides, because you have no network: dependencies installed; the scratch Postgres `127.0.0.1:18304` (env `CTC_SCRATCH_PG_URL`) and the scratch Redis `127.0.0.1:18395` (env `CTC_SCRATCH_REDIS_URL`, needed only by the project suites) are running. Tests create their own schema `ctc_t43_<random>` with `migrate({url, schema})` from `@ctc/shared/repositories/admin`, open it with `createDb({url, schema})` + `createRepositories(db)`, and drop it in `afterAll`. Every `claude_home` is a `mkdtemp(os.tmpdir()/ctc-t43-)` dir that the test removes. Tests never call the real embedder (:18300) or llama-server (:18302): they inject fakes (`embed`, `chat`); the eval vectors are precomputed in `vectors.jsonl`. Never touch `~/.claude`, `~/.claudethecaller`, port 18310 or any other service.

Test naming (the self-check's `--fast` skips slow files by name): the gate tests are `apps/web/src/memory/memory.context.int.test.ts` with a top-level `describe('memory.context', …)` and `apps/web/src/memory/memory.recall.int.test.ts` with a top-level `describe('memory.recall', …)` (D18); every test that needs Postgres is `*.int.test.ts`; pure and fake-only tests are `*.test.ts`.

## Done
`python3 agent/t4-3-recall/selfcheck.py` prints `SELFCHECK: DONE`. It runs the gate tests `memory.context` and `memory.recall` (spec §4.8, §7 F3), the module tests, `checks.mjs`, ESLint on the module, `pnpm -r lint`, `pnpm -r typecheck`, `pnpm -r test` (which keeps T4.2's `memory.idempotent` / `memory.bands` and T1.3's `tenancy` green), the eval-set copy check and the scope check.
