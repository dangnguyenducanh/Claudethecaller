# Task: build the F4 step lifecycle core: the step transition table and the one `transitionStep` every status write goes through, attempts with retry and circuit break, stages, the runner job id, and `Idempotency-Key` handling, plus the four step routes that use them (retry, fail, cancel, report).

Callers (built later): the ctc-web bootstrap mounts `runsRoutes(deps)` on Fastify; the dashboard Runs page calls retry, fail and cancel; the agent process calls report with its step token; T6.2 (worker cold path, restart sweep) and T6.3 (walker, approve, continue, POST runs) call the core functions and `withIdempotency`. All SQL goes through `repos.runner` / `repos.idempotency` (T1.3). Untrusted: every param, body and header, the step token, and what an agent reports. The gates are the Vitest tests `runner.lifecycle` (every illegal `from → to` rejected; duplicate report no-op; stale report `409`) and `runner.idempotent` (same key + payload replays; different payload → `409 idempotency_mismatch`).

Public names (TypeScript strict; exact shapes in DECISIONS.md D3, D9-D21):

    packages/core/src/runner/index.ts  (`@ctc/core/runner`, pure: no I/O, `import type` only from @ctc/shared):
      STEP_STATUSES, NON_FINAL, TRANSITIONS, canTransition(from, to), class RunnerError { code }, STAGES, canEnterStage(current, next),
      runnerLimits, isExhausted(step, max?), isCurrentAttempt(step, steps), runnerJobId({runId, nodeId, visit, attempt}),
      transitionStep(port, ctx, {stepId, from, to, patch?}), advanceStage(port, ctx, step, stage),
      failStep(port, ctx, {step, to, error?, patch?, maxFailures?}), retryStep(port, ctx, {stepId, maxFailures?}),
      reportStep(port, ctx, {stepId, outcome, summary?}), cancelRun(port, ctx, runId); types StepStatus, Stage, RunnerPort
    apps/web/src/runs/index.ts:
      runsRoutes(deps: RunsDeps): Route[]      // exactly the 4 routes of D9
      withIdempotency(deps, ctx, {key, route, payload}, exec), payloadHash(value), stepJson(step), runsLimits, type RunsDeps
    packages/shared/src/schemas/runs/index.ts  (`@ctc/shared/schemas/runs`, Zod only): the four body schemas
    packages/shared/src/repositories/idempotency.ts:  + settle(ctx, {key, route, response}), release(ctx, {key, route})   (D20a)
    packages/shared/src/repositories/tenancy.cases.ts: + the two cases                                          (D20b)
    apps/web/src/library/http.ts: + error codes unauthorized / stale_attempt / idempotency_mismatch, + Route request `headers?`  (D20c)

## How to work
1. `agent/t6-1-runner-core/DECISIONS.md` is the behaviour contract. Implement exactly that.
2. `agent/t6-1-runner-core/PROCESS.md` is the order of work.
3. Change only:
   - `packages/core/src/runner/` (source and `*.test.ts`),
   - `apps/web/src/runs/` (source and `*.test.ts`),
   - `packages/shared/src/schemas/runs/` (source and `*.test.ts`),
   - `packages/shared/src/repositories/idempotency.ts` (only D20a), `packages/shared/src/repositories/tenancy.cases.ts` (only D20b),
     `apps/web/src/library/http.ts` (only D20c); new `*.test.ts` files in `packages/shared/src/repositories/`.
   No new dependency, no `package.json` or lockfile change: `zod` is reached through `@ctc/shared/schemas/runs`, SQL through
   `@ctc/shared/repositories` (never import `pg`/`kysely` outside `packages/shared/src/repositories`; ESLint bans it). No Fastify: routes are
   plain objects of the `Route` type in `apps/web/src/library/http.ts` (reuse it and its `ApiError`/`toApiError`/`errorBody`/`statusOf`).
   Preconditions the orchestrator provides, because you have no network: dependencies installed; the scratch Postgres `127.0.0.1:18304`
   (env `CTC_SCRATCH_PG_URL`) is running; `migrate({url, schema})` from `@ctc/shared/repositories/admin` builds a scratch schema. Dev runs use
   `CTC_HOME=$PWD/.ctc-dev`. Never read or write the real `~/.claude`, `~/.claudethecaller`, port 18310, Redis or any other service; never
   spawn `claude`, `codex` or `git` (nothing in this task needs them).

Test naming (the self-check's `--fast` skips slow files by name): tests that need the scratch Postgres are `*.int.test.ts` (and `tenancy.test.ts`);
pure tests (fake ports) are `*.test.ts`. Scratch schemas are named `ctc_t61_<random>` and dropped in `afterAll`.

## Done
The gate test files exist with exactly these names (DECISIONS.md D22):
- `apps/web/src/runs/runner.lifecycle.int.test.ts`: `describe('runner.lifecycle')` with `it('every illegal from-to transition is rejected')`,
  `it('a duplicate report is a no-op')` and `it('a report from an old attempt gets 409 stale_attempt')`;
- `apps/web/src/runs/runner.idempotent.int.test.ts`: `describe('runner.idempotent')` with
  `it('same key and same payload replays the stored response')` and `it('same key with a different payload gets 409 idempotency_mismatch')`.

`python3 agent/t6-1-runner-core/selfcheck.py` prints `SELFCHECK: DONE`.
