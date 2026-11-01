// checks for T4.1 hooks/spool + apps/web/src/spool + packages/shared/src/spool: one runnable example per decision id (D0..D15).
// Prints `PASS D# ...` or `FAIL D# expected=<..> got=<..>`; last line `CHECKS: <n> pass, <m> fail`; exit 1 on any FAIL.
// Needs: env CTC_SCRATCH_PG_URL (scratch Postgres 127.0.0.1:18304 only), CTC_SCRATCH_REDIS_URL (scratch Redis 127.0.0.1:18395
// only), `dash`, `curl`, `mkfifo`. Run from the repo root:  node --import tsx agent/t4-1-spool/checks.mjs
// Fixture values are this file's own; nothing is derived from the module's code. Every spool dir is a fresh mkdtemp dir,
// every script run gets HOME=<tmp> so nothing can reach the real ~/.claudethecaller.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(new URL('../../', import.meta.url).pathname);
const SCRIPT = path.join(ROOT, 'hooks/spool');
const DRAIN_ENTRY = 'apps/web/src/spool/index.ts';
const SCHEMA_ENTRY = 'packages/shared/src/spool/index.ts';
const GATE_TEST = 'apps/web/src/spool/memory.spool.int.test.ts';
const IDS = Array.from({ length: 16 }, (_, i) => `D${i}`);
let pass = 0;
let fail = 0;
const done = new Set();
const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
function ok(id, msg) { pass++; done.add(id); console.log(`PASS ${id} ${msg}`); }
function bad(id, expected, got) { fail++; done.add(id); console.log(`FAIL ${id} expected=${show(expected)} got=${show(got)}`); }
async function check(id, msg, fn) {
  try { await fn(); ok(id, msg); } catch (e) {
    if (e && e.name === 'AssertionError') bad(id, e.expected ?? msg, e.actual ?? e.message);
    else bad(id, msg, `${e?.name}: ${String(e?.message).split('\n')[0]}`);
  }
}
const cleanups = [];
async function finish() {
  for (const c of cleanups.reverse()) { try { await c(); } catch { /* best effort */ } }
  for (const id of IDS) if (!done.has(id)) bad(id, 'a check', 'missing');
  console.log(`CHECKS: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
async function failAll(why) { for (const id of IDS) if (!done.has(id)) bad(id, 'module importable and scratch services ready', why); await finish(); }

// ---- guards and loading -------------------------------------------------------------------------------------------
const pgUrl = process.env.CTC_SCRATCH_PG_URL ?? '';
const redisUrl = process.env.CTC_SCRATCH_REDIS_URL ?? '';
const hostPort = (u) => { try { const x = new URL(u); return `${x.hostname}:${x.port}`; } catch { return 'unparsable'; } };
if (hostPort(pgUrl) !== '127.0.0.1:18304') await failAll(`refusing CTC_SCRATCH_PG_URL ${hostPort(pgUrl)}: only the scratch Postgres 127.0.0.1:18304`);
if (hostPort(redisUrl) !== '127.0.0.1:18395') await failAll(`refusing CTC_SCRATCH_REDIS_URL ${hostPort(redisUrl)}: only the scratch Redis 127.0.0.1:18395`);
if (!fs.existsSync(SCRIPT)) await failAll('module not built: hooks/spool is missing');
const imp = async (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
let web; let shared; let queuesMod; let reposMod; let adminMod;
try {
  web = await imp(DRAIN_ENTRY);
  shared = await imp(SCHEMA_ENTRY);
  queuesMod = await imp('packages/shared/src/queues/index.ts');
  reposMod = await imp('packages/shared/src/repositories/index.ts');
  adminMod = await imp('packages/shared/src/repositories/admin/index.ts');
} catch (e) { await failAll(`module not importable: ${e?.code ?? e?.name}: ${String(e?.message).split('\n')[0]}`); }

const rnd = () => randomBytes(4).toString('hex');
const schema = `ctc_t41_chk_${rnd()}`;
const ns = `t41chk${rnd()}:`;
let db; let repos; let queues; let downQueues;
try {
  await adminMod.migrate({ url: pgUrl, schema });
  db = reposMod.createDb({ url: pgUrl, schema });
  cleanups.push(async () => { await db.kysely.schema.dropSchema(schema).ifExists().cascade().execute(); await db.close(); });
  repos = reposMod.createRepositories(db);
  queues = queuesMod.createQueues({ url: redisUrl, namespace: ns });
  cleanups.push(async () => { for (const q of ['graph', 'llm']) await queues.get(q).obliterate({ force: true }); await queues.close(); });
  downQueues = queuesMod.createQueues({ url: 'redis://127.0.0.1:1', namespace: ns }); // Redis "down": nothing listens on port 1
  cleanups.push(() => downQueues.close());
} catch (e) { await failAll(`setup failed: ${e?.name}: ${String(e?.message).split('\n')[0]}`); }

// ---- helpers --------------------------------------------------------------------------------------------------------
const tmpdir = (tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `ctc-t41-${tag}-`)); cleanups.push(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const HOME = tmpdir('home');
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const closedUrl = `http://127.0.0.1:${await freePort()}/v1/spool/nudge`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 2000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(25); } return false; }

/** Runs hooks/spool under dash (default) and resolves {code, stdout, stderr, ms}. */
function runSpool({ stdin = '', args = [], dir, nudge = closedUrl, env = {}, shell = 'dash' }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const cmd = shell ? shell : SCRIPT;
    const argv = shell ? [SCRIPT, ...args] : args;
    const p = spawn(cmd, argv, { env: { PATH: process.env.PATH, HOME, CTC_SPOOL_DIR: dir, CTC_NUDGE_URL: nudge, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (b) => (stdout += b)); p.stderr.on('data', (b) => (stderr += b));
    p.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - t0 }));
    p.stdin.on('error', () => undefined);
    p.stdin.end(stdin);
  });
}
const listJson = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
const CWD = `/chk/${rnd()}/repo`;
const hook = (event, sid, extra = {}) => ({ session_id: sid, transcript_path: `/chk/none/${sid}.jsonl`, cwd: CWD, permission_mode: 'default', hook_event_name: event, ...extra });
const edit = (sid, file = `${CWD}/src/a.ts`, tool = 'Edit') => hook('PostToolUse', sid, { tool_name: tool, tool_input: { file_path: file, old_string: 'a', new_string: 'b' }, tool_response: { success: true } });
const iso = (d = new Date()) => d.toISOString().replace(/\.\d+Z$/, 'Z');
/** Writes a spool file directly (no script). `body` = object (JSON-encoded) or raw string. */
function put(dir, name, body, mtimeMs) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
  if (mtimeMs !== undefined) fs.utimesSync(f, mtimeMs / 1000, mtimeMs / 1000);
  return f;
}
const envl = (event, payload) => ({ v: 1, event, received_at: iso(), payload });
const fname = (sid, event) => `${sid}-${event}-${process.hrtime.bigint()}-${rnd()}.json`;
const ZERO = { queued: 0, dropped: 0, corrupt: 0, kept: 0, expired: 0 };
const rep = (o) => ({ ...ZERO, ...o });
/** A drain on `dir` for its own user (so row counts never mix between checks). */
function drainFor(dir, o = {}) {
  const userId = o.userId ?? `chk-${rnd()}`;
  const logs = [];
  const d = web.createSpoolDrain({ dir, keepDays: 7, userId, queues: o.queues ?? queues, repos, log: (m, f) => logs.push([m, f]), ...(o.now ? { now: o.now } : {}) });
  cleanups.push(() => d.close());
  return { d, userId, logs, rows: async () => (await repos.jobs.list({ userId }, { limit: 500 })).rows };
}
const kinds = (rows) => rows.map((r) => `${r.queue}.${r.kind}`).sort();

