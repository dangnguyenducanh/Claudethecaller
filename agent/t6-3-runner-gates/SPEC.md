# Task: build the F4 workflow engine on top of T6.1/T6.2: workflow parse, walker, shell/if/approval/merge/fanout/join nodes, gates with options, handoff (`run_workflow`), the run status, cleanup, and the 3-workflow eval.

Callers (built later, or by T6.1/T6.2): the worker main binds `workflowHandlers(deps)` and `cleanupHandlers(deps)` into `startWorkers({ handlers })`, calls T6.2 `sweepRunner` once at boot, then `startRunnerLoop(deps)`; `runAttempt` (`apps/worker/src/jobs/consumers.ts`) calls the `runner.step` handler for every node type that runs as a job; the ctc-web bootstrap mounts `workflowRoutes(deps)` next to T6.1 `runsRoutes(deps)` and `workflowTools(deps)` on `/mcp`; the dashboard Runs page and an agent (`run_workflow`, `workflow_status`) are the users. All SQL goes through `repos.*` (T1.3); every step status write goes through the T6.1 core. Untrusted: the workflow file, run inputs, `repo`, `base`, every route param/header/body, every byte a shell command or an agent writes, child branch names. The gates are the Vitest tests `runner.fanout` (3 children in 3 worktrees, join merges; depth 2 refused) and `runner.md` (3 sample workflows end to end, metric thresholds).

Public names (TypeScript strict; exact shapes in DECISIONS.md D3, D9-D26):

    packages/core/src/runner/{workflow,walker,gates}.ts (+ more), re-exported from index.ts by added `export ... from` lines only (`@ctc/core/runner`; pure: no node:*, no I/O):
      NODE_TYPES, workflowLimits, parseWorkflow, renderTemplate, evalCondition, scopeOf, outText, planFanout, childId, parseChildId,
      walkerStart, walkerNext, walkerComplete, walkerStatus, isReadonlyNode, deriveRunStatus, approveStep, continueRun, REJECT_OPTION; types Workflow, WorkflowNode, WalkerState
    apps/worker/src/runner/{engine,shell,join,fanout,cleanup,runstate}.ts (+ more), re-exported from index.ts by added `export ... from` lines only:
      workflowHandlers(deps: EngineDeps): { 'runner.step': Handler }, advanceRun(deps, ctx, runId), tickRuns(deps), startRunnerLoop(deps): { stop() },
      cleanupHandlers(deps): { 'cleanup.worktree', 'cleanup.receipts' }, scheduleCleanup(deps), engineLimits, type EngineDeps
    apps/web/src/runs/{workflows,start,tools}.ts (+ more), re-exported from index.ts by added `export ... from` lines only:
      workflowRoutes(deps: WorkflowApiDeps): Route[]  (8 routes), workflowTools(deps): McpTool[]  (run_workflow, workflow_status), startRun, runJson, stepDetailJson, startLimits, handoffLimits
    packages/shared/src/schemas/workflows/index.ts: Zod schemas of the new bodies/queries
    packages/shared/src/repositories/system.ts: + runner.listActiveRuns(sctx)       (D24)
    .claude/metric/eval/runner.md and .claude/metric/eval/runner/*                   (D26)

## How to work
1. `agent/t6-3-runner-gates/DECISIONS.md` is the behaviour contract. Implement exactly that.
2. `agent/t6-3-runner-gates/PROCESS.md` is the order of work.
3. Change only:
   - `packages/core/src/runner/`: new source files, new `*.test.ts` files, and `index.ts` by ADDED `export ... from` lines (no other line; T6.1/T6.2 files `exec.ts`, `exec.test.ts`, `runner.test.ts` untouched);
   - `apps/worker/src/runner/`: new source and `*.test.ts` files, and `index.ts` by ADDED `export ... from` lines (T6.2 files untouched);
   - `apps/web/src/runs/`: new source and `*.test.ts` files, and `index.ts` by ADDED `export ... from` lines (T6.1 files untouched);
   - `packages/shared/src/schemas/workflows/` (new directory);
   - `packages/shared/src/repositories/system.ts` (only D24: ADDED lines), `packages/shared/src/repositories/tenancy.test.ts` (only the allowlist entry of D24), and the new test `packages/shared/src/repositories/system-runner.int.test.ts`;
   - `.claude/metric/eval/runner.md` and `.claude/metric/eval/runner/` (D26).
   No new dependency, no `package.json` or lockfile change (`yaml` is already a dependency of `@ctc/core`; use `node:*` and `@ctc/shared` in the worker). Never import `pg`/`kysely`/`bullmq`/`ioredis` in the new sources (SQL only through `deps.repos`, jobs only through `deps.submit`). No Fastify: routes are plain `Route` objects of `apps/web/src/library/http.ts`.
   Preconditions the orchestrator provides: dependencies installed; the scratch Postgres `127.0.0.1:18304` (env `CTC_SCRATCH_PG_URL`) is running and `migrate({url, schema})` from `@ctc/shared/repositories/admin` builds a scratch schema; `git`, `/bin/sh` and `node` are on PATH. You may start `git`, `/bin/sh` and `node` (a fake agent script you write) in throwaway directories under `os.tmpdir()`. Never start the real `claude` or `codex`, never read or write `~/.claude` or `~/.claudethecaller`, never touch port 18310, Redis, Supabase or any container, never run git in the main clone or against this repository (tests use throwaway repos), never use `pkill -f` (kill the groups your own tests started, by pid). Run every test command under `timeout`. Dev runs use `CTC_HOME=$PWD/.ctc-dev`.

Test naming (the self-check's `--fast` skips slow files by name): tests that need the scratch Postgres, git or child processes are `*.int.test.ts`; pure tests are `*.test.ts`. Scratch schemas are named `ctc_t63_<random>` and dropped in `afterAll`; temp directories start with `ctc-t63-`; every process a test starts is killed in `afterAll`.

## Done
The gate test files exist with exactly these names (DECISIONS.md D25):
- `apps/worker/src/runner/runner.fanout.int.test.ts` with `describe('runner.fanout')` and `it('runs 3 children in 3 worktrees and the join merges their branches')`, `it('refuses a fanout inside a fanout child')`, `it('fails the join with the conflicting files and keeps the branches')`, `it('never runs more children at once than max_parallel')`;
- `apps/worker/src/runner/runner.md.int.test.ts` with `describe('runner.md')` and `it('runs the 3 sample workflows end to end within the metric thresholds')`;
- `.claude/metric/eval/runner.md` exists with a "Results" table (D26).

`python3 agent/t6-3-runner-gates/selfcheck.py` prints `SELFCHECK: DONE`.
