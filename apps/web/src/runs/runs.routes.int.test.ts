import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { URLS, call, mkDeps, mkRun, mkStep, newUser, rnd, scratch, type Scratch } from './testing.ts';

let s: Scratch;
beforeAll(async () => {
  s = await scratch();
}, 60_000);
afterAll(async () => {
  await s?.drop();
});

const sp = (run: { id: number }, step: { id: number }) => ({ rid: String(run.id), sid: String(step.id) });
const getStep = (ctx: { userId: string }, id: number) => s.repos.runner.getStep(ctx, id);

describe('trust and input (D1, D3, D4, D5)', () => {
  it('another user gets 404 on every route and changes nothing', async () => {
    const a = newUser();
    const b = newUser();
    const { routes } = mkDeps(s.repos);
    const run = await mkRun(s.repos, a);
    const { step, token } = await mkStep(s.repos, a, run.id, { status: 'failed' });
    const params = sp(run, step);
    const got = [
      (await call(routes, URLS.retry, { ctx: b, params })).status, (await call(routes, URLS.fail, { ctx: b, params })).status,
      (await call(routes, URLS.cancel, { ctx: b, params })).status,
      (await call(routes, URLS.report, { ctx: b, params, headers: { 'x-ctc-step-token': token }, body: { outcome: 'done' } })).status,
    ];
    expect(got).toEqual([404, 404, 404, 404]);
    expect([(await getStep(a, step.id))?.status, (await s.repos.runner.getRun(a, run.id))?.status]).toEqual(['failed', 'running']);
  });
  it('junk ids and a step of another run are 404; an unknown body key is 422 with its path', async () => {
    const ctx = newUser();
    const { routes } = mkDeps(s.repos);
    const run = await mkRun(s.repos, ctx);
    const other = await mkRun(s.repos, ctx);
    const { step } = await mkStep(s.repos, ctx, run.id, { status: 'failed' });
    const status = async (params: object) => (await call(routes, URLS.retry, { ctx, params })).status;
    expect([await status({ rid: 'abc', sid: String(step.id) }), await status({ rid: String(run.id), sid: '0' }), await status(sp(other, step))]).toEqual([404, 404, 404]);
    const bad = await call(routes, URLS.retry, { ctx, params: sp(run, step), body: { userId: 'x' } });
    expect([bad.status, bad.body.error.code, bad.body.error.path[0]]).toEqual([422, 'invalid', 'body']);
    expect((await s.repos.runner.listSteps(ctx, run.id)).length).toBe(1);
  });
  it('the report needs the step token: wrong, missing or no hash is 401; a bad body is 422 with a path', async () => {
    const ctx = newUser();
    const { routes } = mkDeps(s.repos);
    const run = await mkRun(s.repos, ctx);
    const { step, token } = await mkStep(s.repos, ctx, run.id);
    const bare = await mkStep(s.repos, ctx, run.id, { noToken: true });
    const codes = [
      (await call(routes, URLS.report, { ctx, params: sp(run, step), headers: { 'x-ctc-step-token': 'wrong' }, body: { outcome: 'done' } })).body.error.code,
      (await call(routes, URLS.report, { ctx, params: sp(run, step), body: { outcome: 'done' } })).body.error.code,
      (await call(routes, URLS.report, { ctx, params: sp(run, bare.step), headers: { 'X-CTC-Step-Token': 'x' }, body: { outcome: 'done' } })).body.error.code,
    ];
    expect(codes).toEqual(['unauthorized', 'unauthorized', 'unauthorized']);
    const bad = await call(routes, URLS.report, { ctx, params: sp(run, step), headers: { 'X-CTC-Step-Token': token }, body: { outcome: 'maybe' } });
    expect([bad.status, bad.body.error.path]).toEqual([422, ['body', 'outcome']]);
    expect((await getStep(ctx, step.id))?.status).toBe('running');
  });
  it('an Idempotency-Key of 200 characters is valid, 201 or a repeated header is 422; no key just runs', async () => {
    const ctx = newUser();
    const { routes } = mkDeps(s.repos);
    const run = await mkRun(s.repos, ctx);
    const retry = async (headers: object) => call(routes, URLS.retry, { ctx, params: sp(run, (await mkStep(s.repos, ctx, run.id, { status: 'failed' })).step), headers });
    const ok = await retry({ 'Idempotency-Key': 'k'.repeat(199) + rnd().slice(0, 1) });
    const long = await retry({ 'idempotency-key': 'k'.repeat(201) });
    const twice = await retry({ 'idempotency-key': ['a', 'b'] });
    const none = await retry({});
    expect([ok.status, long.status, long.body.error.path, twice.status, none.status]).toEqual([201, 422, ['headers', 'idempotency-key'], 422, 201]);
  });
  it('bodies of retry may be absent, null or {}; a report keeps working with extra keys and no summary', async () => {
    const ctx = newUser();
    const { routes } = mkDeps(s.repos);
    const run = await mkRun(s.repos, ctx);
    const out: number[] = [];
    for (const body of [undefined, null, {}]) out.push((await call(routes, URLS.retry, { ctx, params: sp(run, (await mkStep(s.repos, ctx, run.id, { status: 'failed' })).step), body })).status);
    const { step, token } = await mkStep(s.repos, ctx, run.id);
    const r = await call(routes, URLS.report, { ctx, params: sp(run, step), headers: { 'x-ctc-step-token': token }, body: { outcome: 'done', foo: 1 } });
    expect([out, r.body.applied, (await getStep(ctx, step.id))?.output]).toEqual([[201, 201, 201], true, { outcome: 'done', summary: null }]);
  });
  it('a summary is cut at 20,000 and a reason at 2,000 (not rejected); replies carry no token', async () => {
    const ctx = newUser();
    const { routes } = mkDeps(s.repos);
    const run = await mkRun(s.repos, ctx);
    const a = await mkStep(s.repos, ctx, run.id);
    const rep = await call(routes, URLS.report, { ctx, params: sp(run, a.step), headers: { 'x-ctc-step-token': a.token }, body: { outcome: 'done', summary: 'x'.repeat(20001) } });
    const u = await mkStep(s.repos, ctx, run.id, { status: 'start_unknown' });
    const f = await call(routes, URLS.fail, { ctx, params: sp(run, u.step), body: { reason: 'r'.repeat(2001) } });
    expect([((await getStep(ctx, a.step.id))?.output as { summary: string }).summary.length, f.body.step.error.length]).toEqual([20000, 2000]);
    expect(JSON.stringify([rep.body, f.body])).not.toMatch(new RegExp(`${a.token}|${a.step.tokenHash}|tokenHash`));
  });
});

