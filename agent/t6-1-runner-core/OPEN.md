# T6.1 planner notes: what the owner reviews in the final PR

Drafted: `agent/t6-1-runner-core/` (SPEC, DECISIONS D0-D22, PROCESS, checks.mjs, selfcheck.py). YOUR-CHOICE lines: 22 (in 21 decisions;
every one is a default under O11). No new FROM-OWNER rule was needed.
Status: `checks.mjs` and `selfcheck.py` run and FAIL cleanly (module not built; with `CTC_SCRATCH_PG_URL` unset, every id fails with that
reason). The checks were never run against an implementation (none exists); their DB fixtures (`createRun`/`setRunStatus`/`insertStep` with
`failureCount`, `parentStepId`, `tokenHash`, a pending `{status: 0}` receipt) were run against the real T1.3 repositories on the scratch DB and
behave as the checks assume. Expect a few planner mistakes; triage after the first coder run (fix the check, not the code, when the check
contradicts DECISIONS.md).
Orchestrator before the coder starts: `python3 agent/t6-1-runner-core/selfcheck.py --snapshot` (records HEAD and the dirty files).
`KNOWN_RED` (schema-assumptions, `projects.graph_epoch`/`mem_epoch`) is still red at 7b5098f and is carried over from the T3.2 selfcheck.

## A. Highest risk (ordered by blast radius)
1. **Nobody in spec §8 owns the walker or the run status.** T6.1 is "transition table, attempts, stages, idempotency keys"; T6.2 is the cold path;
   T6.3 is gates, fan-out, handoff, cleanup. The walker (`packages/core/runner`, spec:97/604) and "the run status follows its steps" (spec:640)
   fall between them. Default: T6.3 owns both (runner.md needs the walker end to end). T6.1 writes the run status only in two places:
   cancel (→ `cancelled`, D17) and circuit break (→ `failed`, D14c). A failed attempt with retries left leaves the run as it is, so a retry is
   possible (D13 refuses retry only on a `done`/`failed`/`cancelled` run). If T6.3's walker marks the run `failed` as soon as a step fails,
   user story 4 (retry to attempt 3) breaks: T6.3 must keep the run non-final while a retry is still possible.
2. **Idempotency reserve-first (D18) adds two repository functions (D20a) and a pending receipt.** Default: insert the receipt as pending
   (`{status: 0}`) before running the mutation, settle it after, release it on 5xx or throw; a concurrent duplicate gets `409 conflict` (in
   progress), never a second execution. Alternative: lookup → execute → store (no repo change; two concurrent requests with one key both execute,
   relying on the `where status = from` guards; POST runs (T6.3) would create two runs). Cost of the default: a crash between reserve and settle
   blocks that key until `cleanup.receipts` prunes it after 30 days (the client must use a new key). The spec's "key PK" is `(user_id, key)`
   since T1.2, so the same key on another route is refused as `idempotency_mismatch` before anything runs.
3. **Report auth and shared mode (D1c, D15, D7).** Default header `X-CTC-Step-Token: <token>`, `sha256` hex compare with `timingSafeEqual`, and the
   step is looked up with `ctxOf(req)` (local mode: `local`). In shared mode the agent process has no API key ("step token only", spec:699), so
   `ctxOf` cannot give the right user; resolving the user from the token needs a system lookup by `token_hash` that no repository function has.
   Left to the web bootstrap/T6.2 (add `repos.system.runner.findStepByTokenHash`). Alternative: `Authorization: Bearer <token>` (collides with the
   shared-mode API key header).

