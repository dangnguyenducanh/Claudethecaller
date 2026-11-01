/**
 * The four F4 step routes (retry, fail, cancel, report), `withIdempotency` and `stepJson` (D9, D15-D18, D21). Called from: the ctc-web
 * bootstrap, which mounts each `Route` with `app.route({ method, url, handler })`; the dashboard Runs page calls retry, fail and cancel; the
 * agent process calls report with its step token; T6.2/T6.3 call `withIdempotency`. Why: one place makes a mutating run request safe to repeat
 * and keeps every status write inside `@ctc/core/runner`. Deliberately NOT done: Fastify, auth, approve/continue/POST runs, the walker, killing
 * processes, enqueueing anything but a retried attempt (D7). Untrusted: params, headers (the step token and `Idempotency-Key` included), bodies,
 * and what an agent reports. A handler never throws and sends exactly one reply.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { RunnerError, failStep, cancelRun, isCurrentAttempt, reportStep, retryStep } from '@ctc/core/runner';
import { EmptyBody, FailBody, ReportBody } from '@ctc/shared/schemas/runs';
import type { Ctx, Repositories } from '@ctc/shared/repositories';
import { ApiError, errorBody, iso, parse, statusOf, toApiError, type Route } from '../library/http.ts';

type Step = NonNullable<Awaited<ReturnType<Repositories['runner']['getStep']>>>;
type Result = { status: number; body: unknown };

export type RunsDeps = {
  repos: Repositories;
  config?: { runner?: { max_failures?: number } };
  enqueueStep?(ctx: Ctx, step: Step): Promise<void>;
  ctxOf?(req: unknown): Ctx;
  log?(message: string, fields?: Record<string, unknown>): void;
  now?(): Date;
};

/** Numbers chosen by judgment (D2); read at call time. A longer `summary` or `reason` is cut, not rejected. */
export const runsLimits = { idempotencyKeyMax: 200, summaryMax: 20000, reasonMax: 2000 };

/** sha256 hex of canonical JSON: object keys sorted at every depth, array order kept, `undefined` members dropped as `JSON.stringify` does. */
export function payloadHash(value: unknown): string {
  const sortKeys = (_k: string, v: unknown): unknown =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v;
  return createHash('sha256').update(JSON.stringify(value, sortKeys) ?? 'null').digest('hex');
}

const conflictResult = (code: 'idempotency_mismatch' | 'conflict', message: string): Result => {
  const e = new ApiError(code, message);
  return { status: statusOf(e), body: errorBody(e) };
};

/**
 * Runs `exec` at most once per `(user, key)` (D18). No key: `exec()` once, nothing stored. Else a pending receipt is reserved first; `exec` runs only
 * when it was reserved, a `< 500` result settles it, a `>= 500` result or a throw releases it. A used key replays the stored reply, or is
 * `409 idempotency_mismatch` (other route or payload) / `409 conflict` (still pending) without running `exec`.
 */
export async function withIdempotency(
  deps: { repos: Pick<Repositories, 'idempotency'>; log?: RunsDeps['log'] }, ctx: Ctx, o: { key: string | undefined; route: string; payload: unknown }, exec: () => Promise<Result>,
): Promise<Result & { replayed: boolean }> {
  if (o.key === undefined) return { ...(await exec()), replayed: false };
  const { idempotency } = deps.repos;
  const ref = { key: o.key, route: o.route };
  const swallow = (e: unknown): false => {
    deps.log?.('idempotency receipt update failed', { error: e instanceof Error ? e.constructor.name : typeof e });
    return false;
  };
  const hash = payloadHash(o.payload);
  if (await idempotency.store(ctx, { ...ref, payloadHash: hash, response: { status: 0 } })) {
    let result: Result;
    try {
      result = await exec();
    } catch (e) {
      await idempotency.release(ctx, ref).catch(swallow);
      throw e;
    }
    // judgment: a failed settle/release must not hide the outcome of a mutation that already ran; the receipt then stays pending.
    if (result.status >= 500) await idempotency.release(ctx, ref).catch(swallow);
    else await idempotency.settle(ctx, { ...ref, response: { status: result.status, body: result.body } }).catch(swallow);
    return { ...result, replayed: false };
  }
  const found = await idempotency.lookup(ctx, ref);
  if (found === null || found.payloadHash !== hash) return { ...conflictResult('idempotency_mismatch', 'Idempotency-Key was used with another request'), replayed: false };
  const stored = found.response as { status?: unknown; body?: unknown } | null;
  if (typeof stored?.status !== 'number' || stored.status === 0) return { ...conflictResult('conflict', 'request with this Idempotency-Key is in progress'), replayed: false };
  return { status: stored.status, body: stored.body, replayed: true };
}

