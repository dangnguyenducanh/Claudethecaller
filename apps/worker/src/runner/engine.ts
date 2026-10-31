/**
 * The F4 workflow engine (D0, D13, D20): `advanceRun` walks one run (reconcile finished steps, start what is ready, derive the run status),
 * `tickRuns` and `startRunnerLoop` call it for every active run, and `workflowHandlers` is the one `runner.step` handler for every node type that
 * runs as a job (agent through T6.2, shell, join merge). Called from: the worker main (binds the handlers, calls T6.2 `sweepRunner(execDepsOf(deps))`
 * once at boot, then starts the loop) and T6.2 (`onStepEnd`). Why: spec:589-608, 640. The walker state is saved after the rows of a round are
 * written and every insert is idempotent, so a crash between the two repeats the round harmlessly.
 * Deliberately NOT done: schedules, nested fan-out, git push, a status write outside the T6.1 core and ./runstate.ts, any SQL.
 * Untrusted: the workflow, run inputs, every step row's strings. `advanceRun` and `tickRuns` never reject for a workflow or step problem.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import {
  REJECT_OPTION, RunnerError, cancelRun, continueRun, deriveRunStatus, evalCondition, isCurrentAttempt, renderTemplate, runnerJobId, transitionStep,
  walkerComplete, walkerNext, walkerStart, walkerStatus, type CurrentStep, type Workflow, type WorkflowNode, type WalkerState,
} from '@ctc/core/runner';
import { JobDropped } from '@ctc/shared/queues';
import { createSystemCtx, type Ctx } from '@ctc/shared/repositories';
import type { Handler } from '../jobs/index.ts';
import { resolveAgentNode } from './agent.ts';
import {
  Ended, FINAL_RUN, cut, currentOf, engineLimits, failNow, loadWorkflow, nextAttempt, nodeFor, nowOf, scopeFor, submitStep, timeoutOf, type EngineDeps,
} from './common.ts';
import { reconcileFanout, startFanout } from './fanout.ts';
import { collectJoin, runJoin } from './join.ts';
import { runnerHandlers, type RunnerExecDeps } from './index.ts';
import { writeRunStatus } from './runstate.ts';
import { runShell } from './shell.ts';
import { attemptPaths, errClass, isConflict, isObject, sleep, type Run, type Step } from './types.ts';

export { engineLimits } from './common.ts';
export type { EngineDeps } from './common.ts';

export type AdvanceResult = { status: string | null; started: string[]; skipped: string[] };
type Env = { deps: EngineDeps; ctx: Ctx; run: Run; wf: Workflow; steps: Step[] };

/** The deps T6.2 needs: the engine supplies `resolveNode` and `onStepEnd` (D0a). Also what the worker main gives `sweepRunner`. */
export function execDepsOf(deps: EngineDeps): RunnerExecDeps {
  return {
    repos: deps.repos, config: deps.config, runsDir: deps.runsDir, reportBase: deps.reportBase,
    ...(deps.log === undefined ? {} : { log: deps.log }),
    resolveNode: (ctx, run, step) => resolveAgentNode(deps, ctx, run, step),
    onStepEnd: async (ctx, step) => void (await advanceRun(deps, ctx, step.runId)),
  };
}

// ---- nodes the engine runs itself ---------------------------------------------------------------------------------------

