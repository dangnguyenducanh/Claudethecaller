# T6.2 planner notes: what the owner reviews in the final PR

Drafted: `agent/t6-2-runner-exec/` (SPEC, DECISIONS D0-D21, PROCESS, checks.mjs, selfcheck.py). YOUR-CHOICE lines: 22 (every one a default under O11).
No new FROM-OWNER rule was needed. A previous planner run had already written DECISIONS.md; it was reviewed against the callers (names, line
numbers, T6.1 core signatures, `repos.runner` columns, env schema defaults) and kept. Two edits: D11 now records the codex evidence below, D14f now
says a missing agent binary ends as `exit 127` (the shell wrapper), not as a spawn error.
Status: `checks.mjs` and `selfcheck.py` run and FAIL cleanly (module not built: every id fails with "apps/worker/src/runner/index.ts is missing").
The checks were never run against an implementation. Only their fixtures were exercised: the fake agent (modes ok, noise, fail, suicide), the
throwaway git repo, `createRun`/`insertStep`/`setRunStatus`/`listRunningSteps` with `pid`, `pidStartedAt`, `logPath`, `startedAt`, `stage` on the
scratch DB. Expect a few planner mistakes; triage after the first coder run (fix the check, not the code, when a check contradicts DECISIONS.md).
Orchestrator before the coder starts: `python3 agent/t6-2-runner-exec/selfcheck.py --snapshot`; env from `.ctc-dev/env.sh` (`CTC_SCRATCH_PG_URL`).
`KNOWN_RED` (schema-assumptions) is carried over from T6.1; it only matters if that test is still red at the base.

## The `codex exec --json` open item (spec §10, "check before T6.2")
- Verified on this machine: `codex exec --json` exists ("Print events to stdout as JSONL"), `--sandbox read-only|workspace-write|danger-full-access` and
  `--model` exist (codex-cli 0.114.0 on PATH). Failure shapes `error {message}`, `turn.failed {error:{message}}`, `thread.started {thread_id}`,
  exit code 1 were seen in a real run (previous planner run, no login). The event names `thread.started`, `turn.started`, `turn.completed`,
  `turn.failed`, `item.started`, `item.updated`, `item.completed`, `error` and the keys `thread_id`, `usage`, `input_tokens`, `cached_input_tokens`
  are strings inside the codex 0.164.0 binary (grep -a on the VS Code extension copy).
- NOT verified: `item.completed` with `item.type == "agent_message"` and `text`, and the keys inside `usage` (no valid codex login, so no successful run).
  Outcome: the spec item stays `[UNVERIFIED]` for those two shapes. The reader is tolerant: unknown events are counted and ignored; with no
  `agent_message` the summary is null and the step still ends by exit code (done with a null summary, or failed). Nothing breaks if the shape differs.
- Claude CLI 2.1.316 (installed): `--permission-mode` choices include `acceptEdits`, `dontAsk`, `plan` (the three PERMISSIONS) and `bypassPermissions`
  (refused); `--verbose` exists. That stream-json needs `--verbose` with `-p` is not re-proved here (no API call made); D10 adds it, harmless either way.

## A. Highest risk (ordered by blast radius)
1. **Seams to T6.3 and the worker main.** The module is correct only if the caller (a) runs `sweepRunner` before `startWorkers`, (b) supplies
   `resolveNode` (the rendered agent node, incl. `setupDecision` and `resolution`) and `onStepEnd` (completes the node), and (c) re-queues parked steps.
   Nobody in spec §8 owns the worker main/config wiring before T6.3. A step parked by setup `ask`, `quota` or `start_unknown` stays parked until T6.3's
   `continue`/retry acts; if T6.3 does not re-queue with `setupDecision`, an `ask` step waits forever. Default: T6.3 owns all of it (D7, D0).
2. **Agent env scrub (D1c).** Default: drop every `CTC_*` variable from the agent and setup environment so the worker's database and Redis URLs never
   reach repo code. Cost: a user hook inside the agent that calls the ctc daemon through `CTC_HOME`/`CTC_PORT` (dev stack: `CTC_HOME=.ctc-dev`, port
   18410) no longer finds it. Alternative: allow-list `CTC_HOME` and `CTC_PORT`. Reviewer should decide before T7.1 installs hooks.
3. **Exit record through a `sh` wrapper (D14c) and `/proc` (D9, D18).** Survival of the agent after a worker crash and the `finish`/`reattach`/`start_unknown`
   split depend on a detached group leader that writes `<step>.exit`, and on `/proc/<pid>/stat` start times (Linux only, 1 s tolerance). pid reuse inside
   the tolerance is accepted. Alternative: a Node supervisor process (more code, same limits). The three `runner.crash` gate tests exercise exactly this.
4. **One attempt budget (D17).** `timeoutS` bounds worktree + setup + agent together via the job's abort signal; setup has its own 120 s, worktree 180 s.
   A slow `git worktree add` eats into an agent's 1,800 s. Alternative: separate budgets (needs a second timer in the handler).

