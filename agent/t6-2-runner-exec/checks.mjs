// checks for T6.2 runner cold path (worktree recipe, setup hook, agent registry, stream, report token, restart sweep): one runnable example per
// decision id (D0..D21). Prints `PASS D# ...` or `FAIL D# expected=<..> got=<..>`; last line `CHECKS: <n> pass, <m> fail`; exit 1 on any FAIL.
// Needs: env CTC_SCRATCH_PG_URL (scratch Postgres 127.0.0.1:18304 only), git, /bin/sh, node, Linux /proc. Run from the repo root:
//   node --import tsx agent/t6-2-runner-exec/checks.mjs      (tsx lets Node import the .ts sources)
// Scratch schema `ctc_t62chk_<random>` (dropped at the end), throwaway git repos and a fake agent under os.tmpdir()/ctc-t62chk-*.
// The fake agent is a node script registered as `claude`/`codex` through config.runner.agents; the real claude/codex never start.
// Every process group a check starts is killed at the end (by pid, only when its command line names the temp dir). Fixture values are this file's own.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(new URL('../../', import.meta.url).pathname);
const CORE_DIR = 'packages/core/src/runner';
const WORKER_DIR = 'apps/worker/src/runner';
const CORE = `${CORE_DIR}/index.ts`;
const WORKER = `${WORKER_DIR}/index.ts`;
const REPOS = 'packages/shared/src/repositories/index.ts';
const ADMIN = 'packages/shared/src/repositories/admin/index.ts';
const GATE = `${WORKER_DIR}/runner.crash.int.test.ts`;
const IDS = Array.from({ length: 22 }, (_, i) => `D${i}`);
let pass = 0; let fail = 0;
const done = new Set();
const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
function ok(id, msg) { pass++; done.add(id); console.log(`PASS ${id} ${msg}`); }
function bad(id, expected, got) { fail++; done.add(id); console.log(`FAIL ${id} expected=${show(expected)} got=${show(got)}`); }
async function check(id, msg, fn) {
  let timer;
  try {
    await Promise.race([fn(), new Promise((_, rej) => (timer = setTimeout(() => rej(new Error('check timed out after 120 s')), 120_000)))]);
    ok(id, msg);
  } catch (e) {
    if (e && e.name === 'AssertionError') bad(id, e.expected, e.actual); else bad(id, msg, `${e?.name}: ${e?.message}`);
  } finally { clearTimeout(timer); }
}
let cleanup = async () => {};
async function finish() {
  try { await cleanup(); } catch (e) { console.log(`note: cleanup failed: ${e?.message}`); }
  for (const id of IDS) if (!done.has(id)) bad(id, 'a check', 'missing');
  console.log(`CHECKS: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
async function failAll(why) { for (const id of IDS) bad(id, 'modules importable and scratch Postgres ready', why); await finish(); }
process.on('unhandledRejection', () => {});
const rnd = () => randomBytes(4).toString('hex');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20_000, every = 50) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`condition not met within ${ms} ms`);
    await sleep(every);
  }
}
const sources = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory() && e.name !== 'node_modules' && e.name !== 'fixtures') walk(p); else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) && e.name !== 'testing.ts') out.push(p); } };
  if (fs.existsSync(path.join(ROOT, dir))) walk(path.join(ROOT, dir));
  return out.map((p) => [path.relative(ROOT, p), fs.readFileSync(p, 'utf8')]);
};
const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const gone = (pid) => until(async () => !groupAlive(pid), 4000);
const stat = (pid) => fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '').split(' '); // [state, ppid, pgrp, session, ...]

// ---- load -----------------------------------------------------------------------------------------------------------
const url = process.env.CTC_SCRATCH_PG_URL;
if (!url) await failAll('env CTC_SCRATCH_PG_URL not set');
const pu = new URL(url);
if (pu.hostname !== '127.0.0.1' || pu.port !== '18304') await failAll(`refusing ${pu.hostname}:${pu.port}, only the scratch Postgres 127.0.0.1:18304`);
if (!fs.existsSync('/proc/self/stat')) await failAll('Linux /proc not available');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
for (const rel of [CORE, WORKER]) if (!fs.existsSync(path.join(ROOT, rel))) await failAll(`module not built: ${rel} is missing`);
let C; let W; let R; let A;
try {
  C = await load(CORE); W = await load(WORKER); R = await load(REPOS); A = await load(ADMIN);
} catch (e) { await failAll(`module not importable: ${e?.code ?? e?.name}: ${String(e?.message).split('\n')[0]}`); }
const schema = `ctc_t62chk_${rnd()}`;
let db; let repos;
try {
  await A.migrate({ url, schema });
  db = R.createDb({ url, schema });
  repos = R.createRepositories(db);
} catch (e) { await failAll(`scratch schema not built: ${e?.name}: ${e?.message}`); }

// ---- fixtures: temp dir, fake agent, git repos, deps ------------------------------------------------------------------
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t62chk-')));
const OUT = path.join(TMP, 'out'); const RUNS = path.join(TMP, 'runs');
fs.mkdirSync(OUT); fs.mkdirSync(RUNS);
process.env.CHK_OUT = OUT;
const FAKE = path.join(TMP, 'fake-agent.mjs');
fs.writeFileSync(FAKE, `
import fs from 'node:fs';
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => main(Buffer.concat(chunks).toString()));
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function main(stdin) {
  const mode = (/CHK_MODE=(\\w+)/.exec(stdin) || [])[1] || 'ok';
  const ms = Number((/CHK_SLEEP=(\\d+)/.exec(stdin) || [])[1] || 0);
  const snap = { env: process.env, argv: process.argv.slice(2), cwd: process.cwd(), stdin, pid: process.pid };
  const f = process.env.CHK_OUT + '/step-' + (process.env.CTC_STEP_ID || 'none') + '-' + process.pid + '.json';
  fs.writeFileSync(f + '.tmp', JSON.stringify(snap)); fs.renameSync(f + '.tmp', f);
  if (mode === 'silent') return;
  line({ type: 'system', subtype: 'init' });
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } });
  if (mode === 'noise') { process.stdout.write('garbage\\n[1,2]\\n"s"\\n42\\nnull\\n{"type":"mystery"}\\n'); }
  if (mode === 'fail') { process.stderr.write('boom\\nbad thing\\n'); process.exit(3); }
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode === 'quota') { line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1893456000 } }); setInterval(() => {}, 1000); return; }
  if (mode === 'suicide') { process.kill(-Number(fs.readFileSync('/proc/self/stat', 'utf8').replace(/^.*\\) /, '').split(' ')[2]), 'SIGKILL'); await wait(5000); return; }
  if (ms) await wait(ms);
  if (/CHK_EDIT=1/.test(stdin)) fs.appendFileSync('README.md', 'edited\\n');
  line({ type: 'result', subtype: 'success', is_error: false, result: 'final answer', usage: { input_tokens: 5, output_tokens: 7 }, total_cost_usd: 0.25 });
}
`);
const GITENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
for (const k of Object.keys(GITENV)) if (k.startsWith('GIT_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_TERMINAL_PROMPT'].includes(k)) delete GITENV[k];
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GITENV, stdio: ['ignore', 'pipe', 'pipe'] });
function mkRepo({ ctcYaml, name } = {}) {
  const dir = path.join(TMP, `repo-${rnd()}`, name ?? 'r');
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  if (ctcYaml !== undefined) fs.writeFileSync(path.join(dir, 'ctc.yaml'), ctcYaml);
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  return dir;
}
const CFG = (over = {}) => ({
  runner: {
    max_failures: 3, worktree: { add_timeout_s: 30, dir: '.ctc/wt' }, setup: { timeout_s: 10, max_output_mb: 1, policy: 'run' },
    agents: { claude: { argv: [process.execPath, FAKE] }, codex: { argv: [process.execPath, FAKE, 'exec', '--json'] } },
    ...over,
  },
});
const NODES = new Map(); const ENDED = []; const LOGS = [];
const mkDeps = (over = {}, runnerOver = {}) => ({
  repos, config: CFG(runnerOver), runsDir: RUNS, reportBase: 'http://127.0.0.1:18410',
  resolveNode: async (_ctx, _run, step) => NODES.get(step.nodeId) ?? null,
  onStepEnd: async (_ctx, step) => { ENDED.push(step); },
  log: (m, f) => { LOGS.push([m, f]); },
  ...over,
});
const FAST_LIMITS = { tailPollMs: 50, statusPollMs: 100, killGraceMs: 300, reportExitGraceMs: 500, quotaExitGraceMs: 300, exitRecordGraceMs: 100 };
const LIMITS0 = JSON.parse(JSON.stringify(C.runnerExecLimits ?? {}));
Object.assign(C.runnerExecLimits ?? {}, FAST_LIMITS);

const ctxA = { userId: `u-a-${rnd()}` }; const ctxB = { userId: `u-b-${rnd()}` };
const PIDS = new Set(); const MANUAL = [];
const keep = (step) => { if (step?.pid) PIDS.add(step.pid); return step; };
const getStep = async (ctx, id) => keep(await repos.runner.getStep(ctx, id));
const getRun = (ctx, id) => repos.runner.getRun(ctx, id);
async function mkRun(ctx, { status = 'running', repo = null, baseBranch = 'main' } = {}) {
  const run = await repos.runner.createRun(ctx, { owner: `o-${rnd()}`, trigger: 'api', repo, baseBranch });
  return status === 'queued' ? run : repos.runner.setRunStatus(ctx, run.id, { from: 'queued', to: status });
}
/** A queued step with its rendered node; `o.mode`/`o.sleep`/`o.edit` steer the fake agent through the prompt. */
async function mk(o = {}) {
  const ctx = o.ctx ?? ctxA;
  const repo = o.repo === undefined ? mkRepo({ ctcYaml: o.ctcYaml }) : o.repo;
  const run = await mkRun(ctx, { status: o.runStatus ?? 'running', repo, baseBranch: o.baseBranch === undefined ? 'main' : o.baseBranch });
  const nodeId = `n${rnd()}`;
  const { step } = await repos.runner.insertStep(ctx, { runId: run.id, nodeId, visit: 1, attempt: o.attempt ?? 1, status: o.stepStatus ?? 'queued', failureCount: o.failureCount ?? 0 });
  const node = {
    agent: 'claude', worktree: 'new', permission: 'acceptEdits', model: null, timeoutS: 60, workflow: 'wf', ...o.node,
    prompt: o.node?.prompt ?? `CHK_MODE=${o.mode ?? 'ok'} CHK_SLEEP=${o.sleep ?? 0} ${o.edit ? 'CHK_EDIT=1' : ''} do the thing`,
  };
  NODES.set(nodeId, node);
  const payload = { userId: ctx.userId, runId: String(run.id), stepId: String(step.id), nodeId, visit: 1, attempt: o.attempt ?? 1, timeoutS: node.timeoutS };
  return { ctx, repo, run, step, nodeId, node, payload, ac: new AbortController() };
}
const call = (a, deps) => W.runnerHandlers(deps ?? mkDeps())['runner.step'](a.payload, { jobId: `j-${rnd()}`, attempt: 1, signal: a.ac.signal, setProgress: async () => {} });
async function go(a, deps) { const res = await call(a, deps); a.step = await getStep(a.ctx, a.step.id); return res; }
const attemptDir = (a) => path.join(RUNS, String(a.run.id));
const snaps = (a) => fs.readdirSync(OUT).filter((f) => f.startsWith(`step-${a.step.id}-`) && f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')));
const snapOf = (a) => { const s = snaps(a); assert.equal(s.length, 1, `agent snapshots of step ${a.step.id}`); return s[0]; };
const branchOf = (a, extra = '') => `ctc/wf-${a.run.id}-${a.nodeId}${extra}`;
const killPid = (pid) => { try { const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); if (cmd.includes(TMP)) process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } };
cleanup = async () => {
  for (const pid of PIDS) killPid(pid);
  for (const c of MANUAL) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } }
  try { await db.kysely.schema.dropSchema(schema).ifExists().cascade().execute(); } finally { await db.close(); }
  fs.rmSync(TMP, { recursive: true, force: true });
};
const spawnSleeper = () => { const c = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' }); c.unref(); MANUAL.push(c); return c; };
/** A running step as a crashed worker would leave it. */
async function fab(ctx, { stage = 'stream', pid = null, pidStartedAt = null, exit = null, log = null, runStatus = 'running', node = {}, startedAt = null } = {}) {
  const run = await mkRun(ctx, { status: runStatus, repo: null });
  const nodeId = `n${rnd()}`;
  NODES.set(nodeId, { agent: 'claude', worktree: 'none', permission: 'acceptEdits', model: null, timeoutS: 3600, workflow: 'wf', prompt: 'p', ...node });
  const dir = path.join(RUNS, String(run.id));
  fs.mkdirSync(dir, { recursive: true });
  const { step } = await repos.runner.insertStep(ctx, { runId: run.id, nodeId, visit: 1, attempt: 1, status: 'running', stage, pid, pidStartedAt, ...(startedAt ? { startedAt } : {}), logPath: path.join(dir, `PLACEHOLDER.jsonl`) });
  const logPath = path.join(dir, `${step.id}.jsonl`);
  fs.writeFileSync(logPath, log ?? '');
  await repos.runner.setStepFields(ctx, step.id, { logPath });
  if (exit !== null) fs.writeFileSync(path.join(dir, `${step.id}.exit`), String(exit));
  return { ctx, run, step: await getStep(ctx, step.id), nodeId };
}
const actionOf = (res, f) => res.actions.find((x) => x.stepId === f.step.id)?.action;
const retire = async (f) => { try { await C.transitionStep(repos.runner, f.ctx, { stepId: f.step.id, from: 'running', to: 'cancelled' }); } catch { /* already moved */ } };
const dropped = async (p, code) => assert.rejects(p, (e) => { assert.equal(e?.code, code); return true; });
const JSONL = (...o) => o.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') + '\n';
const EMPTY = { events: 0, lastMessage: null, usage: null, costUsd: null, quota: null, error: null };

// ---- D0 purpose and callers ---------------------------------------------------------------------------------------------
await check('D0', 'runnerHandlers returns exactly {runner.step}; sweepRunner exists; an ok attempt resolves a JSON-safe result and calls onStepEnd once', async () => {
  const h = W.runnerHandlers(mkDeps());
  assert.deepEqual(Object.keys(h), ['runner.step']);
  assert.equal(typeof h['runner.step'], 'function');
  assert.equal(typeof W.sweepRunner, 'function');
  ENDED.length = 0;
  const a = await mk();
  const res = await go(a);
  assert.deepEqual(JSON.parse(JSON.stringify(res)), res);
  assert.equal(ENDED.filter((s) => s.id === a.step.id).length, 1);
});

// ---- D1 trust -------------------------------------------------------------------------------------------------------------
await check('D1', "other user's ctx cannot see the step (JobDropped step_not_found); agent env has no worker CTC_ vars; token stored only as sha256; no shell for untrusted text", async () => {
  const a = await mk();
  await dropped(call({ ...a, payload: { ...a.payload, userId: ctxB.userId } }), 'step_not_found');
  assert.equal((await getStep(a.ctx, a.step.id)).status, 'queued');
  process.env.CTC_SECRET_CANARY = 'canary-value';
  const evil = path.join(TMP, 'pwned');
  const b = await mk({ repo: mkRepo({ name: "re po'x $HOME" }), node: { prompt: `CHK_MODE=ok $(touch ${evil}) \`touch ${evil}\`; touch ${evil}` } });
  const res = await go(b);
  assert.equal(res.status, 'done');
  assert.equal(fs.existsSync(evil), false);
  const env = snapOf(b).env;
  assert.equal(env.CTC_SECRET_CANARY, undefined);
  const allowed = ['CTC_STEP_TOKEN', 'CTC_REPORT_URL', 'CTC_RUN_ID', 'CTC_STEP_ID', 'CTC_ROOT_PATH', 'CTC_WORKTREE_PATH'];
  assert.deepEqual(Object.keys(env).filter((k) => k.startsWith('CTC_')).filter((k) => !allowed.includes(k)), []);
  assert.equal(env.CHK_OUT, OUT);
  assert.ok(env.PATH);
  assert.match(env.CTC_STEP_TOKEN, /^[0-9a-f]{64}$/);
  assert.equal(b.step.tokenHash, sha(env.CTC_STEP_TOKEN));
  assert.equal(JSON.stringify(b.step).includes(env.CTC_STEP_TOKEN), false);
  assert.ok(snapOf(b).stdin.includes(`touch ${evil}`));
});

