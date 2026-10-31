// checks for T6.3 workflow engine (parse, walker, shell/if/approval/fanout/join, gates, handoff, continue, cleanup, log, eval files): one runnable example per
// decision id (D0..D26). Prints `PASS D# ...` or `FAIL D# expected=<..> got=<..>`; last line `CHECKS: <n> pass, <m> fail`; exit 1 on any FAIL.
// Needs: env CTC_SCRATCH_PG_URL (scratch Postgres 127.0.0.1:18304 only), git, /bin/sh, node, Linux /proc. Run from the repo root:
//   node --import tsx agent/t6-3-runner-gates/checks.mjs      (tsx lets Node import the .ts sources)
// Scratch schema `ctc_t63chk_<random>` (dropped at the end), throwaway git repos and a fake agent under os.tmpdir()/ctc-t63chk-*.
// The fake agent is a node script registered as `claude` through config.runner.agents; the real claude/codex never start. An in-memory queue runs
// `workflowHandlers` for every submitted job (3 at a time) like `runAttempt` would. Fixture values are this file's own.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(new URL('../../', import.meta.url).pathname);
const CORE_DIR = 'packages/core/src/runner'; const WORKER_DIR = 'apps/worker/src/runner'; const WEB_DIR = 'apps/web/src/runs';
const CORE = `${CORE_DIR}/index.ts`; const WORKER = `${WORKER_DIR}/index.ts`; const WEB = `${WEB_DIR}/index.ts`;
const REPOS = 'packages/shared/src/repositories/index.ts'; const ADMIN = 'packages/shared/src/repositories/admin/index.ts';
const QUEUES = 'packages/shared/src/queues/index.ts';
const IDS = Array.from({ length: 27 }, (_, i) => `D${i}`);
let pass = 0; let fail = 0;
const done = new Set();
const show = (v) => { if (typeof v === 'string') return v; try { return JSON.stringify(v); } catch { return '[unserializable]'; } };
function ok(id, msg) { pass++; done.add(id); console.log(`PASS ${id} ${msg}`); }
function bad(id, expected, got) { fail++; done.add(id); console.log(`FAIL ${id} expected=${show(expected)} got=${show(got)}`); }
async function check(id, msg, fn) {
  let timer;
  try {
    await Promise.race([fn(), new Promise((_, rej) => (timer = setTimeout(() => rej(new Error('check timed out after 150 s')), 150_000)))]);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20_000, every = 50) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`condition not met within ${ms} ms`); await sleep(every); }
}
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
const clone = (o) => JSON.parse(JSON.stringify(o));
const gitTracked = new Set(execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' }).split('\n'));
const newSources = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory() && e.name !== 'node_modules' && e.name !== 'fixtures') walk(p); else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) && e.name !== 'testing.ts' && !gitTracked.has(path.relative(ROOT, p))) out.push(p); } };
  if (fs.existsSync(path.join(ROOT, dir))) walk(path.join(ROOT, dir));
  return out.map((p) => [path.relative(ROOT, p), fs.readFileSync(p, 'utf8')]);
};

// ---- load -----------------------------------------------------------------------------------------------------------
const url = process.env.CTC_SCRATCH_PG_URL;
if (!url) await failAll('env CTC_SCRATCH_PG_URL not set');
const pu = new URL(url);
if (pu.hostname !== '127.0.0.1' || pu.port !== '18304') await failAll(`refusing ${pu.hostname}:${pu.port}, only the scratch Postgres 127.0.0.1:18304`);
if (!fs.existsSync('/proc/self/stat')) await failAll('Linux /proc not available');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
for (const rel of [CORE, WORKER, WEB]) if (!fs.existsSync(path.join(ROOT, rel))) await failAll(`module not built: ${rel} is missing`);
let C; let W; let X; let R; let A; let Q;
try { C = await load(CORE); W = await load(WORKER); X = await load(WEB); R = await load(REPOS); A = await load(ADMIN); Q = await load(QUEUES); } catch (e) { await failAll(`module not importable: ${e?.code ?? e?.name}: ${String(e?.message).split('\n')[0]}`); }
for (const [mod, names] of [[C, ['parseWorkflow', 'walkerNext', 'approveStep']], [W, ['workflowHandlers', 'advanceRun']], [X, ['workflowRoutes', 'workflowTools']]]) {
  for (const n of names) if (typeof mod[n] !== 'function') await failAll(`module not built: export ${n} is missing`);
}
const YAML = await import(pathToFileURL(createRequire(path.join(ROOT, 'packages/core/package.json')).resolve('yaml')).href);
const schema = `ctc_t63chk_${rnd()}`;
let db; let repos; let sql;
try {
  await A.migrate({ url, schema });
  db = R.createDb({ url, schema });
  repos = R.createRepositories(db);
  sql = (await import(pathToFileURL(createRequire(path.join(ROOT, 'packages/shared/package.json')).resolve('kysely')).href)).sql;
} catch (e) { await failAll(`scratch schema not built: ${e?.name}: ${e?.message}`); }

