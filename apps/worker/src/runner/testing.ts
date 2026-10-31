/** Test helpers (not exported from index.ts): a scratch schema, throwaway git repos, a fake agent script and deps. Temp dirs start with `ctc-t62-`. */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runnerExecLimits, type AgentNode } from '@ctc/core/runner';
import { createDb, createRepositories, type Ctx, type Repositories } from '@ctc/shared/repositories';
import { migrate } from '@ctc/shared/repositories/admin';
import { runnerHandlers, type RunnerExecDeps } from './index.ts';
import type { Step } from './types.ts';

export const rnd = (): string => randomBytes(4).toString('hex');
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const FAST = { tailPollMs: 50, statusPollMs: 100, killGraceMs: 300, reportExitGraceMs: 500, quotaExitGraceMs: 300, exitRecordGraceMs: 100 };
const DEFAULT_LIMITS = { ...runnerExecLimits };
export const useFastLimits = (): void => void Object.assign(runnerExecLimits, FAST);
export const restoreLimits = (): void => void Object.assign(runnerExecLimits, DEFAULT_LIMITS);

export async function until<T>(fn: () => Promise<T | null | false | undefined>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`condition not met within ${ms} ms`);
    await sleep(50);
  }
}

export const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};
export const groupAlive = (pgid: number): boolean => {
  try { process.kill(-pgid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

export type Scratch = { repos: Repositories; schema: string; url: string; drop(): Promise<void> };

/** Migrates a fresh schema `ctc_t62_<random>`; refuses any URL that is not the scratch Postgres 127.0.0.1:18304. */
export async function scratch(): Promise<Scratch> {
  const url = process.env['CTC_SCRATCH_PG_URL'] ?? '';
  const u = new URL(url);
  if (u.hostname !== '127.0.0.1' || u.port !== '18304') throw new Error(`refusing ${u.hostname}:${u.port}, only the scratch Postgres 127.0.0.1:18304`);
  const schema = `ctc_t62_${rnd()}`;
  await migrate({ url, schema });
  const db = createDb({ url, schema });
  return { repos: createRepositories(db), schema, url, async drop() { try { await db.kysely.schema.dropSchema(schema).ifExists().cascade().execute(); } finally { await db.close(); } } };
}

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
export const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });

/** The fake agent reads its prompt from stdin; `FAKE_MODE=ok|fail|hang|quota|suicide|silent|noise`, `FAKE_SLEEP=<ms>`, `FAKE_EDIT=1` steer it. */
const FAKE_SOURCE = `
import fs from 'node:fs';
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => main(Buffer.concat(chunks).toString()));
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function main(stdin) {
  const mode = (/FAKE_MODE=(\\w+)/.exec(stdin) || [])[1] || 'ok';
  const ms = Number((/FAKE_SLEEP=(\\d+)/.exec(stdin) || [])[1] || 0);
  const f = process.env.FAKE_OUT + '/step-' + (process.env.CTC_STEP_ID || 'none') + '-' + process.pid + '.json';
  fs.writeFileSync(f + '.tmp', JSON.stringify({ env: process.env, argv: process.argv.slice(2), cwd: process.cwd(), stdin }));
  fs.renameSync(f + '.tmp', f);
  if (mode === 'silent') return;
  line({ type: 'system', subtype: 'init' });
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } });
  if (mode === 'noise') process.stdout.write('garbage\\n[1,2]\\n42\\nnull\\n{"type":"mystery"}\\n');
  if (mode === 'fail') { process.stderr.write('boom\\nbad thing\\n'); process.exit(3); }
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode === 'quota') { line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1893456000 } }); setInterval(() => {}, 1000); return; }
  if (mode === 'suicide') { process.kill(-Number(fs.readFileSync('/proc/self/stat', 'utf8').replace(/^.*\\) /, '').split(' ')[2]), 'SIGKILL'); await wait(5000); return; }
  if (ms) await wait(ms);
  if (/FAKE_EDIT=1/.test(stdin)) fs.appendFileSync('README.md', 'edited\\n');
  line({ type: 'result', subtype: 'success', is_error: false, result: 'final answer', usage: { input_tokens: 5, output_tokens: 7 }, total_cost_usd: 0.25 });
}
`;

export type Harness = ReturnType<typeof harness>;

export function harness(s: Scratch) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t62-')));
  const out = path.join(tmp, 'out');
  const runs = path.join(tmp, 'runs');
  fs.mkdirSync(out);
  fs.mkdirSync(runs);
  process.env['FAKE_OUT'] = out;
  const fake = path.join(tmp, 'fake-agent.mjs');
  fs.writeFileSync(fake, FAKE_SOURCE);
  const nodes = new Map<string, AgentNode>();
  const ended: Step[] = [];
  const pids = new Set<number>();
  const config = (over: Record<string, unknown> = {}): RunnerExecDeps['config'] => ({
    runner: {
      max_failures: 3, worktree: { add_timeout_s: 30, dir: '.ctc/wt' }, setup: { timeout_s: 10, max_output_mb: 1, policy: 'run' },
      agents: { claude: { argv: [process.execPath, fake] }, codex: { argv: [process.execPath, fake, 'exec', '--json'] } }, ...over,
    },
  } as RunnerExecDeps['config']);
  const deps = (over: Partial<RunnerExecDeps> = {}, runnerOver: Record<string, unknown> = {}): RunnerExecDeps => ({
    repos: s.repos, config: config(runnerOver), runsDir: runs, reportBase: 'http://127.0.0.1:18410',
    resolveNode: async (_c, _r, step) => nodes.get(step.nodeId) ?? null,
    onStepEnd: async (_c, step) => void ended.push(step),
    ...over,
  });
  const ctxA: Ctx = { userId: `u-a-${rnd()}` };
  const ctxB: Ctx = { userId: `u-b-${rnd()}` };
  const mkRepo = (o: { ctcYaml?: string; name?: string } = {}): string => {
    const dir = path.join(tmp, `repo-${rnd()}`, o.name ?? 'r');
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
    if (o.ctcYaml !== undefined) fs.writeFileSync(path.join(dir, 'ctc.yaml'), o.ctcYaml);
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    return dir;
  };
  type MkOptions = { ctx?: Ctx; repo?: string | null; ctcYaml?: string; mode?: string; sleep?: number; edit?: boolean; node?: Partial<AgentNode>; stepStatus?: string; failureCount?: number; runStatus?: string };
  /** A queued step with its rendered node; the prompt steers the fake agent. */
  async function mk(o: MkOptions = {}) {
    const ctx = o.ctx ?? ctxA;
    const repo = o.repo === undefined ? mkRepo(o.ctcYaml === undefined ? {} : { ctcYaml: o.ctcYaml }) : o.repo;
    const created = await s.repos.runner.createRun(ctx, { owner: `o-${rnd()}`, trigger: 'api', repo, baseBranch: 'main' });
    const run = await s.repos.runner.setRunStatus(ctx, created.id, { from: 'queued', to: o.runStatus ?? 'running' });
    const nodeId = `n${rnd()}`;
    const { step } = await s.repos.runner.insertStep(ctx, { runId: run.id, nodeId, visit: 1, attempt: 1, status: o.stepStatus ?? 'queued', failureCount: o.failureCount ?? 0 });
    const node: AgentNode = {
      agent: 'claude', worktree: 'new', permission: 'acceptEdits', model: null, timeoutS: 60, workflow: 'wf',
      prompt: `FAKE_MODE=${o.mode ?? 'ok'} FAKE_SLEEP=${o.sleep ?? 0} ${o.edit ? 'FAKE_EDIT=1' : ''} do the thing`, ...o.node,
    };
    nodes.set(nodeId, node);
    const payload = { userId: ctx.userId, runId: String(run.id), stepId: String(step.id), nodeId, visit: 1, attempt: 1, timeoutS: node.timeoutS };
    return { ctx, repo, run, step, nodeId, node, payload, ac: new AbortController() };
  }
  type Made = Awaited<ReturnType<typeof mk>>;
  const call = (a: Pick<Made, 'payload' | 'ac'>, d: RunnerExecDeps = deps()) =>
    (runnerHandlers(d)['runner.step'] as unknown as (p: unknown, c: unknown) => Promise<{ stepId: number; status: string; skipped: boolean }>)(a.payload, {
      jobId: `j-${rnd()}`, attempt: 1, signal: a.ac.signal, setProgress: async () => undefined,
    });
  const getStep = async (ctx: Ctx, id: number): Promise<Step> => {
    const row = (await s.repos.runner.getStep(ctx, id)) as Step;
    if (row.pid) pids.add(row.pid);
    return row;
  };
  const snaps = (stepId: number) =>
    fs.readdirSync(out).filter((f) => f.startsWith(`step-${stepId}-`) && f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(out, f), 'utf8')) as { env: Record<string, string>; argv: string[]; cwd: string; stdin: string });
  const killAll = (): void => {
    for (const pid of pids) {
      try { if (fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(tmp)) process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
    }
  };
  return {
    tmp, out, runs, fake, nodes, ended, pids, config, deps, ctxA, ctxB, mkRepo, mk, call, getStep, snaps, killAll,
    /** Runs the handler and re-reads the step. */
    async go(a: Made, d?: RunnerExecDeps) {
      const res = await call(a, d);
      return { res, step: await getStep(a.ctx, a.step.id) };
    },
    remove: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}