describe('retry (D13)', () => {
  it('inserts attempt n+1 as queued, enqueues it once, and refuses an old attempt or a running step', async () => {
    const ctx = newUser();
    const { routes, enqueued } = mkDeps(s.repos);
    const run = await mkRun(s.repos, ctx);
    const { step } = await mkStep(s.repos, ctx, run.id, { status: 'failed' });
    const r = await call(routes, URLS.retry, { ctx, params: sp(run, step) });
    expect([r.status, r.body.created, r.body.enqueued, r.body.step.attempt, r.body.step.failureCount, r.body.step.retryOfStepId, enqueued]).toEqual([201, true, true, 2, 1, step.id, [r.body.step.id]]);
    expect((await call(routes, URLS.retry, { ctx, params: sp(run, step) })).body.error.code).toBe('stale_attempt');
    const running = await mkStep(s.repos, ctx, run.id);
    expect((await call(routes, URLS.retry, { ctx, params: sp(run, running.step) })).body.error.code).toBe('conflict');
  });
  it('the third failure is final: max_failures from the config, circuit_broken and the run failed', async () => {
    const ctx = newUser();
    const { routes } = mkDeps(s.repos, { config: { runner: { max_failures: 2 } } });
    const run = await mkRun(s.repos, ctx);
    const { step } = await mkStep(s.repos, ctx, run.id, { status: 'failed', attempt: 2, failureCount: 1 });
    const r = await call(routes, URLS.retry, { ctx, params: sp(run, step) });
    expect([r.status, r.body.error.code, (await getStep(ctx, step.id))?.status, (await s.repos.runner.getRun(ctx, run.id))?.status]).toEqual([409, 'conflict', 'circuit_broken', 'failed']);
  });
  it('a failing enqueue leaves the attempt queued with enqueued false; no enqueueStep also gives false', async () => {
    const ctx = newUser();
    const run = await mkRun(s.repos, ctx);
    const boom = mkDeps(s.repos, { enqueueStep: async () => { throw new Error('redis down'); } });
    const bare = mkDeps(s.repos, { enqueueStep: undefined });
    for (const { routes } of [boom, bare]) {
      const { step } = await mkStep(s.repos, ctx, run.id, { status: 'failed' });
      const r = await call(routes, URLS.retry, { ctx, params: sp(run, step) });
      expect([r.status, r.body.enqueued, r.body.step.status]).toEqual([201, false, 'queued']);
    }
  });
  it('two concurrent retries insert one attempt and enqueue it once', async () => {
    const ctx = newUser();
    const { routes, enqueued } = mkDeps(s.repos);
    const run = await mkRun(s.repos, ctx);
    const { step } = await mkStep(s.repos, ctx, run.id, { status: 'failed' });
    const both = await Promise.all([call(routes, URLS.retry, { ctx, params: sp(run, step) }), call(routes, URLS.retry, { ctx, params: sp(run, step) })]);
    expect(both.map((x) => x.status).sort()).toContain(201);
    expect([(await s.repos.runner.listSteps(ctx, run.id)).length, enqueued.length]).toEqual([2, 1]);
  });
});

