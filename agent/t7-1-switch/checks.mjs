// checks for T7.1 switch over (settings.json hooks, ctc-web and ctc-worker mains, migration 0006, the gate runner and its reports): one runnable example per
// decision id (D0..D24). Prints `PASS D# ...` or `FAIL D# expected=<..> got=<..>`; last line `CHECKS: <n> pass, <m> fail`; exit 1 on any FAIL.
// Needs: env CTC_SCRATCH_PG_URL (scratch Postgres 127.0.0.1:18304 only), scratch Redis 127.0.0.1:18395 (env CTC_SCRATCH_REDIS_URL, default that), curl, psql, git, /bin/sh, node.
// Run from the repo root:  node --import tsx agent/t7-1-switch/checks.mjs      (tsx lets Node import the .ts sources)
// Own-validation switch: env T71_SETTINGS_FILE=<file> reads that file instead of .claude/settings.json (the planner tested D3/D4/D5 with a draft this way).
// Dev instances started here: HOME is an empty throwaway dir (proves nothing is written under ~), CTC_HOME is a throwaway dir, ports 18412-18419 (18410 is the
// live-smoke test's), scratch schemas `ctc_t71chk_<random>` (dropped at the end), Redis namespace `t71chk<random>:`. Only pids this file started are ever killed.
// Never touches 18310, ~/.claude, ~/.claudethecaller, Supabase or a container. Fixture values are this file's own.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(new URL('../../', import.meta.url).pathname);
const FAST = process.env.CTC_CHECKS_FAST === '1'; // --fast of selfcheck.py: the ledger of a full gate run does not exist yet, so the checks that read it only verify the runner's own behaviour
const IDS = Array.from({ length: 25 }, (_, i) => `D${i}`);
const WEB_MAIN = 'apps/web/src/server/main.ts';
const WORKER_MAIN = 'apps/worker/src/boot/main.ts';
const RUN_MJS = '.claude/metric/eval/switch/run.mjs';
const SETTINGS = process.env.T71_SETTINGS_FILE ? path.resolve(process.env.T71_SETTINGS_FILE) : path.join(ROOT, '.claude/settings.json');
const GATES = ['tenancy', 'failopen', 'ci', 'graph.ids', 'graph.resolve', 'graph.incremental', 'graph.query', 'suggest.latency', 'suggest.context', 'library.version', 'library.mcp',
  'library.override', 'suggest.skills', 'memory.spool', 'memory.idempotent', 'memory.bands', 'memory.context', 'memory.recall', 'runner.lifecycle', 'runner.crash', 'runner.fanout',
  'runner.idempotent', 'runner.md', 'dashboard-e2e', 'dev-instance'];
const TOOLS = ['graph_search', 'graph_explain', 'graph_path', 'graph_affected', 'graph_neighbors', 'get_capability', 'load_capability_resource', 'mem_search', 'mem_timeline', 'mem_get',
  'save_memory', 'run_workflow', 'workflow_status'];
const HANDLERS = ['cleanup.blobs', 'cleanup.receipts', 'cleanup.worktree', 'graph.extract', 'graph.rebuild', 'library.changed', 'library.scan', 'llm.extract', 'llm.summarize', 'memory.distill',
  'memory.import', 'runner.step'];
const ROUTES = ['POST /v1/hook/prompt', 'POST /v1/hook/pre', 'POST /v1/hook/start', 'POST /v1/suggest', 'POST /v1/spool/nudge', 'GET /v1/health', 'GET /api/capabilities', 'GET /api/capabilities/:id',
  'GET /api/capabilities/:id/versions', 'GET /api/capabilities/:id/versions/:v', 'GET /api/capabilities/:id/versions/:v/diff', 'PATCH /api/capabilities/:id/versions/:v/labels',
  'POST /api/capabilities/:id/restore', 'PUT /api/projects/:pid/capabilities/:id/override', 'DELETE /api/projects/:pid/capabilities/:id/override', 'POST /api/index',
  ...['search', 'explain', 'path', 'affected', 'neighbors', 'stats'].map((x) => `GET /api/graph/${x}`), 'POST /api/graph/build', 'PATCH /api/graph/edges', 'GET /api/memories', 'GET /api/memories/:id',
  'PATCH /api/memories/:id', 'DELETE /api/memories/:id', 'POST /api/memories/import', 'GET /api/sessions/:sid/summary', 'GET /api/history', 'POST /api/history/import', 'GET /api/workflows',
  'GET /api/workflows/:id', 'POST /api/workflows/:id/runs', 'GET /api/runs', 'GET /api/runs/:rid', 'POST /api/runs/:rid/approve', 'POST /api/runs/:rid/continue', 'GET /api/runs/:rid/steps/:sid/log',
  'POST /api/runs/:rid/steps/:sid/retry', 'POST /api/runs/:rid/steps/:sid/fail', 'POST /api/runs/:rid/steps/:sid/report', 'POST /api/runs/:rid/cancel'].sort();
const HOOK_ROUTES = [['UserPromptSubmit', 'prompt', '0.15', 1], ['PreToolUse', 'pre', '0.05', 1], ['SessionStart', 'start', '1.5', 3]];
const SPOOL_EVENTS = [['PostToolUse', 'Edit|Write|MultiEdit'], ['Stop', null], ['SessionEnd', null]];

