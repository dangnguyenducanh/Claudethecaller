/**
 * Shared pieces of the workflow engine (D9, D13-D15): `EngineDeps`, the limits object, the default workflow loader, the scope and upstream
 * searches that engine, shell, join and fan-out all need, and the small step helpers. Called from: ./engine.ts, ./shell.ts, ./join.ts,
 * ./fanout.ts, ./agent.ts, ./cleanup.ts. Why: one definition of "the latest finished output of a node" and "the nearest upstream worktree".
 * Deliberately NOT done: any status write other than through the T6.1 core, any SQL (only `deps.repos`), any queue other than `deps.submit`.
 * Untrusted: the workflow text, run inputs, and every string stored in a step row (branches, worktrees, output).
 */
import { bodyOf, mainPathOf } from '@ctc/core/library';
import {
  failStep, isRef, outText, parseWorkflow, runnerJobId, scopeOf, timeoutOf, workflowLimits, type Workflow, type WorkflowNode,
} from '@ctc/core/runner';
import path from 'node:path';
import type { Ctx } from '@ctc/shared/repositories';
import type { Run, RunnerExecDeps, Step } from './types.ts';
import { errClass, isConflict, isObject as isObj } from './types.ts';

export type EngineDeps = Omit<RunnerExecDeps, 'resolveNode' | 'onStepEnd' | 'config'> & {
  config: {
    runner: RunnerExecDeps['config']['runner'] & {
      max_visits: number; worktree: { add_timeout_s: number; dir: string; keep_days: number }; fanout: { max_depth: number; max_parallel: number };
    };
  };
  submit(input: { queue: string; kind: string; payload: unknown; id?: string }): Promise<{ id: string }>;
  loadWorkflow?(ctx: Ctx, run: Run): Promise<Workflow | null>;
  now?(): Date;
};

/**
 * Read at call time so a test can change and restore it (D2). `tickMs` period of the loop; `maxRounds` bound on the rounds of one `advanceRun`;
 * `shellOutputMaxBytes` cap of a shell node's output file (inclusive); `watchMs` how often a running shell or join re-reads its step;
 * `mergeTimeoutS` budget of one join. Every number is chosen by judgment.
 */
export const engineLimits = { tickMs: 2000, maxRounds: 1000, shellOutputMaxBytes: 10485760, watchMs: 1000, mergeTimeoutS: 600 };

/** Thrown to unwind a handler whose step already has its final status. */
export class Ended extends Error {}

export const FINAL_RUN = ['done', 'failed', 'cancelled'];
export const nowOf = (deps: EngineDeps): Date => deps.now?.() ?? new Date();

/** The pinned version of the run's workflow (D9), parsed; any failure is `null`. */
export async function loadWorkflow(deps: EngineDeps, ctx: Ctx, run: Run): Promise<Workflow | null> {
  try {
    if (deps.loadWorkflow !== undefined) return await deps.loadWorkflow(ctx, run);
    if (run.workflowCapId === null) return null;
    const lib = deps.repos.library;
    const version = await lib.getVersion(ctx, run.workflowCapId, run.workflowVersion);
    if (version === null) return null;
    const main = mainPathOf((await lib.manifest(ctx, version.id)).map((m) => m.path));
    const content = main === null ? null : await lib.getBlob(ctx, version.id, main);
    if (main === null || content === null) return null;
    const parsed = parseWorkflow(bodyOf('workflow', main, content), { maxVisits: deps.config.runner.max_visits });
    return parsed.ok ? parsed.workflow : null;
  } catch (e) {
    deps.log?.('workflow load failed', { runId: run.id, error: errClass(e) });
    return null;
  }
}

/** A node of the workflow by step node id; a fan-out child id gives the fan-out node and the child's index. */
export function nodeFor(wf: Workflow, nodeId: string): WorkflowNode | null {
  return wf.nodes.find((n) => n.id === nodeId) ?? null;
}

/** Newest first: visit, then attempt, then id. */
export const newest = (a: Step, b: Step): number => b.visit - a.visit || b.attempt - a.attempt || b.id - a.id;

/** The current attempt (highest) of `(nodeId, visit)`. */
export function currentOf(steps: readonly Step[], nodeId: string, visit: number): Step | undefined {
  return steps.filter((s) => s.nodeId === nodeId && s.visit === visit).sort((a, b) => b.attempt - a.attempt)[0];
}

/**
 * `{{node.out}}`, `{{node.exit}}`, `{{resolution}}` and `{{input.x}}` for the moment a node starts (D11, D14): the output of the latest finished
 * step of every node, the resolution of the latest finished approval step.
 */
export function scopeFor(wf: Workflow, run: Run, steps: readonly Step[], extra: { item?: string; index?: number } = {}): Record<string, string> {
  const outputs: Record<string, { out: string; exit?: number }> = {};
  let resolution: string | null = null;
  let resolutionId = -1;
  for (const s of [...steps].filter((x) => x.status === 'done').sort((a, b) => a.visit - b.visit || a.attempt - b.attempt || a.id - b.id)) {
    const node = nodeFor(wf, s.nodeId);
    if (node === null) continue;
    const exit = isObj(s.output) && typeof s.output['exitCode'] === 'number' ? s.output['exitCode'] : undefined;
    outputs[s.nodeId] = { out: outText(node, s.output), ...(node.type === 'shell' && exit !== undefined ? { exit } : {}) };
    if (node.type === 'approval' && s.resolution !== null && s.id > resolutionId) {
      resolution = s.resolution;
      resolutionId = s.id;
    }
  }
  return scopeOf({ inputs: run.inputs, outputs, resolution, ...(extra.item === undefined ? {} : { item: extra.item }), ...(extra.index === undefined ? {} : { index: extra.index }) });
}