describe('fail, report, cancel (D14-D17)', () => {
  it('fail marks only a start_unknown current attempt failed, with the default or given reason', async () => {
    const ctx = newUser();
    const { routes } = mkDeps(s.repos);
    const run = await mkRun(s.repos, ctx);
    const a = await mkStep(s.repos, ctx, run.id, { status: 'start_unknown' });
    const b = await mkStep(s.repos, ctx, run.id, { status: 'start_unknown' });
    const running = await mkStep(s.repos, ctx, run.id);
    const node = `n-${rnd()}`;
    const old = await mkStep(s.repos, ctx, run.id, { status: 'start_unknown', nodeId: node });
    await mkStep(s.repos, ctx, run.id, { status: 'queued', nodeId: node, attempt: 2, failureCount: 1 });
    expect((await call(routes, URLS.fail, { ctx, params: sp(run, a.step) })).body.step.error).toBe('marked failed by user');
    expect((await call(routes, URLS.fail, { ctx, params: sp(run, b.step), body: { reason: 'gone' } })).body.step.error).toBe('gone');
    expect((await call(routes, URLS.fail, { ctx, params: sp(run, running.step) })).body.error.code).toBe('conflict');
    expect((await call(routes, URLS.fail, { ctx, params: sp(run, old.step) })).body.error.code).toBe('stale_attempt');
  });
  it('a failed report fails the step with the summary; the third failure breaks the circuit and fails the run', async () => {
    const ctx = newUser();
    const { routes } = mkDeps(s.repos);
    const run = await mkRun(s.repos, ctx);
    const third = await mkStep(s.repos, ctx, run.id, { attempt: 3, failureCount: 2 });
    await call(routes, URLS.report, { ctx, params: sp(run, third.step), headers: { 'x-ctc-step-token': third.token }, body: { outcome: 'failed', summary: 'bad' } });
    const row = await getStep(ctx, third.step.id);
    expect([row?.status, row?.error, row?.output, row?.stage, (await s.repos.runner.getRun(ctx, run.id))?.status]).toEqual(['circuit_broken', 'bad', { outcome: 'failed', summary: 'bad' }, 'report', 'failed']);
  });
  it('two concurrent reports on one running step apply exactly once; a done report leaves the run status', async () => {
    const ctx = newUser();
    const { routes } = mkDeps(s.repos);
    const run = await mkRun(s.repos, ctx);
    const { step, token } = await mkStep(s.repos, ctx, run.id);
    const req = { ctx, params: sp(run, step), headers: { 'x-ctc-step-token': token }, body: { outcome: 'done' } };
    const both = await Promise.all([call(routes, URLS.report, req), call(routes, URLS.report, req)]);
    expect(both.map((x) => x.body.applied).sort()).toEqual([false, true]);
    expect((await s.repos.runner.getRun(ctx, run.id))?.status).toBe('running');
  });
  it('a report on a current attempt that is not running is a 200 no-op', async () => {
    const ctx = newUser();
    const { routes } = mkDeps(s.repos);
    const run = await mkRun(s.repos, ctx);
    const w = await mkStep(s.repos, ctx, run.id, { status: 'waiting' });
    const r = await call(routes, URLS.report, { ctx, params: sp(run, w.step), headers: { 'x-ctc-step-token': w.token }, body: { outcome: 'done' } });
    expect([r.status, r.body.applied, (await getStep(ctx, w.step.id))?.status]).toEqual([200, false, 'waiting']);
  });
  it('cancel moves the non-final steps and the run; a second cancel and a finished run are no-ops', async () => {
    const ctx = newUser();
    const { routes } = mkDeps(s.repos);
    const run = await mkRun(s.repos, ctx);
    const q = await mkStep(s.repos, ctx, run.id, { status: 'queued' });
    const d = await mkStep(s.repos, ctx, run.id, { status: 'done' });
    const f = await mkStep(s.repos, ctx, run.id, { status: 'failed' });
    const c = await call(routes, URLS.cancel, { ctx, params: { rid: String(run.id) } });
    expect([c.status, c.body.cancelled, c.body.run.status, typeof c.body.run.endedAt]).toEqual([200, 1, 'cancelled', 'string']);
    expect([(await getStep(ctx, q.step.id))?.status, (await getStep(ctx, d.step.id))?.status, (await getStep(ctx, f.step.id))?.status]).toEqual(['cancelled', 'done', 'failed']);
    expect((await call(routes, URLS.cancel, { ctx, params: { rid: String(run.id) } })).body.cancelled).toBe(0);
    const fin = await mkRun(s.repos, ctx, 'done');
    expect((await call(routes, URLS.cancel, { ctx, params: { rid: String(fin.id) } })).body).toMatchObject({ cancelled: 0, run: { status: 'done' } });
  });
  it('an internal error replies 500 with the class name only', async () => {
    const ctx = newUser();
    class Boom extends Error {}
    const broken = mkDeps({ ...s.repos, runner: { ...s.repos.runner, getRun: async () => { throw new Boom('secret'); } } });
    const r = await call(broken.routes, URLS.cancel, { ctx, params: { rid: '1' } });
    expect([r.status, r.body]).toEqual([500, { error: { code: 'internal', message: 'Boom' } }]);
  });
});

