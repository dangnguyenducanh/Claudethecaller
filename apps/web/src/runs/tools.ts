/**
 * The two MCP tools of the runner (D21): `run_workflow` starts a run and waits briefly to say whether the first agent prompt was delivered,
 * `workflow_status` lists the steps of a run. Called from: the ctc-web bootstrap, which registers each `McpTool` on `/mcp`. Why: spec:678,
 * 701-702. An agent that hands work to a workflow needs to know the prompt arrived. Deliberately NOT done: waiting for the run to finish.
 * Untrusted: every argument. A failure is an `isError` result with the error body, never a throw.
 */
import { RunWorkflowArgs, WorkflowStatusArgs } from '@ctc/shared/schemas/workflows';
import type { Ctx } from '@ctc/shared/repositories';
import { errorBody, notFound, parse, toApiError, type McpResult, type McpTool } from '../library/http.ts';
import { resolveCapability } from '../library/read.ts';
import { startRun, type WorkflowApiDeps } from './start.ts';

/** Numbers chosen by judgment (D2); read at call time. */
export const handoffLimits = { waitMs: 8000, pollMs: 100 };

const text = (v: unknown): McpResult => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
const failure = (e: unknown): McpResult => ({ content: [{ type: 'text', text: JSON.stringify(errorBody(toApiError(e))) }], isError: true });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function workflowTools(deps: WorkflowApiDeps): McpTool[] {
  const port = deps.repos.runner;

  async function runWorkflow(ctx: Ctx, raw: unknown): Promise<McpResult> {
    const args = parse(RunWorkflowArgs, 'args', raw);
    const cap = await resolveCapability(deps.library, ctx, args.name);
    if (cap.kind !== 'workflow') throw notFound('workflow not found');
    const { run, workflow } = await startRun(deps, ctx, { cap, inputs: args.inputs, repo: args.repo, base: args.base, trigger: 'mcp' });
    const agentNodes = new Set(workflow.nodes.filter((n) => n.type === 'agent').map((n) => n.id));
    const fanouts = new Set(workflow.nodes.filter((n) => n.type === 'fanout').map((n) => n.id));
    const isAgent = (nodeId: string): boolean => agentNodes.has(nodeId) || fanouts.has(nodeId.replace(/\[\d+\]$/, ''));
    const end = Date.now() + handoffLimits.waitMs;
    let status = run.status;
    let outcome: string | null = null;
    for (;;) {
      const agents = (await port.listSteps(ctx, run.id)).filter((s) => isAgent(s.nodeId));
      const delivered = agents.find((s) => s.promptOutcome !== null);
      const now = await port.getRun(ctx, run.id);
      status = now?.status ?? status;
      outcome = delivered?.promptOutcome ?? (agents.length > 0 ? 'unconfirmed' : null);
      if (delivered !== undefined || (status !== 'running' && status !== 'queued') || Date.now() >= end) break;
      await sleep(handoffLimits.pollMs);
    }
    return text({ run_id: run.id, status, prompt_outcome: outcome });
  }

  async function workflowStatus(ctx: Ctx, raw: unknown): Promise<McpResult> {
    const args = parse(WorkflowStatusArgs, 'args', raw);
    const run = await port.getRun(ctx, args.run_id);
    if (run === null) throw notFound('run not found');
    const steps = (await port.listSteps(ctx, run.id)).map((s) => ({
      id: s.id, node_id: s.nodeId, visit: s.visit, attempt: s.attempt, status: s.status, stage: s.stage, resolution: s.resolution, prompt_outcome: s.promptOutcome,
    }));
    return text({ run_id: run.id, status: run.status, steps });
  }

  const wrap = (run: (ctx: Ctx, args: unknown) => Promise<McpResult>) => async (ctx: Ctx, args: unknown): Promise<McpResult> => {
    try {
      return await run(ctx, args);
    } catch (e) {
      return failure(e);
    }
  };
  return [
    {
      name: 'run_workflow',
      description:
        'Start a saved workflow (`name` or `namespace:name`) with optional `inputs`, `repo` (absolute path) and `base` (branch). Waits a few seconds and returns run_id, status and prompt_outcome (delivered, not_delivered, unconfirmed, or null when the workflow has not started an agent step).',
      inputSchema: RunWorkflowArgs,
      call: wrap(runWorkflow),
    },
    {
      name: 'workflow_status',
      description: 'The status of a run (`run_id`) and of each of its steps: node, visit, attempt, status, stage, resolution and prompt_outcome.',
      inputSchema: WorkflowStatusArgs,
      call: wrap(workflowStatus),
    },
  ];
}