let pass = 0; let fail = 0;
const done = new Set();
const show = (v) => { if (typeof v === 'string') return v.length > 600 ? `${v.slice(0, 600)}...` : v; try { const s = JSON.stringify(v); return s && s.length > 600 ? `${s.slice(0, 600)}...` : s; } catch { return '[unserializable]'; } };
function ok(id, msg) { pass++; done.add(id); console.log(`PASS ${id} ${msg}`); }
function bad(id, expected, got) { fail++; done.add(id); console.log(`FAIL ${id} expected=${show(expected)} got=${show(got)}`); }
async function check(id, msg, fn, limitMs = 280_000) {
  let timer;
  try {
    await Promise.race([fn(), new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`check timed out after ${limitMs / 1000} s`)), limitMs)))]);
    ok(id, msg);
  } catch (e) {
    if (e && e.name === 'AssertionError') bad(id, e.expected, `${e.generatedMessage ? '' : `${e.message.split('\n')[0]} | actual=`}${show(e.actual)}`); else bad(id, msg, `${e?.name}: ${e?.message}`);
  } finally { clearTimeout(timer); }
}
const cleanups = [];
async function finish() {
  for (const fn of cleanups.reverse()) { try { await fn(); } catch (e) { console.log(`note: cleanup failed: ${e?.message}`); } }
  for (const id of IDS) if (!done.has(id)) bad(id, 'a check', 'missing');
  console.log(`CHECKS: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
async function failAll(why) { for (const id of IDS) bad(id, 'scratch services configured', why); await finish(); }
process.on('unhandledRejection', () => {});
const rnd = () => randomBytes(4).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20_000, every = 100) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`condition not met within ${ms} ms`); await sleep(every); }
}
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' });

// ---- environment ------------------------------------------------------------------------------------------------------------
const PG = process.env.CTC_SCRATCH_PG_URL;
if (!PG) await failAll('env CTC_SCRATCH_PG_URL not set');
const pu = new URL(PG);
if (pu.hostname !== '127.0.0.1' || pu.port !== '18304') await failAll(`refusing ${pu.hostname}:${pu.port}, only the scratch Postgres 127.0.0.1:18304`);
const REDIS_RAW = process.env.CTC_SCRATCH_REDIS_URL ?? 'redis://127.0.0.1:18395';
const ru = new URL(REDIS_RAW);
if (ru.hostname !== '127.0.0.1' || ru.port !== '18395') await failAll(`refusing redis ${ru.hostname}:${ru.port}, only the scratch Redis 127.0.0.1:18395`);
const REDIS = 'redis://127.0.0.1:18395/0';
const TMP = process.env.T71_CHK_TMP ?? os.tmpdir();
const mk = (prefix) => { const d = fs.mkdtempSync(path.join(TMP, prefix)); cleanups.push(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const psql = (sql) => execFileSync('psql', ['-q', PG, '-Atc', sql], { encoding: 'utf8', env: { ...process.env, PGOPTIONS: '-c client_min_messages=warning' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let A; let adminLoaded = false;
try { A = await import(pathToFileURL(path.join(ROOT, 'packages/shared/src/repositories/admin/index.ts')).href); adminLoaded = true; } catch { /* D17 reports it */ }
const schemas = [];
cleanups.push(() => { for (const s of schemas) { try { psql(`drop schema if exists "${s}" cascade`); } catch { /* best effort */ } } });
async function newSchema(dir) {
  const schema = `ctc_t71chk_${rnd()}`; schemas.push(schema);
  assert.ok(adminLoaded, 'packages/shared/src/repositories/admin importable');
  await A.migrate({ url: PG, schema, ...(dir ? { dir } : {}) });
  return schema;
}
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CTC_') && k !== 'HOME'));
const EMPTY_HOME = mk('ctc-t71chk-home-');
const procs = new Set();
cleanups.push(() => { for (const p of procs) { if (p.exitCode === null) { try { p.kill('SIGKILL'); } catch { /* gone */ } } } });
function instEnv({ home, port, schema, ns = `t71chk${rnd()}:`, extra = {} }) {
  return { ...baseEnv, HOME: EMPTY_HOME, CTC_HOME: home, CTC_PORT: String(port), CTC_DATABASE_URL: PG, CTC_REDIS_URL: REDIS, CTC_DB_SCHEMA: schema, CTC_REDIS_NAMESPACE: ns, ...extra };
}
/** Starts a main as a child; `ready` resolves with the parsed ready line; `exit` with {code, signal}. */
function start(file, env) {
  const p = spawn(process.execPath, [path.join(ROOT, file)], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.add(p);
  const o = { p, out: '', err: '', lines: [] };
  let buf = '';
  p.stdout.on('data', (d) => { o.out += d; buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { o.lines.push(JSON.parse(l)); } catch { /* not json */ } } });
  p.stderr.on('data', (d) => { o.err += d; });
  o.exit = new Promise((res) => p.on('exit', (code, signal) => res({ code, signal })));
  o.ready = new Promise((res, rej) => {
    const t = setInterval(() => { const r = o.lines.find((l) => l.msg === 'ready'); if (r) { clearInterval(t); res(r); } }, 50);
    o.exit.then((e) => { clearInterval(t); rej(new Error(`exited ${e.code ?? e.signal} before ready: ${(o.out + o.err).slice(-500)}`)); });
    setTimeout(() => { clearInterval(t); rej(new Error(`not ready after 90 s: ${(o.out + o.err).slice(-500)}`)); }, 90_000);
  });
  o.ready.catch(() => {});
  o.text = () => o.out + o.err;
  return o;
}
async function expectExit(file, env, code, ms = 20_000) {
  const o = start(file, env);
  const r = await Promise.race([o.exit, sleep(ms).then(() => 'timeout')]);
  if (r === 'timeout') { o.p.kill('SIGKILL'); assert.fail(`${file} still running after ${ms} ms: ${o.text().slice(-300)}`); }
  assert.equal(r.code, code, `${file} exit code (${o.text().slice(-300)})`);
  assert.ok(!o.lines.some((l) => l.msg === 'ready'), 'no ready line');
  return o;
}
function request({ port, socketPath }, method, url, { headers = {}, body, ms = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...headers }; if (data && !Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['content-type'] = 'application/json';
    if (data) h['content-length'] = data.length;
    const req = http.request({ ...(socketPath ? { socketPath } : { host: '127.0.0.1', port }), method, path: url, headers: h, timeout: ms }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json; try { json = JSON.parse(text); } catch { /* text */ } resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    req.on('timeout', () => req.destroy(new Error(`request ${method} ${url} timed out`)));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
function runSh(command, { stdin = '', env = {}, ms = 15_000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn('/bin/sh', ['-c', command], { env: { ...baseEnv, HOME: EMPTY_HOME, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
    p.stdin.on('error', () => {}); p.stdin.end(stdin);
    const kill = setTimeout(() => p.kill('SIGKILL'), ms);
    p.on('exit', (code) => { clearTimeout(kill); resolve({ code, stdout, stderr, ms: Date.now() - t0 }); });
  });
}
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
function fakeServer(mode) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, type: req.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') });
      if (mode.kind === 'hang') return;
      res.writeHead(mode.status, { 'content-type': mode.type ?? 'text/plain' });
      res.end(mode.body ?? '');
    });
    req.resume();
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ port: srv.address().port, seen, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) })));
}
function settings() { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); }
function hookGroups() {
  const s = settings();
  const out = {};
  for (const [event, groups] of Object.entries(s.hooks ?? {})) out[event] = groups;
  return out;
}
function routeCommand(route) {
  for (const groups of Object.values(hookGroups())) for (const g of groups) for (const h of g.hooks ?? []) if (String(h.command).includes(`/v1/hook/${route}`)) return h.command;
  throw new Error(`no hook command for /v1/hook/${route}`);
}
function spoolCommand(event) {
  for (const g of hookGroups()[event] ?? []) for (const h of g.hooks ?? []) if (String(h.command).includes('hooks/spool')) return h.command;
  throw new Error(`no spool hook for ${event}`);
}
const ITEMS_HEAD = (() => { try { return JSON.parse(git('show', 'HEAD:.claude/settings.json')); } catch { return { hooks: {} }; } })();

// ---- shared web instance (D8-D14) ---------------------------------------------------------------------------------------------
let webInst;
async function web() {
  if (webInst) return webInst;
  webInst = (async () => {
    assert.ok(exists(WEB_MAIN), `module not built: ${WEB_MAIN} is missing`);
    const home = mk('ctc-t71chk-h-'); const schema = await newSchema();
    const port = 18412; const ns = `t71chk${rnd()}:`;
    const o = start(WEB_MAIN, instEnv({ home, port, schema, ns }));
    const ready = await o.ready;
    return { o, home, schema, port, ready, ns };
  })();
  webInst.catch(() => {});
  return webInst;
}
const gitRepo = () => {
  const d = mk('ctc-t71chk-repo-');
  fs.mkdirSync(path.join(d, 'src')); fs.mkdirSync(path.join(d, 'specs/001-demo'), { recursive: true });
  fs.writeFileSync(path.join(d, 'src/a.ts'), 'export function alpha() { return beta(); }\nexport function beta() { return 1; }\n');
  fs.writeFileSync(path.join(d, 'specs/001-demo/spec.md'), '# Demo\n\n## Tasks\n\n- T1 implement alpha in src/a.ts\n');
  execFileSync('git', ['init', '-q', d]); execFileSync('git', ['-C', d, '-c', 'user.email=a@b', '-c', 'user.name=chk', 'add', '-A']);
  execFileSync('git', ['-C', d, '-c', 'user.email=a@b', '-c', 'user.name=chk', 'commit', '-q', '-m', 'init']);
  return d;
};

// ---- D0 purpose and callers -----------------------------------------------------------------------------------------------------
await check('D0', 'bins ctc-web and ctc-worker point at executable mains with a shebang, the unit files name the same bins, the gate runner exists', async () => {
  const wp = JSON.parse(read('apps/web/package.json')); const kp = JSON.parse(read('apps/worker/package.json'));
  assert.equal(wp.bin?.['ctc-web'], './src/server/main.ts', 'apps/web bin ctc-web');
  assert.equal(kp.bin?.['ctc-worker'], './src/boot/main.ts', 'apps/worker bin ctc-worker');
  for (const f of [WEB_MAIN, WORKER_MAIN]) {
    assert.ok(exists(f), `${f} exists`);
    assert.ok(read(f).startsWith('#!/usr/bin/env node'), `${f} shebang`);
    assert.ok((fs.statSync(path.join(ROOT, f)).mode & 0o111) !== 0, `${f} executable`);
  }
  assert.ok(read('deploy/systemd/ctc-web.service').includes('ctc-web') && read('deploy/systemd/ctc-worker.service').includes('ctc-worker'), 'units name the bins');
  assert.ok(exists(RUN_MJS), `${RUN_MJS} exists`);
});

// ---- D1 trust -------------------------------------------------------------------------------------------------------------------
await check('D1', 'junk, huge and identity-spoofing hook bodies get an empty 204 on every hook route and the server stays healthy', async () => {
  const w = await web();
  const bodies = [Buffer.alloc(2 * 1024 * 1024, 0x61), Buffer.from([0, 1, 2, 0x7b, 0xff]), Buffer.from('{"cwd":"/etc","prompt":{"x":1},"userId":"someone-else"}'), Buffer.from('[]'), Buffer.from('null'), Buffer.from('"str"')];
  for (const route of ['prompt', 'pre', 'start']) {
    for (const body of bodies) {
      const r = await request({ port: w.port }, 'POST', `/v1/hook/${route}`, { body });
      assert.equal(r.status, 204, `/v1/hook/${route} with ${body.length} junk bytes`);
      assert.equal(r.text, '', 'empty body');
    }
  }
  const h = await request({ port: w.port }, 'GET', '/v1/health');
  assert.equal(h.status, 200);
  const r = await request({ port: w.port }, 'GET', '/api/runs', { headers: { 'x-user-id': 'someone-else', authorization: 'Bearer ctc_bogus' } });
  assert.equal(r.status, 200, 'identity headers are ignored in local mode');
});

// ---- D2 scope -------------------------------------------------------------------------------------------------------------------
await check('D2', 'the files D2 lists exist and nothing outside D2 changed', async () => {
  for (const f of [WEB_MAIN, WORKER_MAIN, '.claude/settings.json', 'packages/shared/migrations/0006_epochs.sql', '.claude/metric/eval/switch.md', '.claude/metric/eval/ci.md', RUN_MJS]) assert.ok(exists(f), `${f} exists`);
  const dirty = git('status', '--porcelain', '--untracked-files=all', '--', '.').split('\n').filter(Boolean).map((l) => l.slice(3).replace(/"/g, ''));
  const allowed = [/^apps\/web\/src\/server\//, /^apps\/worker\/src\/boot\//, /^apps\/web\/package\.json$/, /^apps\/worker\/package\.json$/, /^pnpm-lock\.yaml$/, /^\.claude\/settings\.json$/,
    /^packages\/shared\/migrations\/0006_epochs\.sql$/, /^packages\/shared\/src\/repositories\/admin\/migrate\.test\.ts$/, /^apps\/cli\/src\/migrate\.test\.ts$/, /^packages\/shared\/src\/repositories\/scratch\.ts$/, /^packages\/shared\/src\/repositories\/fixtures\/schema-columns\.json$/,
    /^\.claude\/metric\/eval\/(ci\.md|switch\.md|switch\/)/, /^agent\//, /^specs\//, /^\.claude\/agents\//, /^\.ctc-dev\//, /(^|\/)node_modules\/?$/, /^\.venv\/?$/];
  const outside = dirty.filter((p) => !allowed.some((re) => re.test(p)));
  assert.deepEqual(outside, [], 'paths changed outside D2');
});

// ---- D3 settings.json -----------------------------------------------------------------------------------------------------------
await check('D3', 'settings.json keeps the two graphify groups first and adds exactly the six hook groups of D3', async () => {
  const s = settings();
  assert.deepEqual(Object.keys(s), Object.keys(ITEMS_HEAD).length ? Object.keys(ITEMS_HEAD) : ['hooks'], 'top-level keys unchanged');
  const g = s.hooks;
  assert.deepEqual(Object.keys(g).sort(), ['PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'], 'events');
  const headPre = ITEMS_HEAD.hooks?.PreToolUse ?? [];
  assert.equal(headPre.length, 2, 'HEAD has the two graphify groups');
  assert.deepEqual(g.PreToolUse.slice(0, 2), headPre, 'graphify groups deep-equal and first');
  assert.equal(g.PreToolUse.length, 3, 'one new PreToolUse group');
  for (const [event, groups] of Object.entries(g)) {
    const added = event === 'PreToolUse' ? groups.slice(2) : groups;
    assert.equal(added.length, 1, `${event}: exactly one new group`);
    assert.equal(added[0].hooks.length, 1, `${event}: one hook`);
    const h = added[0].hooks[0];
    assert.deepEqual(Object.keys(h).sort(), ['command', 'timeout', 'type'], `${event}: hook keys`);
    assert.equal(h.type, 'command'); assert.equal(typeof h.timeout, 'number');
    assert.ok(!/ctc\.sock|--unix-socket|~/.test(h.command), `${event}: no socket or ~`);
    const without = h.command.replaceAll('${CTC_PORT:-18310}', '');
    assert.ok(!/18310/.test(without), `${event}: 18310 only as the default of CTC_PORT`);
  }
  for (const [event, route, , timeout] of HOOK_ROUTES) {
    const grp = (event === 'PreToolUse' ? g[event].slice(2) : g[event])[0];
    assert.equal(grp.hooks[0].timeout, timeout, `${event} timeout`);
    assert.ok(grp.hooks[0].command.includes(`/v1/hook/${route}`), `${event} route`);
    if (event === 'PreToolUse') assert.equal(grp.matcher, 'Read|Edit|Write|MultiEdit|Grep|Glob|Bash', 'PreToolUse matcher'); else assert.equal(grp.matcher, undefined, `${event} has no matcher`);
  }
  for (const [event, matcher] of SPOOL_EVENTS) {
    const grp = g[event][0];
    assert.equal(grp.hooks[0].timeout, 2, `${event} timeout`);
    assert.ok(grp.hooks[0].command.includes('hooks/spool') && grp.hooks[0].command.includes(event), `${event} runs hooks/spool ${event}`);
    assert.equal(grp.matcher, matcher ?? undefined, `${event} matcher`);
  }
});

// ---- D4 hook command behaviour ----------------------------------------------------------------------------------------------------
await check('D4', 'each route hook relays 200 bodies, drops 204/4xx/5xx, fails open on hang or refusal; the spool hooks write a file and always exit 0', async () => {
  const stdin = '{"hook_event_name":"X","prompt":"héllo\\nworld \\u2603","cwd":"/tmp/x"}\n';
  for (const [, route, m] of HOOK_ROUTES) {
    const cmd = routeCommand(route);
    assert.ok(new RegExp(`-m\\s+${m.replace('.', '\\.')}(\\s|$)`).test(cmd), `${route}: curl -m ${m}`);
    assert.ok(/\|\|\s*true\s*$/.test(cmd), `${route}: ends with || true`);
    assert.ok(cmd.includes('${CTC_PORT:-18310}'), `${route}: port expression`);
    const cases = [[{ status: 200, body: `reply for ${route} ✓`, type: 'text/plain' }, `reply for ${route} ✓`], [{ status: 204 }, ''], [{ status: 500, body: '{"error":{"code":"internal"}}', type: 'application/json' }, ''],
      [{ status: 422, body: '{"error":{"code":"invalid"}}', type: 'application/json' }, '']];
    for (const [mode, want] of cases) {
      const srv = await fakeServer(mode);
      const r = await runSh(cmd, { stdin, env: { CTC_PORT: String(srv.port) } });
      await srv.close();
      assert.equal(r.code, 0, `${route} ${mode.status}: exit`); assert.equal(r.stdout, want, `${route} ${mode.status}: stdout`); assert.equal(r.stderr, '', `${route} ${mode.status}: stderr`);
      const q = srv.seen[0];
      assert.ok(q, `${route} ${mode.status}: request seen`);
      assert.deepEqual([q.method, q.url, q.body], ['POST', `/v1/hook/${route}`, stdin], `${route}: method, path and body relayed`);
      assert.ok(/^application\/json/i.test(q.type ?? ''), `${route}: content-type json, got ${q.type}`);
    }
    const hang = await fakeServer({ kind: 'hang' });
    const rh = await runSh(cmd, { stdin, env: { CTC_PORT: String(hang.port) } });
    await hang.close();
    assert.equal(rh.code, 0, `${route} hang: exit`); assert.equal(rh.stdout, '', `${route} hang: stdout`);
    assert.ok(rh.ms <= Number(m) * 1000 + 500, `${route} hang: back in ${Number(m) * 1000 + 500} ms, took ${rh.ms}`);
    const rr = await runSh(cmd, { stdin, env: { CTC_PORT: String(await freePort()) } });
    assert.deepEqual([rr.code, rr.stdout, rr.stderr], [0, '', ''], `${route} refused`);
    assert.ok(rr.ms < 1500, `${route} refused: ${rr.ms} ms`);
  }
  for (const [event] of SPOOL_EVENTS) {
    const cmd = spoolCommand(event);
    assert.ok(/\|\|\s*true\s*$/.test(cmd), `${event}: ends with || true`);
    const dir = mk('ctc-t71chk-spool-'); const srv = await fakeServer({ status: 204 });
    const payload = `{"hook_event_name":"${event}","session_id":"s-d4","cwd":"/tmp/x","tool_name":"Edit","tool_input":{"file_path":"/tmp/x/a.ts"}}`;
    const r = await runSh(cmd, { stdin: payload, env: { CLAUDE_PROJECT_DIR: ROOT, CTC_SPOOL_DIR: dir, CTC_NUDGE_URL: `http://127.0.0.1:${srv.port}/v1/spool/nudge` } });
    assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', ''], `${event} exit/stdout/stderr`);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1, `${event}: one spool file`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8')).event, event, `${event}: event in file`);
    await until(() => srv.seen.length > 0, 3000); await srv.close();
    const none = mk('ctc-t71chk-spool-');
    for (const cpd of ['', '/nonexistent-ctc-t71']) {
      const r2 = await runSh(cmd, { stdin: payload, env: { CLAUDE_PROJECT_DIR: cpd, CTC_SPOOL_DIR: none } });
      assert.deepEqual([r2.code, r2.stdout, r2.stderr], [0, '', ''], `${event} with CLAUDE_PROJECT_DIR=${JSON.stringify(cpd)} still exits 0 quietly`);
    }
  }
});