const dateOrNull = (d: unknown): string | null => (d === null || d === undefined ? null : iso(d));

/** The public face of a step (D21): no token hash, pid, worktree, branch, log path, usage, cost or options. */
export const stepJson = (s: Step) => ({
  id: s.id, runId: s.runId, nodeId: s.nodeId, visit: s.visit, attempt: s.attempt, retryOfStepId: s.retryOfStepId, failureCount: s.failureCount,
  parentStepId: s.parentStepId, status: s.status, stage: s.stage, liveness: s.liveness, promptOutcome: s.promptOutcome, resolution: s.resolution,
  output: s.output, error: s.error, startedAt: dateOrNull(s.startedAt), endedAt: dateOrNull(s.endedAt),
});

const ID = /^[1-9][0-9]{0,15}$/;
const KEY = /^[\x21-\x7e]+$/;
const errorResult = (e: unknown): Result => {
  const err = e instanceof RunnerError ? new ApiError(e.code, e.message) : toApiError(e);
  return { status: statusOf(err), body: errorBody(err) };
};
const notFound = (what: string): ApiError => new ApiError('not_found', `${what} not found`);

/** A header value, name matched case-insensitively; `undefined` when absent or when `headers` is not an object. */
function headerOf(headers: unknown, name: string): unknown {
  if (headers === null || typeof headers !== 'object') return undefined;
  const hit = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return hit === undefined ? undefined : (headers as Record<string, unknown>)[hit];
}

/** `undefined` when the header is absent; a valid key; else `invalid` with `path ['headers', 'idempotency-key']` (also for a duplicated header). */
function keyOf(headers: unknown): string | undefined {
  const v = headerOf(headers, 'idempotency-key');
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length < 1 || v.length > runsLimits.idempotencyKeyMax || !KEY.test(v)) {
    throw new ApiError('invalid', `Idempotency-Key must be 1 to ${runsLimits.idempotencyKeyMax} visible ASCII characters`, { path: ['headers', 'idempotency-key'] });
  }
  return v;
}

/** `sha256(token)` against the stored hash, in constant time; a step without a hash never matches (D1c). */
function tokenMatches(token: unknown, tokenHash: string | null): boolean {
  if (typeof token !== 'string' || tokenHash === null) return false;
  const actual = Buffer.from(createHash('sha256').update(token).digest('hex'));
  const stored = Buffer.from(tokenHash);
  return actual.length === stored.length && timingSafeEqual(actual, stored);
}

