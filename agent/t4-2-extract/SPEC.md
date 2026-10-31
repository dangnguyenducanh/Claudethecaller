# Task: build the `llm.extract` handler (the user's own words of a session → facts from llama-server with a JSON grammar → the write bands NOOP / UPDATE / SUPERSEDE / ADD → `memories`) and the `llm.summarize` handler (the whole session → 6 fields → `session_summaries` with a content hash), both retrying an invalid model reply once and then dropping the job.

Callers: the worker main (built later) binds `memoryHandlers(deps)` into `startWorkers({ handlers })` (apps/worker/src/jobs, T1.4); the jobs come from the spool drain (apps/web/src/spool, T4.1: `llm.extract` on Stop, `llm.summarize` on SessionEnd after a `sessions` upsert) and later from `memory.distill` (T4.3). T4.3 also reuses `applyBands` (for `save_memory` and `memory.import`), `sanitize`, and the two model clients. All SQL goes through `repos.memory` / `repos.sessions` (T1.3). Untrusted: the job payload (re-validated by `runAttempt`), every byte of the transcript file and the path to it, every byte of every model reply. The gates are the Vitest tests `memory.idempotent` (same session extracted twice → no new rows; reinforcement adds today once) and `memory.bands` (fixture pairs land in NOOP / UPDATE / SUPERSEDE / ADD as labelled).

Public names (TypeScript strict; exact shapes in DECISIONS.md D9):

    packages/core/src/sanitize   (`@ctc/core/sanitize`, pure):  sanitize(text, o?), CTC_LINE_PREFIX
    packages/core/src/memory     (`@ctc/core/memory`, pure, ports injected):
      memoryLimits, KINDS, SCOPES, userTurns, extractInput, sessionText, isRunnerSession,
      EXTRACT_SCHEMA, SUMMARY_SCHEMA, RELATION_SCHEMA, extractMessages, summaryMessages, relationMessages,
      parseExtractReply, parseSummaryReply, parseRelationReply, bandOf, decide, applyBands, summaryHash;
      types Fact, Relation, Band, Action, BandPorts, SummaryFields
    packages/shared/src/models   (`@ctc/shared/models`, fetch only):  createEmbedder, createChat, ModelError, modelLimits; types Embed, Chat, ChatMessage
    apps/worker/src/memory:  memoryHandlers(deps: MemoryDeps): { 'llm.extract': Handler; 'llm.summarize': Handler }; types MemoryDeps

## How to work
1. `agent/t4-2-extract/DECISIONS.md` is the behaviour contract. Implement exactly that.
2. `agent/t4-2-extract/PROCESS.md` is the order of work.
3. Change only these paths (source, `*.test.ts`, and `fixtures/` under them):
   - `packages/core/src/sanitize/`
   - `packages/core/src/memory/`
   - `packages/shared/src/models/`
   - `apps/worker/src/memory/`
   No new dependency, no `package.json` or lockfile change (`fetch`, `node:crypto`, `node:fs` are enough; there is no `zod` in `@ctc/core`, so the reply parsers are plain TypeScript). Do not edit `packages/shared/src/repositories`, `queues`, `cache`, `env`, the migrations, `apps/worker/src/jobs` or `apps/web`.
   Preconditions the orchestrator provides, because you have no network: dependencies installed; the scratch Postgres `127.0.0.1:18304` (env `CTC_SCRATCH_PG_URL`) and the scratch Redis `127.0.0.1:18395` (env `CTC_SCRATCH_REDIS_URL`, needed only by the project suites) are running. Tests create their own schema `ctc_t42_<random>` with `migrate({url, schema})` from `@ctc/shared/repositories/admin`, open it with `createDb({url, schema})` + `createRepositories(db)` from `@ctc/shared/repositories`, and drop it in `afterAll` (`db.kysely.schema.dropSchema(s).ifExists().cascade().execute()`). Every transcript lives under a `mkdtemp(os.tmpdir()/ctc-t42-)` dir used as `claude_home` and is removed. Tests never call the real embedder (:18300) or llama-server (:18302): they inject fakes (`embed`, `chat`) or a `node:http` server on a random loopback port. Never touch `~/.claude`, `~/.claudethecaller`, port 18310 or any other service.

Test naming (the self-check's `--fast` skips slow files by name): the gate tests are `apps/worker/src/memory/memory.idempotent.int.test.ts` with a top-level `describe('memory.idempotent', …)` and `apps/worker/src/memory/memory.bands.int.test.ts` with a top-level `describe('memory.bands', …)` (D16); every test that needs Postgres is `*.int.test.ts`; pure and fake-only tests are `*.test.ts`.

## Done
`python3 agent/t4-2-extract/selfcheck.py` prints `SELFCHECK: DONE`. It runs the gate tests `memory.idempotent` and `memory.bands` (spec §4.8, §7 F3), the module tests, `checks.mjs`, ESLint on the module, `pnpm -r lint`, `pnpm -r typecheck`, `pnpm -r test`, and the scope check.
