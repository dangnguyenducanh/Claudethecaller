// checks for T1.3 packages/shared/src/repositories: one runnable example per decision id (D0..D16).
// Prints `PASS D# ...` or `FAIL D# expected=<..> got=<..>`; last line `CHECKS: <n> pass, <m> fail`; exit 1 on any FAIL.
// Needs: env CTC_SCRATCH_PG_URL (scratch Postgres 127.0.0.1:18304 only) and the T1.2 migrations
// (`packages/shared/src/repositories/admin` exporting migrate({url, schema})). Run from the repo root:
//   node --import tsx agent/t1-3-repos/checks.mjs      (tsx lets Node import the .ts sources)
// Fixture values are this file's own; nothing is derived from the module's code.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(new URL('../../', import.meta.url).pathname);
const MODULE_ENTRY = 'packages/shared/src/repositories/index.ts'; // T1.1 D3b puts sources under src/
const MIGRATIONS_ENTRY = 'packages/shared/src/repositories/admin/index.ts'; // T1.2 exports migrate({url, schema})
const IDS = Array.from({ length: 17 }, (_, i) => `D${i}`);
let pass = 0;
let fail = 0;
const done = new Set();
const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
function ok(id, msg) { pass++; done.add(id); console.log(`PASS ${id} ${msg}`); }
function bad(id, expected, got) { fail++; done.add(id); console.log(`FAIL ${id} expected=${show(expected)} got=${show(got)}`); }
async function check(id, msg, fn) {
  try { await fn(); ok(id, msg); } catch (e) {
    if (e && e.name === 'AssertionError') bad(id, e.expected, e.actual);
    else bad(id, msg, `${e?.name}: ${e?.message}`);
  }
}
function finish() {
  for (const id of IDS) if (!done.has(id)) bad(id, 'a check', 'missing');
  console.log(`CHECKS: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
function failAll(why) { for (const id of IDS) bad(id, 'module importable and scratch DB ready', why); finish(); }

// ---- load module, migrations, scratch DB ------------------------------------------------------------------------
const url = process.env.CTC_SCRATCH_PG_URL;
if (!url) failAll('env CTC_SCRATCH_PG_URL not set');
const u = new URL(url);
if (u.hostname !== '127.0.0.1' || u.port !== '18304') failAll(`refusing ${u.hostname}:${u.port}, only the scratch Postgres 127.0.0.1:18304`);
let mod; let mig;
try { mod = await import(pathToFileURL(path.join(ROOT, MODULE_ENTRY)).href); }
catch (e) { failAll(`module not importable: ${e?.code ?? e?.name}: ${String(e?.message).split('\n')[0]}`); }
try { mig = await import(pathToFileURL(path.join(ROOT, MIGRATIONS_ENTRY)).href); }
catch (e) { failAll(`T1.2 migrations not importable: ${e?.code ?? e?.name}: ${String(e?.message).split('\n')[0]}`); }

const schema = `ctc_t13_chk_${randomBytes(4).toString('hex')}`;
const require = createRequire(path.join(ROOT, 'packages/shared/package.json'));
let db; let db2; let repos; let sql; let sctx;
try {
  ({ sql } = require('kysely'));
  await mig.migrate({ url, schema });
  db = mod.createDb({ url, schema });
  repos = mod.createRepositories(db);
  sctx = mod.createSystemCtx('checks');
} catch (e) { failAll(`setup failed: ${e?.name}: ${String(e?.message).split('\n')[0]}`); }

const A = { userId: 'user-a' };
const B = { userId: 'user-b' };
const rnd = () => randomBytes(4).toString('hex');
const uuid4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const skill = (name, bodyHash = 'h1', files = [['SKILL.md', 'b1', 'hello']]) => ({
  namespace: 'user', kind: 'skill', name, rootPath: `/x/${name}`, description: 'd', frontmatter: {}, bodyHash,
  commitMessage: 'm',
  blobs: files.map(([, hash, content]) => ({ hash, content, size: content.length })),
  files: files.map(([p, blobHash]) => ({ path: p, blobHash })),
});
const deepFreeze = (o) => { Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o); };

try {
  const pA = await repos.projects.upsert(A, { root: `/chk/${rnd()}/a` });
  const AP = { userId: 'user-a', projectId: pA.id };
  const BP = { userId: 'user-b', projectId: pA.id }; // forged: B claims A's project

  await check('D0', 'domains exist; A reads its own project, B cannot', async () => {
    const want = ['projects', 'sessions', 'history', 'jobs', 'idempotency', 'apiKeys', 'dedup', 'graph', 'library', 'memory', 'runner', 'system'];
    assert.deepEqual(Object.keys(repos).sort(), [...want].sort());
    assert.equal((await repos.projects.get(A, pA.id))?.root, pA.root);
    assert.equal(await repos.projects.get(B, pA.id), null);
  });

  await check('D1', 'userId only from ctx; hostile text stored verbatim and harmless', async () => {
    const root = `/chk/inj'; drop table projects;--${rnd()}`;
    const row = await repos.projects.upsert(B, { root, userId: 'user-a', user_id: 'user-a' });
    assert.equal(row.userId, 'user-b');
    assert.equal(row.root, root);
    assert.equal((await repos.projects.list(A, { limit: 500 })).rows.some((r) => r.root === root), false);
    assert.equal((await repos.projects.get(A, pA.id))?.id, pA.id); // table still there
    assert.equal(await repos.graph.getNode(BP, 'anything'), null); // forged project id matches nothing
  });

  await check('D2', 'limits: maxPage 500, defaultPage 50, manyIds 20, read at call time', async () => {
    assert.deepEqual([mod.limits.maxPage, mod.limits.defaultPage, mod.limits.manyIds, mod.limits.statementTimeoutMs], [500, 50, 20, 5000]);
    const root2 = `/chk/${rnd()}/a2`; const root3 = `/chk/${rnd()}/a3`;
    await repos.projects.upsert(A, { root: root2 }); await repos.projects.upsert(A, { root: root3 });
    const keep = mod.limits.maxPage;
    try { mod.limits.maxPage = 2; assert.equal((await repos.projects.list(A, { limit: 100 })).rows.length, 2); }
    finally { mod.limits.maxPage = keep; }
    const ids = Array.from({ length: 21 }, () => crypto.randomUUID());
    await assert.rejects(() => repos.memory.getMany(AP, ids), (e) => e.code === 'invalid');
  });

  await check('D3', 'null for missing/foreign, keyset pages disjoint, typed errors', async () => {
    const all = await repos.projects.list(A, { limit: 500 });
    assert.ok(all.rows.length >= 3);
    const p1 = await repos.projects.list(A, { limit: 2 });
    assert.equal(p1.rows.length, 2); assert.equal(typeof p1.next, 'string');
    const p2 = await repos.projects.list(A, { limit: 2, cursor: p1.next });
    assert.ok(p2.rows.length >= 1);
    assert.deepEqual(p2.rows.filter((r) => p1.rows.some((q) => q.id === r.id)), []);
    const id = crypto.randomUUID();
    await repos.jobs.create(A, { id, queue: 'llm', kind: 'enrich', payload: { secret: 'a-only' } });
    let err; try { await repos.jobs.create(B, { id, queue: 'llm', kind: 'enrich', payload: {} }); } catch (e) { err = e; }
    assert.ok(err instanceof mod.RepoError && err instanceof mod.ConflictError, 'ConflictError extends RepoError');
    assert.equal(err.code, 'conflict');
    assert.equal(String(err.message).includes('a-only'), false);
  });

  await check('D4', 'bad ctx -> TypeError; bad cursor/latest label/too many ids -> invalid', async () => {
    await assert.rejects(() => repos.projects.get(undefined, 'x'), (e) => e instanceof TypeError && e.message === 'ctx.userId required');
    await assert.rejects(() => repos.projects.get({ userId: '   ' }, 'x'), (e) => e instanceof TypeError && e.message === 'ctx.userId required');
    await assert.rejects(() => repos.graph.stats(A), (e) => e instanceof TypeError && e.message === 'ctx.projectId required');
    await assert.rejects(() => repos.projects.list(A, { cursor: '!!!not-a-cursor' }), (e) => e.code === 'invalid');
    const name = `chk-${rnd()}`;
    await repos.library.createVersion(A, skill(name));
    const cap = (await repos.library.listCapabilities(A, { limit: 500 })).rows.find((c) => c.name === name);
    await assert.rejects(() => repos.library.moveLabels(A, { capId: cap.id, version: 1, labels: ['latest'] }), (e) => e.code === 'invalid');
  });

  await check('D5', 'tolerant: missing -> null/0, empty page, new user empty, repeat create is not an error', async () => {
    assert.equal(await repos.projects.get(A, 'zzzzzzzz'), null);
    assert.equal(await repos.history.setStatus(A, `/nope/${rnd()}`, 'failed'), 0);
    assert.deepEqual(await repos.projects.list({ userId: `user-new-${rnd()}` }, {}), { rows: [], next: null });
    const id = crypto.randomUUID();
    const first = await repos.jobs.create(A, { id, queue: 'graph', kind: 'rebuild', payload: {} });
    const second = await repos.jobs.create(A, { id, queue: 'graph', kind: 'rebuild', payload: {} });
    assert.deepEqual([first.created, second.created, second.job.id], [true, false, id]);
    assert.equal(await repos.jobs.cancel(A, crypto.randomUUID()), null);
  });

  await check('D6', 'frozen input ok; failed transaction leaves old rows; statement timeout -> store_timeout', async () => {
    await repos.projects.upsert(A, deepFreeze({ root: `/chk/${rnd()}/frozen` }));
    const node = (id) => ({ id, kind: 'code', type: 'function', label: id });
    const src = { contentHash: 'c1', extractorVersion: '1', builtAtCommit: 'abc' };
    await repos.graph.replaceSource(AP, { origin: 'ast', sourceFile: 'f.ts', nodes: [node('n1'), node('n2')], edges: [], source: src });
    assert.equal(await repos.graph.sourceNodeCount(AP, 'f.ts'), 2);
    await assert.rejects(() => repos.graph.replaceSource(AP, {
      origin: 'ast', sourceFile: 'f.ts', nodes: [node('n3')], edges: [{ src: 'n3', dst: 'n1', relation: 'calls', confidence: 'BOGUS' }], source: src,
    }));
    assert.equal(await repos.graph.sourceNodeCount(AP, 'f.ts'), 2); // rolled back, old rows kept
    db2 = mod.createDb({ url, schema, statementTimeoutMs: 100 });
    const slow = mod.createRepositories(db2);
    let release; const gate = new Promise((r) => { release = r; });
    let locked; const hasLock = new Promise((r) => { locked = r; });
    const holder = db.kysely.transaction().execute(async (trx) => {
      await sql`select 1 from projects where id = ${pA.id} and user_id = 'user-a' for update`.execute(trx);
      locked(); await gate;
    });
    await hasLock;
    try {
      await assert.rejects(() => slow.projects.bumpEpoch(A, pA.id, 'graph'), (e) => e instanceof mod.StoreTimeoutError && e.code === 'store_timeout');
    } finally { release(); await holder; }
  });

  await check('D7', 'non-goals: no 200-file limit, no retry rule, no route codes in the repository', async () => {
    const files = Array.from({ length: 201 }, (_, i) => [`f${i}.md`, 'b1', 'hello']);
    const r = await repos.library.createVersion(A, skill(`chk-many-${rnd()}`, 'h201', files));
    assert.equal(r.created, true);
    assert.equal(typeof repos.runner.retryStep, 'undefined');
    assert.equal(mod.limits.maxFailures, undefined);
  });

  await check('D8', 'silence rule: out-of-range or unknown input is tolerated, not thrown', async () => {
    const t = await repos.memory.timeline(AP, { anchorId: crypto.randomUUID(), before: 99, after: 99 });
    assert.deepEqual([t.memories, t.summaries], [[], []]);
    assert.equal(await repos.library.clearOverride(AP, crypto.randomUUID()), 0);
  });

  await check('D9', 'createDb validates schema, close() resolves, entry exports', async () => {
    assert.throws(() => mod.createDb({ url, schema: 'bad;drop schema x' }), TypeError);
    const tmp = mod.createDb({ url, schema });
    await tmp.close();
    for (const n of ['createDb', 'createRepositories', 'createSystemCtx', 'limits', 'RepoError', 'ConflictError', 'StoreTimeoutError']) {
      assert.ok(n in mod, `export ${n}`);
    }
  });

  await check('D10', 'T1.2 schema provides the assumed columns', async () => {
    const want = [['projects', 'graph_epoch'], ['projects', 'mem_epoch'], ['jobs', 'payload'], ['jobs', 'user_id'], ['jobs', 'attempts'],
      ['idempotency_keys', 'user_id'], ['history_files', 'user_id'], ['graph_edges', 'user_id'], ['graph_edges', 'project_id'],
      ['capabilities', 'removed_at'], ['dedup_review', 'user_id'], ['wf_schedules', 'user_id']];
    const { rows } = await sql`select table_name t, column_name c from information_schema.columns where table_schema = ${schema}`.execute(db.kysely);
    const have = new Set(rows.map((r) => `${r.t}.${r.c}`));
    assert.deepEqual(want.map(([t, c]) => `${t}.${c}`).filter((k) => !have.has(k)), []);
  });

  await check('D11', "B cannot reach A's version, manifest or blob through the child tables", async () => {
    const name = `chk-child-${rnd()}`;
    await repos.library.createVersion(A, skill(name, 'hc'));
    const cap = (await repos.library.listCapabilities(A, { limit: 500 })).rows.find((c) => c.name === name);
    const v = (await repos.library.listVersions(A, cap.id))[0];
    assert.equal((await repos.library.manifest(A, v.id)).length, 1);
    assert.equal(await repos.library.getBlob(A, v.id, 'SKILL.md'), 'hello');
    assert.equal(await repos.library.getVersionById(B, v.id), null);
    assert.deepEqual(await repos.library.manifest(B, v.id), []);
    assert.equal(await repos.library.getBlob(B, v.id, 'SKILL.md'), null);
  });

  await check('D12', 'tenancy test and cases exist and cover every function', async () => {
    const fs = await import('node:fs');
    const dir = path.join(ROOT, 'packages/shared/src/repositories');
    const test = fs.readFileSync(path.join(dir, 'tenancy.test.ts'), 'utf8');
    assert.match(test, /describe\(\s*['"]tenancy['"]/);
    const casesMod = await import(pathToFileURL(path.join(dir, 'tenancy.cases.ts')).href);
    const cases = casesMod.default ?? casesMod.cases;
    const fns = [];
    for (const [d, o] of Object.entries(repos)) if (d !== 'system') for (const [f, v] of Object.entries(o)) if (typeof v === 'function') fns.push(`${d}.${f}`);
    const have = Object.entries(cases).flatMap(([d, o]) => Object.keys(o).map((f) => `${d}.${f}`));
    assert.deepEqual(fns.filter((k) => !have.includes(k)).sort(), []);
    assert.deepEqual(have.filter((k) => !fns.includes(k)).sort(), []);
  });

  await check('D13', 'system allowlist is exact; SystemCtx needs a reason; findByHash skips revoked', async () => {
    const want = ['apiKeys.findByHash', 'cleanup.deleteUnreferencedBlobs', 'cleanup.listFinishedRuns', 'cleanup.pruneIdempotencyKeys',
      'jobs.listQueued', 'jobs.markDead', 'jobs.markDone', 'jobs.markFailed', 'jobs.markQueued', 'jobs.markRunning', 'jobs.setProgress',
      'runner.listRunningSteps'];
    const got = Object.entries(repos.system).flatMap(([d, o]) => Object.keys(o).map((f) => `${d}.${f}`)).sort();
    assert.deepEqual(got, want);
    assert.throws(() => mod.createSystemCtx(''), /./);
    const keyHash = `h-${rnd()}`;
    const k = await repos.apiKeys.create(A, { name: 'chk', keyHash });
    assert.equal((await repos.system.apiKeys.findByHash(sctx, keyHash))?.userId, 'user-a');
    assert.equal(JSON.stringify(await repos.apiKeys.list(A)).includes(keyHash), false);
    await repos.apiKeys.revoke(A, k.id);
    assert.equal(await repos.system.apiKeys.findByHash(sctx, keyHash), null);
  });

  await check('D14', 'inventory: every named function exists; memory reinforcement adds a date once; job claim', async () => {
    const inv = {
      projects: 'upsert get byRoot list epochs bumpEpoch', sessions: 'upsert get list', history: 'upsert listByStatus setStatus',
      jobs: 'create get list oldestQueuedAgeS cancel', idempotency: 'lookup store', apiKeys: 'create list revoke',
      dedup: 'upsertPair listOpen setStatus',
      graph: 'replaceSource sourceNodeCount listSources loadGraph loadVectors getNode edgesOf searchLabels setEmbedding reviewEdge stats',
      library: 'listCapabilities get byName createVersion listVersions getVersion getVersionById manifest getBlob moveLabels setServed markRemoved upsertOverride clearOverride listOverrides upsertVector loadVectors',
      memory: 'nearest add reinforce rewrite supersede get getMany list patch softDelete recallLegs timeline touch insertSummary lastSummaries getSummary',
      runner: 'createRun getRun listRuns setRunStatus insertStep getStep listSteps transition setStepFields listSchedules upsertSchedule deleteSchedule',
    };
    const missing = Object.entries(inv).flatMap(([d, fs]) => fs.split(' ').filter((f) => typeof repos[d]?.[f] !== 'function').map((f) => `${d}.${f}`));
    assert.deepEqual(missing, []);
    const emb = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
    const m = await repos.memory.add(AP, { scope: 'global', kind: 'fact', text: `chk fact ${rnd()}`, embedding: emb });
    await repos.memory.reinforce(AP, m.id, '2026-01-02');
    await repos.memory.reinforce(AP, m.id, '2026-01-02');
    const got = await repos.memory.get(AP, m.id);
    assert.equal(got.reinforcementDates.filter((d) => String(d).startsWith('2026-01-02')).length, 1);
    const jid = crypto.randomUUID();
    await repos.jobs.create(A, { id: jid, queue: 'llm', kind: 'enrich', payload: {} });
    assert.equal(await repos.system.jobs.markRunning(sctx, jid), true);
    await repos.system.jobs.markDone(sctx, jid, { ok: true });
    assert.equal(await repos.system.jobs.markRunning(sctx, jid), false); // done jobs are not claimed again
  });

  await check('D15', 'timestamps come back as Date from the database clock', async () => {
    const j = await repos.jobs.create(A, { queue: 'llm', kind: 'enrich', payload: {} });
    assert.ok(j.job.createdAt instanceof Date);
    assert.ok(Math.abs(Date.now() - j.job.createdAt.getTime()) < 60_000);
  });

  await check('D16', 'generated id formats: project = sha256(root)[:8]; job = uuid', async () => {
    const root = `/chk/${rnd()}/ids`;
    const p = await repos.projects.upsert(A, { root });
    assert.equal(p.id, createHash('sha256').update(root).digest('hex').slice(0, 8));
    const j = await repos.jobs.create(A, { queue: 'llm', kind: 'enrich', payload: {} });
    assert.match(j.job.id, uuid4);
  });
} catch (e) {
  for (const id of IDS) if (!done.has(id)) bad(id, 'seed data created', `${e?.name}: ${String(e?.message).split('\n')[0]}`);
} finally {
  try { await db2?.close(); } catch { /* ignore */ }
  try { await db?.close(); } catch { /* ignore */ }
  try {
    const { Client } = require('pg');
    const c = new Client({ connectionString: url }); await c.connect();
    if (schema.startsWith('ctc_t13_chk_')) await c.query(`drop schema if exists ${schema} cascade`);
    await c.end();
  } catch { /* scratch cleanup is best effort; selfcheck.py also sweeps ctc_t13_* */ }
}
finish();
