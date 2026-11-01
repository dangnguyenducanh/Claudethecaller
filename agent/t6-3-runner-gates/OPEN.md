# T6.3 planner notes: what the owner reviews in the final PR

Drafted: `agent/t6-3-runner-gates/` (SPEC, DECISIONS D0-D26, PROCESS, checks.mjs, selfcheck.py). YOUR-CHOICE lines: 26 (every one a default under O11).
No new FROM-OWNER rule was needed. No earlier run of this planner existed (the directory was empty).
Status: `checks.mjs` and `selfcheck.py` run and FAIL cleanly (module not built: every id fails with "export parseWorkflow is missing"; selfcheck lists the three
missing entry files). The checks were never run against an implementation. Only their fixtures were exercised on the scratch DB: the fake agent (modes ok, fail,
quota_once, write+commit, write without commit), `createVersion` of a `workflow` capability + `manifest`/`getBlob`, `createRun` with `status: 'running'` and `state: {}`,
`insertStep`/`setStepFields`, the `runner.step` and `cleanup.worktree` payloads through `parsePayload`, and a raw `update idempotency_keys` through `sql`. Expect planner
mistakes in the scenario bodies (timing, exact error texts); triage after the first coder run (fix the check, not the code, when a check contradicts DECISIONS.md).
Orchestrator before the coder starts: `python3 agent/t6-3-runner-gates/selfcheck.py --snapshot`; env from `.ctc-dev/env.sh` (`CTC_SCRATCH_PG_URL`).
`KNOWN_RED` (schema-assumptions) is carried over from T6.2; it only matters if that test is still red at the base.
The spec asks T6.3 for "gates, fan-out + join, handoff, cleanup"; T6.1 OPEN A1 had already moved the walker and the run status here, so this task is large (walker,
workflow format, engine, 2 node families, 8 routes, 2 MCP tools, cleanup, an eval). If the coder runs out of room, split after D13 (engine) and run D16-D26 as T6.3b.

## A. Highest risk (ordered by blast radius)
1. **The tick, not a queue kind, drives the walker (D13).** `advanceRun` is idempotent and runs (a) at the end of every step (T6.2 `onStepEnd`) and (b) every
   `engineLimits.tickMs` (2 s) over `repos.system.runner.listActiveRuns` (new system function, D24). The web side (POST runs, approve, continue) only writes rows. Cost: up to 2 s
   latency after an approve; one cross-user query per tick. Alternative: a `runner.advance` queue kind (edits `queues/defs.ts`, `payloads.ts` and their tests; the runner queue
   has 3 slots, so a web-triggered advance would wait behind 3 long agent steps). Crash safety (rows first, state second, insert is idempotent) depends on D6e holding.
2. **Fan-out bookkeeping row is `waiting` (D17b).** The transition table has no way to keep a non-process row open except `waiting`, and T6.2's boot sweep fails any `running`
   step with no stage/pid. Cost: the Runs page shows the fanout step as "waiting" while its children run (it has `options: null`; the run status is derived `running`). A frontend
   spec must special-case it. Alternative: edit T6.2's sweep to skip bookkeeping steps (touches built code).
3. **Quota resume re-runs the prompt in the existing worktree (D14, D20).** T6.2 cannot `git worktree add` a branch that exists, so a resumed attempt is rendered as `worktree: parent`
   on its own worktree; the agent starts from the same prompt with the partial work on disk. Alternative: resume as attempt n+1 (new branch, work lost). The spec table says "same attempt".
4. **Join merge writes git (D18).** Checkpoint commit in each child worktree (an uncommitted child would merge as a silent no-op), identity fallback `ctc <ctc@localhost>`, `merge --no-ff`,
   `merge --abort` on conflict in the join's own worktree. The banned-word list (D6b) deliberately lets `merge`, `add`, `commit` through; cleanup.ts is the only file that may say `remove`.
5. **Setup-gate approval becomes a new attempt (D16e).** The table has no `waiting -> queued`, so the approved parked step ends `done` (stage null) and the engine inserts attempt n+1 with
   the same `failureCount`. The attempt counter on the Runs page therefore increments for a gate answer.