// ---- D5 hooks/spool untouched -----------------------------------------------------------------------------------------------------
await check('D5', 'hooks/spool is byte-identical to HEAD and no wrapper script was added', async () => {
  assert.equal(git('status', '--porcelain', '--', 'hooks').trim(), '', 'hooks/ unchanged');
  assert.equal(git('diff', 'HEAD', '--stat', '--', 'hooks/spool').trim(), '', 'no diff against HEAD');
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'hooks')).sort(), ['spool'], 'only hooks/spool');
});

// ---- D6 isolation guards ---------------------------------------------------------------------------------------------------------
await check('D6', 'with CTC_HOME set, a port outside 18400-18499, a non-scratch database or Redis exits 78 before connecting and never prints a password; nothing is written under HOME', async () => {
  assert.ok(exists(WEB_MAIN) && exists(WORKER_MAIN), 'both mains exist');
  const home = mk('ctc-t71chk-g-'); const schema = `ctc_t71chk_${rnd()}`;
  const base = { home, port: 18413, schema };
  const o1 = await expectExit(WEB_MAIN, instEnv({ ...base, port: 18310 }), 78);
  assert.ok(/port/i.test(o1.text()), `message names the port: ${o1.text().slice(-200)}`);
  await expectExit(WEB_MAIN, instEnv({ ...base, port: 18303 }), 78);
  const o3 = await expectExit(WEB_MAIN, instEnv({ ...base, extra: { CTC_DATABASE_URL: 'postgresql://u:secretpw@10.255.255.1:5432/x' } }), 78);
  assert.ok(!o3.text().includes('secretpw'), 'password not printed');
  const o4 = await expectExit(WEB_MAIN, instEnv({ ...base, extra: { CTC_REDIS_URL: 'redis://:secretpw@127.0.0.1:18303/0' } }), 78);
  assert.ok(!o4.text().includes('secretpw'), 'redis password not printed');
  const o5 = await expectExit(WORKER_MAIN, instEnv({ ...base, extra: { CTC_DATABASE_URL: 'postgresql://u:secretpw@10.255.255.1:5432/x' } }), 78);
  assert.ok(!o5.text().includes('secretpw'));
  await expectExit(WORKER_MAIN, instEnv({ ...base, extra: { CTC_REDIS_URL: 'redis://127.0.0.1:18303/0' } }), 78);
  assert.deepEqual(fs.readdirSync(EMPTY_HOME), [], 'HOME stayed empty');
});

