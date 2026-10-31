/**
 * The fan-out node (D17): `startFanout` plans the items and parks the fan-out row in `waiting` (bookkeeping), `reconcileFanout` releases the
 * children (at most `min(max_parallel, config, 3)` active at once), completes the row when every child is done, and fails it when a child
 * is circuit-broken. Called from: ./engine.ts (`advanceRun`). Why: spec:675. The engine releases children itself (no BullMQ Flow); each child is
 * an agent attempt with its own new worktree, so N children use N worktrees and N branches. Deliberately NOT done: nested fan-out (depth 1,
 * refused by `parseWorkflow`), retrying a parked failed child (the T6.1 retry route does), killing processes. Untrusted: run inputs, step outputs.
 */
import { childId, outText, planFanout, transitionStep, workflowLimits, type Workflow, type WorkflowNode } from '@ctc/core/runner';
import type { Ctx } from '@ctc/shared/repositories';
import { failNow, isAnsweredGate, nextAttempt, scopeFor, submitStep, upstreamBranch, type EngineDeps } from './common.ts';
import { isConflict, isObject, type Run, type Step } from './types.ts';

const ACTIVE = ['queued', 'running', 'waiting', 'quota'];

/** `running → waiting` with `output { items, base, total }`, or `running → failed → circuit_broken` with the `fanout: …` error (D17b). */
export async function startFanout(deps: EngineDeps, ctx: Ctx, run: Run, wf: Workflow, steps: readonly Step[], step: Step, node: WorkflowNode): Promise<void> {
  const planned = planFanout(node, scopeFor(wf, run, steps));
  const reason = !planned.ok ? planned.error : planned.items.length > 0 && run.repo === null ? 'fanout: no repository' : null;
  if (reason !== null || !planned.ok) {
    await failNow(deps, ctx, step, reason ?? 'fanout: bad items', 'failed', undefined, 1);
    return;
  }
  // judgment: "the parent's branch" is the branch of the nearest upstream step that has one, else the run's base (null: T6.2 falls back to it).
  const base = node.child?.base ?? upstreamBranch(wf, steps, node.id);
  await transitionStep(deps.repos.runner, ctx, {
    stepId: step.id, from: 'running', to: 'waiting', patch: { output: { items: planned.items, base, total: planned.items.length } },
  });
}

/** One look at a waiting fan-out row; returns true when it wrote something. */
export async function reconcileFanout(deps: EngineDeps, ctx: Ctx, wf: Workflow, node: WorkflowNode, fan: Step, steps: readonly Step[]): Promise<boolean> {
  const port = deps.repos.runner;
  const out = isObject(fan.output) ? fan.output : {};
  const items = Array.isArray(out['items']) ? out['items'].map(String) : [];
  const kids = steps.filter((s) => s.parentStepId === fan.id);
  const kidOf = (i: number): Step | undefined => {
    const id = childId(node.id, i);
    return kids.filter((s) => s.nodeId === id).sort((a, b) => b.attempt - a.attempt)[0];
  };
  const current = items.map((_, i) => kidOf(i));
  let wrote = false;
  for (const k of current) {
    if (k === undefined || !isAnsweredGate(k)) continue;
    await nextAttempt(deps, ctx, wf, k);
    wrote = true;
  }

  const broken = current.find((k) => k !== undefined && (k.status === 'circuit_broken' || k.status === 'cancelled'));
  if (broken !== undefined) {
    try {
      await transitionStep(port, ctx, { stepId: fan.id, from: 'waiting', to: 'cancelled', patch: { error: `child ${broken.nodeId} failed`, endedAt: new Date() } });
    } catch (e) {
      if (!isConflict(e)) throw e;
      return false;
    }
    for (const k of current) {
      if (k === undefined || !['queued', 'running', 'waiting', 'quota', 'start_unknown'].includes(k.status)) continue;
      try {
        await transitionStep(port, ctx, { stepId: k.id, from: k.status, to: 'cancelled', patch: { endedAt: new Date() } });
      } catch (e) {
        if (!isConflict(e)) throw e;
      }
    }
    return true;
  }

  if (!wrote && current.every((k) => k !== undefined && k.status === 'done')) {
    const children = current.map((k, index) => ({
      index, nodeId: (k as Step).nodeId, stepId: (k as Step).id, branch: (k as Step).branch, worktree: (k as Step).worktree, summary: outText({ type: 'agent' }, (k as Step).output),
    }));
    try {
      await transitionStep(port, ctx, {
        stepId: fan.id, from: 'waiting', to: 'done',
        patch: { output: { outcome: 'done', summary: `${items.length} children done`, items, base: out['base'] ?? null, total: items.length, children }, endedAt: new Date() },
      });
    } catch (e) {
      if (!isConflict(e)) throw e;
      return false;
    }
    return true;
  }

  const cap = Math.min(node.maxParallel ?? workflowLimits.fanoutParallelMax, deps.config.runner.fanout.max_parallel, workflowLimits.fanoutParallelMax);
  let active = current.filter((k) => k !== undefined && ACTIVE.includes(k.status)).length;
  for (let i = 0; i < items.length && active < cap; i++) {
    if (current[i] !== undefined) continue;
    const { step } = await port.insertStep(ctx, { runId: fan.runId, nodeId: childId(node.id, i), visit: fan.visit, attempt: 1, parentStepId: fan.id, failureCount: 0, status: 'queued' });
    if (step.status === 'queued') await submitStep(deps, ctx, step, node.child?.timeoutS ?? 1800);
    active++;
    wrote = true;
  }
  return wrote;
}
