import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STEP_STATUSES, canTransition, transitionStep } from '@ctc/core/runner';
import { URLS, call, mkDeps, mkRun, mkStep, newUser, scratch, sha, type Scratch } from './testing.ts';

let s: Scratch;
beforeAll(async () => {
  s = await scratch();
}, 60_000);
afterAll(async () => {
  await s?.drop();
});

const sp = (run: { id: number }, step: { id: number }) => ({ rid: String(run.id), sid: String(step.id) });

describe('runner.lifecycle', () => {
  it('every illegal from-to transition is rejected', async () => {
    const ctx = newUser();
    const run = await mkRun(s.repos, ctx);
    let legal = 0;
    for (const from of STEP_STATUSES) {
      for (const to of STEP_STATUSES) {
        const { step } = await mkStep(s.repos, ctx, run.id, { status: from });
        const attempt = transitionStep(s.repos.runner, ctx, { stepId: step.id, from, to });
        if (canTransition(from, to)) {
          legal++;
          expect((await attempt).status, `${from} -> ${to}`).toBe(to);
        } else {
          await expect(attempt, `${from} -> ${to}`).rejects.toMatchObject({ name: 'RunnerError', code: 'conflict' });
          expect((await s.repos.runner.getStep(ctx, step.id))?.status, `${from} unchanged`).toBe(from);
        }
      }
    }
    expect(legal).toBe(19);
  }, 120_000);

  it('a duplicate report is a no-op', async () => {
    const ctx = newUser();
    const { routes } = mkDeps(s.repos);
    const run = await mkRun(s.repos, ctx);
    const { step, token } = await mkStep(s.repos, ctx, run.id);
    const req = { ctx, params: sp(run, step), headers: { 'x-ctc-step-token': token } };
    const first = await call(routes, URLS.report, { ...req, body: { outcome: 'done', summary: 'ok' } });
    const row = await s.repos.runner.getStep(ctx, step.id);
    const again = await call(routes, URLS.report, { ...req, body: { outcome: 'done', summary: 'other' } });
    expect([first.status, first.body.applied, row?.status, again.status, again.body.applied]).toEqual([200, true, 'done', 200, false]);
    expect(await s.repos.runner.getStep(ctx, step.id)).toEqual(row);
  });

  it('a report from an old attempt gets 409 stale_attempt', async () => {
    const ctx = newUser();
    const { routes } = mkDeps(s.repos);
    const run = await mkRun(s.repos, ctx);
    const nodeId = 'same-node';
    const old = await mkStep(s.repos, ctx, run.id, { nodeId });
    await mkStep(s.repos, ctx, run.id, { nodeId, attempt: 2, failureCount: 1 });
    const r = await call(routes, URLS.report, { ctx, params: sp(run, old.step), headers: { 'x-ctc-step-token': old.token }, body: { outcome: 'done' } });
    expect([r.status, r.body.error.code]).toEqual([409, 'stale_attempt']);
    expect((await s.repos.runner.getStep(ctx, old.step.id))?.status).toBe('running');
    expect(sha(old.token)).toBe(old.step.tokenHash);
  });
});
