// checks for T1.4 cache, epochs, ctc:inval, queues, dlq-retry, systemd units: one runnable example per decision id (D0..D23).
// Prints `PASS D# ...` or `FAIL D# expected=<..> got=<..>`; last line `CHECKS: <n> pass, <m> fail`; exit 1 on any FAIL.
// Needs: env CTC_SCRATCH_REDIS_URL (scratch Redis 127.0.0.1:18395 only). Run from the repo root:
//   node --import tsx agent/t1-4-cache-queues/checks.mjs      (tsx lets Node import the .ts sources)
// Every check uses its own key namespace and removes only its own keys. Fixture values are this file's own.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(new URL('../../', import.meta.url).pathname);
const CACHE = 'packages/shared/src/cache';
const QUEUES_DIR = 'packages/shared/src/queues';
const WORKER = 'apps/worker/src/jobs';
const UNITS = 'deploy/systemd';
const IDS = Array.from({ length: 24 }, (_, i) => `D${i}`);
let pass = 0; let fail = 0;
const done = new Set();
const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
function ok(id, msg) { pass++; done.add(id); console.log(`PASS ${id} ${msg}`); }
function bad(id, expected, got) { fail++; done.add(id); console.log(`FAIL ${id} expected=${show(expected)} got=${show(got)}`); }
async function check(id, msg, fn) {
  try { await fn(); ok(id, msg); } catch (e) {
    if (e && e.name === 'AssertionError') bad(id, e.expected, e.actual); else bad(id, msg, `${e?.name}: ${e?.message}`);
  }
}
function finish() {
  for (const id of IDS) if (!done.has(id)) bad(id, 'a check', 'missing');
  console.log(`CHECKS: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
function failAll(why) { for (const id of IDS) bad(id, 'modules importable and scratch Redis ready', why); finish(); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000, step = 25) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await sleep(step); }
}
const rnd = () => randomBytes(4).toString('hex');
const sha1 = (s) => createHash('sha1').update(s).digest('hex');

// ---- load -----------------------------------------------------------------------------------------------------------
const url = process.env.CTC_SCRATCH_REDIS_URL;
if (!url) failAll('env CTC_SCRATCH_REDIS_URL not set');
const ru = new URL(url);
if (ru.hostname !== '127.0.0.1' || ru.port !== '18395') failAll(`refusing ${ru.hostname}:${ru.port}, only the scratch Redis 127.0.0.1:18395`);
const DEAD = 'redis://127.0.0.1:1';
const load = async (rel) => import(pathToFileURL(path.join(ROOT, rel, 'index.ts')).href);
let C; let Q; let W;
try {
  C = await load(CACHE); Q = await load(QUEUES_DIR); W = await load(WORKER);
} catch (e) { failAll(`module not importable: ${e?.code ?? e?.name}: ${String(e?.message).split('\n')[0]}`); }
const req = createRequire(path.join(ROOT, 'packages/shared/package.json'));
let IORedis; let UnrecoverableError;
try { IORedis = req('ioredis'); ({ UnrecoverableError } = req('bullmq')); } catch (e) { failAll(`ioredis/bullmq not installed: ${e?.message}`); }
const raw = new IORedis(url, { maxRetriesPerRequest: 1 });
const namespaces = []; const closers = [];
const newNs = () => { const ns = `t14chk${rnd()}:`; namespaces.push(ns); return ns; };
const mkCache = (ns, extra = {}) => { const c = C.createCache({ url, namespace: ns, ...extra }); closers.push(() => c.close()); return c; };
const mkQueues = (ns, u = url) => { const q = Q.createQueues({ url: u, namespace: ns }); closers.push(() => q.close()); return q; };
const llmPayload = { userId: 'u1', capId: 'c1' };

function fakePort() {
  const rows = new Map(); const log = [];
  const port = {
    rows, log,
    add(id, queue, kind, payload, status = 'queued', attempts = 0, updatedAt = new Date()) {
      rows.set(id, { id, queue, kind, status, payload, attempts, userId: 'u1', updatedAt });
    },
    async listQueued(limit) { return [...rows.values()].filter((r) => r.status === 'queued').slice(0, limit); },
    async markRunning(id) { const r = rows.get(id); if (!r || r.status === 'done' || r.status === 'dead') return false; r.status = 'running'; r.attempts++; log.push(['running', id]); return true; },
    async markDone(id, result) { rows.get(id).status = 'done'; log.push(['done', id, result]); },
    async markFailed(id, error) { const r = rows.get(id); r.status = 'failed'; r.error = error; log.push(['failed', id, error]); },
    async markDead(id, error) { const r = rows.get(id); if (r) { r.status = 'dead'; r.error = error; } log.push(['dead', id, error]); },
    async markQueued(id) { const r = rows.get(id); if (r) r.status = 'queued'; log.push(['queued', id]); },
    async setProgress(id, p) { log.push(['progress', id, p]); },
  };
  return port;
}

try {
  await check('D0', 'the three modules export their public names', async () => {
    const want = { C: ['createCache', 'keys', 'ttl', 'cacheLimits'], Q: ['QUEUES', 'payloads', 'parsePayload', 'timeoutMs', 'bullJobId', 'createQueues', 'submitJob', 'queueLimits'], W: ['startWorkers', 'runAttempt', 'pollOnce', 'dlqRetryOnce'] };
    const mods = { C, Q, W };
    const missing = Object.entries(want).flatMap(([m, names]) => names.filter((n) => !(n in mods[m])).map((n) => `${m}.${n}`));
    assert.deepEqual(missing, []);
  });

  await check('D1', 'key parts validated; poisoned L2 value is a miss and is deleted; bad payload rejected', async () => {
    assert.throws(() => C.keys.sug('u:1', 'p1', 'x', 'e1'), (e) => e instanceof TypeError && /invalid key part/.test(e.message));
    assert.throws(() => C.keys.ovr('', 'p1'), TypeError);
    assert.equal(C.keys.proj('u1', '/a:b/c'), 'proj:u1:/a:b/c'); // free-form last part may hold colons
    const ns = newNs(); const c = mkCache(ns);
    await raw.set(`${ns}emb:poison`, '{not json');
    assert.equal(await c.get('emb:poison'), undefined);
    assert.equal(await raw.exists(`${ns}emb:poison`), 0);
    assert.throws(() => Q.parsePayload('llm', 'enrich', { userId: 'u1', capId: 7 }), (e) => e.code === 'invalid');
  });

  await check('D2', 'limits pinned; L1 keeps 256 -> here 3 (equal valid), the 4th evicts the oldest', async () => {
    assert.deepEqual(C.cacheLimits, { l1Max: 256, redisTimeoutMs: 20, downForMs: 10000, l1MaxAgeS: 60, epochMemoMs: 5000, epochStaleS: 60, epochTtlS: 2592000, rateLimitPerMin: 600, rateWindowS: 60 });
    assert.deepEqual(C.ttl, { emb: 604800, sug: 3600, proj: 86400, ovr: 300, ctx: 600, key: 300, keyMiss: 60, rl: 60 });
    for (const [k, v] of Object.entries({ submitTimeoutMs: 1000, pollEveryMs: 5000, staleAfterMs: 10000, dlqEveryMs: 600000, dlqMaxRetries: 5, dlqScan: 200, closeGraceMs: 5000, removeOnCompleteCount: 100, removeOnFailAgeS: 604800, retryWriteTries: 3 })) {
      assert.equal(Q.queueLimits[k], v, k);
    }
    const keep = C.cacheLimits.l1Max; const c = mkCache(newNs(), { url: DEAD });
    try {
      C.cacheLimits.l1Max = 3;
      for (const k of ['k1', 'k2', 'k3']) await c.set(k, k, 60);
      assert.deepEqual([await c.get('k1'), await c.get('k2'), await c.get('k3')], ['k1', 'k2', 'k3']); // equal is valid; k1 is now least recently used
      await c.set('k4', 'k4', 60);
      assert.deepEqual([await c.get('k1'), await c.get('k4')], [undefined, 'k4']);
    } finally { C.cacheLimits.l1Max = keep; }
  });

  await check('D3', 'exact key, token, queue-name and job-id formats', async () => {
    const h = sha1('hello');
    assert.equal(h, 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
    assert.equal(C.keys.emb('hello'), `emb:${h}`);
    assert.equal(C.keys.sug('u1', 'p1', 'hello', 'e5'), `sug:u1:p1:${h}:e5`);
    assert.equal(C.keys.proj('u1', '/home/x/y'), 'proj:u1:/home/x/y');
    assert.equal(C.keys.ovr('u1', 'p1'), 'ovr:u1:p1');
    assert.equal(C.keys.ctx('u1', 'p1', 'm3'), 'ctx:u1:p1:m3');
    assert.equal(C.keys.key('abc'), 'key:abc');
    assert.equal(C.keys.rl('u1', 28000000), 'rl:u1:28000000');
    assert.deepEqual(Object.keys(Q.QUEUES).sort(), ['cleanup', 'dlq-retry', 'graph', 'library', 'llm', 'memory', 'runner']);
    assert.equal(Q.bullJobId('run:r1:node:n1:visit:1:attempt:2'), 'j|run|r1|node|n1|visit|1|attempt|2');
    assert.equal(Q.bullJobId('a|b:c%d'), 'j|a%7Cb|c%25d');
    assert.notEqual(Q.bullJobId('a:b'), Q.bullJobId('a|b'));
    const ns = newNs(); const c = mkCache(ns);
    const t = await c.epoch.get('graph', 'u1', 'p1');
    assert.match(String(t), /^[0-9a-f]{12}$/);
  });

  await check('D4', 'submitJob rejects bad queue/kind/payload before create and Redis; bad ttl throws', async () => {
    const ns = newNs(); const q = mkQueues(ns); let created = 0;
    const deps = { queues: q, create: async (row) => { created++; return { id: row.id, created: true }; } };
    for (const input of [{ queue: 'llm', kind: 'enrich', payload: { userId: 'u1' } }, { queue: 'llm', kind: 'nope', payload: {} }, { queue: 'zzz', kind: 'x', payload: {} }]) {
      await assert.rejects(() => Q.submitJob(deps, input), (e) => e instanceof Q.PayloadInvalidError && e.code === 'invalid' && Array.isArray(e.issues) && e.issues.length >= 1);
    }
    assert.equal(created, 0);
    assert.equal((await q.get('llm').getJobCounts('waiting')).waiting, 0);
    const c = mkCache(ns);
    await assert.rejects(() => c.set('k', 1, Number.NaN), TypeError);
  });

  await check('D5', 'null/false/0/empty are real values; ttl<=0 stores nothing; same id twice = one job', async () => {
    const ns = newNs(); const a = mkCache(ns); const b = mkCache(ns);
    for (const [i, v] of [null, false, 0, ''].entries()) { await a.set(`bundle:v${i}`, v, 60); assert.equal(await b.get(`bundle:v${i}`), v); }
    await a.set('bundle:zero', 1, 0);
    assert.equal(await raw.exists(`${ns}bundle:zero`), 0);
    assert.equal(await a.get('bundle:zero'), undefined);
    await a.set('bundle:frac', 1, 0.5);
    assert.equal(await raw.ttl(`${ns}bundle:frac`), 1);
    await a.close(); await a.close();
    const q = mkQueues(ns); const deps = { queues: q, create: async (row) => ({ id: row.id, created: !deps.seen++ }) }; deps.seen = 0;
    const id = crypto.randomUUID();
    const r1 = await Q.submitJob(deps, { queue: 'llm', kind: 'enrich', payload: llmPayload, id });
    const r2 = await Q.submitJob(deps, { queue: 'llm', kind: 'enrich', payload: llmPayload, id });
    assert.deepEqual([r1.created, r2.created, r2.id], [true, false, id]);
    assert.equal((await q.get('llm').getJobCounts('waiting')).waiting, 1);
  });

  await check('D6', 'Redis down: fast misses, no throw, no values in logs; no FLUSH/KEYS in the source', async () => {
    const logs = []; const c = mkCache(newNs(), { url: DEAD, log: (m, f) => logs.push(`${m} ${JSON.stringify(f ?? {})}`) });
    await c.set('sug:u1:p1:x:e1', { secret: 'SECRETVALUE-xyz' }, 60);
    const t = Date.now();
    for (let i = 0; i < 5; i++) assert.equal(await c.get(`bundle:other${i}`), undefined);
    assert.ok(Date.now() - t < 150, `5 misses took ${Date.now() - t} ms`);
    assert.equal(logs.join('\n').includes('SECRETVALUE'), false);
    const bad = [];
    for (const dir of [CACHE, QUEUES_DIR, WORKER]) for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      const src = fs.readFileSync(path.join(ROOT, dir, f), 'utf8');
      if (/\bflush(db|all)\b/i.test(src) || /\.keys\(\s*['"`]/.test(src) || /['"]KEYS['"]/.test(src)) bad.push(`${dir}/${f}`);
    }
    assert.deepEqual(bad, []);
  });

  await check('D7', 'non-goals: no SQL imports, no built-in job handlers, no semantic cache', async () => {
    const bad = [];
    for (const dir of [CACHE, QUEUES_DIR, WORKER]) for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      if (/from\s+['"](pg|kysely)['"]/.test(fs.readFileSync(path.join(ROOT, dir, f), 'utf8'))) bad.push(`${dir}/${f}`);
    }
    assert.deepEqual(bad, []);
    const w = await W.startWorkers({ url, namespace: newNs(), port: fakePort(), handlers: {}, poll: false, dlq: false });
    assert.deepEqual(w.queues, []);
    await w.close();
    assert.equal(typeof C.createSemanticCache, 'undefined');
  });

  await check('D8', 'tolerant: unknown key is a miss, epoch null when Redis is down, handler-less row left alone', async () => {
    const c = mkCache(newNs(), { url: DEAD });
    assert.equal(await c.get('bundle:unknown'), undefined);
    assert.equal(await c.epoch.get('graph', 'u1', 'p1'), null);
    const port = fakePort(); port.add('r1', 'llm', 'summarize', { userId: 'u1', sessionId: 's1' });
    const res = await W.pollOnce({ port, queues: mkQueues(newNs(), DEAD), handlers: {}, isRedisUp: async () => false });
    assert.deepEqual([res.ran, port.rows.get('r1').status, port.rows.get('r1').attempts], [[], 'queued', 0]);
  });

  await check('D9', 'layout: files exist, units exist, namespace prefixes keys and BullMQ', async () => {
    const need = [`${CACHE}/index.ts`, `${CACHE}/keys.ts`, `${CACHE}/limits.ts`, `${CACHE}/epoch.ts`, `${CACHE}/inval.ts`, `${QUEUES_DIR}/index.ts`, `${QUEUES_DIR}/defs.ts`, `${QUEUES_DIR}/payloads.ts`, `${QUEUES_DIR}/submit.ts`,
      `${WORKER}/index.ts`, `${WORKER}/consumers.ts`, `${WORKER}/poller.ts`, `${WORKER}/dlq-retry.ts`, `${UNITS}/ctc-web.service`, `${UNITS}/ctc-worker.service`];
    assert.deepEqual(need.filter((f) => !fs.existsSync(path.join(ROOT, f))), []);
    const ns = newNs(); const c = mkCache(ns); const q = mkQueues(ns);
    await c.set('bundle:ns', 1, 60);
    await Q.submitJob({ queues: q, create: async (r) => ({ id: r.id, created: true }) }, { queue: 'llm', kind: 'enrich', payload: llmPayload });
    assert.equal(await raw.exists(`${ns}bundle:ns`), 1);
    const [, found] = await raw.scan('0', 'MATCH', `${ns}bull:*`, 'COUNT', 1000);
    assert.ok(found.length > 0, 'BullMQ keys carry the namespace prefix');
    assert.equal(await raw.exists('bundle:ns'), 0);
  });

  await check('D10', 'L2 hit fills L1; L1 survives an L2 delete; del clears both; vectors are 4,096 raw bytes; L1 expiry capped', async () => {
    const ns = newNs(); const a = mkCache(ns); const b = mkCache(ns);
    await a.set('bundle:x', { n: 1 }, 60);
    assert.deepEqual(await b.get('bundle:x'), { n: 1 });
    await raw.del(`${ns}bundle:x`);
    assert.deepEqual(await b.get('bundle:x'), { n: 1 });
    await b.del('bundle:x');
    assert.equal(await b.get('bundle:x'), undefined);
    const v = Float32Array.from({ length: 1024 }, (_, i) => i / 1000);
    await a.setVec('emb:v', v, 60);
    assert.equal(await raw.strlen(`${ns}emb:v`), 4096);
    const got = await b.getVec('emb:v');
    assert.ok(got instanceof Float32Array && got.length === 1024 && Math.abs(got[5] - 0.005) < 1e-6);
    const keep = C.cacheLimits.l1MaxAgeS;
    try {
      C.cacheLimits.l1MaxAgeS = 1;
      await a.set('bundle:age', 1, 600); await raw.del(`${ns}bundle:age`);
      assert.equal(await a.get('bundle:age'), 1);
      await sleep(1200);
      assert.equal(await a.get('bundle:age'), undefined);
    } finally { C.cacheLimits.l1MaxAgeS = keep; }
  });

  await check('D11', 'a Redis that never answers opens the breaker for downForMs, then one probe', async () => {
    const srv = net.createServer(() => {}); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const keep = C.cacheLimits.downForMs;
    try {
      C.cacheLimits.downForMs = 300;
      const c = mkCache(newNs(), { url: `redis://127.0.0.1:${srv.address().port}` });
      assert.equal(await c.get('bundle:k'), undefined);
      assert.equal(c.up, false);
      const t = Date.now(); assert.equal(await c.get('bundle:k2'), undefined);
      assert.ok(Date.now() - t < 10, `second call took ${Date.now() - t} ms while down`);
      await sleep(350);
      assert.equal(c.up, true);
      assert.equal(await c.get('bundle:k3'), undefined);
      assert.equal(c.up, false);
      const live = mkCache(newNs()); await live.get('bundle:nope'); assert.equal(live.up, true);
    } finally { C.cacheLimits.downForMs = keep; srv.close(); }
  });

  await check('D12', 'epochs: stable token, rotate changes it for every process, null when unknown, stale memo when down', async () => {
    const keep = { ...C.cacheLimits };
    try {
      C.cacheLimits.epochMemoMs = 0;
      const ns = newNs(); const a = mkCache(ns); const b = mkCache(ns);
      const t1 = await a.epoch.get('graph', 'u1', 'p1');
      assert.equal(await a.epoch.get('graph', 'u1', 'p1'), t1);
      const t2 = await a.epoch.rotate('graph', 'u1', 'p1');
      assert.match(String(t2), /^[0-9a-f]{12}$/); assert.notEqual(t2, t1);
      assert.equal(await b.epoch.get('graph', 'u1', 'p1'), t2);
      assert.notEqual(await b.epoch.get('mem', 'u1', 'p1'), t2);
      assert.equal(await mkCache(newNs(), { url: DEAD }).epoch.get('graph', 'u1', 'p1'), null);
      C.cacheLimits.downForMs = 100;
      const d = mkCache(ns); const t = await d.epoch.get('graph', 'u1', 'p1');
      await raw.call('CLIENT', 'PAUSE', '400', 'ALL');
      assert.equal(await d.epoch.get('graph', 'u1', 'p1'), t); // Redis stalled past 20 ms: stale memo, not null
      await sleep(450);
    } finally { Object.assign(C.cacheLimits, keep); }
  });

  await check('D13', 'inval: delivered, callback errors isolated, L1 cleared except on epoch, bad messages ignored, close stops it', async () => {
    const ns = newNs(); const p = mkCache(ns); const s = mkCache(ns); const got = []; let first = true;
    const sub = await s.subscribeInval(async (m) => { got.push(m); if (first) { first = false; throw new Error('cb boom'); } });
    await sleep(100);
    await p.publishInval({ v: 1, event: 'graph.rebuild', userId: 'u1', projectId: 'p1' });
    await p.publishInval({ v: 1, event: 'library.changed', userId: 'u1' });
    assert.ok(await waitFor(() => got.length === 2, 2000), `got ${got.length} of 2`);
    assert.equal(got[1].event, 'library.changed');
    await s.set('bundle:k', 1, 60); await raw.del(`${ns}bundle:k`);
    assert.equal(await s.get('bundle:k'), 1);
    await p.publishInval({ v: 1, event: 'library.changed', userId: 'u1' });
    await waitFor(() => got.length === 3, 2000);
    assert.equal(await s.get('bundle:k'), undefined); // L1 cleared by the message
    await s.set('bundle:k', 1, 60); await raw.del(`${ns}bundle:k`);
    await p.epoch.rotate('graph', 'u1', 'p9');
    await waitFor(() => got.length === 4, 2000);
    assert.equal(got[3].event, 'epoch');
    assert.equal(await s.get('bundle:k'), 1); // epoch events keep L1
    await raw.publish(`${ns}ctc:inval`, '{"v":1,"event":"zzz","userId":"u"}');
    await raw.publish(`${ns}ctc:inval`, 'not json');
    await sleep(150);
    assert.equal(got.length, 4);
    await sub.close(); await sleep(50);
    await p.publishInval({ v: 1, event: 'graph.rebuild', userId: 'u1' }); await sleep(200);
    assert.equal(got.length, 4);
    await mkCache(newNs(), { url: DEAD }).publishInval({ v: 1, event: 'graph.rebuild', userId: 'u1' }); // never throws
  });

  await check('D14', 'hitRate: fixed minute window with a 60 s expiry; 0 when Redis is down', async () => {
    const ns = newNs(); const c = mkCache(ns);
    const n1 = await c.hitRate('u1'); const n2 = await c.hitRate('u1');
    assert.ok(n1 >= 1 && (n2 === n1 + 1 || n2 === 1), `${n1},${n2}`); // 1: the minute rolled over between the calls
    const [, ks] = await raw.scan('0', 'MATCH', `${ns}rl:u1:*`, 'COUNT', 1000);
    assert.equal(ks.length >= 1, true);
    const ttl = await raw.ttl(ks[0]); assert.ok(ttl > 0 && ttl <= 60, `ttl ${ttl}`);
    assert.equal(await mkCache(newNs(), { url: DEAD }).hitRate('u1'), 0);
    assert.equal(C.cacheLimits.rateLimitPerMin, 600);
  });

  await check('D15', 'queue table values, BullMQ default options, runner never re-queued when stalled', async () => {
    const Qs = Q.QUEUES;
    const want = { graph: [1, 3, 'exponential'], library: [1, 3, 'exponential'], llm: [1, 2, 'exponential'], memory: [1, 3, 'exponential'], runner: [3, 1, undefined], cleanup: [1, 3, 'exponential'], 'dlq-retry': [1, 1, undefined] };
    for (const [n, [c, a, b]] of Object.entries(want)) assert.deepEqual([n, Qs[n].concurrency, Qs[n].attempts, Qs[n].backoff?.type], [n, c, a, b]);
    assert.equal(Qs.graph.backoff.delay, 5000);
    assert.deepEqual(Object.keys(Qs.graph.kinds), ['rebuild', 'extract']);
    assert.deepEqual(Object.keys(Qs.llm.kinds), ['enrich', 'extract', 'summarize']);
    assert.deepEqual(Object.keys(Qs.cleanup.kinds), ['worktree', 'blobs', 'receipts']);
    assert.equal(Qs.runner.maxStalledCount, 0);
    assert.equal(Qs.graph.maxStalledCount, 1);
    const q = mkQueues(newNs());
    const o = q.get('graph').defaultJobOptions;
    assert.deepEqual([o.attempts, o.backoff, o.removeOnComplete, o.removeOnFail], [3, { type: 'exponential', delay: 5000 }, { count: 100 }, { age: 604800 }]);
    assert.equal(q.get('runner').defaultJobOptions.attempts, 1);
  });

  await check('D16', 'every (queue, kind) has a strict Zod schema; empty userId and extra keys are rejected', async () => {
    const ok14 = { 'graph.rebuild': { userId: 'u1', projectId: 'p1' }, 'graph.extract': { userId: 'u1', projectId: 'p1', files: ['a.ts'] }, 'library.scan': { userId: 'u1' }, 'library.changed': { userId: 'u1', capId: 'c1', version: 1 },
      'llm.enrich': llmPayload, 'llm.extract': { userId: 'u1', sessionId: 's1' }, 'llm.summarize': { userId: 'u1', sessionId: 's1' }, 'memory.import': { userId: 'u1' }, 'memory.distill': { userId: 'u1' },
      'runner.step': { userId: 'u1', runId: 'r1', stepId: 's1', nodeId: 'n1', visit: 1, attempt: 1, timeoutS: 60 }, 'cleanup.worktree': { userId: 'u1', runId: 'r1' }, 'cleanup.blobs': {}, 'cleanup.receipts': {}, 'dlq-retry.run': {} };
    const pairs = Object.entries(Q.QUEUES).flatMap(([n, d]) => Object.keys(d.kinds).map((k) => `${n}.${k}`));
    assert.deepEqual(pairs.filter((p) => !(p in Q.payloads)).sort(), []);
    assert.deepEqual(pairs.filter((p) => !(p in ok14)).sort(), []);
    for (const [pair, payload] of Object.entries(ok14)) {
      const [qn, kn] = pair.split('.');
      Q.parsePayload(qn, kn, payload);
      assert.throws(() => Q.parsePayload(qn, kn, { ...payload, extra: 1 }), (e) => e.code === 'invalid', `${pair} accepts an extra key`);
      if ('userId' in payload) assert.throws(() => Q.parsePayload(qn, kn, { ...payload, userId: '' }), (e) => e.code === 'invalid', `${pair} accepts empty userId`);
    }
  });

  await check('D17', 'submitJob: row first, BullMQ id encoded (runner spec id works), Redis down -> enqueued:false, no throw', async () => {
    const ns = newNs(); const q = mkQueues(ns); const order = [];
    const id = 'run:r1:node:n1:visit:1:attempt:1';
    const r = await Q.submitJob({ queues: q, create: async (row) => { order.push('create'); return { id: row.id, created: true }; } },
      { queue: 'runner', kind: 'step', id, payload: { userId: 'u1', runId: 'r1', stepId: 's1', nodeId: 'n1', visit: 1, attempt: 1, timeoutS: 60 } });
    assert.deepEqual([r.id, r.created, r.enqueued, order], [id, true, true, ['create']]);
    const job = await q.get('runner').getJob(Q.bullJobId(id));
    assert.equal(job.name, 'step'); assert.equal(job.data.id, id);
    const dq = mkQueues(newNs(), DEAD); let n = 0; const t = Date.now();
    const r2 = await Q.submitJob({ queues: dq, create: async (row) => { n++; return { id: row.id, created: true }; } }, { queue: 'llm', kind: 'enrich', payload: llmPayload });
    assert.deepEqual([r2.created, r2.enqueued, n], [true, false, 1]);
    assert.ok(Date.now() - t < 1500, `took ${Date.now() - t} ms`);
    await assert.rejects(() => Q.submitJob({ queues: q, create: async () => { throw new Error('db down'); } }, { queue: 'llm', kind: 'enrich', payload: llmPayload }), /db down/);
  });

  await check('D18', 'runAttempt: claim, done / failed / dead transitions, skip, invalid payload, dropped', async () => {
    const base = (port, handler, over = {}) => ({ port, handler, queue: 'llm', kind: 'enrich', jobId: 'bj', data: { id: 'j1', payload: llmPayload }, attemptsMade: 0, maxAttempts: 3, ...over });
    let port = fakePort(); port.add('j1', 'llm', 'enrich', llmPayload);
    const res = await W.runAttempt(base(port, async () => ({ ok: 1 })));
    assert.deepEqual(res, { skipped: false, result: { ok: 1 } });
    assert.deepEqual(port.log.map((l) => l[0]), ['running', 'done']);
    port = fakePort(); port.add('j1', 'llm', 'enrich', llmPayload);
    await assert.rejects(() => W.runAttempt(base(port, async () => { throw new Error('boom'); })), /boom/);
    assert.deepEqual(port.log.at(-1), ['failed', 'j1', 'Error: boom']);
    port = fakePort(); port.add('j1', 'llm', 'enrich', llmPayload);
    await assert.rejects(() => W.runAttempt(base(port, async () => { throw new Error('boom'); }, { attemptsMade: 2 })));
    assert.equal(port.log.at(-1)[0], 'dead');
    port = fakePort(); port.add('j1', 'llm', 'enrich', llmPayload);
    await assert.rejects(() => W.runAttempt(base(port, async () => { throw new UnrecoverableError('stop'); })));
    assert.equal(port.log.at(-1)[0], 'dead');
    port = fakePort(); port.add('j1', 'llm', 'enrich', llmPayload);
    await assert.rejects(() => W.runAttempt(base(port, async () => { throw new Q.JobDropped('bad_reply'); })), (e) => e instanceof UnrecoverableError);
    assert.deepEqual(port.log.at(-1), ['dead', 'j1', 'dropped:bad_reply']);
    port = fakePort(); port.add('j1', 'llm', 'enrich', llmPayload, 'done'); let called = false;
    assert.deepEqual(await W.runAttempt(base(port, async () => { called = true; })), { skipped: true });
    assert.equal(called, false);
    port = fakePort(); port.add('j1', 'llm', 'enrich', {});
    await assert.rejects(() => W.runAttempt(base(port, async () => 1, { data: { id: 'j1', payload: { userId: 'u1' } } })));
    assert.deepEqual(port.log.at(-1), ['dead', 'j1', 'payload_invalid']);
  });

  await check('D19', 'timeouts: table values, runner from payload, abort signal fires, attempt rejects with JobTimeoutError', async () => {
    assert.deepEqual([Q.timeoutMs('graph', 'rebuild'), Q.timeoutMs('graph', 'extract'), Q.timeoutMs('library', 'scan'), Q.timeoutMs('llm', 'enrich'), Q.timeoutMs('memory', 'import'), Q.timeoutMs('cleanup', 'blobs')],
      [300000, null, 300000, 120000, null, 600000]);
    assert.equal(Q.timeoutMs('runner', 'step', { timeoutS: 7 }), 7000);
    const keep = Q.QUEUES.llm.kinds.enrich.timeoutS; let sawAbort = false;
    try {
      Q.QUEUES.llm.kinds.enrich.timeoutS = 0.05;
      const port = fakePort(); port.add('j1', 'llm', 'enrich', llmPayload);
      const handler = (_p, ctx) => new Promise((_res, rej) => ctx.signal.addEventListener('abort', () => { sawAbort = true; rej(new Error('aborted')); }));
      await assert.rejects(() => W.runAttempt({ port, handler, queue: 'llm', kind: 'enrich', jobId: 'bj', data: { id: 'j1', payload: llmPayload }, attemptsMade: 0, maxAttempts: 2 }),
        (e) => e instanceof Q.JobTimeoutError && e.code === 'timeout');
      assert.equal(sawAbort, true);
      assert.equal(port.log.at(-1)[0], 'failed');
    } finally { Q.QUEUES.llm.kinds.enrich.timeoutS = keep; }
  });

  await check('D20', 'poller: Redis up re-adds stale queued rows only; Redis down runs them directly with attempts', async () => {
    const ns = newNs(); const q = mkQueues(ns); const port = fakePort();
    port.add('old', 'llm', 'enrich', llmPayload, 'queued', 0, new Date(Date.now() - 60_000));
    port.add('fresh', 'llm', 'enrich', llmPayload, 'queued', 0, new Date());
    const up = await W.pollOnce({ port, queues: q, handlers: {}, isRedisUp: async () => true });
    assert.deepEqual(up.reenqueued, ['old']);
    assert.ok(await q.get('llm').getJob(Q.bullJobId('old')));
    assert.equal(await q.get('llm').getJob(Q.bullJobId('fresh')), undefined);
    const p2 = fakePort(); p2.add('d1', 'llm', 'enrich', llmPayload); p2.add('d2', 'llm', 'enrich', llmPayload);
    const handlers = { 'llm.enrich': async (_p, ctx) => { if (ctx.jobId === 'd2') throw new Error('flaky'); return 'ok'; } };
    const dq = mkQueues(newNs(), DEAD);
    const t1 = await W.pollOnce({ port: p2, queues: dq, handlers, isRedisUp: async () => false });
    assert.equal(p2.rows.get('d1').status, 'done'); assert.ok(t1.ran.includes('d1'));
    assert.deepEqual([p2.rows.get('d2').status, p2.rows.get('d2').attempts], ['queued', 1]); // attempt 1 of 2 failed, back to queued
    await W.pollOnce({ port: p2, queues: dq, handlers, isRedisUp: async () => false });
    assert.deepEqual([p2.rows.get('d2').status, p2.rows.get('d2').attempts], ['dead', 2]);
  });

  await check('D21', 'dlq-retry: 5 retries then gave up; dropped and runner failures are never retried', async () => {
    const ns = newNs(); const port = fakePort(); const q = mkQueues(ns);
    const handlers = {
      'llm.enrich': async () => { throw new UnrecoverableError('boom'); },
      'llm.extract': async () => { throw new Q.JobDropped('bad_reply'); },
      'runner.step': async () => { throw new Error('runner boom'); },
    };
    const w = await W.startWorkers({ url, namespace: ns, port, handlers, poll: false, dlq: false }); closers.push(() => w.close());
    const deps = { queues: q, create: async (row) => { port.add(row.id, row.queue, row.kind, row.payload); return { id: row.id, created: true }; } };
    const sub = (queue, kind, payload) => Q.submitJob(deps, { queue, kind, payload }).then((r) => r.id);
    const failedCount = async (name) => (await q.get(name).getFailedCount());
    const idA = await sub('llm', 'enrich', llmPayload);
    assert.ok(await waitFor(async () => port.rows.get(idA).status === 'dead' && (await failedCount('llm')) === 1, 5000), 'job did not fail');
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await W.dlqRetryOnce({ queues: q, redis: raw, port, namespace: ns }));
      await waitFor(async () => port.rows.get(idA).status === 'dead' && (await failedCount('llm')) === 1, 5000);
    }
    assert.deepEqual(results.slice(0, 5).map((r) => r.retried.includes(idA)), [true, true, true, true, true]);
    assert.equal(results[5].gaveUp.includes(idA), true);
    assert.match(String(port.rows.get(idA).error), /^dlq_gave_up/);
    const idB = await sub('llm', 'extract', { userId: 'u1', sessionId: 's1' });
    const idR = await sub('runner', 'step', { userId: 'u1', runId: 'r1', stepId: 's1', nodeId: 'n1', visit: 1, attempt: 1, timeoutS: 60 });
    assert.ok(await waitFor(async () => (await failedCount('runner')) === 1 && port.rows.get(idB).status === 'dead', 5000));
    const r = await W.dlqRetryOnce({ queues: q, redis: raw, port, namespace: ns });
    assert.equal(r.skipped.includes(idB), true);
    assert.equal(r.retried.includes(idB) || r.retried.includes(idR) || r.gaveUp.includes(idR) || r.skipped.includes(idR), false);
  });

  await check('D22', 'systemd units: required directives, differences, parses with systemd-analyze', async () => {
    const parse = (f) => {
      const text = fs.readFileSync(path.join(ROOT, UNITS, f), 'utf8'); const out = {}; let sec = '';
      for (const line of text.split('\n')) { const m = /^\[(\w+)\]$/.exec(line.trim()); if (m) { sec = m[1]; continue; } const kv = /^([A-Za-z]+)=(.*)$/.exec(line.trim()); if (kv && sec) out[`${sec}.${kv[1]}`] = kv[2]; }
      return { out, text };
    };
    const web = parse('ctc-web.service'); const wk = parse('ctc-worker.service');
    for (const { out } of [web, wk]) {
      const exp = { 'Unit.StartLimitIntervalSec': '60', 'Unit.StartLimitBurst': '5', 'Service.Type': 'simple', 'Service.Restart': 'on-failure', 'Service.RestartSec': '2', 'Service.WorkingDirectory': '%h/.claudethecaller',
        'Service.EnvironmentFile': '-%h/.claudethecaller/env', 'Install.WantedBy': 'default.target' };
      for (const [k, v] of Object.entries(exp)) assert.equal(out[k], v, k);
    }
    assert.deepEqual([web.out['Service.ExecStart'], wk.out['Service.ExecStart']], ['%h/.claudethecaller/bin/ctc-web', '%h/.claudethecaller/bin/ctc-worker']);
    assert.deepEqual([web.out['Service.TimeoutStopSec'], web.out['Service.MemoryHigh'], web.out['Service.KillMode']], ['15', '600M', undefined]);
    assert.deepEqual([wk.out['Service.TimeoutStopSec'], wk.out['Service.MemoryHigh'], wk.out['Service.KillMode']], ['20', '1G', 'process']);
    assert.equal(/RestartPreventExitStatus|Requires=/.test(web.text + wk.text), false);
    assert.equal(/password|secret|token/i.test(web.text + wk.text), false);
    const v = spawnSync('systemd-analyze', ['--user', 'verify', path.join(ROOT, UNITS, 'ctc-web.service'), path.join(ROOT, UNITS, 'ctc-worker.service')], { encoding: 'utf8' });
    if (!v.error) assert.equal(/Unknown (key|section)|Failed to parse|Invalid|outside of section/i.test(`${v.stdout}${v.stderr}`), false, `${v.stdout}${v.stderr}`);
  });

  await check('D23', 'close() resolves within the grace period even with a stuck job; no-op after close', async () => {
    const ns = newNs(); const port = fakePort(); const q = mkQueues(ns); const keep = Q.queueLimits.closeGraceMs;
    try {
      Q.queueLimits.closeGraceMs = 100;
      const w = await W.startWorkers({ url, namespace: ns, port, handlers: { 'llm.enrich': () => new Promise(() => {}) }, poll: false, dlq: false });
      const id = await Q.submitJob({ queues: q, create: async (row) => { port.add(row.id, row.queue, row.kind, row.payload); return { id: row.id, created: true }; } }, { queue: 'llm', kind: 'enrich', payload: llmPayload }).then((r) => r.id);
      assert.ok(await waitFor(() => port.rows.get(id).status === 'running', 3000), 'job never started');
      const t = Date.now(); await w.close(); assert.ok(Date.now() - t < 3000, `close took ${Date.now() - t} ms`);
      await w.close();
    } finally { Q.queueLimits.closeGraceMs = keep; }
    const c = mkCache(newNs()); await c.close();
    assert.equal(await c.get('bundle:x'), undefined);
  });
} finally {
  for (const c of closers.reverse()) { try { await c(); } catch { /* ignore */ } }
  try {
    for (const ns of namespaces) {
      let cursor = '0';
      do { const [next, keys] = await raw.scan(cursor, 'MATCH', `${ns}*`, 'COUNT', 1000); cursor = next; if (keys.length) await raw.del(...keys); } while (cursor !== '0');
    }
  } catch { /* best effort; selfcheck.py also scans for t14chk* leftovers */ }
  raw.disconnect();
}
finish();