// ---- D2 limits ------------------------------------------------------------------------------------------------------------
await check('D2', 'runnerExecLimits defaults; output cap is inclusive; pid start tolerance is inclusive; summary and error cuts', async () => {
  assert.deepEqual(LIMITS0, {
    killGraceMs: 5000, tailPollMs: 250, statusPollMs: 2000, reportExitGraceMs: 30000, quotaExitGraceMs: 10000, exitRecordGraceMs: 500,
    pidStartToleranceMs: 1000, summaryMax: 20000, errorMax: 2000, gitTimeoutMs: 30000, defaultTimeoutS: 1800,
  });
  const cap = 1024 * 1024;
  const f1 = path.join(TMP, `cap-${rnd()}.out`); const f2 = path.join(TMP, `cap-${rnd()}.out`);
  const r1 = await W.runGroup({ cmd: ['/bin/sh', '-c', `head -c ${cap} /dev/zero`], cwd: TMP, env: {}, timeoutMs: 20000, maxOutputBytes: cap, outFile: f1 });
  assert.deepEqual([r1.code, r1.overflow, r1.timedOut, fs.statSync(f1).size], [0, false, false, cap]);
  const r2 = await W.runGroup({ cmd: ['/bin/sh', '-c', `head -c ${cap + 1} /dev/zero`], cwd: TMP, env: {}, timeoutMs: 20000, maxOutputBytes: cap, outFile: f2 });
  assert.equal(r2.overflow, true);
  assert.ok(fs.statSync(f2).size <= cap);
  const t = new Date('2026-01-01T00:00:00Z');
  const s = { stage: 'stream', pid: 5, pidStartedAt: t };
  const at = (ms) => C.sweepAction(s, { exitCode: null, startedAt: new Date(t.getTime() + ms) });
  assert.deepEqual([at(1000), at(-1000), at(1001), at(-1001)], ['reattach', 'reattach', 'start_unknown', 'start_unknown']);
  const long = 'x'.repeat(25000);
  assert.equal(C.readStreamLine('claude', C.emptyStream(), JSON.stringify({ type: 'result', result: long })).lastMessage.length, 20000);
  assert.equal(C.readStreamLine('claude', C.emptyStream(), JSON.stringify({ type: 'result', result: 'x'.repeat(20000) })).lastMessage.length, 20000);
  const o = C.exitOutcome({ exitCode: 2, stream: EMPTY, stderrTail: 'e'.repeat(3000) });
  assert.equal(o.error.length, 2000);
});

