# Task: build the F4 runner cold path: the worktree recipe, the repo setup hook, the agent registry (claude, codex), the stream reader, the report token, the attempt handler `runner.step` and the restart sweep.

Callers (built later, or by T6.1): the worker main binds `runnerHandlers(deps)['runner.step']` into `startWorkers({ handlers })` and calls `sweepRunner(deps)` once at boot before it starts the workers; `runAttempt` (`apps/worker/src/jobs/consumers.ts`) calls the handler with a validated `runner.step` payload and an `AbortSignal` that fires at `timeoutS`; T6.3 supplies `deps.resolveNode` / `deps.onStepEnd` and reuses `runGroup` for shell nodes; the agent process POSTs its result to the T6.1 report route with the step token this module issues. All SQL goes through `repos.runner` (T1.3); every status write goes through the T6.1 core (`transitionStep`, `failStep`, `advanceStage`). Untrusted: the run row's `repo`/`baseBranch`/`inputs`, the rendered node (workflow text and user inputs), the repo's `ctc.yaml`, every byte an agent or a setup script writes, and the `runner.step` payload except `userId`. The gate is the Vitest test `runner.crash` (reattach to a live agent after the worker is killed; `start_unknown` when the agent died with the worker; a step interrupted in the worktree or setup stage fails).

Public names (TypeScript strict; exact shapes in DECISIONS.md D3, D9-D20):

    packages/core/src/runner/exec.ts (+ more files if needed), re-exported from index.ts by added `export ... from` lines only (`@ctc/core/runner`; pure: no node:*, no I/O):
      AGENTS, PERMISSIONS, runnerExecLimits, agentArgv(agent, base, {permission, model?}), emptyStream(), readStreamLine(agent, state, line),
      worktreeRecipe({...}), parseRepoSetup(text), buildPreamble({...}), sweepAction(step, probe), exitOutcome({exitCode, stream, stderrTail?});
      types StreamState, AgentNode
    apps/worker/src/runner/index.ts:
      runnerHandlers(deps: RunnerExecDeps): { 'runner.step': Handler }
      sweepRunner(deps): Promise<{ actions, settled }>
      runGroup(o): Promise<{ code, timedOut, overflow, aborted }>      // argv in, new process group, output capped, group kill
      procStartTime(pid): Promise<Date | null>                          // /proc/<pid>/stat, null for dead or zombie
      type RunnerExecDeps

## How to work
1. `agent/t6-2-runner-exec/DECISIONS.md` is the behaviour contract. Implement exactly that.
2. `agent/t6-2-runner-exec/PROCESS.md` is the order of work.
3. Change only:
   - `packages/core/src/runner/` : new source files, new `*.test.ts` files, and `index.ts` by ADDED `export ... from` lines (no other line of `index.ts`, no change to the T6.1 files `index.ts` logic or `runner.test.ts`);
   - `apps/worker/src/runner/` : source and `*.test.ts` files (new directory).
   No new dependency, no `package.json` or lockfile change (`yaml` is already a dependency of `@ctc/core`; use `node:*` and `@ctc/shared` in the worker). Never import `pg`/`kysely` outside `packages/shared/src/repositories` (ESLint bans it); SQL only through `deps.repos`.
   Preconditions the orchestrator provides: dependencies installed; the scratch Postgres `127.0.0.1:18304` (env `CTC_SCRATCH_PG_URL`) is running and `migrate({url, schema})` from `@ctc/shared/repositories/admin` builds a scratch schema; `git`, `/bin/sh` and `node` are on PATH. You may start `git`, `/bin/sh` and `node` (a fake agent script you write in a temp dir) in throwaway directories under `os.tmpdir()`. Never start the real `claude` or `codex`, never read or write `~/.claude` or `~/.claudethecaller`, never touch port 18310, Redis, Supabase or any container, never run git in the main clone or against this repository (tests use throwaway repos), never use `pkill -f` (kill the groups your own tests started, by pid). Run every test command under `timeout`. Dev runs use `CTC_HOME=$PWD/.ctc-dev`.

Test naming (the self-check's `--fast` skips slow files by name): tests that need the scratch Postgres, git or child processes are `*.int.test.ts`; pure tests (fake ports, no process) are `*.test.ts`. Scratch schemas are named `ctc_t62_<random>` and dropped in `afterAll`; temp directories start with `ctc-t62-`; every process a test starts is killed in `afterAll`.

## Done
The gate test file exists with exactly these names (DECISIONS.md D21): `apps/worker/src/runner/runner.crash.int.test.ts` with `describe('runner.crash')` and
`it('reattaches to a live agent after the worker is killed mid-step')`, `it('marks the step start_unknown when the agent died with the worker')`,
`it('fails an attempt interrupted in the worktree or setup stage')`.

`python3 agent/t6-2-runner-exec/selfcheck.py` prints `SELFCHECK: DONE`.
