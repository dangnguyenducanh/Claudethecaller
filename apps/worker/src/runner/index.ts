/**
 * The F4 runner cold path in the worker: the `runner.step` handler (worktree, repo setup, spawn, follow, end of one agent attempt) and the
 * restart sweep. Called from: the worker main (not built yet), which binds `runnerHandlers(deps)['runner.step']` into `startWorkers({ handlers })`
 * and calls `sweepRunner(deps)` once at boot BEFORE it starts the workers; T6.3 supplies `deps.resolveNode` and `deps.onStepEnd`.
 * Why: spec:642-686. One job runs one attempt from `queued` to a final or parked status, so a crash, a timeout, a quota stop or a failure leaves a
 * record a user can retry. Deliberately NOT done: the walker, templating, approval and shell nodes, re-queueing parked steps, `git worktree remove`
 * and log archiving (T6.3), the report route (T6.1), the worker main and config loading.
 * Untrusted: the run row (`repo`, `baseBranch`, `inputs`), the rendered node, the repo's `ctc.yaml`, every byte an agent or setup script writes, and
 * every payload field except `userId`. Never: a shell for untrusted text, a force flag, a status write outside the T6.1 core, the token anywhere
 * but the agent's environment.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  advanceStage, agentArgv, buildPreamble, emptyStream, failStep, parseRepoSetup, runnerExecLimits, sweepAction, transitionStep, worktreeRecipe,
  type AgentNode,
} from '@ctc/core/runner';
import { JobDropped } from '@ctc/shared/queues';
import { createSystemCtx, type Ctx } from '@ctc/shared/repositories';
import type { Handler } from '../jobs/index.ts';
import { finalizeAttempt, follow, LogTail, markStartUnknown, readExitRecord, timeoutStep } from './follow.ts';
import { ensureExcluded, gitErrorLine, repoKey, runGit, withRepo } from './git.ts';
import { killGroup, killIfOurs, procStartTime, runGroup, scrubbedEnv } from './proc.ts';
import { parkRun } from './runstatus.ts';
import { attemptPaths, errClass, isConflict, type Run, type RunnerExecDeps, type Step } from './types.ts';

export { runGroup, procStartTime };
export type { RunnerExecDeps };

type Payload = { userId: string; runId: string; stepId: string; nodeId: string; visit: number; attempt: number; timeoutS: number };
type JobCtx = { jobId: string; attempt: number; signal: AbortSignal; setProgress(n: number): Promise<void> };
type Result = { stepId: number; status: string; skipped: boolean };

/** Thrown to unwind a handler run whose step already has its final or parked status. */
class Ended extends Error {}

const SETUP_OPTIONS = [{ id: 'run', label: 'Run setup' }, { id: 'skip', label: 'Skip setup' }];

/**
 * The fixed wrapper script (D14c). It runs the agent as a child (not `exec`) so it can write the exit record, and it is the leader of the
 * agent's process group. The exit record is written to a temp name and renamed, so a reader sees all of it or nothing.
 */
const WRAPPER = 'umask 077; f=$1; shift; "$@"; c=$?; printf "%s" "$c" > "$f.tmp" && mv "$f.tmp" "$f"';