// ---- D3 output and error format ----------------------------------------------------------------------------------------------
await check('D3', 'result {stepId,status,skipped}; exact error texts for node not found, spawn refused, setup failed; output shapes', async () => {
  const a = await mk();
  const res = await go(a);
  assert.deepEqual(res, { stepId: a.step.id, status: 'done', skipped: false });
  assert.deepEqual(Object.keys(a.step.output).sort(), ['diffStat', 'outcome', 'summary']);
  assert.deepEqual([a.step.output.outcome, a.step.output.summary, typeof a.step.output.diffStat], ['done', 'final answer', 'string']);
  const n = await mk({ node: { worktree: 'none' } });
  await go(n);
  assert.deepEqual(n.step.output, { outcome: 'done', summary: 'final answer' });
  const missing = await mk();
  NODES.delete(missing.nodeId);
  assert.deepEqual(await go(missing), { stepId: missing.step.id, status: 'failed', skipped: false });
  assert.equal(missing.step.error, 'node not found');
  const throws = await mk();
  const r = await go(throws, mkDeps({ resolveNode: async () => { throw new Error('boom'); } }));
  assert.deepEqual([r.status, throws.step.error], ['failed', 'node not found']);
  const bs = await mk({ node: { agent: 'nope' } });
  await go(bs);
  assert.deepEqual([bs.step.status, bs.step.error], ['failed', 'spawn refused: unknown agent nope']);
  const sf = await mk({ ctcYaml: 'setup: "exit 7"\n' });
  await go(sf);
  assert.deepEqual([sf.step.status, sf.step.error, sf.step.stage], ['failed', 'setup failed: exit 7', 'setup']);
});

// ---- D4 bad input -----------------------------------------------------------------------------------------------------------
await check('D4', 'unknown step and payload mismatch are dropped untouched; a repeat or lost claim race spawns once; unsafe run/node fail the attempt', async () => {
  const a = await mk();
  await dropped(call({ ...a, payload: { ...a.payload, stepId: '999999999' } }), 'step_not_found');
  const before = await getStep(a.ctx, a.step.id);
  await dropped(call({ ...a, payload: { ...a.payload, nodeId: 'other' } }), 'payload_mismatch');
  await dropped(call({ ...a, payload: { ...a.payload, attempt: 2 } }), 'payload_mismatch');
  assert.deepEqual(await getStep(a.ctx, a.step.id), before);
  const [r1, r2] = await Promise.all([call(a), call(a)]);
  assert.deepEqual([r1.skipped, r2.skipped].sort(), [false, true]);
  assert.equal(snaps(a).length, 1);
  assert.equal((await call(a)).skipped, true);
  assert.equal(snaps(a).length, 1);
  const running = await mk({ stepStatus: 'running' });
  assert.equal((await call(running)).skipped, true);
  assert.equal(snaps(running).length, 0);
  const notGit = await mk({ repo: fs.mkdtempSync(path.join(TMP, 'plain-')) });
  await go(notGit);
  assert.deepEqual([notGit.step.status, notGit.step.error], ['failed', 'worktree failed: not a git repository']);
  const noParent = await mk({ node: { worktree: 'parent' } });
  await go(noParent);
  assert.equal(noParent.step.status, 'failed');
  const badYaml = await mk({ ctcYaml: 'setup: 5\n' });
  await go(badYaml);
  assert.deepEqual([badYaml.step.status, badYaml.step.error, badYaml.step.worktree, badYaml.step.branch], ['failed', 'setup config invalid', null, null]);
  assert.equal(git(badYaml.repo, 'branch', '--list', 'ctc/*').trim(), '');
  const badPerm = await mk({ node: { permission: 'bypassPermissions' } });
  await go(badPerm);
  assert.equal(badPerm.step.error, 'spawn refused: permission bypassPermissions not allowed');
  const badModel = await mk({ node: { model: '--evil' } });
  await go(badModel);
  assert.equal(badModel.step.error, 'spawn refused: model not allowed');
  assert.equal(snaps(badModel).length, 0);
});

// ---- D5 odd but harmless input ------------------------------------------------------------------------------------------------
await check('D5', 'no ctc.yaml / empty setup / worktree none or parent / noisy stream / silent agent / no model all stay valid', async () => {
  const none = await mk({ ctcYaml: 'setup: []\n' });
  assert.equal((await go(none)).status, 'done');
  assert.equal(fs.existsSync(path.join(attemptDir(none), `${none.step.id}.setup.log`)), false);
  const blank = await mk({ ctcYaml: 'name: x\nsetup:\n  - ""\n  - "  "\n' });
  assert.equal((await go(blank)).status, 'done');
  assert.equal(fs.existsSync(path.join(attemptDir(blank), `${blank.step.id}.setup.log`)), false);
  const wn = await mk({ node: { worktree: 'none' } });
  await go(wn);
  assert.deepEqual([wn.step.status, wn.step.worktree, wn.step.branch, fs.realpathSync(snapOf(wn).cwd)], ['done', null, null, fs.realpathSync(wn.repo)]);
  const parentDir = fs.mkdtempSync(path.join(TMP, 'parent-'));
  const wp = await mk({ node: { worktree: 'parent', parentWorktree: parentDir } });
  await go(wp);
  assert.deepEqual([wp.step.status, wp.step.worktree, wp.step.branch, fs.realpathSync(snapOf(wp).cwd)], ['done', parentDir, null, fs.realpathSync(parentDir)]);
  assert.equal(git(wp.repo, 'branch', '--list', 'ctc/*').trim(), '');
  const noisy = await mk({ mode: 'noise' });
  await go(noisy);
  assert.deepEqual([noisy.step.status, noisy.step.output.summary], ['done', 'final answer']);
  const silent = await mk({ mode: 'silent' });
  await go(silent);
  assert.deepEqual([silent.step.status, silent.step.output.summary, silent.step.promptOutcome], ['done', null, 'not_delivered']);
  const st = C.readStreamLine('claude', C.emptyStream(), '');
  assert.deepEqual(st, EMPTY);
  for (const l of ['not json', '[1,2]', '"s"', '42', 'null', '{"type":"mystery"}{']) assert.doesNotThrow(() => C.readStreamLine('claude', C.emptyStream(), l));
});