// ---- D7 env and exit codes -------------------------------------------------------------------------------------------------------
await check('D7', 'a bad config key, a bad CTC_DB_SCHEMA and a missing database url exit 78 naming the setting; the ready lines have the D7 shape', async () => {
  const cfg = mk('ctc-t71chk-cfg-'); fs.cpSync(path.join(ROOT, 'config'), cfg, { recursive: true });
  fs.appendFileSync(path.join(cfg, 'server.yaml'), '\nbogus_key_t71: 1\n');
  const home = mk('ctc-t71chk-e-'); const schema = `ctc_t71chk_${rnd()}`;
  const o1 = await expectExit(WEB_MAIN, instEnv({ home, port: 18413, schema, extra: { CTC_CONFIG_DIR: cfg } }), 78);
  assert.ok(o1.text().includes('bogus_key_t71'), `names the bad key: ${o1.text().slice(-200)}`);
  const o2 = await expectExit(WEB_MAIN, instEnv({ home, port: 18413, schema: 'Bad;Schema' }), 78);
  assert.ok(/schema/i.test(o2.text()), 'names the schema');
  const e3 = instEnv({ home, port: 18413, schema }); delete e3.CTC_DATABASE_URL;
  const o3 = await expectExit(WEB_MAIN, e3, 78);
  assert.ok(/database_url/.test(o3.text()), 'names database_url');
  const w = await web();
  assert.equal(w.ready.app, 'ctc-web'); assert.equal(w.ready.port, 18412); assert.ok(Array.isArray(w.ready.routes), 'routes array');
  for (const l of w.o.lines) assert.equal(typeof l.msg, 'string', 'every log line has msg');
  assert.ok(!w.o.text().includes('ctcdev'), 'database password never logged');
});