async function runInline(env: Env, node: WorkflowNode, step: Step): Promise<void> {
  const { deps, ctx, run, wf, steps } = env;
  const port = deps.repos.runner;
  let row = step;
  if (row.status === 'queued') {
    try {
      row = await transitionStep(port, ctx, { stepId: row.id, from: 'queued', to: 'running', patch: { startedAt: nowOf(deps) } });
    } catch (e) {
      if (!isConflict(e)) throw e;
      return;
    }
  }
  if (row.status !== 'running') return;
  const finish = (output: Record<string, unknown>) =>
    transitionStep(port, ctx, { stepId: row.id, from: 'running', to: 'done', patch: { output: { outcome: 'done', ...output }, endedAt: nowOf(deps) } });
  try {
    switch (node.type) {
      case 'if': {
        const scope = scopeFor(wf, run, steps);
        const handle = String(evalCondition(node.op, cut(renderTemplate(node.left, scope).text), cut(renderTemplate(node.right, scope).text)));
        await finish({ summary: handle, handle });
        break;
      }
      case 'merge': await finish({ summary: '' }); break;
      case 'join': await collectJoin(deps, ctx, wf, steps, row, node); break;
      case 'approval': {
        const question = cut(renderTemplate(node.question, scopeFor(wf, run, steps)).text);
        await transitionStep(port, ctx, { stepId: row.id, from: 'running', to: 'waiting', patch: { options: node.options ?? [], output: { question } } });
        break;
      }
      case 'fanout': await startFanout(deps, ctx, run, wf, steps, row, node); break;
      default: await failNow(deps, ctx, row, `node ${node.id}: not an inline node`, 'failed', undefined, 1);
    }
  } catch (e) {
    if (isConflict(e)) return;
    const live = await port.getStep(ctx, row.id);
    // judgment: a node the engine runs inline has nothing to retry, so its failure breaks the circuit at once.
    if (live !== null && live.status === 'running') await failNow(deps, ctx, live, errClass(e), 'failed', undefined, 1);
  }
}

/** Inserts attempt 1 of `(node, visit)` and, by type, submits the job or runs the node inline. A repeat finds the row and does nothing twice. */
async function startNode(env: Env, node: WorkflowNode, visit: number): Promise<void> {
  const { deps, ctx, run } = env;
  const { step } = await deps.repos.runner.insertStep(ctx, { runId: run.id, nodeId: node.id, visit, attempt: 1, failureCount: 0, status: 'queued' });
  const asJob = node.type === 'agent' || node.type === 'shell' || (node.type === 'join' && node.strategy !== 'collect');
  if (!asJob) return runInline(env, node, step);
  if (step.status === 'queued') await submitStep(deps, ctx, step, node.type === 'join' ? engineLimits.mergeTimeoutS : (node.timeoutS ?? 1800));
}

// ---- reconcile ----------------------------------------------------------------------------------------------------------

type Reconciled = { state: WalkerState; progressed: boolean; cancel?: true; error?: string };

async function reconcile(env: Env, state: WalkerState, nodeId: string, visit: number): Promise<Reconciled> {
  const { deps, ctx, wf, steps } = env;
  const node = nodeFor(wf, nodeId);
  const done = (r: { state: WalkerState; error: string | null }): Reconciled => ({ state: r.state, progressed: true, ...(r.error === null ? {} : { error: r.error }) });
  if (node === null) return done(walkerComplete(wf, state, nodeId, { ok: false }));
  const cur = currentOf(steps, nodeId, visit);
  if (cur === undefined) {
    await startNode(env, node, visit);
    return { state, progressed: false };
  }
  if (node.type === 'fanout' && cur.status === 'waiting') return { state, progressed: await reconcileFanout(deps, ctx, wf, node, cur, steps) };
  switch (cur.status) {
    case 'done': {
      if (node.type === 'approval' && cur.resolution === REJECT_OPTION) return { state, progressed: true, cancel: true };
      if (node.type === 'agent' && cur.stage === null && cur.options !== null) {
        await nextAttempt(deps, ctx, wf, cur);
        return { state, progressed: true };
      }
      const handle = node.type === 'if' && isObject(cur.output) ? String(cur.output['handle'] ?? '') : undefined;
      return done(walkerComplete(wf, state, nodeId, { ok: true, handle }));
    }
    case 'circuit_broken':
    case 'cancelled':
      return done(walkerComplete(wf, state, nodeId, { ok: false }));
    default:
      return { state, progressed: false };
  }
}

