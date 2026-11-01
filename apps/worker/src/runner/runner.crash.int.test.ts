import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepRunner } from './index.ts';
import { groupAlive, harness, restoreLimits, scratch, until, useFastLimits, FAST, type Harness, type Scratch } from './testing.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CHILD = `
import { pathToFileURL } from 'node:url';
const [, , root, schema, url, nodeJson, payloadJson] = process.argv;
const load = (rel) => import(pathToFileURL(root + '/' + rel).href);
const R = await load('packages/shared/src/repositories/index.ts');
const C = await load('packages/core/src/runner/index.ts');
const W = await load('apps/worker/src/runner/index.ts');
Object.assign(C.runnerExecLimits, JSON.parse(process.env.CRASH_LIMITS));
const node = JSON.parse(nodeJson);
const deps = { repos: R.createRepositories(R.createDb({ url, schema })), config: JSON.parse(process.env.CRASH_CONFIG), runsDir: process.env.CRASH_RUNS, reportBase: 'http://127.0.0.1:18410', resolveNode: async () => node };
await W.runnerHandlers(deps)['runner.step'](JSON.parse(payloadJson), { jobId: 'child', attempt: 1, signal: new AbortController().signal, setProgress: async () => {} });
process.exit(0);
`;

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

/** Runs the handler in a child Node process and SIGKILLs that process once the agent is streaming, like a worker crash. */
async function crashWorker(killAgentToo: boolean) {
  const a = await h.mk({ sleep: 7000 });
  const file = path.join(h.tmp, `child-${a.step.id}.mjs`);
  fs.writeFileSync(file, CHILD);
  const child = spawn(process.execPath, ['--import', 'tsx', file, ROOT, s.schema, s.url, JSON.stringify(a.node), JSON.stringify(a.payload)], {
    stdio: 'ignore', env: { ...process.env, CRASH_LIMITS: JSON.stringify(FAST), CRASH_CONFIG: JSON.stringify(h.config()), CRASH_RUNS: h.runs },
  });
  const streaming = await until(async () => { const st = await h.getStep(a.ctx, a.step.id); return st.pid && st.stage === 'stream' ? st : null; }, 60_000);
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
  if (killAgentToo) {
    process.kill(-(streaming.pid as number), 'SIGKILL');
    await until(async () => !groupAlive(streaming.pid as number), 5000);
  }
  expect((await h.getStep(a.ctx, a.step.id)).status).toBe('running');
  return { a, streaming };
}

describe('runner.crash', () => {
  it('reattaches to a live agent after the worker is killed mid-step', async () => {
    const { a, streaming } = await crashWorker(false);
    expect(groupAlive(streaming.pid as number)).toBe(true);
    const res = await sweepRunner(h.deps());
    expect(res.actions.find((x) => x.stepId === a.step.id)?.action).toBe('reattach');
    await res.settled;
    const done = await h.getStep(a.ctx, a.step.id);
    expect([done.status, (done.output as { summary: string }).summary]).toEqual(['done', 'final answer']);
  }, 90_000);

  it('marks the step start_unknown when the agent died with the worker', async () => {
    const { a } = await crashWorker(true);
    const res = await sweepRunner(h.deps());
    expect(res.actions.find((x) => x.stepId === a.step.id)?.action).toBe('start_unknown');
    await res.settled;
    const step = await h.getStep(a.ctx, a.step.id);
    expect([step.status, step.liveness]).toEqual(['start_unknown', 'start_unknown']);
    expect((await s.repos.runner.getRun(a.ctx, a.run.id))?.status).toBe('waiting');
  }, 90_000);

  it('fails an attempt interrupted in the worktree or setup stage', async () => {
    const run = await s.repos.runner.createRun(h.ctxA, { owner: `o-${Math.random()}`, trigger: 'api', repo: null });
    await s.repos.runner.setRunStatus(h.ctxA, run.id, { from: 'queued', to: 'running' });
    const { step } = await s.repos.runner.insertStep(h.ctxA, { runId: run.id, nodeId: 'n-setup', visit: 1, attempt: 1, status: 'running', stage: 'setup', pid: null });
    const res = await sweepRunner(h.deps());
    expect(res.actions.find((x) => x.stepId === step.id)?.action).toBe('fail_stage');
    const failed = await h.getStep(h.ctxA, step.id);
    expect([failed.status, failed.error]).toEqual(['failed', 'interrupted at stage setup']);
  }, 30_000);
});