/** `onStepEnd` completes the node (D16d); a throw is logged and swallowed. */
async function endHook(deps: RunnerExecDeps, ctx: Ctx, step: Step): Promise<void> {
  try {
    await deps.onStepEnd?.(ctx, step);
  } catch (e) {
    deps.log?.('onStepEnd failed', { stepId: step.id, error: errClass(e) });
  }
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const baseOf = (node: AgentNode | null, run: Run): string => node?.base ?? run.baseBranch ?? 'HEAD';

/** The diff-stat input of an attempt that had a worktree (D16c), or undefined. */
function diffInput(node: AgentNode | null, run: Run | null, step: Step): { worktree: string; repo: string; base: string } | undefined {
  if (node === null || run === null || node.worktree === 'none' || step.worktree === null || run.repo === null) return undefined;
  return { worktree: step.worktree, repo: run.repo, base: baseOf(node, run) };
}

/** `running → failed` (which may break the circuit, T6.1). A concurrent move of the step is left alone and the given row is returned. */
async function failNow(deps: RunnerExecDeps, ctx: Ctx, step: Step, error: string): Promise<Step> {
  try {
    return await failStep(deps.repos.runner, ctx, { step, to: 'failed', error, maxFailures: deps.config.runner.max_failures });
  } catch (e) {
    if (!isConflict(e)) throw e;
    return step;
  }
}

/** One handler run: the claimed step and the helpers that write through the T6.1 core. */
class Attempt {
  step: Step;
  readonly deps: RunnerExecDeps;
  readonly ctx: Ctx;
  readonly run: Run;
  readonly node: AgentNode;
  readonly payload: Payload;
  readonly signal: AbortSignal;
  readonly paths: ReturnType<typeof attemptPaths>;
  constructor(deps: RunnerExecDeps, ctx: Ctx, step: Step, run: Run, node: AgentNode, payload: Payload, signal: AbortSignal) {
    this.deps = deps;
    this.ctx = ctx;
    this.step = step;
    this.run = run;
    this.node = node;
    this.payload = payload;
    this.signal = signal;
    this.paths = attemptPaths(deps.runsDir, step.runId, step.id);
  }

  get port() {
    return this.deps.repos.runner;
  }

  async set(patch: Record<string, unknown>): Promise<void> {
    this.step = (await this.port.setStepFields(this.ctx, this.step.id, patch)) ?? this.step;
  }

  /** Writes the stage before its side effect. A step that is no longer `running` (cancelled) or a passed timeout ends the run quietly. */
  async stage(next: string): Promise<void> {
    if (this.signal.aborted) throw await this.timeout();
    const live = await this.port.getStep(this.ctx, this.step.id);
    if (live === null || live.status !== 'running') throw new Ended();
    this.step = await advanceStage(this.port, this.ctx, live, next);
  }

  /** `running → failed` with the exact error text (D3c); the caller throws the returned `Ended` to unwind. */
  async fail(error: string): Promise<Ended> {
    this.step = await failNow(this.deps, this.ctx, this.step, error);
    return new Ended();
  }

  async timeout(): Promise<Ended> {
    await timeoutStep(this.deps, this.ctx, this.step.id, this.payload.timeoutS);
    return new Ended();
  }
}

export function runnerHandlers(deps: RunnerExecDeps): { 'runner.step': Handler } {
  const port = deps.repos.runner;
  const cfg = () => deps.config.runner;

  /** Stage worktree (only `new`): returns the worktree path and the setup entries to run. */
  async function makeWorktree(a: Attempt): Promise<{ path: string; entries: string[] }> {
    const { run, node } = a;
    const repo = run.repo;
    if (repo === null || !path.isAbsolute(repo)) throw await a.fail('worktree failed: not a git repository');
    const base = baseOf(node, run);
    let rec: ReturnType<typeof worktreeRecipe>;
    try {
      rec = worktreeRecipe({
        repo, dir: cfg().worktree.dir, workflow: node.workflow, runId: run.id, nodeId: a.step.nodeId, stepId: a.step.id, visit: a.step.visit, attempt: a.step.attempt,
        child: node.child, base,
      });
    } catch (e) {
      if (e instanceof TypeError) throw await a.fail(`worktree failed: ${e.message}`);
      throw e;
    }
    const key = await repoKey(repo);
    const git = (args: string[], timeoutMs: number) => withRepo(key, () => runGit({ repo, args, outFile: a.paths.git, timeoutMs }));
    let inside;
    try {
      inside = await git(['rev-parse', '--is-inside-work-tree'], runnerExecLimits.gitTimeoutMs);
    } catch {
      throw await a.fail('worktree failed: not a git repository');
    }
    if (inside.code !== 0 || inside.text.trim() !== 'true') throw await a.fail('worktree failed: not a git repository');

    let entries: string[] = [];
    const show = await git(['show', `${base}:ctc.yaml`], runnerExecLimits.gitTimeoutMs).catch(() => null);
    if (show !== null && show.code === 0) {
      try {
        if (show.overflow) throw new TypeError('ctc.yaml too large');
        entries = parseRepoSetup(show.text).setup;
      } catch (e) {
        if (e instanceof TypeError) throw await a.fail('setup config invalid');
        throw e;
      }
    }
    if (entries.length > 0 && cfg().setup.policy === 'ask' && node.setupDecision !== 'run' && node.setupDecision !== 'skip') {
      await transitionStep(port, a.ctx, { stepId: a.step.id, from: 'running', to: 'waiting', patch: { options: SETUP_OPTIONS } });
      await parkRun(deps, a.ctx, a.step.runId, 'waiting');
      throw new Ended();
    }
    const runSetup = entries.length > 0 && (cfg().setup.policy === 'run' || (cfg().setup.policy === 'ask' && node.setupDecision === 'run'));

    await a.stage('worktree');
    await a.set({ worktree: rec.path, branch: rec.branch });
    const addMs = cfg().worktree.add_timeout_s * 1000;
    const add = await withRepo(key, async () => {
      await ensureExcluded({ repo, dir: cfg().worktree.dir, outFile: a.paths.git, timeoutMs: runnerExecLimits.gitTimeoutMs });
      const r = await runGit({ repo, args: rec.add, outFile: a.paths.git, timeoutMs: addMs, signal: a.signal });
      if (r.code === 0) {
        const c = await runGit({ repo, args: rec.config, outFile: a.paths.git, timeoutMs: runnerExecLimits.gitTimeoutMs });
        // judgment: the base is only a record for the later merge; a failed config write does not fail the attempt
        if (c.code !== 0) deps.log?.('branch base not recorded', { stepId: a.step.id });
      }
      return r;
    }).catch(async (e: unknown) => {
      throw await a.fail(`worktree failed: ${(e as NodeJS.ErrnoException).code ?? errClass(e)}`);
    });
    if (add.aborted) throw await a.timeout();
    if (add.timedOut) throw await a.fail(`worktree timed out after ${cfg().worktree.add_timeout_s} s`);
    if (add.code !== 0) throw await a.fail(`worktree failed: ${gitErrorLine(add)}`);
    return { path: rec.path, entries: runSetup ? entries : [] };
  }

  /** Stage setup: each entry of the repo's `setup` runs through `sh -c` in the worktree, sharing one time budget and one output cap (D13c). */
  async function runSetup(a: Attempt, worktree: string, entries: string[]): Promise<void> {
    const { timeout_s, max_output_mb } = cfg().setup;
    await a.stage('setup');
    const end = Date.now() + timeout_s * 1000;
    const cap = max_output_mb * 1024 * 1024;
    const env = scrubbedEnv({ CTC_ROOT_PATH: a.run.repo ?? '', CTC_WORKTREE_PATH: worktree });
    for (const entry of entries) {
      const used = await fs.promises.stat(a.paths.setup).then((s) => s.size, () => 0);
      const r = await runGroup({
        cmd: ['/bin/sh', '-c', entry], cwd: worktree, env, timeoutMs: Math.max(end - Date.now(), 1), maxOutputBytes: Math.max(cap - used, 0), outFile: a.paths.setup,
        signal: a.signal, onStart: async (pid) => a.set({ pid, pidStartedAt: await procStartTime(pid) }),
      });
      if (r.aborted) throw await a.timeout();
      if (r.timedOut) throw await a.fail(`setup timed out after ${timeout_s} s`);
      if (r.overflow) throw await a.fail(`setup output over ${max_output_mb} MB`);
      if (r.code !== 0) throw await a.fail(`setup failed: exit ${r.code ?? 'signal'}`);
    }
    await a.set({ pid: null, pidStartedAt: null });
  }

  /** Stage spawn: token, prompt file, the wrapper; returns the leader's pid and start time (D14). */
  async function spawnAgent(a: Attempt, argv: string[], cwd: string, worktree: string | null): Promise<{ pid: number; startedAt: Date | null }> {
    const { run, node, step } = a;
    await a.stage('spawn');
    const token = randomBytes(32).toString('hex');
    await a.set({ tokenHash: sha256(token), logPath: a.paths.log, pid: null, pidStartedAt: null });
    const preamble = buildPreamble({
      workflow: node.workflow, nodeId: step.nodeId, attempt: step.attempt, prompt: node.prompt, ...(node.resolution ? { resolution: node.resolution } : {}),
    });
    const env = scrubbedEnv({
      CTC_STEP_TOKEN: token,
      CTC_REPORT_URL: `${deps.reportBase}/api/runs/${run.id}/steps/${step.id}/report`,
      CTC_RUN_ID: String(run.id),
      CTC_STEP_ID: String(step.id),
      ...(worktree === null ? {} : { CTC_WORKTREE_PATH: worktree, ...(run.repo === null ? {} : { CTC_ROOT_PATH: run.repo }) }),
    });
    const fds: number[] = [];
    let spawned: number | string;
    let child: ReturnType<typeof spawn> | undefined;
    try {
      fs.writeFileSync(a.paths.prompt, preamble, { mode: 0o600 });
      fs.rmSync(a.paths.exit, { force: true });
      fds.push(fs.openSync(a.paths.prompt, 'r'), fs.openSync(a.paths.log, 'a', 0o600), fs.openSync(a.paths.err, 'a', 0o600));
      child = spawn('/bin/sh', ['-c', WRAPPER, 'ctc-step', a.paths.exit, ...argv], { cwd, env, detached: true, stdio: [fds[0] ?? 'ignore', fds[1] ?? 'ignore', fds[2] ?? 'ignore'] });
      const started = child;
      spawned = await new Promise<number | string>((resolve) => {
        started.once('error', (e) => resolve((e as NodeJS.ErrnoException).code ?? e.name));
        started.once('spawn', () => resolve(started.pid ?? 'ENOPID'));
      });
    } catch (e) {
      spawned = (e as NodeJS.ErrnoException).code ?? errClass(e);
    } finally {
      for (const fd of fds) fs.closeSync(fd);
    }
    child?.on('error', () => undefined);
    child?.unref();
    if (typeof spawned === 'string') throw await a.fail(`spawn failed: ${spawned}`);
    try {
      const startedAt = await procStartTime(spawned);
      await a.set({ pid: spawned, pidStartedAt: startedAt });
      await a.stage('stream');
      return { pid: spawned, startedAt };
    } catch (e) {
      await killGroup(spawned); // the agent is ours and running: no exit path may leave it (and its token) behind
      throw e;
    }
  }

  /** Runs every stage of one claimed attempt. Unwinds with `Ended` once the step has its final or parked status. */
  async function execute(a: Attempt): Promise<void> {
    const { node, run } = a;
    let argv: string[];
    try {
      const configured = Object.hasOwn(cfg().agents, node.agent) ? cfg().agents[node.agent]?.argv : undefined;
      argv = agentArgv(node.agent, configured, { permission: node.permission, model: node.model ?? null });
    } catch (e) {
      if (e instanceof TypeError) throw await a.fail(`spawn refused: ${e.message}`);
      throw e;
    }
    await fs.promises.mkdir(a.paths.dir, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(a.paths.dir, 0o700);

    let cwd: string;
    let worktree: string | null = null;
    if (node.worktree === 'new') {
      const made = await makeWorktree(a);
      worktree = made.path;
      cwd = made.path;
      if (made.entries.length > 0) await runSetup(a, made.path, made.entries);
    } else if (node.worktree === 'parent') {
      if (typeof node.parentWorktree !== 'string' || !path.isAbsolute(node.parentWorktree)) throw await a.fail('worktree failed: no parent worktree');
      worktree = node.parentWorktree;
      cwd = worktree;
      await a.set({ worktree });
    } else if (node.worktree === 'none') {
      if (run.repo === null) throw await a.fail('spawn failed: no working directory');
      cwd = run.repo;
    } else {
      throw await a.fail('worktree failed: unknown mode');
    }

    const { pid, startedAt } = await spawnAgent(a, argv, cwd, worktree);
    try {
      await follow(deps, {
        ctx: a.ctx, step: a.step, agent: node.agent, pid, pidStartedAt: startedAt, own: true, deadline: null, signal: a.signal, timeoutS: a.payload.timeoutS,
        diff: diffInput(node, run, a.step),
      });
    } catch (e) {
      await killIfOurs(pid, startedAt, true); // follow ended abnormally (DB error, conflict): the group it was watching must not outlive the attempt
      throw e;
    }
  }

  const handler = async (payload: Payload, jc: JobCtx): Promise<Result> => {
    const ctx: Ctx = { userId: payload.userId };
    const found = await port.getStep(ctx, Number(payload.stepId));
    if (found === null) throw new JobDropped('step_not_found');
    if (String(found.runId) !== payload.runId || found.nodeId !== payload.nodeId || found.visit !== payload.visit || found.attempt !== payload.attempt) {
      throw new JobDropped('payload_mismatch');
    }
    if (found.status !== 'queued') return { stepId: found.id, status: found.status, skipped: true };
    let claimed: Step;
    try {
      claimed = await transitionStep(port, ctx, { stepId: found.id, from: 'queued', to: 'running', patch: { startedAt: new Date() } });
    } catch (e) {
      if (!isConflict(e)) throw e;
      return { stepId: found.id, status: (await port.getStep(ctx, found.id))?.status ?? found.status, skipped: true };
    }

    const run = await port.getRun(ctx, claimed.runId);
    let node: AgentNode | null = null;
    try {
      node = run === null ? null : await deps.resolveNode(ctx, run, claimed);
    } catch (e) {
      deps.log?.('resolveNode failed', { stepId: claimed.id, error: errClass(e) });
    }
    try {
      if (run === null || node === null) {
        await failNow(deps, ctx, claimed, 'node not found');
        throw new Ended();
      }
      await execute(new Attempt(deps, ctx, claimed, run, node, payload, jc.signal));
    } catch (e) {
      if (!(e instanceof Ended) && !isConflict(e)) {
        deps.log?.('attempt failed unexpectedly', { stepId: claimed.id, error: errClass(e) });
        const live = await port.getStep(ctx, claimed.id);
        if (live === null || live.status !== 'running') throw e;
        try {
          await failStep(port, ctx, { step: live, to: 'failed', error: `internal error: ${errClass(e)}`, maxFailures: cfg().max_failures });
        } catch {
          throw e;
        }
      }
    }
    const final = (await port.getStep(ctx, claimed.id)) ?? claimed;
    await endHook(deps, ctx, final);
    return { stepId: final.id, status: final.status, skipped: false };
  };
  return { 'runner.step': handler };
}

/**
 * Decides what to do with every `running` step of every user after a worker restart (spec:682-686) and does it (D18). Call once at boot, BEFORE
 * the workers start. `actions` has one entry per listed step in list order; `settled` resolves when every reattached attempt has ended and never rejects.
 */
export async function sweepRunner(deps: RunnerExecDeps): Promise<{ actions: { stepId: number; action: string }[]; settled: Promise<void> }> {
  const port = deps.repos.runner;
  const rows = await deps.repos.system.runner.listRunningSteps(createSystemCtx('runner sweep'));
  const actions: { stepId: number; action: string }[] = [];
  const tasks: Promise<void>[] = [];

  async function sweepOne(row: Step): Promise<string> {
    const ctx: Ctx = { userId: (row as unknown as { userId: string }).userId };
    const paths = attemptPaths(deps.runsDir, row.runId, row.id);
    const exitCode = await readExitRecord(paths.exit);
    const startedAt = row.pid === null ? null : await procStartTime(row.pid);
    const action = sweepAction(row, { exitCode, startedAt });
    const run = await port.getRun(ctx, row.runId);
    let node: AgentNode | null = null;
    if (action !== 'fail_stage' && run !== null) node = await deps.resolveNode(ctx, run, row).catch(() => null);
    const agent = node?.agent ?? 'claude';
    const end = async (): Promise<void> => {
      const final = await port.getStep(ctx, row.id);
      if (final !== null) await endHook(deps, ctx, final);
    };

    if (action === 'fail_stage') {
      if (row.stage === 'setup') await killIfOurs(row.pid, row.pidStartedAt, false);
      try {
        await failStep(port, ctx, {
          step: row, to: 'failed', error: row.stage === null ? 'interrupted before stage worktree' : `interrupted at stage ${row.stage}`, maxFailures: deps.config.runner.max_failures,
        });
      } catch (e) {
        if (isConflict(e)) return 'skipped';
        throw e;
      }
      await end();
      return action;
    }
    const state = await new LogTail(paths.log).read(agent, emptyStream(), true);
    if (action === 'finish') {
      const known = node === null ? emptyStream() : state;
      const tail = await fs.promises.readFile(paths.err, 'utf8').then((t) => t.slice(-4096), () => '');
      await finalizeAttempt(deps, { ctx, step: row, diff: diffInput(node, run, row) }, known, exitCode, tail);
      await end();
      return action;
    }
    if (action === 'reattach') {
      const timeoutS = node?.timeoutS ?? runnerExecLimits.defaultTimeoutS;
      tasks.push(
        follow(deps, {
          ctx, step: row, agent, pid: row.pid, pidStartedAt: row.pidStartedAt, own: false, deadline: row.startedAt.getTime() + timeoutS * 1000, timeoutS,
          diff: diffInput(node, run, row),
        }).then(end, (e: unknown) => deps.log?.('reattach failed', { stepId: row.id, error: errClass(e) })),
      );
      return action;
    }
    const current = await port.getStep(ctx, row.id);
    if (current === null || current.status !== 'running') return 'skipped';
    await markStartUnknown(deps, ctx, row, state);
    const after = await port.getStep(ctx, row.id);
    if (after?.status !== 'start_unknown') return 'skipped';
    await end();
    return action;
  }

  for (const row of rows) {
    try {
      actions.push({ stepId: row.id, action: await sweepOne(row) });
    } catch (e) {
      deps.log?.('sweep step failed', { stepId: row.id, error: errClass(e) });
      actions.push({ stepId: row.id, action: 'skipped' });
    }
  }
  return { actions, settled: Promise.allSettled(tasks).then(() => undefined) };
}
export { advanceRun, execDepsOf, startRunnerLoop, tickRuns, workflowHandlers } from './engine.ts';
export type { AdvanceResult } from './engine.ts';
export { cleanupHandlers, scheduleCleanup } from './cleanup.ts';
export { engineLimits } from './common.ts';
export type { EngineDeps } from './common.ts';