## B. YOUR-CHOICE items (D-id: default | alternative | why it matters)
| D | Default | Alternative | Why it matters |
|---|---|---|---|
| D0 | one `runner.step` handler for every node type; `advanceRun` from `onStepEnd` and a tick; sweep stays T6.2's | separate handler per node type; queue kind `advance` | worker main binds one handler; see A1 |
| D1 | every substituted value single-quoted in shell text; ref pattern `^[A-Za-z0-9][A-Za-z0-9._/@-]{0,199}$`; `repo` absolute, no `..`, 4,096 chars | trust workflow authors; looser refs | shell injection from inputs and from an agent's earlier output; a `-x` base would reach git |
| D2 | `workflowLimits` (200 nodes, 1000 edges, 20 items, 4,000-char tail), `engineLimits`, `startLimits`, `handoffLimits` | other numbers | module constants read at call time; only 3/3/600/3 are from the spec |
| D3 | result shapes, route bodies, error texts, `runJson`, `stepDetailJson` (adds `options`, `worktree`, `branch`, `usage`, `costUsd`) | other shapes | the dashboard Runs page will be built on them (no frontend spec yet) |
| D4 | order params -> run lookup -> header -> body -> state; `errors` list on a bad workflow | 422 for junk ids | same rule as T3.2/T6.1 |
| D5 | tolerant list (extra keys, unreachable nodes, missing variables, empty fanout, CRLF) | strict workflow validation | a hand-edited workflow should still run |
| D6 | word lists for git, single `runstate.ts` for `setRunStatus`, no `.transition(` | trust review | keeps "every status write goes through the core" checkable |
| D7 | non-goal split (schedules, nested fanout, exports, push) | | task sizes |
| D9 | file names, `EngineDeps`/`WorkflowApiDeps` shapes (`enqueueResume` hook, `library` deps object, `ownerOf`, `advance`) | other shapes | the web and worker bootstraps build against them |
| D10 | snake_case in files, camelCase parsed; error texts; id pattern; options 1-8; push guard over all paths incl. back-edges; `join` must follow exactly one fanout; 50-error cap | looser guard; multi-fanout joins | the guard is a safety rule (spec:608); join shape decides what a workflow can express |
| D11 | template syntax details, `.exit`, missing -> empty, trimmed conditions, truthy list | error on a missing variable | a missing variable should not kill a run |
| D12 | walker state shape, ready/skip/consume rules, visit numbering, readonly set (plan agents, control nodes, collect join), trigger has no row | Python's inbox model | spec says "kept from runner/graph.py"; this is an independent design, not a transcription |
| D13 | rows-first rounds, in-process lock, derived run status table, `maxRounds`, retry-pending steps park the run as `waiting` | run stays `running` while a retry is possible | user story 4; T6.1 A1 said the walker must not mark the run failed early |
| D14 | scope content, base/parent-worktree search (BFS, newest visit), `setupDecision` source, resume = worktree parent | other lookups | which branch a child starts from; which worktree a reviewer sees |
| D15 | carried worktree or `no worktree to run in` (never the main checkout), no pid on shell steps (a crash gives `start_unknown`), output keys | fall back to `run.repo` | a shell must not write into the main checkout by accident; never re-run a shell after a crash |
| D16 | `reject` option cancels the run; strict option check; setup gate = new attempt | `reject` only a normal choice | a default `approve/reject` gate in front of `git push` must really stop on reject |
| D17 | no BullMQ Flow; children rows created lazily; bookkeeping `waiting`; items `'1'..'N'`; cap fails instead of truncating; parked children do not count toward the limit | Flow API; truncate | spec:675 says "as a BullMQ Flow"; defs.ts says Flow is not built |
| D18 | join worktree + `merge --no-ff`, checkpoint commit, identity fallback, 20-file cap in the error | merge into the base worktree; no checkpoint | silent no-op merges; committer identity on a bare machine |
| D19 | run created `running` (second run for the owner = `409`), `ownerOf` default `userId`, `advance` hook, limits | queue the second run | spec:614 one running run per owner |
| D20 | `waiting` continue rules, resume job id suffix, auto-resume only with a parsed reset time | auto-resume always / never | spec:633 "reset time reached"; resumed steps clear `error` |
| D21 | bounded wait (8 s), `null` when no agent step started, first agent step decides | wait for completion | the calling agent needs a quick answer; spec:678 |
| D22 | no `--force` (dirty worktrees are kept and reported), which logs are archived, `kept` reasons, `scheduleCleanup` submits | force remove | an agent that did not commit would lose work |
| D23 | gunzip on the fly, `runsDir` guard | serve the `.gz` | spec:696 "streamed log" |
| D24 | new system function `runner.listActiveRuns` + allowlist entry | polling table | needed by the tick; tenancy gate stays complete |
| D25-D26 | extra gate tests; the three sample workflows, metric set, thresholds | other samples | spec:736 "metrics as today" |

## C. Places where two reasonable readers differ
1. **"Metrics as today" (spec:736).** No comparable metric file exists for the Python runner (`.claude/metric/eval/` holds only `memory/`). D26 invents the set (`status`, `steps`,
   `attempts`, `agent_steps`, `prompt_outcome`, `children`, `gate_wait_ms`, `wall_ms`, `cost_usd`). `[UNVERIFIED]` that this is what the owner meant.
2. **Join target.** Spec says "`merge` runs `git merge` of the child branches" without a target. D18 merges into a new worktree/branch of its own (`ctc/<wf>-<run>-<join>`) from the fanout's
   base. Another reader merges into the parent step's branch, which may not exist when the fanout follows a gate or a trigger.
3. **Who is "parent" in "from the parent's branch" (spec:675).** D14 takes the branch of the nearest upstream step that has one, else the run's base. Another reader takes the fanout
   step's own branch (it has none).
4. **Where a fanout lives.** D10 puts the child inline (`child:` on the fanout node) and the join directly after the fanout (one incoming edge). Another reader draws the child as a
   separate agent node between them.
5. **`reject` semantics.** Default option `reject` cancels the run (D16d). Another reader treats every option as data and lets the workflow decide.
6. **Run status while a retry is possible (D13d).** `waiting`, not `running` and not `failed`. T6.1 D14 sets `failed` only at the circuit break; the dashboard may want a separate flag.
7. **Trigger without a step row.** Spec:615 lists no row for it; Python wrote one. D12 writes none (fewer rows, nothing to retry).
8. **Check strictness.** D6 greps new sources for git words (`'reset'`, `'remove'`, `'-f'`, ...), `.transition(` and `setRunStatus(`; D10 checks exact error texts; D3 checks exact
   key sets; D22 expects `kept` reasons `dirty`; D12 expects the exact loop error text. Triage these first if a coder run fails on them. Timing-based checks (D15 cancel and timeout,
   D17 overlap, D21 handoff) can flake on a loaded machine: re-run once before treating them as defects.
9. **Config keys.** `runner.max_visits`, `runner.fanout`, `runner.worktree.keep_days` exist in the env schema (`packages/shared/src/env/schema.ts`); `fanout.max_depth` above 1 is read as 1.