// ---- D8 listeners and health ------------------------------------------------------------------------------------------------------
await check('D8', '/v1/health is 200 with the D8 shape on the loopback port and on the unix socket (when the path fits); the socket is mode 0600', async () => {
  const w = await web();
  const r = await request({ port: w.port }, 'GET', '/v1/health');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ['db', 'mode', 'redis', 'status', 'uptime_s']);
  assert.deepEqual([r.json.status, r.json.mode, r.json.db, r.json.redis], ['ok', 'local', 'up', 'up']);
  assert.equal(typeof r.json.uptime_s, 'number');
  const sock = path.join(w.home, '.claudethecaller/ctc.sock');
  if (Buffer.byteLength(sock) <= 100) {
    assert.ok(fs.existsSync(sock), `socket ${sock}`);
    assert.equal(fs.statSync(sock).mode & 0o777, 0o600, 'socket mode');
    const s = await request({ socketPath: sock }, 'GET', '/v1/health');
    assert.equal(s.status, 200);
  } else {
    assert.ok(w.o.lines.some((l) => /socket skipped/.test(l.msg)), 'long socket path: skipped with a log line');
  }
});

// ---- D9 route table ---------------------------------------------------------------------------------------------------------------
await check('D9', 'the ready line lists exactly the expected METHOD url set; non-parameter routes are mounted; an unknown URL is a 404 not_found; /api/schedules is not mounted', async () => {
  const w = await web();
  assert.deepEqual([...w.ready.routes].sort(), ROUTES, 'route table');
  assert.equal(new Set(w.ready.routes).size, w.ready.routes.length, 'no duplicates');
  for (const r of ROUTES.filter((x) => !x.includes(':'))) {
    const [method, url] = r.split(' ');
    const res = await request({ port: w.port }, method, url, { body: method === 'GET' ? undefined : '{}' });
    assert.ok(res.status !== 404, `${r} is mounted (got ${res.status})`);
  }
  const nf = await request({ port: w.port }, 'GET', '/api/nope');
  assert.equal(nf.status, 404); assert.equal(nf.json?.error?.code, 'not_found');
  assert.equal((await request({ port: w.port }, 'GET', '/api/schedules')).status, 404);
});

// ---- D10 bodies and content types ---------------------------------------------------------------------------------------------------
await check('D10', 'hook routes parse JSON under any content type and cap the body at 1 MiB with an empty 204; /api answers 422 invalid for a bad or oversized JSON body', async () => {
  const w = await web();
  const body = JSON.stringify({ cwd: '/nonexistent-ctc-t71', tool_name: 'Read', tool_input: { file_path: '/nonexistent-ctc-t71/a.ts' }, session_id: 's-d10', hook_event_name: 'PreToolUse' });
  const a = await request({ port: w.port }, 'POST', '/v1/hook/pre', { body, headers: { 'content-type': 'application/json' } });
  const b = await request({ port: w.port }, 'POST', '/v1/hook/pre', { body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const c = await request({ port: w.port }, 'POST', '/v1/hook/pre', { body, headers: { 'content-type': 'text/plain' } });
  assert.deepEqual([b.status, b.text], [a.status, a.text], 'form content type behaves as json');
  assert.deepEqual([c.status, c.text], [a.status, a.text], 'text/plain behaves as json');
  const limit = 1_048_576;
  const pad = (n) => JSON.stringify({ cwd: '/x', prompt: 'a'.repeat(n) });
  const over = Buffer.alloc(limit + 1, 0x20); Buffer.from('{"cwd":"/x"}').copy(over);
  const o1 = await request({ port: w.port }, 'POST', '/v1/hook/prompt', { body: over });
  assert.deepEqual([o1.status, o1.text], [204, ''], 'over the limit');
  const o2 = await request({ port: w.port }, 'POST', '/v1/hook/prompt', { body: pad(1000) });
  assert.ok(o2.status === 204 || o2.status === 200, 'small body fine');
  const bj = await request({ port: w.port }, 'POST', '/api/graph/build', { body: '{', headers: { 'content-type': 'application/json' } });
  assert.equal(bj.status, 422); assert.equal(bj.json?.error?.code, 'invalid');
  const big = await request({ port: w.port }, 'POST', '/api/graph/build', { body: Buffer.concat([Buffer.from('{"x":"'), Buffer.alloc(limit, 0x61), Buffer.from('"}')]) });
  assert.equal(big.status, 422, 'oversized /api body'); assert.equal(big.json?.error?.code, 'invalid');
  const tp = await request({ port: w.port }, 'POST', '/api/graph/build', { body: '{}', headers: { 'content-type': 'text/plain' } });
  assert.ok(tp.status >= 400 && tp.status < 500 && tp.json?.error, '/api needs application/json');
});

// ---- D11 hooks never error -------------------------------------------------------------------------------------------------------------
await check('D11', 'wrong-typed fields on every hook route are an empty 204; /api errors carry only code and message; the server survives', async () => {
  const w = await web();
  const weird = [{ cwd: 5 }, { cwd: '/' + 'a'.repeat(5000), prompt: 'x' }, { cwd: '../relative', tool_name: ['Edit'] }, { prompt: 'x' }, { session_id: { a: 1 } }, {}];
  for (const route of ['prompt', 'pre', 'start']) for (const b of weird) {
    const r = await request({ port: w.port }, 'POST', `/v1/hook/${route}`, { body: b });
    assert.ok(r.status === 204 || (r.status === 200 && r.text.length > 0), `/v1/hook/${route} ${JSON.stringify(b).slice(0, 40)}: ${r.status}`);
    assert.ok(r.status !== 204 || r.text === '', '204 has no body');
  }
  const e = await request({ port: w.port }, 'GET', '/api/runs/not-a-real-run');
  assert.ok(e.status >= 400 && e.status < 600, `error status ${e.status}`);
  assert.deepEqual(Object.keys(e.json?.error ?? {}).filter((k) => !['code', 'message', 'candidates', 'path'].includes(k)), [], 'error body keys');
  assert.ok(!/at .*\.ts:\d+/.test(e.text), 'no stack trace');
  assert.equal((await request({ port: w.port }, 'GET', '/v1/health')).status, 200);
});

// ---- D12 modes --------------------------------------------------------------------------------------------------------------------------
await check('D12', 'shared mode exits 78 naming it; a bogus Bearer header is ignored in local mode', async () => {
  const home = mk('ctc-t71chk-m-');
  const o = await expectExit(WEB_MAIN, instEnv({ home, port: 18413, schema: `ctc_t71chk_${rnd()}`, extra: { CTC_MODE: 'shared' } }), 78);
  assert.ok(/shared/i.test(o.text()), `names shared mode: ${o.text().slice(-200)}`);
  const w = await web();
  for (const url of ['/v1/health', '/api/runs']) assert.equal((await request({ port: w.port }, 'GET', url, { headers: { authorization: 'Bearer ctc_not_a_key' } })).status, 200, url);
});

// ---- D13 wiring ---------------------------------------------------------------------------------------------------------------------------
await check('D13', 'the spool drain is wired (an Edit event becomes a graph.rebuild job row); with a missing database the process starts, health says db down, hooks answer 204 and /api answers 500 internal', async () => {
  const w = await web(); const repo = gitRepo();
  const dir = path.join(w.home, '.claudethecaller/spool');
  const payload = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's-d13', cwd: repo, tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src/a.ts') } });
  const r = await runSh(spoolCommand('PostToolUse'), { stdin: payload, env: { CLAUDE_PROJECT_DIR: ROOT, CTC_SPOOL_DIR: dir, CTC_NUDGE_URL: `http://127.0.0.1:${w.port}/v1/spool/nudge` } });
  assert.equal(r.code, 0);
  await until(() => psql(`select count(*) from "${w.schema}".jobs where queue='graph' and kind='rebuild'`) !== '0', 20_000);
  await until(() => fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length === 0, 10_000);
  const home2 = mk('ctc-t71chk-nodb-');
  const down = instEnv({ home: home2, port: 18414, schema: `ctc_t71chk_${rnd()}`, extra: { CTC_DATABASE_URL: PG.replace(/\/[^/]*$/, '/ctc_t71_no_such_db') } });
  const o = start(WEB_MAIN, down); await o.ready;
  try {
    const h = await request({ port: 18414 }, 'GET', '/v1/health');
    assert.equal(h.status, 200); assert.equal(h.json.db, 'down');
    assert.equal((await request({ port: 18414 }, 'POST', '/v1/hook/prompt', { body: { prompt: 'x', cwd: repo } })).status, 204);
    const a = await request({ port: 18414 }, 'GET', '/api/runs');
    assert.equal(a.status, 500); assert.equal(a.json?.error?.code, 'internal');
  } finally { o.p.kill('SIGTERM'); await Promise.race([o.exit, sleep(15_000)]); }
});

// ---- D14 MCP -------------------------------------------------------------------------------------------------------------------------------
const rpc = async (port, method, params, id = 1) => {
  const r = await request({ port }, 'POST', '/mcp', { body: { jsonrpc: '2.0', id, method, params }, headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' } });
  let msg = r.json;
  if (!msg) { const line = r.text.split('\n').find((l) => l.startsWith('data:')); msg = line ? JSON.parse(line.slice(5)) : undefined; }
  return { status: r.status, msg };
};
await check('D14', '/mcp is stateless Streamable HTTP: initialize names claudethecaller, tools/list is exactly the 13 tools, an unknown tool is -32602, GET is 405', async () => {
  const w = await web();
  const init = await rpc(w.port, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'chk', version: '0' } });
  assert.equal(init.status, 200); assert.equal(init.msg?.result?.serverInfo?.name, 'claudethecaller');
  const list = await rpc(w.port, 'tools/list', {}, 2);
  const tools = list.msg?.result?.tools ?? [];
  assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOLS].sort(), 'tool names');
  for (const t of tools) { assert.ok(t.description?.length > 0, `${t.name} description`); assert.equal(t.inputSchema?.type, 'object', `${t.name} inputSchema`); }
  const unk = await rpc(w.port, 'tools/call', { name: 'no_such_tool', arguments: {} }, 3);
  assert.equal(unk.msg?.error?.code, -32602, `unknown tool: ${show(unk)}`);
  const bad = await rpc(w.port, 'tools/call', { name: 'workflow_status', arguments: { run_id: 12345 } }, 4);
  assert.ok(bad.msg?.result?.isError === true || bad.msg?.error, `bad arguments are an error result, not a crash: ${show(bad)}`);
  assert.equal((await request({ port: w.port }, 'GET', '/mcp')).status, 405);
  assert.equal((await request({ port: w.port }, 'DELETE', '/mcp')).status, 405);
  assert.equal((await request({ port: w.port }, 'GET', '/v1/health')).status, 200);
});