## B. YOUR-CHOICE items (D-id: default | alternative | why it matters)
| D | Default | Alternative | Why it matters |
|---|---|---|---|
| D0 | T6.2/T6.3 call core `transitionStep`/`failStep`/`advanceStage`/`runnerJobId` and web `withIdempotency`; nobody calls `repos.runner.transition` directly | put the table check inside `repos.runner.transition` | the repo cannot import core (core depends on shared), so the single choke point lives in core; enforced by a source grep (D6a) |
| D1 | retry/fail/cancel bodies strict; report body strips unknown keys; 404 before 401 | report strict too; 401 before 404 | an agent's report with one extra key should not be lost; 404-first leaks step existence to a caller without a token (local mode only today) |
| D2 | key 1..200 visible ASCII; summary cut at 20,000, reason/error cut at 2,000 (not rejected) | reject over-long values | cutting keeps an agent's result instead of a 422 it cannot fix |
| D3 | retry `201 {step, created, enqueued}` (`200` when a race already created it); fail `{step}`; cancel `{run:{id,status,endedAt}, cancelled}`; report `{applied, step}`; `RunnerError(code, message)` | other shapes | the dashboard and T6.3 depend on them |
| D4 | order params → lookup → header/token → body → state; junk ids are 404 | 422 for junk ids | same rule as T3.2 |
| D5 | report on a current non-running attempt is a 200 no-op (any outcome); cancel of a finished run is a 200 no-op | 409 for both | duplicates from retrying clients and agents stay harmless |
| D6 | web source may not call `runner.transition(`/`setRunStatus(` | trust code review | keeps "every status write goes through transition" checkable |
| D7 | split listed (approve, continue, POST runs, walker → T6.3; claim, stages in the cold path, token issue, kill, sweep → T6.2) | T6.1 also does cancel-kill and continue | task sizes |
| D9 | core has no runtime import of `@ctc/shared` and no `node:*`; Zod in `packages/shared/src/schemas/runs` | Zod in web (needs a new dependency) | keeps core pure (spec:99) and no lockfile change |
| D10 | "any non-final" = queued, running, waiting, quota, start_unknown; failed/timeout are not cancelled | cancel also moves failed/timeout | a cancel should not rewrite a recorded failure |
| D11 | message `illegal transition <from> -> <to>` | — | text only |
| D12 | stages forward-only with skips, same stage allowed, only while `running` | strictly the next stage | `worktree: none` agent steps start at `spawn` |
| D13 | `failure_count < 3` read as the NEW attempt's count (attempts 1-3, the third failure is final); retryable from failed/timeout/start_unknown; retry refused on a finished run; start_unknown is first marked `failed` "superseded by retry" | read as the old attempt's count (4 attempts) | the spec line alone allows both; user story 4 decides for 3 attempts |
| D14 | circuit breaks at the third failure itself (and the run → failed), not only when a retry is asked | break only on the refused retry | the Runs page shows `circuit_broken` without a click |
| D15 | header name; report on `start_unknown` is a no-op (the table has no `start_unknown → done`); `output = {outcome, summary}` | allow `start_unknown → done` on a late report | "never act on absence": a step marked start_unknown that then reports done keeps start_unknown until the user retries or fails it; the agent's summary is lost (see C) |
| D16 | `/fail` only for start_unknown; default error `marked failed by user` | any non-final step | route name says "mark start_unknown failed" |
| D17 | cancel moves non-final steps and the run, kills nothing (T6.2 stops on its next transition conflict) | cancel also signals the worker | no process access in web |
| D18 | reserve-first receipts, no stored 5xx, hash over `{params, body ?? null}` with sorted keys, 409s returned not thrown | see A2 | retry semantics for every mutating F4 route |
| D19 | escape `%`→`%25`, `:`→`%3A` in the node id inside the spec job id | forbid `:` in node ids | keeps job ids injective for any workflow file |
| D20 | add `settle`/`release` to `repos.idempotency`, two tenancy cases, three error codes + `headers?` in `apps/web/src/library/http.ts` | a separate http module for runs | reuses the one error model |
| D21 | stepJson key set (no token hash, pid, worktree, branch, log path, usage, cost, options) | include usage/cost/worktree | the Runs page will need more (frontend spec pending, spec §10); add then |

## C. Places where two reasonable readers differ
- spec:640 "only if `failure_count < 3`": the old attempt's count (allows attempt 4) or the new one's (D13 default). User story 4 (spec:587) and
  spec:724 "3 failed attempts → circuit_broken" support the default.
- spec:636 "any non-final → cancelled" vs spec:640 "failed or timeout once no retry is taken" are final: whether a cancel touches failed/timeout
  attempts (D10 default: no).
- spec:684 says the sweep sets `liveness = start_unknown` and the run `waiting`; the table (spec:632) has `running → start_unknown` as a status.
  T6.1 treats `start_unknown` as a status (the table) and leaves the liveness column to T6.2.
- spec:670 "a duplicate report is a no-op": only an identical repeat, or any report on an attempt that is no longer running (D5 default: any).
- A late report after the sweep marked the attempt `start_unknown`: no-op by the table (D15) vs. accepting the result. The table has no edge for
  it; adding `start_unknown → done` would be a spec change.
- spec:165 "same key + same payload hash": whether the payload includes the route params (D18 default: yes, so the same key on another run is a
  mismatch) and whether a 4xx reply is stored (default: yes; only 5xx is not).
- spec:697 lists `/cancel` with approve/continue under T6.3-like features; T6.1 builds cancel because it is pure transition-table work.
- spec:644 job id `run:<rid>:…` contains `:`, which BullMQ 5 rejects: T1.4's `bullJobId` already encodes it (agent/t1-34-OPEN.md A5); T6.1 keeps
  the spec string for `jobs.id`.