describe('idempotency on the routes (D18)', () => {
  it('fail and cancel replay the stored reply; a 422 is never stored', async () => {
    const ctx = newUser();
    const { routes } = mkDeps(s.repos);
    const run = await mkRun(s.repos, ctx);
    const { step } = await mkStep(s.repos, ctx, run.id, { status: 'start_unknown' });
    const headers = { 'idempotency-key': `kf-${rnd()}` };
    const f1 = await call(routes, URLS.fail, { ctx, params: sp(run, step), headers });
    const f2 = await call(routes, URLS.fail, { ctx, params: sp(run, step), headers });
    expect([f2.status, f2.body]).toEqual([f1.status, f1.body]);
    const ck = { 'idempotency-key': `kc-${rnd()}` };
    const c1 = await call(routes, URLS.cancel, { ctx, params: { rid: String(run.id) }, headers: ck });
    const c2 = await call(routes, URLS.cancel, { ctx, params: { rid: String(run.id) }, headers: ck });
    expect(c2.body).toEqual(c1.body);
    const k422 = { 'idempotency-key': `k4-${rnd()}` };
    await call(routes, URLS.cancel, { ctx, params: { rid: String(run.id) }, headers: k422, body: { junk: 1 } });
    expect(await s.repos.idempotency.lookup(ctx, { key: k422['idempotency-key'], route: URLS.cancel.slice(5) })).toBeNull();
  });
});