// ---- D6 must never ----------------------------------------------------------------------------------------------------------------
await check('D6', 'source rules (no status write outside the core, no forced git, no bypass flag, pure core); no token outside the agent env; a quiet agent is not killed; frozen inputs are not edited', async () => {
  const worker = sources(WORKER_DIR);
  const core = sources(CORE_DIR);
  assert.ok(worker.length > 0 && core.length > 0, 'sources exist');
  for (const [f, s] of worker) {
    assert.equal(/\.transition\(/.test(s), false, `${f} calls repos.runner.transition`);
    for (const m of s.matchAll(/setStepFields\(/g)) {
      const call = s.slice(m.index, m.index + 160).split(';')[0];
      assert.equal(/\bstatus\s*:/.test(call), false, `${f}: setStepFields with status: ${call}`);
    }
    assert.equal(/homedir|['"`][^'"`]*\.claude['"`]|fetch\(|node:https?|node:net|ioredis|bullmq/.test(s), false, `${f} touches ~/.claude, network or Redis`);
    assert.equal(/['"`](--force|--force-with-lease|-f|-B|-D|reset|clean|push|checkout|remove)['"`]/.test(s), false, `${f} has a forbidden git word`);
    assert.equal(/--dangerously-skip-permissions|--allow-dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox/.test(s), false, `${f} names a bypass flag`);
  }
  assert.ok(worker.filter(([, s]) => /setRunStatus\(/.test(s)).length <= 1, 'setRunStatus( in at most one worker file');
  for (const [f, s] of core) {
    assert.equal(/from\s+['"]node:|require\(/.test(s), false, `${f} imports node:*`);
    assert.equal(/^import\s+(?!type\b)[^;]*from\s+['"]@ctc\/shared/m.test(s), false, `${f} has a runtime @ctc/shared import`);
  }
  const a = await mk();
  const logs0 = LOGS.length;
  await go(a);
  const env = snapOf(a).env;
  const token = env.CTC_STEP_TOKEN;
  const hay = [
    fs.readFileSync(path.join(attemptDir(a), `${a.step.id}.prompt`), 'utf8'), fs.readFileSync(path.join(attemptDir(a), `${a.step.id}.jsonl`), 'utf8'),
    fs.readFileSync(path.join(attemptDir(a), `${a.step.id}.err`), 'utf8'), JSON.stringify(a.step), JSON.stringify(snapOf(a).argv), JSON.stringify(LOGS.slice(logs0)),
    JSON.stringify(await repos.runner.getRun(a.ctx, a.run.id)),
  ].join('\n');
  assert.equal(hay.includes(token), false);
  assert.equal(/bypassPermissions|dangerously/.test(JSON.stringify(snapOf(a).argv)), false);
  const q = await mk({ mode: 'ok', sleep: 1500 });
  const t0 = Date.now();
  const rq = await go(q);
  assert.deepEqual([rq.status, q.step.output.summary], ['done', 'final answer']);
  assert.ok(Date.now() - t0 >= 1400);
  const cfg = deepFreeze(CFG()); const node = deepFreeze({ agent: 'claude', worktree: 'new', permission: 'plan', model: 'm1', timeoutS: 60, workflow: 'wf', prompt: 'CHK_MODE=ok x' });
  const fz = await mk();
  NODES.set(fz.nodeId, node);
  const payload = deepFreeze({ ...fz.payload });
  const res = await W.runnerHandlers(mkDeps({ config: cfg }))['runner.step'](payload, { jobId: 'j', attempt: 1, signal: fz.ac.signal, setProgress: async () => {} });
  assert.equal(res.status, 'done');
  const pid = (await getStep(fz.ctx, fz.step.id)).pid;
  await gone(pid);
});

// ---- D7 non-goals -----------------------------------------------------------------------------------------------------------------
await check('D7', 'a done attempt leaves the run status, the step list, the worktree and the branch alone; codex cost stays null', async () => {
  const a = await mk();
  await go(a);
  assert.equal(a.step.status, 'done');
  assert.equal((await getRun(a.ctx, a.run.id)).status, 'running');
  assert.equal((await repos.runner.listSteps(a.ctx, a.run.id)).length, 1);
  assert.ok(fs.existsSync(a.step.worktree));
  assert.ok(git(a.repo, 'rev-parse', '--verify', `refs/heads/${a.step.branch}`).trim());
  const s = C.readStreamLine('codex', C.emptyStream(), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, cached_input_tokens: 1, output_tokens: 2 } }));
  assert.deepEqual([s.usage, s.costUsd], [{ input_tokens: 3, cached_input_tokens: 1, output_tokens: 2 }, null]);
});

// ---- D8 silence rule --------------------------------------------------------------------------------------------------------------
await check('D8', 'a failed attempt keeps its worktree and branch (keep over remove)', async () => {
  const a = await mk({ mode: 'fail' });
  await go(a);
  assert.equal(a.step.status, 'failed');
  assert.ok(fs.existsSync(a.step.worktree));
  assert.ok(git(a.repo, 'rev-parse', '--verify', `refs/heads/${a.step.branch}`).trim());
});

// ---- D9 layout and public names ----------------------------------------------------------------------------------------------------
await check('D9', 'public names exist; index.ts only gained export-from lines; no package.json or lockfile change', async () => {
  assert.deepEqual([...C.AGENTS], ['claude', 'codex']);
  assert.deepEqual([...C.PERMISSIONS], ['acceptEdits', 'dontAsk', 'plan']);
  for (const n of ['runnerExecLimits', 'agentArgv', 'emptyStream', 'readStreamLine', 'worktreeRecipe', 'parseRepoSetup', 'buildPreamble', 'sweepAction', 'exitOutcome']) assert.ok(C[n], `core export ${n}`);
  for (const n of ['transitionStep', 'failStep', 'advanceStage', 'reportStep', 'runnerJobId', 'RunnerError', 'cancelRun', 'retryStep']) assert.ok(C[n], `T6.1 export ${n} kept`);
  for (const n of ['runnerHandlers', 'sweepRunner', 'runGroup', 'procStartTime']) assert.equal(typeof W[n], 'function', `worker export ${n}`);
  const diff = execFileSync('git', ['diff', '-U0', 'HEAD', '--', CORE], { cwd: ROOT, encoding: 'utf8' });
  const lines = diff.split('\n').filter((l) => !/^(diff |index |--- |\+\+\+ |@@)/.test(l) && l !== '');
  assert.deepEqual(lines.filter((l) => l.startsWith('-')), [], 'index.ts lost lines');
  const added = lines.filter((l) => l.startsWith('+')).map((l) => l.slice(1)).join('\n')
    .replace(/export\s+(type\s+)?\{[^}]*\}\s*from\s*['"][^'"]+['"];?/g, '').replace(/export\s+\*\s+(as\s+\w+\s+)?from\s*['"][^'"]+['"];?/g, '').replace(/\/\/[^\n]*/g, '');
  assert.equal(added.trim(), '', 'index.ts changed beyond export-from lines');
  assert.equal(execFileSync('git', ['status', '--porcelain', '--', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'apps/worker/package.json', 'packages/core/package.json'], { cwd: ROOT, encoding: 'utf8' }).trim(), '');
});

// ---- D10 agent registry ------------------------------------------------------------------------------------------------------------
await check('D10', 'agentArgv builds claude and codex argv, never edits base, refuses unknown agent / bad permission / bad model / banned flag', async () => {
  const base = deepFreeze(['claude', '-p', '--output-format', 'stream-json']);
  const out = C.agentArgv('claude', base, { permission: 'plan', model: 'sonnet' });
  assert.deepEqual(out, ['claude', '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan', '--model', 'sonnet']);
  assert.notEqual(out, base);
  assert.deepEqual(C.agentArgv('claude', ['claude', '-p', '--verbose'], { permission: 'dontAsk' }), ['claude', '-p', '--verbose', '--permission-mode', 'dontAsk']);
  assert.deepEqual(C.agentArgv('claude', ['claude'], { permission: 'acceptEdits', model: null }), ['claude', '--verbose', '--permission-mode', 'acceptEdits']);
  const cb = deepFreeze(['codex', 'exec', '--json']);
  assert.deepEqual(C.agentArgv('codex', cb, { permission: 'plan' }), ['codex', 'exec', '--json', '--sandbox', 'read-only']);
  assert.deepEqual(C.agentArgv('codex', cb, { permission: 'acceptEdits', model: 'gpt-5.1-codex' }), ['codex', 'exec', '--json', '--sandbox', 'workspace-write', '--model', 'gpt-5.1-codex']);
  assert.deepEqual(C.agentArgv('codex', cb, { permission: 'dontAsk' }).slice(-2), ['--sandbox', 'workspace-write']);
  const bad = (f, msg) => assert.throws(f, (e) => { assert.ok(e instanceof TypeError, 'TypeError'); assert.equal(e.message, msg); return true; });
  bad(() => C.agentArgv('nope', base, { permission: 'plan' }), 'unknown agent nope');
  bad(() => C.agentArgv('claude', undefined, { permission: 'plan' }), 'unknown agent claude');
  bad(() => C.agentArgv('claude', base, { permission: 'bypassPermissions' }), 'permission bypassPermissions not allowed');
  bad(() => C.agentArgv('codex', cb, { permission: 'full' }), 'permission full not allowed');
  for (const m of ['-x', '--evil', 'a b', '', 'a'.repeat(101), 'x;y']) bad(() => C.agentArgv('claude', base, { permission: 'plan', model: m }), 'model not allowed');
  for (const m of ['claude-sonnet-4-5', 'a/b:c@d[1]', 'a'.repeat(100)]) assert.doesNotThrow(() => C.agentArgv('claude', base, { permission: 'plan', model: m }));
  for (const f of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox']) bad(() => C.agentArgv('claude', ['claude', f], { permission: 'plan' }), `banned flag ${f}`);
  const a = await mk({ node: { prompt: 'CHK_MODE=ok PROMPT-ON-STDIN' } });
  await go(a);
  assert.deepEqual(snapOf(a).argv, ['--verbose', '--permission-mode', 'acceptEdits']);
  assert.ok(snapOf(a).stdin.includes('PROMPT-ON-STDIN'));
});

// ---- D11 stream reading ------------------------------------------------------------------------------------------------------------
await check('D11', 'readStreamLine maps claude and codex events, counts JSON objects, finds quota, never throws or edits state', async () => {
  assert.deepEqual(C.emptyStream(), EMPTY);
  const rs = (agent, st, o) => C.readStreamLine(agent, st, typeof o === 'string' ? o : JSON.stringify(o));
  const frozen = deepFreeze(C.emptyStream());
  const s1 = rs('claude', frozen, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'x' }, { type: 'text', text: 'hello there' }] } });
  assert.deepEqual([s1.events, s1.lastMessage, frozen.events], [1, 'hello there', 0]);
  const two = rs('claude', frozen, { type: 'assistant', message: { content: [{ type: 'text', text: 'AAA' }, { type: 'text', text: 'BBB' }] } });
  assert.ok(two.lastMessage.includes('AAA') && two.lastMessage.includes('BBB'));
  const s2 = rs('claude', s1, { type: 'result', result: 'final', usage: { input_tokens: 1 }, total_cost_usd: 0.5, is_error: false });
  assert.deepEqual([s2.events, s2.lastMessage, s2.usage, s2.costUsd, s2.quota], [2, 'final', { input_tokens: 1 }, 0.5, null]);
  const s3 = rs('claude', s2, { type: 'result', result: 'x', usage: 'no', total_cost_usd: 'no' });
  assert.deepEqual([s3.usage, s3.costUsd], [{ input_tokens: 1 }, 0.5]);
  assert.deepEqual(rs('claude', frozen, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1893456000 } }).quota, { resetsAt: '2030-01-01T00:00:00.000Z' });
  assert.deepEqual(rs('claude', frozen, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }).quota, { resetsAt: null });
  assert.equal(rs('claude', frozen, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1893456000 } }).quota, null);
  assert.deepEqual(rs('claude', frozen, { type: 'result', is_error: true, result: "You've hit your session limit · resets 3pm" }).quota, { resetsAt: null });
  assert.deepEqual(rs('claude', frozen, { type: 'result', is_error: true, result: 'Claude usage limit reached' }).quota, { resetsAt: null });
  assert.equal(rs('claude', frozen, { type: 'result', is_error: true, result: 'tool failed' }).quota, null);
  assert.equal(rs('claude', frozen, { type: 'result', is_error: false, result: 'we discussed the usage limit' }).quota, null);
  for (const l of ['', 'plain', '[1]', '"s"', '7', 'null', '{broken']) assert.deepEqual(rs('claude', frozen, l), frozen);
  assert.equal(rs('claude', frozen, { type: 'mystery' }).events, 1);
  let c = C.emptyStream();
  c = rs('codex', c, { type: 'thread.started', thread_id: 't1' });
  c = rs('codex', c, { type: 'item.completed', item: { type: 'agent_message', text: 'first' } });
  c = rs('codex', c, { type: 'item.completed', item: { type: 'agent_message', text: 'second' } });
  c = rs('codex', c, { type: 'turn.completed', usage: { input_tokens: 9, output_tokens: 4 } });
  assert.deepEqual([c.events, c.lastMessage, c.usage, c.costUsd, c.error, c.quota], [4, 'second', { input_tokens: 9, output_tokens: 4 }, null, null, null]);
  assert.equal(rs('codex', frozen, { type: 'error', message: 'stream broke' }).error, 'stream broke');
  assert.equal(rs('codex', frozen, { type: 'turn.failed', error: { message: 'turn broke' } }).error, 'turn broke');
  assert.deepEqual(rs('codex', frozen, { type: 'error', message: 'You have hit your usage limit' }).quota, { resetsAt: null });
  assert.equal(rs('codex', frozen, { type: 'item.completed', item: { type: 'command_execution', text: 'no' } }).lastMessage, null);
  assert.equal(rs('codex', frozen, { type: 'error', message: 'e'.repeat(3000) }).error.length, 2000);
});

