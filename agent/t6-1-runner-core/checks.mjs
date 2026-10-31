// checks for T6.1 runner step lifecycle (transition table, attempts, stages, idempotency keys, step routes): one runnable example per
// decision id (D0..D22). Prints `PASS D# ...` or `FAIL D# expected=<..> got=<..>`; last line `CHECKS: <n> pass, <m> fail`; exit 1 on any FAIL.
// Needs: env CTC_SCRATCH_PG_URL (scratch Postgres 127.0.0.1:18304 only) and the T1.2 migrations. Run from the repo root:
//   node --import tsx agent/t6-1-runner-core/checks.mjs      (tsx lets Node import the .ts sources)
// Scratch schema `ctc_t61chk_<random>`, dropped at the end. Fixture values are this file's own. Nothing outside the scratch DB is touched.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(new URL('../../', import.meta.url).pathname);
const CORE = 'packages/core/src/runner/index.ts';
const WEB = 'apps/web/src/runs/index.ts';
const SCHEMAS = 'packages/shared/src/schemas/runs/index.ts';
const REPOS = 'packages/shared/src/repositories/index.ts';
const ADMIN = 'packages/shared/src/repositories/admin/index.ts';
const HTTP = 'apps/web/src/library/http.ts';
const QDEFS = 'packages/shared/src/queues/defs.ts';
const CASES = 'packages/shared/src/repositories/tenancy.cases.ts';
const CORE_DIR = 'packages/core/src/runner';
const WEB_DIR = 'apps/web/src/runs';
const GATE_LIFE = 'apps/web/src/runs/runner.lifecycle.int.test.ts';
const GATE_IDEM = 'apps/web/src/runs/runner.idempotent.int.test.ts';
const P = {
  retry: 'POST /api/runs/:rid/steps/:sid/retry', fail: 'POST /api/runs/:rid/steps/:sid/fail',
  cancel: 'POST /api/runs/:rid/cancel', report: 'POST /api/runs/:rid/steps/:sid/report',
};
const STATUSES = ['queued', 'running', 'waiting', 'done', 'failed', 'timeout', 'start_unknown', 'quota', 'skipped', 'cancelled', 'circuit_broken'];
const LEGAL = {
  queued: ['running', 'skipped', 'cancelled'],
  running: ['done', 'waiting', 'failed', 'timeout', 'start_unknown', 'quota', 'cancelled'],
  quota: ['queued', 'cancelled'], waiting: ['done', 'cancelled'], start_unknown: ['failed', 'cancelled', 'circuit_broken'],
  failed: ['circuit_broken'], timeout: ['circuit_broken'], done: [], skipped: [], cancelled: [], circuit_broken: [],
};
const IDS = Array.from({ length: 23 }, (_, i) => `D${i}`);
let pass = 0; let fail = 0;
const done = new Set();
const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
function ok(id, msg) { pass++; done.add(id); console.log(`PASS ${id} ${msg}`); }
function bad(id, expected, got) { fail++; done.add(id); console.log(`FAIL ${id} expected=${show(expected)} got=${show(got)}`); }
async function check(id, msg, fn) {
  let timer;
  try {
    await Promise.race([fn(), new Promise((_, rej) => (timer = setTimeout(() => rej(new Error('check timed out after 60 s')), 60_000)))]);
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
const sorted = (a) => [...a].sort();
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sources = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory() && e.name !== 'node_modules' && e.name !== 'fixtures') walk(p); else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p); } };
  if (fs.existsSync(path.join(ROOT, dir))) walk(path.join(ROOT, dir));
  return out.map((p) => [path.relative(ROOT, p), fs.readFileSync(p, 'utf8')]);
};
const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
const jsonSafe = (b) => assert.deepEqual(JSON.parse(JSON.stringify(b)), b);

// ---- load -----------------------------------------------------------------------------------------------------------
const url = process.env.CTC_SCRATCH_PG_URL;
if (!url) await failAll('env CTC_SCRATCH_PG_URL not set');
const pu = new URL(url);
if (pu.hostname !== '127.0.0.1' || pu.port !== '18304') await failAll(`refusing ${pu.hostname}:${pu.port}, only the scratch Postgres 127.0.0.1:18304`);
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
for (const rel of [CORE, WEB, SCHEMAS]) if (!fs.existsSync(path.join(ROOT, rel))) await failAll(`module not built: ${rel} is missing`);
let C; let W; let R; let A; let H; let Q;
try {
  C = await load(CORE); W = await load(WEB); R = await load(REPOS); A = await load(ADMIN); H = await load(HTTP); Q = await load(QDEFS);
} catch (e) { await failAll(`module not importable: ${e?.code ?? e?.name}: ${String(e?.message).split('\n')[0]}`); }
const schema = `ctc_t61chk_${rnd()}`;
let db; let repos;
try {
  await A.migrate({ url, schema });
  db = R.createDb({ url, schema });
  repos = R.createRepositories(db);
} catch (e) { await failAll(`scratch schema not built: ${e?.name}: ${e?.message}`); }
cleanup = async () => { try { await db.kysely.schema.dropSchema(schema).ifExists().cascade().execute(); } finally { await db.close(); } };

// ---- fixtures -------------------------------------------------------------------------------------------------------
const ctxA = { userId: `u-a-${rnd()}` };
const ctxB = { userId: `u-b-${rnd()}` };
async function mkRun(ctx, status = 'running') {
  const run = await repos.runner.createRun(ctx, { owner: `o-${rnd()}`, trigger: 'api' });
  return status === 'queued' ? run : repos.runner.setRunStatus(ctx, run.id, { from: 'queued', to: status });
}
async function mkStep(ctx, runId, o = {}) {
  const token = `tok-${rnd()}${rnd()}`;
  const { step } = await repos.runner.insertStep(ctx, {
    runId, nodeId: o.nodeId ?? `n-${rnd()}`, visit: o.visit ?? 1, attempt: o.attempt ?? 1, status: o.status ?? 'running',
    failureCount: o.failureCount ?? 0, parentStepId: o.parentStepId ?? null, ...(o.noToken ? {} : { tokenHash: sha(token) }),
  });
  return { step, token };
}
const getStep = (ctx, id) => repos.runner.getStep(ctx, id);
const getRun = (ctx, id) => repos.runner.getRun(ctx, id);
const enq = [];
let enqueueImpl = async (_ctx, s) => { enq.push(s.id); };
const cfg = { runner: { max_failures: 3 } };
const mkDeps = (over = {}) => ({ repos, config: cfg, ctxOf: (req) => req?.ctx ?? { userId: 'local' }, enqueueStep: (c, s) => enqueueImpl(c, s), log: () => {}, ...over });
let routes = [];
async function call(name, req, rs = routes) {
  const [method, u] = P[name].split(' ');
  const r = rs.find((x) => x.method === method && x.url === u);
  if (!r) throw new Error(`route missing: ${P[name]}`);
  const out = { status: undefined, body: undefined, sends: 0 };
  const reply = { code(n) { out.status = n; return { send(b) { out.body = b; out.sends++; return b; } }; } };
  await r.handler({ params: {}, query: {}, headers: {}, ...req }, reply);
  return out;
}
const sp = (run, step) => ({ rid: String(run.id), sid: String(step.id) });
const retry = (ctx, run, step, o = {}) => call('retry', { ctx, params: sp(run, step), body: o.body, headers: o.headers ?? {} });
const failR = (ctx, run, step, o = {}) => call('fail', { ctx, params: sp(run, step), body: o.body, headers: o.headers ?? {} });
const cancel = (ctx, run, o = {}) => call('cancel', { ctx, params: { rid: String(run.id) }, body: o.body, headers: o.headers ?? {} });
const report = (ctx, run, step, token, body, hdr = 'x-ctc-step-token') =>
  call('report', { ctx, params: sp(run, step), headers: token === undefined ? {} : { [hdr]: token }, body });