// ---- D15 boot order, stamp and stop ---------------------------------------------------------------------------------------------------------
await check('D15', 'a schema behind the binary exits 78 saying "ctc migrate"; SIGTERM stops web cleanly within 15 s and removes the socket and frees the port', async () => {
  const mig = path.join(ROOT, 'packages/shared/migrations');
  const old = mk('ctc-t71chk-mig-');
  for (const f of fs.readdirSync(mig).filter((x) => /^000[1-5]_/.test(x))) fs.copyFileSync(path.join(mig, f), path.join(old, f));
  const behind = await newSchema(old);
  const home = mk('ctc-t71chk-s-');
  const o = await expectExit(WEB_MAIN, instEnv({ home, port: 18413, schema: behind }), 78, 60_000);
  assert.ok(/ctc migrate/.test(o.text()), `says to run ctc migrate: ${o.text().slice(-200)}`);
  const home2 = mk('ctc-t71chk-t-'); const schema = await newSchema();
  const a = start(WEB_MAIN, instEnv({ home: home2, port: 18415, schema }));
  await a.ready;
  const sock = path.join(home2, '.claudethecaller/ctc.sock');
  const hadSock = fs.existsSync(sock);
  const t0 = Date.now(); a.p.kill('SIGTERM');
  const e = await Promise.race([a.exit, sleep(16_000).then(() => 'timeout')]);
  assert.notEqual(e, 'timeout', 'stopped within 15 s'); assert.equal(e.code, 0, 'exit 0'); assert.ok(Date.now() - t0 < 15_500);
  if (hadSock) assert.ok(!fs.existsSync(sock), 'socket file removed');
  await assert.rejects(request({ port: 18415 }, 'GET', '/v1/health', { ms: 1500 }), 'port closed');
});

// ---- D16 worker main -------------------------------------------------------------------------------------------------------------------------
await check('D16', 'the worker registers exactly the 12 handler keys, runs a library.scan job submitted through the web, and stops cleanly within 15 s', async () => {
  const w = await web();
  const k = start(WORKER_MAIN, instEnv({ home: w.home, port: 18416, schema: w.schema, ns: w.ns })); // same schema, same Redis namespace as the web instance: the queue is shared
  const ready = await k.ready;
  try {
    assert.equal(ready.app, 'ctc-worker'); assert.deepEqual([...ready.handlers].sort(), HANDLERS, 'handler keys');
    assert.ok(!ready.handlers.includes('llm.enrich'), 'no llm.enrich handler');
    const r = await request({ port: w.port }, 'POST', '/api/index', { body: {} });
    assert.ok(r.status === 202 || r.status === 200, `POST /api/index: ${r.status} ${r.text.slice(0, 200)}`);
    await until(() => psql(`select status from "${w.schema}".jobs where queue='library' and kind='scan' order by created_at desc limit 1`) === 'done', 60_000, 250);
  } finally {
    const t0 = Date.now(); k.p.kill('SIGTERM');
    const e = await Promise.race([k.exit, sleep(16_000).then(() => 'timeout')]);
    assert.notEqual(e, 'timeout', 'worker stopped within 15 s'); assert.equal(e.code, 0, 'exit 0'); assert.ok(Date.now() - t0 < 15_500);
  }
});