// ---- D12 worktree recipe -----------------------------------------------------------------------------------------------------------
await check('D12', 'worktreeRecipe is pure and exact; a real attempt adds the worktree, branch, base config, one exclude line; concurrent steps of one repo all succeed', async () => {
  const o = { repo: '/r', dir: '.ctc/wt', workflow: 'wf', runId: 7, nodeId: 'impl', stepId: 42, visit: 1, attempt: 1, base: 'main' };
  assert.deepEqual(C.worktreeRecipe(o), {
    branch: 'ctc/wf-7-impl', path: '/r/.ctc/wt/7/42',
    add: ['worktree', 'add', '--no-track', '-b', 'ctc/wf-7-impl', '/r/.ctc/wt/7/42', 'main'], config: ['config', 'branch.ctc/wf-7-impl.base', 'main'],
  });
  assert.equal(C.worktreeRecipe({ ...o, child: 'a b' }).branch, 'ctc/wf-7-impl-a-b');
  assert.equal(C.worktreeRecipe({ ...o, visit: 2, attempt: 3 }).branch, 'ctc/wf-7-impl-v2-a3');
  assert.equal(C.worktreeRecipe({ ...o, visit: 2, attempt: 1 }).branch, 'ctc/wf-7-impl-v2');
  assert.equal(C.worktreeRecipe({ ...o, attempt: 2 }).branch, 'ctc/wf-7-impl-a2');
  assert.equal(C.worktreeRecipe({ ...o, workflow: '--we ird//name!!' }).branch, 'ctc/we-ird-name-7-impl');
  assert.equal(C.worktreeRecipe({ ...o, nodeId: '' }).branch, 'ctc/wf-7-x');
  assert.equal(C.worktreeRecipe({ ...o, nodeId: 'a'.repeat(70) }).branch, `ctc/wf-7-${'a'.repeat(60)}`);
  assert.equal(C.worktreeRecipe({ ...o, repo: '/r/', dir: '.ctc//wt/' }).path, '/r/.ctc/wt/7/42');
  const frozen = deepFreeze({ ...o });
  assert.doesNotThrow(() => C.worktreeRecipe(frozen));
  for (const bad of [{ repo: 'rel/repo' }, { dir: '/abs' }, { dir: '../x' }, { dir: 'a/../../x' }, { base: '' }, { base: '-x' }]) assert.throws(() => C.worktreeRecipe({ ...o, ...bad }), TypeError);

  const a = await mk();
  await go(a);
  assert.equal(a.step.status, 'done');
  assert.equal(a.step.branch, branchOf(a));
  assert.equal(a.step.worktree, path.join(a.repo, '.ctc/wt', String(a.run.id), String(a.step.id)));
  assert.ok(fs.existsSync(path.join(a.step.worktree, 'README.md')));
  assert.equal(git(a.repo, 'config', `branch.${a.step.branch}.base`).trim(), 'main');
  assert.equal(git(a.repo, 'rev-parse', a.step.branch).trim(), git(a.repo, 'rev-parse', 'main').trim());
  const b = await mk({ repo: a.repo });
  await go(b);
  const exclude = fs.readFileSync(path.join(a.repo, '.git/info/exclude'), 'utf8').split('\n');
  assert.equal(exclude.filter((l) => l === '/.ctc/').length, 1);
  assert.equal(git(a.repo, 'status', '--porcelain').trim(), '');
  const nb = await mk({ baseBranch: null });
  await go(nb);
  assert.equal(git(nb.repo, 'config', `branch.${nb.step.branch}.base`).trim(), 'HEAD');
  const many = [];
  const shared = mkRepo();
  for (let i = 0; i < 3; i++) many.push(await mk({ repo: shared }));
  const results = await Promise.all(many.map((m) => go(m)));
  assert.deepEqual(results.map((r) => r.status), ['done', 'done', 'done']);
});

// ---- D13 setup hook -----------------------------------------------------------------------------------------------------------------
await check('D13', 'parseRepoSetup forms; setup runs in the worktree with the two env vars and no CTC_ secrets; stops at the first failure; timeout, overflow, ask, skip', async () => {
  const p = (t) => C.parseRepoSetup(t);
  assert.deepEqual(p('setup: "npm ci"\n'), { setup: ['npm ci'] });
  assert.deepEqual(p('setup:\n  - a\n  - ""\n  - b\n'), { setup: ['a', 'b'] });
  assert.deepEqual([p(''), p('name: x\n'), p('setup:\n'), p('setup: "  "\n'), p('setup: []\n')], [{ setup: [] }, { setup: [] }, { setup: [] }, { setup: [] }, { setup: [] }]);
  for (const t of ['setup: 5\n', 'setup: [1]\n', 'setup: {a: b}\n', 'a: [\n', 'setup: [a, [b]]\n']) assert.throws(() => p(t), TypeError);

  process.env.CTC_SECRET_CANARY = 'canary-value';
  const yaml = 'setup: |\n  echo ran > setup-ran.txt\n  echo "$CTC_WORKTREE_PATH" > wt.txt\n  echo "$CTC_ROOT_PATH" > root.txt\n  env | grep -c CTC_SECRET_CANARY > canary.txt || true\n  echo log-line\n';
  const a = await mk({ ctcYaml: yaml });
  await go(a);
  assert.equal(a.step.status, 'done');
  const rd = (f) => fs.readFileSync(path.join(a.step.worktree, f), 'utf8').trim();
  assert.deepEqual([rd('setup-ran.txt'), rd('wt.txt'), rd('root.txt'), rd('canary.txt')], ['ran', a.step.worktree, a.repo, '0']);
  assert.ok(fs.readFileSync(path.join(attemptDir(a), `${a.step.id}.setup.log`), 'utf8').includes('log-line'));

  const order = await mk({ ctcYaml: 'setup:\n  - echo a >> order.txt\n  - exit 2\n  - echo c >> order.txt\n' });
  await go(order);
  assert.deepEqual([order.step.status, order.step.error, order.step.stage, fs.readFileSync(path.join(order.step.worktree, 'order.txt'), 'utf8')], ['failed', 'setup failed: exit 2', 'setup', 'a\n']);

  const slow = await mk({ ctcYaml: 'setup: "sleep 30 & echo $! > bg.pid; wait"\n' });
  const t0 = Date.now();
  await go(slow, mkDeps({}, { setup: { timeout_s: 1, max_output_mb: 1, policy: 'run' } }));
  assert.deepEqual([slow.step.status, slow.step.error], ['failed', 'setup timed out after 1 s']);
  assert.ok(Date.now() - t0 < 8000);
  const slowPid = Number(fs.readFileSync(path.join(slow.step.worktree, 'bg.pid'), 'utf8').trim());
  await until(async () => !alive(slowPid), 3000);
  assert.equal(snaps(slow).length, 0);

  const big = await mk({ ctcYaml: "setup: \"head -c 1100000 /dev/zero | tr '\\\\0' x\"\n" });
  await go(big);
  assert.deepEqual([big.step.status, big.step.error], ['failed', 'setup output over 1 MB']);

  const skip = await mk({ ctcYaml: 'setup: "echo ran > setup-ran.txt"\n' });
  await go(skip, mkDeps({}, { setup: { timeout_s: 10, max_output_mb: 1, policy: 'skip' } }));
  assert.deepEqual([skip.step.status, fs.existsSync(path.join(skip.step.worktree, 'setup-ran.txt'))], ['done', false]);

  const ask = await mk({ ctcYaml: 'setup: "echo ran > setup-ran.txt"\n' });
  const askDeps = mkDeps({}, { setup: { timeout_s: 10, max_output_mb: 1, policy: 'ask' } });
  const res = await go(ask, askDeps);
  assert.deepEqual(res, { stepId: ask.step.id, status: 'waiting', skipped: false });
  assert.deepEqual(ask.step.options, [{ id: 'run', label: 'Run setup' }, { id: 'skip', label: 'Skip setup' }]);
  assert.notEqual(ask.step.stage, 'setup');
  assert.equal(ask.step.branch, null);
  assert.equal(git(ask.repo, 'branch', '--list', 'ctc/*').trim(), '');
  assert.equal((await getRun(ask.ctx, ask.run.id)).status, 'waiting');
  assert.equal(snaps(ask).length, 0);
  const askRun = await mk({ ctcYaml: 'setup: "echo ran > setup-ran.txt"\n', node: { setupDecision: 'run' } });
  await go(askRun, askDeps);
  assert.deepEqual([askRun.step.status, fs.existsSync(path.join(askRun.step.worktree, 'setup-ran.txt'))], ['done', true]);
  const askSkip = await mk({ ctcYaml: 'setup: "echo ran > setup-ran.txt"\n', node: { setupDecision: 'skip' } });
  await go(askSkip, askDeps);
  assert.deepEqual([askSkip.step.status, fs.existsSync(path.join(askSkip.step.worktree, 'setup-ran.txt'))], ['done', false]);
  const askNone = await mk({});
  assert.equal((await go(askNone, askDeps)).status, 'done');
});

