// checks for T3.3 skill seed channel, TEI client, RAM matrix, loadSkillIndex: one runnable example per decision id (D0..D23).
// Prints `PASS D# ...` or `FAIL D# expected=<..> got=<..>`; last line `CHECKS: <n> pass, <m> fail`; exit 1 on any FAIL.
// Needs: env CTC_SCRATCH_PG_URL (scratch Postgres 127.0.0.1:18304 only) and the T1.2 migrations. Run from the repo root:
//   node --import tsx agent/t3-3-skill-channel/checks.mjs      (tsx lets Node import the .ts sources)
// TEI is a fake HTTP server on 127.0.0.1:<random port> started here; the real TEI, Redis and ~/.claude are never used.
// Scratch schema `ctc_t33chk_<random>`, dropped at the end. Fixture values are this file's own.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = path.resolve(new URL('../../', import.meta.url).pathname);
const CORE = 'packages/core/src/skills/index.ts';
const TEI = 'packages/shared/src/tei/index.ts';
const WEB = 'apps/web/src/skills/index.ts';
const WEBLIB = 'apps/web/src/library/index.ts';
const CORELIB = 'packages/core/src/library/index.ts';
const REPOS = 'packages/shared/src/repositories/index.ts';
const ADMIN = 'packages/shared/src/repositories/admin/index.ts';
const KEYS = 'packages/shared/src/cache/keys.ts';
const CASES = 'packages/shared/src/repositories/tenancy.cases.ts';
const GATE = 'apps/web/src/skills/suggest.skills.int.test.ts';
const GATE_DESCRIBE = 'suggest.skills';
const GATE_IT = 'SkillRet test split: NDCG@10 of the skill channel is at least 0.80';
const EXPORT = process.env.CTC_SKILLRET_FILE || path.join(ROOT, '.ctc-dev/eval/skillret-test.json');
const IDS = Array.from({ length: 24 }, (_, i) => `D${i}`);
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
const rnd = () => randomBytes(4).toString('hex');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const close = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

// ---- load -----------------------------------------------------------------------------------------------------------
const url = process.env.CTC_SCRATCH_PG_URL;
if (!url) await failAll('env CTC_SCRATCH_PG_URL not set');
const pu = new URL(url);
if (pu.hostname !== '127.0.0.1' || pu.port !== '18304') await failAll(`refusing ${pu.hostname}:${pu.port}, only the scratch Postgres 127.0.0.1:18304`);
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
let C; let T; let W; let WL; let CL; let R; let A; let KEYMOD;
for (const rel of [CORE, TEI, WEB]) if (!fs.existsSync(path.join(ROOT, rel))) await failAll(`module not built: ${rel} is missing`);
try {
  C = await load(CORE); T = await load(TEI); W = await load(WEB); WL = await load(WEBLIB); CL = await load(CORELIB);
  R = await load(REPOS); A = await load(ADMIN); KEYMOD = await load(KEYS);
} catch (e) { await failAll(`module not importable: ${e?.code ?? e?.name}: ${String(e?.message).split('\n')[0]}`); }
const req = createRequire(path.join(ROOT, 'packages/shared/package.json'));
const { sql } = req('kysely');
const schema = `ctc_t33chk_${rnd()}`;
let db; let repos;
try {
  await A.migrate({ url, schema });
  db = R.createDb({ url, schema });
  repos = R.createRepositories(db);
} catch (e) { await failAll(`scratch schema not built: ${e?.name}: ${e?.message}`); }

// ---- fake TEI ---------------------------------------------------------------------------------------------------------
const DIM = 1024;
const vec = (m) => { const v = new Array(DIM).fill(0); for (const [i, x] of Object.entries(m)) v[Number(i)] = x; return v; };
/** unit vector in the plane of axes 0 and 1 at the given cosine with axis 0 */
const at = (c) => vec({ 0: c, 1: Math.sqrt(Math.max(0, 1 - c * c)) });
function fakeTei() {
  const s = { reqs: [], qmap: new Map(), rmap: new Map(), mode: { embed: 'ok', rerank: 'ok' }, delayMs: 0, socks: new Set() };
  s.server = http.createServer((rq, res) => {
    let body = '';
    rq.on('data', (c) => (body += c));
    rq.on('end', async () => {
      let j = null; try { j = JSON.parse(body); } catch { /* keep null */ }
      const op = rq.url.endsWith('/embed') ? 'embed' : rq.url.endsWith('/rerank') ? 'rerank' : 'other';
      s.reqs.push({ op, url: rq.url, method: rq.method, ct: rq.headers['content-type'], body: j });
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const mode = s.mode[op];
      if (mode === 'hang') return;
      if (s.delayMs) await sleep(s.delayMs);
      if (mode === 'fail') return send(503, { error: 'down' });
      if (op === 'embed') {
        let out = (j?.inputs ?? []).map((t) => s.qmap.get(t) ?? vec({ 1000: 1 }));
        if (mode === 'short') out = out.slice(1);
        if (mode === 'baddim') out = out.map((v) => v.slice(1));
        if (mode === 'nan') out = out.map((v) => [null, ...v.slice(1)]);
        return send(200, out);
      }
      if (op === 'rerank') {
        let out = (j?.texts ?? []).map((t, i) => ({ index: i, score: s.rmap.get(t) ?? 0 })).sort((a, b) => b.score - a.score);
        if (mode === 'missing') out = out.slice(1);
        return send(200, out);
      }
      return send(404, {});
    });
  });
  s.server.on('connection', (sock) => { s.socks.add(sock); sock.on('close', () => s.socks.delete(sock)); });
  s.start = () => new Promise((r) => s.server.listen(0, '127.0.0.1', () => { s.port = s.server.address().port; r(s); }));
  s.stop = () => new Promise((r) => { for (const k of s.socks) k.destroy(); s.server.close(() => r()); });
  s.count = (op) => s.reqs.filter((x) => x.op === op).length;
  s.reset = () => { s.reqs.length = 0; s.mode = { embed: 'ok', rerank: 'ok' }; s.delayMs = 0; };
  return s;
}
const tei = await fakeTei().start();
const deadPort = await new Promise((r) => { const sv = http.createServer(); sv.listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => r(p)); }); });
cleanup = async () => {
  await tei.stop();
  try { await db.kysely.schema.dropSchema(schema).ifExists().cascade().execute(); } finally { await db.close(); }
};

