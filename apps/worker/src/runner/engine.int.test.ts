import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { approveStep, cancelRun, retryStep, runnerJobId } from '@ctc/core/runner';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { advanceRun, cleanupHandlers, scheduleCleanup, startRunnerLoop, tickRuns } from './index.ts';
import { engineLimits } from './common.ts';
import { harness, restoreLimits, scratch, sleep, until, useFastLimits, type Harness, type Scratch } from './harness.ts';

let s: Scratch;
const open: Harness[] = [];
beforeAll(async () => {
  useFastLimits();
  s = await scratch();
}, 60_000);
afterAll(async () => {
  restoreLimits();
  for (const h of open) await h.close();
  await s?.drop();
});
const mk = (cfg: Record<string, unknown> = {}): Harness => {
  const h = harness(s, cfg);
  open.push(h);
  return h;
};
const T = { id: 't', type: 'trigger' };
const sh = (id: string, run: string, o: object = {}) => ({ id, type: 'shell', run, cwd: 'repo', ...o });
const wf = (nodes: object[], edges: object[]) => ({ name: 'wf', nodes: [T, ...nodes], edges });
const chain = (...ids: string[]) => ids.slice(1).map((to, i) => ({ from: ids[i], to }));
const cur = <S extends { nodeId: string }>(steps: S[], id: string): S | undefined => steps.filter((x) => x.nodeId === id).at(-1);