// ---- D14 spawn and report token ------------------------------------------------------------------------------------------------------
await check('D14', 'attempt dir and files with modes; wrapper leads a detached group; env names and report URL; new token per attempt; preamble; spawn refusal writes no stage; missing binary or cwd fails', async () => {
  const a = await mk({ mode: 'ok', sleep: 1200 });
  const pending = go(a);
  const live = await until(async () => { const s = await getStep(a.ctx, a.step.id); return s.pid && s.stage === 'stream' ? s : null; });
  const st = stat(live.pid);
  assert.deepEqual([st[2], st[3]], [String(live.pid), String(live.pid)], 'pid leads its own group and session');
  assert.ok(live.pidStartedAt instanceof Date);
  await pending;
  const dir = attemptDir(a);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  for (const ext of ['prompt', 'jsonl', 'err', 'exit']) {
    const f = path.join(dir, `${a.step.id}.${ext}`);
    assert.equal(fs.statSync(f).mode & 0o777, 0o600, `${ext} mode`);
  }
  assert.equal(fs.existsSync(path.join(dir, `${a.step.id}.exit.tmp`)), false);
  assert.equal(fs.readFileSync(path.join(dir, `${a.step.id}.exit`), 'utf8').trim(), '0');
  assert.equal(a.step.logPath, path.join(dir, `${a.step.id}.jsonl`));
  assert.ok(fs.readFileSync(a.step.logPath, 'utf8').includes('"final answer"'));
  const snap = snapOf(a);
  assert.equal(snap.env.CTC_REPORT_URL, `http://127.0.0.1:18410/api/runs/${a.run.id}/steps/${a.step.id}/report`);
  assert.deepEqual([snap.env.CTC_RUN_ID, snap.env.CTC_STEP_ID, snap.env.CTC_ROOT_PATH, snap.env.CTC_WORKTREE_PATH], [String(a.run.id), String(a.step.id), a.repo, a.step.worktree]);
  assert.equal(fs.realpathSync(snap.cwd), fs.realpathSync(a.step.worktree));
  for (const need of ['curl', '$CTC_REPORT_URL', 'X-CTC-Step-Token', '$CTC_STEP_TOKEN', 'outcome', 'summary', a.node.prompt]) assert.ok(snap.stdin.includes(need), `stdin has ${need}`);
  assert.equal(snap.stdin.includes(snap.env.CTC_STEP_TOKEN), false);
  assert.equal(fs.readFileSync(path.join(dir, `${a.step.id}.prompt`), 'utf8'), snap.stdin);
  const none = await mk({ node: { worktree: 'none' } });
  await go(none);
  assert.deepEqual([snapOf(none).env.CTC_ROOT_PATH, snapOf(none).env.CTC_WORKTREE_PATH], [undefined, undefined]);
  const first = await mk({ mode: 'fail' });
  await go(first);
  const second = await mk({ repo: first.repo, ctx: first.ctx });
  await go(second);
  assert.notEqual(snapOf(first).env.CTC_STEP_TOKEN, snapOf(second).env.CTC_STEP_TOKEN);
  const pre = C.buildPreamble({ workflow: 'wf', nodeId: 'n1', attempt: 2, prompt: 'Do $X `y` "z"\n  verbatim', resolution: 'APPROVED-BY-USER' });
  assert.ok(pre.includes('Do $X `y` "z"\n  verbatim') && pre.includes('APPROVED-BY-USER'));
  assert.ok(pre.includes('$CTC_REPORT_URL') && pre.includes('X-CTC-Step-Token') && pre.includes('curl'));
  assert.equal(/[0-9a-f]{64}/.test(pre), false);
  const pre2 = C.buildPreamble({ workflow: 'wf', nodeId: 'n1', attempt: 1, prompt: 'P' });
  assert.equal(pre2.includes('APPROVED-BY-USER'), false);
  assert.equal(pre2, C.buildPreamble({ workflow: 'wf', nodeId: 'n1', attempt: 1, prompt: 'P' }));
  const refused = await mk({ node: { agent: 'nope' } });
  await go(refused);
  assert.ok(refused.step.stage !== 'spawn' && refused.step.stage !== 'stream');
  assert.deepEqual([refused.step.tokenHash, refused.step.pid], [null, null]);
  const nobin = await mk();
  await go(nobin, mkDeps({}, { agents: { claude: { argv: ['/nonexistent/agent-bin'] }, codex: { argv: ['codex'] } } }));
  assert.equal(nobin.step.status, 'failed');
  assert.match(nobin.step.error, /^(spawn failed: ENOENT|exit 127)/);
  const nocwd = await mk({ repo: path.join(TMP, 'no-such-dir'), node: { worktree: 'none' } });
  await go(nocwd);
  assert.equal(nocwd.step.status, 'failed');
  assert.match(nocwd.step.error, /^(spawn failed: ENOENT|worktree failed: )/);
});

// ---- D15 following an attempt ---------------------------------------------------------------------------------------------------------
await check('D15', 'delivered on the first event; usage and cost stored; cancel kills the group; a report ends the step first; quota parks step and run; a vanished leader is start_unknown', async () => {
  const a = await mk({ mode: 'ok', sleep: 1500 });
  const pending = go(a);
  await until(async () => (await getStep(a.ctx, a.step.id)).promptOutcome === 'delivered');
  assert.equal((await getStep(a.ctx, a.step.id)).status, 'running');
  await pending;
  assert.deepEqual([a.step.usage, a.step.costUsd], [{ input_tokens: 5, output_tokens: 7 }, 0.25]);

  const c = await mk({ mode: 'hang' });
  const pc = go(c);
  const live = await until(async () => { const s = await getStep(c.ctx, c.step.id); return s.pid && s.stage === 'stream' ? s : null; });
  await C.transitionStep(repos.runner, c.ctx, { stepId: c.step.id, from: 'running', to: 'cancelled' });
  const rc = await pc;
  assert.equal(rc.status, 'cancelled');
  await gone(live.pid);
  assert.equal((await getStep(c.ctx, c.step.id)).status, 'cancelled');

  const r = await mk({ mode: 'hang' });
  const pr = go(r);
  const liveR = await until(async () => { const s = await getStep(r.ctx, r.step.id); return s.pid && s.stage === 'stream' ? s : null; });
  const rep = await C.reportStep(repos.runner, r.ctx, { stepId: r.step.id, outcome: 'done', summary: 'by agent' });
  assert.equal(rep.applied, true);
  const rr = await pr;
  assert.equal(rr.status, 'done');
  await gone(liveR.pid);
  const after = await getStep(r.ctx, r.step.id);
  assert.deepEqual([after.status, after.output.outcome, after.output.summary], ['done', 'done', 'by agent']);

  const q = await mk({ mode: 'quota' });
  const t0 = Date.now();
  const rq = await go(q);
  assert.equal(rq.status, 'quota');
  assert.equal(q.step.error, 'usage limit until 2030-01-01T00:00:00.000Z');
  assert.equal((await getRun(q.ctx, q.run.id)).status, 'quota');
  assert.ok(Date.now() - t0 < 15000);
  await gone(q.step.pid);

  const s = await mk({ mode: 'suicide' });
  const rs = await go(s);
  assert.equal(rs.status, 'start_unknown');
  assert.equal(s.step.liveness, 'start_unknown');
  assert.equal((await getRun(s.ctx, s.run.id)).status, 'waiting');
});

