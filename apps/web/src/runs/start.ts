/**
 * Starting a run (D19): `startRun` reads the version of a workflow capability the caller is served, parses it, checks the run arguments and
 * creates the run row; `readWorkflow` is the same read for the show-workflow route. Called from: ./workflows.ts (`POST /api/workflows/:id/runs`)
 * and ./tools.ts (`run_workflow`). Why: spec:589-591, 614. The run pins the served version, so later edits of the file do not change a run.
 * Deliberately NOT done: walking the run (the worker tick does; `deps.advance` only hurries it), queueing a second run of an owner (it is a
 * `409`), `the schedules table`. Untrusted: `inputs`, `repo`, `base`, the workflow file.
 */
import { isRef, parseWorkflow, timeoutOf, type ParseResult, type Workflow } from '@ctc/core/runner';
import type { Ctx, Repositories } from '@ctc/shared/repositories';
import { ApiError, notFound, type Capability, type LibraryApiDeps } from '../library/http.ts';
import { manifestAndBody } from '../library/read.ts';
import { servedVersion } from '../library/served.ts';
import type { RunsDeps } from './index.ts';

type Run = NonNullable<Awaited<ReturnType<Repositories['runner']['getRun']>>>;

export type WorkflowApiDeps = RunsDeps & {
  library: LibraryApiDeps;
  runsDir: string;
  ownerOf?(ctx: Ctx): string | Promise<string>;
  advance?(ctx: Ctx, runId: number): Promise<void>;
  enqueueResume?(ctx: Ctx, step: NonNullable<Awaited<ReturnType<Repositories['runner']['getStep']>>>, jobId: string): Promise<void>;
};

/** Numbers chosen by judgment (D2); read at call time. */
export const startLimits = { repoMax: 4096, baseMax: 200, inputsMaxBytes: 65536 };

/** The served version of a workflow capability, read and parsed. `404` when the caller is not served any version. */
export async function readWorkflow(deps: Pick<WorkflowApiDeps, 'library'>, ctx: Ctx, cap: Capability): Promise<{ version: number; parsed: ParseResult }> {
  const version = await servedVersion(deps.library, ctx, cap.id);
  const row = version === null ? null : await deps.library.repos.library.getVersion(ctx, cap.id, version);
  if (version === null || row === null) throw notFound('workflow has no served version');
  const { body } = await manifestAndBody(deps.library, ctx, cap.kind, row.id);
  return { version, parsed: parseWorkflow(body) };
}

const bad = (field: string, message: string): ApiError => new ApiError('invalid', message, { path: ['body', field] });

/** The arguments of a run, checked (D1d); returns what `createRun` stores. */
export function checkRunArgs(o: { inputs?: unknown; repo?: string | null | undefined; base?: string | null | undefined }): {
  inputs: Record<string, unknown>; repo: string | null; base: string | null;
} {
  const inputs = (o.inputs ?? {}) as Record<string, unknown>;
  if (typeof inputs !== 'object' || Array.isArray(inputs)) throw bad('inputs', 'inputs must be an object');
  if (Buffer.byteLength(JSON.stringify(inputs)) > startLimits.inputsMaxBytes) throw bad('inputs', `inputs are over ${startLimits.inputsMaxBytes} bytes`);
  const repo = o.repo ?? null;
  if (repo !== null) {
    if (repo.length > startLimits.repoMax) throw bad('repo', `repo is over ${startLimits.repoMax} characters`);
    if (!repo.startsWith('/') || repo.includes('\0') || repo.split('/').includes('..')) throw bad('repo', 'repo must be an absolute path without ..');
  }
  const base = o.base ?? null;
  if (base !== null && (base.length > startLimits.baseMax || !isRef(base))) throw bad('base', 'base must be a plain branch or ref name');
  return { inputs, repo, base };
}

/**
 * `{ run, workflow }` for a new `running` run of `cap` (a workflow capability of the caller). Order: served version `404`, arguments `422`, workflow
 * `422` (message = first error, `errors` = all), then `createRun`; an owner with a running run is `409`. Calls `deps.advance` best effort.
 */
export async function startRun(
  deps: WorkflowApiDeps, ctx: Ctx,
  o: { cap: Capability; inputs?: unknown; repo?: string | null | undefined; base?: string | null | undefined; trigger: 'api' | 'mcp' },
): Promise<{ run: Run; workflow: Workflow }> {
  const { version, parsed } = await readWorkflow(deps, ctx, o.cap);
  const args = checkRunArgs(o);
  if (!parsed.ok) throw new ApiError('invalid', parsed.errors[0] ?? 'invalid workflow', { path: [], errors: parsed.errors });
  if (args.repo === null && parsed.workflow.nodes.some((n) => (n.type === 'agent' && n.worktree === 'new') || n.type === 'fanout')) {
    throw bad('repo', 'repo is required: an agent node of this workflow needs a git worktree');
  }
  // judgment: `startedAt` is set by the engine on the first `advanceRun` (a status write outside the core is not allowed here).
  const run = await deps.repos.runner.createRun(ctx, {
    owner: (await deps.ownerOf?.(ctx)) ?? ctx.userId, workflowCapId: o.cap.id, workflowVersion: version, status: 'running', trigger: o.trigger,
    inputs: args.inputs, repo: args.repo, baseBranch: args.base, state: {},
  });
  try {
    await deps.advance?.(ctx, run.id);
  } catch (e) {
    deps.log?.('advance after start failed', { error: e instanceof Error ? e.constructor.name : typeof e });
  }
  return { run, workflow: parsed.workflow };
}

/** Job timeout of a step that is queued again (retry, resume): its node's `timeout_s` in the run's pinned workflow version, as the engine submits it; else the agent default. */
export async function stepTimeoutS(deps: WorkflowApiDeps, ctx: Ctx, step: { runId: number; nodeId: string }): Promise<number> {
  try {
    const run = await deps.repos.runner.getRun(ctx, step.runId);
    const row = run?.workflowCapId ? await deps.library.repos.library.getVersion(ctx, run.workflowCapId, run.workflowVersion) : null;
    if (row) {
      const parsed = parseWorkflow((await manifestAndBody(deps.library, ctx, 'workflow', row.id)).body);
      if (parsed.ok) return timeoutOf(parsed.workflow, step.nodeId);
    }
  } catch (e) {
    deps.log?.('step timeout lookup failed', { error: e instanceof Error ? e.constructor.name : typeof e });
  }
  return 1800;
}