/** The current attempt of every started-not-completed node, plus the current children of a running fan-out (D13d). */
function currentSteps(wf: Workflow, state: WalkerState, steps: readonly Step[]): CurrentStep[] {
  const out: CurrentStep[] = [];
  for (const [nodeId, visit] of Object.entries(state.running ?? {})) {
    const cur = currentOf(steps, nodeId, visit);
    if (cur === undefined) continue;
    const fanout = nodeFor(wf, nodeId)?.type === 'fanout';
    out.push({ nodeId, status: cur.status, bookkeeping: fanout && cur.status === 'waiting' });
    if (!fanout) continue;
    const kids = new Map<string, Step>();
    for (const k of steps.filter((s) => s.parentStepId === cur.id)) if ((kids.get(k.nodeId)?.attempt ?? 0) < k.attempt) kids.set(k.nodeId, k);
    for (const k of kids.values()) out.push({ nodeId: k.nodeId, status: k.status, bookkeeping: false });
  }
  return out;
}

// ---- advanceRun ---------------------------------------------------------------------------------------------------------

async function advanceLocked(deps: EngineDeps, ctx: Ctx, runId: number): Promise<AdvanceResult> {
  const port = deps.repos.runner;
  const out: AdvanceResult = { status: null, started: [], skipped: [] };
  let run = await port.getRun(ctx, runId);
  if (run === null) return out;
  out.status = run.status;
  if (FINAL_RUN.includes(run.status)) return out;
  const wf = await loadWorkflow(deps, ctx, run);
  if (wf === null) {
    deps.log?.('workflow unloadable', { runId });
    const failed = await writeRunStatus(port, ctx, runId, 'failed', {
      endedAt: nowOf(deps), state: { ...(isObject(run.state) ? run.state : {}), error: 'workflow unloadable' },
    });
    out.status = failed?.status ?? run.status;
    return out;
  }
  if (run.status === 'queued') {
    const moved = await writeRunStatus(port, ctx, runId, 'running', run.startedAt === null ? { startedAt: nowOf(deps) } : {});
    if (moved === null || moved.status !== 'running') return { ...out, status: moved?.status ?? run.status };
    run = moved;
  }
  const original = run.state;
  let state: WalkerState = isObject(original) && original['started'] === true ? (original as WalkerState) : walkerStart(wf);
  let hitMax = true;
  for (let round = 0; round < engineLimits.maxRounds; round++) {
    const fresh = await port.getRun(ctx, runId);
    if (fresh === null || FINAL_RUN.includes(fresh.status)) return { ...out, status: fresh?.status ?? null };
    const env: Env = { deps, ctx, run: fresh, wf, steps: await port.listSteps(ctx, runId) };
    let progressed = false;
    for (const [nodeId, visit] of Object.entries(state.running ?? {})) {
      const r = await reconcile(env, state, nodeId, visit);
      if (r.cancel === true) {
        const { run: cancelled } = await cancelRun(port, ctx, runId);
        return { ...out, status: cancelled.status };
      }
      if (r.error !== undefined) deps.log?.('walker error', { runId, error: r.error });
      state = r.state;
      progressed ||= r.progressed;
    }
    const next = walkerNext(wf, state);
    state = next.state;
    for (const s of next.skip) {
      const { step } = await port.insertStep(ctx, { runId, nodeId: s.nodeId, visit: s.visit, attempt: 1, failureCount: 0, status: 'queued' });
      if (step.status === 'queued') {
        await transitionStep(port, ctx, { stepId: step.id, from: 'queued', to: 'skipped', patch: { endedAt: nowOf(deps) } }).catch((e: unknown) => {
          if (!isConflict(e)) throw e;
        });
      }
      out.skipped.push(s.nodeId);
    }
    for (const s of next.start) {
      const node = nodeFor(wf, s.nodeId);
      if (node === null) continue;
      await startNode(env, node, s.visit);
      out.started.push(s.nodeId);
    }
    progressed ||= next.start.length > 0 || next.skip.length > 0;
    if (!progressed) {
      hitMax = false;
      break;
    }
  }
  if (hitMax) {
    deps.log?.('advanceRun stopped at maxRounds', { runId });
    state = { ...state, error: state.error ?? 'maxRounds' };
  }
  const steps = await port.listSteps(ctx, runId);
  const status = deriveRunStatus({ walker: walkerStatus(wf, state), current: currentSteps(wf, state, steps) });
  const patch: Record<string, unknown> = {};
  if (JSON.stringify(state) !== JSON.stringify(original)) patch['state'] = state;
  if (run.startedAt === null) patch['startedAt'] = nowOf(deps);
  if (status === 'done' || status === 'failed') patch['endedAt'] = nowOf(deps);
  const stored = await writeRunStatus(port, ctx, runId, status, patch);
  out.status = stored?.status ?? status;
  return out;
}