describe('engine (D1, D3, D6, D13, D15)', () => {
  it('runs a shell chain, passes outputs on and never lets an input reach the shell unquoted', async () => {
    const h = mk();
    const { run, repo } = await h.mkRun(wf([sh('a', 'echo {{input.x}} > out.txt; echo one'), sh('b', 'echo {{a.out}}-two')], chain('t', 'a', 'b')), { inputs: { x: 'a; touch PWNED' } });
    const final = await h.drive(run.id);
    expect(final.status).toBe('done');
    expect(final.startedAt).not.toBeNull();
    expect(final.endedAt).not.toBeNull();
    expect(fs.existsSync(path.join(repo, 'PWNED'))).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'out.txt'), 'utf8').trim()).toBe('a; touch PWNED');
    const b = cur(await h.stepsOf(run.id), 'b');
    expect(b?.output).toMatchObject({ exitCode: 0 });
    expect(JSON.stringify(b?.output)).toMatch(/one.*two/);
    expect(h.errors).toEqual([]);
  });

  it('gives the shell the scrubbed environment plus the step variables', async () => {
    const h = mk();
    process.env['CTC_DATABASE_URL'] = 'postgres://secret';
    try {
      const { run } = await h.mkRun(wf([sh('a', 'env')], chain('t', 'a')));
      await h.drive(run.id);
      const tail = String((cur(await h.stepsOf(run.id), 'a')?.output as { stdoutTail: string }).stdoutTail);
      expect(tail).not.toMatch(/^CTC_DATABASE_URL=/m);
      for (const k of ['CTC_ROOT_PATH', 'CTC_WORKTREE_PATH', 'CTC_RUN_ID', 'CTC_STEP_ID']) expect(tail).toMatch(new RegExp(`^${k}=`, 'm'));
    } finally {
      delete process.env['CTC_DATABASE_URL'];
    }
  });

  it('advanceRun called four times at once writes one row and submits one job', async () => {
    const h = mk();
    const { run } = await h.mkRun(wf([sh('a', 'true'), sh('b', 'true')], chain('t', 'a', 'b')));
    const results = await Promise.all([1, 2, 3, 4].map(() => advanceRun(h.deps, h.ctx, run.id)));
    expect(results.flatMap((r) => r.started)).toEqual(['a']);
    expect(await h.stepsOf(run.id)).toHaveLength(1);
    expect(new Set(h.submits.map((x) => x.id)).size).toBe(1);
    expect(await advanceRun(h.deps, { userId: 'someone-else' }, run.id)).toEqual({ status: null, started: [], skipped: [] });
  });

  it('loops through an if and a back-edge and stops when the condition holds', async () => {
    const h = mk();
    const { run, repo } = await h.mkRun(wf(
      [sh('count', 'n=$(cat count.txt 2>/dev/null || echo 0); echo $((n+1)) > count.txt'), sh('chk', 'if test $(cat count.txt) -ge 3; then echo yes; else echo no; fi'), { id: 'enough', type: 'if', op: 'eq', left: '{{chk.out}}', right: 'yes' }, sh('fin', 'echo finished')],
      [{ from: 't', to: 'count' }, { from: 'count', to: 'chk' }, { from: 'chk', to: 'enough' }, { from: 'enough', to: 'fin', handle: true }, { from: 'enough', to: 'count', handle: false }],
    ));
    expect((await h.drive(run.id)).status).toBe('done');
    expect(cur(await h.stepsOf(run.id), 'count')?.visit).toBe(3);
    expect(fs.readFileSync(path.join(repo, 'count.txt'), 'utf8').trim()).toBe('3');
  });

  it('a failing step parks the run as waiting, then the third failure breaks the circuit and fails the run', async () => {
    const h = mk();
    const { run } = await h.mkRun(wf([sh('bad', 'echo nope >&2; exit 3')], chain('t', 'bad')));
    const failedAt = (attempt: number) => async (_r: unknown, steps: { nodeId: string; attempt: number; status: string }[]) => {
      const c = cur(steps, 'bad');
      return c?.attempt === attempt && ['failed', 'circuit_broken'].includes(c.status) && h.active.size === 0;
    };
    await h.drive(run.id, { stop: failedAt(1) });
    await advanceRun(h.deps, h.ctx, run.id);
    expect((await s.repos.runner.getRun(h.ctx, run.id))?.status).toBe('waiting');
    for (const attempt of [2, 3]) {
      const last = cur(await h.stepsOf(run.id), 'bad');
      const { step } = await retryStep(s.repos.runner, h.ctx, { stepId: (last as { id: number }).id });
      await h.deps.submit({ queue: 'runner', kind: 'step', id: runnerJobId(step), payload: { userId: h.ctx.userId, runId: String(run.id), stepId: String(step.id), nodeId: 'bad', visit: 1, attempt, timeoutS: 60 } });
      await h.drive(run.id, { stop: failedAt(attempt) });
    }
    await advanceRun(h.deps, h.ctx, run.id);
    expect(cur(await h.stepsOf(run.id), 'bad')?.status).toBe('circuit_broken');
    expect((await s.repos.runner.getRun(h.ctx, run.id))?.status).toBe('failed');
    expect(cur(await h.stepsOf(run.id), 'bad')?.error).toBe('shell failed: exit 3');
  });

  it('times a shell out, refuses a missing worktree and kills the group of a cancelled run', async () => {
    const h = mk();
    const t = await h.mkRun(wf([sh('s', 'sleep 32', { timeout_s: 1 })], chain('t', 's')));
    const t0 = Date.now();
    await h.drive(t.run.id, { stop: (_r, steps) => cur(steps, 's')?.status === 'timeout' });
    expect(cur(await h.stepsOf(t.run.id), 's')?.error).toBe('shell timed out after 1 s');
    expect(Date.now() - t0).toBeLessThan(15_000);
    const none = await h.mkRun(wf([sh('s', 'echo hi', { cwd: 'worktree' })], chain('t', 's')));
    await h.drive(none.run.id, { stop: (_r, steps) => cur(steps, 's')?.status === 'failed' });
    expect(cur(await h.stepsOf(none.run.id), 's')?.error).toBe('no worktree to run in');
    const cn = await h.mkRun(wf([sh('s', 'sleep 31')], chain('t', 's')));
    await h.drive(cn.run.id, { stop: (_r, steps) => cur(steps, 's')?.status === 'running' });
    await sleep(300);
    await cancelRun(s.repos.runner, h.ctx, cn.run.id);
    await until(async () => h.active.size === 0, 15_000);
    expect(cur(await h.stepsOf(cn.run.id), 's')?.status).toBe('cancelled');
  }, 90_000);

  it('a quiet shell is not killed and the output cap is inclusive', async () => {
    const h = mk();
    const keep = engineLimits.shellOutputMaxBytes;
    engineLimits.shellOutputMaxBytes = 100;
    try {
      const over = await h.mkRun(wf([sh('s', 'yes | head -c 5000')], chain('t', 's')));
      await h.drive(over.run.id, { stop: (_r, steps) => cur(steps, 's')?.status === 'failed' });
      expect(cur(await h.stepsOf(over.run.id), 's')?.error).toMatch(/^shell output over/);
      const exact = await h.mkRun(wf([sh('s', 'head -c 100 /dev/zero | tr "\\0" x')], chain('t', 's')));
      expect((await h.drive(exact.run.id)).status).toBe('done');
    } finally {
      engineLimits.shellOutputMaxBytes = keep;
    }
    const quiet = await h.mkRun(wf([sh('s', 'sleep 1; true')], chain('t', 's')));
    expect((await h.drive(quiet.run.id)).status).toBe('done');
  }, 60_000);

  it('the tick and the loop start a run nobody advanced', async () => {
    const h = mk();
    const a = await h.mkRun(wf([sh('a', 'true')], chain('t', 'a')));
    expect((await tickRuns(h.deps)).advanced).toContain(a.run.id);
    const b = await h.mkRun(wf([sh('a', 'true')], chain('t', 'a')));
    const loop = startRunnerLoop(h.deps);
    try {
      await until(async () => (await h.stepsOf(b.run.id)).length === 1);
    } finally {
      await loop.stop();
    }
  });
});