// ---- fixtures ---------------------------------------------------------------------------------------------------------
const Q = () => C.QUERY_INSTRUCTIONS.skillret;
const teiCfg = (o = {}) => ({ embed_url: `http://127.0.0.1:${o.port ?? tei.port}`, rerank_url: `http://127.0.0.1:${o.port ?? tei.port}`, embed_model: 'm-test',
  embedding_dim: DIM, timeout_s: o.timeout_s ?? 2, batch_timeout_s: o.batch_timeout_s ?? 5 });
const mkTei = (o = {}) => T.createTei({ config: teiCfg(o), ...(o.cache ? { cache: o.cache } : {}), ...(o.log ? { log: o.log } : {}) });
const chanCfg = (o = {}) => ({ k: o.k ?? 5, depth: o.depth ?? 50, rerank_top: o.rerank_top ?? 20, rrf_k: 60,
  ranking: { keyword_rrf_weight: 0, rerank_weight: 0, fusion: 'rrf', score_w: 0.7, rerank_by: 'sigmoid', ...(o.ranking ?? {}) },
  embed: { text: 'skillret', instruction: o.instruction ?? 'skillret', skillret_body_chars: 8000 }, embedding_dim: DIM });
function spyRepos(o = {}) {
  const calls = [];
  const wrap = (obj, prefix) => new Proxy(obj, { get(t, k) {
    const f = t[k];
    if (typeof f !== 'function') return f;
    return async (...a) => {
      const name = `${prefix}${String(k)}`;
      calls.push(name);
      if (o.delay?.[name] && calls.filter((c) => c === name).length > (o.delayAfter ?? 0)) await sleep(o.delay[name]);
      if (o.fail?.includes(name)) throw new Error('db down');
      return f.apply(t, a);
    };
  } });
  const r = new Proxy(repos, { get(t, k) { const v = t[k]; return v && typeof v === 'object' ? wrap(v, k === 'library' ? '' : `${String(k)}.`) : v; } });
  return { r, calls, n: (name) => calls.filter((c) => c === name).length };
}
const mkChannel = (o = {}) => W.createSkillChannel({ repos: o.repos ?? repos, tei: o.tei ?? mkTei(), config: o.config ?? chanCfg(),
  ...(o.cache ? { cache: o.cache } : {}), ...(o.log ? { log: o.log } : {}), ...(o.now ? { now: o.now } : {}) });
const userCtx = () => ({ userId: `u-${rnd()}` });
async function addCap(ctx, name, embedding, o = {}) {
  const content = `${name} ${o.description ?? ''} ${rnd()}`;
  const { version } = await repos.library.createVersion(ctx, {
    namespace: o.namespace ?? 'user', kind: o.kind ?? 'skill', name, rootPath: `/nonexistent-t33/${name}`,
    description: o.description ?? `desc ${name}`, frontmatter: { name }, bodyHash: sha(content), commitMessage: 'chk',
    blobs: [{ hash: sha(content), content, size: Buffer.byteLength(content) }], files: [{ path: 'SKILL.md', blobHash: sha(content) }],
  });
  if (o.served !== null) await repos.library.setServed(ctx, version.capId, version.version);
  if (embedding) await repos.library.upsertVector(ctx, { capId: version.capId, textHash: o.textHash ?? sha(name), embedding, model: 'm-test' });
  return version.capId;
}
const names = (res) => res.hits.map((h) => h.name);
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
async function until(fn, ms = 3000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(25); } return false; }
async function teiErr(p) { try { await p; return null; } catch (e) { return e; } }