// ---- D16 end of an attempt ------------------------------------------------------------------------------------------------------------
await check('D16', 'exitOutcome is pure and exact; exit 0 is done with the last message; exit 3 is failed with the stderr line; circuit break; diffStat; onStepEnd once and its throw swallowed', async () => {
  const stream = { ...EMPTY, events: 3, lastMessage: 'the last' };
  assert.deepEqual(C.exitOutcome({ exitCode: 0, stream }), { to: 'done', output: { outcome: 'done', summary: 'the last' }, error: null });
  assert.deepEqual(C.exitOutcome({ exitCode: 3, stream, stderrTail: 'a\nboom\n\n  \n' }), { to: 'failed', output: { outcome: 'failed', summary: 'the last' }, error: 'exit 3: boom' });
  assert.equal(C.exitOutcome({ exitCode: 3, stream }).error, 'exit 3');
  assert.equal(C.exitOutcome({ exitCode: 0, stream: EMPTY }).output.summary, null);
  assert.equal(C.exitOutcome({ exitCode: 0, stream: { ...EMPTY, lastMessage: 'z'.repeat(25000) } }).output.summary.length, 20000);
  const fz = deepFreeze({ exitCode: 1, stream: { ...EMPTY }, stderrTail: 'x' });
  assert.doesNotThrow(() => C.exitOutcome(fz));

  const f = await mk({ mode: 'fail' });
  await go(f);
  assert.deepEqual([f.step.status, f.step.error, f.step.stage, f.step.output.outcome, f.step.output.summary, f.step.promptOutcome], ['failed', 'exit 3: bad thing', 'report', 'failed', 'working', 'delivered']);
  const cb = await mk({ mode: 'fail', failureCount: 2 });
  await go(cb);
  assert.equal(cb.step.status, 'circuit_broken');
  assert.equal((await getRun(cb.ctx, cb.run.id)).status, 'failed');

  const e = await mk({ edit: true });
  await go(e);
  assert.match(e.step.output.diffStat, /1 file changed/);
  const ne = await mk();
  await go(ne);
  assert.equal(ne.step.output.diffStat, '');

  ENDED.length = 0;
  const ok1 = await mk();
  await go(ok1);
  assert.equal(ENDED.filter((s) => s.id === ok1.step.id).length, 1);
  assert.equal(ENDED.find((s) => s.id === ok1.step.id).status, 'done');
  const sw = await mk();
  const r = await go(sw, mkDeps({ onStepEnd: async () => { throw new Error('hook broke'); } }));
  assert.equal(r.status, 'done');
  const before = ENDED.length;
  await dropped(call({ ...sw, payload: { ...sw.payload, nodeId: 'zzz' } }), 'payload_mismatch');
  assert.equal((await call(sw)).skipped, true);
  assert.equal(ENDED.length, before);
});

// ---- D17 timeout -----------------------------------------------------------------------------------------------------------------------
await check('D17', 'the abort signal ends the whole attempt: agent group killed, step timeout with the exact error; also during setup', async () => {
  const a = await mk({ mode: 'hang', node: { timeoutS: 1 } });
  const pa = go(a);
  await until(async () => (await getStep(a.ctx, a.step.id)).stage === 'stream');
  a.ac.abort();
  const res = await pa;
  assert.equal(res.status, 'timeout');
  assert.equal(a.step.error, 'timeout after 1 s');
  assert.ok(a.step.pid, 'the agent had a pid');
  await gone(a.step.pid);
  const b = await mk({ ctcYaml: 'setup: "sleep 30 & echo $! > bg.pid; wait"\n', node: { timeoutS: 1 } });
  const pb = go(b);
  const bgFile = await until(async () => { const s = await getStep(b.ctx, b.step.id); const f = s.worktree && path.join(s.worktree, 'bg.pid'); return f && fs.existsSync(f) && fs.readFileSync(f, 'utf8').trim() ? f : null; });
  b.ac.abort();
  const rb = await pb;
  assert.deepEqual([rb.status, b.step.error], ['timeout', 'timeout after 1 s']);
  const bgPid = Number(fs.readFileSync(bgFile, 'utf8').trim());
  await until(async () => !alive(bgPid), 3000);
  assert.equal(snaps(b).length, 0);
});

// ---- D18 restart sweep -------------------------------------------------------------------------------------------------------------------
await check('D18', 'sweepAction table; sweepRunner fail_stage / finish / reattach / start_unknown over two users; nothing killed on a mismatching pid; reattach after a real worker SIGKILL', async () => {
  const t = new Date('2026-02-02T00:00:00Z');
  const s = (o) => ({ stage: 'stream', pid: 10, pidStartedAt: t, ...o });
  const live = { exitCode: null, startedAt: t };
  assert.deepEqual([null, 'worktree', 'setup'].map((stage) => C.sweepAction(s({ stage }), { exitCode: 0, startedAt: t })), ['fail_stage', 'fail_stage', 'fail_stage']);
  assert.equal(C.sweepAction(s({ stage: 'spawn' }), { exitCode: 0, startedAt: null }), 'finish');
  assert.equal(C.sweepAction(s(), { exitCode: 7, startedAt: t }), 'finish');
  assert.equal(C.sweepAction(s(), live), 'reattach');
  assert.equal(C.sweepAction(s({ stage: 'spawn' }), live), 'reattach');
  assert.deepEqual([s({ pid: null }), s({ pidStartedAt: null })].map((x) => C.sweepAction(x, live)), ['start_unknown', 'start_unknown']);
  assert.equal(C.sweepAction(s(), { exitCode: null, startedAt: null }), 'start_unknown');
  assert.equal(C.sweepAction(s(), { exitCode: null, startedAt: new Date(t.getTime() + 60_000) }), 'start_unknown');
  assert.doesNotThrow(() => C.sweepAction(deepFreeze(s()), deepFreeze({ ...live })));

  const lineResult = JSONL({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }, { type: 'result', result: 'from log', usage: { input_tokens: 1 }, total_cost_usd: 0.1 });
  const f1 = await fab(ctxA, { stage: null });
  const f2 = await fab(ctxB, { stage: 'worktree' });
  const f3 = await fab(ctxA, { stage: 'stream', exit: 0, log: lineResult });
  const f4 = await fab(ctxB, { stage: 'stream', exit: 3, log: lineResult });
  const f5 = await fab(ctxA, { stage: 'stream', pid: null });
  const f6 = await fab(ctxA, { stage: 'stream', pid: null, runStatus: 'done' });
  const f7 = await fab(ctxB, { stage: 'stream', pid: null, log: JSONL({ type: 'system' }) });
  const sleeper = spawnSleeper();
  const started = await W.procStartTime(sleeper.pid);
  assert.ok(started instanceof Date);
  const f8 = await fab(ctxA, { stage: 'stream', pid: sleeper.pid, pidStartedAt: new Date(started.getTime() + 600_000) });
  const orphan = spawnSleeper();
  const f9 = await fab(ctxA, { stage: 'setup', pid: orphan.pid, pidStartedAt: await W.procStartTime(orphan.pid) });
  const foreign = spawnSleeper();
  const f10 = await fab(ctxB, { stage: 'setup', pid: foreign.pid, pidStartedAt: new Date((await W.procStartTime(foreign.pid)).getTime() + 600_000) });
  const all = [f1, f2, f3, f4, f5, f6, f7, f8, f9, f10];
  const res = await W.sweepRunner(mkDeps());
  await res.settled;
  assert.deepEqual(res.actions.map((x) => x.stepId), [...res.actions.map((x) => x.stepId)].sort((x, y) => x - y), 'list order');
  assert.deepEqual(all.map((f) => actionOf(res, f)), ['fail_stage', 'fail_stage', 'finish', 'finish', 'start_unknown', 'start_unknown', 'start_unknown', 'start_unknown', 'fail_stage', 'fail_stage']);
  const row = async (f) => getStep(f.ctx, f.step.id);
  const g1 = await row(f1); const g2 = await row(f2);
  assert.deepEqual([g1.status, g1.error, g2.status, g2.error], ['failed', 'interrupted before stage worktree', 'failed', 'interrupted at stage worktree']);
  const g3 = await row(f3); const g4 = await row(f4);
  assert.deepEqual([g3.status, g3.output.summary, g3.usage, g3.costUsd], ['done', 'from log', { input_tokens: 1 }, 0.1]);
  assert.deepEqual([g4.status, g4.error], ['failed', 'exit 3']);
  const g5 = await row(f5); const g7 = await row(f7);
  assert.deepEqual([g5.status, g5.liveness, g5.promptOutcome, g7.promptOutcome], ['start_unknown', 'start_unknown', 'unconfirmed', 'delivered']);
  assert.equal((await getRun(f5.ctx, f5.run.id)).status, 'waiting');
  assert.equal((await getRun(f6.ctx, f6.run.id)).status, 'done');
  assert.equal(alive(sleeper.pid), true, 'a pid with a different start time is not signalled');
  assert.equal(await until(async () => !alive(orphan.pid), 8000).catch(() => false), true, 'a matching setup orphan is killed');
  assert.deepEqual([(await row(f9)).status, (await row(f9)).error], ['failed', 'interrupted at stage setup']);
  assert.equal(alive(foreign.pid), true);
  assert.equal((await row(f10)).status, 'failed');
  assert.ok(res.actions.every((x) => ['fail_stage', 'finish', 'reattach', 'start_unknown', 'skipped'].includes(x.action)));
  for (const f of all) await retire(f);

  const exp = await fab(ctxA, { stage: 'stream', pid: null });
  assert.equal(actionOf(await W.sweepRunner(mkDeps({ resolveNode: async () => null })), exp), 'start_unknown');
  await retire(exp);

  const rem = spawnSleeper();
  const fr = await fab(ctxA, { stage: 'stream', pid: rem.pid, pidStartedAt: await W.procStartTime(rem.pid), node: { timeoutS: 1 }, startedAt: new Date(Date.now() - 3_600_000) });
  const rr = await W.sweepRunner(mkDeps());
  assert.equal(actionOf(rr, fr), 'reattach');
  await rr.settled;
  const gr = await row(fr);
  assert.deepEqual([gr.status, gr.error], ['timeout', 'timeout after 1 s']);
  assert.equal(await until(async () => !alive(rem.pid), 8000).catch(() => false), true);

  // a real worker crash: the handler runs in a child node process that is SIGKILLed while the agent is streaming
  const child = path.join(TMP, 'child.mjs');
  fs.writeFileSync(child, `
import { pathToFileURL } from 'node:url';
const [, , root, schema, url, nodeJson, payloadJson] = process.argv;
const load = (rel) => import(pathToFileURL(root + '/' + rel).href);
const R = await load('${REPOS}'); const C = await load('${CORE}'); const W = await load('${WORKER}');
Object.assign(C.runnerExecLimits, JSON.parse(process.env.CHK_LIMITS));
const repos = R.createRepositories(R.createDb({ url, schema }));
const node = JSON.parse(nodeJson);
const deps = { repos, config: JSON.parse(process.env.CHK_CONFIG), runsDir: process.env.CHK_RUNS, reportBase: 'http://127.0.0.1:18410', resolveNode: async () => node };
await W.runnerHandlers(deps)['runner.step'](JSON.parse(payloadJson), { jobId: 'child', attempt: 1, signal: new AbortController().signal, setProgress: async () => {} });
process.exit(0);
`);
  const crash = async (killAgentToo) => {
    const a = await mk({ mode: 'ok', sleep: 7000 });
    const cp = spawn(process.execPath, ['--import', 'tsx', child, ROOT, schema, url, JSON.stringify(a.node), JSON.stringify(a.payload)], {
      stdio: 'ignore', env: { ...process.env, CHK_OUT: OUT, CHK_LIMITS: JSON.stringify(FAST_LIMITS), CHK_CONFIG: JSON.stringify(CFG()), CHK_RUNS: RUNS },
    });
    const run = await until(async () => { const s = await getStep(a.ctx, a.step.id); return s.pid && s.stage === 'stream' ? s : null; }, 60_000);
    cp.kill('SIGKILL');
    await new Promise((r) => cp.once('exit', r));
    if (killAgentToo) { process.kill(-run.pid, 'SIGKILL'); await until(async () => !groupAlive(run.pid), 5000); }
    assert.equal((await getStep(a.ctx, a.step.id)).status, 'running', 'the killed worker left the step running');
    return { a, run };
  };
  const ra = await crash(false);
  assert.equal(groupAlive(ra.run.pid), true, 'the agent survives its worker');
  const sa = await W.sweepRunner(mkDeps());
  assert.equal(actionOf(sa, { step: ra.a.step }), 'reattach');
  await sa.settled;
  const fin = await getStep(ra.a.ctx, ra.a.step.id);
  assert.deepEqual([fin.status, fin.output.summary], ['done', 'final answer']);
  const rb = await crash(true);
  const sb = await W.sweepRunner(mkDeps());
  assert.equal(actionOf(sb, { step: rb.a.step }), 'start_unknown');
  await sb.settled;
  const fb = await getStep(rb.a.ctx, rb.a.step.id);
  assert.deepEqual([fb.status, fb.liveness], ['start_unknown', 'start_unknown']);
  assert.equal((await getRun(rb.a.ctx, rb.a.run.id)).status, 'waiting');
});