describe('gates and cleanup (D16, D22)', () => {
  it('an approval waits, the answer reaches the next prompt, and reject cancels the run', async () => {
    const h = mk();
    const flow = wf(
      [{ id: 'gate', type: 'approval', question: 'Merge {{input.topic}}?', options: [{ id: 'merge', label: 'Merge' }, { id: 'rework', label: 'Rework' }] }, { id: 'next', type: 'agent', agent: 'claude', worktree: 'none', prompt: 'FAKE_SAY=x final after {{resolution}} and {{gate.out}}' }],
      chain('t', 'gate', 'next'),
    );
    const { run } = await h.mkRun(flow, { inputs: { topic: 'widgets' } });
    await h.drive(run.id, { stop: (r, steps) => r.status === 'waiting' && cur(steps, 'gate')?.status === 'waiting' });
    const gate = cur(await h.stepsOf(run.id), 'gate');
    expect(gate?.options).toEqual([{ id: 'merge', label: 'Merge' }, { id: 'rework', label: 'Rework' }]);
    expect(gate?.output).toMatchObject({ question: 'Merge widgets?' });
    expect(h.snapshots()).toEqual([]);
    await approveStep(s.repos.runner, h.ctx, { stepId: (gate as { id: number }).id, optionId: 'merge' });
    expect((await h.drive(run.id)).status).toBe('done');
    expect(h.snapshots().some((x) => x.stdin.includes('final after merge and merge'))).toBe(true);

    const rej = await h.mkRun(wf([{ id: 'gate', type: 'approval', question: 'go?' }, sh('after', 'echo no > after.txt')], chain('t', 'gate', 'after')));
    await h.drive(rej.run.id, { stop: (_r, steps) => cur(steps, 'gate')?.status === 'waiting' });
    await approveStep(s.repos.runner, h.ctx, { stepId: (cur(await h.stepsOf(rej.run.id), 'gate') as { id: number }).id, optionId: 'reject' });
    expect((await h.drive(rej.run.id)).status).toBe('cancelled');
    expect(fs.existsSync(path.join(rej.repo, 'after.txt'))).toBe(false);
  }, 60_000);

  it('cleanup waits for keep_days, then gzips the logs, removes clean worktrees without force, keeps dirty ones and branches', async () => {
    const h = mk({ worktree: { add_timeout_s: 30, dir: '.ctc/wt', keep_days: 0 } });
    const flow = wf([{ id: 'a', type: 'agent', agent: 'claude', prompt: 'FAKE_WRITE=a.txt:x' }, { id: 'b', type: 'agent', agent: 'claude', prompt: 'FAKE_WRITE=b.txt:y' }, sh('l', 'echo log-line', { cwd: 'worktree' })], chain('t', 'a', 'b', 'l'));
    const { run, repo } = await h.mkRun(flow);
    expect((await h.drive(run.id)).status).toBe('done');
    const steps = await h.stepsOf(run.id);
    const a = cur(steps, 'a');
    const b = cur(steps, 'b');
    fs.writeFileSync(path.join(a?.worktree as string, 'untracked.txt'), 'precious');
    const logged = steps.filter((x) => x.logPath !== null && fs.existsSync(x.logPath as string));
    const handlers = cleanupHandlers(h.deps);
    const call = (name: 'cleanup.worktree' | 'cleanup.receipts', payload: object) =>
      (handlers[name] as unknown as (p: object, c: object) => Promise<Record<string, unknown>>)(payload, { jobId: 'c', attempt: 1, signal: new AbortController().signal, setProgress: async () => undefined });
    const keepLater = mk({ worktree: { add_timeout_s: 30, dir: '.ctc/wt', keep_days: 7 } });
    const early = await (cleanupHandlers(keepLater.deps)['cleanup.worktree'] as unknown as (p: object, c: object) => Promise<unknown>)({ userId: h.ctx.userId, runId: String(run.id) }, {});
    expect(early).toEqual({ runId: String(run.id), removed: 0, kept: [], archived: 0, due: false });
    const res = await call('cleanup.worktree', { userId: h.ctx.userId, runId: String(run.id) });
    expect(res['due']).toBe(true);
    expect(res['kept']).toEqual([{ stepId: a?.id, reason: 'dirty' }]);
    expect(fs.existsSync(path.join(a?.worktree as string, 'untracked.txt'))).toBe(true);
    expect(fs.existsSync(b?.worktree as string)).toBe(false);
    expect(h.branches(repo)).toHaveLength(2);
    for (const x of logged) {
      expect(fs.existsSync(x.logPath as string)).toBe(false);
      expect(zlib.gunzipSync(fs.readFileSync(`${x.logPath}.gz`)).length).toBeGreaterThan(0);
    }
    expect((await call('cleanup.worktree', { userId: h.ctx.userId, runId: String(run.id) }))['removed']).toBe(0);
    await expect(call('cleanup.worktree', { userId: h.ctx.userId, runId: '999999999' })).rejects.toMatchObject({ code: 'run_not_found' });
    expect(typeof (await call('cleanup.receipts', {}))['pruned']).toBe('number');
    expect((await scheduleCleanup(h.deps)).submitted).toBeGreaterThanOrEqual(1);
    const job = h.submits.find((x) => x.queue === 'cleanup');
    expect(job?.id).toMatch(/^cleanup:worktree:\d+$/);
  }, 60_000);
});
