import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { URLS, call, mkDeps, mkRun, mkStep, newUser, rnd, scratch, type Scratch } from './testing.ts';

let s: Scratch;
beforeAll(async () => {
  s = await scratch();
}, 60_000);
afterAll(async () => {
  await s?.drop();
});

describe('runner.idempotent', () => {
  it('same key and same payload replays the stored response', async () => {
    const ctx = newUser();
    const { routes, enqueued } = mkDeps(s.repos);
    const run = await mkRun(s.repos, ctx);
    const { step } = await mkStep(s.repos, ctx, run.id, { status: 'failed' });
    const req = { ctx, params: { rid: String(run.id), sid: String(step.id) }, headers: { 'idempotency-key': `k-${rnd()}` } };
    const first = await call(routes, URLS.retry, req);
    const second = await call(routes, URLS.retry, req);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(second.body).toEqual(first.body);
    expect((await s.repos.runner.listSteps(ctx, run.id)).length).toBe(2);
    expect(enqueued).toEqual([first.body.step.id]);
  });

  it('same key with a different payload gets 409 idempotency_mismatch', async () => {
    const ctx = newUser();
    const { routes, enqueued } = mkDeps(s.repos);
    const run = await mkRun(s.repos, ctx);
    const a = await mkStep(s.repos, ctx, run.id, { status: 'failed' });
    const b = await mkStep(s.repos, ctx, run.id, { status: 'failed' });
    const headers = { 'idempotency-key': `k-${rnd()}` };
    await call(routes, URLS.retry, { ctx, params: { rid: String(run.id), sid: String(a.step.id) }, headers });
    const clash = await call(routes, URLS.retry, { ctx, params: { rid: String(run.id), sid: String(b.step.id) }, headers });
    expect([clash.status, clash.body.error.code]).toEqual([409, 'idempotency_mismatch']);
    expect((await s.repos.runner.listSteps(ctx, run.id)).length).toBe(3);
    expect(enqueued.length).toBe(1);
  });
});
