import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cancelRun, reportStep, transitionStep } from '@ctc/core/runner';
import { sweepRunner } from './index.ts';
import { alive, git, groupAlive, harness, restoreLimits, scratch, sleep, until, useFastLimits, type Harness, type Scratch } from './testing.ts';

let s: Scratch;
let h: Harness;
beforeAll(async () => {
  s = await scratch();
  h = harness(s);
  useFastLimits();
}, 60_000);
afterAll(async () => {
  restoreLimits();
  h?.killAll();
  await s?.drop();
  h?.remove();
});

const sha = (t: string): string => createHash('sha256').update(t).digest('hex');
const dropCode = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { return (e as { code?: string }).code ?? 'no code'; }
  return 'resolved';
};
const live = (a: Awaited<ReturnType<Harness['mk']>>) => until(async () => { const st = await h.getStep(a.ctx, a.step.id); return st.pid && st.stage === 'stream' ? st : null; });

describe('runner.step handler: a dev instance (O12)', () => {
  it('refuses to spawn an agent or create a worktree', async () => {
    const a = await h.mk();
    const { step } = await h.go(a, h.deps({ dev: true }));
    expect([step.status, step.error]).toEqual(['failed', 'spawn refused: dev instance']);
    expect(h.snaps(a.step.id)).toEqual([]);
    expect(git(a.repo as string, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  });
});

describe('runner.step handler: a normal attempt (D0, D1, D3, D12, D14, D16)', () => {
  it('runs the agent in a new worktree and ends done with summary, usage, cost and diff stat', async () => {
    h.ended.length = 0;
    const a = await h.mk({ edit: true });
    const { res, step } = await h.go(a);
    expect(res).toEqual({ stepId: a.step.id, status: 'done', skipped: false });
    expect([step.stage, step.error, step.promptOutcome, step.usage, step.costUsd]).toEqual(['report', null, 'delivered', { input_tokens: 5, output_tokens: 7 }, 0.25]);
    expect(step.output).toMatchObject({ outcome: 'done', summary: 'final answer' });
    expect((step.output as { diffStat: string }).diffStat).toMatch(/1 file changed/);
    expect(step.branch).toBe(`ctc/wf-${a.run.id}-${a.nodeId}-s${a.step.id}`);
    expect(step.worktree).toBe(path.join(a.repo as string, '.ctc/wt', String(a.run.id), String(a.step.id)));
    expect(git(a.repo as string, 'config', `branch.${step.branch}.base`).trim()).toBe('main');
    expect(git(a.repo as string, 'status', '--porcelain').trim()).toBe('');
    expect(h.ended.filter((e) => e.id === a.step.id)).toHaveLength(1);
  });

  it('gives the agent a scrubbed environment, the token only there, and the prompt on stdin', async () => {
    process.env['CTC_SECRET_CANARY'] = 'canary';
    const a = await h.mk({ repo: h.mkRepo({ name: "re po'x $HOME" }) });
    const { step } = await h.go(a);
    const snap = h.snaps(a.step.id)[0]!;
    expect(Object.keys(snap.env).filter((k) => k.startsWith('CTC_') && k !== 'CTC_SECRET_CANARY').sort()).toEqual(
      ['CTC_REPORT_URL', 'CTC_ROOT_PATH', 'CTC_RUN_ID', 'CTC_STEP_ID', 'CTC_STEP_TOKEN', 'CTC_WORKTREE_PATH'],
    );
    expect(snap.env['CTC_SECRET_CANARY']).toBeUndefined();
    const token = snap.env['CTC_STEP_TOKEN'] as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(step.tokenHash).toBe(sha(token));
    expect(snap.env['CTC_REPORT_URL']).toBe(`http://127.0.0.1:18410/api/runs/${a.run.id}/steps/${a.step.id}/report`);
    expect(snap.argv).toEqual(['--verbose', '--permission-mode', 'acceptEdits']);
    expect(snap.stdin).toContain('do the thing');
    const dir = path.join(h.runs, String(a.run.id));
    const files = ['prompt', 'jsonl', 'err', 'exit'].map((e) => path.join(dir, `${a.step.id}.${e}`));
    for (const f of files) expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    const haystack = [...files.map((f) => fs.readFileSync(f, 'utf8')), JSON.stringify(step), JSON.stringify(snap.argv)].join('\n');
    expect(haystack.includes(token)).toBe(false);
  });

  it('treats a silent agent, a noisy stream and worktree none or parent as valid', async () => {
    const silent = await h.mk({ mode: 'silent' });
    const sr = await h.go(silent);
    expect([sr.step.status, sr.step.output, sr.step.promptOutcome]).toEqual(['done', { outcome: 'done', summary: null, diffStat: '' }, 'not_delivered']);
    const noisy = await h.mk({ mode: 'noise' });
    expect((await h.go(noisy)).step.output).toMatchObject({ summary: 'final answer' });
    const none = await h.mk({ node: { worktree: 'none' } });
    const nr = await h.go(none);
    expect([nr.step.status, nr.step.worktree, nr.step.branch, nr.step.output]).toEqual(['done', null, null, { outcome: 'done', summary: 'final answer' }]);
    const parentDir = fs.mkdtempSync(path.join(h.tmp, 'parent-'));
    const parent = await h.mk({ node: { worktree: 'parent', parentWorktree: parentDir } });
    const pr = await h.go(parent);
    expect([pr.step.status, pr.step.worktree, pr.step.branch]).toEqual(['done', parentDir, null]);
  });

  it('keeps the worktree and branch of a failed attempt and breaks the circuit on the third failure', async () => {
    const f = await h.mk({ mode: 'fail' });
    const fr = await h.go(f);
    expect([fr.step.status, fr.step.error, fr.step.output]).toMatchObject(['failed', 'exit 3: bad thing', { outcome: 'failed', summary: 'working' }]);
    expect(fs.existsSync(fr.step.worktree as string)).toBe(true);
    expect(git(f.repo as string, 'rev-parse', '--verify', `refs/heads/${fr.step.branch}`).trim()).toMatch(/^[0-9a-f]{40}$/);
    const cb = await h.mk({ mode: 'fail', failureCount: 2 });
    expect((await h.go(cb)).step.status).toBe('circuit_broken');
    expect((await s.repos.runner.getRun(cb.ctx, cb.run.id))?.status).toBe('failed');
  });
});

describe('runner.step handler: bad input (D4)', () => {
  it('drops an unknown step and a payload mismatch, skips a repeat, and fails what it cannot run safely', async () => {
    const a = await h.mk();
    expect(await dropCode(h.call({ ...a, payload: { ...a.payload, stepId: '999999999' } }))).toBe('step_not_found');
    expect(await dropCode(h.call({ ...a, payload: { ...a.payload, userId: h.ctxB.userId } }))).toBe('step_not_found');
    expect(await dropCode(h.call({ ...a, payload: { ...a.payload, nodeId: 'other' } }))).toBe('payload_mismatch');
    expect((await h.getStep(a.ctx, a.step.id)).status).toBe('queued');
    const [r1, r2] = await Promise.all([h.call(a), h.call(a)]);
    expect([r1.skipped, r2.skipped].sort()).toEqual([false, true]);
    expect((await h.call(a)).skipped).toBe(true);
    expect(h.snaps(a.step.id)).toHaveLength(1);

    const err = async (o: Parameters<Harness['mk']>[0]): Promise<string | null> => (await h.go(await h.mk(o))).step.error;
    expect(await err({ node: { agent: 'nope' } })).toBe('spawn refused: unknown agent nope');
    expect(await err({ node: { permission: 'bypassPermissions' } })).toBe('spawn refused: permission bypassPermissions not allowed');
    expect(await err({ node: { model: '--evil' } })).toBe('spawn refused: model not allowed');
    expect(await err({ repo: fs.mkdtempSync(path.join(h.tmp, 'plain-')) })).toBe('worktree failed: not a git repository');
    expect(await err({ ctcYaml: 'setup: 5\n' })).toBe('setup config invalid');
    const noRepo = await h.go(await h.mk({ repo: null }));
    expect([noRepo.step.error, noRepo.step.promptOutcome]).toEqual(['worktree failed: not a git repository', 'not_delivered']);
    const missing = await h.mk();
    h.nodes.delete(missing.nodeId);
    expect((await h.go(missing)).step.error).toBe('node not found');
  });

  it('never kills a quiet agent and never edits frozen inputs', async () => {
    const q = await h.mk({ sleep: 1500 });
    const t0 = Date.now();
    expect((await h.go(q)).step.status).toBe('done');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1400);
    const fz = await h.mk();
    const frozen = Object.freeze({ ...fz.payload });
    const cfg = JSON.parse(JSON.stringify(h.config())) as ReturnType<Harness['config']>;
    cfg.runner.agents = Object.freeze({ claude: Object.freeze({ argv: Object.freeze([...cfg.runner.agents['claude']!.argv]) as unknown as string[] }) });
    const res = await h.call({ payload: frozen, ac: fz.ac }, h.deps({ config: cfg }));
    expect(res.status).toBe('done');
  });
});

describe('runner.step handler: repo setup (D13, D20)', () => {
  it('runs setup in the worktree with the two env vars, stops at the first failure and keeps CTC secrets out', async () => {
    process.env['CTC_SECRET_CANARY'] = 'canary';
    const yaml = 'setup: |\n  echo ran > setup-ran.txt\n  echo "$CTC_WORKTREE_PATH" > wt.txt\n  env | grep -c CTC_SECRET_CANARY > canary.txt || true\n  echo log-line\n';
    const a = await h.mk({ ctcYaml: yaml });
    const { step } = await h.go(a);
    const rd = (f: string): string => fs.readFileSync(path.join(step.worktree as string, f), 'utf8').trim();
    expect([step.status, rd('setup-ran.txt'), rd('wt.txt'), rd('canary.txt')]).toEqual(['done', 'ran', step.worktree, '0']);
    expect(fs.readFileSync(path.join(h.runs, String(a.run.id), `${a.step.id}.setup.log`), 'utf8')).toContain('log-line');
    const order = await h.mk({ ctcYaml: 'setup:\n  - echo a >> order.txt\n  - exit 2\n  - echo c >> order.txt\n' });
    const or = await h.go(order);
    expect([or.step.status, or.step.error, or.step.stage, fs.readFileSync(path.join(or.step.worktree as string, 'order.txt'), 'utf8')]).toEqual(['failed', 'setup failed: exit 2', 'setup', 'a\n']);
    expect(h.snaps(order.step.id)).toHaveLength(0);
  });

  it('fails on a setup timeout (group killed) and on output over the cap', async () => {
    const slow = await h.mk({ ctcYaml: 'setup: "sleep 30 & echo $! > bg.pid; wait"\n' });
    const sr = await h.go(slow, h.deps({}, { setup: { timeout_s: 1, max_output_mb: 1, policy: 'run' } }));
    expect([sr.step.status, sr.step.error]).toEqual(['failed', 'setup timed out after 1 s']);
    const bg = Number(fs.readFileSync(path.join(sr.step.worktree as string, 'bg.pid'), 'utf8').trim());
    await until(async () => !alive(bg), 3000);
    const big = await h.mk({ ctcYaml: "setup: \"head -c 1100000 /dev/zero | tr '\\\\0' x\"\n" });
    expect((await h.go(big)).step.error).toBe('setup output over 1 MB');
  });

  it('honours the policy: skip runs nothing, ask parks the step and the run before any git write, a decision resumes', async () => {
    const yaml = 'setup: "echo ran > setup-ran.txt"\n';
    const ranIn = (st: { worktree: string | null }): boolean => fs.existsSync(path.join(st.worktree as string, 'setup-ran.txt'));
    const skip = await h.mk({ ctcYaml: yaml });
    expect(ranIn((await h.go(skip, h.deps({}, { setup: { timeout_s: 10, max_output_mb: 1, policy: 'skip' } }))).step)).toBe(false);
    const askDeps = h.deps({}, { setup: { timeout_s: 10, max_output_mb: 1, policy: 'ask' } });
    const ask = await h.mk({ ctcYaml: yaml, runStatus: 'queued' });
    const parked = await h.go(ask, askDeps);
    expect(parked.res).toEqual({ stepId: ask.step.id, status: 'waiting', skipped: false });
    expect(parked.step.options).toEqual([{ id: 'run', label: 'Run setup' }, { id: 'skip', label: 'Skip setup' }]);
    expect([parked.step.stage, parked.step.branch]).toEqual([null, null]);
    expect(git(ask.repo as string, 'branch', '--list', 'ctc/*').trim()).toBe('');
    expect((await s.repos.runner.getRun(ask.ctx, ask.run.id))?.status).toBe('waiting');
    const runIt = await h.mk({ ctcYaml: yaml, node: { setupDecision: 'run' } });
    expect(ranIn((await h.go(runIt, askDeps)).step)).toBe(true);
    const skipIt = await h.mk({ ctcYaml: yaml, node: { setupDecision: 'skip' } });
    expect(ranIn((await h.go(skipIt, askDeps)).step)).toBe(false);
  });
});

describe('runner.step handler: following the agent (D15, D17)', () => {
  it('stops the setup process when the step is cancelled during setup', async () => {
    const marker = path.join(h.tmp, `setup-ran-${Date.now()}`);
    const c = await h.mk({ ctcYaml: `setup:\n  - sleep 3; touch ${marker}\n` });
    const pending = h.go(c);
    await until(async () => (await h.getStep(c.ctx, c.step.id)).stage === 'setup');
    await sleep(300);
    await transitionStep(s.repos.runner, c.ctx, { stepId: c.step.id, from: 'running', to: 'cancelled' });
    expect((await pending).step.status).toBe('cancelled');
    await sleep(3500);
    expect(fs.existsSync(marker)).toBe(false);
  }, 20_000);

  it('kills the group when the step is cancelled', async () => {
    const c = await h.mk({ mode: 'hang' });
    const pending = h.go(c);
    const st = await live(c);
    await transitionStep(s.repos.runner, c.ctx, { stepId: c.step.id, from: 'running', to: 'cancelled' });
    expect((await pending).step.status).toBe('cancelled');
    await until(async () => !groupAlive(st.pid as number), 4000);
  });

  it('lets a report win over the exit and stops the lingering agent', async () => {
    const r = await h.mk({ mode: 'hang' });
    const pending = h.go(r);
    const st = await live(r);
    expect((await reportStep(s.repos.runner, r.ctx, { stepId: r.step.id, outcome: 'done', summary: 'by agent' })).applied).toBe(true);
    const { step } = await pending;
    expect([step.status, step.output]).toMatchObject(['done', { outcome: 'done', summary: 'by agent' }]);
    await until(async () => !groupAlive(st.pid as number), 4000);
  });

  it('stops a background process the agent left running after a normal exit (D6g)', async () => {
    const pidf = path.join(h.tmp, 'bg-left.pid');
    const argv = ['/bin/sh', '-c', `cat >/dev/null; sleep 300 & echo $! > '${pidf}'; echo '{"type":"result","result":"ok"}'`];
    const a = await h.mk({});
    const { step } = await h.go(a, h.deps({}, { agents: { claude: { argv }, codex: { argv } } }));
    expect(step.status).toBe('done');
    const bg = Number(fs.readFileSync(pidf, 'utf8').trim());
    expect([alive(bg), groupAlive(step.pid as number)]).toEqual([false, false]);
  });

  it('parks step and run on a usage limit', async () => {
    const q = await h.mk({ mode: 'quota' });
    const { step } = await h.go(q);
    expect([step.status, step.error]).toEqual(['quota', 'usage limit until 2030-01-01T00:00:00.000Z']);
    expect((await s.repos.runner.getRun(q.ctx, q.run.id))?.status).toBe('quota');
    await until(async () => !groupAlive(step.pid as number), 4000);
  });

  it('parks step and run on a usage limit when the agent prints it and exits', async () => {
    const q = await h.mk({ mode: 'quota_exit' });
    const { step } = await h.go(q);
    expect([step.status, step.error]).toEqual(['quota', 'usage limit until 2030-01-01T00:00:00.000Z']);
    expect((await s.repos.runner.getRun(q.ctx, q.run.id))?.status).toBe('quota');
  });

  it('marks the step start_unknown when the agent group vanishes without an exit record', async () => {
    const u = await h.mk({ mode: 'suicide' });
    const { step } = await h.go(u);
    expect([step.status, step.liveness]).toEqual(['start_unknown', 'start_unknown']);
    expect((await s.repos.runner.getRun(u.ctx, u.run.id))?.status).toBe('waiting');
  });

  it('times out on the abort signal, killing the agent group, and also during setup', async () => {
    const a = await h.mk({ mode: 'hang', node: { timeoutS: 1 } });
    const pending = h.go(a);
    const st = await live(a);
    a.ac.abort();
    const { step } = await pending;
    expect([step.status, step.error]).toEqual(['timeout', 'timeout after 1 s']);
    await until(async () => !groupAlive(st.pid as number), 4000);
    const b = await h.mk({ ctcYaml: 'setup: "sleep 30 & echo $! > bg.pid; wait"\n', node: { timeoutS: 1 } });
    const pb = h.go(b);
    const file = await until(async () => { const w = (await h.getStep(b.ctx, b.step.id)).worktree; const f = w && path.join(w, 'bg.pid'); return f && fs.existsSync(f) && fs.readFileSync(f, 'utf8').trim() ? f : null; });
    b.ac.abort();
    expect((await pb).step.error).toBe('timeout after 1 s');
    await until(async () => !alive(Number(fs.readFileSync(file, 'utf8').trim())), 3000);
    expect(h.snaps(b.step.id)).toHaveLength(0);
  });

  it('stops after a cancelled run without starting the agent when the step is gone before the spawn', async () => {
    const c = await h.mk({ ctcYaml: 'setup: "sleep 1"\n' });
    const pending = h.go(c);
    await until(async () => (await h.getStep(c.ctx, c.step.id)).stage === 'setup');
    await cancelRun(s.repos.runner, c.ctx, c.run.id);
    expect((await pending).step.status).toBe('cancelled');
    await sleep(200);
    expect(h.snaps(c.step.id)).toHaveLength(0);
  });
});

describe('sweepRunner (D18)', () => {
  /** A running step as a crashed worker would leave it. */
  async function fab(o: { stage: string | null; pid?: number | null; pidStartedAt?: Date | null; exit?: number; log?: string; runStatus?: string }) {
    const ctx = h.ctxA;
    const run = await s.repos.runner.createRun(ctx, { owner: `o-${Math.random()}`, trigger: 'api', repo: null });
    await s.repos.runner.setRunStatus(ctx, run.id, { from: 'queued', to: o.runStatus ?? 'running' });
    const nodeId = `n${Math.random()}`;
    h.nodes.set(nodeId, { agent: 'claude', worktree: 'none', permission: 'acceptEdits', timeoutS: 3600, workflow: 'wf', prompt: 'p' });
    const { step } = await s.repos.runner.insertStep(ctx, { runId: run.id, nodeId, visit: 1, attempt: 1, status: 'running', stage: o.stage, pid: o.pid ?? null, pidStartedAt: o.pidStartedAt ?? null });
    const dir = path.join(h.runs, String(run.id));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${step.id}.jsonl`), o.log ?? '');
    if (o.exit !== undefined) fs.writeFileSync(path.join(dir, `${step.id}.exit`), String(o.exit));
    return { ctx, run, step };
  }
  const sleepers: number[] = [];
  afterAll(() => { for (const pid of sleepers) try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } });

  it('fails a step interrupted before spawn, finishes one with an exit record, and parks one with no live pid', async () => {
    const log = [{ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }, { type: 'result', result: 'from log', usage: { input_tokens: 1 }, total_cost_usd: 0.1 }].map((x) => JSON.stringify(x)).join('\n') + '\n';
    const f1 = await fab({ stage: null });
    const f2 = await fab({ stage: 'worktree' });
    const f3 = await fab({ stage: 'stream', exit: 0, log });
    const f4 = await fab({ stage: 'stream', exit: 3, log });
    const f5 = await fab({ stage: 'stream' });
    const f6 = await fab({ stage: 'stream', runStatus: 'done' });
    const res = await sweepRunner(h.deps());
    await res.settled;
    const action = (f: { step: { id: number } }) => res.actions.find((x) => x.stepId === f.step.id)?.action;
    expect([f1, f2, f3, f4, f5, f6].map(action)).toEqual(['fail_stage', 'fail_stage', 'finish', 'finish', 'start_unknown', 'start_unknown']);
    const row = (f: { step: { id: number } }) => h.getStep(h.ctxA, f.step.id);
    expect([(await row(f1)).error, (await row(f2)).error]).toEqual(['interrupted before stage worktree', 'interrupted at stage worktree']);
    const g3 = await row(f3);
    expect([g3.status, (g3.output as { summary: string }).summary, g3.usage, g3.costUsd]).toEqual(['done', 'from log', { input_tokens: 1 }, 0.1]);
    expect([(await row(f4)).status, (await row(f4)).error]).toEqual(['failed', 'exit 3']);
    const g5 = await row(f5);
    expect([g5.status, g5.liveness, g5.promptOutcome]).toEqual(['start_unknown', 'start_unknown', 'unconfirmed']);
    expect((await s.repos.runner.getRun(h.ctxA, f5.run.id))?.status).toBe('waiting');
    expect((await s.repos.runner.getRun(h.ctxA, f6.run.id))?.status).toBe('done');
  });

  it('kills an orphan setup group only while its start time matches, and signals nothing with a different start time', async () => {
    const { spawn } = await import('node:child_process');
    const { procStartTime } = await import('./index.ts');
    const mkSleeper = () => { const c = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' }); c.unref(); sleepers.push(c.pid as number); return c.pid as number; };
    const orphan = mkSleeper();
    const foreign = mkSleeper();
    const started = (await procStartTime(foreign)) as Date;
    const f1 = await fab({ stage: 'setup', pid: orphan, pidStartedAt: await procStartTime(orphan) });
    const f2 = await fab({ stage: 'setup', pid: foreign, pidStartedAt: new Date(started.getTime() + 600_000) });
    const f3 = await fab({ stage: 'stream', pid: foreign, pidStartedAt: new Date(started.getTime() + 600_000) });
    const res = await sweepRunner(h.deps());
    expect([f1, f2, f3].map((f) => res.actions.find((x) => x.stepId === f.step.id)?.action)).toEqual(['fail_stage', 'fail_stage', 'start_unknown']);
    await until(async () => !alive(orphan), 8000);
    expect(alive(foreign)).toBe(true);
    expect((await h.getStep(h.ctxA, f1.step.id)).error).toBe('interrupted at stage setup');
  });
});

describe('runner.step handler: no exit path leaves the agent group running (D6g)', () => {
  type Port = typeof s.repos.runner;
  /** Repositories whose runner port runs `hook` in place of the named method. */
  const wrap = <K extends keyof Port>(name: K, hook: (orig: Port[K], ...args: unknown[]) => unknown) => {
    const runner = new Proxy(s.repos.runner, {
      get: (t, k) => (k === name ? (...args: unknown[]) => hook((t[name] as (...a: unknown[]) => unknown).bind(t) as Port[K], ...args) : (t as never)[k]),
    });
    return { ...s.repos, runner } as typeof s.repos;
  };
  const probe = async (a: Awaited<ReturnType<Harness['mk']>>, repos: typeof s.repos) => {
    const out = await h.go(a, h.deps({ repos }));
    const st = await h.getStep(a.ctx, a.step.id);
    await sleep(1500);
    return { out, st, dead: !groupAlive(st.pid as number) };
  };
  const afterPid = (onPid: (a: { id: number }) => Promise<void>) =>
    wrap('setStepFields', async (orig, ...args) => {
      const r = await (orig as (...x: unknown[]) => Promise<unknown>)(...args);
      if ((args[2] as { pid?: number | null }).pid) await onPid({ id: args[1] as number });
      return r;
    });

  it('kills the group when the step is cancelled right after the pid is recorded', async () => {
    const a = await h.mk({ mode: 'hang' });
    const repos = afterPid(async ({ id }) => void (await transitionStep(s.repos.runner, a.ctx, { stepId: id, from: 'running', to: 'cancelled' })));
    const { out, st, dead } = await probe(a, repos);
    expect([out.step.status, dead]).toEqual(['cancelled', true]);
    expect(st.pid).toBeTruthy();
  });

  it('kills the group when the job abort fires right after the pid is recorded', async () => {
    const a = await h.mk({ mode: 'hang', node: { timeoutS: 1 } });
    const { out, dead } = await probe(a, afterPid(async () => a.ac.abort()));
    expect([out.step.status, dead]).toEqual(['timeout', true]);
  });

  it('kills the group when following fails with an error that is not a conflict', async () => {
    const a = await h.mk({ mode: 'hang' });
    let seenStream = false;
    const repos = wrap('getStep', async (orig, ...args) => {
      const row = await (orig as (...x: unknown[]) => Promise<{ stage: string | null } | null>)(...args);
      if (row?.stage === 'stream' && !seenStream) {
        seenStream = true;
        throw new Error('db down');
      }
      return row;
    });
    const { out, dead } = await probe(a, repos);
    expect([seenStream, out.step.status, dead]).toEqual([true, 'failed', true]);
  });
});
