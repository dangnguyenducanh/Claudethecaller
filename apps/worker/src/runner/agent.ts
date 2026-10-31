/**
 * The engine's `resolveNode` for the T6.2 cold path (D14): turns a step of an `agent` node (or of a fan-out child) into the rendered `AgentNode`.
 * Called from: ./engine.ts (given to `runnerHandlers` and `sweepRunner`). Why: the prompt must be rendered at the moment the node starts, with
 * the outputs of earlier steps, the gate resolution and the right base branch and worktree. Deliberately NOT done: any write, spawning.
 * Untrusted: the workflow text, run inputs, and what earlier steps stored (branches and worktrees are checked before use).
 */
import { isRef, parseChildId, renderTemplate, type AgentNode, type Workflow } from '@ctc/core/runner';
import type { Ctx } from '@ctc/shared/repositories';
import { cut, currentOf, loadWorkflow, nodeFor, scopeFor, upstreamWorktree, type EngineDeps } from './common.ts';
import { isObject, type Run, type Step } from './types.ts';

/** `null` for an unknown node or a bad workflow: T6.2 then fails the step with `node not found`. */
export async function resolveAgentNode(deps: EngineDeps, ctx: Ctx, run: Run, step: Step, loaded?: Workflow | null): Promise<AgentNode | null> {
  const wf = loaded ?? (await loadWorkflow(deps, ctx, run));
  if (wf === null) return null;
  const steps = await deps.repos.runner.listSteps(ctx, run.id);
  const cid = parseChildId(step.nodeId);
  const owner = nodeFor(wf, cid === null ? step.nodeId : cid.fanoutId);
  const body = cid === null ? (owner?.type === 'agent' ? owner : null) : owner?.type === 'fanout' ? owner.child : undefined;
  if (owner === null || body === null || body === undefined || body.agent === undefined || body.prompt === undefined || body.permission === undefined) return null;
  let item: string | undefined;
  let index: number | undefined;
  let base: string | null = body.base ?? null;
  if (cid !== null) {
    const fan = currentOf(steps, cid.fanoutId, step.visit);
    const out = isObject(fan?.output) ? fan.output : {};
    item = Array.isArray(out['items']) && typeof out['items'][cid.index] === 'string' ? out['items'][cid.index] : '';
    index = cid.index;
    if (base === null && isRef(out['base'])) base = out['base'];
  }
  const scope = scopeFor(wf, run, steps, { ...(item === undefined ? {} : { item }), ...(index === undefined ? {} : { index }) });
  const resolution = scope['resolution'] ?? null;
  const parent = step.worktree ?? (body.worktree === 'parent' ? upstreamWorktree(wf, steps, owner.id) : null);
  const prior = step.retryOfStepId === null ? undefined : steps.find((s) => s.id === step.retryOfStepId);
  const decision = prior !== undefined && prior.status === 'done' && prior.stage === null && (prior.resolution === 'run' || prior.resolution === 'skip') ? prior.resolution : null;
  return {
    agent: body.agent,
    prompt: cut(renderTemplate(body.prompt, scope).text),
    // judgment: a step that already has a worktree is a resumed attempt (quota, D20); T6.2 cannot add a worktree on a branch that exists, so it reuses this one.
    worktree: step.worktree === null ? (body.worktree ?? 'new') : 'parent',
    permission: body.permission,
    model: body.model ?? null,
    timeoutS: body.timeoutS ?? 1800,
    workflow: wf.name,
    child: index ?? null,
    base,
    parentWorktree: parent,
    resolution,
    setupDecision: decision,
  };
}