// ---- D17 migration 0006 ---------------------------------------------------------------------------------------------------------------------------
await check('D17', 'migration 0006 adds projects.graph_epoch and mem_epoch (bigint not null default 0); six files, stamp 6; schema-assumptions, migrate and cli migrate tests pass', async () => {
  const f = 'packages/shared/migrations/0006_epochs.sql'; assert.ok(exists(f), f);
  const sql = read(f);
  assert.ok(/graph_epoch/.test(sql) && /mem_epoch/.test(sql) && /bigint/i.test(sql) && /not null/i.test(sql) && /default 0/i.test(sql) && /if not exists/i.test(sql), 'sql content');
  assert.ok(adminLoaded, 'admin module importable');
  assert.deepEqual(A.loadMigrations().map((m) => m.file), ['0001_base.sql', '0002_graph.sql', '0003_library.sql', '0004_memory.sql', '0005_runner.sql', '0006_epochs.sql']);
  const schema = await newSchema();
  assert.equal(await A.schemaVersion({ url: PG, schema }), 6);
  const cols = psql(`select column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'') from information_schema.columns where table_schema='${schema}' and table_name='projects' and column_name in ('graph_epoch','mem_epoch') order by 1`);
  assert.equal(cols, 'graph_epoch:bigint:NO:0\nmem_epoch:bigint:NO:0');
  for (const n of ['0001_base', '0002_graph', '0003_library', '0004_memory', '0005_runner']) assert.equal(git('status', '--porcelain', '--', `packages/shared/migrations/${n}.sql`).trim(), '', `${n} untouched`);
  const t = spawnSync('timeout', ['300', 'pnpm', 'exec', 'vitest', 'run', 'packages/shared/src/repositories/schema-assumptions.test.ts', 'packages/shared/src/repositories/admin/migrate.test.ts', 'apps/cli/src/migrate.test.ts', '--reporter=dot'],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CTC_TEST_DATABASE_URL: PG, CTC_TEST_ADMIN_URL: PG, CTC_SCRATCH_PG_URL: PG } });
  assert.equal(t.status, 0, `vitest: ${(t.stdout + t.stderr).slice(-600)}`);
}, 320_000);

// ---- D18 dependencies ----------------------------------------------------------------------------------------------------------------------------
await check('D18', 'fastify 5 and @modelcontextprotocol/sdk 1 are exact pins in apps/web, the lockfile is frozen-clean, no new file imports pg or kysely', async () => {
  const wp = JSON.parse(read('apps/web/package.json'));
  const fv = wp.dependencies?.fastify; const sv = wp.dependencies?.['@modelcontextprotocol/sdk'];
  assert.ok(/^5\.\d+\.\d+$/.test(fv ?? ''), `fastify exact 5.x.y, got ${fv}`);
  assert.ok(/^1\.\d+\.\d+$/.test(sv ?? ''), `sdk exact 1.x.y, got ${sv}`);
  const lock = read('pnpm-lock.yaml'); assert.ok(lock.includes(`fastify@${fv}`) && lock.includes('@modelcontextprotocol/sdk@'), 'lockfile has both');
  const r = spawnSync('timeout', ['300', 'pnpm', 'install', '--frozen-lockfile'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, `pnpm install --frozen-lockfile: ${(r.stdout + r.stderr).slice(-400)}`);
  for (const dir of ['apps/web/src/server', 'apps/worker/src/boot']) for (const file of walk(dir)) assert.ok(!/from\s+['"](pg|kysely)['"]/.test(fs.readFileSync(file, 'utf8')), `${file} imports pg or kysely`);
}, 320_000);
function walk(dir) {
  const out = []; const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  const rec = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'fixtures') rec(p); } else out.push(p); } };
  rec(abs); return out;
}

// ---- D19 the gates ---------------------------------------------------------------------------------------------------------------------------------
const LEDGER = path.join(ROOT, '.ctc-dev/eval/switch.json');
await check('D19', 'run.mjs lists the 25 gate names in order, refuses a non-scratch database, records dashboard-e2e as not_run; the ledger of the last full run has every other gate green', async () => {
  const l = spawnSync(process.execPath, [path.join(ROOT, RUN_MJS), '--list'], { cwd: ROOT, encoding: 'utf8', env: { ...baseEnv, CTC_SCRATCH_PG_URL: PG } });
  assert.equal(l.status, 0, `--list: ${l.stderr}`);
  assert.deepEqual(l.stdout.split('\n').filter(Boolean), GATES, '--list');
  const out = path.join(mk('ctc-t71chk-led-'), 'one.json');
  const refuse = spawnSync(process.execPath, [path.join(ROOT, RUN_MJS), '--only', 'dashboard-e2e', '--out', out], { cwd: ROOT, encoding: 'utf8', env: { ...baseEnv, CTC_SCRATCH_PG_URL: 'postgresql://u:p@10.255.255.1:5432/x' } });
  assert.equal(refuse.status, 2, 'refuses a non-scratch database with exit 2'); assert.ok(!fs.existsSync(out), 'nothing written');
  const unknown = spawnSync(process.execPath, [path.join(ROOT, RUN_MJS), '--only', 'no.such.gate', '--out', out], { cwd: ROOT, encoding: 'utf8', env: { ...baseEnv, CTC_SCRATCH_PG_URL: PG } });
  assert.equal(unknown.status, 2, 'unknown gate is exit 2');
  const one = spawnSync(process.execPath, [path.join(ROOT, RUN_MJS), '--only', 'dashboard-e2e', '--out', out], { cwd: ROOT, encoding: 'utf8', env: { ...baseEnv, CTC_SCRATCH_PG_URL: PG } });
  assert.equal(one.status, 0, `dashboard-e2e alone: ${one.stderr}`);
  const row = JSON.parse(fs.readFileSync(out, 'utf8')).rows;
  assert.equal(row.length, 1); assert.equal(row[0].status, 'not_run'); assert.ok(/O12/.test(row[0].reason ?? ''), 'reason cites O12'); assert.equal(row[0].area, 'Dashboard');
  if (FAST) return;
  assert.ok(fs.existsSync(LEDGER), `${LEDGER} exists: run node ${RUN_MJS} first`);
  const led = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  assert.equal(led.head, git('rev-parse', 'HEAD').trim(), 'ledger was written at this HEAD');
  assert.deepEqual(led.rows.map((r) => r.gate), GATES, 'ledger rows in order');
  for (const r of led.rows) {
    assert.ok(r.command && r.area, `${r.gate}: command and area`);
    if (r.gate === 'dashboard-e2e') { assert.equal(r.status, 'not_run'); continue; }
    assert.equal(r.status, 'pass', `${r.gate}: ${r.status} ${r.reason ?? ''}`);
    if (r.gate !== 'ci') assert.ok(r.passed >= 1 && r.failed === 0 && r.skipped === 0, `${r.gate}: counts ${r.passed}/${r.failed}/${r.skipped}`);
  }
}, 120_000);

