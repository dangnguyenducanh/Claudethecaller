/**
 * Harness for the engine gate tests and the runner eval (D25, D26): a scratch schema `ctc_t63_<random>`, throwaway git repos under the system temp
 * directory (`ctc-t63-*`), the fake agent of `.claude/metric/eval/runner/fake-agent.mjs` registered as `claude`, an in-memory queue that runs
 * `workflowHandlers` for every submitted job (3 at a time), and `runSample`, which drives one sample workflow and measures it.
 * Called from: *.int.test.ts in this directory and `.claude/metric/eval/runner/run.mjs`. Why: one harness, so the eval and the gate test cannot
 * disagree. Deliberately NOT done: the real `claude` or `codex`, the main clone, any port other than the scratch Postgres 127.0.0.1:18304.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { approveStep, parseWorkflow, runnerExecLimits, type Workflow } from '@ctc/core/runner';
import { parsePayload } from '@ctc/shared/queues';
import { createDb, createRepositories, type Ctx, type Repositories } from '@ctc/shared/repositories';
import { migrate } from '@ctc/shared/repositories/admin';
import { loadWorkflow } from './common.ts';
import { advanceRun, engineLimits, workflowHandlers, type EngineDeps } from './index.ts';
import type { Step } from './types.ts';

export const rnd = (): string => randomBytes(4).toString('hex');
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const FAKE = path.resolve(import.meta.dirname, '../../../../.claude/metric/eval/runner/fake-agent.mjs');
export const SAMPLES_DIR = path.resolve(import.meta.dirname, '../../../../.claude/metric/eval/runner');

export type Scratch = { repos: Repositories; schema: string; drop(): Promise<void> };

/** Migrates a fresh schema; refuses any URL that is not the scratch Postgres 127.0.0.1:18304. */
export async function scratch(): Promise<Scratch> {
  const url = process.env['CTC_SCRATCH_PG_URL'] ?? '';
  const u = new URL(url);
  if (u.hostname !== '127.0.0.1' || u.port !== '18304') throw new Error(`refusing ${u.hostname}:${u.port}, only the scratch Postgres 127.0.0.1:18304`);
  const schema = `ctc_t63_${rnd()}`;
  await migrate({ url, schema });
  const db = createDb({ url, schema });
  return { repos: createRepositories(db), schema, async drop() { try { await db.kysely.schema.dropSchema(schema).ifExists().cascade().execute(); } finally { await db.close(); } } };
}

const FAST = { tailPollMs: 50, statusPollMs: 100, killGraceMs: 300, reportExitGraceMs: 500, quotaExitGraceMs: 300, exitRecordGraceMs: 100 };
const keep = { exec: { ...runnerExecLimits }, engine: { ...engineLimits } };
/** Short polls so a test does not wait seconds; `restoreLimits` undoes it. */
export function useFastLimits(): void {
  Object.assign(runnerExecLimits, FAST);
  Object.assign(engineLimits, { tickMs: 100, watchMs: 100 });
}
export function restoreLimits(): void {
  Object.assign(runnerExecLimits, keep.exec);
  Object.assign(engineLimits, keep.engine);
}

export async function until<T>(fn: () => Promise<T | null | false | undefined>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`condition not met within ${ms} ms`);
    await sleep(50);
  }
}

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
export const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });

type Job = { queue: string; kind: string; payload: { timeoutS?: number }; id: string };
export type Harness = ReturnType<typeof harness>;