// ---- fixtures: temp dir, fake agent, git repos, harness -------------------------------------------------------------------
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t63chk-')));
const OUT = path.join(TMP, 'out'); const RUNS = path.join(TMP, 'runs');
fs.mkdirSync(OUT); fs.mkdirSync(RUNS);
process.env.CHK_OUT = OUT;
process.env.GIT_CONFIG_GLOBAL = '/dev/null'; process.env.GIT_CONFIG_SYSTEM = '/dev/null'; process.env.GIT_TERMINAL_PROMPT = '0'; // no git identity anywhere: the join must bring its own
const FAKE = path.join(TMP, 'fake-agent.mjs');
fs.writeFileSync(FAKE, `
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => main(Buffer.concat(chunks).toString()));
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (re, d) => (re.exec(stdinText) || [])[1] ?? d;
let stdinText = '';
async function main(stdin) {
  stdinText = stdin;
  const mode = pick(/CHK_MODE=(\\w+)/, 'ok'); const ms = Number(pick(/CHK_SLEEP=(\\d+)/, 0)); const say = pick(/CHK_SAY=([\\w-]+)/, 'done');
  const wr = /CHK_WRITE=([\\w.-]+):([\\w-]+)/.exec(stdin); const reset = Number(pick(/CHK_RESET=(\\d+)/, 1893456000));
  const snap = { start: Date.now(), argv: process.argv.slice(2), cwd: process.cwd(), stdin, envKeys: Object.keys(process.env) };
  const f = process.env.CHK_OUT + '/agent-' + process.env.CTC_STEP_ID + '-' + process.pid + '.json';
  const save = () => { fs.writeFileSync(f + '.tmp', JSON.stringify(snap)); fs.renameSync(f + '.tmp', f); };
  save();
  line({ type: 'system', subtype: 'init' });
  if (mode === 'fail') { process.stderr.write('boom\\n'); process.exit(3); }
  if (mode === 'quota_once') {
    const marker = process.env.CHK_OUT + '/quota-' + process.env.CTC_RUN_ID;
    if (!fs.existsSync(marker)) { fs.writeFileSync(marker, '1'); line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: reset } }); setInterval(() => {}, 1000); return; }
  }
  if (ms) await wait(ms);
  if (wr) {
    fs.writeFileSync(wr[1], wr[2] + '\\n');
    if (!/CHK_NOCOMMIT=1/.test(stdin)) { const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' }); g('add', '-A'); g('commit', '-q', '-m', 'agent'); }
  }
  snap.end = Date.now(); save();
  line({ type: 'assistant', message: { content: [{ type: 'text', text: say }] } });
  line({ type: 'result', subtype: 'success', is_error: false, result: say, usage: { input_tokens: 5, output_tokens: 7 }, total_cost_usd: 0.25 });
}
`);
const GITENV = { ...process.env };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GITENV, stdio: ['ignore', 'pipe', 'pipe'] });
function mkRepo({ ctcYaml } = {}) {
  const dir = path.join(TMP, `repo-${rnd()}`, 'r');
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  if (ctcYaml !== undefined) fs.writeFileSync(path.join(dir, 'ctc.yaml'), ctcYaml);
  git(dir, 'add', '-A'); git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  return dir;
}
const branchesOf = (repo) => git(repo, 'branch', '--list', 'ctc/*', '--format=%(refname:short)').split('\n').filter(Boolean);
const CFG = (over = {}) => ({
  runner: {
    max_failures: 3, max_visits: 3, worktree: { add_timeout_s: 30, dir: '.ctc/wt', keep_days: 7 }, setup: { timeout_s: 10, max_output_mb: 1, policy: 'run' },
    fanout: { max_depth: 1, max_parallel: 3 }, agents: { claude: { argv: [process.execPath, FAKE] }, codex: { argv: [process.execPath, FAKE, 'exec', '--json'] } }, ...over,
  },
});
const FAST_LIMITS = { tailPollMs: 50, statusPollMs: 100, killGraceMs: 300, reportExitGraceMs: 500, quotaExitGraceMs: 300, exitRecordGraceMs: 100 };
Object.assign(C.runnerExecLimits ?? {}, FAST_LIMITS);
if (W.engineLimits) Object.assign(W.engineLimits, { tickMs: 100, watchMs: 100 });
const LOGS = []; const WFS = new Map();
const ctxA = { userId: `u-a-${rnd()}` }; const ctxB = { userId: `u-b-${rnd()}` };
function mkH({ runner = {}, deps = {} } = {}) {
  const h = { queue: [], active: new Set(), submits: [], errors: [], ctx: ctxA };
  h.deps = {
    repos, config: CFG(runner), runsDir: RUNS, reportBase: 'http://127.0.0.1:18410',
    submit: async (i) => { Q.parsePayload(i.queue, i.kind, i.payload); h.submits.push(i); h.queue.push(i); return { id: i.id ?? `j-${rnd()}` }; },
    loadWorkflow: async (_c, run) => WFS.get(run.id) ?? null, log: (m, f) => { LOGS.push([m, f]); }, ...deps,
  };
  h.handlers = W.workflowHandlers(h.deps);
  return h;
}
function startJobs(h) {
  while (h.queue.length && h.active.size < 3) {
    const job = h.queue.shift();
    if (job.queue !== 'runner') continue;
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), (job.payload.timeoutS ?? 60) * 1000);
    const p = h.handlers['runner.step'](job.payload, { jobId: job.id, attempt: 1, signal: ac.signal, setProgress: async () => {} })
      .catch((e) => { h.errors.push(e); }).finally(() => { clearTimeout(t); h.active.delete(p); });
    h.active.add(p);
  }
}
const FINAL = ['done', 'failed', 'cancelled'];
async function drive(h, r, { ms = 60_000, stop, onPoll } = {}) {
  const end = Date.now() + ms;
  for (;;) {
    await W.advanceRun(h.deps, r.ctx, r.run.id);
    startJobs(h);
    const run = await repos.runner.getRun(r.ctx, r.run.id); const steps = await repos.runner.listSteps(r.ctx, r.run.id);
    onPoll?.(run, steps);
    if (stop && (await stop(run, steps))) return run;
    if (FINAL.includes(run.status) && h.active.size === 0 && h.queue.length === 0) return run;
    if (Date.now() > end) throw new Error(`drive timed out: run ${run.status}; steps ${steps.map((s) => `${s.nodeId}#${s.visit}.${s.attempt}:${s.status}`).join(' ')}; errors ${h.errors.map((e) => e?.message)}`);
    await sleep(60);
  }
}
async function mkRunFor(src, { ctx = ctxA, inputs = {}, repo, base = 'main', status = 'running', ctcYaml } = {}) {
  const parsed = C.parseWorkflow(src);
  assert.ok(parsed.ok, `workflow fixture invalid: ${JSON.stringify(parsed.errors)}`);
  const repoDir = repo === undefined ? mkRepo({ ctcYaml }) : repo;
  const run = await repos.runner.createRun(ctx, { owner: `o-${rnd()}`, trigger: 'api', status, inputs, repo: repoDir, baseBranch: base, state: {} });
  WFS.set(run.id, parsed.workflow);
  return { ctx, run, repo: repoDir, wf: parsed.workflow };
}
const stepsOf = (r) => repos.runner.listSteps(r.ctx, r.run.id);
const cur = (steps, nodeId) => steps.filter((s) => s.nodeId === nodeId).sort((a, b) => b.visit - a.visit || b.attempt - a.attempt)[0];
const snaps = () => fs.readdirSync(OUT).filter((f) => f.startsWith('agent-') && f.endsWith('.json')).map((f) => ({ stepId: Number(f.split('-')[1]), ...JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')) }));
const snapOf = (step) => { const s = snaps().filter((x) => x.stepId === step.id); assert.equal(s.length >= 1, true, `agent snapshot of step ${step.id}`); return s[s.length - 1]; };
const payloadOf = (ctx, s, timeoutS = 60) => ({ userId: ctx.userId, runId: String(s.runId), stepId: String(s.id), nodeId: s.nodeId, visit: s.visit, attempt: s.attempt, timeoutS });
const enqueueFor = (h) => async (ctx, step) => { await h.deps.submit({ queue: 'runner', kind: 'step', id: C.runnerJobId(step), payload: payloadOf(ctx, step) }); };

// workflow builders (plain objects, snake_case like a file)
const T = { id: 't', type: 'trigger' };
const sh = (id, run, o = {}) => ({ id, type: 'shell', run, cwd: 'repo', ...o });
const ag = (id, prompt, o = {}) => ({ id, type: 'agent', agent: 'claude', prompt, ...o });
const chain = (...ids) => ids.slice(1).map((to, i) => ({ from: ids[i], to }));
const wf = (nodes, edges, o = {}) => ({ name: o.name ?? 'wf', nodes: [T, ...nodes], edges, ...o });

// route caller
const mkWdeps = (h, over = {}) => ({ repos, runsDir: RUNS, ctxOf: (req) => req?.who ?? ctxA, enqueueStep: enqueueFor(h), enqueueResume: async (ctx, step, jobId) => { await h.deps.submit({ queue: 'runner', kind: 'step', id: jobId, payload: payloadOf(ctx, step) }); }, library: { repos, config: { mode: 'local', claude_home: TMP, library: { roots: [], default_label: 'production' } }, submit: async () => ({ id: 'x' }) }, ownerOf: () => `o-${rnd()}`, ...over });
async function call(routes, method, urlTemplate, { params = {}, body, headers = {}, query = {}, who } = {}) {
  const route = routes.find((r) => r.method === method && r.url === urlTemplate);
  assert.ok(route, `route ${method} ${urlTemplate} exists`);
  let sent; let status;
  const reply = { code(n) { status = n; return { send(b) { sent = b; return undefined; } }; }, header() { return reply; } };
  await route.handler({ params, body, headers, query, who }, reply);
  return { status, body: sent };
}
async function mkCap(ctx, name, doc, { kind = 'workflow' } = {}) {
  const text = typeof doc === 'string' ? doc : JSON.stringify(doc);
  const hash = rnd() + rnd() + name;
  const { version } = await repos.library.createVersion(ctx, { namespace: 'user', kind, name, rootPath: `/nonexistent-t63/${name}`, description: `d ${name}`, frontmatter: { name }, bodyHash: hash, commitMessage: 'x', blobs: [{ hash, content: text, size: Buffer.byteLength(text) }], files: [{ path: `${name}.yaml`, blobHash: hash }] });
  const cap = (await repos.library.listCapabilities(ctx, { kind })).rows.find((c) => c.name === name);
  return { cap, version };
}
async function viaLibrary(ctx, run) {
  if (!run.workflowCapId) return null;
  const v = await repos.library.getVersion(ctx, run.workflowCapId, run.workflowVersion); if (!v) return null;
  const man = await repos.library.manifest(ctx, v.id); const text = await repos.library.getBlob(ctx, v.id, man[0].path);
  const r = C.parseWorkflow(text); return r.ok ? r.workflow : null;
}
const readAll = async (stream) => { const chunks = []; for await (const c of stream) chunks.push(Buffer.from(c)); return Buffer.concat(chunks).toString('utf8'); };
cleanup = async () => {
  try {
    const rows = await db.kysely.selectFrom('wf_steps').select('pid').where('pid', 'is not', null).execute();
    for (const { pid } of rows) { try { if (fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(TMP)) process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
  } catch { /* schema gone */ }
  try { await db.kysely.schema.dropSchema(schema).ifExists().cascade().execute(); } finally { await db.close(); }
  fs.rmSync(TMP, { recursive: true, force: true });
};

// ---- D0 purpose and callers ---------------------------------------------------------------------------------------------
await check('D0', 'exports exist; handlers keyed exactly; 8 workflow routes + 2 tools; T6.1 runsRoutes still 4; a shell chain runs end to end and calls nothing else', async () => {
  for (const n of ['NODE_TYPES', 'workflowLimits', 'parseWorkflow', 'renderTemplate', 'evalCondition', 'scopeOf', 'outText', 'planFanout', 'childId', 'parseChildId', 'walkerStart', 'walkerNext', 'walkerComplete', 'walkerStatus', 'isReadonlyNode', 'deriveRunStatus', 'approveStep', 'continueRun', 'REJECT_OPTION']) assert.ok(n in C, `core export ${n}`);
  assert.equal(C.REJECT_OPTION, 'reject');
  for (const n of ['workflowHandlers', 'advanceRun', 'tickRuns', 'startRunnerLoop', 'cleanupHandlers', 'scheduleCleanup', 'engineLimits']) assert.ok(n in W, `worker export ${n}`);
  for (const n of ['workflowRoutes', 'workflowTools', 'startRun', 'runJson', 'stepDetailJson', 'startLimits', 'handoffLimits', 'runsRoutes']) assert.ok(n in X, `web export ${n}`);
  const h = mkH();
  assert.deepEqual(Object.keys(h.handlers), ['runner.step']);
  assert.deepEqual(Object.keys(W.cleanupHandlers(h.deps)).sort(), ['cleanup.receipts', 'cleanup.worktree']);
  const routes = X.workflowRoutes(mkWdeps(h));
  assert.deepEqual(routes.map((r) => `${r.method} ${r.url}`).sort(), ['GET /api/runs', 'GET /api/runs/:rid', 'GET /api/runs/:rid/steps/:sid/log', 'GET /api/workflows', 'GET /api/workflows/:id', 'POST /api/runs/:rid/approve', 'POST /api/runs/:rid/continue', 'POST /api/workflows/:id/runs']);
  assert.deepEqual(X.workflowTools(mkWdeps(h)).map((t) => t.name).sort(), ['run_workflow', 'workflow_status']);
  assert.equal(X.runsRoutes({ repos }).length, 4);
  const r = await mkRunFor(wf([sh('a', 'echo one'), sh('b', 'echo two')], chain('t', 'a', 'b')));
  const run = await drive(h, r);
  assert.equal(run.status, 'done');
  assert.deepEqual((await stepsOf(r)).map((s) => s.nodeId).sort(), ['a', 'b']);
  assert.equal(h.errors.length, 0);
});

// ---- D1 trust -------------------------------------------------------------------------------------------------------------
await check('D1', 'other user sees nothing; input text never reaches the shell unquoted; shell env has no CTC_ secrets but CTC_WORKTREE_PATH/ROOT_PATH', async () => {
  const h = mkH();
  const repo = mkRepo();
  process.env.CTC_DATABASE_URL = 'postgres://secret'; // must not reach the shell
  const r = await mkRunFor(wf([sh('a', 'echo {{input.x}} > out.txt; env > env.txt')], chain('t', 'a')), { repo, inputs: { x: 'a; touch PWNED' } });
  const run = await drive(h, r);
  delete process.env.CTC_DATABASE_URL;
  assert.equal(run.status, 'done');
  assert.equal(fs.existsSync(path.join(repo, 'PWNED')), false, 'injected command ran');
  assert.equal(fs.readFileSync(path.join(repo, 'out.txt'), 'utf8').trim(), 'a; touch PWNED');
  const env = fs.readFileSync(path.join(repo, 'env.txt'), 'utf8');
  assert.equal(/^CTC_DATABASE_URL=/m.test(env), false, 'worker secret leaked to shell');
  assert.ok(/^CTC_ROOT_PATH=/m.test(env) && /^CTC_WORKTREE_PATH=/m.test(env) && /^CTC_RUN_ID=/m.test(env) && /^CTC_STEP_ID=/m.test(env), 'step env variables');
  assert.equal(/^CTC_STEP_TOKEN=/m.test(env), false);
  assert.deepEqual(await W.advanceRun(h.deps, ctxB, r.run.id), { status: null, started: [], skipped: [] });
  const routes = X.workflowRoutes(mkWdeps(h));
  assert.equal((await call(routes, 'GET', '/api/runs/:rid', { params: { rid: String(r.run.id) }, who: ctxB })).status, 404);
  const s = (await stepsOf(r))[0];
  assert.equal((await call(routes, 'POST', '/api/runs/:rid/approve', { params: { rid: String(r.run.id) }, body: { step_id: s.id, option_id: 'approve' }, who: ctxB })).status, 404);
});

// ---- D2 limits ------------------------------------------------------------------------------------------------------------
await check('D2', 'workflowLimits/engineLimits/startLimits/handoffLimits defaults pinned; 200 nodes valid and 201 an error; fanout items 20 valid, 21 an error; read at call time', async () => {
  const L = C.workflowLimits;
  for (const [k, v] of Object.entries({ maxNodes: 200, maxEdges: 1000, idMax: 64, textMax: 20000, fanoutItemsMax: 20, fanoutParallelMax: 3, itemMax: 2000, defaultMaxVisits: 3, shellTimeoutS: 600, outTailChars: 4000 })) assert.equal(L[k], v, `workflowLimits.${k}`);
  assert.equal(X.startLimits.repoMax, 4096); assert.equal(X.startLimits.baseMax, 200); assert.equal(X.startLimits.inputsMaxBytes, 65536);
  assert.equal(X.handoffLimits.waitMs, 8000); assert.equal(X.handoffLimits.pollMs, 100);
  assert.equal(W.engineLimits.maxRounds, 1000); assert.equal(W.engineLimits.shellOutputMaxBytes, 10485760); assert.equal(W.engineLimits.mergeTimeoutS, 600);
  const many = (n) => { const nodes = Array.from({ length: n - 1 }, (_, i) => sh(`n${i}`, 'true')); return wf(nodes, chain('t', ...nodes.map((x) => x.id))); };
  assert.equal(C.parseWorkflow(many(200)).ok, true, '200 nodes');
  const r201 = C.parseWorkflow(many(201));
  assert.equal(r201.ok, false); assert.ok(r201.errors.includes('workflow has too many nodes'), r201.errors?.join('|'));
  const F = { id: 'f', type: 'fanout', over: '{{input.l}}', child: { type: 'agent', agent: 'claude', prompt: 'p' } };
  const items = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => `i${i}`));
  assert.equal(C.planFanout(F, { 'input.l': items(20) }).ok, true);
  const over = C.planFanout(F, { 'input.l': items(21) });
  assert.deepEqual(over, { ok: false, error: 'fanout: 21 items exceeds 20' });
  const keep = L.fanoutItemsMax; L.fanoutItemsMax = 2;
  try { assert.equal(C.planFanout(F, { 'input.l': items(2) }).ok, true); assert.equal(C.planFanout(F, { 'input.l': items(3) }).ok, false); } finally { L.fanoutItemsMax = keep; }
  const longItem = C.planFanout(F, { 'input.l': JSON.stringify(['x'.repeat(2001)]) });
  assert.deepEqual(longItem, { ok: false, error: 'fanout: bad items' });
  assert.equal(C.planFanout(F, { 'input.l': JSON.stringify(['x'.repeat(2000)]) }).ok, true);
});

// ---- D3 output and error format -------------------------------------------------------------------------------------------
await check('D3', 'handler result {stepId,status,skipped}; advanceRun/tickRuns shapes; every job payload valid; 202 {run_id,status}; error body {error:{code,message}}; GET run has steps with options', async () => {
  const h = mkH();
  const parsed = C.parseWorkflow({ name: 'p', nodes: [T], edges: [] });
  assert.equal(parsed.ok, true); assert.deepEqual(Object.keys(parsed.workflow).sort(), ['description', 'edges', 'inputs', 'maxVisits', 'name', 'nodes']);
  assert.deepEqual(Object.keys(C.parseWorkflow(null)).sort(), ['errors', 'ok']);
  const r = await mkRunFor(wf([sh('a', 'echo hi')], chain('t', 'a')));
  const first = await W.advanceRun(h.deps, r.ctx, r.run.id);
  assert.deepEqual(Object.keys(first).sort(), ['skipped', 'started', 'status']);
  assert.deepEqual(first.started, ['a']); assert.equal(first.status, 'running');
  const job = h.queue.shift();
  const res = await h.handlers['runner.step'](job.payload, { jobId: job.id, attempt: 1, signal: new AbortController().signal, setProgress: async () => {} });
  assert.deepEqual(Object.keys(res).sort(), ['skipped', 'status', 'stepId']); assert.equal(res.status, 'done'); assert.equal(res.skipped, false);
  assert.deepEqual(JSON.parse(JSON.stringify(res)), res);
  assert.equal(job.queue, 'runner'); assert.equal(job.kind, 'step'); assert.equal(job.id, C.runnerJobId({ runId: r.run.id, nodeId: 'a', visit: 1, attempt: 1 }));
  const tick = await W.tickRuns(h.deps);
  assert.deepEqual(Object.keys(tick), ['advanced']); assert.ok(Array.isArray(tick.advanced));
  const routes = X.workflowRoutes(mkWdeps(h));
  const nf = await call(routes, 'GET', '/api/runs/:rid', { params: { rid: '999999999' } });
  assert.equal(nf.status, 404); assert.deepEqual(Object.keys(nf.body), ['error']); assert.equal(nf.body.error.code, 'not_found'); assert.equal(typeof nf.body.error.message, 'string');
  const g = await mkRunFor(wf([{ id: 'gate', type: 'approval', question: 'ok?' }], chain('t', 'gate')));
  await drive(h, g, { stop: async (run) => run.status === 'waiting' });
  const one = await call(routes, 'GET', '/api/runs/:rid', { params: { rid: String(g.run.id) } });
  assert.equal(one.status, 200); assert.equal(one.body.run.id, g.run.id); assert.equal(one.body.steps.length, 1);
  const st = one.body.steps[0];
  assert.deepEqual(st.options, [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }]);
  for (const k of ['tokenHash', 'pid', 'pidStartedAt', 'logPath']) assert.equal(k in st, false, `step json leaks ${k}`);
  for (const k of ['worktree', 'branch', 'usage', 'costUsd', 'options', 'status', 'stage', 'resolution']) assert.ok(k in st, `step json has ${k}`);
  const list = await call(routes, 'GET', '/api/runs', {});
  assert.equal(list.status, 200); assert.ok(Array.isArray(list.body.runs)); assert.ok('next' in list.body);
  assert.deepEqual(JSON.parse(JSON.stringify(one.body)), one.body);
});

// ---- D4 bad input ---------------------------------------------------------------------------------------------------------
await check('D4', 'route order params 404 -> header 422 -> body 422 -> state 409; pure functions never throw on junk', async () => {
  const h = mkH(); const routes = X.workflowRoutes(mkWdeps(h));
  const g = await mkRunFor(wf([{ id: 'gate', type: 'approval', question: 'ok?' }], chain('t', 'gate')));
  await drive(h, g, { stop: async (run) => run.status === 'waiting' });
  const gate = cur(await stepsOf(g), 'gate'); const rid = String(g.run.id);
  assert.equal((await call(routes, 'POST', '/api/runs/:rid/approve', { params: { rid: 'abc' }, body: { step_id: gate.id, option_id: 'approve' } })).status, 404);
  assert.equal((await call(routes, 'POST', '/api/runs/:rid/approve', { params: { rid }, body: { step_id: 999999999, option_id: 'approve' } })).status, 404);
  const hdr = await call(routes, 'POST', '/api/runs/:rid/approve', { params: { rid }, body: { step_id: gate.id, option_id: 'approve' }, headers: { 'idempotency-key': 'has space' } });
  assert.equal(hdr.status, 422); assert.deepEqual(hdr.body.error.path, ['headers', 'idempotency-key']);
  const nob = await call(routes, 'POST', '/api/runs/:rid/approve', { params: { rid }, body: { step_id: gate.id } });
  assert.equal(nob.status, 422); assert.deepEqual(nob.body.error.path.slice(0, 2), ['body', 'option_id']);
  const extra = await call(routes, 'POST', '/api/runs/:rid/approve', { params: { rid }, body: { step_id: gate.id, option_id: 'approve', userId: 'x' } });
  assert.equal(extra.status, 422);
  const bogus = await call(routes, 'POST', '/api/runs/:rid/approve', { params: { rid }, body: { step_id: gate.id, option_id: 'nope' } });
  assert.equal(bogus.status, 422); assert.deepEqual(bogus.body.error.path, ['body', 'option_id']);
  const circ = {}; circ.self = circ;
  for (const junk of [null, undefined, 5, true, [], '', 'x: [', '{', { nodes: 'no' }, { nodes: [null, 5, 'x'] }, { nodes: [T], edges: 5 }, circ]) {
    const res = C.parseWorkflow(junk); assert.equal(res.ok, false, `junk ${show(junk)?.slice(0, 20)}`); assert.ok(res.errors.every((e) => typeof e === 'string') && res.errors.length >= 1);
  }
  assert.equal(C.renderTemplate(5, {}).text, ''); assert.equal(C.renderTemplate(null, null).text, '');
  assert.equal(C.evalCondition('zzz', 'a', 'a'), false); assert.equal(C.evalCondition(undefined, 5, {}), false);
  assert.equal(C.planFanout(null, {}).ok, false); assert.equal(C.planFanout({ over: {} }, {}).ok, false);
  const w = C.parseWorkflow(wf([sh('a', 'true')], chain('t', 'a'))).workflow;
  const bad = C.walkerComplete(w, C.walkerStart(w), 'ghost', { ok: true });
  assert.equal(typeof bad.error, 'string'); assert.doesNotThrow(() => C.walkerComplete(w, {}, 'a', null)); assert.doesNotThrow(() => C.walkerNext(w, null));
  const run = await repos.runner.getRun(g.ctx, g.run.id);
  assert.equal(run.status, 'waiting');
});

// ---- D5 odd but harmless --------------------------------------------------------------------------------------------------
await check('D5', 'extra keys, unreachable node, CRLF YAML and JSON text, missing template variable, empty fanout list, if without right are all fine', async () => {
  const doc = { name: 'odd', extra: { a: 1 }, nodes: [T, { ...sh('a', 'true'), colour: 'red' }, sh('orphan', 'true'), { id: 'i', type: 'if', op: 'truthy', left: '1' }], edges: [{ from: 't', to: 'a' }, { from: 'a', to: 'i' }], zzz: 1 };
  const res = C.parseWorkflow(doc); assert.equal(res.ok, true, JSON.stringify(res.errors));
  const yamlText = 'name: crlf\r\nnodes:\r\n  - {id: t, type: trigger}\r\n  - {id: a, type: shell, run: "echo hi", cwd: repo}\r\nedges:\r\n  - {from: t, to: a}\r\n';
  assert.equal(C.parseWorkflow(yamlText).ok, true); assert.equal(C.parseWorkflow(JSON.stringify(doc)).ok, true);
  assert.equal(res.workflow.nodes.find((n) => n.id === 'i').right, '');
  assert.deepEqual(C.renderTemplate('a{{ nope.x }}b{{nope.x}}', {}), { text: 'ab', missing: ['nope.x'] });
  assert.deepEqual(C.planFanout({ id: 'f', over: '[]' }, {}), { ok: true, items: [] });
  const h = mkH();
  const r = await mkRunFor(wf([{ id: 'f', type: 'fanout', over: '{{input.list}}', child: { type: 'agent', agent: 'claude', prompt: 'x' } }, { id: 'j', type: 'join', strategy: 'collect' }], chain('t', 'f', 'j')), { inputs: { list: [] } });
  const run = await drive(h, r);
  assert.equal(run.status, 'done');
  const steps = await stepsOf(r);
  assert.equal(cur(steps, 'f').status, 'done'); assert.equal(cur(steps, 'f').output.total, 0); assert.deepEqual(cur(steps, 'j').output.results, []);
  assert.equal(steps.filter((s) => s.parentStepId !== null).length, 0);
});

// ---- D6 must never --------------------------------------------------------------------------------------------------------
await check('D6', 'sources: no .transition(, setRunStatus( only in core/runstate.ts, no forced/destructive git word, no pg/kysely/bullmq/ioredis; advanceRun x4 at once makes one row; inputs stay frozen', async () => {
  const files = [...newSources(CORE_DIR), ...newSources(WORKER_DIR), ...newSources(WEB_DIR)];
  assert.ok(files.length >= 6, `new source files found: ${files.length}`);
  const offenders = [];
  for (const [f, src] of files) {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    if (/\.transition\(/.test(code)) offenders.push(`${f}: .transition(`);
    if (/setRunStatus\(/.test(code) && !f.startsWith(CORE_DIR) && !f.endsWith('/runstate.ts')) offenders.push(`${f}: setRunStatus(`);
    if (/from ['"](pg|kysely|bullmq|ioredis)['"]/.test(code)) offenders.push(`${f}: forbidden import`);
    if (/homedir\(|['"]\.claude['"]|\.claudethecaller/.test(code)) offenders.push(`${f}: home path`);
    if (f.startsWith(WORKER_DIR)) {
      for (const w of ["'--force'", "'-f'", "'-B'", "'-D'", "'reset'", "'clean'", "'checkout'", "'rebase'", "'stash'", "'push'"]) if (code.includes(w)) offenders.push(`${f}: git word ${w}`);
      if (/['"]remove['"]/.test(code) && !f.endsWith('/cleanup.ts')) offenders.push(`${f}: 'remove' outside cleanup.ts`);
    }
  }
  assert.deepEqual(offenders, []);
  const h = mkH();
  const r = await mkRunFor(wf([sh('a', 'echo hi'), sh('b', 'echo hi')], chain('t', 'a', 'b')));
  await Promise.all([1, 2, 3, 4].map(() => W.advanceRun(h.deps, r.ctx, r.run.id)));
  const steps = await stepsOf(r);
  assert.equal(steps.length, 1, 'one row for node a after 4 parallel advances');
  assert.equal(new Set(h.submits.map((s) => s.id)).size, 1);
  const frozen = deepFreeze(clone(C.parseWorkflow(wf([sh('a', 'true')], chain('t', 'a'))).workflow));
  const st = deepFreeze(clone(C.walkerStart(frozen)));
  const nx = C.walkerNext(frozen, st); assert.deepEqual(nx.start, [{ nodeId: 'a', visit: 1 }]);
  C.walkerComplete(frozen, deepFreeze(clone(nx.state)), 'a', { ok: true });
  assert.equal(C.parseWorkflow(deepFreeze({ name: 'x', nodes: [T], edges: [] })).ok, true);
});

// ---- D7 non-goals ---------------------------------------------------------------------------------------------------------
await check('D7', 'no schedule code, no nested fanout, only claude/codex agents, push needs approval, no /api/schedules route', async () => {
  for (const [f, src] of [...newSources(CORE_DIR), ...newSources(WORKER_DIR), ...newSources(WEB_DIR)]) assert.equal(/wf_schedules|upsertSchedule|listSchedules|deleteSchedule/.test(src), false, `${f} touches schedules`);
  const routes = X.workflowRoutes(mkWdeps(mkH()));
  assert.equal(routes.some((r) => r.url.includes('schedule')), false);
  const agent3 = C.parseWorkflow(wf([ag('a', 'x', { agent: 'gemini' })], chain('t', 'a')));
  assert.equal(agent3.ok, false); assert.ok(agent3.errors.includes('node a: unknown agent "gemini"'), agent3.errors?.join('|'));
  const nested = C.parseWorkflow(wf([{ id: 'f', type: 'fanout', over: '2', child: { type: 'fanout', over: '2', child: { type: 'agent', agent: 'claude', prompt: 'p' } } }], chain('t', 'f')));
  assert.equal(nested.ok, false);
});

// ---- D8 silence rule ------------------------------------------------------------------------------------------------------
await check('D8', 'the new sources carry judgment: comments where the list is silent', async () => {
  const n = [...newSources(CORE_DIR), ...newSources(WORKER_DIR), ...newSources(WEB_DIR)].reduce((c, [, s]) => c + (s.match(/judgment:/g) ?? []).length, 0);
  assert.ok(n >= 6, `judgment: comments: ${n}`);
});

// ---- D9 layout ------------------------------------------------------------------------------------------------------------
await check('D9', 'named files exist; engine deps accepted without resolveNode/onStepEnd; system.listActiveRuns exists; schemas module present', async () => {
  const want = [`${CORE_DIR}/workflow.ts`, `${CORE_DIR}/walker.ts`, `${CORE_DIR}/gates.ts`, ...['engine', 'shell', 'join', 'fanout', 'cleanup', 'runstate'].map((n) => `${WORKER_DIR}/${n}.ts`), ...['workflows', 'start', 'tools'].map((n) => `${WEB_DIR}/${n}.ts`), 'packages/shared/src/schemas/workflows/index.ts'];
  assert.deepEqual(want.filter((f) => !fs.existsSync(path.join(ROOT, f))), []);
  const h = mkH({ deps: {} });
  assert.equal(typeof h.handlers['runner.step'], 'function');
  assert.equal(typeof repos.system.runner.listActiveRuns, 'function');
  const loop = W.startRunnerLoop(h.deps); assert.equal(typeof loop.stop, 'function'); await loop.stop();
  assert.equal(typeof (await W.scheduleCleanup(h.deps)).submitted, 'number');
});

// ---- D10 workflow format --------------------------------------------------------------------------------------------------
await check('D10', 'node types, defaults, exact error texts, push guard on every path, depth, join rule, handles, YAML = JSON', async () => {
  const full = {
    name: 'full', description: 'd', max_visits: 5,
    nodes: [T, ag('a', 'do it'), sh('s', 'echo hi'), { id: 'i', type: 'if', op: 'eq', left: 'a', right: 'b' }, { id: 'g', type: 'approval', question: 'q' }, { id: 'm', type: 'merge' },
      { id: 'f', type: 'fanout', over: 3, child: { type: 'agent', agent: 'claude', prompt: 'p' } }, { id: 'j', type: 'join' }],
    edges: [{ from: 't', to: 'a' }, { from: 'a', to: 's' }, { from: 's', to: 'i' }, { from: 'i', to: 'g', handle: true }, { from: 'i', to: 'm', handle: 'false' }, { from: 'g', to: 'm' }, { from: 'm', to: 'f' }, { from: 'f', to: 'j' }],
  };
  const ok1 = C.parseWorkflow(full); assert.equal(ok1.ok, true, JSON.stringify(ok1.errors));
  const w = ok1.workflow; const n = (id) => w.nodes.find((x) => x.id === id);
  assert.equal(w.maxVisits, 5);
  assert.deepEqual([n('a').worktree, n('a').permission, n('a').timeoutS, n('a').model, n('a').base], ['new', 'acceptEdits', 1800, null, null]);
  assert.deepEqual([n('s').cwd, n('s').timeoutS], ['repo', 600]);
  assert.deepEqual(n('g').options, [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }]);
  assert.deepEqual([n('f').maxParallel, n('j').strategy], [3, 'merge']);
  assert.deepEqual(w.edges.filter((e) => e.from === 'i').map((e) => e.handle), ['true', 'false']);
  assert.equal(C.parseWorkflow(wf([sh('a', 'true')], chain('t', 'a'))).workflow.maxVisits, 3);
  assert.deepEqual(C.parseWorkflow(JSON.stringify(full)).workflow, w);
  assert.deepEqual(C.parseWorkflow((YAML.default ?? YAML).stringify(full)).workflow, w);
  const errs = (src) => { const r = C.parseWorkflow(src); assert.equal(r.ok, false, 'expected invalid'); return r.errors; };
  const e = (nodes, edges = [], extra = {}) => errs({ name: 'x', nodes: [T, ...nodes], edges, ...extra });
  assert.ok(e([ag('a', 'p', { permission: 'bypassPermissions' })]).includes('node a: permission "bypassPermissions" is not allowed'));
  assert.ok(e([ag('a', 'p', { permission: 'root' })]).includes('node a: permission "root" is not allowed'));
  assert.ok(errs({ name: 'x', nodes: [T, { ...T, id: 't2' }], edges: [] }).includes('workflow needs exactly one trigger'));
  assert.ok(errs({ name: 'x', nodes: [], edges: [] }).includes('workflow needs exactly one trigger'));
  assert.ok(e([sh('bad id', 'true')]).includes('node bad id: invalid id'));
  assert.ok(e([sh('input', 'true')]).includes('node input: invalid id'));
  assert.ok(e([sh('a', 'true'), sh('a', 'true')]).includes('node a: duplicate id'));
  assert.ok(e([{ id: 'a', type: 'wizard' }]).includes('node a: unknown type "wizard"'));
  assert.ok(e([{ id: 'a', type: 'shell' }]).includes('node a: run is required'));
  assert.ok(e([sh('a', 'true')], [{ from: 't', to: 'zz' }]).includes('edge 0: unknown node "zz"'));
  assert.ok(e([{ id: 'i', type: 'if', op: 'eq', left: 'a' }, sh('a', 'true')], [{ from: 'i', to: 'a', handle: 'maybe' }]).includes('edge 0: invalid handle "maybe"'));
  assert.ok(e([{ id: 'f', type: 'fanout', over: '2', max_parallel: 4, child: { type: 'agent', agent: 'claude', prompt: 'p' } }]).includes('node f: max_parallel must be 1 to 3'));
  assert.ok(e([{ id: 'f', type: 'fanout', over: '2', child: { type: 'fanout', over: '2', child: { type: 'agent', agent: 'claude', prompt: 'p' } } }]).includes('node f: fanout depth exceeded (max_depth 1)'));
  assert.ok(e([{ id: 'f', type: 'fanout', over: '2', child: { type: 'agent', agent: 'claude', prompt: 'p', worktree: 'parent' } }]).includes('node f: fanout child must use worktree new'));
  assert.ok(e([{ id: 'g', type: 'approval', question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }]).includes('node g: options must be 1 to 8 entries with unique ids'));
  assert.ok(e([{ id: 'j', type: 'join' }, sh('a', 'true')], [{ from: 't', to: 'j' }]).includes('join j: needs exactly one incoming edge, from a fanout node'));
  const push = (id) => `node ${id}: git push or gh pr needs an approval node on every path before it`;
  assert.ok(e([sh('p', 'git push origin main')], chain('t', 'p')).includes(push('p')));
  assert.ok(e([ag('p', 'then run gh pr create now')], chain('t', 'p')).includes(push('p')));
  assert.ok(e([{ id: 'f', type: 'fanout', over: '2', child: { type: 'agent', agent: 'claude', prompt: 'git push it' } }], chain('t', 'f')).some((x) => x.includes('git push or gh pr needs')));
  assert.equal(C.parseWorkflow(wf([{ id: 'g', type: 'approval', question: 'push?' }, sh('p', 'git push origin main')], chain('t', 'g', 'p'))).ok, true);
  const twoPaths = e([{ id: 'g', type: 'approval', question: 'q' }, sh('x', 'true'), sh('p', 'git push')], [{ from: 't', to: 'g' }, { from: 't', to: 'x' }, { from: 'g', to: 'p' }, { from: 'x', to: 'p' }]);
  assert.ok(twoPaths.includes(push('p')), 'a path that avoids the approval must still be an error');
  assert.equal(C.parseWorkflow({ name: 'x', nodes: [T, ag('a', 'git status')], edges: chain('t', 'a') }).ok, true);
});

// ---- D11 templates and conditions ----------------------------------------------------------------------------------------
await check('D11', 'renderTemplate (missing, prototype keys, no rescan, shell quoting), scopeOf, outText, evalCondition', async () => {
  assert.deepEqual(C.renderTemplate('x {{ a.b }} y {{c}}', { 'a.b': 'AB', c: 7 }), { text: 'x AB y 7', missing: [] });
  assert.deepEqual(C.renderTemplate('{{constructor}}{{__proto__}}{{toString}}', {}), { text: '', missing: ['constructor', '__proto__', 'toString'] });
  assert.equal(C.renderTemplate('{{a}}', { a: '{{b}}', b: 'no' }).text, '{{b}}');
  assert.deepEqual(C.renderTemplate('echo {{a}} {{gone}}!', { a: "it's" }, { shell: true }), { text: "echo 'it'\\''s' ''!", missing: ['gone'] });
  assert.equal(C.renderTemplate('{{a}}', { a: '$(rm -rf /); `x`' }, { shell: true }).text, "'$(rm -rf /); `x`'");
  const scope = C.scopeOf({ inputs: { topic: 'widgets', n: 3, list: ['a', 'b'] }, outputs: { plan: { out: 'P', exit: 0 } }, resolution: 'merge', item: 'it', index: 2 });
  assert.deepEqual(scope, { 'input.topic': 'widgets', 'input.n': '3', 'input.list': '["a","b"]', 'plan.out': 'P', 'plan.exit': '0', resolution: 'merge', item: 'it', index: '2' }, show(scope));
  assert.equal(Object.hasOwn(C.scopeOf({ inputs: {}, outputs: {} }), 'resolution'), false);
  assert.equal(C.outText({ type: 'agent' }, { summary: 'S' }), 'S'); assert.equal(C.outText({ type: 'agent' }, null), '');
  assert.equal(C.outText({ type: 'shell' }, { stdoutTail: 'T\n' }), 'T\n'); assert.equal(C.outText({ type: 'approval' }, { choice: 'merge' }), 'merge');
  assert.equal(C.outText({ type: 'if' }, { handle: 'false' }), 'false');
  assert.equal(C.outText({ type: 'join', strategy: 'collect' }, { results: ['a', 'b'] }), '["a","b"]');
  assert.equal(C.outText({ type: 'join', strategy: 'merge' }, { summary: 'merged 3 branches' }), 'merged 3 branches');
  for (const [op, l, r, want] of [['eq', ' a ', 'a', true], ['eq', 'a', 'b', false], ['ne', 'a', 'b', true], ['contains', 'hello world', 'lo w', true], ['contains', 'a', 'b', false], ['truthy', 'yes', '', true], ['truthy', ' FALSE ', '', false], ['truthy', '0', '', false], ['truthy', '', '', false], ['truthy', 'No', '', false], ['truthy', 'null', '', false], ['truthy', '1', '', true], ['bogus', 'a', 'a', false]]) assert.equal(C.evalCondition(op, l, r), want, `${op} ${l} ${r}`);
  assert.deepEqual(C.planFanout({ id: 'f', over: 3 }, {}), { ok: true, items: ['1', '2', '3'] });
  assert.deepEqual(C.planFanout({ id: 'f', over: '2' }, {}), { ok: true, items: ['1', '2'] });
  assert.deepEqual(C.planFanout({ id: 'f', over: '{{l}}' }, { l: 'a\n\n  b \n' }), { ok: true, items: ['a', 'b'] });
  assert.deepEqual(C.planFanout({ id: 'f', over: '{{l}}' }, { l: '["a",{"k":1}]' }), { ok: true, items: ['a', '{"k":1}'] });
  assert.equal(C.childId('f', 0), 'f[0]'); assert.deepEqual(C.parseChildId('f[12]'), { fanoutId: 'f', index: 12 }); assert.equal(C.parseChildId('f'), null);
});

// ---- D12 walker -----------------------------------------------------------------------------------------------------------
await check('D12', 'linear, if/else with skip, readonly batch then one writer, merge waits, loop re-entry and max_visits, failure stops, status', async () => {
  const P = (nodes, edges, o) => { const r = C.parseWorkflow(wf(nodes, edges, o)); assert.ok(r.ok, JSON.stringify(r.errors)); return deepFreeze(r.workflow); };
  const step = (w, s) => C.walkerNext(w, deepFreeze(clone(s)));
  const done = (w, s, id, r = { ok: true }) => C.walkerComplete(w, deepFreeze(clone(s)), id, r);
  // linear
  let w = P([sh('a', 'true'), sh('b', 'true')], chain('t', 'a', 'b'));
  let s = C.walkerStart(w); assert.deepEqual(JSON.parse(JSON.stringify(s)), s); assert.equal(C.walkerStatus(w, s), 'running');
  let n = step(w, s); assert.deepEqual(n.start, [{ nodeId: 'a', visit: 1 }]); assert.deepEqual(n.skip, []);
  assert.deepEqual(step(w, n.state).start, [], 'a is running: nothing else starts');
  let c = done(w, n.state, 'a'); assert.equal(c.error, null); n = step(w, c.state); assert.deepEqual(n.start, [{ nodeId: 'b', visit: 1 }]);
  c = done(w, n.state, 'b'); assert.equal(C.walkerStatus(w, c.state), 'done');
  // if / else with skip and merge
  w = P([sh('c', 'true'), { id: 'i', type: 'if', op: 'truthy', left: 'x' }, sh('x', 'true'), sh('y', 'true'), { id: 'm', type: 'merge' }, sh('z', 'true')],
    [{ from: 't', to: 'c' }, { from: 'c', to: 'i' }, { from: 'i', to: 'x', handle: 'true' }, { from: 'i', to: 'y', handle: 'false' }, { from: 'x', to: 'm' }, { from: 'y', to: 'm' }, { from: 'm', to: 'z' }]);
  s = C.walkerStart(w); n = step(w, s); c = done(w, n.state, 'c'); n = step(w, c.state); assert.deepEqual(n.start, [{ nodeId: 'i', visit: 1 }]);
  c = done(w, n.state, 'i', { ok: true, handle: 'false' }); n = step(w, c.state);
  assert.deepEqual(n.skip, [{ nodeId: 'x', visit: 1 }]); assert.deepEqual(n.start, [{ nodeId: 'y', visit: 1 }]);
  c = done(w, n.state, 'y'); n = step(w, c.state); assert.deepEqual(n.start, [{ nodeId: 'm', visit: 1 }], 'merge runs once, after the dead branch resolved');
  c = done(w, n.state, 'm'); n = step(w, c.state); assert.deepEqual(n.start, [{ nodeId: 'z', visit: 1 }]);
  // readonly batch, then one writer at a time
  w = P([ag('r1', 'p', { permission: 'plan' }), ag('r2', 'p', { permission: 'plan' }), sh('w1', 'true'), sh('w2', 'true')], [{ from: 't', to: 'w1' }, { from: 't', to: 'r1' }, { from: 't', to: 'w2' }, { from: 't', to: 'r2' }]);
  assert.equal(C.isReadonlyNode(w.nodes.find((x) => x.id === 'r1')), true); assert.equal(C.isReadonlyNode(w.nodes.find((x) => x.id === 'w1')), false);
  assert.equal(C.isReadonlyNode({ type: 'if' }), true); assert.equal(C.isReadonlyNode({ type: 'join', strategy: 'collect' }), true); assert.equal(C.isReadonlyNode({ type: 'join', strategy: 'merge' }), false);
  s = C.walkerStart(w); n = step(w, s); assert.deepEqual(n.start.map((x) => x.nodeId), ['r1', 'r2'], 'readonly nodes as one batch');
  c = done(w, n.state, 'r1'); c = done(w, c.state, 'r2'); n = step(w, c.state); assert.deepEqual(n.start.map((x) => x.nodeId), ['w1'], 'then one writer');
  assert.deepEqual(step(w, n.state).start, [], 'second writer waits');
  c = done(w, n.state, 'w1'); n = step(w, c.state); assert.deepEqual(n.start.map((x) => x.nodeId), ['w2']);
  // loop: back-edge to n, capped by max_visits
  w = P([sh('n', 'true'), { id: 'i', type: 'if', op: 'truthy', left: '0' }, sh('f', 'true')], [{ from: 't', to: 'n' }, { from: 'n', to: 'i' }, { from: 'i', to: 'f', handle: 'true' }, { from: 'i', to: 'n', handle: 'false' }]);
  s = C.walkerStart(w);
  const lap = (st, handle) => { let r = step(w, st); const v = r.start[0].visit; r = done(w, r.state, 'n'); r = step(w, r.state); assert.equal(r.start[0].nodeId, 'i'); return { v, out: done(w, r.state, 'i', { ok: true, handle }) }; };
  let l = lap(s, 'false'); assert.equal(l.v, 1); assert.equal(l.out.error, null);
  l = lap(l.out.state, 'false'); assert.equal(l.v, 2); assert.equal(l.out.error, null);
  l = lap(l.out.state, 'false'); assert.equal(l.v, 3); assert.equal(l.out.error, 'loop n exceeded max_visits 3'); assert.equal(C.walkerStatus(w, l.out.state), 'failed');
  l = lap(s, 'false'); l = lap(l.out.state, 'true'); assert.equal(l.out.error, null);
  n = step(w, l.out.state); assert.deepEqual(n.start, [{ nodeId: 'f', visit: 1 }]);
  // failure
  w = P([sh('a', 'true'), sh('b', 'true')], chain('t', 'a', 'b'));
  n = step(w, C.walkerStart(w)); c = done(w, n.state, 'a', { ok: false });
  assert.equal(C.walkerStatus(w, c.state), 'failed'); assert.deepEqual(step(w, c.state).start, []);
  // run status derivation
  const d = (walker, current) => C.deriveRunStatus({ walker, current });
  const cs = (...st) => st.map((status, i) => ({ nodeId: `n${i}`, status, bookkeeping: false }));
  assert.equal(d('running', cs('running')), 'running'); assert.equal(d('running', cs('queued')), 'running');
  assert.equal(d('running', cs('waiting')), 'waiting'); assert.equal(d('running', cs('start_unknown')), 'waiting');
  assert.equal(d('running', cs('failed')), 'waiting'); assert.equal(d('running', cs('timeout')), 'waiting');
  assert.equal(d('running', cs('quota')), 'quota'); assert.equal(d('running', cs('quota', 'running')), 'running');
  assert.equal(d('running', [{ nodeId: 'f', status: 'waiting', bookkeeping: true }, ...cs('running')]), 'running');
  assert.equal(d('done', []), 'done'); assert.equal(d('failed', cs('circuit_broken')), 'failed'); assert.equal(d('running', []), 'running');
});

// ---- D13 engine -----------------------------------------------------------------------------------------------------------
await check('D13', 'shell chain end to end with outputs; startedAt/endedAt; retry to circuit break with run waiting then failed; tick and loop start a run; loop of if/back-edge', async () => {
  const h = mkH();
  const r = await mkRunFor(wf([sh('a', 'echo one'), sh('b', 'echo {{a.out}}-two')], chain('t', 'a', 'b')));
  const run = await drive(h, r);
  assert.equal(run.status, 'done'); assert.ok(run.startedAt && run.endedAt);
  const steps = await stepsOf(r);
  assert.ok(/one/.test(cur(steps, 'b').output.stdoutTail) && /two/.test(cur(steps, 'b').output.stdoutTail), cur(steps, 'b').output.stdoutTail);
  assert.equal(cur(steps, 'a').output.exitCode, 0);
  // failure -> waiting -> retry x2 -> circuit_broken + failed
  const f = await mkRunFor(wf([sh('bad', 'echo nope >&2; exit 3')], chain('t', 'bad')));
  const rr = X.runsRoutes({ repos, enqueueStep: enqueueFor(h), ctxOf: () => ctxA });
  let st = await drive(h, f, { stop: async (run2, s2) => cur(s2, 'bad')?.status === 'failed' && h.active.size === 0 });
  await W.advanceRun(h.deps, f.ctx, f.run.id);
  assert.equal((await repos.runner.getRun(f.ctx, f.run.id)).status, 'waiting', 'a failed step with retries left parks the run');
  for (const attempt of [2, 3]) {
    const last = cur(await stepsOf(f), 'bad');
    const rt = await call(rr, 'POST', '/api/runs/:rid/steps/:sid/retry', { params: { rid: String(f.run.id), sid: String(last.id) } });
    assert.equal(rt.status, 201, show(rt.body));
    st = await drive(h, f, { stop: async (run2, s2) => cur(s2, 'bad')?.attempt === attempt && ['failed', 'circuit_broken'].includes(cur(s2, 'bad').status) && h.active.size === 0 });
  }
  await W.advanceRun(h.deps, f.ctx, f.run.id);
  assert.equal(cur(await stepsOf(f), 'bad').status, 'circuit_broken');
  assert.equal((await repos.runner.getRun(f.ctx, f.run.id)).status, 'failed');
  // tick and the loop start a run nobody advanced
  const h2 = mkH();
  const t = await mkRunFor(wf([sh('a', 'echo hi')], chain('t', 'a')));
  const tick = await W.tickRuns(h2.deps); assert.ok(tick.advanced.includes(t.run.id), `advanced ${tick.advanced}`);
  assert.equal((await stepsOf(t)).length, 1);
  const u = await mkRunFor(wf([sh('a', 'echo hi')], chain('t', 'a')));
  const loop = W.startRunnerLoop(h2.deps);
  try { await until(async () => (await stepsOf(u)).length === 1 && (startJobs(h2), true), 5000); } finally { await loop.stop(); }
  const after = (await stepsOf(u)).length; await sleep(300); assert.equal((await stepsOf(u)).length, after, 'loop stopped');
  // if + back-edge loop: count runs 3 times, the third check says yes
  const lp = await mkRunFor(wf([sh('count', 'n=$(cat count.txt 2>/dev/null || echo 0); echo $((n+1)) > count.txt; cat count.txt'), sh('chk', 'if test $(cat count.txt) -ge 3; then echo yes; else echo no; fi'), { id: 'enough', type: 'if', op: 'eq', left: '{{chk.out}}', right: 'yes' }, sh('fin', 'echo finished')],
    [{ from: 't', to: 'count' }, { from: 'count', to: 'chk' }, { from: 'chk', to: 'enough' }, { from: 'enough', to: 'fin', handle: true }, { from: 'enough', to: 'count', handle: false }]));
  const lrun = await drive(h, lp);
  assert.equal(lrun.status, 'done', show(h.errors.map((e) => e?.message)));
  const ls = await stepsOf(lp);
  assert.equal(cur(ls, 'count').visit, 3); assert.equal(cur(ls, 'chk').visit, 3); assert.equal(cur(ls, 'fin').status, 'done');
  assert.equal(fs.readFileSync(path.join(lp.repo, 'count.txt'), 'utf8').trim(), '3');
});

// ---- D14 agent nodes ------------------------------------------------------------------------------------------------------
await check('D14', 'prompt rendered with input and upstream output; worktree new vs parent; permission flag; agent env has no worker secret; run done', async () => {
  const h = mkH();
  const r = await mkRunFor(wf([ag('impl', 'CHK_WRITE=a.txt:hello CHK_SAY=implemented-it make a thing about {{input.topic}}'), ag('review', 'CHK_SAY=reviewed review of {{impl.out}} for {{input.topic}}', { worktree: 'parent', permission: 'plan' })], chain('t', 'impl', 'review')), { inputs: { topic: 'widgets' } });
  const run = await drive(h, r);
  assert.equal(run.status, 'done', show(h.errors.map((e) => e?.message)));
  const steps = await stepsOf(r); const impl = cur(steps, 'impl'); const rev = cur(steps, 'review');
  const si = snapOf(impl); const sr = snapOf(rev);
  assert.ok(si.stdin.includes('make a thing about widgets'));
  assert.ok(sr.stdin.includes('review of implemented-it for widgets'), 'upstream summary reaches the next prompt');
  assert.equal(impl.worktree, si.cwd); assert.ok(impl.worktree.startsWith(path.join(r.repo, '.ctc', 'wt', String(r.run.id)) + path.sep), impl.worktree);
  assert.equal(sr.cwd, impl.worktree, 'worktree parent reuses the upstream worktree');
  assert.ok(si.argv.join(' ').includes('--permission-mode acceptEdits')); assert.ok(sr.argv.join(' ').includes('--permission-mode plan'));
  assert.equal(fs.readFileSync(path.join(impl.worktree, 'a.txt'), 'utf8').trim(), 'hello');
  assert.equal(branchesOf(r.repo).length, 1, 'only the new-worktree node made a branch');
});

// ---- D15 shell nodes ------------------------------------------------------------------------------------------------------
await check('D15', 'cwd worktree is the carried one; none -> no worktree to run in; timeout; overflow; no pid; quiet shell not killed; cancel kills the group', async () => {
  const h = mkH();
  const r = await mkRunFor(wf([ag('impl', 'CHK_WRITE=a.txt:hello'), sh('ls', 'ls; echo wt=$CTC_WORKTREE_PATH', { cwd: 'worktree' })], chain('t', 'impl', 'ls')));
  assert.equal((await drive(h, r)).status, 'done');
  const steps = await stepsOf(r); const s = cur(steps, 'ls');
  assert.ok(s.output.stdoutTail.includes('a.txt')); assert.ok(s.output.stdoutTail.includes(`wt=${cur(steps, 'impl').worktree}`));
  assert.equal(s.pid, null); assert.equal(s.stage, 'report'); assert.equal(typeof s.logPath, 'string'); assert.ok(fs.existsSync(s.logPath));
  const none = await mkRunFor(wf([sh('s', 'echo hi', { cwd: 'worktree' })], chain('t', 's')));
  await drive(h, none, { stop: async (run, st) => cur(st, 's')?.status === 'failed' });
  assert.equal(cur(await stepsOf(none), 's').error, 'no worktree to run in');
  const to = await mkRunFor(wf([sh('s', 'sleep 32', { timeout_s: 1 })], chain('t', 's')));
  const t0 = Date.now(); await drive(h, to, { stop: async (run, st) => cur(st, 's')?.status === 'timeout' });
  const ts = cur(await stepsOf(to), 's'); assert.equal(ts.error, 'shell timed out after 1 s'); assert.ok(Date.now() - t0 < 15_000);
  const keep = W.engineLimits.shellOutputMaxBytes; W.engineLimits.shellOutputMaxBytes = 100;
  try {
    const ov = await mkRunFor(wf([sh('s', 'yes | head -c 5000')], chain('t', 's')));
    await drive(h, ov, { stop: async (run, st) => cur(st, 's')?.status === 'failed' });
    assert.ok(cur(await stepsOf(ov), 's').error.startsWith('shell output over'), cur(await stepsOf(ov), 's').error);
    const exact = await mkRunFor(wf([sh('s', 'head -c 100 /dev/zero | tr "\\0" x')], chain('t', 's')));
    assert.equal((await drive(h, exact)).status, 'done', 'exactly the cap is fine');
  } finally { W.engineLimits.shellOutputMaxBytes = keep; }
  const quiet = await mkRunFor(wf([sh('s', 'sleep 1; true')], chain('t', 's')));
  assert.equal((await drive(h, quiet)).status, 'done', 'a quiet shell is not killed');
  const cn = await mkRunFor(wf([sh('s', 'sleep 31')], chain('t', 's')));
  await drive(h, cn, { stop: async (run, st) => cur(st, 's')?.status === 'running' });
  await sleep(300);
  await call(X.runsRoutes({ repos, ctxOf: () => ctxA }), 'POST', '/api/runs/:rid/cancel', { params: { rid: String(cn.run.id) } });
  const t1 = Date.now(); await until(async () => h.active.size === 0, 15_000);
  assert.ok(Date.now() - t1 < 12_000, 'handler ended after cancel');
  const cs = cur(await stepsOf(cn), 's'); assert.equal(cs.status, 'cancelled');
  const left = () => { try { return execFileSync('sh', ['-c', 'ps -eo args | grep -c "[s]leep 3[12]"'], { encoding: 'utf8' }).trim(); } catch { return '0'; } };
  await until(async () => left() === '0', 5000).catch(() => { throw new Error(`shell process group survived: ${left()} sleep process(es)`); });
});

// ---- D16 gates ------------------------------------------------------------------------------------------------------------
await check('D16', 'approval waits with options; approve route (bad option 422, replay, duplicate no-op, other option 409, foreign 404); resolution reaches the next prompt; reject cancels; setup gate resumes as a new attempt', async () => {
  const h = mkH(); const routes = X.workflowRoutes(mkWdeps(h));
  const gw = wf([ag('impl', 'CHK_WRITE=a.txt:x CHK_SAY=built'), { id: 'gate', type: 'approval', question: 'Merge {{input.topic}}?', options: [{ id: 'merge', label: 'Merge' }, { id: 'rework', label: 'Rework' }] }, ag('next', 'CHK_SAY=final after {{resolution}} and {{gate.out}}', { worktree: 'parent' })], chain('t', 'impl', 'gate', 'next'));
  const r = await mkRunFor(gw, { inputs: { topic: 'widgets' } });
  await drive(h, r, { stop: async (run, st) => run.status === 'waiting' && cur(st, 'gate')?.status === 'waiting' });
  const gate = cur(await stepsOf(r), 'gate');
  assert.deepEqual(gate.options, [{ id: 'merge', label: 'Merge' }, { id: 'rework', label: 'Rework' }]); assert.equal(gate.output.question, 'Merge widgets?');
  assert.equal((await repos.runner.getRun(r.ctx, r.run.id)).status, 'waiting'); assert.equal(snaps().some((x) => x.stdin.includes('final after')), false, 'next did not start');
  const url = '/api/runs/:rid/approve'; const params = { rid: String(r.run.id) };
  const headers = { 'idempotency-key': `k-${rnd()}` };
  const a1 = await call(routes, 'POST', url, { params, body: { step_id: gate.id, option_id: 'merge' }, headers });
  assert.equal(a1.status, 200, show(a1.body)); assert.equal(a1.body.applied, true); assert.equal(a1.body.step.resolution, 'merge'); assert.equal(a1.body.step.status, 'done');
  const a2 = await call(routes, 'POST', url, { params, body: { step_id: gate.id, option_id: 'merge' }, headers });
  assert.deepEqual(a2, a1, 'same Idempotency-Key replays the stored reply');
  const a3 = await call(routes, 'POST', url, { params, body: { step_id: gate.id, option_id: 'merge' } });
  assert.equal(a3.status, 200); assert.equal(a3.body.applied, false);
  assert.equal((await call(routes, 'POST', url, { params, body: { step_id: gate.id, option_id: 'rework' } })).status, 409);
  const run = await drive(h, r);
  assert.equal(run.status, 'done');
  const nx = snapOf(cur(await stepsOf(r), 'next')); assert.ok(nx.stdin.includes('final after merge and merge'), 'resolution and gate output in the prompt');
  // reject cancels the run
  const rj = await mkRunFor(wf([{ id: 'gate', type: 'approval', question: 'go?' }, sh('after', 'echo SHOULD-NOT-RUN > after.txt')], chain('t', 'gate', 'after')));
  await drive(h, rj, { stop: async (run2, st) => cur(st, 'gate')?.status === 'waiting' });
  const g2 = cur(await stepsOf(rj), 'gate');
  assert.equal((await call(routes, 'POST', url, { params: { rid: String(rj.run.id) }, body: { step_id: g2.id, option_id: 'reject' } })).status, 200);
  const rrun = await drive(h, rj);
  assert.equal(rrun.status, 'cancelled'); assert.equal(fs.existsSync(path.join(rj.repo, 'after.txt')), false);
  // setup gate: policy ask parks the agent step; approve run -> new attempt that runs setup
  const h2 = mkH({ runner: { setup: { timeout_s: 10, max_output_mb: 1, policy: 'ask' } } }); const routes2 = X.workflowRoutes(mkWdeps(h2));
  const sg = await mkRunFor(wf([ag('impl', 'CHK_SAY=ok')], chain('t', 'impl')), { ctcYaml: 'setup: "echo setup-ran"\n' });
  await drive(h2, sg, { stop: async (run2, st) => cur(st, 'impl')?.status === 'waiting' });
  const parked = cur(await stepsOf(sg), 'impl');
  assert.deepEqual(parked.options.map((o) => o.id), ['run', 'skip']); assert.equal(parked.stage, null);
  const ap = await call(routes2, 'POST', url, { params: { rid: String(sg.run.id) }, body: { step_id: parked.id, option_id: 'run' } });
  assert.equal(ap.status, 200, show(ap.body));
  const srun = await drive(h2, sg);
  assert.equal(srun.status, 'done', `run ${srun.status}`);
  const all = (await stepsOf(sg)).filter((s) => s.nodeId === 'impl').sort((a, b) => a.attempt - b.attempt);
  assert.equal(all.length, 2); assert.equal(all[1].retryOfStepId, all[0].id); assert.equal(all[1].failureCount, all[0].failureCount); assert.equal(all[1].status, 'done');
  assert.ok(fs.existsSync(path.join(RUNS, String(sg.run.id), `${all[1].id}.setup.log`)), 'setup ran for the new attempt');
});

// ---- D17 fan-out ----------------------------------------------------------------------------------------------------------
const fanWf = (over, childPrompt, o = {}) => wf([{ id: 'F', type: 'fanout', over, child: { type: 'agent', agent: 'claude', prompt: childPrompt }, ...(o.maxParallel ? { max_parallel: o.maxParallel } : {}) }, { id: 'J', type: 'join', strategy: o.strategy ?? 'merge' }, ...(o.after ? [o.after] : [])], [...chain('t', 'F', 'J'), ...(o.after ? [{ from: 'J', to: o.after.id }] : [])]);
let fanRun; let fanH;
await check('D17', '3 children in 3 worktrees under parent step, F waiting while run stays running, throttle by max_parallel, depth refused, item cap fails the run, parked failed child', async () => {
  const h = fanH = mkH(); const seen = [];
  const r = fanRun = await mkRunFor(fanWf(3, 'CHK_WRITE=f{{item}}.txt:c{{item}} CHK_SAY=child-{{item}} CHK_SLEEP=400', { after: sh('v', 'ls', { cwd: 'worktree' }) }));
  const run = await drive(h, r, { onPoll: (run2, st) => { const F = cur(st, 'F'); if (F) seen.push({ run: run2.status, F: F.status, kids: st.filter((s) => s.parentStepId === F.id).map((s) => s.status) }); } });
  assert.equal(run.status, 'done', show(h.errors.map((e) => e?.message)));
  const steps = await stepsOf(r); const F = cur(steps, 'F'); const kids = steps.filter((s) => s.parentStepId === F.id).sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  assert.deepEqual(kids.map((k) => k.nodeId), ['F[0]', 'F[1]', 'F[2]']); assert.equal(F.status, 'done'); assert.equal(F.output.total, 3); assert.equal(F.output.children.length, 3);
  assert.equal(new Set(kids.map((k) => k.worktree)).size, 3, '3 worktrees'); assert.equal(new Set(kids.map((k) => k.branch)).size, 3, '3 branches');
  assert.ok(kids.every((k) => k.status === 'done' && k.branch && fs.existsSync(k.worktree)));
  assert.ok(seen.some((p) => p.F === 'waiting'), 'fanout bookkeeping row is waiting while children run');
  assert.equal(seen.some((p) => p.run === 'waiting' && p.kids.some((k) => ['queued', 'running'].includes(k))), false, 'run is not waiting while children run');
  // throttle: 4 items, max_parallel 2
  const h2 = mkH({ runner: { fanout: { max_depth: 1, max_parallel: 2 } } });
  const t = await mkRunFor(fanWf(4, 'CHK_WRITE=g{{item}}.txt:c{{item}} CHK_SLEEP=600'));
  assert.equal((await drive(h2, t)).status, 'done');
  const tk = (await stepsOf(t)).filter((s) => s.nodeId.startsWith('F['));
  const spans = tk.map((k) => snapOf(k)).map((s) => [s.start, s.end]);
  let peak = 0; for (const [a] of spans) peak = Math.max(peak, spans.filter(([s, e]) => s <= a && e > a).length);
  assert.ok(peak <= 2, `peak concurrency ${peak} > max_parallel 2`); assert.ok(peak >= 2, 'children did run in parallel');
  // depth 2 refused, also through the route
  const nestedDoc = wf([{ id: 'F', type: 'fanout', over: '2', child: { type: 'fanout', over: '2', child: { type: 'agent', agent: 'claude', prompt: 'p' } } }], chain('t', 'F'));
  assert.equal(C.parseWorkflow(nestedDoc).ok, false);
  // item cap
  const big = await mkRunFor(fanWf('{{input.l}}', 'x'), { inputs: { l: Array.from({ length: 21 }, (_, i) => `i${i}`) } });
  assert.equal((await drive(mkH(), big)).status, 'failed');
  const bs = await stepsOf(big); assert.ok(/fanout: 21 items exceeds 20/.test(cur(bs, 'F').error), cur(bs, 'F').error); assert.equal(bs.filter((s) => s.parentStepId !== null).length, 0);
  // parked failed child
  const pk = await mkRunFor(fanWf('["ok","fail"]', 'CHK_MODE={{item}} CHK_SAY=x'));
  await drive(h, pk, { stop: async (run2, st) => run2.status === 'waiting' && st.filter((s) => s.parentStepId !== null).some((s) => s.status === 'failed') && h.active.size === 0 });
  const ps = await stepsOf(pk); const kk = ps.filter((s) => s.parentStepId !== null);
  assert.deepEqual(kk.map((k) => `${k.nodeId}:${k.status}`).sort(), ['F[0]:done', 'F[1]:failed']); assert.equal(cur(ps, 'F').status, 'waiting');
});

// ---- D18 join -------------------------------------------------------------------------------------------------------------
await check('D18', 'merge: all branches merged in order into the join worktree (uncommitted child checkpointed, no git identity needed); conflict lists files and keeps branches; collect returns the list', async () => {
  const h = mkH();
  // child 2 (index 1) leaves its file uncommitted: the join must checkpoint it
  const r = await mkRunFor(fanWf(3, 'CHK_WRITE=m{{item}}.txt:c{{item}} CHK_SAY=child-{{item}} CHK_NOCOMMIT={{index}}', { after: sh('v', 'ls', { cwd: 'worktree' }) }));
  const run = await drive(h, r);
  assert.equal(run.status, 'done', show(h.errors.map((e) => e?.message)));
  const steps = await stepsOf(r); const J = cur(steps, 'J'); const ls = cur(steps, 'v').output.stdoutTail;
  assert.equal(J.status, 'done'); assert.equal(J.output.merged.length, 3); assert.ok(J.worktree && J.branch);
  for (const f of ['m1.txt', 'm2.txt', 'm3.txt']) assert.ok(ls.includes(f), `${f} in merged tree: ${ls}`);
  assert.equal(git(J.worktree, 'log', '--merges', '--format=%s').split('\n').filter(Boolean).length, 3);
  assert.equal(git(J.worktree, 'status', '--porcelain').trim(), '');
  const kids = steps.filter((s) => s.parentStepId !== null); assert.ok(kids.every((k) => branchesOf(r.repo).includes(k.branch)), 'child branches kept');
  assert.deepEqual(J.output.merged, kids.sort((a, b) => a.nodeId.localeCompare(b.nodeId)).map((k) => k.branch), 'merged in index order');
  // conflict
  const c = await mkRunFor(fanWf(3, 'CHK_WRITE=same.txt:c{{item}} CHK_SAY=x'));
  await drive(h, c, { stop: async (run2, st) => cur(st, 'J')?.status === 'failed' && h.active.size === 0 });
  const cs = await stepsOf(c); const CJ = cur(cs, 'J');
  assert.ok(CJ.error.startsWith('merge conflict: same.txt'), CJ.error); assert.match(CJ.error, /\(branch ctc\//);
  assert.equal(branchesOf(c.repo).filter((b) => cs.some((s) => s.parentStepId !== null && s.branch === b)).length, 3, 'child branches kept');
  assert.equal(git(CJ.worktree, 'status', '--porcelain').trim(), '', 'merge aborted: clean tree'); assert.equal(fs.existsSync(path.resolve(CJ.worktree, git(CJ.worktree, 'rev-parse', '--git-path', 'MERGE_HEAD').trim())), false, 'no merge in progress');
  await W.advanceRun(h.deps, c.ctx, c.run.id); assert.equal((await repos.runner.getRun(c.ctx, c.run.id)).status, 'waiting');
  // collect
  const k = await mkRunFor(fanWf(3, 'CHK_SAY=child-{{item}}', { strategy: 'collect' }));
  assert.equal((await drive(h, k)).status, 'done');
  const KJ = cur(await stepsOf(k), 'J'); assert.deepEqual(KJ.output.results, ['child-1', 'child-2', 'child-3']); assert.equal(C.outText({ type: 'join', strategy: 'collect' }, KJ.output), '["child-1","child-2","child-3"]');
});

// ---- D19 starting a run ---------------------------------------------------------------------------------------------------
await check('D19', 'POST runs: 202, pinned version through the default loader, validation 422, 404s, one running run per owner 409, idempotent replay; GET workflows/runs', async () => {
  const h = mkH({ deps: { loadWorkflow: undefined } }); delete h.deps.loadWorkflow; h.handlers = W.workflowHandlers(h.deps);
  const repo = mkRepo();
  const owner = `o-${rnd()}`;
  const wd = mkWdeps(h, { ownerOf: () => owner, advance: async (ctx, id) => { await W.advanceRun(h.deps, ctx, id); } });
  const routes = X.workflowRoutes(wd); const name = `wf-${rnd()}`;
  const v1 = await mkCap(ctxA, name, wf([sh('a', 'echo v1')], chain('t', 'a')));
  const U = '/api/workflows/:id/runs'; const params = { id: v1.cap.id };
  const key = `k-${rnd()}`;
  const p1 = await call(routes, 'POST', U, { params, body: { inputs: { topic: 'x' }, repo, base: 'main' }, headers: { 'idempotency-key': key } });
  assert.equal(p1.status, 202, show(p1.body)); assert.equal(typeof p1.body.run_id, 'number'); assert.equal(p1.body.status, 'running');
  const row = await repos.runner.getRun(ctxA, p1.body.run_id);
  assert.equal(row.workflowCapId, v1.cap.id); assert.equal(row.workflowVersion, v1.version.version); assert.equal(row.repo, repo); assert.equal(row.baseBranch, 'main'); assert.equal(row.trigger, 'api'); assert.equal(row.owner, owner);
  const again = await call(routes, 'POST', U, { params, body: { inputs: { topic: 'x' }, repo, base: 'main' }, headers: { 'idempotency-key': key } });
  assert.deepEqual(again, p1, 'same key and payload replays');
  assert.equal((await repos.runner.listRuns(ctxA, { limit: 500 })).rows.filter((x) => x.owner === owner).length, 1);
  assert.equal((await call(routes, 'POST', U, { params, body: { repo } })).status, 409, 'owner already has a running run');
  await mkCap(ctxA, name, wf([sh('a', 'echo v2')], chain('t', 'a')));
  const fin = await drive(h, { ctx: ctxA, run: row });
  assert.equal(fin.status, 'done'); assert.ok(cur(await repos.runner.listSteps(ctxA, row.id), 'a').output.stdoutTail.includes('v1'), 'the run stays on the pinned version');
  const ownerFree = mkWdeps(h, { ownerOf: () => `o-${rnd()}` }); const r2 = X.workflowRoutes(ownerFree);
  const bad = async (body, id = params.id, who) => call(r2, 'POST', U, { params: { id }, body, who });
  for (const body of [{ repo: '../x' }, { repo: 'relative/dir' }, { repo: `/a/${'b'.repeat(4100)}` }, { repo: '/a\u0000b' }, { repo, base: '-x' }, { repo, base: 'a..b' }, { repo, base: 'x.lock' }, { repo, inputs: 'no' }, { repo, inputs: { big: 'x'.repeat(70000) } }, { repo, extra: 1 }]) {
    const res = await bad(body); assert.equal(res.status, 422, show(body).slice(0, 60)); assert.equal(res.body.error.code, 'invalid');
  }
  assert.equal((await bad({ repo }, 'not-a-uuid')).status, 404); assert.equal((await bad({ repo }, params.id, ctxB)).status, 404);
  const skill = await mkCap(ctxA, `sk-${rnd()}`, 'text', { kind: 'skill' }); assert.equal((await bad({ repo }, skill.cap.id)).status, 404);
  const broken = await mkCap(ctxA, `br-${rnd()}`, { name: 'br', nodes: 'nope', edges: [] });
  const bres = await bad({ repo }, broken.cap.id); assert.equal(bres.status, 422); assert.ok(Array.isArray(bres.body.error.errors) && bres.body.error.errors.length >= 1);
  const list = await call(routes, 'GET', '/api/workflows', {}); assert.equal(list.status, 200); assert.ok(list.body.workflows.some((w) => w.id === v1.cap.id && w.name === name));
  const one = await call(routes, 'GET', '/api/workflows/:id', { params }); assert.equal(one.status, 200); assert.equal(one.body.workflow.nodes.length, 2); assert.deepEqual(one.body.errors, []);
  const bone = await call(routes, 'GET', '/api/workflows/:id', { params: { id: broken.cap.id } }); assert.equal(bone.status, 200); assert.equal(bone.body.workflow, null); assert.ok(bone.body.errors.length >= 1);
  const runs = await call(routes, 'GET', '/api/runs', { query: { limit: '1' } }); assert.equal(runs.status, 200); assert.equal(runs.body.runs.length, 1);
  assert.equal((await call(routes, 'GET', '/api/runs', { query: { limit: '9999' } })).status, 422);
});

// ---- D20 continue and quota -----------------------------------------------------------------------------------------------
await check('D20', 'quota parks the run; continue re-queues the same attempt with a resume job id; past reset time resumes by itself; continue on gate/finished/running', async () => {
  const h = mkH(); const routes = X.workflowRoutes(mkWdeps(h));
  const U = '/api/runs/:rid/continue';
  const q = await mkRunFor(wf([ag('impl', 'CHK_MODE=quota_once CHK_SAY=after-quota')], chain('t', 'impl')));
  await drive(h, q, { stop: async (run, st) => run.status === 'quota' && cur(st, 'impl')?.status === 'quota' && h.active.size === 0 });
  const parked = cur(await stepsOf(q), 'impl'); assert.ok(/^usage limit until /.test(parked.error), parked.error);
  h.submits.length = 0;
  const key = `k-${rnd()}`;
  const c1 = await call(routes, 'POST', U, { params: { rid: String(q.run.id) }, body: {}, headers: { 'idempotency-key': key } });
  assert.equal(c1.status, 200, show(c1.body)); assert.equal(c1.body.applied, true); assert.equal(c1.body.resumed, 1); assert.equal(c1.body.run.status, 'running');
  const after = cur(await stepsOf(q), 'impl'); assert.equal(after.id, parked.id, 'same attempt'); assert.equal(after.attempt, 1);
  assert.ok(h.submits.some((s) => s.id.startsWith(C.runnerJobId({ runId: q.run.id, nodeId: 'impl', visit: 1, attempt: 1 }) + ':resume:')), `resume job id: ${h.submits.map((s) => s.id)}`);
  assert.deepEqual(await call(routes, 'POST', U, { params: { rid: String(q.run.id) }, body: {}, headers: { 'idempotency-key': key } }), c1);
  assert.equal((await drive(h, q)).status, 'done');
  assert.equal((await call(routes, 'POST', U, { params: { rid: String(q.run.id) }, body: {} })).status, 409, 'finished run');
  // automatic: reset time already passed
  const a = await mkRunFor(wf([ag('impl', 'CHK_MODE=quota_once CHK_RESET=1000000000 CHK_SAY=auto')], chain('t', 'impl')));
  await drive(h, a, { stop: async (run, st) => run.status === 'quota' && cur(st, 'impl')?.status === 'quota' && h.active.size === 0 });
  assert.match(cur(await stepsOf(a), 'impl').error, /^usage limit until 2001-/);
  await W.tickRuns(h.deps);
  assert.equal(cur(await stepsOf(a), 'impl').status, 'queued', 'the tick resumed a quota step whose reset time passed');
  assert.equal((await drive(h, a)).status, 'done');
  // future reset is not resumed by the tick
  const f = await mkRunFor(wf([ag('impl', 'CHK_MODE=quota_once CHK_SAY=later')], chain('t', 'impl')));
  await drive(h, f, { stop: async (run, st) => run.status === 'quota' && cur(st, 'impl')?.status === 'quota' && h.active.size === 0 });
  await W.tickRuns(h.deps); assert.equal(cur(await stepsOf(f), 'impl').status, 'quota');
  // gate open -> 409; running -> no-op
  const g = await mkRunFor(wf([{ id: 'gate', type: 'approval', question: 'q' }], chain('t', 'gate')));
  await drive(h, g, { stop: async (run) => run.status === 'waiting' });
  assert.equal((await call(routes, 'POST', U, { params: { rid: String(g.run.id) }, body: {} })).status, 409);
  const n = await mkRunFor(wf([sh('a', 'sleep 1')], chain('t', 'a')));
  const nr = await call(routes, 'POST', U, { params: { rid: String(n.run.id) }, body: {} }); assert.equal(nr.status, 200); assert.equal(nr.body.applied, false);
  assert.equal((await call(routes, 'POST', U, { params: { rid: String(n.run.id) }, body: { x: 1 } })).status, 422);
});

// ---- D21 handoff ----------------------------------------------------------------------------------------------------------
await check('D21', 'run_workflow returns {run_id,status,prompt_outcome}: delivered for an agent first step, null without an agent; workflow_status lists steps; errors are isError results', async () => {
  const h = mkH(); const repo = mkRepo();
  h.deps.loadWorkflow = async (ctx, run) => WFS.get(run.id) ?? viaLibrary(ctx, run); h.handlers = W.workflowHandlers(h.deps);
  const wd = mkWdeps(h, { ownerOf: () => `o-${rnd()}` });
  const tools = Object.fromEntries(X.workflowTools(wd).map((t) => [t.name, t]));
  const pump = setInterval(() => { void W.tickRuns(h.deps).then(() => startJobs(h)).catch(() => {}); }, 80);
  const keep = { ...X.handoffLimits };
  try {
    X.handoffLimits.waitMs = 20_000; X.handoffLimits.pollMs = 50;
    const a = await mkCap(ctxA, `ho-${rnd()}`, wf([ag('impl', 'CHK_SAY=handed')], chain('t', 'impl')));
    const res = await tools.run_workflow.call(ctxA, { name: `user:${a.cap.name}`, inputs: {}, repo, base: 'main' });
    assert.equal(res.isError, undefined, show(res)); assert.equal(res.content[0].type, 'text');
    const body = JSON.parse(res.content[0].text); assert.deepEqual(Object.keys(body).sort(), ['prompt_outcome', 'run_id', 'status']);
    assert.equal(body.prompt_outcome, 'delivered'); assert.equal(typeof body.run_id, 'number');
    const stt = JSON.parse((await tools.workflow_status.call(ctxA, { run_id: body.run_id })).content[0].text);
    assert.equal(stt.run_id, body.run_id); assert.ok(stt.steps.length >= 1); for (const k of ['id', 'node_id', 'visit', 'attempt', 'status', 'stage', 'resolution', 'prompt_outcome']) assert.ok(k in stt.steps[0], k);
    assert.equal((await tools.workflow_status.call(ctxB, { run_id: body.run_id })).isError, true);
    assert.equal((await tools.workflow_status.call(ctxA, { run_id: 'x' })).isError, true);
    X.handoffLimits.waitMs = 700;
    const s = await mkCap(ctxA, `ho-${rnd()}`, wf([sh('a', 'echo hi')], chain('t', 'a')));
    const r2 = JSON.parse((await tools.run_workflow.call(ctxA, { name: s.cap.name, repo })).content[0].text);
    assert.equal(r2.prompt_outcome, null, 'no agent step: null');
    const miss = await tools.run_workflow.call(ctxA, { name: 'no-such-workflow-xyz' });
    assert.equal(miss.isError, true); assert.equal(JSON.parse(miss.content[0].text).error.code, 'not_found');
    const sk = await mkCap(ctxA, `sk-${rnd()}`, 'text', { kind: 'skill' });
    assert.equal((await tools.run_workflow.call(ctxA, { name: sk.cap.name })).isError, true, 'a skill is not a workflow');
    assert.equal((await tools.run_workflow.call(ctxA, { name: s.cap.name, extra: 1 })).isError, true);
  } finally { Object.assign(X.handoffLimits, keep); clearInterval(pump); await sleep(300); }
});

// ---- D22 cleanup ----------------------------------------------------------------------------------------------------------
await check('D22', 'cleanup.worktree: not due -> nothing; due -> logs gzipped, clean worktrees removed without force, dirty kept, outside path untouched, branches kept, repeat no-op; receipts pruned; scheduleCleanup', async () => {
  const h = mkH({ runner: { worktree: { add_timeout_s: 30, dir: '.ctc/wt', keep_days: 7 } } });
  const handlers = W.cleanupHandlers(h.deps);
  const r = fanRun; assert.ok(r, 'D17 run available');
  const steps = await stepsOf(r); const kids = steps.filter((s) => s.parentStepId !== null);
  assert.deepEqual(await handlers['cleanup.worktree']({ userId: r.ctx.userId, runId: String(r.run.id) }, { jobId: 'c', attempt: 1, signal: new AbortController().signal, setProgress: async () => {} }), { runId: String(r.run.id), removed: 0, kept: [], archived: 0, due: false });
  assert.ok(kids.every((k) => fs.existsSync(k.worktree)));
  const hz = mkH({ runner: { worktree: { add_timeout_s: 30, dir: '.ctc/wt', keep_days: 0 } } });
  const hz2 = W.cleanupHandlers(hz.deps); const J = { jobId: 'c', attempt: 1, signal: new AbortController().signal, setProgress: async () => {} };
  const dirtyWt = kids[0].worktree; fs.writeFileSync(path.join(dirtyWt, 'untracked.txt'), 'precious');
  const victim = path.join(TMP, `victim-${rnd()}`); fs.mkdirSync(victim); fs.writeFileSync(path.join(victim, 'keep.txt'), 'x');
  const stray = await repos.runner.insertStep(r.ctx, { runId: r.run.id, nodeId: 'stray', visit: 1, attempt: 1, status: 'queued' });
  await repos.runner.setStepFields(r.ctx, stray.step.id, { worktree: victim });
  const logged = steps.filter((s) => s.logPath && fs.existsSync(s.logPath));
  const res = await hz2['cleanup.worktree']({ userId: r.ctx.userId, runId: String(r.run.id) }, J);
  assert.equal(res.due, true); assert.ok(res.removed >= 3, show(res)); assert.ok(res.archived >= 1, show(res));
  assert.ok(res.kept.some((k) => k.stepId === kids[0].id && k.reason === 'dirty'), show(res.kept));
  assert.equal(fs.existsSync(path.join(dirtyWt, 'untracked.txt')), true, 'dirty worktree kept'); assert.equal(fs.existsSync(path.join(victim, 'keep.txt')), true, 'path outside <repo>/.ctc/wt/<run>/ untouched');
  assert.ok(kids.slice(1).every((k) => !fs.existsSync(k.worktree)), 'clean worktrees removed');
  assert.ok(branchesOf(r.repo).length >= 3, 'branches kept');
  for (const s of logged) { assert.equal(fs.existsSync(s.logPath), false, 'plain log removed'); assert.ok(fs.existsSync(`${s.logPath}.gz`), 'gz written'); }
  const again = await hz2['cleanup.worktree']({ userId: r.ctx.userId, runId: String(r.run.id) }, J);
  assert.equal(again.removed, 0); assert.equal(again.due, true);
  await assert.rejects(hz2['cleanup.worktree']({ userId: r.ctx.userId, runId: '999999999' }, J), (e) => e?.code === 'run_not_found');
  await assert.rejects(hz2['cleanup.worktree']({ userId: ctxB.userId, runId: String(r.run.id) }, J), (e) => e?.code === 'run_not_found');
  await repos.idempotency.store(ctxA, { key: `old-${rnd()}`, route: 'POST /x', payloadHash: 'h', response: { status: 200 } });
  await sql`update idempotency_keys set created_at = now() - interval '31 days'`.execute(db.kysely);
  const pr = await hz2['cleanup.receipts']({}, J); assert.ok(pr.pruned >= 1);
  const sched = await W.scheduleCleanup(hz.deps); assert.ok(sched.submitted >= 1);
  const cj = hz.submits.find((s) => s.queue === 'cleanup'); assert.equal(cj.kind, 'worktree'); assert.match(cj.id, /^cleanup:worktree:\d+$/); assert.deepEqual(Object.keys(cj.payload).sort(), ['runId', 'userId']);
});

// ---- D23 log route --------------------------------------------------------------------------------------------------------
await check('D23', 'log route streams the plain log, then the gunzipped one after cleanup, 404 for a path outside runsDir or no log', async () => {
  const h = mkH(); const routes = X.workflowRoutes(mkWdeps(h));
  const r = await mkRunFor(wf([sh('a', 'echo log-line-1')], chain('t', 'a')));
  assert.equal((await drive(h, r)).status, 'done');
  const s = cur(await stepsOf(r), 'a'); const U = '/api/runs/:rid/steps/:sid/log'; const params = { rid: String(r.run.id), sid: String(s.id) };
  const g1 = await call(routes, 'GET', U, { params }); assert.equal(g1.status, 200); assert.ok((await readAll(g1.body)).includes('log-line-1'));
  const raw = fs.readFileSync(s.logPath); fs.writeFileSync(`${s.logPath}.gz`, zlib.gzipSync(raw)); fs.rmSync(s.logPath);
  const g2 = await call(routes, 'GET', U, { params }); assert.equal(g2.status, 200); assert.ok((await readAll(g2.body)).includes('log-line-1'), 'gunzipped on the fly');
  await repos.runner.setStepFields(r.ctx, s.id, { logPath: '/etc/hostname' });
  assert.equal((await call(routes, 'GET', U, { params })).status, 404);
  await repos.runner.setStepFields(r.ctx, s.id, { logPath: null });
  assert.equal((await call(routes, 'GET', U, { params })).status, 404);
  assert.equal((await call(routes, 'GET', U, { params, who: ctxB })).status, 404);
});

// ---- D24 small edits ------------------------------------------------------------------------------------------------------
await check('D24', 'system.runner.listActiveRuns lists queued/running/waiting/quota runs of all users, not finished ones; tenancy allowlist and test file present', async () => {
  const sctx = R.createSystemCtx('t63 check');
  const mk = async (ctx, status) => repos.runner.createRun(ctx, { owner: `o-${rnd()}`, trigger: 'api', status });
  const a = await mk(ctxA, 'running'); const b = await mk(ctxB, 'waiting'); const c = await mk(ctxA, 'queued'); const d = await mk(ctxB, 'quota'); const e = await mk(ctxA, 'done'); const f = await mk(ctxB, 'failed'); const g = await mk(ctxA, 'cancelled');
  const list = await repos.system.runner.listActiveRuns(sctx); const ids = list.map((x) => x.id);
  for (const x of [a, b, c, d]) assert.ok(ids.includes(x.id), `run ${x.id} (${x.status}) listed`);
  for (const x of [e, f, g]) assert.equal(ids.includes(x.id), false, `finished run ${x.status} not listed`);
  assert.deepEqual([...ids].sort((p, q) => p - q), ids, 'ordered by id'); assert.equal(list.find((x) => x.id === b.id).userId, ctxB.userId);
  await assert.rejects(() => repos.system.runner.listActiveRuns({ userId: 'x' }), TypeError);
  assert.ok(fs.readFileSync(path.join(ROOT, 'packages/shared/src/repositories/tenancy.test.ts'), 'utf8').includes("'runner.listActiveRuns'"));
  assert.ok(fs.existsSync(path.join(ROOT, 'packages/shared/src/repositories/system-runner.int.test.ts')));
});

// ---- D25 gate tests -------------------------------------------------------------------------------------------------------
await check('D25', 'gate test files exist with the exact describe and it names', async () => {
  const gates = { [`${WORKER_DIR}/runner.fanout.int.test.ts`]: ['runner.fanout', ['runs 3 children in 3 worktrees and the join merges their branches', 'refuses a fanout inside a fanout child', 'fails the join with the conflicting files and keeps the branches', 'never runs more children at once than max_parallel']], [`${WORKER_DIR}/runner.md.int.test.ts`]: ['runner.md', ['runs the 3 sample workflows end to end within the metric thresholds']] };
  for (const [file, [describe, names]] of Object.entries(gates)) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} exists`);
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(new RegExp(`describe\\(\\s*['"\`]${describe.replace('.', '\\.')}['"\`]`).test(src), `describe ${describe}`);
    for (const n of names) assert.ok(src.includes(`'${n}'`) || src.includes(`"${n}"`) || src.includes(`\`${n}\``), `it ${n}`);
  }
});

// ---- D26 eval files -------------------------------------------------------------------------------------------------------
await check('D26', 'runner.md has a Results table; the 3 sample workflows parse and cover agent+gate, fanout+join, if back-edge loop; run.mjs and fake-agent.mjs exist', async () => {
  const md = path.join(ROOT, '.claude/metric/eval/runner.md'); assert.ok(fs.existsSync(md), 'runner.md exists');
  const text = fs.readFileSync(md, 'utf8'); assert.ok(/^#+\s*Results/m.test(text), 'Results heading'); assert.ok(/^\|.*status.*\|/im.test(text) && /wall_ms/.test(text), 'metrics table header');
  const dir = path.join(ROOT, '.claude/metric/eval/runner');
  for (const f of ['run.mjs', 'fake-agent.mjs']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  const parse = (f) => { const r = C.parseWorkflow(fs.readFileSync(path.join(dir, f), 'utf8')); assert.ok(r.ok, `${f}: ${JSON.stringify(r.errors)}`); return r.workflow; };
  const ir = parse('implement-review.yaml'); const fm = parse('fanout-merge.yaml'); const lg = parse('loop-gate.yaml');
  const types = (w) => new Set(w.nodes.map((n) => n.type));
  assert.ok(types(ir).has('agent') && types(ir).has('approval')); assert.ok(types(fm).has('fanout') && types(fm).has('join')); assert.ok(types(lg).has('if') && types(lg).has('approval') && types(lg).has('shell'));
  assert.ok(lg.nodes.filter((n) => n.type === 'shell').length >= 2 && lg.edges.length >= 5, 'loop-gate shape');
});

await finish();