// ---- D20 dev-instance smoke --------------------------------------------------------------------------------------------------------------------------
await check('D20', 'the three route hook commands from settings.json work against a real instance on a throwaway repo; switch.live exists with its name; its ledger row is green', async () => {
  const w = await web(); const repo = gitRepo();
  const cases = [['prompt', { hook_event_name: 'UserPromptSubmit', session_id: 's-d20', cwd: repo, prompt: 'where is alpha defined' }, 400, 0.15],
    ['pre', { hook_event_name: 'PreToolUse', session_id: 's-d20', cwd: repo, tool_name: 'Read', tool_input: { file_path: path.join(repo, 'src/a.ts') } }, 5000, 0.05],
    ['start', { hook_event_name: 'SessionStart', session_id: 's-d20', cwd: repo, source: 'startup' }, 10_000, 1.5]];
  for (const [route, body, maxChars, m] of cases) {
    const r = await runSh(routeCommand(route), { stdin: JSON.stringify(body), env: { CTC_PORT: String(w.port) } });
    assert.equal(r.code, 0, `${route} exit`); assert.ok(r.stdout.length <= maxChars, `${route} stdout ${r.stdout.length} chars`);
    assert.ok(r.ms < m * 1000 + 3000, `${route}: ${r.ms} ms (the first call may build the project)`);
    if (route === 'pre' && r.stdout) assert.ok(typeof JSON.parse(r.stdout).hookSpecificOutput?.additionalContext === 'string', 'pre reply is hookSpecificOutput JSON');
  }
  const f = 'apps/web/src/server/switch.live.int.test.ts'; assert.ok(exists(f), f);
  assert.ok(/describe\(\s*['"`]switch\.live['"`]/.test(read(f)), 'describe switch.live');
  if (FAST) return;
  assert.ok(fs.existsSync(LEDGER), 'ledger exists'); const row = JSON.parse(fs.readFileSync(LEDGER, 'utf8')).rows.find((r) => r.gate === 'dev-instance');
  assert.equal(row?.status, 'pass', `dev-instance row: ${show(row)}`);
});

// ---- D21 O12 safety ---------------------------------------------------------------------------------------------------------------------------------
await check('D21', 'no changed file mentions systemctl, pkill, killall, docker stop/rm/restart or supabase; no non-test source names port 18310 outside the CTC_PORT default; no settings.local.json; no write outside D2', async () => {
  const changed = git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean).map((l) => l.slice(3).replace(/"/g, '').split(' -> ').pop())
    .filter((p) => !/^(agent|specs|\.claude\/agents|\.ctc-dev)\//.test(p) && !p.endsWith('pnpm-lock.yaml') && fs.existsSync(path.join(ROOT, p)) && fs.statSync(path.join(ROOT, p)).isFile());
  assert.ok(changed.length > 0, 'something changed');
  const banned = /systemctl|pkill|killall|docker\s+(stop|rm|restart)|supabase/i;
  for (const p of changed) {
    const text = fs.readFileSync(path.join(ROOT, p), 'utf8');
    if (/\.test\.ts$/.test(p) || p.endsWith('.md')) continue; // tests may assert that a guard refuses such a name; the reports may quote the owner rules
    const m = text.match(banned);
    assert.ok(!m, `${p} contains ${m?.[0]}`);
    if (p !== '.claude/settings.json') assert.ok(!/18310/.test(text), `${p} names port 18310`);
  }
  assert.ok(!fs.existsSync(path.join(ROOT, '.claude/settings.local.json')) || !git('status', '--porcelain', '--', '.claude/settings.local.json').trim(), 'no new settings.local.json');
  assert.ok(/not done/i.test(read('.claude/metric/eval/switch.md')) && /stop the python daemon/i.test(read('.claude/metric/eval/switch.md')), 'switch.md reports the daemon stop as not done');
});

// ---- D22 reports ------------------------------------------------------------------------------------------------------------------------------------------
await check('D22', 'switch.md and ci.md have the required sections and a Results table that matches the ledger', async () => {
  const md = read('.claude/metric/eval/switch.md');
  for (const h of ['Gates', 'Results', 'Not done', 'Settings']) assert.ok(new RegExp(`^#{1,3}\\s*${h}`, 'm').test(md), `heading ${h}`);
  const m = md.match(/<!-- results:start -->([\s\S]*?)<!-- results:end -->/); assert.ok(m, 'results markers');
  assert.ok(/gate\s*\|\s*area\s*\|\s*status\s*\|\s*passed\s*\|\s*failed\s*\|\s*skipped\s*\|\s*ms/i.test(m[1]), 'results header');
  const rows = m[1].split('\n').filter((l) => /^\|/.test(l) && !/^\|\s*-/.test(l) && !/gate\s*\|\s*area/i.test(l));
  assert.equal(rows.length, GATES.length, 'one row per gate');
  GATES.forEach((g, i) => { assert.ok(rows[i].includes(g), `row ${i} is ${g}: ${rows[i]}`); if (FAST) return; const want = g === 'dashboard-e2e' ? 'not_run' : 'pass'; assert.ok(rows[i].includes(want), `${g} says ${want}`); });
  for (const item of ['python daemon', 'install', 'dashboard-e2e', 'T7.2', 'shared mode', 'ctc daemon']) assert.ok(new RegExp(item, 'i').test(md.slice(md.search(/^#+\s*Not done/m))), `Not done lists ${item}`);
  for (const r of ['/v1/hook/prompt', '/v1/hook/pre', '/v1/hook/start', 'hooks/spool']) assert.ok(md.slice(md.search(/^#+\s*Settings/m)).includes(r), `Settings quotes ${r}`);
  const ci = read('.claude/metric/eval/ci.md');
  assert.ok(/pnpm -r lint/.test(ci) && /pnpm -r typecheck/.test(ci) && /pnpm -r test/.test(ci) && /check\.sh/.test(ci), 'ci.md names the command');
  const cm = ci.match(/<!-- results:start -->([\s\S]*?)<!-- results:end -->/); assert.ok(cm, 'ci.md markers');
  assert.ok(cm[1].split('\n').filter((l) => /^\|/.test(l) && !/^\|\s*-/.test(l) && !/command\s*\|\s*exit/i.test(l)).length === 1, 'ci.md has one result row');
  assert.ok(!exists('.claude/metric/eval/dashboard-e2e.md'), 'dashboard-e2e.md is not created (gate not run)');
});

// ---- D23 non-goals --------------------------------------------------------------------------------------------------------------------------------------
await check('D23', 'no dashboard, deploy, Python, docker or config change; apps/cli source untouched; no schedules route; no llm.enrich handler; no ctc daemon command', async () => {
  assert.equal(git('status', '--porcelain', '--', 'dashboard', 'deploy', 'src', 'docker', 'config', 'apps/cli/src/main.ts', 'apps/cli/src/migrate.ts', 'apps/cli/src/index.ts', 'apps/web/src/index.ts', 'apps/worker/src/index.ts', 'packages/core').trim(), '', 'untouched');
  const w = await web();
  assert.ok(!w.ready.routes.some((r) => /schedules/.test(r)), 'no schedules route');
  assert.ok(!/daemon/.test(read('apps/cli/src/main.ts')), 'no daemon command');
  const wr = read(WORKER_MAIN); assert.ok(!/['"`]llm\.enrich['"`]\s*:/.test(wr), 'no llm.enrich handler in the worker main');
});

// ---- D24 code shape -------------------------------------------------------------------------------------------------------------------------------------------
await check('D24', 'every new source file starts with a header naming Called from and NOT done; no chat-history comments; the mains and run.mjs reuse loadConfigOrExit/assertSchemaVersion', async () => {
  const files = [...walk('apps/web/src/server'), ...walk('apps/worker/src/boot'), path.join(ROOT, RUN_MJS)].filter((f) => /\.(ts|mjs)$/.test(f) && !/\.test\.ts$/.test(f) && fs.existsSync(f));
  assert.ok(files.length >= 4, `at least 4 new sources, found ${files.length}`);
  for (const f of files) {
    const head = fs.readFileSync(f, 'utf8').replace(/^#!.*\n/, '').slice(0, 1800);
    assert.ok(/Called from/i.test(head) && /NOT done/i.test(head), `${path.relative(ROOT, f)}: header lacks "Called from" and "NOT done"`);
    assert.ok(!/(as requested|the user asked|per the owner|as discussed|you asked)/i.test(fs.readFileSync(f, 'utf8')), `${path.relative(ROOT, f)}: chat-history comment`);
  }
  assert.ok(/loadConfigOrExit/.test(read(WEB_MAIN) + walk('apps/web/src/server').map((f) => fs.readFileSync(f, 'utf8')).join('')), 'web reuses loadConfigOrExit');
  assert.ok(/assertSchemaVersion/.test(walk('apps/web/src/server').map((f) => fs.readFileSync(f, 'utf8')).join('')), 'web reuses assertSchemaVersion');
  assert.ok(/loadConfigOrExit/.test(walk('apps/worker/src/boot').map((f) => fs.readFileSync(f, 'utf8')).join('')), 'worker reuses loadConfigOrExit');
});

await finish();