/** Renders one workflow text and cuts it to `textMax` (D11). */
export const cut = (s: string): string => s.slice(0, workflowLimits.textMax);

/**
 * The nearest upstream step that satisfies `pick` (D14): walks incoming edges breadth-first from `fromNodeId`, newest visit first at each node.
 * `null` when none. Back-edges are walked too; a node is visited once.
 */
export function upstreamStep(wf: Workflow, steps: readonly Step[], fromNodeId: string, pick: (s: Step) => boolean): Step | null {
  const seen = new Set<string>([fromNodeId]);
  const queue = [fromNodeId];
  while (queue.length > 0) {
    const at = queue.shift() as string;
    for (const e of wf.edges) {
      if (e.to !== at) continue;
      const hit = steps.filter((s) => s.nodeId === e.from && pick(s)).sort(newest)[0];
      if (hit !== undefined) return hit;
      if (!seen.has(e.from)) {
        seen.add(e.from);
        queue.push(e.from);
      }
    }
  }
  return null;
}

/** Worktree of the nearest upstream step that has one and whose path is absolute. */
export const upstreamWorktree = (wf: Workflow, steps: readonly Step[], from: string): string | null =>
  upstreamStep(wf, steps, from, (s) => typeof s.worktree === 'string' && s.worktree.startsWith('/'))?.worktree ?? null;

/** Branch of the nearest upstream step that has a valid one ("the parent's branch", D14). */
export const upstreamBranch = (wf: Workflow, steps: readonly Step[], from: string): string | null =>
  upstreamStep(wf, steps, from, (s) => isRef(s.branch))?.branch ?? null;

/** Submits one `runner.step` job under the T6.1 job id (a repeat is the same job). */
export async function submitStep(deps: EngineDeps, ctx: Ctx, step: Step, timeoutS: number, id?: string): Promise<void> {
  await deps.submit({
    queue: 'runner', kind: 'step', id: id ?? runnerJobId(step),
    payload: { userId: ctx.userId, runId: String(step.runId), stepId: String(step.id), nodeId: step.nodeId, visit: step.visit, attempt: step.attempt, timeoutS },
  });
}

/** `running → failed` through the T6.1 core; `maxFailures` 1 breaks the circuit at once (a node the engine runs inline has nothing to retry). */
export async function failNow(deps: EngineDeps, ctx: Ctx, step: Step, error: string, to: 'failed' | 'timeout' = 'failed', patch?: Record<string, unknown>, maxFailures?: number): Promise<Step> {
  try {
    return await failStep(deps.repos.runner, ctx, {
      step, to, error, ...(patch === undefined ? {} : { patch }), maxFailures: maxFailures ?? deps.config.runner.max_failures,
    });
  } catch (e) {
    if (!isConflict(e)) throw e;
    return (await deps.repos.runner.getStep(ctx, step.id)) ?? step;
  }
}

/**
 * Notices a cancel (D15): aborts when the job's own signal fires, or when the step is no longer `running` (read every `engineLimits.watchMs`).
 * `reason()` says which. Never kills anything by itself and never acts on silence.
 */
export function watchStep(deps: Pick<RunnerExecDeps, 'repos'>, ctx: Ctx, stepId: number, jobSignal: AbortSignal): { signal: AbortSignal; reason(): 'job' | 'step' | null; stop(): void } {
  const ac = new AbortController();
  let why: 'job' | 'step' | null = null;
  const onJob = (): void => {
    why ??= 'job';
    ac.abort();
  };
  if (jobSignal.aborted) onJob();
  else jobSignal.addEventListener('abort', onJob, { once: true });
  const timer = setInterval(() => {
    void deps.repos.runner.getStep(ctx, stepId).then((s) => {
      if (s === null || s.status !== 'running') {
        why ??= 'step';
        ac.abort();
      }
    }, () => undefined);
  }, engineLimits.watchMs);
  return {
    signal: ac.signal,
    reason: () => why,
    stop: () => {
      clearInterval(timer);
      jobSignal.removeEventListener('abort', onJob);
    },
  };
}

/** `<repo>/<worktree.dir>/<runId>/` as an absolute path with a trailing separator, the only place a ctc worktree may be (D1d, D22). */
export const worktreeRoot = (deps: EngineDeps, run: Run): string | null =>
  run.repo === null || !run.repo.startsWith('/') ? null : `${path.resolve(run.repo, deps.config.runner.worktree.dir, String(run.id))}${path.sep}`;

/** True when `p` lies strictly below the run's worktree root. */
export function underWorktrees(deps: EngineDeps, run: Run, p: unknown): p is string {
  const root = worktreeRoot(deps, run);
  return root !== null && typeof p === 'string' && p.startsWith('/') && !p.includes('\0') && path.resolve(p).startsWith(root);
}

export { timeoutOf };

/** True when `step` is an agent step that was parked at a setup gate and answered: it is no completion, the next attempt runs it (D16e). */
export const isAnsweredGate = (step: Step): boolean => step.status === 'done' && step.stage === null && step.options !== null;

/** Inserts attempt n+1 of an answered setup gate (same `failureCount`, same parent) and submits it; a repeat is a no-op. */
export async function nextAttempt(deps: EngineDeps, ctx: Ctx, wf: Workflow, cur: Step): Promise<void> {
  const { step } = await deps.repos.runner.insertStep(ctx, {
    runId: cur.runId, nodeId: cur.nodeId, visit: cur.visit, attempt: cur.attempt + 1, retryOfStepId: cur.id, failureCount: cur.failureCount,
    parentStepId: cur.parentStepId, status: 'queued',
  });
  if (step.status === 'queued') await submitStep(deps, ctx, step, timeoutOf(wf, cur.nodeId));
}