// ---- checks ---------------------------------------------------------------------------------------------------------
try {
  await check('D0', 'script is executable; one Stop through script + drain becomes one llm.extract job', async () => {
    fs.accessSync(SCRIPT, fs.constants.X_OK);
    assert.equal(fs.readFileSync(SCRIPT, 'utf8').split('\n')[0], '#!/bin/sh');
    for (const n of ['createSpoolDrain', 'nudgeRoute', 'spoolLimits']) assert.equal(n in web, true, n);
    const dir = tmpdir('d0');
    const r = await runSpool({ stdin: JSON.stringify(hook('Stop', `s0${rnd()}`)), args: ['Stop'], dir, shell: '' });
    assert.equal(r.code, 0);
    const { d, rows } = drainFor(dir);
    assert.deepEqual(await d.drainOnce(), rep({ queued: 1 }));
    assert.deepEqual(kinds(await rows()), ['llm.extract']);
  });

  await check('D1', 'hostile session_id stays a basename; userId comes from deps, not the payload; edit outside cwd dropped', async () => {
    const dir = tmpdir('d1');
    const r = await runSpool({ stdin: JSON.stringify({ ...hook('Stop', '../../x y/..'), userId: 'evil' }), args: ['Stop'], dir });
    assert.equal(r.code, 0);
    const files = listJson(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^[A-Za-z0-9_-]{1,64}-Stop-\d{1,20}-[0-9a-f]{8}\.json$/);
    put(dir, fname('s1', 'PostToolUse'), envl('PostToolUse', edit('s1', '../../../etc/passwd')));
    const { d, userId, rows } = drainFor(dir);
    assert.deepEqual(await d.drainOnce(), rep({ queued: 1, dropped: 1 }));
    const [row] = await rows();
    assert.equal(row.payload.userId, userId);
    assert.equal(row.userId, userId);
  });

  await check('D2', 'limits: defaults; maxFileBytes equal valid, +1 corrupt; keepDays boundary by mtime', async () => {
    assert.deepEqual({ ...web.spoolLimits }, { maxFileBytes: 1048576, sweepEveryMs: 30000, nudgeTimeoutMs: 250 });
    assert.deepEqual({ ...shared.spoolFieldLimits }, { event: 32, sessionId: 256, toolName: 128, path: 4096 });
    const dir = tmpdir('d2');
    const base = JSON.stringify(envl('Stop', hook('Stop', 'sz')));
    const keep = web.spoolLimits.maxFileBytes;
    try {
      web.spoolLimits.maxFileBytes = Buffer.byteLength(base) + 10;
      put(dir, 'eq-Stop-1-00000001.json', base.slice(0, -1) + ' '.repeat(10) + '}'); // exactly the limit
      put(dir, 'gt-Stop-1-00000002.json', base.slice(0, -1) + ' '.repeat(11) + '}'); // one more
      const { d } = drainFor(dir);
      assert.deepEqual(await d.drainOnce(), rep({ queued: 1, corrupt: 1 }));
      assert.deepEqual(fs.readdirSync(path.join(dir, 'corrupt')), ['gt-Stop-1-00000002.json']);
    } finally { web.spoolLimits.maxFileBytes = keep; }
    const dir2 = tmpdir('d2b');
    const now = Math.floor(Date.now() / 1000) * 1000; // whole seconds: utimes keeps them exactly
    const DAY = 86_400_000;
    put(dir2, 'k7-Stop-1-0000000a.json', envl('Stop', hook('Stop', 'k7')), now - 7 * DAY);      // exactly 7 days: kept
    put(dir2, 'k8-Stop-1-0000000b.json', envl('Stop', hook('Stop', 'k8')), now - 7 * DAY - 1000); // older: expired
    const { d: d2 } = drainFor(dir2, { queues: downQueues, now: () => now });
    assert.deepEqual(await d2.drainOnce(), rep({ kept: 1, expired: 1 }));
    assert.deepEqual(listJson(dir2), ['k7-Stop-1-0000000a.json']);
  });

  await check('D3', 'file name, body, job id, payload shape, nudge reply 204, report keys', async () => {
    const dir = path.join(tmpdir('d3'), 'new-spool'); // the script creates it
    const sid = `sess-${rnd()}`;
    const r = await runSpool({ stdin: JSON.stringify(edit(sid)), args: ['PostToolUse'], dir });
    assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', '']);
    const all = fs.readdirSync(dir);
    assert.equal(all.some((f) => f.endsWith('.tmp')), false);
    const [f] = listJson(dir);
    assert.match(f, new RegExp(`^${sid}-PostToolUse-\\d{1,20}-[0-9a-f]{8}\\.json$`));
    const body = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.deepEqual(Object.keys(body), ['v', 'event', 'received_at', 'payload']);
    assert.equal(body.v, 1); assert.equal(body.event, 'PostToolUse');
    assert.match(body.received_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.deepEqual(body.payload, edit(sid));
    assert.equal((fs.statSync(dir).mode & 0o777), 0o700);
    const { d, userId, rows } = drainFor(dir);
    assert.deepEqual(Object.keys(await d.drainOnce()).sort(), ['corrupt', 'dropped', 'expired', 'kept', 'queued']);
    const [row] = await rows();
    assert.equal(row.id, `spool:${f.slice(0, -5)}`);
    assert.deepEqual(row.payload, { userId, projectId: (await repos.projects.byRoot({ userId }, CWD)).id, files: ['src/a.ts'] });
    assert.ok(await queues.get('graph').getJob(queuesMod.bullJobId(row.id)), 'BullMQ job exists');
    const route = web.nudgeRoute(d);
    assert.deepEqual([route.method, route.url], ['POST', '/v1/spool/nudge']);
    let code; let sent = false;
    await route.handler({ body: 'ignored' }, { code(n) { code = n; return { send() { sent = true; } }; } });
    assert.deepEqual([code, sent], [204, true]);
  });

  await check('D4', 'corrupt: not json, v 2, payload array, Stop w/o session_id, Edit w/o file_path; wrong-typed optional = absent', async () => {
    const dir = tmpdir('d4');
    put(dir, 'a-Stop-1-00000001.json', 'not json');
    put(dir, 'b-Stop-1-00000002.json', { ...envl('Stop', hook('Stop', 'b')), v: 2 });
    put(dir, 'c-Stop-1-00000003.json', { ...envl('Stop', {}), payload: [1] });
    put(dir, 'd-Stop-1-00000004.json', envl('Stop', { cwd: CWD }));
    put(dir, 'e-PostToolUse-1-00000005.json', envl('PostToolUse', { ...edit('e'), tool_input: { old_string: 'x' } }));
    put(dir, 'f-Stop-1-00000006.json', { ...envl('Stop', { ...hook('Stop', 'f'), transcript_path: 42 }), extra: true });
    const { d, rows } = drainFor(dir);
    assert.deepEqual(await d.drainOnce(), rep({ queued: 1, corrupt: 5 }));
    assert.equal(fs.readdirSync(path.join(dir, 'corrupt')).length, 5);
    const [row] = await rows();
    assert.equal('transcriptPath' in row.payload, false);
    assert.deepEqual(await d.drainOnce(), rep({}));            // never retried
  });

  await check('D5', 'empty stdin: no file; no session_id: nosession; non-json names ignored; relative path + trailing slash ok', async () => {
    const dir = tmpdir('d5');
    for (const stdin of ['', '  \n\t ']) assert.equal((await runSpool({ stdin, args: ['Stop'], dir })).code, 0);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => !fs.statSync(path.join(dir, f)).isDirectory()), []);
    await runSpool({ stdin: '{"hook_event_name":"Stop","cwd":"/x"}', dir });
    assert.match(listJson(dir)[0], /^nosession-Stop-/);
    fs.rmSync(path.join(dir, listJson(dir)[0]));
    put(dir, 'notes.txt', 'keep me');
    put(dir, 'r-PostToolUse-1-00000001.json', envl('PostToolUse', { ...edit('r', 'src/b.ts'), cwd: `${CWD}/` }));
    const { d, rows } = drainFor(dir);
    assert.deepEqual(await d.drainOnce(), rep({ queued: 1 }));
    assert.deepEqual((await rows())[0].payload.files, ['src/b.ts']);
    assert.equal(fs.existsSync(path.join(dir, 'notes.txt')), true);
  });

  await check('D6', 'script silent + exit 0 on unwritable dir, returns fast against a hanging nudge; drain skips FIFO/symlink/subdir, never logs payload', async () => {
    const r1 = await runSpool({ stdin: JSON.stringify(hook('Stop', 'u')), args: ['Stop'], dir: '/proc/ctc-t41-no/such/dir' });
    assert.deepEqual([r1.code, r1.stdout, r1.stderr], [0, '', '']);
    let closedAt = 0; const t0 = Date.now();
    const hang = net.createServer((s) => { s.resume(); s.on('close', () => (closedAt = Date.now())); s.on('error', () => undefined); }).listen(0, '127.0.0.1');
    await new Promise((res) => hang.on('listening', res));
    cleanups.push(() => new Promise((res) => hang.close(res)));
    const dir = tmpdir('d6');
    const big = JSON.stringify(hook('Stop', 'h', { pad: 'x'.repeat(10_000) }));
    const r2 = await runSpool({ stdin: big, args: ['Stop'], dir, nudge: `http://127.0.0.1:${hang.address().port}/v1/spool/nudge` });
    assert.equal(r2.code, 0);
    assert.ok(r2.ms <= 500, `script took ${r2.ms} ms`);
    assert.ok(await waitFor(() => closedAt > 0, 1500), 'curl gave up on the hanging nudge');
    assert.ok(closedAt - t0 <= 1500, `curl held the socket ${closedAt - t0} ms`);
    fs.rmSync(path.join(dir, listJson(dir)[0]));
    assert.equal(spawnSync('mkfifo', [path.join(dir, 'fifo-Stop-1-00000001.json')]).status, 0);
    const outside = put(tmpdir('d6o'), 'o.json', envl('Stop', hook('Stop', 'o')));
    fs.symlinkSync(outside, path.join(dir, 'link-Stop-1-00000002.json'));
    fs.mkdirSync(path.join(dir, 'sub'));
    put(path.join(dir, 'sub'), 'n-Stop-1-00000003.json', envl('Stop', hook('Stop', 'n')));
    put(dir, 'p-Stop-1-00000004.json', envl('Stop', hook('Stop', 'p', { secret: 'SECRET-T41-VALUE' })));
    const { d, logs } = drainFor(dir);
    const t1 = Date.now();
    assert.deepEqual(await d.drainOnce(), rep({ queued: 1 }));
    assert.ok(Date.now() - t1 < 5000, 'no hang on the FIFO');
    assert.equal(fs.lstatSync(path.join(dir, 'link-Stop-1-00000002.json')).isSymbolicLink(), true);
    assert.equal(fs.existsSync(outside), true);
    assert.equal(fs.existsSync(path.join(dir, 'sub', 'n-Stop-1-00000003.json')), true);
    assert.equal(JSON.stringify(logs).includes('SECRET-T41-VALUE'), false);
    assert.equal(JSON.stringify(logs).includes(CWD), false);
  });

  await check('D7', 'non-goals: no debounce (2 edits = 2 jobs), corrupt/ never pruned, no fastify import', async () => {
    const dir = tmpdir('d7');
    put(dir, 'g1-PostToolUse-1-00000001.json', envl('PostToolUse', edit('g1')));
    put(dir, 'g2-PostToolUse-1-00000002.json', envl('PostToolUse', edit('g2')));
    fs.mkdirSync(path.join(dir, 'corrupt'));
    put(path.join(dir, 'corrupt'), 'old.json', 'x', Date.now() - 400 * 86_400_000);
    const { d, rows } = drainFor(dir);
    assert.deepEqual(await d.drainOnce(), rep({ queued: 2 }));
    assert.deepEqual(kinds(await rows()), ['graph.rebuild', 'graph.rebuild']);
    assert.equal(fs.existsSync(path.join(dir, 'corrupt', 'old.json')), true);
    const src = fs.readdirSync(path.join(ROOT, 'apps/web/src/spool'), { recursive: true }).filter((f) => String(f).endsWith('.ts'))
      .map((f) => fs.readFileSync(path.join(ROOT, 'apps/web/src/spool', String(f)), 'utf8')).join('\n');
    assert.equal(/from ['"](fastify|pg|kysely|zod)['"]/.test(src), false);
  });

  await check('D8', 'silence rule: young .tmp and foreign names are left alone', async () => {
    const dir = tmpdir('d8');
    put(dir, 'y-Stop-1-00000001.json.tmp', '{"half":');
    put(dir, 'README', 'x');
    const { d } = drainFor(dir);
    assert.deepEqual(await d.drainOnce(), rep({}));
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f !== 'corrupt').sort(), ['README', 'y-Stop-1-00000001.json.tmp']);
  });

  await check('D9', 'public shapes: schema exports, EDIT_TOOLS, bad deps throw TypeError', async () => {
    assert.deepEqual([...shared.EDIT_TOOLS], ['Edit', 'Write', 'MultiEdit']);
    assert.equal(shared.SpoolFileSchema.safeParse(envl('Stop', {})).success, true);
    assert.equal(shared.SpoolFileSchema.safeParse({ ...envl('Stop', {}), v: '1' }).success, false);
    assert.throws(() => web.createSpoolDrain({ keepDays: 7, queues, repos }), TypeError);
    assert.throws(() => web.createSpoolDrain({ dir: tmpdir('d9'), keepDays: 0, queues, repos }), TypeError);
    const d = web.createSpoolDrain({ dir: tmpdir('d9b'), keepDays: 7, queues, repos });
    assert.deepEqual(Object.keys(d).sort(), ['close', 'drainOnce', 'nudge', 'start']);
  });

  await check('D10', 'argv event wins, bad argv falls back to payload, no curl still writes, runs under dash', async () => {
    const dir = tmpdir('d10');
    await runSpool({ stdin: JSON.stringify(hook('SessionEnd', 'a1')), args: ['Stop'], dir });
    await runSpool({ stdin: JSON.stringify(hook('SessionEnd', 'a2')), args: ['bad name!'], dir });
    await runSpool({ stdin: JSON.stringify({ session_id: 'a3' }), args: [], dir });
    const bin = tmpdir('bin');
    for (const t of ['cat', 'awk', 'sed', 'tr', 'head', 'od', 'date', 'mkdir', 'mv', 'rm', 'dash']) {
      const w = spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim();
      if (w) fs.symlinkSync(w, path.join(bin, t));
    }
    const r = await runSpool({ stdin: JSON.stringify(hook('Stop', 'a4')), args: ['Stop'], dir, env: { PATH: bin }, shell: path.join(bin, 'dash') });
    assert.equal(r.code, 0);
    const ev = (sid) => listJson(dir).find((f) => f.startsWith(`${sid}-`))?.split('-')[1];
    assert.deepEqual([ev('a1'), ev('a2'), ev('a3'), ev('a4')], ['Stop', 'SessionEnd', 'unknown', 'Stop']);
  });

  await check('D11', 'strip: three tags removed across lines, repeated; lone close kept; unclosed cuts to the end', async () => {
    const dir = tmpdir('d11');
    const text = 'keep1 <private>P1\nP2</private> keep2 <system-reminder>R</system-reminder><persisted-output>O</persisted-output> </private> <private>P3</private>end';
    await runSpool({ stdin: JSON.stringify(hook('Stop', 'st1', { note: text })), args: ['Stop'], dir });
    const [f1] = listJson(dir);
    const b = JSON.parse(fs.readFileSync(path.join(dir, f1), 'utf8'));
    assert.equal(b.payload.note, 'keep1  keep2  </private> end');
    fs.rmSync(path.join(dir, f1));
    await runSpool({ stdin: JSON.stringify(hook('Stop', 'st2', { note: 'a <private>SECRET-T41-UNCLOSED' })), args: ['Stop'], dir });
    const [f2] = listJson(dir);
    assert.equal(fs.readFileSync(path.join(dir, f2), 'utf8').includes('SECRET-T41-UNCLOSED'), false);
    const { d } = drainFor(dir);
    assert.deepEqual(await d.drainOnce(), rep({ corrupt: 1 }));
  });

  await check('D12', 'routing: Read/other events dropped; SessionEnd = session upsert + summarize; Stop w/o cwd has no projectId', async () => {
    const dir = tmpdir('d12');
    const sid = `se-${rnd()}`;
    put(dir, '1-PostToolUse-1-00000001.json', envl('PostToolUse', edit('r1', `${CWD}/a.ts`, 'Read')));
    put(dir, '2-SubagentStop-1-00000002.json', envl('SubagentStop', hook('SubagentStop', 'r2')));
    put(dir, '3-Stop-1-00000003.json', envl('Stop', { session_id: 'r3' }));
    put(dir, '4-SessionEnd-1-00000004.json', envl('SessionEnd', hook('SessionEnd', sid, { reason: 'exit' })));
    put(dir, '5-PostToolUse-1-00000005.json', envl('PostToolUse', edit('r5', `${CWD}/w.ts`, 'MultiEdit')));
    const { d, userId, rows } = drainFor(dir);
    assert.deepEqual(await d.drainOnce(), rep({ queued: 3, dropped: 2 }));
    const all = await rows();
    assert.deepEqual(kinds(all), ['graph.rebuild', 'llm.extract', 'llm.summarize']);
    assert.deepEqual(all.find((r) => r.kind === 'extract').payload, { userId, sessionId: 'r3' });
    const s = await repos.sessions.get({ userId }, sid);
    assert.ok(s && s.endedAt, 'session row with ended_at');
    assert.equal(s.transcriptPath, `/chk/none/${sid}.jsonl`);
  });

  await check('D12', 'unusable roots: > 2048 UTF-8 bytes or RepoError from projects.upsert = no project; later files still delivered', async () => {
    const dir = tmpdir('d12r');
    const old = Date.now() - 60_000;
    const long = `/chk/${'é'.repeat(1100)}`; // 1105 chars, 2205 bytes
    const max = `/${'b'.repeat(2047)}`; // exactly 2048 bytes: still a project
    put(dir, '1-PostToolUse-1-00000001.json', envl('PostToolUse', { ...edit('l1'), cwd: long, tool_input: { file_path: `${long}/a.ts` } }), old);
    put(dir, '2-Stop-1-00000002.json', envl('Stop', { session_id: 'l2', cwd: long }), old + 1000);
    put(dir, '3-SessionEnd-1-00000003.json', envl('SessionEnd', { session_id: `l3-${rnd()}`, cwd: long }), old + 2000);
    put(dir, '4-PostToolUse-1-00000004.json', envl('PostToolUse', { ...edit('l4'), cwd: max, tool_input: { file_path: `${max}/a.ts` } }), old + 3000);
    const { d, userId, rows } = drainFor(dir);
    assert.deepEqual(await d.drainOnce(), rep({ queued: 3, dropped: 1 }));
    const all = await rows();
    assert.deepEqual(kinds(all), ['graph.rebuild', 'llm.extract', 'llm.summarize']);
    for (const r of all.filter((x) => x.queue === 'llm')) assert.equal('projectId' in r.payload, false, `${r.kind} has no projectId`);
    assert.equal(typeof all.find((r) => r.queue === 'graph').payload.projectId, 'string');
    const dir2 = tmpdir('d12c');
    put(dir2, 'c1-PostToolUse-1-00000001.json', envl('PostToolUse', edit('c1')), old);
    put(dir2, 'c2-Stop-1-00000002.json', envl('Stop', { session_id: 'c2', cwd: CWD }), old + 1000);
    const userId2 = `chk-${rnd()}`;
    const conflict = { ...repos, projects: { upsert: async () => { throw new reposMod.ConflictError('project id collision'); } } };
    const d2 = web.createSpoolDrain({ dir: dir2, keepDays: 7, userId: userId2, queues, repos: conflict, log: () => undefined });
    cleanups.push(() => d2.close());
    assert.deepEqual(await d2.drainOnce(), rep({ queued: 1, dropped: 1 }));
    const r2 = (await repos.jobs.list({ userId: userId2 }, { limit: 10 })).rows;
    assert.deepEqual(r2.map((r) => r.payload), [{ userId: userId2, sessionId: 'c2' }]);
  });

  await check('D13', 'Redis down: kept, stop after first failure; Redis up: delivered once; delivered copy again = no new row; old .tmp expired', async () => {
    const dir = tmpdir('d13');
    for (const i of [1, 2, 3]) put(dir, `q${i}-Stop-1-0000000${i}.json`, envl('Stop', hook('Stop', `q${i}`)), Date.now() - (10 - i) * 1000);
    const userId = `chk-${rnd()}`;
    const down = drainFor(dir, { userId, queues: downQueues });
    assert.deepEqual(await down.d.drainOnce(), rep({ kept: 3 }));
    assert.equal((await down.rows()).length, 1, 'only the first file was tried');
    const up = drainFor(dir, { userId });
    assert.deepEqual(await up.d.drainOnce(), rep({ queued: 3 }));
    assert.equal((await up.rows()).length, 3);
    put(dir, 'q1-Stop-1-00000001.json', envl('Stop', hook('Stop', 'q1')));
    assert.deepEqual(await up.d.drainOnce(), rep({ queued: 1 }));
    assert.equal((await up.rows()).length, 3);
    put(dir, 'old-Stop-1-00000009.json.tmp', '{', Date.now() - 8 * 86_400_000);
    assert.deepEqual(await up.d.drainOnce(), rep({ expired: 1 }));
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f !== 'corrupt'), []);
  });

  await check('D14', 'start: dirs 0700 + boot pass; watch picks up a new file; nudge before start ignored; concurrent drainOnce makes one row; close idempotent', async () => {
    const dir = path.join(tmpdir('d14'), 'spool');
    const { d, rows } = drainFor(dir);
    d.nudge();                                             // before start: ignored, no throw
    await d.start();
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, 'corrupt')).isDirectory(), true);
    await d.start();
    put(dir, 'w1-Stop-1-00000001.json', envl('Stop', hook('Stop', 'w1')));
    assert.ok(await waitFor(async () => (await rows()).length === 1, 2000), 'fs.watch triggered a pass');
    put(dir, 'w2-Stop-1-00000002.json', envl('Stop', hook('Stop', 'w2')));
    const reports = await Promise.all([d.drainOnce(), d.drainOnce()]);
    assert.equal((await rows()).length, 2, `reports ${show(reports)}`);
    await d.close(); await d.close();
    d.nudge();                                             // after close: ignored
  });

  await check('D15', 'gate test file exists with describe("memory.spool"); end to end: web down -> files -> web up -> once, corrupt kept', async () => {
    const gate = fs.readFileSync(path.join(ROOT, GATE_TEST), 'utf8');
    assert.match(gate, /describe\(\s*['"`]memory\.spool['"`]/);
    const dir = tmpdir('d15');
    const sid = `g-${rnd()}`;
    for (const [p, ev] of [[edit(sid), 'PostToolUse'], [edit(sid, `${CWD}/r.ts`, 'Read'), 'PostToolUse'], [hook('Stop', sid), 'Stop'], [hook('SessionEnd', sid, { reason: 'exit' }), 'SessionEnd']]) {
      const r = await runSpool({ stdin: JSON.stringify(p), args: [ev], dir });
      assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', '']);
    }
    assert.equal(listJson(dir).length, 4);
    put(dir, 'bad-Stop-1-00000001.json', 'not json');
    const { d, userId, rows } = drainFor(dir);
    const server = http.createServer((req, res) => {
      const route = web.nudgeRoute(d);
      if (req.method === route.method && req.url === route.url) route.handler(req, { code(n) { res.statusCode = n; return { send() { res.end(); } }; } });
      else { res.statusCode = 404; res.end(); }
    }).listen(0, '127.0.0.1');
    await new Promise((res) => server.on('listening', res));
    cleanups.push(() => new Promise((res) => server.close(res)));
    await d.start();
    assert.deepEqual(kinds(await rows()), ['graph.rebuild', 'llm.extract', 'llm.summarize']);
    assert.deepEqual(fs.readdirSync(dir), ['corrupt']);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'corrupt')), ['bad-Stop-1-00000001.json']);
    await d.drainOnce();
    const again = drainFor(dir, { userId }); await again.d.drainOnce();
    assert.equal((await rows()).length, 3);
    const nudgeUrl = `http://127.0.0.1:${server.address().port}/v1/spool/nudge`;
    await runSpool({ stdin: JSON.stringify(hook('Stop', `${sid}b`)), args: ['Stop'], dir, nudge: nudgeUrl });
    assert.ok(await waitFor(async () => (await rows()).length === 4, 2000), 'nudge delivered the new Stop within 2 s');
  });
} catch (e) {
  console.log(`checks aborted: ${e?.name}: ${e?.message}`);
}
await finish();
