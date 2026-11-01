// checks for T3.2 library MCP tools, /api capability routes, overrides, restore, blob cleanup: one runnable example per decision id (D0..D22).
// Prints `PASS D# ...` or `FAIL D# expected=<..> got=<..>`; last line `CHECKS: <n> pass, <m> fail`; exit 1 on any FAIL.
// Needs: env CTC_SCRATCH_PG_URL (scratch Postgres 127.0.0.1:18304 only) and the T1.2 migrations. Run from the repo root:
//   node --import tsx agent/t3-2-library-api/checks.mjs      (tsx lets Node import the .ts sources)
// Restore targets are temp dirs under os.tmpdir(), removed at the end; the real ~/.claude is never read or written.
// Scratch schema `ctc_t32chk_<random>`, dropped at the end. Fixture values are this file's own.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(new URL('../../', import.meta.url).pathname);
const SCHEMAS = 'packages/shared/src/schemas/library/index.ts';
const WEB = 'apps/web/src/library/index.ts';
const WORKER = 'apps/worker/src/library/index.ts';
const CORE = 'packages/core/src/library/index.ts';
const REPOS = 'packages/shared/src/repositories/index.ts';
const ADMIN = 'packages/shared/src/repositories/admin/index.ts';
const KEYS = 'packages/shared/src/cache/keys.ts';
const CASES = 'packages/shared/src/repositories/tenancy.cases.ts';
const HANDLERS = 'apps/worker/src/library/handlers.ts';
const GATE_MCP = 'apps/web/src/library/library.mcp.int.test.ts';
const GATE_OVR = 'apps/web/src/library/library.override.int.test.ts';
const ROUTES = [
  'GET /api/capabilities', 'GET /api/capabilities/:id', 'GET /api/capabilities/:id/versions', 'GET /api/capabilities/:id/versions/:v',
  'GET /api/capabilities/:id/versions/:v/diff', 'PATCH /api/capabilities/:id/versions/:v/labels', 'POST /api/capabilities/:id/restore',
  'PUT /api/projects/:pid/capabilities/:id/override', 'DELETE /api/projects/:pid/capabilities/:id/override', 'POST /api/index',
];
const IDS = Array.from({ length: 23 }, (_, i) => `D${i}`);
let pass = 0; let fail = 0;
const done = new Set();
const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
function ok(id, msg) { pass++; done.add(id); console.log(`PASS ${id} ${msg}`); }
function bad(id, expected, got) { fail++; done.add(id); console.log(`FAIL ${id} expected=${show(expected)} got=${show(got)}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));
const rnd = () => randomBytes(4).toString('hex');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const sorted = (a) => [...a].sort();
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---- load -----------------------------------------------------------------------------------------------------------
const url = process.env.CTC_SCRATCH_PG_URL;
if (!url) await failAll('env CTC_SCRATCH_PG_URL not set');
const pu = new URL(url);
if (pu.hostname !== '127.0.0.1' || pu.port !== '18304') await failAll(`refusing ${pu.hostname}:${pu.port}, only the scratch Postgres 127.0.0.1:18304`);
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
let S; let W; let K; let C; let R; let A; let KEYMOD;
for (const rel of [SCHEMAS, WEB, WORKER, CORE]) if (!fs.existsSync(path.join(ROOT, rel))) await failAll(`module not built: ${rel} is missing`);
try {
  S = await load(SCHEMAS); W = await load(WEB); K = await load(WORKER); C = await load(CORE); R = await load(REPOS); A = await load(ADMIN); KEYMOD = await load(KEYS);
} catch (e) { await failAll(`module not importable: ${e?.code ?? e?.name}: ${String(e?.message).split('\n')[0]}`); }
const req = createRequire(path.join(ROOT, 'packages/shared/package.json'));
const { sql } = req('kysely');
const schema = `ctc_t32chk_${rnd()}`;
let db; let repos;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't32chk-'));
try {
  await A.migrate({ url, schema });
  db = R.createDb({ url, schema });
  repos = R.createRepositories(db);
} catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); await failAll(`scratch schema not built: ${e?.name}: ${e?.message}`); }
cleanup = async () => {
  try { fs.chmodSync(tmp, 0o700); } catch { /* ignore */ }
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory() && !e.isSymbolicLink()) { try { fs.chmodSync(p, 0o700); } catch { /* ignore */ } walk(p); } } };
  try { walk(tmp); } catch { /* ignore */ }
  fs.rmSync(tmp, { recursive: true, force: true });
  try { await db.kysely.schema.dropSchema(schema).ifExists().cascade().execute(); } finally { await db.close(); }
};

// ---- fixtures ---------------------------------------------------------------------------------------------------------
let homes = 0;
const newHome = () => { const d = path.join(tmp, `h${++homes}`); fs.mkdirSync(d, { recursive: true }); return d; };
const put = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); return p; };
const read = (p) => fs.readFileSync(p, 'utf8');
const skillMd = (name, desc, body) => `---\nname: ${name}\ndescription: ${desc}\n---\n${body}`;
const userCtx = () => ({ userId: `u-${rnd()}` });
const LOCAL = { userId: 'local' };
const blob = (s) => ({ hash: sha(s), content: s, size: Buffer.byteLength(s) });
/** One version of `name` with `files` {path: content}; returns the version row. */
async function mkVersion(ctx, name, files, o = {}) {
  const ents = Object.entries(files);
  const blobs = [...new Map(ents.map(([, s]) => [sha(s), blob(s)])).values(), ...(o.extraBlobs ?? [])];
  const { version } = await repos.library.createVersion(ctx, {
    namespace: o.namespace ?? 'user', kind: o.kind ?? 'skill', name, rootPath: o.rootPath ?? `/nonexistent-t32/${name}`,
    description: o.description ?? `desc ${name}`, frontmatter: o.frontmatter ?? { name }, bodyHash: sha(JSON.stringify(files)),
    commitMessage: o.commitMessage ?? 'chk', blobs, files: ents.map(([p, s]) => ({ path: p, blobHash: sha(s) })),
  });
  return version;
}
const versionsOf = async (ctx, capId) => [...(await repos.library.listVersions(ctx, capId))].sort((a, b) => a.version - b.version);
function fakeSubmit(o = {}) {
  const calls = [];
  const f = async (input) => { calls.push(input); if (o.throws) throw o.throws; return { id: `job-${calls.length}` }; };
  f.calls = calls;
  return f;
}
function fakeCache() {
  const m = new Map(); const log = [];
  return {
    m, log,
    async get(k) { log.push(['get', k]); return m.has(k) ? JSON.parse(m.get(k)) : undefined; },
    async set(k, v, t) { log.push(['set', k, t]); m.set(k, JSON.stringify(v)); },
    async del(...ks) { log.push(['del', ...ks]); for (const k of ks) m.delete(k); },
    async publishInval(msg) { log.push(['pub', msg]); },
  };
}
const mkDeps = (o = {}) => {
  const home = o.home ?? tmp;
  const d = {
    repos: o.repos ?? repos,
    config: { mode: o.mode ?? 'local', claude_home: home, library: { roots: o.roots ?? [home], default_label: 'production' } },
    submit: o.submit ?? fakeSubmit(),
  };
  if (o.cache) d.cache = o.cache;
  if (o.ctxOf !== null) d.ctxOf = o.ctxOf ?? ((r) => r?.ctx ?? { userId: o.userId ?? 'local' });
  return d;
};
async function call(deps, method, url, reqIn = {}) {
  const r = W.libraryRoutes(deps).find((x) => x.method === method && x.url === url);
  if (!r) throw new Error(`no route ${method} ${url}`);
  let status = 0; let body; let sends = 0;
  const reply = { code(n) { status = n; return { send(b) { sends++; body = b; return reply; } }; } };
  await r.handler({ params: {}, query: {}, ...reqIn }, reply);
  return { status, body, sends };
}
const json = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
async function tool(deps, name, ctx, args) {
  const t = W.libraryTools(deps).find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t.call(ctx, args);
}
const okText = (res) => { assert.notEqual(res.isError, true, `tool error: ${res?.content?.[0]?.text}`); assert.equal(res.content[0].type, 'text'); return res.content[0].text; };
const okJson = (res) => JSON.parse(okText(res));
const errOf = (res) => { assert.equal(res.isError, true); assert.equal(res.content[0].type, 'text'); return JSON.parse(res.content[0].text).error; };
function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; }
const treeFiles = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p)); } };
  walk(dir); return out.sort();
};
const blobCount = async (hash) => (await sql`select count(*)::int as n from cap_blobs where hash = ${hash}`.execute(db.kysely)).rows[0].n;

try {
  await check('D0', 'public names exported; exactly the 10 routes and the 2 MCP tools; cleanup handler keyed cleanup.blobs; repos.library.listByName', async () => {
    const miss = [];
    for (const n of ['libraryApiLimits', 'CapabilityListQuery', 'VersionParams', 'DiffQuery', 'LabelsBody', 'RestoreBody', 'OverrideParams', 'OverrideBody', 'GetCapabilityArgs', 'LoadResourceArgs', 'parseVersionNumber']) if (!(n in S)) miss.push(`schemas.${n}`);
    for (const n of ['libraryRoutes', 'libraryTools', 'servedVersion']) if (!(n in W)) miss.push(`web.${n}`);
    for (const n of ['blobCleanupHandlers', 'blobCleanupJobId', 'startBlobCleanup']) if (!(n in K)) miss.push(`worker.${n}`);
    for (const n of ['mainPathOf', 'bodyOf']) if (!(n in C)) miss.push(`core.${n}`);
    if (typeof repos.library.listByName !== 'function') miss.push('repos.library.listByName');
    assert.deepEqual(miss, []);
    assert.deepEqual(sorted(W.libraryRoutes(mkDeps()).map((r) => `${r.method} ${r.url}`)), sorted(ROUTES));
    assert.deepEqual(sorted(W.libraryTools(mkDeps()).map((t) => t.name)), ['get_capability', 'load_capability_resource']);
    assert.deepEqual(Object.keys(K.blobCleanupHandlers({ repos })), ['cleanup.blobs']);
  });

  await check('D1', 'no cross-user read; strict bodies; foreign project 404; restore only local/local, inside the roots, no unsafe path', async () => {
    const a = userCtx(); const b = userCtx();
    const v = await mkVersion(a, 'd1-cap', { 'SKILL.md': skillMd('d1-cap', 'd', 'A body\n') });
    const deps = mkDeps();
    assert.equal((await call(deps, 'GET', '/api/capabilities/:id', { params: { id: v.capId }, ctx: b })).status, 404);
    assert.deepEqual((await call(deps, 'GET', '/api/capabilities', { ctx: b })).body.items, []);
    assert.equal(errOf(await tool(deps, 'load_capability_resource', b, { version_id: v.id, path: 'SKILL.md' })).code, 'not_found');
    assert.equal(errOf(await tool(deps, 'get_capability', b, { name: 'd1-cap' })).code, 'not_found');
    const hostile = await call(deps, 'PATCH', '/api/capabilities/:id/versions/:v/labels', { params: { id: v.capId, v: '1' }, body: { labels: ['beta'], userId: a.userId }, ctx: a });
    assert.deepEqual([hostile.status, hostile.body.error.code, hostile.body.error.path[0]], [422, 'invalid', 'body']);
    assert.deepEqual((await versionsOf(a, v.capId))[0].labels, ['latest', 'production']);
    const projA = await repos.projects.upsert(a, { root: `/t32/${rnd()}` });
    const foreign = await call(deps, 'PUT', '/api/projects/:pid/capabilities/:id/override', { params: { pid: projA.id, id: v.capId }, body: { action: 'block' }, ctx: b });
    assert.equal(foreign.status, 404);
    assert.deepEqual(await repos.library.listOverrides({ ...a, projectId: projA.id }), []);

    const home = newHome();
    const rootPath = path.join(home, 'skills', 'd1-local');
    const lv = await mkVersion(LOCAL, 'd1-local', { 'SKILL.md': skillMd('d1-local', 'd', 'L\n') }, { rootPath });
    const shared = await call(mkDeps({ home, mode: 'shared' }), 'POST', '/api/capabilities/:id/restore', { params: { id: lv.capId }, body: { version: 1 } });
    assert.deepEqual([shared.status, shared.body.error.code], [409, 'conflict']);
    const notLocal = await mkVersion(a, 'd1-remote', { 'SKILL.md': 'x' }, { rootPath: path.join(home, 'skills', 'd1-remote') });
    const remote = await call(mkDeps({ home }), 'POST', '/api/capabilities/:id/restore', { params: { id: notLocal.capId }, body: { version: 1 }, ctx: a });
    assert.deepEqual([remote.status, remote.body.error.code], [409, 'conflict']);
    assert.equal(fs.existsSync(rootPath) || fs.existsSync(path.join(home, 'skills', 'd1-remote')), false);

    const outside = fs.mkdtempSync(path.join(tmp, 'outside-'));
    const ov = await mkVersion(LOCAL, 'd1-outside', { 'SKILL.md': 'o' }, { rootPath: path.join(outside, 'skills', 'd1-outside') });
    const out = await call(mkDeps({ home }), 'POST', '/api/capabilities/:id/restore', { params: { id: ov.capId }, body: { version: 1 } });
    assert.deepEqual([out.status, out.body.error.code, fs.readdirSync(outside)], [409, 'conflict', []]);
    for (const [i, unsafe] of ['.env', '../evil.md', 'a//b.md', 'sub/./x.md', '.git/hooks/pre-commit'].entries()) {
      const rp = path.join(home, 'skills', `d1-unsafe${i}`);
      const uv = await mkVersion(LOCAL, `d1-unsafe${i}`, { 'SKILL.md': 'u', [unsafe]: 'evil' }, { rootPath: rp });
      const r = await call(mkDeps({ home }), 'POST', '/api/capabilities/:id/restore', { params: { id: uv.capId }, body: { version: 1 } });
      assert.deepEqual([unsafe, r.status, r.body.error.code, fs.existsSync(path.join(rp, 'SKILL.md'))], [unsafe, 409, 'conflict', false]);
    }
    assert.equal(fs.existsSync(path.join(home, 'skills', 'evil.md')), false);
  });

  await check('D2', 'limit defaults pinned; list limit 500 ok / 501 invalid; labels 20 / 21; q 200 / 201; name 200 / 201; path 1024 / 1025; 10 candidates', async () => {
    assert.deepEqual({ ...S.libraryApiLimits }, { listDefault: 50, listMax: 500, labelsMax: 20, qMax: 200, cursorMax: 512, nameMax: 200, pathMax: 1024, candidatesMax: 10 });
    const u = userCtx(); const deps = mkDeps({ userId: u.userId });
    const v = await mkVersion(u, 'd2-cap', { 'SKILL.md': 'x' });
    await mkVersion(u, 'd2-cap', { 'SKILL.md': 'y' });
    assert.equal((await call(deps, 'GET', '/api/capabilities', { query: { limit: '500' } })).status, 200);
    const over = await call(deps, 'GET', '/api/capabilities', { query: { limit: '501' } });
    assert.deepEqual([over.status, over.body.error.code, over.body.error.path], [422, 'invalid', ['query', 'limit']]);
    assert.equal((await call(deps, 'GET', '/api/capabilities', { query: { q: 'q'.repeat(200) } })).status, 200);
    assert.equal((await call(deps, 'GET', '/api/capabilities', { query: { q: 'q'.repeat(201) } })).status, 422);
    const labels = (n) => Array.from({ length: n }, (_, i) => `l${i}`);
    assert.equal((await call(deps, 'PATCH', '/api/capabilities/:id/versions/:v/labels', { params: { id: v.capId, v: '2' }, body: { labels: labels(20) } })).status, 200);
    const many = await call(deps, 'PATCH', '/api/capabilities/:id/versions/:v/labels', { params: { id: v.capId, v: '2' }, body: { labels: labels(21) } });
    assert.deepEqual([many.status, many.body.error.path.slice(0, 2)], [422, ['body', 'labels']]);
    assert.notEqual(errOf(await tool(deps, 'get_capability', u, { name: 'n'.repeat(200) })).code, 'invalid');
    assert.equal(errOf(await tool(deps, 'get_capability', u, { name: 'n'.repeat(201) })).code, 'invalid');
    assert.notEqual(errOf(await tool(deps, 'load_capability_resource', u, { version_id: v.id, path: 'p'.repeat(1024) })).code, 'invalid');
    assert.equal(errOf(await tool(deps, 'load_capability_resource', u, { version_id: v.id, path: 'p'.repeat(1025) })).code, 'invalid');
    for (let i = 0; i < 12; i++) await mkVersion(u, 'd2-many', { 'SKILL.md': `m${i}` }, { namespace: `p${String(i).padStart(2, '0')}` });
    const amb = errOf(await tool(deps, 'get_capability', u, { name: 'd2-many' }));
    assert.deepEqual([amb.code, amb.candidates.length, amb.candidates[0]], ['ambiguous', 10, { name: 'p00:d2-many', kind: 'skill' }]);
  });

  await check('D3', 'error body shapes and statuses; internal = class name only; JSON-safe bodies without userId; MCP error text', async () => {
    const u = userCtx(); const deps = mkDeps({ userId: u.userId });
    const v = await mkVersion(u, 'd3-cap', { 'SKILL.md': skillMd('d3-cap', 'd', 'B\n') });
    const nf = await call(deps, 'GET', '/api/capabilities/:id', { params: { id: randomUUID() } });
    assert.deepEqual([nf.status, sorted(Object.keys(nf.body.error)), nf.body.error.code, typeof nf.body.error.message], [404, ['code', 'message'], 'not_found', 'string']);
    const broken = (err) => mkDeps({ userId: u.userId, repos: { ...repos, library: { ...repos.library, get: async () => { throw err; } } } });
    const internal = await call(broken(new TypeError('secret-d3')), 'GET', '/api/capabilities/:id', { params: { id: v.capId } });
    assert.deepEqual([internal.status, json(internal.body)], [500, { error: { code: 'internal', message: 'TypeError' } }]);
    const timeout = await call(broken(new R.StoreTimeoutError()), 'GET', '/api/capabilities/:id', { params: { id: v.capId } });
    assert.deepEqual([timeout.status, timeout.body.error.code], [504, 'store_timeout']);
    const conflict = await call(broken(new R.ConflictError('x')), 'GET', '/api/capabilities/:id', { params: { id: v.capId } });
    assert.deepEqual([conflict.status, conflict.body.error.code], [409, 'conflict']);
    const one = await call(deps, 'GET', '/api/capabilities/:id/versions/:v', { params: { id: v.capId, v: '1' } });
    assert.equal(one.status, 200);
    assert.deepEqual(one.body, json(one.body));
    assert.match(one.body.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    const cap = await call(deps, 'GET', '/api/capabilities/:id', { params: { id: v.capId } });
    assert.deepEqual([cap.body, 'userId' in cap.body], [json(cap.body), false]);
    const e = await tool(deps, 'get_capability', u, { name: 'd3-nope' });
    assert.deepEqual([e.isError, sorted(Object.keys(JSON.parse(e.content[0].text)))], [true, ['error']]);
    assert.equal(errOf(e).code, 'not_found');
  });

  await check('D4', 'bad :v / against → 422 with the path; non-uuid id → 404; params checked before body; bad cursor 422; MCP label+version invalid; parseVersionNumber', async () => {
    const u = userCtx(); const deps = mkDeps({ userId: u.userId });
    const v = await mkVersion(u, 'd4-cap', { 'SKILL.md': 'x' });
    for (const bad of ['abc', '0', '-1', '1.5', '']) {
      const r = await call(deps, 'GET', '/api/capabilities/:id/versions/:v', { params: { id: v.capId, v: bad } });
      assert.deepEqual([bad, r.status, r.body.error.path], [bad, 422, ['params', 'v']]);
    }
    assert.equal((await call(deps, 'GET', '/api/capabilities/:id', { params: { id: 'not-a-uuid' } })).status, 404);
    const order = await call(deps, 'PATCH', '/api/capabilities/:id/versions/:v/labels', { params: { id: v.capId, v: 'x' }, body: { nope: 1 } });
    assert.deepEqual([order.status, order.body.error.path[0]], [422, 'params']);
    const cur = await call(deps, 'GET', '/api/capabilities', { query: { cursor: 'garbage' } });
    assert.deepEqual([cur.status, cur.body.error.code], [422, 'invalid']);
    const both = errOf(await tool(deps, 'get_capability', u, { name: 'd4-cap', label: 'production', version: 1 }));
    assert.deepEqual([both.code, both.message], ['invalid', 'give label or version, not both']);
    assert.equal(errOf(await tool(deps, 'get_capability', u, null)).code, 'invalid');
    assert.equal(errOf(await tool(deps, 'load_capability_resource', u, { version_id: 5 })).code, 'invalid');
    const p = S.parseVersionNumber;
    assert.deepEqual([p(3), p('3'), p(999999999), p('999999999')], [3, 3, 999999999, 999999999]);
    assert.deepEqual([p(0), p(-1), p(1.5), p('1e3'), p(' 3'), p(1000000000), p('1000000000'), p(true), p(null), p(undefined)], [null, null, null, null, null, null, null, null, null, null]);
  });

  await check('D5', 'tolerant inputs: no query, empty q, digit-string version, trimmed name, latest on reads, extra MCP keys, removed version still loads, index body ignored', async () => {
    const u = userCtx(); const deps = mkDeps({ userId: u.userId });
    const v = await mkVersion(u, 'd5-cap', { 'SKILL.md': skillMd('d5-cap', 'd', 'B5\n') });
    const none = await call(deps, 'GET', '/api/capabilities', {});
    const empty = await call(deps, 'GET', '/api/capabilities', { query: { q: '' } });
    assert.deepEqual([none.status, none.body.items.map((c) => c.name), empty.body.items.map((c) => c.name)], [200, ['d5-cap'], ['d5-cap']]);
    assert.equal(okJson(await tool(deps, 'get_capability', u, { name: '  d5-cap  ', version: '1', extra: 'ignored' })).version_id, v.id);
    assert.equal(okJson(await tool(deps, 'get_capability', u, { name: 'd5-cap', label: 'latest' })).version, 1);
    assert.equal((await call(deps, 'PATCH', '/api/capabilities/:id/versions/:v/labels', { params: { id: v.capId, v: '1' }, body: { labels: ['production'] } })).status, 200);
    await repos.library.markRemoved(u, v.capId);
    assert.equal(okText(await tool(deps, 'load_capability_resource', u, { version_id: v.id, path: 'SKILL.md' })), skillMd('d5-cap', 'd', 'B5\n'));
    const removed = await call(deps, 'GET', '/api/capabilities/:id', { params: { id: v.capId } });
    assert.deepEqual([removed.status, typeof removed.body.removedAt], [200, 'string']);
    assert.equal((await call(deps, 'POST', '/api/index', { body: { junk: 1, roots: ['/etc'] } })).status, 202);
  });

  await check('D6', 'restore keeps extra and dot files, never writes through an outside symlink; frozen inputs; junk requests get a reply, never a throw', async () => {
    const home = newHome();
    const rp = path.join(home, 'skills', 'd6-keep');
    const v = await mkVersion(LOCAL, 'd6-keep', { 'SKILL.md': 'k1', 'sub/x.md': 'x1' }, { rootPath: rp });
    put(path.join(rp, 'SKILL.md'), 'k2'); put(path.join(rp, 'extra.md'), 'e'); put(path.join(rp, '.keep'), 'dot'); put(path.join(rp, 'node_modules/m.js'), 'm');
    const r = await call(mkDeps({ home }), 'POST', '/api/capabilities/:id/restore', { params: { id: v.capId }, body: { version: 1 } });
    assert.equal(r.status, 200);
    assert.deepEqual([read(path.join(rp, 'SKILL.md')), read(path.join(rp, 'sub/x.md')), read(path.join(rp, 'extra.md')), read(path.join(rp, '.keep')), read(path.join(rp, 'node_modules/m.js'))], ['k1', 'x1', 'e', 'dot', 'm']);

    const outside = fs.mkdtempSync(path.join(tmp, 'outside6-'));
    const rp2 = path.join(home, 'skills', 'd6-link');
    fs.mkdirSync(rp2, { recursive: true });
    fs.symlinkSync(outside, path.join(rp2, 'sub'));
    const v2 = await mkVersion(LOCAL, 'd6-link', { 'SKILL.md': 'l1', 'sub/x.md': 'evil' }, { rootPath: rp2 });
    const r2 = await call(mkDeps({ home }), 'POST', '/api/capabilities/:id/restore', { params: { id: v2.capId }, body: { version: 1 } });
    assert.deepEqual([r2.status, r2.body.error?.code, fs.readdirSync(outside), fs.existsSync(path.join(rp2, 'SKILL.md'))], [409, 'conflict', [], false]);

    const u = userCtx(); const deps = mkDeps({ userId: u.userId });
    const fv = await mkVersion(u, 'd6-frozen', { 'SKILL.md': 'f' });
    await mkVersion(u, 'd6-frozen', { 'SKILL.md': 'g' });
    const frozen = deepFreeze({ params: { id: fv.capId, v: '2' }, query: {}, body: { labels: ['production'] } });
    assert.equal((await call(deps, 'PATCH', '/api/capabilities/:id/versions/:v/labels', frozen)).status, 200);
    assert.equal(okJson(await tool(deps, 'get_capability', u, deepFreeze({ name: 'd6-frozen' }))).version, 2);
    for (const route of W.libraryRoutes(deps)) {
      for (const junk of [{ params: null, query: null, body: null }, { params: 'x', query: 5, body: [1] }, { params: { id: {}, v: [], pid: 1 }, query: { limit: {} }, body: 'str' }]) {
        const res = await call(deps, route.method, route.url, junk);
        assert.ok(res.status >= 200 && res.status < 600 && res.sends === 1, `${route.method} ${route.url} replied ${res.status} (${res.sends} sends)`);
      }
    }
    for (const t of W.libraryTools(deps)) for (const junk of [undefined, 'x', 42, [], { name: {} }]) assert.equal((await t.call(u, junk)).isError, true);
  });

  await check('D7', 'non-goals: no enrich/dedup/graph routes; restore leaves a newer file that the old version lacks', async () => {
    const urls = W.libraryRoutes(mkDeps()).map((r) => r.url);
    assert.deepEqual(urls.filter((x) => /enrich|dedup|graph/.test(x)), []);
    const home = newHome();
    const rp = path.join(home, 'skills', 'd7-cap');
    const v1 = await mkVersion(LOCAL, 'd7-cap', { 'SKILL.md': 's1' }, { rootPath: rp });
    await mkVersion(LOCAL, 'd7-cap', { 'SKILL.md': 's2', 'new.md': 'n2' }, { rootPath: rp });
    put(path.join(rp, 'SKILL.md'), 's2'); put(path.join(rp, 'new.md'), 'n2');
    const r = await call(mkDeps({ home }), 'POST', '/api/capabilities/:id/restore', { params: { id: v1.capId }, body: { version: 1 } });
    assert.deepEqual([r.status, read(path.join(rp, 'SKILL.md')), read(path.join(rp, 'new.md'))], [200, 's1', 'n2']);
  });

  await check('D8', 'judgment: comments mark the silence-rule calls in apps/web/src/library', async () => {
    const dir = path.join(ROOT, 'apps/web/src/library');
    const text = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    assert.ok(/judgment:/.test(text), 'no `judgment:` comment in apps/web/src/library');
  });

  await check('D9', 'layout: schemas import only zod; no node:fs in schemas/core; no fastify / MCP SDK / zod import in web; apps/web package.json deps unchanged; inputSchema is Zod', async () => {
    const imports = (text) => [...text.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    const schemaDir = path.join(ROOT, 'packages/shared/src/schemas/library');
    const schemaSrc = fs.readdirSync(schemaDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => fs.readFileSync(path.join(schemaDir, f), 'utf8')).join('\n');
    assert.deepEqual(imports(schemaSrc).filter((s) => s !== 'zod' && !s.startsWith('./')), []);
    assert.equal(/node:fs/.test(schemaSrc) || /node:fs/.test(src(CORE)), false);
    const webDir = path.join(ROOT, 'apps/web/src/library');
    const webSrc = fs.readdirSync(webDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => fs.readFileSync(path.join(webDir, f), 'utf8')).join('\n');
    assert.deepEqual(imports(webSrc).filter((s) => /^(fastify|@modelcontextprotocol|zod|pg|kysely)($|\/)/.test(s)), []);
    assert.deepEqual(sorted(Object.keys(JSON.parse(src('apps/web/package.json')).dependencies ?? {})), ['@ctc/core', '@ctc/shared']);
    for (const t of W.libraryTools(mkDeps())) assert.equal(typeof t.inputSchema?.safeParse, 'function', `${t.name} inputSchema`);
    for (const t of W.libraryTools(mkDeps())) assert.equal(typeof t.description === 'string' && t.description.length > 0, true);
  });

  await check('D10', 'ctxOf defaults to local; config read at call time', async () => {
    const home = newHome();
    const rp = path.join(home, 'skills', 'd10-cap');
    const v = await mkVersion(LOCAL, 'd10-cap', { 'SKILL.md': 'z' }, { rootPath: rp });
    const deps = mkDeps({ home, ctxOf: null });
    assert.equal('ctxOf' in deps, false);
    const got = await call(deps, 'GET', '/api/capabilities/:id', { params: { id: v.capId } });
    assert.deepEqual([got.status, got.body.name], [200, 'd10-cap']);
    deps.config.mode = 'shared';
    const r = await call(deps, 'POST', '/api/capabilities/:id/restore', { params: { id: v.capId }, body: { version: 1 } });
    assert.deepEqual([r.status, fs.existsSync(rp)], [409, false]);
  });

  await check('D11', 'name lookup: user namespace first, ns:name, one other namespace, ambiguous across two, kind order, removed and bad names not found; listByName scoped', async () => {
    const u = userCtx(); const deps = mkDeps({ userId: u.userId });
    const mine = await mkVersion(u, 'd11-a', { 'SKILL.md': 'user' });
    const plug = await mkVersion(u, 'd11-a', { 'SKILL.md': 'plug' }, { namespace: 'plug' });
    const get = async (name) => okJson(await tool(deps, 'get_capability', u, { name })).version_id;
    assert.deepEqual([await get('d11-a'), await get('plug:d11-a'), await get('user:d11-a')], [mine.id, plug.id, mine.id]);
    const only = await mkVersion(u, 'd11-c', { 'SKILL.md': 'c' }, { namespace: 'solo' });
    assert.equal(await get('d11-c'), only.id);
    await mkVersion(u, 'd11-b', { 'SKILL.md': 'b1' }, { namespace: 'pb' });
    await mkVersion(u, 'd11-b', { 'SKILL.md': 'b2' }, { namespace: 'pa' });
    const amb = errOf(await tool(deps, 'get_capability', u, { name: 'd11-b' }));
    assert.deepEqual([amb.code, amb.candidates], ['ambiguous', [{ name: 'pa:d11-b', kind: 'skill' }, { name: 'pb:d11-b', kind: 'skill' }]]);
    const cmd = await mkVersion(u, 'd11-k', { 'k.md': 'cmd' }, { kind: 'command' });
    const skill = await mkVersion(u, 'd11-k', { 'SKILL.md': 'skill' });
    const agent = await mkVersion(u, 'd11-j', { 'j.md': 'agent' }, { kind: 'agent' });
    await mkVersion(u, 'd11-j', { 'j.md': 'cmd' }, { kind: 'command' });
    await mkVersion(u, 'd11-j', { 'j.yaml': 'name: d11-j\n' }, { kind: 'workflow' });
    assert.deepEqual([await get('d11-k'), await get('d11-j')], [skill.id, agent.id]);
    assert.notEqual(cmd.id, skill.id);
    const gone = await mkVersion(u, 'd11-gone', { 'SKILL.md': 'g' });
    await repos.library.markRemoved(u, gone.capId);
    assert.equal(errOf(await tool(deps, 'get_capability', u, { name: 'd11-gone' })).code, 'not_found');
    assert.equal(errOf(await tool(deps, 'get_capability', u, { name: 'Bad_Name' })).code, 'not_found');
    assert.equal(errOf(await tool(deps, 'get_capability', u, { name: 'nope:d11-a' })).code, 'not_found');
    const listed = await repos.library.listByName(u, 'd11-a');
    assert.deepEqual(listed.map((c) => c.namespace), ['plug', 'user']);
    assert.deepEqual(await repos.library.listByName(userCtx(), 'd11-a'), []);
    assert.match(src(CASES), /listByName\s*:/);
  });

  await check('D12', 'servedVersion: default label, project row beats global row, global applies elsewhere, column ignored, block null, ovr: cache-aside', async () => {
    const u = userCtx(); const cache = fakeCache(); const deps = mkDeps({ userId: u.userId, cache });
    const v1 = await mkVersion(u, 'd12-cap', { 'SKILL.md': 'a' });
    await mkVersion(u, 'd12-cap', { 'SKILL.md': 'b' });
    const capId = v1.capId;
    const p1 = (await repos.projects.upsert(u, { root: `/t32/d12/${rnd()}` })).id;
    const p2 = (await repos.projects.upsert(u, { root: `/t32/d12/${rnd()}` })).id;
    const P1 = { ...u, projectId: p1 }; const P2 = { ...u, projectId: p2 };
    assert.equal(await W.servedVersion(deps, u, capId), 1);
    await repos.library.setServed(u, capId, 2);
    assert.equal(await W.servedVersion(deps, u, capId), 1);
    await repos.library.upsertOverride(u, { capId, action: 'pin', version: 2 });
    await repos.library.upsertOverride(P1, { capId, action: 'pin', version: 1 });
    assert.deepEqual([await W.servedVersion(deps, P1, capId), await W.servedVersion(deps, P2, capId), await W.servedVersion(deps, u, capId)], [1, 2, 2]);
    const key = KEYMOD.keys.ovr(u.userId, p1);
    assert.ok(cache.log.some((e) => e[0] === 'set' && e[1] === key && e[2] === 300), `no set of ${key} with ttl 300: ${JSON.stringify(cache.log)}`);
    await repos.library.upsertOverride(P1, { capId, action: 'block' });
    assert.equal(await W.servedVersion(deps, P1, capId), 1, 'a cached override row must be used until the key is rotated');
    await cache.del(key);
    assert.equal(await W.servedVersion(deps, P1, capId), null);
    assert.equal(await W.servedVersion(mkDeps({ userId: u.userId }), P1, capId), null);
    assert.equal(await W.servedVersion(deps, userCtx(), capId), null);
    assert.equal(await W.servedVersion(deps, u, randomUUID()), null);
  });

  await check('D13', 'get_capability: exact keys, body without frontmatter, sorted files with sizes, served/version/label picks, block vs explicit read, workflow and agent bodies', async () => {
    const u = userCtx(); const deps = mkDeps({ userId: u.userId });
    const main = skillMd('d13-cap', 'D13 desc', 'Body one\n');
    const v1 = await mkVersion(u, 'd13-cap', { 'ref.md': 'reference one', 'SKILL.md': main }, { frontmatter: { name: 'd13-cap', description: 'D13 desc' } });
    const r = okJson(await tool(deps, 'get_capability', u, { name: 'd13-cap' }));
    assert.deepEqual(sorted(Object.keys(r)), ['body', 'files', 'frontmatter', 'labels', 'version', 'version_id']);
    assert.deepEqual(r, {
      version_id: v1.id, version: 1, labels: ['latest', 'production'], frontmatter: { name: 'd13-cap', description: 'D13 desc' }, body: 'Body one\n',
      files: [{ path: 'SKILL.md', size: Buffer.byteLength(main) }, { path: 'ref.md', size: 13 }],
    });
    const v2 = await mkVersion(u, 'd13-cap', { 'SKILL.md': skillMd('d13-cap', 'D13 desc', 'Body two\n') });
    assert.equal(okJson(await tool(deps, 'get_capability', u, { name: 'd13-cap' })).version, 1, 'production stays served');
    assert.equal(okJson(await tool(deps, 'get_capability', u, { name: 'd13-cap', version: 2 })).version_id, v2.id);
    await repos.library.moveLabels(u, { capId: v1.capId, version: 2, labels: ['beta'] });
    assert.equal(okJson(await tool(deps, 'get_capability', u, { name: 'd13-cap', label: 'beta' })).body, 'Body two\n');
    assert.equal(errOf(await tool(deps, 'get_capability', u, { name: 'd13-cap', label: 'nolabel' })).code, 'not_found');
    assert.equal(errOf(await tool(deps, 'get_capability', u, { name: 'd13-cap', version: 9 })).code, 'not_found');
    const p = { ...u, projectId: (await repos.projects.upsert(u, { root: `/t32/d13/${rnd()}` })).id };
    await repos.library.upsertOverride(p, { capId: v1.capId, action: 'block' });
    const blocked = errOf(await tool(deps, 'get_capability', p, { name: 'd13-cap' }));
    assert.deepEqual([blocked.code, blocked.message], ['not_found', 'not served for this project']);
    assert.equal(okJson(await tool(deps, 'get_capability', p, { name: 'd13-cap', version: 1 })).version, 1);
    const wf = 'name: d13-wf\nsteps: []\n';
    await mkVersion(u, 'd13-wf', { 'd13-wf.yaml': wf }, { kind: 'workflow' });
    assert.equal(okJson(await tool(deps, 'get_capability', u, { name: 'd13-wf' })).body, wf);
    await mkVersion(u, 'd13-agent', { 'd13-agent.md': skillMd('d13-agent', 'a', 'Agent body\n') }, { kind: 'agent' });
    assert.equal(okJson(await tool(deps, 'get_capability', u, { name: 'd13-agent' })).body, 'Agent body\n');
  });

  await check('D14', 'load_capability_resource: raw stored content (frontmatter kept); unknown path, non-uuid and foreign version not_found', async () => {
    const u = userCtx(); const deps = mkDeps({ userId: u.userId });
    const main = skillMd('d14-cap', 'd', 'Main\n');
    const v = await mkVersion(u, 'd14-cap', { 'SKILL.md': main, 'docs/ref.md': 'ref ü\n' });
    assert.equal(okText(await tool(deps, 'load_capability_resource', u, { version_id: v.id, path: 'SKILL.md' })), main);
    assert.equal(okText(await tool(deps, 'load_capability_resource', u, { version_id: v.id, path: 'docs/ref.md' })), 'ref ü\n');
    for (const args of [{ version_id: v.id, path: 'missing.md' }, { version_id: 'nope', path: 'SKILL.md' }, { version_id: randomUUID(), path: 'SKILL.md' }]) {
      assert.equal(errOf(await tool(deps, 'load_capability_resource', u, args)).code, 'not_found');
    }
    assert.equal(errOf(await tool(deps, 'load_capability_resource', userCtx(), { version_id: v.id, path: 'SKILL.md' })).code, 'not_found');
  });

  await check('D15', 'read routes: list filter + keyset paging, capability and version JSON keys, versions newest first, version manifest + body, diff', async () => {
    const u = userCtx(); const deps = mkDeps({ userId: u.userId });
    const s1 = await mkVersion(u, 'd15-skill', { 'SKILL.md': skillMd('d15-skill', 'd', 'one\n'), 'a.md': 'a1', 'gone.md': 'g' });
    const s2 = await mkVersion(u, 'd15-skill', { 'SKILL.md': skillMd('d15-skill', 'd', 'two\n'), 'a.md': 'a1', 'new.md': 'n' });
    await mkVersion(u, 'd15-agent', { 'd15-agent.md': 'agent' }, { kind: 'agent' });
    const agents = await call(deps, 'GET', '/api/capabilities', { query: { kind: 'agent' } });
    assert.deepEqual([agents.status, agents.body.items.map((c) => c.name), agents.body.next], [200, ['d15-agent'], null]);
    const page1 = await call(deps, 'GET', '/api/capabilities', { query: { limit: '1' } });
    assert.equal(page1.body.items.length, 1);
    assert.equal(typeof page1.body.next, 'string');
    const page2 = await call(deps, 'GET', '/api/capabilities', { query: { limit: '1', cursor: page1.body.next } });
    assert.deepEqual(sorted([...page1.body.items, ...page2.body.items].map((c) => c.name)), ['d15-agent', 'd15-skill']);
    const cap = await call(deps, 'GET', '/api/capabilities/:id', { params: { id: s1.capId } });
    assert.deepEqual(sorted(Object.keys(cap.body)), ['enrichment', 'id', 'kind', 'name', 'namespace', 'removedAt', 'rootPath', 'servedVersion']);
    const vs = await call(deps, 'GET', '/api/capabilities/:id/versions', { params: { id: s1.capId } });
    assert.deepEqual(vs.body.items.map((x) => x.version), [2, 1]);
    assert.deepEqual(sorted(Object.keys(vs.body.items[0])), ['bodyHash', 'capId', 'commitMessage', 'createdAt', 'description', 'frontmatter', 'id', 'labels', 'version']);
    assert.equal((await call(deps, 'GET', '/api/capabilities/:id/versions', { params: { id: randomUUID() } })).status, 404);
    const one = await call(deps, 'GET', '/api/capabilities/:id/versions/:v', { params: { id: s1.capId, v: '2' } });
    assert.deepEqual([one.body.id, one.body.body, one.body.files.map((f) => f.path), one.body.files[0].blobHash], [s2.id, 'two\n', ['SKILL.md', 'a.md', 'new.md'], sha(skillMd('d15-skill', 'd', 'two\n'))]);
    assert.equal(one.body.files[1].size, 2);
    const diff = await call(deps, 'GET', '/api/capabilities/:id/versions/:v/diff', { params: { id: s1.capId, v: '2' }, query: { against: '1' } });
    assert.deepEqual([diff.status, diff.body], [200, { from: 1, to: 2, added: ['new.md'], removed: ['gone.md'], changed: ['SKILL.md'] }]);
    const noAgainst = await call(deps, 'GET', '/api/capabilities/:id/versions/:v/diff', { params: { id: s1.capId, v: '2' }, query: {} });
    assert.deepEqual([noAgainst.status, noAgainst.body.error.path], [422, ['query', 'against']]);
    assert.equal((await call(deps, 'GET', '/api/capabilities/:id/versions/:v/diff', { params: { id: s1.capId, v: '2' }, query: { against: '7' } })).status, 404);
  });

  await check('D16', 'label move: exclusive, library.changed submitted, latest/bad label 422, unknown version 404, held lock 409, submit failure still 200', async () => {
    const u = userCtx(); const submit = fakeSubmit(); const deps = mkDeps({ userId: u.userId, submit });
    const v1 = await mkVersion(u, 'd16-cap', { 'SKILL.md': 'one' });
    await mkVersion(u, 'd16-cap', { 'SKILL.md': 'two' });
    const capId = v1.capId;
    const mv = await call(deps, 'PATCH', '/api/capabilities/:id/versions/:v/labels', { params: { id: capId, v: '2' }, body: { labels: ['production'] } });
    assert.deepEqual([mv.status, mv.body.version, mv.body.labels], [200, 2, ['latest', 'production']]);
    assert.deepEqual((await versionsOf(u, capId)).map((x) => x.labels), [[], ['latest', 'production']]);
    assert.deepEqual(submit.calls.map((c) => ({ queue: c.queue, kind: c.kind, payload: c.payload })), [{ queue: 'library', kind: 'changed', payload: { userId: u.userId, capId, version: 2 } }]);
    const latest = await call(deps, 'PATCH', '/api/capabilities/:id/versions/:v/labels', { params: { id: capId, v: '1' }, body: { labels: ['latest'] } });
    assert.deepEqual([latest.status, latest.body.error.code], [422, 'invalid']);
    assert.equal((await call(deps, 'PATCH', '/api/capabilities/:id/versions/:v/labels', { params: { id: capId, v: '1' }, body: { labels: ['Bad Label'] } })).status, 422);
    assert.equal((await call(deps, 'PATCH', '/api/capabilities/:id/versions/:v/labels', { params: { id: capId, v: '1' }, body: { labels: [] } })).status, 422);
    assert.equal((await call(deps, 'PATCH', '/api/capabilities/:id/versions/:v/labels', { params: { id: capId, v: '9' }, body: { labels: ['beta'] } })).status, 404);
    assert.deepEqual((await versionsOf(u, capId)).map((x) => x.labels), [[], ['latest', 'production']]);
    await db.kysely.transaction().execute(async (trx) => {
      await sql`select v.id from capability_versions v where v.cap_id = ${capId} and v.version = 1 for update`.execute(trx);
      const held = await call(deps, 'PATCH', '/api/capabilities/:id/versions/:v/labels', { params: { id: capId, v: '1' }, body: { labels: ['beta'] } });
      assert.deepEqual([held.status, held.body.error.code], [409, 'conflict']);
    });
    const failing = await call(mkDeps({ userId: u.userId, submit: fakeSubmit({ throws: new Error('redis gone') }) }), 'PATCH', '/api/capabilities/:id/versions/:v/labels', { params: { id: capId, v: '1' }, body: { labels: ['beta'] } });
    assert.equal(failing.status, 200);
  });

  await check('D17', 'override PUT pin version / pin label / block → 200 rows; bad bodies 422; unknown version 404; rotate ovr: (del + publish); DELETE 204', async () => {
    const u = userCtx(); const cache = fakeCache(); const deps = mkDeps({ userId: u.userId, cache });
    const v1 = await mkVersion(u, 'd17-cap', { 'SKILL.md': 'one' });
    const capId = v1.capId;
    const pid = (await repos.projects.upsert(u, { root: `/t32/d17/${rnd()}` })).id;
    const put = (body) => call(deps, 'PUT', '/api/projects/:pid/capabilities/:id/override', { params: { pid, id: capId }, body });
    const byV = await put({ action: 'pin', version: 1 });
    assert.deepEqual([byV.status, byV.body], [200, { projectId: pid, capId, action: 'pin', label: null, version: 1 }]);
    const byL = await put({ action: 'pin', label: 'production' });
    assert.deepEqual(byL.body, { projectId: pid, capId, action: 'pin', label: 'production', version: null });
    const blk = await put({ action: 'block' });
    assert.deepEqual(blk.body, { projectId: pid, capId, action: 'block', label: null, version: null });
    for (const body of [{ action: 'pin' }, { action: 'pin', label: 'production', version: 1 }, { action: 'block', label: 'production' }, { action: 'block', version: 1 }, { action: 'nope' }, {}]) {
      assert.deepEqual([JSON.stringify(body), (await put(body)).status], [JSON.stringify(body), 422]);
    }
    assert.equal((await put({ action: 'pin', version: 5 })).status, 404);
    assert.equal((await put({ action: 'pin', label: 'nolabel' })).status, 404);
    assert.equal((await call(deps, 'PUT', '/api/projects/:pid/capabilities/:id/override', { params: { pid: 'deadbeef', id: capId }, body: { action: 'block' } })).status, 404);
    const key = KEYMOD.keys.ovr(u.userId, pid);
    assert.ok(cache.log.some((e) => e[0] === 'del' && e.includes(key)), `no del of ${key}`);
    assert.ok(cache.log.some((e) => e[0] === 'pub' && isDeepStrictEqual(e[1], { v: 1, event: 'ovr.changed', userId: u.userId, projectId: pid })), `no ovr.changed publish: ${JSON.stringify(cache.log)}`);
    cache.log.length = 0;
    const del = await call(deps, 'DELETE', '/api/projects/:pid/capabilities/:id/override', { params: { pid, id: capId } });
    assert.deepEqual([del.status, del.body], [204, undefined]);
    assert.deepEqual(await repos.library.listOverrides({ ...u, projectId: pid }), []);
    assert.ok(cache.log.some((e) => e[0] === 'del' && e.includes(key)), 'DELETE must rotate ovr: too');
    assert.equal((await call(deps, 'DELETE', '/api/projects/:pid/capabilities/:id/override', { params: { pid, id: capId } })).status, 204);
    assert.equal((await call(mkDeps({ userId: u.userId }), 'PUT', '/api/projects/:pid/capabilities/:id/override', { params: { pid, id: capId }, body: { action: 'block' } })).status, 200, 'no cache: still works');
  });

  await check('D18', 'restore: writes v1 files atomically, keeps the mode, new version `restore v1` with latest only, production unchanged, changed job, idempotent, imported refused, unwritable 500 with no partial write', async () => {
    const home = newHome(); const submit = fakeSubmit(); const deps = mkDeps({ home, submit });
    const rp = path.join(home, 'skills', 'd18-cap');
    const f1 = { 'SKILL.md': skillMd('d18-cap', 'd', 'one\n'), 'ref.md': 'r1', 'scripts/run.sh': '#!/bin/sh\necho 1\n' };
    const f2 = { 'SKILL.md': skillMd('d18-cap', 'd', 'two\n'), 'ref.md': 'r2', 'scripts/run.sh': '#!/bin/sh\necho 2\n' };
    const v1 = await mkVersion(LOCAL, 'd18-cap', f1, { rootPath: rp });
    await mkVersion(LOCAL, 'd18-cap', f2, { rootPath: rp, commitMessage: 'scan' });
    for (const [p, s] of Object.entries(f2)) put(path.join(rp, p), s);
    fs.chmodSync(path.join(rp, 'scripts/run.sh'), 0o755);
    put(path.join(rp, 'extra.md'), 'extra');
    const r = await call(deps, 'POST', '/api/capabilities/:id/restore', { params: { id: v1.capId }, body: { version: 1 } });
    assert.deepEqual([r.status, r.body], [200, { version: 3, created: true, written: ['SKILL.md', 'ref.md', 'scripts/run.sh'] }]);
    for (const [p, s] of Object.entries(f1)) assert.equal(read(path.join(rp, p)), s);
    assert.equal(fs.statSync(path.join(rp, 'scripts/run.sh')).mode & 0o777, 0o755);
    assert.deepEqual(treeFiles(rp), ['SKILL.md', 'extra.md', 'ref.md', 'scripts/run.sh']);
    const vs = await versionsOf(LOCAL, v1.capId);
    assert.deepEqual(vs.map((x) => [x.version, x.labels, x.commitMessage]), [[1, ['production'], 'chk'], [2, [], 'scan'], [3, ['latest'], 'restore v1']]);
    const man = async (id) => (await repos.library.manifest(LOCAL, id)).map((m) => [m.path, m.blobHash]);
    assert.deepEqual(await man(vs[2].id), await man(v1.id));
    assert.deepEqual(submit.calls.map((c) => [c.queue, c.kind, c.payload]), [['library', 'changed', { userId: 'local', capId: v1.capId, version: 3 }]]);
    const again = await call(deps, 'POST', '/api/capabilities/:id/restore', { params: { id: v1.capId }, body: { version: 1 } });
    assert.deepEqual([again.status, again.body.version, again.body.created, submit.calls.length], [200, 3, false, 1]);
    assert.equal((await call(deps, 'POST', '/api/capabilities/:id/restore', { params: { id: v1.capId }, body: { version: 9 } })).status, 404);
    assert.equal((await call(deps, 'POST', '/api/capabilities/:id/restore', { params: { id: v1.capId }, body: {} })).status, 422);

    const rpImp = path.join(home, 'skills', 'd18-imported');
    const imp = await mkVersion(LOCAL, 'd18-imported', { 'SKILL.md': 'python body only' }, { rootPath: rpImp, commitMessage: 'imported from python' });
    const ri = await call(deps, 'POST', '/api/capabilities/:id/restore', { params: { id: imp.capId }, body: { version: 1 } });
    assert.deepEqual([ri.status, ri.body.error.code, fs.existsSync(rpImp)], [409, 'conflict', false]);

    const rpGone = path.join(home, 'skills', 'd18-gone');
    const gone = await mkVersion(LOCAL, 'd18-gone', { 'SKILL.md': 'back', 'deep/a/b.md': 'b' }, { rootPath: rpGone });
    await repos.library.markRemoved(LOCAL, gone.capId);
    const rg = await call(deps, 'POST', '/api/capabilities/:id/restore', { params: { id: gone.capId }, body: { version: 1 } });
    assert.deepEqual([rg.status, read(path.join(rpGone, 'SKILL.md')), read(path.join(rpGone, 'deep/a/b.md'))], [200, 'back', 'b']);

    if (process.getuid && process.getuid() !== 0) {
      const rpRo = path.join(home, 'skills', 'd18-ro');
      const ro = await mkVersion(LOCAL, 'd18-ro', { 'SKILL.md': 'new main', 'sub/x.md': 'new x' }, { rootPath: rpRo });
      put(path.join(rpRo, 'SKILL.md'), 'old main'); put(path.join(rpRo, 'sub/x.md'), 'old x');
      fs.chmodSync(path.join(rpRo, 'sub'), 0o555);
      const rr = await call(deps, 'POST', '/api/capabilities/:id/restore', { params: { id: ro.capId }, body: { version: 1 } });
      fs.chmodSync(path.join(rpRo, 'sub'), 0o755);
      assert.deepEqual([rr.status, rr.body.error.code, read(path.join(rpRo, 'SKILL.md')), read(path.join(rpRo, 'sub/x.md'))], [500, 'internal', 'old main', 'old x']);
      assert.deepEqual(treeFiles(rpRo).filter((f) => /ctc-restore/.test(f)), []);
    }
  });

  await check('D19', 'POST /api/index → 202 {job_id}, library.scan for the caller; submit failure → 500 internal', async () => {
    const submit = fakeSubmit(); const deps = mkDeps({ submit });
    const r = await call(deps, 'POST', '/api/index', { body: undefined });
    assert.deepEqual([r.status, r.body], [202, { job_id: 'job-1' }]);
    assert.deepEqual(submit.calls.map((c) => [c.queue, c.kind, c.payload]), [['library', 'scan', { userId: 'local' }]]);
    const f = await call(mkDeps({ submit: fakeSubmit({ throws: new TypeError('boom') }) }), 'POST', '/api/index', {});
    assert.deepEqual([f.status, json(f.body)], [500, { error: { code: 'internal', message: 'TypeError' } }]);
  });

  await check('D20', 'cleanup.blobs deletes only unreferenced blobs, waits for an open writer (no race), ISO-week ids, startBlobCleanup timer', async () => {
    const u = userCtx();
    const orphan = blob(`orphan-${rnd()}`);
    const v = await mkVersion(u, 'd20-cap', { 'SKILL.md': 'kept-d20' }, { extraBlobs: [orphan] });
    assert.equal(await blobCount(orphan.hash), 1);
    const res = await K.blobCleanupHandlers({ repos })['cleanup.blobs']({}, { jobId: 'j', attempt: 1, signal: new AbortController().signal, setProgress: async () => {} });
    assert.deepEqual([res, await blobCount(orphan.hash), await blobCount(sha('kept-d20'))], [{ deleted: 1 }, 0, 1]);
    assert.equal(await repos.library.getBlob(u, v.id, 'SKILL.md'), 'kept-d20');

    const race = blob(`race-${rnd()}`);
    await sql`insert into cap_blobs (user_id, hash, content, size) values (${u.userId}, ${race.hash}, ${race.content}, ${race.size})`.execute(db.kysely);
    let settled = false; let cleanupP;
    await db.kysely.transaction().execute(async (trx) => {
      await sql`insert into cap_blobs (user_id, hash, content, size) values (${u.userId}, ${race.hash}, ${race.content}, ${race.size}) on conflict do nothing`.execute(trx);
      await sql`insert into cap_files (version_id, path, blob_hash) values (${v.id}, 'race.md', ${race.hash})`.execute(trx);
      cleanupP = repos.system.cleanup.deleteUnreferencedBlobs(R.createSystemCtx('t32 check')).finally(() => (settled = true));
      cleanupP.catch(() => {});
      await sleep(400);
      assert.equal(settled, false, 'the delete must wait for the open writer');
    });
    await cleanupP;
    assert.equal(await blobCount(race.hash), 1, 'a blob referenced by a writer that committed during the cleanup must survive');
    assert.equal(await repos.library.getBlob(u, v.id, 'race.md'), race.content);

    assert.deepEqual([K.blobCleanupJobId(new Date('2026-10-31T12:00:00Z')), K.blobCleanupJobId(new Date('2027-01-01T12:00:00Z')), K.blobCleanupJobId(new Date('2026-01-05T00:00:00Z'))],
      ['cleanup.blobs:2026-W44', 'cleanup.blobs:2026-W53', 'cleanup.blobs:2026-W02']);
    const submit = fakeSubmit();
    const now = () => new Date('2026-10-31T12:00:00Z');
    const t = K.startBlobCleanup({ submit, everyMs: 50, now });
    await sleep(140);
    t.close(); t.close();
    const n = submit.calls.length;
    assert.ok(n >= 2, `expected the first submit at once and more every 50 ms, got ${n}`);
    assert.deepEqual(submit.calls[0], { queue: 'cleanup', kind: 'blobs', payload: {}, id: 'cleanup.blobs:2026-W44' });
    await sleep(120);
    assert.equal(submit.calls.length, n, 'close() stops the timer');
    const before = unhandled.length;
    const t2 = K.startBlobCleanup({ submit: async () => { throw new Error('down'); }, everyMs: 30, now, log: () => {} });
    const t3 = K.startBlobCleanup({ submit: () => { throw new Error('sync'); }, everyMs: 30, now, log: () => {} });
    await sleep(80); t2.close(); t3.close(); await sleep(10);
    assert.equal(unhandled.length, before, 'a failing submit must be logged, not left unhandled');
  });

  await check('D21', 'mainPathOf / bodyOf in core; worker handlers.ts uses them instead of a private copy', async () => {
    assert.deepEqual([C.mainPathOf(['ref.md', 'SKILL.md']), C.mainPathOf(['x.md']), C.mainPathOf(['a.md', 'b.md']), C.mainPathOf([])], ['SKILL.md', 'x.md', null, null]);
    const md = '---\nname: x\n---\nBody\n';
    assert.deepEqual([C.bodyOf('skill', 'SKILL.md', md), C.bodyOf('workflow', 'w.md', md), C.bodyOf('workflow', 'w.YAML', md), C.bodyOf('workflow', 'w.json', '{"a":1}')], ['Body\n', 'Body\n', md, '{"a":1}']);
    const badYaml = '---\na: [\n---\nB\n';
    assert.equal(C.bodyOf('agent', 'a.md', badYaml), badYaml);
    assert.equal(C.bodyOf('command', 'c.md', 'no header\n'), 'no header\n');
    const h = src(HANDLERS);
    assert.equal(/function\s+bodyOf\s*\(/.test(h), false, 'handlers.ts still has its own bodyOf');
    assert.match(h, /import\s*\{[^}]*\bmainPathOf\b[^}]*\}\s*from\s*['"]@ctc\/core\/library['"]/);
    assert.match(h, /import\s*\{[^}]*\bbodyOf\b[^}]*\}\s*from\s*['"]@ctc\/core\/library['"]/);
  });

  await check('D22', 'gate test files exist with describe(library.mcp) / describe(library.override) and the exact test names', async () => {
    const need = [[GATE_MCP, 'library.mcp', ['get_capability and load_capability_resource stay on the returned version after a new version lands']],
      [GATE_OVR, 'library.override', ['pin by label changes the served version for that project only', 'pin by version changes the served version for that project only']]];
    const missing = [];
    for (const [file, d, names] of need) {
      if (!fs.existsSync(path.join(ROOT, file))) { missing.push(file); continue; }
      const text = src(file);
      if (!new RegExp(`describe\\(\\s*['"\`]${d.replace('.', '\\.')}['"\`]`).test(text)) missing.push(`${file}: describe('${d}')`);
      for (const n of names) if (!new RegExp(`\\b(it|test)\\(\\s*['"\`]${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(text)) missing.push(`${file}: ${n}`);
    }
    assert.deepEqual(missing, []);
  });
} catch (e) {
  console.log(`note: checks stopped early: ${e?.name}: ${e?.message}`);
}
await finish();