try {
  // ---- D0 -----------------------------------------------------------------------------------------------------------
  await check('D0', 'public names exported by core, tei, web; repos.library.loadSkillIndex; overrideRows re-exported from apps/web/src/library', async () => {
    const miss = [];
    for (const n of ['QUERY_INSTRUCTIONS', 'queryText', 'normalize', 'topCosine', 'tokenize', 'buildKeywordIndex', 'keywordTop', 'rrf', 'firstOrder', 'finalOrder', 'sigmoid', 'ndcgAt', 'recallAt']) if (!(n in C)) miss.push(`core.${n}`);
    for (const n of ['createTei', 'teiLimits', 'TeiError']) if (!(n in T)) miss.push(`tei.${n}`);
    for (const n of ['createSkillChannel', 'skillLimits']) if (!(n in W)) miss.push(`web.${n}`);
    if (typeof WL.overrideRows !== 'function') miss.push('apps/web/src/library overrideRows');
    if (typeof repos.library.loadSkillIndex !== 'function') miss.push('repos.library.loadSkillIndex');
    assert.deepEqual(miss, []);
    const ch = mkChannel();
    assert.deepEqual(['invalidate', 'onInval', 'reload', 'search'].filter((k) => typeof ch[k] !== 'function'), []);
    const t = mkTei();
    assert.deepEqual(['embed', 'rerank'].filter((k) => typeof t[k] !== 'function'), []);
  });

  // ---- D1 -----------------------------------------------------------------------------------------------------------
  await check('D1', "a user's search never sees another user's capabilities; prompt text never reaches logs or TeiError messages", async () => {
    const a = userCtx(); const b = userCtx();
    await addCap(a, 'd1-alpha', at(0.9));
    tei.qmap.set(Q() + 'd1 prompt', vec({ 0: 1 }));
    const ch = mkChannel();
    assert.deepEqual(names(await ch.search(a, 'd1 prompt')), ['d1-alpha']);
    const rb = await ch.search(b, 'd1 prompt');
    assert.deepEqual([rb.hits, rb.degraded], [[], []]);
    const logs = [];
    const log = (m, f) => logs.push([m, f]);
    const down = W.createSkillChannel({ repos, tei: mkTei({ port: deadPort, log }), config: chanCfg(), log });
    const r = await down.search(a, 'SECRET-PROMPT-d1');
    assert.deepEqual(r.degraded, ['embed']);
    assert.equal(JSON.stringify(logs).includes('SECRET-PROMPT-d1'), false);
    const e = await teiErr(mkTei({ port: deadPort }).embed(['SECRET-PROMPT-d1']));
    assert.equal(String(e?.message).includes('SECRET'), false);
  });

  // ---- D2 -----------------------------------------------------------------------------------------------------------
  await check('D2', 'limit defaults pinned; prompt cut at 20,000 (equal unchanged); 32 inputs per request (33 -> 2); k clamped to maxK', async () => {
    assert.deepEqual({ ...W.skillLimits }, { promptChars: 20000, maxK: 100, maxAgeMs: 60000, retryMs: 5000, maxUsers: 32 });
    assert.deepEqual({ ...T.teiLimits }, { batch: 32 });
    const u = userCtx();
    for (const [i, c] of [0.9, 0.8, 0.7].entries()) await addCap(u, `d2-c${i}`, at(c));
    const ch = mkChannel();
    tei.reset();
    await ch.search(u, 'x'.repeat(20000));
    await ch.search(u, 'y'.repeat(20001));
    const inputs = tei.reqs.filter((x) => x.op === 'embed').map((x) => x.body.inputs[0]);
    assert.deepEqual(inputs.map((s) => s.length), [Q().length + 20000, Q().length + 20000]);
    assert.equal(inputs[1], Q() + 'y'.repeat(20000));
    tei.reset();
    const out = await mkTei().embed(Array.from({ length: 33 }, (_, i) => `d2 text ${i}`));
    assert.deepEqual([out.length, tei.reqs.map((x) => x.body.inputs.length)], [33, [32, 1]]);
    const keep = W.skillLimits.maxK;
    try { W.skillLimits.maxK = 2; assert.equal((await ch.search(u, 'd2 k', { k: 3 })).hits.length, 2); } finally { W.skillLimits.maxK = keep; }
    assert.equal((await ch.search(u, 'd2 k', { k: 3 })).hits.length, 3);
  });

  // ---- D3 -----------------------------------------------------------------------------------------------------------
  await check('D3', 'SkillSearch / SkillHit keys exactly; rank 1-based; cosine true; rerank null at weight 0; TeiError shape', async () => {
    const u = userCtx();
    await addCap(u, 'd3-a', at(0.6)); await addCap(u, 'd3-b', at(0.8));
    tei.qmap.set(Q() + 'd3 prompt', vec({ 0: 2 }));
    const r = await mkChannel().search(u, 'd3 prompt');
    assert.deepEqual(Object.keys(r).sort(), ['degraded', 'hits', 'ms']);
    assert.deepEqual(Object.keys(r.ms).sort(), ['embed', 'load', 'rank', 'rerank', 'total']);
    assert.ok(Object.values(r.ms).every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && close(x * 10, Math.round(x * 10), 1e-6)), 'ms values');
    assert.deepEqual(Object.keys(r.hits[0]).sort(), ['capId', 'cosine', 'kind', 'name', 'namespace', 'rank', 'rerank']);
    assert.deepEqual(r.hits.map((h) => [h.name, h.rank, h.kind, h.namespace, h.rerank]), [['d3-b', 1, 'skill', 'user', null], ['d3-a', 2, 'skill', 'user', null]]);
    assert.ok(close(r.hits[0].cosine, 0.8) && close(r.hits[1].cosine, 0.6), `cosines ${r.hits.map((h) => h.cosine)}`);
    tei.mode.embed = 'fail';
    const e = await teiErr(mkTei().embed(['d3']));
    tei.reset();
    assert.deepEqual([e?.name, e?.code, e?.status, e?.message, e instanceof T.TeiError], ['TeiError', 'http', 503, 'tei embed http 503', true]);
  });

  // ---- D4 -----------------------------------------------------------------------------------------------------------
  await check('D4', 'non-string / blank prompt: empty, no TEI call; bad ctx: store; bad k -> config.k; empty embed/rerank: no request; zero vector row skipped', async () => {
    const u = userCtx();
    for (const [i, c] of [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3].entries()) await addCap(u, `d4-c${i}`, at(c));
    await addCap(u, 'd4-zero', vec({}));
    const ch = mkChannel();
    tei.reset();
    for (const p of [42, null, undefined, '', '   \n\t']) {
      const r = await ch.search(u, p);
      assert.deepEqual([r.hits, r.degraded], [[], []], `prompt ${show(p)}`);
    }
    assert.equal(tei.count('embed'), 0);
    for (const bad of [{}, { userId: 7 }, null]) { const r = await ch.search(bad, 'd4'); assert.deepEqual([r.hits, r.degraded], [[], ['store']]); }
    for (const k of [0, -1, 2.5, '3', NaN]) assert.equal((await ch.search(u, 'd4 k', { k })).hits.length, 5, `k ${show(k)}`);
    assert.equal((await ch.search(u, 'd4 k', 'not-an-object')).hits.length, 5);
    const all = await ch.search(u, 'd4 all', { k: 50 });
    assert.equal(all.hits.some((h) => h.name === 'd4-zero'), false);
    assert.equal(all.hits.length, 7);
    tei.reset();
    const t = mkTei();
    assert.deepEqual([await t.embed([]), await t.rerank('q', []), tei.reqs.length], [[], [], 0]);
    ch.onInval('junk'); ch.onInval({ v: 1, event: 'nope' }); ch.onInval(null);
  });

  // ---- D5 -----------------------------------------------------------------------------------------------------------
  await check('D5', 'NUL/emoji prompt sent as is; k above the count gives all; no vectors: empty; aborted signal: embed, no request; same name twice kept', async () => {
    const u = userCtx();
    await addCap(u, 'd5-same', at(0.9), { namespace: 'user' });
    await addCap(u, 'd5-same', at(0.8), { namespace: 'plug' });
    await addCap(u, 'd5-other', at(0.1), { kind: 'agent' });
    const ch = mkChannel();
    tei.reset();
    const odd = 'a\u0000b \u{1F600} \u0007';
    tei.qmap.set(Q() + odd, vec({ 0: 1 }));
    const r = await ch.search(u, odd, { k: 99 });
    assert.equal(tei.reqs[0].body.inputs[0], Q() + odd);
    assert.deepEqual(r.hits.map((h) => `${h.namespace}:${h.name}`), ['user:d5-same', 'plug:d5-same', 'user:d5-other']);
    const empty = await ch.search(userCtx(), 'd5');
    assert.deepEqual([empty.hits, empty.degraded], [[], []]);
    tei.reset();
    const ac = new AbortController(); ac.abort();
    const ab = await ch.search(u, 'd5 aborted', { signal: ac.signal });
    assert.deepEqual([ab.hits, ab.degraded, tei.count('embed')], [[], ['embed'], 0]);
  });

  // ---- D6 -----------------------------------------------------------------------------------------------------------
  await check('D6', 'no throw with TEI or Postgres down; only loadSkillIndex/listOverrides called; no rerank request at weight 0; frozen inputs; same order twice', async () => {
    const u = userCtx();
    for (const [i, c] of [0.5, 0.5, 0.7].entries()) await addCap(u, `d6-c${i}`, at(c));
    const down = W.createSkillChannel({ repos, tei: mkTei({ port: deadPort }), config: chanCfg() });
    assert.deepEqual((await down.search(u, 'd6')).degraded, ['embed']);
    const dead = spyRepos({ fail: ['loadSkillIndex'] });
    const r0 = await W.createSkillChannel({ repos: dead.r, tei: mkTei(), config: chanCfg() }).search(u, 'd6');
    assert.deepEqual([r0.hits, r0.degraded], [[], ['store']]);
    assert.deepEqual(await W.createSkillChannel({ repos: dead.r, tei: mkTei(), config: chanCfg() }).reload(u), { ok: false, size: 0 });
    const spy = spyRepos();
    const cfg = deepFreeze(chanCfg());
    const ch = W.createSkillChannel({ repos: spy.r, tei: mkTei(), config: cfg });
    tei.reset();
    tei.qmap.set(Q() + 'd6 frozen', vec({ 0: 1 }));
    const ctx = deepFreeze({ ...u });
    const a = await ch.search(ctx, 'd6 frozen', deepFreeze({ k: 3 }));
    const b = await ch.search(ctx, 'd6 frozen', deepFreeze({ k: 3 }));
    assert.deepEqual(a.hits, b.hits);
    assert.deepEqual([a.hits[0].name, a.hits.map((h) => h.name).sort()], ['d6-c2', ['d6-c0', 'd6-c1', 'd6-c2']]);
    assert.equal(tei.count('rerank'), 0);
    assert.deepEqual([...new Set(spy.calls)].filter((c) => c !== 'loadSkillIndex' && c !== 'listOverrides'), []);
  });

  // ---- D7 -----------------------------------------------------------------------------------------------------------
  await check('D7', 'no floor (negative cosine still returned); a pin changes nothing; no rows written', async () => {
    const u = userCtx();
    const p = (await repos.projects.upsert(u, { root: `/t33/d7/${rnd()}` })).id;
    const pos = await addCap(u, 'd7-pos', at(0.4));
    await addCap(u, 'd7-neg', vec({ 0: -0.5, 2: Math.sqrt(0.75) }));
    const count = async () => Number((await sql`select (select count(*) from cap_vectors) + (select count(*) from capability_versions) + (select count(*) from overrides) as n`.execute(db.kysely)).rows[0].n);
    const before = await count();
    const ch = mkChannel();
    tei.qmap.set(Q() + 'd7', vec({ 0: 1 }));
    const r1 = await ch.search({ ...u, projectId: p }, 'd7');
    assert.deepEqual(names(r1), ['d7-pos', 'd7-neg']);
    assert.ok(r1.hits[1].cosine < 0);
    assert.equal(await count(), before);
    await repos.library.upsertOverride({ ...u, projectId: p }, { capId: pos, action: 'pin', version: 1 });
    const r2 = await mkChannel().search({ ...u, projectId: p }, 'd7');
    assert.deepEqual(names(r2), ['d7-pos', 'd7-neg']);
  });

  // ---- D8 -----------------------------------------------------------------------------------------------------------
  await check('D8', 'judgment: comments mark the silence-rule calls in the new modules', async () => {
    const dirs = ['packages/core/src/skills', 'packages/shared/src/tei', 'apps/web/src/skills'];
    const text = dirs.flatMap((d) => fs.readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => src(path.join(d, f)))).join('\n');
    assert.ok(/judgment:/.test(text), 'no `judgment:` comment in core/skills, shared/tei or web/skills');
  });

  // ---- D9 -----------------------------------------------------------------------------------------------------------
  await check('D9', 'layout: core skills pure (no node:fs, no fetch, no node:http); no package.json or lockfile change; overrideRows exported from served.ts', async () => {
    const dir = path.join(ROOT, 'packages/core/src/skills');
    const core = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    assert.deepEqual([/from\s+['"]node:(fs|http|https|net|child_process)/.test(core), /\bfetch\s*\(/.test(core)], [false, false]);
    const changed = execFileSync('git', ['status', '--porcelain', '--', 'package.json', 'pnpm-lock.yaml', 'apps/web/package.json', 'packages/core/package.json', 'packages/shared/package.json'], { cwd: ROOT, encoding: 'utf8' }).trim();
    assert.equal(changed, '');
    assert.ok(/export\s+(async\s+)?function\s+overrideRows|export\s*\{[^}]*\boverrideRows\b/.test(src('apps/web/src/library/served.ts')), 'served.ts exports overrideRows');
  });

  // ---- D10 ----------------------------------------------------------------------------------------------------------
  await check('D10', 'config read at every call; a throwing cache never fails embed; tei.embed fits the T3.1 Embed shape', async () => {
    const u = userCtx();
    for (const [i, c] of [0.9, 0.8, 0.7].entries()) await addCap(u, `d10-c${i}`, at(c));
    const cfg = chanCfg({ k: 1 });
    const ch = W.createSkillChannel({ repos, tei: mkTei(), config: cfg });
    assert.equal((await ch.search(u, 'd10')).hits.length, 1);
    cfg.k = 2;
    assert.equal((await ch.search(u, 'd10')).hits.length, 2);
    const boom = { async getVec() { throw new Error('redis down'); }, async setVec() { throw new Error('redis down'); } };
    tei.qmap.set('d10 doc', vec({ 5: 1 }));
    const out = await mkTei({ cache: boom }).embed(['d10 doc']);
    assert.deepEqual([out.length, out[0].length, out[0][5], Array.isArray(out[0])], [1, DIM, 1, true]);
  });

  // ---- D11 ----------------------------------------------------------------------------------------------------------
  await check('D11', 'embed request shape and URL; reply validation; http/unreachable/timeout/aborted codes; 1-input vs batch timeout; emb: cache', async () => {
    tei.reset();
    const t = T.createTei({ config: { ...teiCfg(), embed_url: `http://127.0.0.1:${tei.port}/` } });
    tei.qmap.set('d11 a', vec({ 3: 1 }));
    const [v] = await t.embed(['d11 a']);
    assert.equal(v[3], 1);
    assert.deepEqual([tei.reqs[0].url, tei.reqs[0].method, tei.reqs[0].ct?.split(';')[0], tei.reqs[0].body], ['/embed', 'POST', 'application/json', { inputs: ['d11 a'], truncate: true }]);
    const codes = [];
    for (const m of ['short', 'baddim', 'nan', 'fail']) { tei.mode.embed = m; const e = await teiErr(mkTei().embed(['x', 'y'])); codes.push(e?.code); }
    tei.reset();
    codes.push((await teiErr(mkTei({ port: deadPort }).embed(['x'])))?.code);
    assert.deepEqual(codes, ['bad_reply', 'bad_reply', 'bad_reply', 'http', 'unreachable']);
    tei.mode.embed = 'hang';
    const t0 = Date.now();
    const te = await teiErr(mkTei({ timeout_s: 0.3, batch_timeout_s: 0.3 }).embed(['x']));
    assert.deepEqual([te?.code, Date.now() - t0 < 2500], ['timeout', true]);
    const ac = new AbortController(); setTimeout(() => ac.abort(), 100);
    assert.equal((await teiErr(mkTei({ timeout_s: 5 }).embed(['x'], { signal: ac.signal })))?.code, 'aborted');
    tei.reset(); tei.delayMs = 600;
    assert.equal((await teiErr(mkTei({ timeout_s: 0.3, batch_timeout_s: 5 }).embed(['x'])))?.code, 'timeout');
    assert.equal((await mkTei({ timeout_s: 0.3, batch_timeout_s: 5 }).embed(['x', 'y'])).length, 2);
    tei.reset();
    const m = new Map(); const sets = [];
    const cache = { async getVec(k) { return m.get(k); }, async setVec(k, val, ttlS) { sets.push([k, ttlS]); m.set(k, Float32Array.from(val)); } };
    const tc = mkTei({ cache });
    tei.qmap.set('d11 c', vec({ 7: 1 }));
    await tc.embed(['d11 c', 'd11 c']);
    assert.deepEqual(tei.reqs.map((x) => x.body.inputs), [['d11 c']]);
    assert.deepEqual(sets, [[KEYMOD.keys.emb('m-test\u0000d11 c'), 604800]]);
    const again = await tc.embed(['d11 c']);
    assert.deepEqual([tei.reqs.length, again[0][7]], [1, 1]);
    m.set(KEYMOD.keys.emb('m-test\u0000d11 short'), Float32Array.from([1, 2]));
    await tc.embed(['d11 short']);
    assert.equal(tei.reqs.length, 2);
  });

  // ---- D12 ----------------------------------------------------------------------------------------------------------
  await check('D12', 'rerank request shape; logits back in input order; a missing index is bad_reply; 33 texts -> 2 requests', async () => {
    tei.reset();
    tei.rmap.set('r-a', -1); tei.rmap.set('r-b', 3); tei.rmap.set('r-c', 1);
    const out = await mkTei().rerank('d12 q', ['r-a', 'r-b', 'r-c']);
    assert.deepEqual(out, [-1, 3, 1]);
    assert.deepEqual([tei.reqs[0].url, tei.reqs[0].body], ['/rerank', { query: 'd12 q', texts: ['r-a', 'r-b', 'r-c'], raw_scores: true, truncate: true }]);
    tei.mode.rerank = 'missing';
    assert.equal((await teiErr(mkTei().rerank('q', ['r-a', 'r-b'])))?.code, 'bad_reply');
    tei.reset();
    const many = await mkTei().rerank('q', Array.from({ length: 33 }, (_, i) => `t${i}`));
    assert.deepEqual([many.length, tei.reqs.map((x) => x.body.texts.length)], [33, [32, 1]]);
  });

  // ---- D13 ----------------------------------------------------------------------------------------------------------
  await check('D13', 'the two instruction strings exactly; queryText; unknown -> skillret; channel uses config.embed.instruction', async () => {
    assert.deepEqual({ ...C.QUERY_INSTRUCTIONS }, {
      coding: 'Instruct: Given a coding task or question, retrieve capabilities (skills, agents, commands, workflows) that help accomplish it\nQuery: ',
      skillret: 'Instruct: Given a skill search query, retrieve relevant skills that match the query\nQuery: ',
    });
    assert.equal(C.queryText('p', 'coding'), C.QUERY_INSTRUCTIONS.coding + 'p');
    assert.equal(C.queryText('p', 'nope'), C.QUERY_INSTRUCTIONS.skillret + 'p');
    const u = userCtx(); await addCap(u, 'd13-a', at(0.5));
    tei.reset();
    await W.createSkillChannel({ repos, tei: mkTei(), config: chanCfg({ instruction: 'coding' }) }).search(u, 'd13 p');
    assert.deepEqual(tei.reqs[0].body.inputs, [C.QUERY_INSTRUCTIONS.coding + 'd13 p']);
  });

  // ---- D14 ----------------------------------------------------------------------------------------------------------
  await check('D14', 'one load per user; invalidate/onInval/maxAge reload in the background without waiting; retry pause; reload(); maxUsers eviction', async () => {
    const u = userCtx();
    await addCap(u, 'd14-old', at(0.5));
    tei.qmap.set(Q() + 'd14', vec({ 0: 1 }));
    let clock = 1_000_000;
    const spy = spyRepos({ delay: { loadSkillIndex: 400 }, delayAfter: 1 });
    const ch = W.createSkillChannel({ repos: spy.r, tei: mkTei(), config: chanCfg(), now: () => clock });
    await Promise.all([ch.search(u, 'd14'), ch.search(u, 'd14')]);
    assert.equal(spy.n('loadSkillIndex'), 1);
    await addCap(u, 'd14-new', at(0.9));
    assert.deepEqual(names(await ch.search(u, 'd14')), ['d14-old']);
    ch.invalidate(u.userId);
    const t0 = Date.now();
    assert.deepEqual(names(await ch.search(u, 'd14')), ['d14-old']);
    assert.ok(Date.now() - t0 < 300, 'search waited for the background reload');
    assert.ok(await until(async () => names(await ch.search(u, 'd14'))[0] === 'd14-new'), 'reload never landed');
    const n2 = spy.n('loadSkillIndex');
    await addCap(u, 'd14-third', at(0.95));
    ch.onInval({ v: 1, event: 'library.changed', userId: u.userId });
    await ch.search(u, 'd14');
    assert.ok(await until(async () => names(await ch.search(u, 'd14'))[0] === 'd14-third'), 'onInval reload never landed');
    const n3 = spy.n('loadSkillIndex');
    assert.equal(n3, n2 + 1);
    clock += 60_001;
    await ch.search(u, 'd14');
    assert.ok(await until(async () => spy.n('loadSkillIndex') === n3 + 1), 'maxAge reload');
    assert.deepEqual(await ch.reload(u), { ok: true, size: 3 });
    const f = spyRepos({ fail: ['loadSkillIndex'] });
    const fc = W.createSkillChannel({ repos: f.r, tei: mkTei(), config: chanCfg(), now: () => clock });
    await fc.search(u, 'd14'); await fc.search(u, 'd14');
    assert.equal(f.n('loadSkillIndex'), 1);
    clock += 5001;
    await fc.search(u, 'd14');
    assert.equal(f.n('loadSkillIndex'), 2);
    const keep = W.skillLimits.maxUsers;
    try {
      W.skillLimits.maxUsers = 1;
      const e = spyRepos();
      const ec = W.createSkillChannel({ repos: e.r, tei: mkTei(), config: chanCfg() });
      const v = userCtx(); await addCap(v, 'd14-v', at(0.5));
      await ec.search(u, 'd14'); await ec.search(v, 'd14'); await ec.search(u, 'd14');
      assert.equal(e.n('loadSkillIndex'), 3);
    } finally { W.skillLimits.maxUsers = keep; }
  });

  // ---- D15 ----------------------------------------------------------------------------------------------------------
  await check('D15', 'topCosine: cosine on normalised rows, ties by lower index, n cut, zero query empty', async () => {
    const rows = [[1, 0], [0, 1], [1, 1], [1, 0]].map((r) => C.normalize(r));
    const m = new Float32Array(8); rows.forEach((r, i) => m.set(r, i * 2));
    const got = C.topCosine(m, 2, [3, 0], 3).map((s) => [s.index, Math.round(s.score * 1e4) / 1e4]);
    assert.deepEqual(got, [[0, 1], [3, 1], [2, 0.7071]]);
    assert.deepEqual(C.topCosine(m, 2, [0, 0], 3), []);
    assert.equal(C.normalize([0, 0]), null);
  });

  // ---- D16 ----------------------------------------------------------------------------------------------------------
  await check('D16', 'tokenize (NFKC, lower, split on non letter/digit); BM25 k1 1.2 b 0.75; only score > 0; ties by lower index', async () => {
    assert.deepEqual(C.tokenize('Héllo-World_x 42 ÄB ﬁle'), ['héllo', 'world', 'x', '42', 'äb', 'file']);
    const docs = ['tdd red green', 'red', 'blue sky', 'red'];
    const idx = C.buildKeywordIndex(docs);
    const got = C.keywordTop(idx, 'Red tdd red', 10);
    const N = 4; const avg = (3 + 1 + 2 + 1) / 4;
    const idf = (df) => Math.log(1 + (N - df + 0.5) / (df + 0.5));
    const bm = (tf, len) => (tf * 2.2) / (tf + 1.2 * (1 - 0.75 + 0.75 * (len / avg)));
    const s0 = idf(3) * bm(1, 3) + idf(1) * bm(1, 3); const s1 = idf(3) * bm(1, 1);
    assert.ok(s0 > s1, 'fixture: doc 0 must outscore docs 1 and 3');
    assert.deepEqual(got.map((s) => s.index), [0, 1, 3]);
    assert.ok(close(got.find((s) => s.index === 0).score, s0) && close(got.find((s) => s.index === 1).score, s1), `scores ${show(got)}`);
    assert.equal(got.some((s) => s.index === 2), false);
  });

  // ---- D17 ----------------------------------------------------------------------------------------------------------
  await check('D17', 'rrf maths; keyword weight lifts a keyword match; fusion score with score_w', async () => {
    const m = C.rrf([['a', 'b'], ['b', 'c']], [1, 0.5], 60);
    assert.ok(close(m.get('a'), 1 / 61, 1e-12) && close(m.get('b'), 1 / 62 + 0.5 / 61, 1e-12) && close(m.get('c'), 0.5 / 62, 1e-12));
    const u = userCtx();
    await addCap(u, 'd17-dense', at(0.9), { description: 'nothing shared' });
    await addCap(u, 'd17-word', at(0.8), { description: 'zebra quokka' });
    tei.qmap.set(Q() + 'zebra quokka', vec({ 0: 1 }));
    const run = (ranking) => W.createSkillChannel({ repos, tei: mkTei(), config: chanCfg({ ranking }) }).search(u, 'zebra quokka');
    assert.deepEqual(names(await run({ keyword_rrf_weight: 0 })), ['d17-dense', 'd17-word']);
    assert.deepEqual(names(await run({ keyword_rrf_weight: 1 })), ['d17-word', 'd17-dense']);
    assert.deepEqual(names(await run({ fusion: 'score', score_w: 0.5 })), ['d17-word', 'd17-dense']);
    assert.deepEqual(names(await run({ fusion: 'score', score_w: 1 })), ['d17-dense', 'd17-word']);
  });

  // ---- D18 ----------------------------------------------------------------------------------------------------------
  await check('D18', 'rerank RRF with weight; tie by first order; pool = rerank_top, rest appended with null; sigmoid/logit; rerank failure falls back', async () => {
    const u = userCtx();
    await addCap(u, 'd18-a', at(0.9), { description: 'da' });
    await addCap(u, 'd18-b', at(0.8), { description: 'db' });
    await addCap(u, 'd18-c', at(0.7), { description: 'dc' });
    tei.qmap.set(Q() + 'd18', vec({ 0: 1 }));
    tei.rmap.set('d18-a | da', -5); tei.rmap.set('d18-b | db', 0); tei.rmap.set('d18-c | dc', 5);
    const run = (o) => W.createSkillChannel({ repos, tei: mkTei(), config: chanCfg(o) }).search(u, 'd18');
    tei.reset();
    const r = await run({ ranking: { rerank_weight: 1 } });
    assert.deepEqual(names(r), ['d18-a', 'd18-c', 'd18-b']);
    assert.deepEqual(tei.reqs.filter((x) => x.op === 'rerank').map((x) => x.body.query), ['d18']);
    assert.ok(close(r.hits[0].rerank, C.sigmoid(-5)) && close(r.hits[1].rerank, C.sigmoid(5)), `rerank ${show(r.hits)}`);
    assert.ok(close(C.sigmoid(0), 0.5, 1e-12));
    const lg = await run({ ranking: { rerank_weight: 1, rerank_by: 'logit' } });
    assert.deepEqual(lg.hits.map((h) => h.rerank), [-5, 5, 0]);
    const top2 = await run({ rerank_top: 2, ranking: { rerank_weight: 1 } });
    assert.deepEqual([names(top2), top2.hits[2].rerank], [['d18-a', 'd18-b', 'd18-c'], null]);
    const heavy = await run({ ranking: { rerank_weight: 3 } });
    assert.deepEqual(names(heavy), ['d18-c', 'd18-b', 'd18-a']);
    tei.mode.rerank = 'fail';
    const fb = await run({ ranking: { rerank_weight: 1 } });
    tei.reset();
    assert.deepEqual([names(fb), fb.degraded, fb.hits.map((h) => h.rerank)], [['d18-a', 'd18-b', 'd18-c'], ['rerank'], [null, null, null]]);
  });

  // ---- D19 ----------------------------------------------------------------------------------------------------------
  await check('D19', 'global block hides everywhere; project block hides in that project only; listOverrides failure: no filter, no throw', async () => {
    const u = userCtx();
    const p1 = (await repos.projects.upsert(u, { root: `/t33/d19/${rnd()}` })).id;
    const p2 = (await repos.projects.upsert(u, { root: `/t33/d19/${rnd()}` })).id;
    const g = await addCap(u, 'd19-global', at(0.9));
    const pb = await addCap(u, 'd19-proj', at(0.8));
    await addCap(u, 'd19-free', at(0.7));
    await repos.library.upsertOverride(u, { capId: g, action: 'block' });
    await repos.library.upsertOverride({ ...u, projectId: p1 }, { capId: pb, action: 'block' });
    tei.qmap.set(Q() + 'd19', vec({ 0: 1 }));
    const ch = mkChannel();
    assert.deepEqual(names(await ch.search({ ...u, projectId: p1 }, 'd19')), ['d19-free']);
    assert.deepEqual(names(await ch.search({ ...u, projectId: p2 }, 'd19')), ['d19-proj', 'd19-free']);
    assert.deepEqual(names(await ch.search(u, 'd19')), ['d19-proj', 'd19-free']);
    const f = spyRepos({ fail: ['listOverrides'] });
    const r = await W.createSkillChannel({ repos: f.r, tei: mkTei(), config: chanCfg() }).search({ ...u, projectId: p1 }, 'd19');
    assert.deepEqual(names(r), ['d19-global', 'd19-proj', 'd19-free']);
  });

  // ---- D20 ----------------------------------------------------------------------------------------------------------
  await check('D20', 'step order: no matrix -> store only, no TEI call; bad embed reply -> embed; rerank failure -> rerank only', async () => {
    const u = userCtx(); await addCap(u, 'd20-a', at(0.9));
    tei.reset();
    const f = spyRepos({ fail: ['loadSkillIndex'] });
    const r1 = await W.createSkillChannel({ repos: f.r, tei: mkTei({ port: deadPort }), config: chanCfg() }).search(u, 'd20');
    assert.deepEqual([r1.degraded, tei.reqs.length], [['store'], 0]);
    tei.mode.embed = 'baddim';
    const r2 = await mkChannel().search(u, 'd20');
    assert.deepEqual([r2.hits, r2.degraded], [[], ['embed']]);
    tei.reset(); tei.mode.rerank = 'fail';
    const r3 = await W.createSkillChannel({ repos, tei: mkTei(), config: chanCfg({ ranking: { rerank_weight: 1 } }) }).search(u, 'd20');
    tei.reset();
    assert.deepEqual([names(r3), r3.degraded], [['d20-a'], ['rerank']]);
  });

  // ---- D21 ----------------------------------------------------------------------------------------------------------
  await check('D21', 'loadSkillIndex: keys, live with a vector only, served description, one row per capability, capId order, tenancy case', async () => {
    const u = userCtx(); const other = userCtx();
    const two = await addCap(u, 'd21-two', at(0.5), { description: 'old desc' });
    await repos.library.createVersion(u, { namespace: 'user', kind: 'skill', name: 'd21-two', rootPath: '/x', description: 'new desc', frontmatter: {}, bodyHash: sha('v2'),
      commitMessage: 'chk', blobs: [{ hash: sha('v2 body'), content: 'v2 body', size: 7 }], files: [{ path: 'SKILL.md', blobHash: sha('v2 body') }] });
    await repos.library.setServed(u, two, 1);
    await repos.library.upsertVector(u, { capId: two, textHash: '0', embedding: at(0.6), model: 'm' });
    await addCap(u, 'd21-novec', null);
    const gone = await addCap(u, 'd21-gone', at(0.5)); await repos.library.markRemoved(u, gone);
    const unserved = await addCap(u, 'd21-unserved', at(0.5), { served: null });
    await addCap(other, 'd21-other', at(0.5));
    const rows = await repos.library.loadSkillIndex(u);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['capId', 'description', 'embedding', 'kind', 'name', 'namespace']);
    assert.deepEqual(rows.map((r) => r.name).sort(), ['d21-two', 'd21-unserved']);
    assert.deepEqual(rows.map((r) => r.capId), rows.map((r) => r.capId).slice().sort());
    const t = rows.find((r) => r.capId === two);
    assert.deepEqual([t.description, t.embedding.length, close(t.embedding[0], 0.6)], ['old desc', DIM, true]);
    assert.equal(rows.find((r) => r.capId === unserved).description, '');
    assert.ok(/\bloadSkillIndex\s*:\s*\{\s*expect:\s*'no-a'/.test(src(CASES)), 'tenancy case loadSkillIndex expect no-a');
  });

  // ---- D22 ----------------------------------------------------------------------------------------------------------
  await check('D22', 'ndcgAt (linear gain, log2, repeats once, IDCG 0 -> 0) and recallAt', async () => {
    const idcg2 = 1 + 1 / Math.log2(3);
    assert.ok(close(C.ndcgAt(['a', 'x', 'b'], { a: 1, b: 1 }, 10), 1.5 / idcg2, 1e-9));
    assert.ok(close(C.ndcgAt(['a', 'a', 'b'], { a: 1, b: 1 }, 10), 1.5 / idcg2, 1e-9));
    assert.ok(close(C.ndcgAt(['b', 'a'], { a: 2, b: 1 }), (1 + 2 / Math.log2(3)) / (2 + 1 / Math.log2(3)), 1e-9));
    assert.equal(C.ndcgAt(['x', 'a'], { a: 1 }, 1), 0);
    assert.equal(C.ndcgAt(['a'], {}, 10), 0);
    assert.deepEqual([C.recallAt(['x', 'a'], { a: 1, b: 1, c: 0 }, 1), C.recallAt(['x', 'a'], { a: 1, b: 1, c: 0 }, 2), C.recallAt(['a'], { a: 0 }, 5)], [0, 0.5, 0]);
  });

  // ---- D23 ----------------------------------------------------------------------------------------------------------
  await check('D23', 'gate test file with describe/it names, the 0.80 bar and the strict switch; export file counts when present', async () => {
    assert.ok(fs.existsSync(path.join(ROOT, GATE)), `${GATE} missing`);
    const text = src(GATE);
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const missing = [];
    if (!new RegExp(`describe(\\.skipIf\\([^)]*\\))?\\(\\s*['"\`]${esc(GATE_DESCRIBE)}['"\`]`).test(text)) missing.push(`describe('${GATE_DESCRIBE}')`);
    if (!new RegExp(`\\b(it|test)\\(\\s*['"\`]${esc(GATE_IT)}['"\`]`).test(text)) missing.push(`it('${GATE_IT}')`);
    for (const s of ['CTC_GATE_SUGGEST_SKILLS', 'skillret-test.json', '0.8', 'ndcgAt', 'createSkillChannel', 'ctc_t33_']) if (!text.includes(s)) missing.push(s);
    assert.deepEqual(missing, []);
    if (fs.existsSync(EXPORT)) {
      const j = JSON.parse(fs.readFileSync(EXPORT, 'utf8'));
      assert.deepEqual([j.skills.length, j.queries.length, Object.keys(j.qrels).length, Object.keys(j.skills[0]).sort()], [6006, 4392, 4392, ['body', 'description', 'id', 'name']]);
    } else console.log(`note: ${EXPORT} not present (selfcheck.py --export writes it); export counts not checked`);
    assert.equal(typeof CL.skillretText, 'function');
  });
} catch (e) {
  console.log(`note: check run aborted: ${e?.name}: ${e?.message}`);
}
await finish();