export function runsRoutes(deps: RunsDeps): Route[] {
  const { repos } = deps;
  const maxFailures = (): { maxFailures?: number } => {
    const n = deps.config?.runner?.max_failures;
    return n === undefined ? {} : { maxFailures: n };
  };
  const logError = (message: string, e: unknown): void => deps.log?.(message, { error: e instanceof Error ? e.constructor.name : typeof e });

  const route = (url: string, run: (req: Req, ctx: Ctx, route: string) => Promise<Result>): Route => ({
    method: 'POST',
    url,
    async handler(req, reply) {
      let result: Result;
      try {
        result = await run((req ?? {}) as Req, deps.ctxOf?.(req) ?? { userId: 'local' }, `POST ${url}`);
      } catch (e) {
        result = errorResult(e);
        if (result.status === 500) logError(`POST ${url} failed`, e);
      }
      return reply.code(result.status).send(result.body);
    },
  });
  type Req = { params?: unknown; body?: unknown; headers?: unknown };

  /** D4 steps 1-2: ids in `:rid` (and `:sid`) are digit strings of a run (and step) the caller can see; anything else is `not_found`. */
  async function lookup(req: Req, ctx: Ctx, withStep: true): Promise<{ rid: string; sid: string; step: Step }>;
  async function lookup(req: Req, ctx: Ctx, withStep: false): Promise<{ rid: string }>;
  async function lookup(req: Req, ctx: Ctx, withStep: boolean): Promise<{ rid: string; sid?: string; step?: Step }> {
    const p = (req.params ?? {}) as { rid?: unknown; sid?: unknown };
    if (typeof p.rid !== 'string' || !ID.test(p.rid)) throw notFound('run');
    if (!withStep) {
      if ((await repos.runner.getRun(ctx, Number(p.rid))) === null) throw notFound('run');
      return { rid: p.rid };
    }
    if (typeof p.sid !== 'string' || !ID.test(p.sid)) throw notFound('step');
    const [run, step] = await Promise.all([repos.runner.getRun(ctx, Number(p.rid)), repos.runner.getStep(ctx, Number(p.sid))]);
    if (run === null) throw notFound('run');
    if (step === null || step.runId !== run.id) throw notFound('step');
    return { rid: p.rid, sid: p.sid, step };
  }

  /** Runs `op` behind the idempotency receipt; a 4xx raised by `op` is a reply that is stored, a 5xx is not (D18). */
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

  const fresh = async (ctx: Ctx, step: Step): Promise<Step> => (await repos.runner.getStep(ctx, step.id)) ?? step;
  const requireCurrent = async (ctx: Ctx, step: Step): Promise<void> => {
    if (!isCurrentAttempt(step, await repos.runner.listSteps(ctx, step.runId))) throw new RunnerError('stale_attempt', 'a newer attempt exists');
  };

  return [
    route('/api/runs/:rid/steps/:sid/retry', async (req, ctx, tpl) => {
      const { rid, sid, step } = await lookup(req, ctx, true);
      const key = keyOf(req.headers);
      parse(EmptyBody, 'body', req.body ?? {});
      return keyed(ctx, tpl, key, { rid, sid }, req.body, async () => {
        const made = await retryStep(repos.runner, ctx, { stepId: step.id, ...maxFailures() });
        let enqueued = false;
        if (made.created && deps.enqueueStep) {
          try {
            await deps.enqueueStep(ctx, made.step);
            enqueued = true;
          } catch (e) {
            logError('enqueue of a retried attempt failed', e);
          }
        }
        return { status: made.created ? 201 : 200, body: { step: stepJson(made.step), created: made.created, enqueued } };
      });
    }),

    route('/api/runs/:rid/steps/:sid/fail', async (req, ctx, tpl) => {
      const { rid, sid, step } = await lookup(req, ctx, true);
      const key = keyOf(req.headers);
      const body = parse(FailBody, 'body', req.body ?? {});
      return keyed(ctx, tpl, key, { rid, sid }, req.body, async () => {
        await requireCurrent(ctx, step);
        const now = await fresh(ctx, step);
        if (now.status !== 'start_unknown') throw new RunnerError('conflict', 'only a start_unknown step can be marked failed');
        // judgment: an empty reason gets the default text too.
        const error = (body.reason || 'marked failed by user').slice(0, runsLimits.reasonMax);
        const failed = await failStep(repos.runner, ctx, { step: now, to: 'failed', error, ...maxFailures() });
        return { status: 200, body: { step: stepJson(failed) } };
      });
    }),

    route('/api/runs/:rid/cancel', async (req, ctx, tpl) => {
      const { rid } = await lookup(req, ctx, false);
      const key = keyOf(req.headers);
      parse(EmptyBody, 'body', req.body ?? {});
      return keyed(ctx, tpl, key, { rid }, req.body, async () => {
        const { run, cancelled } = await cancelRun(repos.runner, ctx, Number(rid));
        return { status: 200, body: { run: { id: run.id, status: run.status, endedAt: dateOrNull(run.endedAt) }, cancelled } };
      });
    }),

    route('/api/runs/:rid/steps/:sid/report', async (req, ctx) => {
      const { step } = await lookup(req, ctx, true);
      if (!tokenMatches(headerOf(req.headers, 'x-ctc-step-token'), step.tokenHash)) throw new ApiError('unauthorized', 'missing or wrong step token');
      const body = parse(ReportBody, 'body', req.body);
      const summary = body.summary?.slice(0, runsLimits.summaryMax);
      const { applied, step: now } = await reportStep(repos.runner, ctx, { stepId: step.id, outcome: body.outcome, ...(summary === undefined ? {} : { summary }) });
      return { status: 200, body: { applied, step: stepJson(now) } };
    }),
  ];
}
export { runJson, stepDetailJson, workflowRoutes } from './workflows.ts';
export { startLimits, startRun, stepTimeoutS } from './start.ts';
export type { WorkflowApiDeps } from './start.ts';
export { handoffLimits, workflowTools } from './tools.ts';
