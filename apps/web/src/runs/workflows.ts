/**
 * The eight workflow routes (D3c, D4, D16c, D19, D20, D23): list and show workflows, start a run, list and show runs, approve a gate, continue a
 * run, stream a step log. Called from: the ctc-web bootstrap, which mounts each `Route` next to `runsRoutes`; the dashboard Runs page calls them.
 * Why: spec:694-702. Deliberately NOT done: Fastify, auth, the walker (the worker tick), `the schedules table`, writing any status except through
 * `@ctc/core/runner`. Untrusted: params, query, headers, bodies. A handler never throws and sends exactly one reply.
 */
import { randomUUID } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { RunnerError, approveStep, continueRun, optionIds, runnerJobId } from '@ctc/core/runner';
import { RepoError, type Ctx, type Repositories } from '@ctc/shared/repositories';
import { ApproveBody, RunListQuery } from '@ctc/shared/schemas/workflows';
import { EmptyBody } from '@ctc/shared/schemas/runs';
import { ApiError, errorBody, iso, notFound, parse, statusOf, toApiError, type Route } from '../library/http.ts';
import { runsLimits, stepJson, withIdempotency } from './index.ts';
import { readWorkflow, startRun, type WorkflowApiDeps } from './start.ts';
import { StartRunBody } from '@ctc/shared/schemas/workflows';

type Run = NonNullable<Awaited<ReturnType<Repositories['runner']['getRun']>>>;
type Step = NonNullable<Awaited<ReturnType<Repositories['runner']['getStep']>>>;
type Result = { status: number; body: unknown };
type Req = { params?: unknown; query?: unknown; body?: unknown; headers?: unknown };

const dateOrNull = (d: unknown): string | null => (d === null || d === undefined ? null : iso(d));
const ID = /^[1-9][0-9]{0,15}$/;
const KEY = /^[\x21-\x7e]+$/;

/** The public face of a run (D3c): no `state`, no `userId`. */
export const runJson = (r: Run) => ({
  id: r.id, owner: r.owner, workflowCapId: r.workflowCapId, workflowVersion: r.workflowVersion, status: r.status, trigger: r.trigger, inputs: r.inputs,
  repo: r.repo, baseBranch: r.baseBranch, createdAt: dateOrNull(r.createdAt), startedAt: dateOrNull(r.startedAt), endedAt: dateOrNull(r.endedAt),
});

/** `stepJson` plus the gate options and the work the step did; never the token hash, pid or log path. */
export const stepDetailJson = (s: Step) => ({ ...stepJson(s), options: s.options, worktree: s.worktree, branch: s.branch, usage: s.usage, costUsd: s.costUsd });

const errorResult = (e: unknown): Result => {
  const err = e instanceof RunnerError ? new ApiError(e.code, e.message) : toApiError(e);
  return { status: statusOf(err), body: errorBody(err) };
};

function keyOf(headers: unknown): string | undefined {
  if (headers === null || typeof headers !== 'object') return undefined;
  const hit = Object.keys(headers).find((k) => k.toLowerCase() === 'idempotency-key');
  const v = hit === undefined ? undefined : (headers as Record<string, unknown>)[hit];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length < 1 || v.length > runsLimits.idempotencyKeyMax || !KEY.test(v)) {
    throw new ApiError('invalid', `Idempotency-Key must be 1 to ${runsLimits.idempotencyKeyMax} visible ASCII characters`, { path: ['headers', 'idempotency-key'] });
  }
  return v;
}

