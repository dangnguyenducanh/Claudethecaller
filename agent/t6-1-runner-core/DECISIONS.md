# Decisions for T6.1: runner step transition table, attempts, stages, idempotency keys

Tags: FROM-OWNER (O#, agent/OWNER.md), FROM-SPEC (specs/007-ctc/spec.md line), FROM-CALLERS (file:line), YOUR-CHOICE (owner reviews every one, O11).
"spec" = `specs/007-ctc/spec.md`. "repos" = `createRepositories(db)` from `packages/shared/src/repositories/index.ts` (T1.3). "core" =
`packages/core/src/runner` (`@ctc/core/runner`), "web" = `apps/web/src/runs`, "schemas" = `packages/shared/src/schemas/runs`
(`@ctc/shared/schemas/runs`). "step" = a `repos.runner` `Step` row (camelCase). A tag at the end of a block of indented lines covers the whole block.

D0  Purpose and callers. One place decides which step status changes are legal, how attempts are counted and retried, which stage an attempt
    is in, and how a mutating F4 request is made safe to repeat. Callers:
    (a) the ctc-web bootstrap (not built yet) mounts every `Route` of `runsRoutes(deps)` with `app.route({ method, url, handler })`, passing
        `ctxOf` (shared mode: the verified key's user; local mode: `local`); the dashboard Runs page calls retry, fail and cancel; the agent
        process calls report with its step token;
    (b) T6.2 (worker cold path: claim, stages, stream, timeout, quota, restart sweep) and T6.3 (walker, approve, continue, fan-out, POST runs,
        `run_workflow`) call the core functions `transitionStep`, `advanceStage`, `failStep`, `runnerJobId`, and web's `withIdempotency`;
        they never call `repos.runner.transition` themselves.
    Results: core returns `Step` rows or throws `RunnerError`; routes reply `{status, body}` through the Fastify-style `reply`.
    FROM-SPEC (spec:622 "Every status write goes through `transition(step, from, to)`", spec:97 code map `packages/core/runner` "transition table",
    spec:789 T6.1 scope, spec:165, spec:697-699). FROM-CALLERS (packages/shared/src/repositories/runner.ts:1-4 "the retry rule … (T6.1)";
    apps/web/src/library/http.ts:23-27 Route shape). Which calls T6.2/T6.3 make: YOUR-CHOICE.

D1  Trust. `ctx` (from `deps.ctxOf(req)`, default `{userId:'local'}`) is trusted. Untrusted: every param, body, header (the step token and the
    `Idempotency-Key` included), and the `outcome`/`summary` an agent reports. Rules:
    (a) every repository call takes the caller's ctx, so another user's run or step is invisible: `404 not_found`, never `401`/`409` that
        would confirm it exists; a step whose `runId` is not `:rid` is also `404`;
    (b) bodies of retry, fail and cancel are strict (an unknown key such as `userId` is `422 invalid`); the report body strips unknown keys (D5);
    (c) the report route accepts only `sha256(token)` (lowercase hex) equal to the step's `tokenHash`, compared with `crypto.timingSafeEqual`;
        a missing or wrong header, or a step with `tokenHash = null`, is `401 unauthorized`;
    (d) idempotency receipts are per user (repos key `(user_id, key)`): user B sending user A's key never sees A's stored response.
    Prevents: one user (or one agent) changing another's steps, a forged or old agent finishing a step, replay of another user's response.
    FROM-SPEC (spec:140, spec:154, spec:670 "only `sha256(token)` is stored. The report route checks the token"). FROM-CALLERS
    (packages/shared/src/repositories/idempotency.ts:9-27, packages/shared/migrations/0001_base.sql:67-75 PK `(user_id, key)`). Header and
    the strict/stripped split: YOUR-CHOICE.

D2  Limits (module constants, read at call time so a test can change them and restore them):
    core `runnerLimits.maxFailures = 3` (used when no `maxFailures` argument and no `deps.config.runner.max_failures` is given; the route reads
    `deps.config?.runner?.max_failures` at each call) FROM-SPEC (spec:640, spec:710) FROM-CALLERS (packages/shared/src/env/schema.ts:167);
    web `runsLimits = { idempotencyKeyMax: 200, summaryMax: 20000, reasonMax: 2000 }`: an `Idempotency-Key` of 1..200 visible ASCII
    characters (0x21-0x7e, inclusive) is valid, 201 is `422`; a report `summary` longer than 20,000 UTF-16 units is cut to 20,000 (not rejected);
    a fail `reason` or a failed report's error longer than 2,000 is cut to 2,000. YOUR-CHOICE (numbers chosen by judgment).

D3  Output and error format.
    Error replies use the existing web error model: body `{ error: { code, message, ...extra } }`, status by code:
    `invalid` 422 (extra `path`: `['params'|'headers'|'body', ...]`), `unauthorized` 401, `not_found` 404, `conflict` 409, `stale_attempt` 409,
    `idempotency_mismatch` 409, `store_timeout` 504, `internal` 500 (message = the thrown value's class name only).
    Every handler calls `reply.code(status).send(body)` exactly once and resolves; it never throws or rejects.
    Success bodies (all JSON-safe: `JSON.parse(JSON.stringify(b))` deep-equals `b`; steps as `stepJson`, D21):
      retry  `201 { step, created: true, enqueued: boolean }`, or `200 { step, created: false, enqueued: false }` when a concurrent retry
             already inserted attempt n+1 (D13);
      fail   `200 { step }` (status `failed`, or `circuit_broken` when D14 exhausts it);
      cancel `200 { run: { id, status, endedAt }, cancelled: number }` (`endedAt` ISO string or null);
      report `200 { applied: boolean, step }`.
    Core throws `RunnerError extends Error`, built as `new RunnerError(code, message)`, with `name = 'RunnerError'`, `code: 'conflict' |
    'stale_attempt' | 'not_found'`; web maps it to the
    same-named code. A repos `RepoError`/`ConflictError` keeps its code (`conflict`, `not_found`, `invalid`, `store_timeout`).
    FROM-SPEC (spec:148-162 error table, spec:147 `201` create). FROM-CALLERS (apps/web/src/library/http.ts:36-60 ApiError, toApiError,
    errorBody). Bodies and the `RunnerError` class: YOUR-CHOICE.

D4  Bad input. Order, first problem wins: (1) params: `:rid`/`:sid` not `^[1-9][0-9]{0,15}$` → `404 not_found` (like any unknown id);
    (2) the run/step lookup → `404`; (3) headers: `Idempotency-Key` present but not 1..`idempotencyKeyMax` visible ASCII, or sent twice
    (an array value) → `422` with `path ['headers', 'idempotency-key']`; report: token check → `401`; (4) body → `422` with
    `path ['body', ...first Zod issue path]`; (5) state rules (stale → `409 stale_attempt`, wrong status → `409 conflict`).
    Nothing is stored and nothing is written for a reply produced in steps 1-4. Core: an unknown status name in `canTransition` returns
    `false` (never throws); `transitionStep` with an illegal or unknown pair throws `RunnerError('conflict')` BEFORE any port call.
    FROM-SPEC (spec:152 "Zod failed (with the field path)", spec:154). Order and the 404-for-junk-ids rule: YOUR-CHOICE.

D5  Odd but harmless input stays valid: retry/fail/cancel with no body, `null` or `{}`; no `Idempotency-Key` (the request runs, no receipt
    is written); the header looked up case-insensitively (`Idempotency-Key`, `idempotency-key`, `X-CTC-Step-Token` likewise); a report with
    no `summary` (`output.summary = null`), with extra keys (stripped), or with a long summary (cut, D2); a report on the CURRENT attempt whose
    status is not `running` (already `done`, `failed`, `waiting`, `start_unknown`, …) → `200 { applied: false, step }` unchanged (the
    duplicate-report no-op, also for a different `outcome`); cancel of a run that is already `done`/`failed`/`cancelled` → `200`,
    `cancelled: 0`, nothing written. judgment: tolerant by default (D8). FROM-SPEC (spec:670 "a duplicate report is a no-op") for the
    report no-op; the rest YOUR-CHOICE.

D6  Must never:
    (a) write `wf_steps.status` except through core `transitionStep` (or the core functions built on it); web source never calls
        `repos.runner.transition(` or `setRunStatus(` directly, and never writes `status` through `setStepFields`;
    (b) run the mutation of a request whose key mismatches or is in progress (D18), or call `deps.enqueueStep` for an attempt it did not create;
    (c) return or log the step token, `tokenHash`, `pid`, a report `summary`, or another user's row (stepJson has no such keys, D21);
    (d) store a receipt for a `5xx` reply, or leave a pending receipt behind after its request finished (D18);
    (e) kill a process, spawn one, touch the file system, git, Redis or the network: core has no I/O at all (it calls only the port it is given),
        web reaches the database only through `deps.repos` and the queue only through `deps.enqueueStep`;
    (f) edit its argument objects (inputs may be deep-frozen); throw from a route handler (D3); act on absence (a quiet step is never
        assumed dead here: `start_unknown` is set only by T6.2's sweep).
    FROM-SPEC (spec:622, spec:670 "only `sha256(token)` is stored", spec:686 "Never act on absence", spec:99 core is pure) for (a), (c), (e), (f);
    the rest YOUR-CHOICE.

D7  Non-goals (which code does that instead): `POST /api/workflows/:id/runs`, `/approve`, `/continue`, MCP `run_workflow`/`workflow_status`,
    `GET /api/runs*`, the walker, run status derivation ("the run status follows its steps") except the two writes in D14 and D17 (T6.3);
    claiming attempts (`queued → running`), stage writes in the cold path, issuing `CTC_STEP_TOKEN`, stream/usage, timeout and quota handling,
    the restart sweep, killing the process group of a cancelled step (T6.2: its next `transitionStep` gets `RunnerError('conflict')` and it
    stops); building the BullMQ job for a retried attempt (T6.2/T6.3 supply `deps.enqueueStep`, which knows the node's `timeout_s`);
    `cleanup.receipts` (prunes `idempotency_keys` older than 30 days, T6.3 cleanup, `repos.system.cleanup.pruneIdempotencyKeys` exists);
    resolving the user of a report in shared mode from the token alone (the bootstrap's `ctxOf`; see OPEN.md); Fastify, auth, rate limit
    (web bootstrap); dashboard pages (no frontend spec, O12). FROM-SPEC (spec:789-791 task split, spec:687) FROM-OWNER (O12). Exact split:
    YOUR-CHOICE.

D8  Silence rule. Where this list says nothing, choose the more tolerant, less destructive behaviour (no-op over error for a repeat; refuse a
    write over guessing; keep a row over deleting it; never rewrite a finished step) and add a comment starting `judgment:`. FROM-OWNER (O11).

D9  Layout and public names (TypeScript strict, Node type stripping, no build):
    core `packages/core/src/runner/index.ts` exports: `STEP_STATUSES`, `NON_FINAL`, `TRANSITIONS`, `canTransition`, `RunnerError`, `STAGES`,
      `canEnterStage`, `runnerLimits`, `isExhausted`, `isCurrentAttempt`, `runnerJobId`, `transitionStep`, `advanceStage`, `failStep`,
      `retryStep`, `reportStep`, `cancelRun`, types `StepStatus`, `Stage`, `RunnerPort`. Core imports from `@ctc/shared` only with
      `import type` (no runtime dependency, no `node:*` module at all).
      `type RunnerPort = Pick<Repositories['runner'], 'getRun' | 'setRunStatus' | 'getStep' | 'listSteps' | 'insertStep' | 'transition' | 'setStepFields'>`
      (`repos.runner` satisfies it; tests may pass fakes).
    web `apps/web/src/runs/index.ts` exports: `runsRoutes(deps: RunsDeps): Route[]`, `withIdempotency`, `payloadHash`, `stepJson`, `runsLimits`,
      type `RunsDeps = { repos: Repositories; config?: { runner?: { max_failures?: number } }; enqueueStep?(ctx: Ctx, step: Step): Promise<void>;
      ctxOf?(req: unknown): Ctx; log?(message: string, fields?: Record<string, unknown>): void; now?(): Date }`.
      `runsRoutes` returns exactly these 4 routes (method + url):
      `POST /api/runs/:rid/steps/:sid/retry`, `POST /api/runs/:rid/steps/:sid/fail`, `POST /api/runs/:rid/cancel`,
      `POST /api/runs/:rid/steps/:sid/report`.
    schemas `packages/shared/src/schemas/runs/index.ts`: the Zod schemas of the four bodies (web has no `zod` dependency and imports them from
      `@ctc/shared/schemas/runs`); names: the coder's choice.
    No new dependency, no `package.json` or lockfile change; web uses `node:crypto` for sha256 and `timingSafeEqual`.
    FROM-SPEC (spec:97, spec:697-699) FROM-CALLERS (packages/core/package.json `exports "./*"`, packages/shared/package.json `exports "./*"`,
    agent/t3-2-library-api/DECISIONS.md D9 same route-object pattern). Names and file split: YOUR-CHOICE.

D10 Transition table. `STEP_STATUSES` = the 11 statuses of the schema: queued, running, waiting, done, failed, timeout, start_unknown, quota,
    skipped, cancelled, circuit_broken. `TRANSITIONS` (deep-frozen) allows exactly these 19 pairs and no other (same-status included):
      queued → running | skipped | cancelled
      running → done | waiting | failed | timeout | start_unknown | quota | cancelled
      quota → queued | cancelled
      waiting → done | cancelled
      start_unknown → failed | cancelled | circuit_broken
      failed → circuit_broken
      timeout → circuit_broken
    `NON_FINAL` = queued, running, waiting, quota, start_unknown (the "any non-final" of the cancel row). `failed` and `timeout` are NOT in it:
    cancel leaves a failed attempt failed (its record stays true); they only move on to `circuit_broken`.
    `canTransition(from, to)` is true exactly for the 19 pairs.
    FROM-SPEC (spec:624-638 table, spec:640 final states) FROM-CALLERS (packages/shared/migrations/0005_runner.sql:32 status list). Reading
    "any non-final" as the five statuses above (excluding failed/timeout): YOUR-CHOICE.

D11 `transitionStep(port, ctx, { stepId, from, to, patch? }): Promise<Step>`: when `canTransition(from, to)` is false → throws
    `RunnerError('conflict', 'illegal transition <from> -> <to>')` and calls no port function; else returns `port.transition(ctx, {stepId, from,
    to, patch})` unchanged (its `ConflictError` when the row is no longer in `from`, and `RepoError('not_found')`, propagate). Every other core
    function that changes a status goes through it. FROM-SPEC (spec:622 "checks the allowed table below and runs `UPDATE … WHERE status = from`;
    0 rows updated → `409 conflict`") FROM-CALLERS (packages/shared/src/repositories/runner.ts:150-163). Message text: YOUR-CHOICE.

D12 Stages. `STAGES = ['worktree', 'setup', 'spawn', 'stream', 'report']` (this order). `canEnterStage(current: string | null, next: string)`:
    true when `next` is a stage and (`current` is null or `next` is the same or a later stage than `current`); a backward move or an unknown
    name is false. Forward skips are allowed (an agent step with `worktree: none` starts at `spawn`). `advanceStage(port, ctx, step, next)`:
    when `canEnterStage(step.stage, next)` is false → `RunnerError('conflict')` with no write; when `step.status` is not `running` →
    `RunnerError('conflict')` with no write; else `port.setStepFields(ctx, step.id, { stage: next })` and returns the row (a `null` from the port
    → `RunnerError('not_found')`). The caller writes the stage BEFORE the side effect of that stage.
    FROM-SPEC (spec:615 stage list, spec:644 "Each stage is written to `wf_steps.stage` **before** its side effect") FROM-CALLERS
    (packages/shared/migrations/0005_runner.sql:33). Forward-only with skips and same-stage rewrite, running-only: YOUR-CHOICE.

D13 Attempts and retry.
    (a) `failureCount` of an attempt = failed attempts before it (attempt n normally has n-1). `isExhausted(step, max = runnerLimits.maxFailures)`
        is `step.failureCount + 1 >= max`: the failure of this attempt is the max-th one. With 3: attempts 1 and 2 may be retried, attempt 3's
        failure is final ("a step fails twice → I retry it (attempt 3); a third failure stops the step for good").
    (b) The current attempt of `(runId, nodeId, visit)` is the one with the highest `attempt`. `isCurrentAttempt(step, steps)` is true when no
        step in `steps` has the same `runId`, `nodeId`, `visit` and a higher `attempt`.
    (c) `retryStep(port, ctx, { stepId, maxFailures? })` and the retry route, in this order: step not visible → `RunnerError('not_found')`;
        not the current attempt → `RunnerError('stale_attempt')`; status not `failed`/`timeout`/`start_unknown` → `RunnerError('conflict',
        'step is not retryable')`; the run is `done`/`failed`/`cancelled` → `RunnerError('conflict', 'run is finished')`; exhausted → the
        step goes to `circuit_broken` and the run to `failed` (D14c) and then `RunnerError('conflict', 'retry limit reached')`; else, for
        `start_unknown` first `start_unknown → failed` with `error = 'superseded by retry'` (so every older attempt is final), then
        `port.insertStep(ctx, { runId, nodeId, visit, attempt: n+1, retryOfStepId: step.id, failureCount: step.failureCount + 1,
        parentStepId: step.parentStepId, status: 'queued' })`. Returns `{ step: <new attempt>, created }` (`created: false` when a concurrent
        retry already inserted it: the repos unique key makes it one row).
    (d) The route calls `deps.enqueueStep(ctx, newStep)` only when `created`; a throw or rejection there is logged (no message text) and gives
        `enqueued: false`; the attempt stays `queued`. No `enqueueStep` → `enqueued: false`.
    FROM-SPEC (spec:640 "inserts attempt n+1 (`retry_of_step_id`, `failure_count + 1`) as `queued`, but only if `failure_count < 3`" read as
    the new attempt's count, spec:587, spec:638, spec:698, spec:670 "current attempt") FROM-CALLERS (packages/shared/src/repositories/runner.ts:112-139
    `insertStep` repeat → `created: false`). The `< 3` reading, retryable statuses, the finished-run refusal, `superseded by retry`: YOUR-CHOICE.

D14 Failure path. `failStep(port, ctx, { step, to, error?, patch?, maxFailures? }): Promise<Step>` with `to` = `failed` (from `running` or
    `start_unknown`) or `timeout` (from `running`):
    (a) `transitionStep(step.status → to, patch { ...patch, error: cut to reasonMax, endedAt: now })`;
    (b) when `isExhausted(step, maxFailures)`: then `to → circuit_broken`;
    (c) on `circuit_broken` the run goes to `failed` (`setRunStatus(from: run's current status, to: 'failed', patch { endedAt })`) unless it is
        already `done`/`failed`/`cancelled`; a `ConflictError` from a concurrent run change is re-read once and then left alone.
    Returns the final step row. Illegal pairs throw per D11. FROM-SPEC (spec:630-631, spec:638, spec:724 "3 failed attempts → `circuit_broken`;
    run `failed`"). Breaking the circuit at the failure itself (not only when a retry is asked) and the run write: YOUR-CHOICE.

D15 Report (`POST /api/runs/:rid/steps/:sid/report`, header `X-CTC-Step-Token: <token>`, body `{ outcome: 'done' | 'failed', summary?: string }`).
    Order: D4 params → step lookup (404) → token (401, D1c) → body (422) → `reportStep(port, ctx, { stepId, outcome, summary })`:
    (a) not the current attempt → `RunnerError('stale_attempt')` → `409 stale_attempt`, nothing written ("a late report from an old attempt …
        is ignored");
    (b) current but not `running` → `{ applied: false, step }` (no write; duplicate no-op);
    (c) `running` + `done` → `running → done`, patch `{ stage: 'report', output: { outcome: 'done', summary }, endedAt: now }`;
        `running` + `failed` → `failStep` (D14) with `error = summary ?? 'reported failed'` and `patch { stage: 'report', output: { outcome:
        'failed', summary } }` (one transition writes them);
    (d) a `ConflictError` from the transition (the step changed meanwhile: a process exit or a second report won) → re-read, `{ applied: false,
        step }`. Two concurrent reports on one running step: exactly one `applied: true`.
    No `Idempotency-Key` on this route (token + no-op cover repeats). The run status is not changed by a `done` report (walker, T6.3).
    FROM-SPEC (spec:662-666, spec:670, spec:699 "step token only", spec:723, spec:732). The header name, report-after-start_unknown being a no-op
    (the table has no `start_unknown → done`), `output` shape: YOUR-CHOICE.

D16 Fail (`POST /api/runs/:rid/steps/:sid/fail`, body `{ reason?: string }`, `Idempotency-Key` accepted): marks a `start_unknown` attempt
    failed. Not current → `409 stale_attempt`; status not `start_unknown` → `409 conflict`; else `failStep(to: 'failed', error: reason ??
    'marked failed by user')` (may end `circuit_broken` + run `failed`) → `200 { step }`. FROM-SPEC (spec:637, spec:698 "mark start_unknown
    failed"). Only-start_unknown and the default text: YOUR-CHOICE.

D17 Cancel (`POST /api/runs/:rid/cancel`, body `{}` or none, `Idempotency-Key` accepted). `cancelRun(port, ctx, runId)`: run not visible → `404`;
    run already `done`/`failed`/`cancelled` → `{ run, cancelled: 0 }` with no write; else every step of the run (all attempts) whose status is in
    `NON_FINAL` goes `→ cancelled` with `endedAt` (a `ConflictError` → re-read; still non-final → one more try; else skip), then the run
    `→ cancelled` with `endedAt` (a `ConflictError` → re-read once and retry from the new status if it is still non-final). `cancelled` = the
    number of steps moved. Steps in `done`, `skipped`, `failed`, `timeout`, `circuit_broken` are untouched. Nothing is killed here (D7).
    FROM-SPEC (spec:636 "any non-final → cancelled: user cancelled the run", spec:697). Cancel of a finished run as a no-op: YOUR-CHOICE.

D18 Idempotency keys. `withIdempotency(deps: { repos }, ctx, { key, route, payload }, exec: () => Promise<{ status: number; body: unknown }>):
    Promise<{ status: number; body: unknown; replayed: boolean }>`. `route` = the route's `'<METHOD> <url template>'` (e.g.
    `'POST /api/runs/:rid/steps/:sid/retry'`); `payload` = `{ params, body: body ?? null }` of the request. Receipt `response` jsonb is
    `{ status, body }`; a pending receipt is `{ status: 0 }`.
    (a) `key` undefined → `exec()` once, nothing stored, `replayed: false`;
    (b) else reserve: `repos.idempotency.store(ctx, { key, route, payloadHash: payloadHash(payload), response: { status: 0 } })`;
        reserved → `exec()`; result `status < 500` → `repos.idempotency.settle(ctx, { key, route, response: { status, body } })`;
        `status >= 500` or `exec` throws → `repos.idempotency.release(ctx, { key, route })` (then the error is rethrown);
    (c) not reserved (the key exists) → `repos.idempotency.lookup(ctx, { key, route })`: `null` (the key was used on another route) or a different
        `payloadHash` → `409 idempotency_mismatch`; same hash and `status: 0` → `409 conflict` "request with this Idempotency-Key is in
        progress"; same hash otherwise → the stored `{ status, body }` with `replayed: true`. `exec` is not called in (c). The two `409`s are
        returned, not thrown: `{ status: 409, body: { error: { code, message } }, replayed: false }`.
    `payloadHash(v)` = sha256 hex of canonical JSON: object keys sorted at every depth, array order kept, `undefined` members dropped as
    `JSON.stringify` does. The routes retry, fail and cancel use it (D4 validation runs first; a 422 is never stored). The replayed reply equals
    the first one (status and deep-equal body). A crash between reserve and settle leaves the key pending until `cleanup.receipts` prunes it
    (30 days); the client uses a new key.
    FROM-SPEC (spec:157, spec:165, spec:697-698, spec:726 "lost HTTP reply on approve → same `Idempotency-Key` replays the stored response",
    spec:735). FROM-CALLERS (packages/shared/src/repositories/idempotency.ts:9-27; agent/t1-34-OPEN.md row T1.3 D10 key per user). Reserve
    first (Orca's pending receipt), no stored 5xx, canonical hash over params + body: YOUR-CHOICE.

D19 Job id. `runnerJobId({ runId, nodeId, visit, attempt })` = `run:<runId>:node:<nodeId>:visit:<visit>:attempt:<attempt>` with `%` in
    `nodeId` written `%25` and `:` written `%3A` (so the id stays injective); `jobs.id` keeps this string and BullMQ gets T1.4's
    `bullJobId(id)` (no second encoder). Equal inputs → equal id, so "a double add is one job". FROM-SPEC (spec:644) FROM-CALLERS
    (packages/shared/src/queues/defs.ts:60-62 `bullJobId`, packages/shared/src/queues/payloads.ts:23 `runner.step`). The node-id escaping:
    YOUR-CHOICE.

D20 Small edits outside the module (no other change to these files):
    (a) `packages/shared/src/repositories/idempotency.ts` gains `settle(ctx, { key, route, response }): Promise<boolean>` (updates the
        response of the caller's receipt only while it is pending, `response->>'status' = '0'`; `false` otherwise) and
        `release(ctx, { key, route }): Promise<boolean>` (deletes the caller's receipt only while it is pending); both filter `user_id = ctx.userId`;
    (b) `packages/shared/src/repositories/tenancy.cases.ts` gains the two cases (`settle`, `release` under `idempotency`; user B changes
        nothing of user A's) so the `tenancy` gate stays complete;
    (c) `apps/web/src/library/http.ts`: `ErrorCode` and its status map gain `unauthorized: 401`, `stale_attempt: 409`,
        `idempotency_mismatch: 409`, and `Route`'s request type gains `headers?: Record<string, string | string[] | undefined>`.
    FROM-CALLERS (packages/shared/src/repositories/tenancy.cases.ts:124-128, apps/web/src/library/http.ts:23-37, spec:153, spec:156-157).
    Adding to these files instead of a second error model / a raw SQL path: YOUR-CHOICE.

D21 `stepJson(step)` returns exactly these keys: `id, runId, nodeId, visit, attempt, retryOfStepId, failureCount, parentStepId, status, stage,
    liveness, promptOutcome, resolution, output, error, startedAt, endedAt` (dates as ISO strings or null; everything else as stored). Never
    `tokenHash`, `pid`, `pidStartedAt`, `worktree`, `branch`, `logPath`, `usage`, `costUsd`, `options`. FROM-SPEC (spec:702 "steps with status,
    attempt, stage, resolution"). The exact key set: YOUR-CHOICE.

D22 Gate tests (Vitest, real scratch Postgres, schema `ctc_t61_<random>` dropped in `afterAll`):
    `apps/web/src/runs/runner.lifecycle.int.test.ts`: `describe('runner.lifecycle')` with
      `it('every illegal from-to transition is rejected')` (all 121 - 19 pairs through `transitionStep` on real rows: `RunnerError('conflict')`,
        row unchanged; the 19 legal ones succeed),
      `it('a duplicate report is a no-op')`, `it('a report from an old attempt gets 409 stale_attempt')` (through the report route);
    `apps/web/src/runs/runner.idempotent.int.test.ts`: `describe('runner.idempotent')` with
      `it('same key and same payload replays the stored response')` (retry route twice: same status and body, one new attempt, one enqueue),
      `it('same key with a different payload gets 409 idempotency_mismatch')` (nothing executed the second time).
    FROM-SPEC (spec:732, spec:735, spec:789).