## B. YOUR-CHOICE items (D-id: default | alternative | why it matters)
| D | Default | Alternative | Why it matters |
|---|---|---|---|
| D0 | deps seam `resolveNode`/`onStepEnd`; sweep before `startWorkers` | handler loads the workflow itself | T6.3 owns rendering; keeps this module free of the workflow file format |
| D1 | `CTC_*` scrub; only two `sh -c` (wrapper, repo setup) | pass the env through | secrets of the worker reach repo code; see A2 |
| D2 | all `runnerExecLimits` numbers (5 s kill grace, 250 ms tail, 2 s status poll, 30 s/10 s exit grace, 1 s pid tolerance, 20,000/2,000 cuts, 1,800 default) | other numbers | latency of cancel/report vs CPU; all are module constants read at call time |
| D3 | result `{stepId,status,skipped}`; error texts; log fields | other shapes | the Runs page shows `error`; T6.3 reads `status` |
| D4 | drop vs fail split: unknown/mismatched step drops, unsafe input fails the attempt | drop on unsafe input | a failed attempt is retryable and visible; a drop is silent |
| D5 | tolerant list (no ctc.yaml, blank setup, noisy stream, silent agent exits 0 as done) | fail a silent agent | spec says exit 0 without report is done |
| D6 | git word ban list, kill-only-if-start-time-matches | trust review | the destructive-action safety net |
| D7 | non-goal split with T6.3/later | T6.2 also re-queues quota | task sizes |
| D9 | names, file split, `RunnerExecDeps` shape, `AgentNode` fields | other shapes | T6.3 builds against them |
| D10 | `--verbose` auto-added; codex sandbox mapping (`plan`→read-only, else workspace-write); model pattern; prompt on stdin | model passthrough; codex `--full-auto` | `dontAsk` has no codex equivalent; workspace-write is the least permissive that can edit |
| D11 | field mapping; usage-limit regex `/usage limit\|hit your (\w+ )?limit/i`; codex shapes | stricter regex | false quota would park a healthy step; seen real text: "You've hit your session limit · resets 3pm" |
| D12 | branch suffixes `-v<visit>`/`-a<attempt>`; `clean` rule (60 chars); base fallback `HEAD`; `info/exclude` line | reuse the kept branch on retry | spec name alone collides on retry; D6d forbids force or checkout of an existing branch |
| D13 | `ctc.yaml` read from `<base>` by `git show`; string or array; one shared budget; `ask` parks the step before any git write | read from the new worktree | Orca refuses `ask` before any git work; reading from base means the script that runs is the committed one |
| D14 | wrapper, file names, env names beyond `CTC_STEP_TOKEN`, stdin prompt, dir 0700/files 0600 | argv prompt | argv shows in `ps`; stdin does not |
| D15 | polling, grace periods, vanished leader -> `start_unknown` | kill-and-fail | "never act on absence" (spec:686) |
| D16 | report wins over exit; `onStepEnd` once; diffStat is `git diff --shortstat <base>` | `base...HEAD` including commits | an agent that commits would show no diff with the default; see C3 |
| D17 | one budget through the abort signal | per-stage budgets | see A4 |
| D18 | `finish` on an exit record; stage null = interrupted; orphan setup killed; `promptOutcome` values | always `start_unknown` | decides retry vs user choice after a crash |
| D19 | TERM, 5 s, KILL | KILL at once | agents flush the log on TERM |
| D20 | run status only to waiting/quota, guarded | walker owns all | avoids a second run-status writer next to T6.3 |
| D21 | third gate test, child-process method for the crash | `process.kill` of the same process | the crash must be a real SIGKILL of the handler's process |

## C. Places where two reasonable readers differ
1. **Spawn error vs `exit 127`** (D14f): with the `sh` wrapper a missing agent binary exits 127 and is reported as `exit 127: ...`. Another reader pre-checks PATH and
   reports `spawn failed: ENOENT`. The check accepts both.
2. **Where `ctc.yaml` comes from** (D13a): base ref via `git show` (default) or the new worktree. Spec 5.5 says "if the repo has ctc.yaml" and runs "in the worktree".
3. **diffStat base** (D16c): `git diff --shortstat <base>` compares the worktree files to the base, so committed and uncommitted changes both count and untracked
   files do not. Another reader uses `<base>...<branch>` (commits only).
4. **Stage null in the sweep** (D18): spec 5.8 lists only worktree/setup/spawn/stream. Default fails a null stage as "interrupted before stage worktree" (safe to retry).
5. **Exit record vs live pid** (D18): spec says only "live pid matching pid_started_at -> reattach". Default adds `finish` when an exit record exists, so a finished agent is not
   left as `start_unknown`. A reader following the spec text to the letter has no `finish` action; the check pins the default.
6. **Policy per repo** (spec 5.5 "per repo"): D7 keeps the one global `runner.setup.policy`; a per-repo map is a later change.
7. **`resolution` on resume**: the node carries `resolution` and `setupDecision`; how T6.3 puts them there is its design.
8. **Check strictness**: D6 greps worker sources for git words (`'-f'`, `'reset'`, `'remove'`, ...) and `.transition(`; a coder using such a quoted word for another purpose will trip it.
   D9 expects `index.ts` to change only by `export ... from` lines. D13 expects the ask/option texts exactly. Triage these first if a coder run fails on them.