export function workflowRoutes(deps: WorkflowApiDeps): Route[] {
  const { repos } = deps;
  const logError = (message: string, e: unknown): void => deps.log?.(message, { error: e instanceof Error ? e.constructor.name : typeof e });
  const route = (method: Route['method'], url: string, run: (req: Req, ctx: Ctx, tpl: string, reply: unknown) => Promise<Result>): Route => ({
    method,
    url,
    async handler(req, reply) {
      let result: Result;
      try {
        result = await run((req ?? {}) as Req, deps.ctxOf?.(req) ?? { userId: 'local' }, `${method} ${url}`, reply);
      } catch (e) {
        result = errorResult(e);
        if (result.status === 500) logError(`${method} ${url} failed`, e);
      }
      return reply.code(result.status).send(result.body);
    },
  });
  const keyed = (ctx: Ctx, tpl: string, key: string | undefined, params: Record<string, string>, body: unknown, op: () => Promise<Result>): Promise<Result> =>
    withIdempotency(deps, ctx, { key, route: tpl, payload: { params, body: body ?? null } }, async () => {
      try {
        return await op();
      } catch (e) {
        const result = errorResult(e);
        if (result.status >= 500) logError(`${tpl} failed`, e);
        return result;
      }
    });
  const advance = async (ctx: Ctx, runId: number): Promise<void> => {
    try {
      await deps.advance?.(ctx, runId);
    } catch (e) {
      logError('advance failed', e);
    }
  };
  const runOf = async (req: Req, ctx: Ctx): Promise<Run> => {
    const rid = (req.params as { rid?: unknown } | null | undefined)?.rid;
    const run = typeof rid === 'string' && ID.test(rid) ? await repos.runner.getRun(ctx, Number(rid)) : null;
    if (run === null) throw notFound('run not found');
    return run;
  };
  const workflowOf = async (req: Req, ctx: Ctx) => {
    const id = (req.params as { id?: unknown } | null | undefined)?.id;
    const cap = typeof id === 'string' ? await repos.library.get(ctx, id) : null;
    if (cap === null || cap.kind !== 'workflow' || cap.removedAt) throw notFound('workflow not found');
    return cap;
  };

  return [
    route('GET', '/api/workflows', async (_req, ctx) => {
      const page = await repos.library.listCapabilities(ctx, { kind: 'workflow', limit: 500 });
      const workflows = page.rows.filter((c) => !c.removedAt).map((c) => ({ id: c.id, name: c.name, namespace: c.namespace, servedVersion: c.servedVersion ?? null }));
      workflows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return { status: 200, body: { workflows } };
    }),

    route('GET', '/api/workflows/:id', async (req, ctx) => {
      const cap = await workflowOf(req, ctx);
      const { version, parsed } = await readWorkflow(deps, ctx, cap);
      return { status: 200, body: { id: cap.id, name: cap.name, namespace: cap.namespace, version, workflow: parsed.ok ? parsed.workflow : null, errors: parsed.ok ? [] : parsed.errors } };
    }),

    route('POST', '/api/workflows/:id/runs', async (req, ctx, tpl) => {
      const cap = await workflowOf(req, ctx);
      const key = keyOf(req.headers);
      const body = parse(StartRunBody, 'body', req.body ?? {});
      return keyed(ctx, tpl, key, { id: cap.id }, req.body, async () => {
        const { run } = await startRun(deps, ctx, { cap, inputs: body.inputs, repo: body.repo, base: body.base, trigger: 'api' });
        return { status: 202, body: { run_id: run.id, status: run.status } };
      });
    }),

    route('GET', '/api/runs', async (req, ctx) => {
      const q = parse(RunListQuery, 'query', req.query ?? {});
      try {
        const page = await repos.runner.listRuns(ctx, { ...(q.limit === undefined ? {} : { limit: q.limit }), ...(q.cursor === undefined ? {} : { cursor: q.cursor }) });
        return { status: 200, body: { runs: page.rows.map(runJson), next: page.next } };
      } catch (e) {
        throw e instanceof RepoError && e.code === 'invalid' ? new ApiError('invalid', e.message, { path: ['query', 'cursor'] }) : e;
      }
    }),

    route('GET', '/api/runs/:rid', async (req, ctx) => {
      const run = await runOf(req, ctx);
      const steps = await repos.runner.listSteps(ctx, run.id);
      return { status: 200, body: { run: runJson(run), steps: steps.map(stepDetailJson) } };
    }),

    route('POST', '/api/runs/:rid/approve', async (req, ctx, tpl) => {
      const run = await runOf(req, ctx);
      const key = keyOf(req.headers);
      const body = parse(ApproveBody, 'body', req.body);
      const step = await repos.runner.getStep(ctx, body.step_id);
      if (step === null || step.runId !== run.id) throw notFound('step not found');
      if (!optionIds(step.options).includes(body.option_id)) throw new ApiError('invalid', 'option_id is not one of the step options', { path: ['body', 'option_id'] });
      return keyed(ctx, tpl, key, { rid: String(run.id) }, req.body, async () => {
        const { step: answered, applied } = await approveStep(repos.runner, ctx, { stepId: step.id, optionId: body.option_id });
        if (applied) await advance(ctx, run.id);
        const now = await repos.runner.getRun(ctx, run.id);
        return { status: 200, body: { applied, step: stepDetailJson(answered), run: { id: run.id, status: now?.status ?? run.status } } };
      });
    }),

    route('POST', '/api/runs/:rid/continue', async (req, ctx, tpl) => {
      const run = await runOf(req, ctx);
      const key = keyOf(req.headers);
      parse(EmptyBody, 'body', req.body ?? {});
      return keyed(ctx, tpl, key, { rid: String(run.id) }, req.body, async () => {
        const { run: after, resumed } = await continueRun(repos.runner, ctx, { runId: run.id });
        for (const s of resumed) {
          // judgment: the same attempt id would be ignored by the queue while the old job record exists, so a resume gets its own id.
          try {
            await deps.enqueueResume?.(ctx, s, `${runnerJobId(s)}:resume:${key ?? randomUUID()}`);
          } catch (e) {
            logError('enqueue of a resumed step failed', e);
          }
        }
        const applied = resumed.length > 0 || after.status !== run.status;
        if (applied) await advance(ctx, run.id);
        return { status: 200, body: { applied, run: { id: after.id, status: after.status }, resumed: resumed.length } };
      });
    }),

    route('GET', '/api/runs/:rid/steps/:sid/log', async (req, ctx, _tpl, reply) => {
      const run = await runOf(req, ctx);
      const sid = (req.params as { sid?: unknown } | null | undefined)?.sid;
      const step = typeof sid === 'string' && ID.test(sid) ? await repos.runner.getStep(ctx, Number(sid)) : null;
      if (step === null || step.runId !== run.id) throw notFound('step not found');
      const root = path.resolve(deps.runsDir) + path.sep;
      const file = step.logPath === null ? null : path.resolve(step.logPath);
      if (file === null || !file.startsWith(root)) throw notFound('log not found');
      const isFile = (p: string): Promise<boolean> => stat(p).then((st) => st.isFile(), () => false);
      const plain = await isFile(file);
      if (!plain && !(await isFile(`${file}.gz`))) throw notFound('log not found');
      (reply as { header?(k: string, v: string): unknown }).header?.('content-type', 'application/x-ndjson');
      const handle = await open(plain ? file : `${file}.gz`, 'r');
      const stream = plain ? handle.createReadStream() : handle.createReadStream().pipe(zlib.createGunzip());
      return { status: 200, body: stream };
    }),
  ];
}