const KEY = (k) => ({ 'idempotency-key': k });
const fakePort = (over = {}) => {
  const calls = [];
  const port = {};
  for (const n of ['getRun', 'setRunStatus', 'getStep', 'listSteps', 'insertStep', 'transition', 'setStepFields']) {
    port[n] = async (...args) => { calls.push([n, args]); if (over[n]) return over[n](...args); throw new Error(`unexpected port call ${n}`); };
  }
  return { port, calls };
};

try {
  routes = W.runsRoutes(mkDeps());

  await check('D0', 'public names exported; exactly the 4 routes; repos.idempotency.settle/release exist', async () => {
    const core = ['STEP_STATUSES', 'NON_FINAL', 'TRANSITIONS', 'canTransition', 'RunnerError', 'STAGES', 'canEnterStage', 'runnerLimits', 'isExhausted',
      'isCurrentAttempt', 'runnerJobId', 'transitionStep', 'advanceStage', 'failStep', 'retryStep', 'reportStep', 'cancelRun'];
    assert.deepEqual(core.filter((n) => C[n] === undefined), []);
    assert.deepEqual(['runsRoutes', 'withIdempotency', 'payloadHash', 'stepJson', 'runsLimits'].filter((n) => W[n] === undefined), []);
    assert.deepEqual(sorted(routes.map((r) => `${r.method} ${r.url}`)), sorted(Object.values(P)));
    assert.deepEqual([typeof repos.idempotency.settle, typeof repos.idempotency.release], ['function', 'function']);
  });

  await check('D1', 'another user gets 404 everywhere and changes nothing; strict retry body; token required; receipts per user', async () => {
    const runA = await mkRun(ctxA);
    const { step: sA, token: tA } = await mkStep(ctxA, runA.id, { status: 'failed' });
    const got = [(await retry(ctxB, runA, sA)).status, (await failR(ctxB, runA, sA)).status, (await cancel(ctxB, runA)).status,
      (await report(ctxB, runA, sA, tA, { outcome: 'done' })).status];
    assert.deepEqual(got, [404, 404, 404, 404]);
    assert.deepEqual([(await repos.runner.listSteps(ctxA, runA.id)).map((s) => s.status), (await getRun(ctxA, runA.id)).status], [['failed'], 'running']);
    const strict = await retry(ctxA, runA, sA, { body: { userId: ctxB.userId } });
    assert.deepEqual([strict.status, strict.body?.error?.code, strict.body?.error?.path?.[0]], [422, 'invalid', 'body']);
    const runT = await mkRun(ctxA);
    const { step: sT } = await mkStep(ctxA, runT.id);
    const { step: sN } = await mkStep(ctxA, runT.id, { noToken: true });
    const w = [await report(ctxA, runT, sT, 'wrong', { outcome: 'done' }), await report(ctxA, runT, sT, undefined, { outcome: 'done' }),
      await report(ctxA, runT, sN, 'anything', { outcome: 'done' })];
    assert.deepEqual(w.map((x) => [x.status, x.body?.error?.code]), [[401, 'unauthorized'], [401, 'unauthorized'], [401, 'unauthorized']]);
    assert.equal((await getStep(ctxA, sT.id)).status, 'running');
    const K = `k-${rnd()}`;
    const ra = await retry(ctxA, runA, sA, { headers: KEY(K) });
    const runB = await mkRun(ctxB);
    const { step: sB } = await mkStep(ctxB, runB.id, { status: 'failed' });
    const rb = await retry(ctxB, runB, sB, { headers: KEY(K) });
    assert.deepEqual([ra.status, rb.status, rb.body?.step?.runId === runB.id, rb.body?.step?.retryOfStepId === sB.id], [201, 201, true, true]);
  });

  await check('D2', 'limits pinned and read at call time: key 200/201, summary cut at 20000, reason cut at 2000, config max_failures', async () => {
    assert.deepEqual({ ...W.runsLimits }, { idempotencyKeyMax: 200, summaryMax: 20000, reasonMax: 2000 });
    assert.deepEqual({ ...C.runnerLimits }, { maxFailures: 3 });
    const run = await mkRun(ctxA);
    const k200 = await retry(ctxA, run, (await mkStep(ctxA, run.id, { status: 'failed' })).step, { headers: KEY('k'.repeat(199) + rnd().slice(0, 1)) });
    const k201 = await retry(ctxA, run, (await mkStep(ctxA, run.id, { status: 'failed' })).step, { headers: KEY('k'.repeat(201)) });
    assert.deepEqual([k200.status, k201.status, k201.body?.error?.path], [201, 422, ['headers', 'idempotency-key']]);
    const s1 = await mkStep(ctxA, run.id);
    const s2 = await mkStep(ctxA, run.id);
    await report(ctxA, run, s1.step, s1.token, { outcome: 'done', summary: 'x'.repeat(20001) });
    await report(ctxA, run, s2.step, s2.token, { outcome: 'done', summary: 'y'.repeat(20000) });
    assert.deepEqual([(await getStep(ctxA, s1.step.id)).output.summary.length, (await getStep(ctxA, s2.step.id)).output.summary.length], [20000, 20000]);
    const su = await mkStep(ctxA, run.id, { status: 'start_unknown' });
    await failR(ctxA, run, su.step, { body: { reason: 'r'.repeat(2001) } });
    assert.equal((await getStep(ctxA, su.step.id)).error.length, 2000);
    const saved = W.runsLimits.idempotencyKeyMax;
    try {
      W.runsLimits.idempotencyKeyMax = 5;
      const a = await retry(ctxA, run, (await mkStep(ctxA, run.id, { status: 'failed' })).step, { headers: KEY('abcdef') });
      const b = await retry(ctxA, run, (await mkStep(ctxA, run.id, { status: 'failed' })).step, { headers: KEY(rnd().slice(0, 5)) });
      assert.deepEqual([a.status, b.status], [422, 201]);
    } finally { W.runsLimits.idempotencyKeyMax = saved; }
    try {
      cfg.runner.max_failures = 2;
      const run2 = await mkRun(ctxA);
      const s = await mkStep(ctxA, run2.id, { status: 'failed', attempt: 2, failureCount: 1 });
      const r = await retry(ctxA, run2, s.step);
      assert.deepEqual([r.status, r.body?.error?.code, (await getStep(ctxA, s.step.id)).status], [409, 'conflict', 'circuit_broken']);
    } finally { cfg.runner.max_failures = 3; }
    const run3 = await mkRun(ctxA);
    const s3 = await mkStep(ctxA, run3.id, { status: 'failed', attempt: 2, failureCount: 1 });
    assert.equal((await retry(ctxA, run3, s3.step)).status, 201);
  });

  await check('D3', 'error bodies and statuses; internal = class name only; success bodies; JSON-safe; one send; RunnerError', async () => {
    const nf = await retry(ctxA, { id: 999999999 }, { id: 999999998 });
    assert.deepEqual([nf.status, nf.body?.error?.code, typeof nf.body?.error?.message, nf.sends], [404, 'not_found', 'string', 1]);
    class Boom extends Error {}
    const boomRepos = { ...repos, runner: { ...repos.runner, getStep: async () => { throw new Boom('secret-detail'); }, getRun: async () => { throw new Boom('secret-detail'); } } };
    const broken = W.runsRoutes(mkDeps({ repos: boomRepos }));
    const run = await mkRun(ctxA);
    const { step } = await mkStep(ctxA, run.id, { status: 'failed' });
    const i = await call('retry', { ctx: ctxA, params: sp(run, step) }, broken);
    assert.deepEqual([i.status, i.body], [500, { error: { code: 'internal', message: 'Boom' } }]);
    const rt = await retry(ctxA, run, step);
    assert.deepEqual([rt.status, sorted(Object.keys(rt.body)), rt.body.created, rt.body.enqueued, rt.sends], [201, ['created', 'enqueued', 'step'], true, true, 1]);
    jsonSafe(rt.body);
    const su = await mkStep(ctxA, run.id, { status: 'start_unknown' });
    const f = await failR(ctxA, run, su.step);
    assert.deepEqual([f.status, Object.keys(f.body)], [200, ['step']]);
    const rr = await mkStep(ctxA, run.id);
    const rep = await report(ctxA, run, rr.step, rr.token, { outcome: 'done', summary: 's' });
    assert.deepEqual([rep.status, sorted(Object.keys(rep.body)), rep.body.applied], [200, ['applied', 'step'], true]);
    jsonSafe(rep.body);
    const c = await cancel(ctxA, run);
    assert.deepEqual([c.status, sorted(Object.keys(c.body)), sorted(Object.keys(c.body.run)), c.body.run.status], [200, ['cancelled', 'run'], ['endedAt', 'id', 'status'], 'cancelled']);
    jsonSafe(c.body);
    const e = new C.RunnerError('stale_attempt', 'x');
    assert.deepEqual([e instanceof Error, e.name, e.code], [true, 'RunnerError', 'stale_attempt']);
  });

  await check('D4', 'bad ids 404; other run 404; body 422 with path; bad/duplicate key 422; order params > lookup > headers/token > body', async () => {
    const run = await mkRun(ctxA);
    const { step } = await mkStep(ctxA, run.id, { status: 'failed' });
    const st = async (params, o = {}) => (await call('retry', { ctx: ctxA, params, ...o })).status;
    assert.deepEqual([await st({ rid: 'abc', sid: String(step.id) }), await st({ rid: String(run.id), sid: '1.5' }), await st({ rid: String(run.id), sid: '0' }),
      await st({ rid: String(run.id), sid: `0${step.id}` })], [404, 404, 404, 404]);
    const other = await mkRun(ctxA);
    assert.equal(await st({ rid: String(other.id), sid: String(step.id) }), 404);
    const rr = await mkStep(ctxA, run.id);
    const b = await report(ctxA, run, rr.step, rr.token, { outcome: 'maybe' });
    assert.deepEqual([b.status, b.body?.error?.code, b.body?.error?.path], [422, 'invalid', ['body', 'outcome']]);
    const sp1 = await retry(ctxA, run, step, { headers: KEY('a b') });
    const arr = await retry(ctxA, run, step, { headers: { 'idempotency-key': ['k1', 'k2'] } });
    assert.deepEqual([sp1.status, sp1.body?.error?.path, arr.status], [422, ['headers', 'idempotency-key'], 422]);
    assert.equal(await st({ rid: 'abc', sid: String(step.id) }, { body: { junk: 1 } }), 404);
    const hb = await retry(ctxA, run, step, { headers: KEY('a b'), body: { junk: 1 } });
    assert.deepEqual(hb.body?.error?.path, ['headers', 'idempotency-key']);
    assert.equal((await report(ctxA, run, rr.step, 'wrong', { outcome: 'maybe' })).status, 401);
    assert.equal((await repos.runner.listSteps(ctxA, run.id)).length, 2);
    assert.equal(C.canTransition('nope', 'running'), false);
    const { port, calls } = fakePort();
    await assert.rejects(C.transitionStep(port, ctxA, { stepId: 1, from: 'nope', to: 'running' }), (e) => e.code === 'conflict');
    assert.equal(calls.length, 0);
  });

  await check('D5', 'tolerant: empty/null/no body, no key, header case, report without summary or with extra keys, no-op reports, finished-run cancel', async () => {
    const run = await mkRun(ctxA);
    const bodies = [undefined, null, {}];
    const st = [];
    for (const body of bodies) st.push((await retry(ctxA, run, (await mkStep(ctxA, run.id, { status: 'failed' })).step, { body })).status);
    assert.deepEqual(st, [201, 201, 201]);
    const s = (await mkStep(ctxA, run.id, { status: 'failed' })).step;
    assert.deepEqual([(await retry(ctxA, run, s)).status, (await retry(ctxA, run, s)).body?.error?.code], [201, 'stale_attempt']);
    const s2 = (await mkStep(ctxA, run.id, { status: 'failed' })).step;
    const K = `K-${rnd()}`;
    const first = await retry(ctxA, run, s2, { headers: { 'Idempotency-Key': K } });
    const again = await retry(ctxA, run, s2, { headers: { 'idempotency-key': K } });
    assert.deepEqual([first.status, again.status, again.body?.step?.id === first.body?.step?.id], [201, 201, true]);
    const a = await mkStep(ctxA, run.id);
    const ra = await report(ctxA, run, a.step, a.token, { outcome: 'done' });
    assert.deepEqual([ra.body?.applied, (await getStep(ctxA, a.step.id)).output], [true, { outcome: 'done', summary: null }]);
    const b = await mkStep(ctxA, run.id);
    assert.deepEqual([(await report(ctxA, run, b.step, b.token, { outcome: 'done', foo: 1 }, 'X-CTC-Step-Token')).body?.applied], [true]);
    const w = await mkStep(ctxA, run.id, { status: 'waiting' });
    const rw = await report(ctxA, run, w.step, w.token, { outcome: 'done' });
    assert.deepEqual([rw.status, rw.body?.applied, (await getStep(ctxA, w.step.id)).status], [200, false, 'waiting']);
    const rf = await report(ctxA, run, a.step, a.token, { outcome: 'failed', summary: 'late' });
    assert.deepEqual([rf.status, rf.body?.applied, (await getStep(ctxA, a.step.id)).status], [200, false, 'done']);
    const fin = await mkRun(ctxA, 'done');
    const c = await cancel(ctxA, fin);
    assert.deepEqual([c.status, c.body?.cancelled, (await getRun(ctxA, fin.id)).status], [200, 0, 'done']);
  });

  await check('D6', 'no token/tokenHash in replies; frozen inputs; junk never throws; mismatch/in-progress never exec; 5xx not stored; no direct status writes or I/O in source', async () => {
    const run = await mkRun(ctxA);
    const x = await mkStep(ctxA, run.id);
    const replies = [await report(ctxA, run, x.step, x.token, { outcome: 'done', summary: 'ok' }), await report(ctxA, run, x.step, x.token, { outcome: 'done' })];
    const f = await mkStep(ctxA, run.id, { status: 'failed' });
    replies.push(await retry(ctxA, run, f.step));
    const text = JSON.stringify(replies.map((r) => r.body));
    assert.deepEqual([text.includes(x.token), text.includes(sha(x.token)), text.includes('tokenHash'), text.includes(f.token)], [false, false, false, false]);
    const g = await mkStep(ctxA, run.id, { status: 'failed' });
    const frozen = await call('retry', deepFreeze({ ctx: ctxA, params: sp(run, g.step), body: {}, headers: KEY(`fz-${rnd()}`) }));
    assert.equal(frozen.status, 201);
    for (const name of Object.keys(P)) {
      for (const req of [{}, { params: null, headers: null, body: 'junk' }, { params: { rid: '1', sid: '1' }, headers: { 'idempotency-key': 5 }, body: [] }]) {
        const out = await call(name, req);
        assert.equal(typeof out.status, 'number', `${name} replied`);
        assert.equal(out.sends, 1);
      }
    }
    let n = 0;
    const exec = async () => { n++; return { status: 201, body: { n } }; };
    const route = `POST /chk/${rnd()}`;
    const K = `k6-${rnd()}`;
    await W.withIdempotency({ repos }, ctxA, { key: K, route, payload: { a: 1 } }, exec);
    const mm = await W.withIdempotency({ repos }, ctxA, { key: K, route, payload: { a: 2 } }, exec);
    assert.deepEqual([n, mm.status, mm.body?.error?.code], [1, 409, 'idempotency_mismatch']);
    const K5 = `k5-${rnd()}`;
    const r5 = await W.withIdempotency({ repos }, ctxA, { key: K5, route, payload: {} }, async () => { n++; return { status: 503, body: {} }; });
    assert.deepEqual([r5.status, await repos.idempotency.lookup(ctxA, { key: K5, route })], [503, null]);
    await W.withIdempotency({ repos }, ctxA, { key: K5, route, payload: {} }, exec);
    assert.equal(n, 3);
    const KT = `kt-${rnd()}`;
    await assert.rejects(W.withIdempotency({ repos }, ctxA, { key: KT, route, payload: {} }, async () => { throw new TypeError('x'); }));
    assert.equal(await repos.idempotency.lookup(ctxA, { key: KT, route }), null);
    const web = sources(WEB_DIR);
    assert.deepEqual(web.filter(([, t]) => /runner\s*\.\s*transition\s*\(|setRunStatus\s*\(/.test(t)).map(([p]) => p), []);
    const io = /from\s+['"](node:)?(fs|fs\/promises|child_process|net|http|https)['"]|require\(/;
    assert.deepEqual([...web, ...sources(CORE_DIR)].filter(([, t]) => io.test(t)).map(([p]) => p), []);
  });

  await check('D7', 'non-goals: no approve/continue/run-create/GET routes; a done report leaves the run status; no enqueueStep → enqueued false', async () => {
    assert.deepEqual(routes.filter((r) => r.method !== 'POST' || /approve|continue|\/api\/workflows/.test(r.url)).map((r) => r.url), []);
    const run = await mkRun(ctxA);
    const a = await mkStep(ctxA, run.id);
    await report(ctxA, run, a.step, a.token, { outcome: 'done' });
    assert.equal((await getRun(ctxA, run.id)).status, 'running');
    const bare = W.runsRoutes(mkDeps({ enqueueStep: undefined }));
    const f = await mkStep(ctxA, run.id, { status: 'failed' });
    const r = await call('retry', { ctx: ctxA, params: sp(run, f.step) }, bare);
    assert.deepEqual([r.status, r.body?.enqueued, r.body?.step?.status], [201, false, 'queued']);
  });

  await check('D8', 'judgment: comments mark the silence-rule calls', async () => {
    const all = [...sources(CORE_DIR), ...sources(WEB_DIR)].map(([, t]) => t).join('\n');
    assert.ok(/judgment:/.test(all), 'a judgment: comment in packages/core/src/runner or apps/web/src/runs');
  });

  await check('D9', 'layout: core imports @ctc/shared only as types and no node:*; web imports no zod/fastify and uses the runs schemas; no package.json/lockfile change', async () => {
    const core = sources(CORE_DIR);
    const badCore = core.flatMap(([p, t]) => t.split('\n').filter((l) => /from\s+['"]@ctc\/shared/.test(l) && !/^\s*(import|export)\s+type\b/.test(l)).map((l) => `${p}: ${l.trim()}`));
    assert.deepEqual(badCore, []);
    assert.deepEqual(core.filter(([, t]) => /from\s+['"]node:|import\(\s*['"]node:/.test(t)).map(([p]) => p), []);
    const web = sources(WEB_DIR);
    assert.deepEqual(web.filter(([, t]) => /from\s+['"](zod|fastify)['"]/.test(t)).map(([p]) => p), []);
    assert.ok(web.some(([, t]) => /['"]@ctc\/shared\/schemas\/runs['"]/.test(t)), 'web imports @ctc/shared/schemas/runs');
    const sch = src(SCHEMAS);
    assert.deepEqual([...sch.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]).filter((m) => m !== 'zod' && !m.startsWith('.')), []);
    let clean = true;
    try { execFileSync('git', ['diff', '--quiet', 'HEAD', '--', 'apps/web/package.json', 'packages/core/package.json', 'packages/shared/package.json', 'package.json', 'pnpm-lock.yaml'], { cwd: ROOT }); } catch { clean = false; }
    assert.equal(clean, true);
  });

  await check('D10', 'transition table: exactly the 19 legal pairs of 121; NON_FINAL; frozen', async () => {
    assert.deepEqual(sorted(C.STEP_STATUSES), sorted(STATUSES));
    const wrong = [];
    for (const f of STATUSES) for (const t of STATUSES) if (C.canTransition(f, t) !== LEGAL[f].includes(t)) wrong.push(`${f}->${t}`);
    assert.deepEqual(wrong, []);
    assert.deepEqual(Object.fromEntries(STATUSES.map((s) => [s, sorted(C.TRANSITIONS[s] ?? [])])), Object.fromEntries(STATUSES.map((s) => [s, sorted(LEGAL[s])])));
    assert.deepEqual(sorted(C.NON_FINAL), sorted(['queued', 'running', 'waiting', 'quota', 'start_unknown']));
    assert.equal(Object.isFrozen(C.TRANSITIONS) && Object.values(C.TRANSITIONS).every((v) => Object.isFrozen(v)), true);
  });

  await check('D11', 'transitionStep: illegal → RunnerError conflict with no port call; legal → port.transition once, result returned; DB race → conflict', async () => {
    const f1 = fakePort();
    await assert.rejects(C.transitionStep(f1.port, ctxA, { stepId: 1, from: 'done', to: 'running' }), (e) => e.name === 'RunnerError' && e.code === 'conflict');
    assert.equal(f1.calls.length, 0);
    const sentinel = { id: 1, status: 'running' };
    const f2 = fakePort({ transition: async () => sentinel });
    const got = await C.transitionStep(f2.port, ctxA, { stepId: 1, from: 'queued', to: 'running', patch: { stage: 'worktree' } });
    assert.deepEqual([got === sentinel, f2.calls.length, f2.calls[0]?.[1]?.[1]], [true, 1, { stepId: 1, from: 'queued', to: 'running', patch: { stage: 'worktree' } }]);
    const run = await mkRun(ctxA);
    const { step } = await mkStep(ctxA, run.id, { status: 'running' });
    await assert.rejects(C.transitionStep(repos.runner, ctxA, { stepId: step.id, from: 'queued', to: 'running' }), (e) => e.code === 'conflict');
    assert.equal((await getStep(ctxA, step.id)).status, 'running');
  });

  await check('D12', 'stages: order; forward only with skips and same-stage; advanceStage writes only while running', async () => {
    assert.deepEqual([...C.STAGES], ['worktree', 'setup', 'spawn', 'stream', 'report']);
    const cases = [[null, 'worktree', true], [null, 'spawn', true], ['worktree', 'worktree', true], ['worktree', 'spawn', true], ['setup', 'worktree', false],
      ['report', 'stream', false], [null, 'bogus', false], ['worktree', 'bogus', false]];
    assert.deepEqual(cases.map(([a, b]) => C.canEnterStage(a, b)), cases.map((c) => c[2]));
    const run = await mkRun(ctxA);
    const { step } = await mkStep(ctxA, run.id);
    const s1 = await C.advanceStage(repos.runner, ctxA, step, 'setup');
    assert.equal(s1.stage, 'setup');
    await assert.rejects(C.advanceStage(repos.runner, ctxA, s1, 'worktree'), (e) => e.code === 'conflict');
    assert.equal((await getStep(ctxA, step.id)).stage, 'setup');
    const { step: q } = await mkStep(ctxA, run.id, { status: 'queued' });
    await assert.rejects(C.advanceStage(repos.runner, ctxA, q, 'worktree'), (e) => e.code === 'conflict');
    assert.equal((await getStep(ctxA, q.id)).stage, null);
  });

  await check('D13', 'attempts: exhaustion rule, current attempt, retry inserts n+1, stale/conflict/finished/exhausted refusals, start_unknown superseded, race, enqueue failure', async () => {
    assert.deepEqual([C.isExhausted({ failureCount: 0 }), C.isExhausted({ failureCount: 1 }, 3), C.isExhausted({ failureCount: 2 }, 3), C.isExhausted({ failureCount: 2 })], [false, false, true, true]);
    const s1 = { runId: 1, nodeId: 'a', visit: 1, attempt: 1 }; const s2 = { ...s1, attempt: 2 };
    assert.deepEqual([C.isCurrentAttempt(s1, [s1, s2]), C.isCurrentAttempt(s2, [s1, s2]), C.isCurrentAttempt(s1, [s1, { ...s1, nodeId: 'b', attempt: 5 }]),
      C.isCurrentAttempt(s1, [s1, { ...s1, visit: 2, attempt: 3 }])], [false, true, true, true]);
    const run = await mkRun(ctxA);
    const parent = (await mkStep(ctxA, run.id, { status: 'done' })).step;
    const a1 = (await mkStep(ctxA, run.id, { status: 'failed', parentStepId: parent.id })).step;
    const before = enq.length;
    const r = await retry(ctxA, run, a1);
    const n = r.body?.step;
    assert.deepEqual([r.status, n?.attempt, n?.failureCount, n?.retryOfStepId, n?.status, n?.parentStepId, n?.nodeId, enq.slice(before)],
      [201, 2, 1, a1.id, 'queued', parent.id, a1.nodeId, [n?.id]]);
    assert.equal((await retry(ctxA, run, a1)).body?.error?.code, 'stale_attempt');
    const running = (await mkStep(ctxA, run.id)).step;
    assert.deepEqual([(await retry(ctxA, run, running)).status, (await retry(ctxA, run, running)).body?.error?.code], [409, 'conflict']);
    const su = (await mkStep(ctxA, run.id, { status: 'start_unknown' })).step;
    assert.equal((await retry(ctxA, run, su)).status, 201);
    const old = await getStep(ctxA, su.id);
    assert.deepEqual([old.status, old.error], ['failed', 'superseded by retry']);
    const ex = (await mkStep(ctxA, run.id, { status: 'failed', attempt: 3, failureCount: 2 })).step;
    const re = await retry(ctxA, run, ex);
    assert.deepEqual([re.status, re.body?.error?.code, (await getStep(ctxA, ex.id)).status, (await getRun(ctxA, run.id)).status], [409, 'conflict', 'circuit_broken', 'failed']);
    const fin = await mkRun(ctxA, 'cancelled');
    const ff = (await mkStep(ctxA, fin.id, { status: 'failed' })).step;
    assert.deepEqual([(await retry(ctxA, fin, ff)).status, (await repos.runner.listSteps(ctxA, fin.id)).length], [409, 1]);
    const run2 = await mkRun(ctxA);
    const race = (await mkStep(ctxA, run2.id, { status: 'failed' })).step;
    const b2 = enq.length;
    const both = await Promise.all([retry(ctxA, run2, race), retry(ctxA, run2, race)]);
    const sts = sorted(both.map((x) => x.status));
    assert.ok(sts[0] === 201 || sts[1] === 201, `one 201, got ${sts}`);
    assert.ok(both.every((x) => [200, 201, 409].includes(x.status)));
    assert.deepEqual([(await repos.runner.listSteps(ctxA, run2.id)).length, enq.length - b2], [2, 1]);
    const saved = enqueueImpl;
    try {
      enqueueImpl = async () => { throw new Error('redis down'); };
      const e1 = (await mkStep(ctxA, run2.id, { status: 'failed' })).step;
      const er = await retry(ctxA, run2, e1);
      assert.deepEqual([er.status, er.body?.enqueued, er.body?.step?.status], [201, false, 'queued']);
    } finally { enqueueImpl = saved; }
    await assert.rejects(C.retryStep(repos.runner, ctxB, { stepId: a1.id }), (e) => e.code === 'not_found');
  });

  await check('D14', 'failStep: failed/timeout with error and endedAt; exhaustion → circuit_broken + run failed (unless finished); illegal from done; patch kept; error cut', async () => {
    const run = await mkRun(ctxA);
    const a = (await mkStep(ctxA, run.id)).step;
    const fa = await C.failStep(repos.runner, ctxA, { step: a, to: 'failed', error: 'boom' });
    assert.deepEqual([fa.status, fa.error, fa.endedAt !== null, (await getRun(ctxA, run.id)).status], ['failed', 'boom', true, 'running']);
    const t = (await mkStep(ctxA, run.id, { failureCount: 2, attempt: 3 })).step;
    const ft = await C.failStep(repos.runner, ctxA, { step: t, to: 'timeout' });
    const r = await getRun(ctxA, run.id);
    assert.deepEqual([ft.status, r.status, r.endedAt !== null], ['circuit_broken', 'failed', true]);
    const run2 = await mkRun(ctxA);
    const su = (await mkStep(ctxA, run2.id, { status: 'start_unknown' })).step;
    assert.equal((await C.failStep(repos.runner, ctxA, { step: su, to: 'failed' })).status, 'failed');
    const d = (await mkStep(ctxA, run2.id, { status: 'done' })).step;
    await assert.rejects(C.failStep(repos.runner, ctxA, { step: d, to: 'failed' }), (e) => e.code === 'conflict');
    const p = (await mkStep(ctxA, run2.id)).step;
    const fp = await C.failStep(repos.runner, ctxA, { step: p, to: 'failed', error: 'e'.repeat(2001), patch: { stage: 'report' } });
    assert.deepEqual([fp.stage, fp.error.length], ['report', 2000]);
    const run3 = await mkRun(ctxA, 'cancelled');
    const c3 = (await mkStep(ctxA, run3.id, { failureCount: 2, attempt: 3 })).step;
    assert.deepEqual([(await C.failStep(repos.runner, ctxA, { step: c3, to: 'failed' })).status, (await getRun(ctxA, run3.id)).status], ['circuit_broken', 'cancelled']);
  });

  await check('D15', 'report: applies done once; duplicate no-op; stale 409 unchanged; token before stale; failed outcome; third failure; concurrent reports', async () => {
    const run = await mkRun(ctxA);
    const a = await mkStep(ctxA, run.id);
    const r1 = await report(ctxA, run, a.step, a.token, { outcome: 'done', summary: 's' });
    const row = await getStep(ctxA, a.step.id);
    assert.deepEqual([r1.status, r1.body?.applied, row.status, row.stage, row.output, row.endedAt !== null], [200, true, 'done', 'report', { outcome: 'done', summary: 's' }, true]);
    const r2 = await report(ctxA, run, a.step, a.token, { outcome: 'done', summary: 'other' });
    assert.deepEqual([r2.status, r2.body?.applied, await getStep(ctxA, a.step.id)], [200, false, row]);
    const node = `n-${rnd()}`;
    const o1 = await mkStep(ctxA, run.id, { nodeId: node, attempt: 1 });
    await mkStep(ctxA, run.id, { nodeId: node, attempt: 2, failureCount: 1 });
    const st = await report(ctxA, run, o1.step, o1.token, { outcome: 'done' });
    assert.deepEqual([st.status, st.body?.error?.code, (await getStep(ctxA, o1.step.id)).status], [409, 'stale_attempt', 'running']);
    assert.equal((await report(ctxA, run, o1.step, 'wrong', { outcome: 'done' })).status, 401);
    const f = await mkStep(ctxA, run.id);
    await report(ctxA, run, f.step, f.token, { outcome: 'failed', summary: 'bad' });
    const fr = await getStep(ctxA, f.step.id);
    assert.deepEqual([fr.status, fr.error, fr.output, fr.stage], ['failed', 'bad', { outcome: 'failed', summary: 'bad' }, 'report']);
    const g = await mkStep(ctxA, run.id);
    await report(ctxA, run, g.step, g.token, { outcome: 'failed' });
    assert.equal((await getStep(ctxA, g.step.id)).error, 'reported failed');
    const run2 = await mkRun(ctxA);
    const third = await mkStep(ctxA, run2.id, { attempt: 3, failureCount: 2 });
    await report(ctxA, run2, third.step, third.token, { outcome: 'failed', summary: 'x' });
    assert.deepEqual([(await getStep(ctxA, third.step.id)).status, (await getRun(ctxA, run2.id)).status], ['circuit_broken', 'failed']);
    const c = await mkStep(ctxA, run.id);
    const both = await Promise.all([report(ctxA, run, c.step, c.token, { outcome: 'done' }), report(ctxA, run, c.step, c.token, { outcome: 'done' })]);
    assert.deepEqual(sorted(both.map((x) => String(x.body?.applied))), ['false', 'true']);
  });

  await check('D16', 'fail route: start_unknown → failed (default text, reason); running 409 conflict; old attempt 409 stale; exhausted → circuit_broken + run failed', async () => {
    const run = await mkRun(ctxA);
    const a = (await mkStep(ctxA, run.id, { status: 'start_unknown' })).step;
    const r = await failR(ctxA, run, a);
    assert.deepEqual([r.status, r.body?.step?.status, r.body?.step?.error], [200, 'failed', 'marked failed by user']);
    const b = (await mkStep(ctxA, run.id, { status: 'start_unknown' })).step;
    assert.equal((await failR(ctxA, run, b, { body: { reason: 'gone' } })).body?.step?.error, 'gone');
    const c = (await mkStep(ctxA, run.id)).step;
    const rc = await failR(ctxA, run, c);
    assert.deepEqual([rc.status, rc.body?.error?.code], [409, 'conflict']);
    const node = `n-${rnd()}`;
    const old = (await mkStep(ctxA, run.id, { nodeId: node, status: 'start_unknown' })).step;
    await mkStep(ctxA, run.id, { nodeId: node, attempt: 2, failureCount: 1, status: 'queued' });
    assert.equal((await failR(ctxA, run, old)).body?.error?.code, 'stale_attempt');
    const ex = (await mkStep(ctxA, run.id, { status: 'start_unknown', attempt: 3, failureCount: 2 })).step;
    const re = await failR(ctxA, run, ex);
    assert.deepEqual([re.status, re.body?.step?.status, (await getRun(ctxA, run.id)).status], [200, 'circuit_broken', 'failed']);
  });

  await check('D17', 'cancel: the five non-final statuses → cancelled with endedAt, the rest untouched; run cancelled; second cancel is a no-op', async () => {
    const run = await mkRun(ctxA);
    const all = ['queued', 'running', 'waiting', 'quota', 'start_unknown', 'done', 'failed', 'timeout', 'circuit_broken', 'skipped'];
    const ids = {};
    for (const s of all) ids[s] = (await mkStep(ctxA, run.id, { status: s })).step.id;
    const c = await cancel(ctxA, run);
    assert.deepEqual([c.status, c.body?.cancelled, c.body?.run?.status, typeof c.body?.run?.endedAt], [200, 5, 'cancelled', 'string']);
    const now = Object.fromEntries(await Promise.all(all.map(async (s) => [s, (await getStep(ctxA, ids[s])).status])));
    assert.deepEqual(now, { queued: 'cancelled', running: 'cancelled', waiting: 'cancelled', quota: 'cancelled', start_unknown: 'cancelled',
      done: 'done', failed: 'failed', timeout: 'timeout', circuit_broken: 'circuit_broken', skipped: 'skipped' });
    assert.equal((await getStep(ctxA, ids.queued)).endedAt !== null, true);
    const runRow = await getRun(ctxA, run.id);
    const c2 = await cancel(ctxA, run);
    assert.deepEqual([c2.status, c2.body?.cancelled, await getRun(ctxA, run.id)], [200, 0, runRow]);
    const run2 = await mkRun(ctxA, 'waiting');
    await mkStep(ctxA, run2.id, { status: 'waiting' });
    const cr = await C.cancelRun(repos.runner, ctxA, run2.id);
    assert.deepEqual([cr.cancelled, cr.run?.status], [1, 'cancelled']);
  });

  await check('D18', 'withIdempotency: no key runs; first stores {status, body}; same payload (any key order) replays; mismatch / other route / pending → 409 without exec; 4xx stored; routes replay', async () => {
    let n = 0;
    const exec = async () => { n++; return { status: 201, body: { v: n } }; };
    const route = `POST /chk/${rnd()}`;
    await W.withIdempotency({ repos }, ctxA, { key: undefined, route, payload: {} }, exec);
    const nk = await W.withIdempotency({ repos }, ctxA, { key: undefined, route, payload: {} }, exec);
    assert.deepEqual([n, nk.replayed], [2, false]);
    const K1 = `k1-${rnd()}`;
    const p = { a: 1, b: [1, 2] };
    const first = await W.withIdempotency({ repos }, ctxA, { key: K1, route, payload: p }, exec);
    assert.deepEqual(first, { status: 201, body: { v: 3 }, replayed: false });
    assert.deepEqual(await repos.idempotency.lookup(ctxA, { key: K1, route }), { payloadHash: W.payloadHash(p), response: { status: 201, body: { v: 3 } } });
    const again = await W.withIdempotency({ repos }, ctxA, { key: K1, route, payload: { b: [1, 2], a: 1 } }, exec);
    assert.deepEqual([again, n], [{ status: 201, body: { v: 3 }, replayed: true }, 3]);
    const mm = await W.withIdempotency({ repos }, ctxA, { key: K1, route, payload: { a: 2, b: [1, 2] } }, exec);
    const other = await W.withIdempotency({ repos }, ctxA, { key: K1, route: `${route}/x`, payload: p }, exec);
    assert.deepEqual([mm.status, mm.body?.error?.code, mm.replayed, other.status, other.body?.error?.code, n], [409, 'idempotency_mismatch', false, 409, 'idempotency_mismatch', 3]);
    assert.deepEqual([/^[0-9a-f]{64}$/.test(W.payloadHash(p)), W.payloadHash({ x: [1, 2] }) === W.payloadHash({ x: [2, 1] }),
      W.payloadHash({ a: 1, b: undefined }) === W.payloadHash({ a: 1 }), W.payloadHash({ o: { y: 1, z: 2 } }) === W.payloadHash({ o: { z: 2, y: 1 } })], [true, false, true, true]);
    const K3 = `k3-${rnd()}`;
    await repos.idempotency.store(ctxA, { key: K3, route, payloadHash: W.payloadHash(p), response: { status: 0 } });
    const pend = await W.withIdempotency({ repos }, ctxA, { key: K3, route, payload: p }, exec);
    assert.deepEqual([pend.status, pend.body?.error?.code, n], [409, 'conflict', 3]);
    const K4 = `k4-${rnd()}`;
    const e409 = async () => { n++; return { status: 409, body: { error: { code: 'conflict', message: 'm' } } }; };
    await W.withIdempotency({ repos }, ctxA, { key: K4, route, payload: {} }, e409);
    const r4 = await W.withIdempotency({ repos }, ctxA, { key: K4, route, payload: {} }, e409);
    assert.deepEqual([r4.status, r4.replayed, n], [409, true, 4]);
    const run = await mkRun(ctxA);
    const s = (await mkStep(ctxA, run.id, { status: 'failed' })).step;
    const KR = `kr-${rnd()}`;
    const b = enq.length;
    const x1 = await retry(ctxA, run, s, { headers: KEY(KR) });
    const x2 = await retry(ctxA, run, s, { headers: KEY(KR) });
    assert.deepEqual([x1.status, x2.status, x2.body, (await repos.runner.listSteps(ctxA, run.id)).length, enq.length - b], [201, 201, x1.body, 2, 1]);
    assert.equal((await repos.idempotency.lookup(ctxA, { key: KR, route: P.retry }))?.payloadHash, W.payloadHash({ params: sp(run, s), body: null }));
    const su = (await mkStep(ctxA, run.id, { status: 'start_unknown' })).step;
    const KF = `kf-${rnd()}`;
    const f1 = await failR(ctxA, run, su, { headers: KEY(KF) });
    const f2 = await failR(ctxA, run, su, { headers: KEY(KF) });
    assert.deepEqual([f1.status, f2.status, f2.body], [200, 200, f1.body]);
    const KC = `kc-${rnd()}`;
    const c1 = await cancel(ctxA, run, { headers: KEY(KC) });
    const c2 = await cancel(ctxA, run, { headers: KEY(KC) });
    assert.deepEqual([c1.status, c2.body], [200, c1.body]);
  });

  await check('D19', 'runnerJobId: spec string, node id escaping, deterministic, bullJobId has no colon', async () => {
    const id = C.runnerJobId({ runId: 7, nodeId: 'n1', visit: 2, attempt: 3 });
    assert.equal(id, 'run:7:node:n1:visit:2:attempt:3');
    assert.equal(C.runnerJobId({ runId: 1, nodeId: 'a:b%c', visit: 1, attempt: 1 }), 'run:1:node:a%3Ab%25c:visit:1:attempt:1');
    assert.equal(C.runnerJobId({ runId: 7, nodeId: 'n1', visit: 2, attempt: 3 }), id);
    assert.notEqual(C.runnerJobId({ runId: 7, nodeId: 'n1', visit: 2, attempt: 4 }), id);
    assert.equal(Q.bullJobId(id).includes(':'), false);
  });

  await check('D20', 'http error codes added; idempotency.settle/release only touch pending receipts of the caller; tenancy cases present', async () => {
    const st = ['stale_attempt', 'idempotency_mismatch', 'unauthorized'].map((c) => H.statusOf(new H.ApiError(c, 'm')));
    assert.deepEqual(st, [409, 409, 401]);
    assert.deepEqual(H.errorBody(new H.ApiError('stale_attempt', 'm')), { error: { code: 'stale_attempt', message: 'm' } });
    const route = `POST /chk20/${rnd()}`;
    const K = `s-${rnd()}`;
    await repos.idempotency.store(ctxA, { key: K, route, payloadHash: 'h', response: { status: 0 } });
    assert.deepEqual([await repos.idempotency.settle(ctxB, { key: K, route, response: { status: 200, body: 'b' } }), await repos.idempotency.release(ctxB, { key: K, route })], [false, false]);
    assert.equal(await repos.idempotency.settle(ctxA, { key: K, route, response: { status: 201, body: { ok: 1 } } }), true);
    assert.equal(await repos.idempotency.settle(ctxA, { key: K, route, response: { status: 500, body: null } }), false);
    assert.deepEqual((await repos.idempotency.lookup(ctxA, { key: K, route }))?.response, { status: 201, body: { ok: 1 } });
    assert.equal(await repos.idempotency.release(ctxA, { key: K, route }), false);
    assert.notEqual(await repos.idempotency.lookup(ctxA, { key: K, route }), null);
    const K2 = `p-${rnd()}`;
    await repos.idempotency.store(ctxA, { key: K2, route, payloadHash: 'h', response: { status: 0 } });
    assert.deepEqual([await repos.idempotency.release(ctxA, { key: K2, route }), await repos.idempotency.lookup(ctxA, { key: K2, route })], [true, null]);
    const cases = src(CASES);
    const block = cases.slice(cases.indexOf('idempotency: {'));
    assert.deepEqual([/\bsettle\s*:/.test(block.slice(0, 2000)), /\brelease\s*:/.test(block.slice(0, 2000))], [true, true]);
  });

  await check('D21', 'stepJson: exact keys, ISO dates, nothing secret', async () => {
    const run = await mkRun(ctxA);
    const { step } = await mkStep(ctxA, run.id);
    const j = W.stepJson(await getStep(ctxA, step.id));
    assert.deepEqual(sorted(Object.keys(j)), sorted(['id', 'runId', 'nodeId', 'visit', 'attempt', 'retryOfStepId', 'failureCount', 'parentStepId', 'status', 'stage',
      'liveness', 'promptOutcome', 'resolution', 'output', 'error', 'startedAt', 'endedAt']));
    assert.deepEqual([typeof j.startedAt, !Number.isNaN(Date.parse(j.startedAt)), j.endedAt, j.id, j.status], ['string', true, null, step.id, 'running']);
    jsonSafe(j);
  });

  await check('D22', 'gate test files exist with describe(runner.lifecycle) / describe(runner.idempotent) and the exact test names', async () => {
    const need = [[GATE_LIFE, 'runner.lifecycle', ['every illegal from-to transition is rejected', 'a duplicate report is a no-op', 'a report from an old attempt gets 409 stale_attempt']],
      [GATE_IDEM, 'runner.idempotent', ['same key and same payload replays the stored response', 'same key with a different payload gets 409 idempotency_mismatch']]];
    const missing = [];
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const [file, d, names] of need) {
      if (!fs.existsSync(path.join(ROOT, file))) { missing.push(file); continue; }
      const text = src(file);
      if (!new RegExp(`describe\\(\\s*['"\`]${esc(d)}['"\`]`).test(text)) missing.push(`${file}: describe('${d}')`);
      for (const n of names) if (!new RegExp(`\\b(it|test)\\(\\s*['"\`]${esc(n)}['"\`]`).test(text)) missing.push(`${file}: ${n}`);
    }
    assert.deepEqual(missing, []);
  });
} catch (e) {
  console.log(`note: checks stopped early: ${e?.name}: ${e?.message}`);
}
await finish();