const locks = new Map<string, Promise<void>>();

/**
 * Idempotent and safe from several places at once (D13): calls for one `(user, run)` run one after the other in this process, and every row it
 * writes is an idempotent insert. Resolves `{ status, started, skipped }`; `status` is `null` when the run is not visible. Never rejects.
 */
export function advanceRun(deps: EngineDeps, ctx: Ctx, runId: number): Promise<AdvanceResult> {
  const key = `${ctx.userId}\0${runId}`;
  const run = (locks.get(key) ?? Promise.resolve()).then(async (): Promise<AdvanceResult> => {
    try {
      return await advanceLocked(deps, ctx, runId);
    } catch (e) {
      deps.log?.('advanceRun failed', { runId, error: errClass(e) });
      return { status: null, started: [], skipped: [] };
    }
  });
  const tail = run.then(() => undefined);
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

// ---- tick and loop ------------------------------------------------------------------------------------------------------

const RESET = /^usage limit until (\S+)$/;

/** D20: a `quota` run whose quota steps all carry a reset time that has passed is resumed like the continue route does. */
async function autoResume(deps: EngineDeps, ctx: Ctx, run: Run): Promise<void> {
  const port = deps.repos.runner;
  const steps = await port.listSteps(ctx, run.id);
  const parked = steps.filter((s) => s.status === 'quota' && isCurrentAttempt(s, steps));
  const now = nowOf(deps).getTime();
  if (parked.length === 0 || !parked.every((s) => now >= Date.parse(RESET.exec(s.error ?? '')?.[1] ?? 'x'))) return;
  const wf = await loadWorkflow(deps, ctx, run);
  if (wf === null) return;
  let resumed: Step[];
  try {
    resumed = (await continueRun(port, ctx, { runId: run.id })).resumed;
  } catch (e) {
    if (e instanceof RunnerError) return;
    throw e;
  }
  for (const s of resumed) await submitStep(deps, ctx, s, timeoutOf(wf, s.nodeId), `${runnerJobId(s)}:resume:${randomUUID()}`);
}

/** Advances every active run once, one at a time; an error is logged and the next run goes on. */
export async function tickRuns(deps: EngineDeps): Promise<{ advanced: number[] }> {
  const runs = await deps.repos.system.runner.listActiveRuns(createSystemCtx('runner tick'));
  const advanced: number[] = [];
  for (const row of runs) {
    const ctx: Ctx = { userId: row.userId };
    try {
      if (row.status === 'quota') await autoResume(deps, ctx, row);
      await advanceRun(deps, ctx, row.id);
      advanced.push(row.id);
    } catch (e) {
      deps.log?.('tick failed for a run', { runId: row.id, error: errClass(e) });
    }
  }
  return { advanced };
}

/** Calls `tickRuns` every `engineLimits.tickMs`, never two at once. `stop()` waits for the tick in flight. */
export function startRunnerLoop(deps: EngineDeps): { stop(): Promise<void> } {
  let stopped = false;
  let wake: (() => void) | undefined;
  const loop = (async (): Promise<void> => {
    while (!stopped) {
      try {
        await tickRuns(deps);
      } catch (e) {
        deps.log?.('tick failed', { error: errClass(e) });
      }
      if (stopped) break;
      await Promise.race([sleep(engineLimits.tickMs), new Promise<void>((r) => (wake = r))]);
    }
  })();
  return {
    async stop() {
      stopped = true;
      wake?.();
      await loop;
    },
  };
}

// ---- the runner.step handler --------------------------------------------------------------------------------------------

type Payload = { userId: string; runId: string; stepId: string; nodeId: string; visit: number; attempt: number; timeoutS: number };
type JobCtx = { jobId: string; attempt: number; signal: AbortSignal; setProgress(n: number): Promise<void> };
type Result = { stepId: number; status: string; skipped: boolean };

/** One handler for every node type that runs as a job: shell and join `merge` here, every other node (agent, fan-out child) through T6.2. */
export function workflowHandlers(deps: EngineDeps): { 'runner.step': Handler } {
  const port = deps.repos.runner;
  const agentHandler = runnerHandlers(execDepsOf(deps))['runner.step'] as unknown as (p: Payload, c: JobCtx) => Promise<Result>;

  const handler = async (payload: Payload, jc: JobCtx): Promise<Result> => {
    const ctx: Ctx = { userId: payload.userId };
    const found = await port.getStep(ctx, Number(payload.stepId));
    if (found === null) throw new JobDropped('step_not_found');
    if (String(found.runId) !== payload.runId || found.nodeId !== payload.nodeId || found.visit !== payload.visit || found.attempt !== payload.attempt) {
      throw new JobDropped('payload_mismatch');
    }
    const run = await port.getRun(ctx, found.runId);
    const wf = run === null ? null : await loadWorkflow(deps, ctx, run);
    const node = wf === null ? null : nodeFor(wf, found.nodeId);
    const mine = node !== null && (node.type === 'shell' || (node.type === 'join' && node.strategy !== 'collect'));
    if (!mine || run === null || wf === null) {
      // judgment: a queued step that already has a worktree is a resumed attempt (quota, D20); its old stream log is set aside so the
      // follower does not read the earlier usage-limit event again.
      if (found.status === 'queued' && found.worktree !== null) {
        const log = attemptPaths(deps.runsDir, found.runId, found.id).log;
        await fs.promises.rename(log, `${log}.${Date.now()}.prev`).catch(() => undefined);
      }
      return agentHandler(payload, jc);
    }
    if (found.status !== 'queued') return { stepId: found.id, status: found.status, skipped: true };
    let claimed: Step;
    try {
      claimed = await transitionStep(port, ctx, { stepId: found.id, from: 'queued', to: 'running', patch: { startedAt: nowOf(deps) } });
    } catch (e) {
      if (!isConflict(e)) throw e;
      return { stepId: found.id, status: (await port.getStep(ctx, found.id))?.status ?? found.status, skipped: true };
    }
    try {
      const args = { ctx, step: claimed, run, wf, node, signal: jc.signal };
      await (node.type === 'shell' ? runShell(deps, args) : runJoin(deps, args));
    } catch (e) {
      if (!(e instanceof Ended) && !isConflict(e)) {
        deps.log?.('step failed unexpectedly', { stepId: claimed.id, error: errClass(e) });
        const live = await port.getStep(ctx, claimed.id);
        if (live === null || live.status !== 'running') throw e;
        await failNow(deps, ctx, live, `internal error: ${errClass(e)}`);
      }
    }
    const final = (await port.getStep(ctx, claimed.id)) ?? claimed;
    await advanceRun(deps, ctx, final.runId);
    return { stepId: final.id, status: final.status, skipped: false };
  };
  return { 'runner.step': handler as unknown as Handler };
}