/** `deps.submit` validates every payload like the real queue and parks the job; `pump` runs parked runner jobs, at most 3 at a time. */
export function harness(s: Scratch, runnerConfig: Record<string, unknown> = {}) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t63-')));
  const out = path.join(tmp, 'out');
  const runs = path.join(tmp, 'runs');
  fs.mkdirSync(out);
  fs.mkdirSync(runs);
  process.env['FAKE_OUT'] = out;
  const workflows = new Map<number, Workflow>();
  const queue: Job[] = [];
  const submits: Job[] = [];
  const active = new Set<Promise<void>>();
  const errors: unknown[] = [];
  const config = {
    runner: {
      max_failures: 3, max_visits: 3, worktree: { add_timeout_s: 30, dir: '.ctc/wt', keep_days: 7 }, setup: { timeout_s: 10, max_output_mb: 1, policy: 'run' as const },
      fanout: { max_depth: 1, max_parallel: 3 }, agents: { claude: { argv: [process.execPath, FAKE] }, codex: { argv: [process.execPath, FAKE, 'exec', '--json'] } },
      ...runnerConfig,
    },
  } as EngineDeps['config'];
  const base: EngineDeps = {
    repos: s.repos, config, runsDir: runs, reportBase: 'http://127.0.0.1:18410',
    submit: async (i) => {
      parsePayload(i.queue, i.kind, i.payload);
      const job = i as Job;
      submits.push(job);
      queue.push(job);
      return { id: i.id ?? `j-${rnd()}` };
    },
  };
  // runs made by mkRun use the parsed workflow; runs started through the routes use the pinned library version like the real loader
  const deps: EngineDeps = { ...base, loadWorkflow: async (c, run) => workflows.get(run.id) ?? loadWorkflow(base, c, run) };
  const handlers = workflowHandlers(deps);
  const pump = (): void => {
    while (queue.length > 0 && active.size < 3) {
      const job = queue.shift() as Job;
      if (job.queue !== 'runner') continue;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), (job.payload.timeoutS ?? 60) * 1000);
      const p: Promise<void> = (handlers['runner.step'] as unknown as (p: unknown, c: unknown) => Promise<unknown>)(job.payload, {
        jobId: job.id, attempt: 1, signal: ac.signal, setProgress: async () => undefined,
      }).then(() => undefined, (e: unknown) => void errors.push(e)).finally(() => {
        clearTimeout(timer);
        active.delete(p);
      });
      active.add(p);
    }
  };
  const ctx: Ctx = { userId: `u-${rnd()}` };
  const mkRepo = (): string => {
    const dir = path.join(tmp, `repo-${rnd()}`, 'r');
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    return dir;
  };
  /** A running run of `source` (YAML/JSON text or object) in a fresh repo. */
  async function mkRun(source: unknown, o: { inputs?: unknown; repo?: string } = {}) {
    const parsed = parseWorkflow(source);
    if (!parsed.ok) throw new Error(`workflow invalid: ${parsed.errors.join('; ')}`);
    const repo = o.repo ?? mkRepo();
    const run = await s.repos.runner.createRun(ctx, { owner: `o-${rnd()}`, trigger: 'api', status: 'running', inputs: o.inputs ?? {}, repo, baseBranch: 'main', state: {} });
    workflows.set(run.id, parsed.workflow);
    return { run, repo, workflow: parsed.workflow };
  }
  const stepsOf = (runId: number): Promise<Step[]> => s.repos.runner.listSteps(ctx, runId);
  const FINAL = ['done', 'failed', 'cancelled'];
  /** Advances and pumps until `stop` says so, or the run is final and nothing is running. `onPoll` sees every poll (gates answered there). */
  async function drive(runId: number, o: { ms?: number; stop?: (run: { status: string }, steps: Step[]) => boolean | Promise<boolean>; onPoll?: (steps: Step[]) => Promise<void> } = {}) {
    const end = Date.now() + (o.ms ?? 60_000);
    for (;;) {
      await advanceRun(deps, ctx, runId);
      pump();
      const run = await s.repos.runner.getRun(ctx, runId);
      const steps = await stepsOf(runId);
      await o.onPoll?.(steps);
      if (run === null) throw new Error('run vanished');
      if (o.stop !== undefined && (await o.stop(run, steps))) return run;
      if (FINAL.includes(run.status) && active.size === 0 && queue.length === 0) return run;
      if (Date.now() > end) throw new Error(`drive timed out: run ${run.status}; steps ${steps.map((x) => `${x.nodeId}#${x.visit}.${x.attempt}:${x.status}`).join(' ')}; errors ${errors.map(String).join(',')}`);
      await sleep(60);
    }
  }
  /** Start and end times (ms) of every fake-agent process, by step id. */
  const snapshots = (): { stepId: number; start: number; end?: number; cwd: string; stdin: string; argv: string[] }[] =>
    fs.readdirSync(out).filter((f) => f.startsWith('agent-') && f.endsWith('.json')).map((f) => ({ stepId: Number(f.split('-')[1]), ...(JSON.parse(fs.readFileSync(path.join(out, f), 'utf8')) as { start: number; cwd: string; stdin: string; argv: string[] }) }));
  const branches = (repo: string): string[] => git(repo, 'branch', '--list', 'ctc/*', '--format=%(refname:short)').split('\n').filter(Boolean);
  async function close(): Promise<void> {
    const rows = await s.repos.system.runner.listRunningSteps((await import('@ctc/shared/repositories')).createSystemCtx('harness close')).catch(() => []);
    for (const row of rows) {
      try { if (row.pid !== null && fs.readFileSync(`/proc/${row.pid}/cmdline`, 'utf8').includes(tmp)) process.kill(-row.pid, 'SIGKILL'); } catch { /* gone */ }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { tmp, runs, out, deps, config, ctx, queue, submits, active, errors, workflows, mkRepo, mkRun, stepsOf, drive, pump, snapshots, branches, close };
}

export type SampleMetrics = {
  workflow: string; status: string; steps: number; attempts: number; agent_steps: number; prompt_outcome: string | null; children: number;
  gate_wait_ms: number; wall_ms: number; cost_usd: number; worktrees: number; visits: Record<string, number>; files: string;
};

/** Drives one sample workflow file to its end, answering every gate with its first option (never `reject`), and measures it (D26). */
export async function runSample(h: Harness, s: Scratch, file: string, inputs: Record<string, unknown> = {}): Promise<SampleMetrics & { reviewPrompt: string }> {
  const text = fs.readFileSync(path.join(SAMPLES_DIR, file), 'utf8');
  const { run, workflow } = await h.mkRun(text, { inputs });
  const t0 = Date.now();
  const waitingSince = new Map<number, number>();
  let gateWait = 0;
  const final = await h.drive(run.id, {
    ms: 90_000,
    onPoll: async (steps) => {
      for (const st of steps) {
        if (st.status !== 'waiting' || !Array.isArray(st.options) || workflow.nodes.find((n) => n.id === st.nodeId)?.type !== 'approval') continue;
        const since = waitingSince.get(st.id) ?? Date.now();
        waitingSince.set(st.id, since);
        const first = (st.options as { id: string }[])[0]?.id ?? 'approve';
        await approveStep(s.repos.runner, h.ctx, { stepId: st.id, optionId: first });
        gateWait += Date.now() - since;
      }
    },
  });
  const wall = Date.now() - t0;
  const steps = await h.stepsOf(run.id);
  const isAgent = (nodeId: string): boolean => {
    const base = nodeId.replace(/\[\d+\]$/, '');
    const n = workflow.nodes.find((x) => x.id === base);
    return n?.type === 'agent' || (n?.type === 'fanout' && base !== nodeId);
  };
  const agentRows = steps.filter((x) => isAgent(x.nodeId));
  const visits: Record<string, number> = {};
  for (const x of steps) visits[x.nodeId] = Math.max(visits[x.nodeId] ?? 0, x.visit);
  const distinct = new Set(steps.map((x) => `${x.nodeId}#${x.visit}`)).size;
  const worktrees = new Set(steps.filter((x) => x.parentStepId !== null).map((x) => x.worktree)).size;
  const last = steps.filter((x) => x.nodeId === 'list' || x.nodeId === 'announce' || x.nodeId === 'fin').sort((a, b) => b.id - a.id)[0];
  const review = steps.find((x) => x.nodeId === 'review');
  const reviewPrompt = review === undefined ? '' : (h.snapshots().find((x) => x.stepId === review.id)?.stdin ?? '');
  return {
    workflow: workflow.name, status: final.status, steps: steps.length, attempts: steps.length - distinct, agent_steps: agentRows.length,
    prompt_outcome: agentRows[0]?.promptOutcome ?? null, children: steps.filter((x) => x.parentStepId !== null).length, gate_wait_ms: gateWait, wall_ms: wall,
    cost_usd: Number(steps.reduce((sum, x) => sum + (x.costUsd ?? 0), 0).toFixed(4)), worktrees, visits,
    files: last !== undefined && last.output !== null && typeof last.output === 'object' ? String((last.output as { stdoutTail?: unknown }).stdoutTail ?? '') : '',
    reviewPrompt,
  };
}