// ---- D19 killing a group ------------------------------------------------------------------------------------------------------------------
await check('D19', 'runGroup: argv without a shell, own group, exact env, TERM then KILL, abort, exit code; procStartTime of live, dead and zombie processes', async () => {
  const f = () => path.join(TMP, `rg-${rnd()}.out`);
  const o1 = f();
  const r1 = await W.runGroup({ cmd: ['/bin/sh', '-c', 'echo hi; echo err >&2; exit 3'], cwd: TMP, env: {}, timeoutMs: 10000, maxOutputBytes: 1 << 20, outFile: o1 });
  assert.deepEqual([r1.code, r1.timedOut, r1.overflow, r1.aborted], [3, false, false, false]);
  const t1 = fs.readFileSync(o1, 'utf8');
  assert.ok(t1.includes('hi') && t1.includes('err'));
  const o2 = f();
  await W.runGroup({ cmd: ['/bin/echo', '$(touch /tmp/ctc-t62chk-never)', 'a b'], cwd: TMP, env: {}, timeoutMs: 10000, maxOutputBytes: 1 << 20, outFile: o2 });
  assert.equal(fs.readFileSync(o2, 'utf8').trim(), '$(touch /tmp/ctc-t62chk-never) a b');
  const o3 = f();
  await W.runGroup({ cmd: ['/usr/bin/env'], cwd: TMP, env: { A: '1' }, timeoutMs: 10000, maxOutputBytes: 1 << 20, outFile: o3 });
  assert.equal(fs.readFileSync(o3, 'utf8').trim(), 'A=1');
  const lead = [];
  await W.runGroup({ cmd: ['/bin/sh', '-c', 'sleep 0.5'], cwd: TMP, env: {}, timeoutMs: 10000, maxOutputBytes: 1 << 20, outFile: f(), onStart: (pid) => { lead.push(pid, stat(pid)[2]); } });
  assert.equal(String(lead[0]), lead[1], 'leader of its own group');

  const bg = path.join(TMP, `bg-${rnd()}.pid`);
  let leader = 0;
  const t0 = Date.now();
  const r2 = await W.runGroup({ cmd: ['/bin/sh', '-c', 'sleep 30 & echo $! > "$0"; wait', bg], cwd: TMP, env: { PATH: process.env.PATH }, timeoutMs: 400, maxOutputBytes: 1 << 20, outFile: f(), onStart: (pid) => { leader = pid; } });
  assert.deepEqual([r2.timedOut, r2.code === 0], [true, false]);
  assert.ok(Date.now() - t0 < 5000);
  const bgPid = Number(fs.readFileSync(bg, 'utf8').trim());
  await until(async () => !alive(bgPid), 3000);
  await gone(leader);

  const bg2 = path.join(TMP, `bg-${rnd()}.pid`);
  const t2 = Date.now();
  const r3 = await W.runGroup({ cmd: ['/bin/sh', '-c', 'trap "" TERM; sleep 30 & echo $! > "$0"; wait', bg2], cwd: TMP, env: { PATH: process.env.PATH }, timeoutMs: 300, maxOutputBytes: 1 << 20, outFile: f() });
  assert.equal(r3.timedOut, true);
  assert.ok(Date.now() - t2 >= 300 + C.runnerExecLimits.killGraceMs - 50 && Date.now() - t2 < 6000, 'KILL follows TERM after the grace');
  const bgPid2 = Number(fs.readFileSync(bg2, 'utf8').trim());
  await until(async () => !alive(bgPid2), 3000);

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const r4 = await W.runGroup({ cmd: ['/bin/sh', '-c', 'sleep 30'], cwd: TMP, env: { PATH: process.env.PATH }, timeoutMs: 20000, maxOutputBytes: 1 << 20, outFile: f(), signal: ac.signal });
  assert.deepEqual([r4.aborted, r4.timedOut], [true, false]);

  const own = await W.procStartTime(process.pid);
  assert.ok(Math.abs(own.getTime() - (Date.now() - process.uptime() * 1000)) < 3000, 'start time of this process');
  assert.equal(await W.procStartTime(2 ** 22 + 12345), null);
  const dead = spawnSleeper();
  process.kill(dead.pid, 'SIGKILL');
  await until(async () => (await W.procStartTime(dead.pid)) === null, 5000);
  const zp = spawn('/bin/sh', ['-c', '/bin/sh -c "exit 0" & echo $!; exec sleep 5'], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  MANUAL.push(zp);
  const zpid = Number(await new Promise((res) => zp.stdout.once('data', (d) => res(String(d).trim()))));
  await sleep(300);
  assert.equal(await W.procStartTime(zpid), null, 'a zombie has no start time');
});

// ---- D20 run status writes ---------------------------------------------------------------------------------------------------------------------
await check('D20', 'the run changes only to waiting (start_unknown, ask) or quota; a done, failed or cancelled run is never changed; a done attempt leaves it alone', async () => {
  const ok1 = await mk();
  await go(ok1);
  assert.equal((await getRun(ok1.ctx, ok1.run.id)).status, 'running');
  const fl = await mk({ mode: 'fail' });
  await go(fl);
  assert.equal((await getRun(fl.ctx, fl.run.id)).status, 'running');
  for (const final of ['done', 'failed', 'cancelled']) {
    const f = await fab(ctxA, { stage: 'stream', pid: null, runStatus: final });
    const res = await W.sweepRunner(mkDeps());
    assert.equal(actionOf(res, f), 'start_unknown');
    assert.equal((await getRun(f.ctx, f.run.id)).status, final);
  }
  const ask = await mk({ ctcYaml: 'setup: "true"\n', runStatus: 'queued' });
  const res = await go(ask, mkDeps({}, { setup: { timeout_s: 10, max_output_mb: 1, policy: 'ask' } }));
  assert.equal(res.status, 'waiting');
  assert.equal((await getRun(ask.ctx, ask.run.id)).status, 'waiting');
  const srcs = sources(WORKER_DIR).filter(([, s]) => /setRunStatus\(/.test(s));
  assert.ok(srcs.length <= 1);
  for (const [, s] of srcs) assert.equal(/to:\s*['"`](done|failed|cancelled|running|queued)['"`]/.test(s.split('setRunStatus(').slice(1).map((x) => x.slice(0, 200)).join('\n')), false);
});

// ---- D21 gate tests ----------------------------------------------------------------------------------------------------------------------------
await check('D21', 'runner.crash gate test file has the describe and the three exact test names', async () => {
  const f = path.join(ROOT, GATE);
  assert.ok(fs.existsSync(f), `${GATE} missing`);
  const src = fs.readFileSync(f, 'utf8');
  assert.match(src, /describe\(\s*['"`]runner\.crash['"`]/);
  for (const n of ['reattaches to a live agent after the worker is killed mid-step', 'marks the step start_unknown when the agent died with the worker', 'fails an attempt interrupted in the worktree or setup stage']) {
    assert.ok(new RegExp(`\\b(it|test)\\(\\s*['"\`]${n}['"\`]`).test(src), `test missing: ${n}`);
  }
});

await finish();
