// checks for T3.1 library scanner + `library` queue: one runnable example per decision id (D0..D21).
// Prints `PASS D# ...` or `FAIL D# expected=<..> got=<..>`; last line `CHECKS: <n> pass, <m> fail`; exit 1 on any FAIL.
// Needs: env CTC_SCRATCH_PG_URL (scratch Postgres 127.0.0.1:18304 only) and the T1.2 migrations. Run from the repo root:
//   node --import tsx agent/t3-1-scanner/checks.mjs      (tsx lets Node import the .ts sources)
// Fixture trees are written under os.tmpdir() and removed at the end; the real ~/.claude is never read.
// Scratch schema `ctc_t31chk_<random>`, dropped at the end. Fixture values are this file's own.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(new URL('../../', import.meta.url).pathname);
const CORE = 'packages/core/src/library/index.ts';
const WORKER = 'apps/worker/src/library/index.ts';
const REPOS = 'packages/shared/src/repositories/index.ts';
const ADMIN = 'packages/shared/src/repositories/admin/index.ts';
const GATE = 'apps/worker/src/library/library.version.test.ts';
const CASES = 'packages/shared/src/repositories/tenancy.cases.ts';
const IDS = Array.from({ length: 22 }, (_, i) => `D${i}`);
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
const enc = (s) => new TextEncoder().encode(s);
const sorted = (a) => [...a].sort();

// ---- load -----------------------------------------------------------------------------------------------------------
const url = process.env.CTC_SCRATCH_PG_URL;
if (!url) await failAll('env CTC_SCRATCH_PG_URL not set');
const pu = new URL(url);
if (pu.hostname !== '127.0.0.1' || pu.port !== '18304') await failAll(`refusing ${pu.hostname}:${pu.port}, only the scratch Postgres 127.0.0.1:18304`);
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
let C; let W; let R; let A;
for (const rel of [CORE, WORKER]) if (!fs.existsSync(path.join(ROOT, rel))) await failAll(`module not built: ${rel} is missing`);
try {
  C = await load(CORE); W = await load(WORKER); R = await load(REPOS); A = await load(ADMIN);
} catch (e) { await failAll(`module not importable: ${e?.code ?? e?.name}: ${String(e?.message).split('\n')[0]}`); }
const req = createRequire(path.join(ROOT, 'packages/shared/package.json'));
const { sql } = req('kysely');
const schema = `ctc_t31chk_${rnd()}`;
let db; let repos;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't31chk-'));
try {
  await A.migrate({ url, schema });
  db = R.createDb({ url, schema });
  repos = R.createRepositories(db);
} catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); await failAll(`scratch schema not built: ${e?.name}: ${e?.message}`); }
cleanup = async () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  try { await db.kysely.schema.dropSchema(schema).ifExists().cascade().execute(); } finally { await db.close(); }
};

// ---- fixtures ---------------------------------------------------------------------------------------------------------
let homes = 0;
const newHome = () => { const d = path.join(tmp, `h${++homes}`); fs.mkdirSync(d, { recursive: true }); return d; };
const put = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); return p; };
const skillMd = (name, desc, body = 'Body text\n') => `---\nname: ${name}\ndescription: ${desc}\n---\n${body}`;
const userCtx = () => ({ userId: `u-${rnd()}` });
const rootOf = (dir, namespace = 'user') => [{ path: dir, namespace }];
const scan = (ctx, roots, extra = {}) => W.scanLibrary({ repos, ctx, roots, ...extra });
const hctx = (signal) => ({ jobId: `j-${rnd()}`, attempt: 1, signal: signal ?? new AbortController().signal, setProgress: async () => {} });
const vecOf = (i) => Array.from({ length: 1024 }, (_, j) => (j === i ? 1 : 0));
const baseConfig = (home) => ({
  mode: 'local', claude_home: home, embed_model: 'chk-model', embed: { skillret_body_chars: 8000 },
  library: { roots: [home], default_label: 'production', dedup_cosine: 0.92, max_files: 200, max_bytes: 1048576 },
});
const bi = (defaultName, files, kind = 'skill', mainPath = 'SKILL.md') => ({
  kind, namespace: 'user', defaultName, rootPath: `/r/${defaultName}`, mainPath,
  files: files.map(([p, s]) => ({ path: p, bytes: typeof s === 'string' ? enc(s) : s })),
});
const capIdOf = (res, name) => res.created.find((c) => c.name === name)?.capId;
async function capOf(ctx, kind, name, namespace = 'user') { return repos.library.byName(ctx, { namespace, kind, name }); }
async function versionsOf(ctx, capId) { return [...(await repos.library.listVersions(ctx, capId))].sort((a, b) => a.version - b.version); }
async function manifestPaths(ctx, capId) {
  const vs = await versionsOf(ctx, capId);
  const latest = vs.find((v) => v.labels.includes('latest'));
  return sorted((await repos.library.manifest(ctx, latest.id)).map((m) => m.path));
}
const vectorsOf = async (ctx, capId) => (await repos.library.loadVectors(ctx)).filter((v) => v.capId === capId);
function deepFreeze(o) { if (o && typeof o === 'object' && !ArrayBuffer.isView(o) && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; }
const snapshot = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); const st = fs.lstatSync(p); out.push(`${p}|${st.size}|${st.mtimeMs}`); if (e.isDirectory()) walk(p); } };
  walk(dir); return out.sort();
};

try {
  await check('D0', 'public names exported; handlers keyed library.scan / library.changed; repos.library.pruneVectors exists', async () => {
    const want = {
      core: ['libraryLimits', 'NAME_RE', 'LABEL_RE', 'isName', 'isLabel', 'sha256Hex', 'parseFrontmatter', 'buildVersion', 'sameManifest', 'diffManifests', 'resolveServed', 'skillretText', 'cosine'],
      worker: ['discoverRoots', 'scanLibrary', 'libraryHandlers', 'watchLibrary'],
    };
    const missing = [...want.core.filter((n) => !(n in C)).map((n) => `core.${n}`), ...want.worker.filter((n) => !(n in W)).map((n) => `worker.${n}`)];
    assert.deepEqual(missing, []);
    assert.deepEqual(sorted(Object.keys(W.libraryHandlers({ repos, config: baseConfig(tmp) }))), ['library.changed', 'library.scan']);
    assert.equal(typeof repos.library.pruneVectors, 'function');
  });

  await check('D1', 'scan only for local/local mode; payload.roots ignored; outside symlink and dot/node_modules files never stored', async () => {
    const home = newHome();
    put(path.join(home, 'skills/d1-home/SKILL.md'), skillMd('d1-home', 'home skill'));
    const other = newHome();
    put(path.join(other, 'skills/d1-evil/SKILL.md'), skillMd('d1-evil', 'evil'));
    const dropped = (e) => e?.name === 'UnrecoverableError' && e?.message === 'dropped:scan_not_local';
    const H = W.libraryHandlers({ repos, config: baseConfig(home) });
    await assert.rejects(H['library.scan']({ userId: 'user-b' }, hctx()), dropped);
    assert.deepEqual((await repos.library.listCapabilities({ userId: 'user-b' }, { limit: 500 })).rows, []);
    const shared = W.libraryHandlers({ repos, config: { ...baseConfig(home), mode: 'shared' } });
    await assert.rejects(shared['library.scan']({ userId: 'local' }, hctx()), dropped);
    const res = await H['library.scan']({ userId: 'local', roots: [other] }, hctx());
    assert.deepEqual([res.created.some((c) => c.name === 'd1-home'), res.created.some((c) => c.name === 'd1-evil')], [true, false]);

    const h2 = newHome();
    const secret = put(path.join(tmp, 'outside-secret.txt'), 'secret');
    const dir = path.join(h2, 'skills/d1-link');
    put(path.join(dir, 'SKILL.md'), skillMd('d1-link', 'link'));
    put(path.join(dir, 'inside.md'), 'in');
    fs.symlinkSync(secret, path.join(dir, 'leak.md'));
    fs.symlinkSync(path.join(dir, 'inside.md'), path.join(dir, 'alias.md'));
    put(path.join(dir, '.env'), 'TOKEN=x');
    put(path.join(dir, '.git/config'), 'x');
    put(path.join(dir, 'node_modules/x.js'), 'x');
    put(path.join(dir, '__pycache__/x.pyc'), 'x');
    const ctx = userCtx();
    const r = await scan(ctx, rootOf(h2));
    assert.deepEqual(await manifestPaths(ctx, capIdOf(r, 'd1-link')), ['SKILL.md', 'alias.md', 'inside.md']);
    assert.deepEqual(r.warnings.map((w) => [w.code, w.path]), [['symlink_outside', path.join(dir, 'leak.md')]]);
  });

  await check('D2', 'limits pinned and read at call time; equal is valid, one more is skipped; limits argument overrides', async () => {
    assert.deepEqual({ ...C.libraryLimits }, { maxFiles: 200, maxBytes: 1048576, maxNameLen: 64, maxDescription: 1024, bodyChars: 8000 });
    const keep = { ...C.libraryLimits };
    try {
      C.libraryLimits.maxFiles = 3;
      const many = (n) => C.buildVersion(bi('d2', Array.from({ length: n }, (_, i) => (i === 0 ? ['SKILL.md', skillMd('d2', 'x')] : [`f${i}.md`, 'x']))));
      assert.deepEqual([many(3).ok, many(4).skip?.code], [true, 'too_many_files']);
      Object.assign(C.libraryLimits, keep);
      const main = skillMd('d2', 'x');
      C.libraryLimits.maxBytes = enc(main).length + 5;
      const sized = (n) => C.buildVersion(bi('d2', [['SKILL.md', main], ['pad.txt', 'p'.repeat(n)]]));
      assert.deepEqual([sized(5).ok, sized(6).skip?.code], [true, 'too_large']);
    } finally { Object.assign(C.libraryLimits, keep); }
    const named = (n) => C.buildVersion(bi('d2', [['SKILL.md', skillMd(n, 'x')]]));
    assert.deepEqual([named('a'.repeat(64)).ok, named('a'.repeat(65)).skip?.code], [true, 'bad_name']);
    const described = (n) => C.buildVersion(bi('d2', [['SKILL.md', skillMd('d2', 'd'.repeat(n))]]));
    assert.deepEqual([described(1024).ok, described(1025).skip?.code], [true, 'description_too_long']);
    const two = bi('d2', [['SKILL.md', skillMd('d2', 'x')], ['b.md', 'b']]);
    assert.equal(C.buildVersion(two, { ...C.libraryLimits, maxFiles: 1 }).skip?.code, 'too_many_files');
  });

  await check('D3', 'ScanResult / Skip / created / removed shapes; JSON-safe; skip path is the main file', async () => {
    const h = newHome();
    put(path.join(h, 'skills/d3-ok/SKILL.md'), skillMd('d3-ok', 'ok'));
    put(path.join(h, 'skills/d3-bad/SKILL.md'), '---\nname: d3-bad\ndescription: x: y: z\n---\n');
    put(path.join(h, 'agents/d3-agent.md'), skillMd('d3-agent', 'agent'));
    const ctx = userCtx();
    const r = await scan(ctx, rootOf(h));
    assert.deepEqual(sorted(Object.keys(r)), ['created', 'removed', 'roots', 'skipped', 'unchanged', 'warnings']);
    assert.deepEqual(r.roots, [{ path: h, namespace: 'user', walked: true }]);
    assert.deepEqual(sorted(Object.keys(r.created[0])), ['capId', 'kind', 'name', 'namespace', 'version']);
    assert.deepEqual(sorted(r.created.map((c) => `${c.namespace}/${c.kind}/${c.name}@${c.version}`)), ['user/agent/d3-agent@1', 'user/skill/d3-ok@1']);
    assert.equal(typeof r.unchanged, 'number');
    assert.deepEqual(r.skipped.map((s) => [sorted(Object.keys(s)), s.code, s.path, typeof s.message]),
      [[['code', 'message', 'path'], 'bad_yaml', path.join(h, 'skills/d3-bad/SKILL.md'), 'string']]);
    assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
    fs.rmSync(path.join(h, 'agents/d3-agent.md'));
    const r2 = await scan(ctx, rootOf(h));
    assert.deepEqual(r2.removed, [{ capId: capIdOf(r, 'd3-agent'), namespace: 'user', kind: 'agent', name: 'd3-agent' }]);
  });

  await check('D4', 'one bad capability never stops the scan; first failing check is the only code', async () => {
    const h = newHome();
    const sk = (dir, text, extra = {}) => { put(path.join(h, 'skills', dir, 'SKILL.md'), text); for (const [p, s] of Object.entries(extra)) put(path.join(h, 'skills', dir, p), s); };
    sk('d4-ok', skillMd('d4-ok', 'fine'));
    sk('d4-yaml', '---\nname: d4-yaml\ndescription: Use it. Triggers on: x\n---\n');
    sk('d4-many', '---\nname: [unclosed\n---\n', { 'a.md': 'a', 'b.md': 'b' });
    sk('d4-unclosed', '---\nname: d4-unclosed\ndescription: d\n');
    sk('d4-alias', '---\nname: d4-alias\ndescription: &d text\nother: *d\n---\n');
    sk('d4-list', '---\n- a\n- b\n---\n');
    sk('D4Upper', '---\ndescription: upper\n---\n');
    sk('d4-desc', skillMd('d4-desc', 'eleven char'));
    sk('d4-zdup', skillMd('d4-ok', 'dup'));
    const ctx = userCtx();
    const r = await scan(ctx, rootOf(h), { limits: { ...C.libraryLimits, maxFiles: 2, maxDescription: 10 } });
    assert.deepEqual(r.created.map((c) => c.name), ['d4-ok']);
    const codes = Object.fromEntries(r.skipped.map((s) => [path.basename(path.dirname(s.path)), s.code]));
    assert.deepEqual(codes, {
      'd4-yaml': 'bad_yaml', 'd4-many': 'too_many_files', 'd4-unclosed': 'bad_yaml', 'd4-alias': 'bad_yaml', 'd4-list': 'bad_yaml',
      D4Upper: 'bad_name', 'd4-desc': 'description_too_long', 'd4-zdup': 'duplicate_name',
    });
    assert.equal(r.skipped.length, 8);
  });

  await check('D5', 'no frontmatter, CRLF, BOM, empty header, non-string name/description, empty or missing roots are all valid', async () => {
    const h = newHome();
    put(path.join(h, 'agents/d5-plain.md'), 'Just text\n');
    put(path.join(h, 'skills/d5-crlf/SKILL.md'), '---\r\nname: d5-crlf\r\ndescription: crlf desc\r\n---\r\nBody\r\n');
    put(path.join(h, 'skills/d5-bom/SKILL.md'), '\uFEFF---\nname: d5-bom\ndescription: bom\n---\nB');
    put(path.join(h, 'skills/d5-empty/SKILL.md'), '---\n---\nbody');
    put(path.join(h, 'commands/d5-num.md'), '---\nname: 7\ndescription: [a, b]\n---\nx');
    const ctx = userCtx();
    const r = await scan(ctx, rootOf(h));
    assert.deepEqual(sorted(r.created.map((c) => c.name)), ['d5-bom', 'd5-crlf', 'd5-empty', 'd5-num', 'd5-plain']);
    assert.deepEqual(r.skipped, []);
    const desc = async (name) => {
      const v = (await versionsOf(ctx, capIdOf(r, name)))[0];
      return [v.description, v.frontmatter];
    };
    assert.deepEqual(await desc('d5-plain'), ['', {}]);
    assert.deepEqual((await desc('d5-crlf'))[0], 'crlf desc');
    assert.deepEqual((await desc('d5-bom'))[0], 'bom');
    assert.deepEqual(await desc('d5-empty'), ['', {}]);
    assert.deepEqual((await desc('d5-num'))[0], '');
    const again = await scan(ctx, rootOf(h));
    assert.deepEqual([again.created, again.unchanged, again.removed], [[], 5, []]);
    const missing = await scan(ctx, rootOf(path.join(h, 'nope')));
    assert.deepEqual(missing, { roots: [{ path: path.join(h, 'nope'), namespace: 'user', walked: false }], created: [], unchanged: 0, removed: [], skipped: [], warnings: [] });
    assert.deepEqual(await scan(ctx, []), { roots: [], created: [], unchanged: 0, removed: [], skipped: [], warnings: [] });
  });

  await check('D6', 'never writes under a root, never hard-deletes, never removes an unwalked or skipped capability, no symlink loop, frozen input', async () => {
    const frozen = deepFreeze(bi('d6', [['SKILL.md', skillMd('d6', 'x')], ['a.md', 'a']]));
    assert.equal(C.buildVersion(frozen).ok, true);
    assert.equal(C.resolveServed(deepFreeze([{ version: 1, labels: ['latest', 'production'] }])), 1);
    const h = newHome();
    put(path.join(h, 'agents/d6-a.md'), skillMd('d6-a', 'agent'));
    const loop = path.join(h, 'skills/d6-loop');
    put(path.join(loop, 'SKILL.md'), skillMd('d6-loop', 'loop'));
    fs.symlinkSync(loop, path.join(loop, 'self'));
    const ctx = userCtx();
    const before = snapshot(h);
    const r = await scan(ctx, rootOf(h));
    assert.deepEqual(snapshot(h), before);
    assert.deepEqual(await manifestPaths(ctx, capIdOf(r, 'd6-loop')), ['SKILL.md']);
    const agent = capIdOf(r, 'd6-a');
    fs.renameSync(h, `${h}-moved`);
    const unwalked = await scan(ctx, rootOf(h));
    assert.deepEqual([unwalked.removed, (await repos.library.get(ctx, agent)).removedAt], [[], null]);
    fs.renameSync(`${h}-moved`, h);
    put(path.join(h, 'agents/d6-a.md'), '---\nname: d6-a\ndescription: broken: yaml: here\n---\n');
    const skipped = await scan(ctx, rootOf(h));
    assert.deepEqual([skipped.skipped.map((s) => s.code), skipped.removed, (await repos.library.get(ctx, agent)).removedAt], [['bad_yaml'], [], null]);
    fs.rmSync(path.join(h, 'agents/d6-a.md'));
    const gone = await scan(ctx, rootOf(h));
    assert.deepEqual(gone.removed.map((x) => x.capId), [agent]);
    assert.notEqual((await repos.library.get(ctx, agent)).removedAt, null);
    assert.equal((await versionsOf(ctx, agent)).length, 1);
  });

  await check('D7', 'non-goals: only library.changed is submitted, no jobs rows, no graph rows', async () => {
    const h = newHome();
    put(path.join(h, 'skills/d7-s/SKILL.md'), skillMd('d7-s', 'seven'));
    const ctx = userCtx();
    const calls = [];
    const r = await scan(ctx, rootOf(h), { submit: async (x) => { calls.push(x); return { id: x.id, created: true, enqueued: true }; } });
    const H = W.libraryHandlers({ repos, config: baseConfig(h), embed: async (t) => t.map(() => vecOf(7)) });
    await H['library.changed']({ userId: ctx.userId, capId: capIdOf(r, 'd7-s'), version: 1 }, hctx());
    assert.deepEqual(calls.map((c) => `${c.queue}.${c.kind}`), ['library.changed']);
    assert.deepEqual((await repos.jobs.list(ctx, {})).rows, []);
    const n = await sql`select (select count(*) from graph_nodes)::int + (select count(*) from graph_edges)::int as n`.execute(db.kysely);
    assert.equal(n.rows[0].n, 0);
  });

  await check('D8', 'silence rule: at least one `judgment:` comment in the module directories', async () => {
    const files = ['packages/core/src/library', 'apps/worker/src/library'].flatMap((d) => fs.readdirSync(path.join(ROOT, d), { recursive: true })
      .filter((f) => String(f).endsWith('.ts') && !String(f).endsWith('.test.ts')).map((f) => path.join(ROOT, d, String(f))));
    assert.equal(files.some((f) => /judgment:/.test(fs.readFileSync(f, 'utf8'))), true);
  });

  await check('D9', 'core library is pure (no I/O imports); yaml 2.9.1 dependency; NAME_RE / LABEL_RE as the spec', async () => {
    const dir = path.join(ROOT, 'packages/core/src/library');
    const src = fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.ts') && !String(f).endsWith('.test.ts'))
      .map((f) => fs.readFileSync(path.join(dir, String(f)), 'utf8')).join('\n');
    const io = src.match(/from\s+['"](node:)?(fs|fs\/promises|net|child_process|http|https|pg|kysely|ioredis|bullmq)['"]/g) ?? [];
    assert.deepEqual(io, []);
    assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/core/package.json'), 'utf8')).dependencies?.yaml, '2.9.1');
    assert.deepEqual([String(C.NAME_RE), String(C.LABEL_RE)], [String(/^[a-z0-9]+(-[a-z0-9]+)*$/), String(/^[a-z0-9_\-.]{1,36}$/)]);
    assert.deepEqual([C.isName('tdd-x'), C.isName('Tdd'), C.isName('a--b'), C.isLabel('v1.2_rc-1'), C.isLabel('a'.repeat(37)), C.isLabel('Prod')],
      [true, false, false, true, false, false]);
  });

  await check('D10', 'discoverRoots: user, root@<hash8>, plugin roots sorted by key, deduped; v1 shape; bad json ignored', async () => {
    const h = newHome(); const extra = newHome();
    const p1 = path.join(tmp, 'plug-z'); const p2 = path.join(tmp, 'plug-a');
    fs.mkdirSync(p1, { recursive: true }); fs.mkdirSync(p2, { recursive: true });
    put(path.join(h, 'plugins/installed_plugins.json'), JSON.stringify({
      version: 2, plugins: { 'zeta@mk': [{ installPath: p1 }], 'alpha@mk': [{ installPath: p2 }, { installPath: p2 }], 'bad@mk': [{ nope: 1 }] },
    }));
    assert.deepEqual(await W.discoverRoots({ claudeHome: h, roots: [h, extra, h] }), [
      { path: h, namespace: 'user' }, { path: extra, namespace: `root@${sha(path.resolve(extra)).slice(0, 8)}` },
      { path: p2, namespace: 'alpha' }, { path: p1, namespace: 'zeta' },
    ]);
    const h2 = newHome();
    put(path.join(h2, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'solo@m': { installPath: p1 } } }));
    assert.deepEqual(await W.discoverRoots({ claudeHome: h2, roots: [h2] }), [{ path: h2, namespace: 'user' }, { path: p1, namespace: 'solo' }]);
    const h3 = newHome();
    put(path.join(h3, 'plugins/installed_plugins.json'), '{not json');
    assert.deepEqual(await W.discoverRoots({ claudeHome: h3, roots: [h3] }), [{ path: h3, namespace: 'user' }]);
  });

  await check('D11', 'layout per kind: globs, names, rootPath, manifest paths, symlinked skill dir, duplicate workflow name', async () => {
    const h = newHome();
    put(path.join(h, 'skills/d11-multi/SKILL.md'), skillMd('d11-multi', 'multi'));
    put(path.join(h, 'skills/d11-multi/refs/a.md'), 'a');
    put(path.join(h, 'skills/d11-multi/scripts/run.sh'), 'echo');
    put(path.join(h, 'skills/d11-dir/SKILL.md'), skillMd('d11-renamed', 'renamed'));
    put(path.join(h, 'skills/d11-nosk/README.md'), 'no skill');
    const elsewhere = path.join(tmp, 'elsewhere/linked');
    put(path.join(elsewhere, 'SKILL.md'), skillMd('d11-linked', 'linked'));
    fs.symlinkSync(elsewhere, path.join(h, 'skills/d11-linked'));
    put(path.join(h, 'agents/d11-agent.md'), skillMd('d11-agent', 'agent'));
    put(path.join(h, 'agents/sub/d11-deep.md'), skillMd('d11-deep', 'deep'));
    put(path.join(h, 'commands/d11-cmd.md'), skillMd('d11-cmd', 'cmd'));
    put(path.join(h, 'ctc-workflows/d11-wf.yaml'), 'name: d11-wf\ndescription: wf\nnodes: []\n');
    put(path.join(h, 'workflows/d11-wf.md'), skillMd('d11-wf', 'dup'));
    put(path.join(h, 'workflows/d11-wf2.json'), '{"name":"d11-wf2","description":"j","nodes":[]}');
    const ctx = userCtx();
    const r = await scan(ctx, rootOf(h));
    assert.deepEqual(sorted(r.created.map((c) => `${c.kind}:${c.name}`)),
      ['agent:d11-agent', 'command:d11-cmd', 'skill:d11-linked', 'skill:d11-multi', 'skill:d11-renamed', 'workflow:d11-wf', 'workflow:d11-wf2']);
    assert.deepEqual(r.skipped.map((s) => [s.code, s.path]), [['duplicate_name', path.join(h, 'workflows/d11-wf.md')]]);
    assert.deepEqual(await manifestPaths(ctx, capIdOf(r, 'd11-multi')), ['SKILL.md', 'refs/a.md', 'scripts/run.sh']);
    assert.deepEqual(await manifestPaths(ctx, capIdOf(r, 'd11-agent')), ['d11-agent.md']);
    const root = async (kind, name) => (await capOf(ctx, kind, name)).rootPath;
    assert.deepEqual([await root('skill', 'd11-multi'), await root('skill', 'd11-linked'), await root('agent', 'd11-agent'), await root('workflow', 'd11-wf')],
      [path.join(h, 'skills/d11-multi'), path.join(h, 'skills/d11-linked'), path.join(h, 'agents'), path.join(h, 'ctc-workflows')]);
    const wf = (await versionsOf(ctx, capIdOf(r, 'd11-wf')))[0];
    assert.deepEqual([wf.description, wf.frontmatter], ['wf', { name: 'd11-wf', description: 'wf', nodes: [] }]);
  });

  await check('D12', 'parseFrontmatter: header, body, BOM, CRLF, empty header, EOF close; alias, duplicate key, unclosed, list = bad_yaml', async () => {
    const P = C.parseFrontmatter;
    assert.deepEqual(P('---\nname: x\ndescription: d\n---\nBody\n'), { ok: true, frontmatter: { name: 'x', description: 'd' }, body: 'Body\n' });
    assert.deepEqual(P('plain'), { ok: true, frontmatter: {}, body: 'plain' });
    assert.deepEqual(P('\uFEFF---\na: 1\n---\nB'), { ok: true, frontmatter: { a: 1 }, body: 'B' });
    assert.deepEqual(P('---\r\na: 1\r\n---\r\nB\r\n'), { ok: true, frontmatter: { a: 1 }, body: 'B\r\n' });
    assert.deepEqual(P('---\n---\nB'), { ok: true, frontmatter: {}, body: 'B' });
    assert.deepEqual(P('---\na: 1\n---'), { ok: true, frontmatter: { a: 1 }, body: '' });
    for (const t of ['---\na: &x 1\nb: *x\n---\n', '---\na: 1\na: 2\n---\n', '---\na: 1\n', '---\n- a\n---\n', '---\njust a scalar\n---\n']) {
      const got = P(t);
      assert.deepEqual([got.ok, got.code, typeof got.message], [false, 'bad_yaml', 'string'], JSON.stringify(t));
    }
    const r = C.buildVersion(bi('d12-default', [['SKILL.md', '---\ndescription: "  spaced  "\nname: "  "\n---\n']]));
    assert.deepEqual([r.input?.name, r.input?.description], ['d12-default', 'spaced']);
  });

  await check('D13', 'blob hash = sha256 of bytes, content round-trips (BOM kept), binary left out, bodyHash, manifest equality and diff', async () => {
    const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...enc('hi')]);
    const bin = Uint8Array.from([0x00, 0x01]);
    const badUtf8 = Uint8Array.from([0xff, 0xfe, 0x41]);
    const main = skillMd('d13', 'desc13', 'Body13\n');
    const r = C.buildVersion(bi('d13', [['SKILL.md', main], ['bom.txt', bom], ['bin.dat', bin], ['bad.txt', badUtf8], ['dup.txt', 'hi2'], ['dup2.txt', 'hi2']]));
    assert.equal(r.ok, true);
    const i = r.input;
    assert.deepEqual([i.namespace, i.kind, i.name, i.rootPath, i.description, i.bodyHash, i.frontmatter],
      ['user', 'skill', 'd13', '/r/d13', 'desc13', sha('Body13\n'), { name: 'd13', description: 'desc13' }]);
    assert.deepEqual(sorted(i.files.map((f) => `${f.path}=${f.blobHash}`)),
      sorted([`SKILL.md=${sha(main)}`, `bom.txt=${sha(bom)}`, `dup.txt=${sha('hi2')}`, `dup2.txt=${sha('hi2')}`]));
    assert.equal(i.blobs.length, 3);
    for (const b of i.blobs) assert.deepEqual([sha(Buffer.from(b.content, 'utf8')), Buffer.byteLength(b.content, 'utf8')], [b.hash, b.size]);
    assert.deepEqual(sorted(r.warnings.map((w) => `${w.code} ${w.path}`)), ['binary_file /r/d13/bad.txt', 'binary_file /r/d13/bin.dat']);
    assert.equal(C.buildVersion(bi('d13-b', [['SKILL.md', bin]])).skip?.code, 'unreadable');
    const wfText = 'name: d13-wf\ndescription: w\n';
    const wf = C.buildVersion(bi('d13-wf', [['d13-wf.yaml', wfText]], 'workflow', 'd13-wf.yaml'));
    assert.deepEqual([wf.input?.frontmatter, wf.input?.bodyHash], [{ name: 'd13-wf', description: 'w' }, sha(wfText)]);
    const m = [{ path: 'a', blobHash: '1' }, { path: 'b', blobHash: '2' }];
    assert.deepEqual([C.sameManifest(m, [...m].reverse()), C.sameManifest(m, [m[0], { path: 'b', blobHash: '3' }]), C.sameManifest(m, [...m, { path: 'c', blobHash: '4' }])],
      [true, false, false]);
    assert.deepEqual(C.diffManifests([{ path: 'a', blobHash: '1' }, { path: 'b', blobHash: '2' }, { path: 'c', blobHash: '3' }], [{ path: 'd', blobHash: '4' }, { path: 'b', blobHash: '9' }, { path: 'a', blobHash: '1' }]),
      { added: ['d'], removed: ['c'], changed: ['b'] });
    assert.equal(C.sha256Hex('x'), sha('x'));
  });

  await check('D14', 'scan: unchanged writes nothing, edit = n+1 + latest moved + changed submitted with a fixed id, removal + inval, return un-removes', async () => {
    const h = newHome();
    put(path.join(h, 'skills/d14-s/SKILL.md'), skillMd('d14-s', 'fourteen'));
    put(path.join(h, 'skills/d14-s/ref.md'), 'v1');
    put(path.join(h, 'agents/d14-a.md'), skillMd('d14-a', 'agent'));
    const ctx = userCtx();
    const calls = []; const pubs = [];
    const deps = { submit: async (x) => { calls.push(x); return { id: x.id, created: true, enqueued: true }; }, cache: { publishInval: async (m) => { pubs.push(m); } } };
    const r1 = await scan(ctx, rootOf(h), deps);
    const s = capIdOf(r1, 'd14-s'); const a = capIdOf(r1, 'd14-a');
    assert.deepEqual(sorted(calls.map((c) => c.id)), sorted([`library.changed:${s}:1`, `library.changed:${a}:1`]));
    assert.deepEqual(calls.find((c) => c.payload.capId === s), { queue: 'library', kind: 'changed', payload: { userId: ctx.userId, capId: s, version: 1 }, id: `library.changed:${s}:1` });
    const r2 = await scan(ctx, rootOf(h), deps);
    assert.deepEqual([r2.created, r2.unchanged, calls.length, pubs.length], [[], 2, 2, 0]);
    put(path.join(h, 'skills/d14-s/ref.md'), 'v2');
    const r3 = await scan(ctx, rootOf(h), deps);
    assert.deepEqual(r3.created.map((c) => [c.name, c.version]), [['d14-s', 2]]);
    const vs = await versionsOf(ctx, s);
    assert.deepEqual(vs.map((v) => [v.version, sorted(v.labels), v.commitMessage]), [[1, ['production'], 'scan'], [2, ['latest'], 'scan']]);
    assert.equal(calls.at(-1).id, `library.changed:${s}:2`);
    const agentText = fs.readFileSync(path.join(h, 'agents/d14-a.md'), 'utf8');
    fs.rmSync(path.join(h, 'agents/d14-a.md'));
    const r4 = await scan(ctx, rootOf(h), deps);
    assert.deepEqual(r4.removed, [{ capId: a, namespace: 'user', kind: 'agent', name: 'd14-a' }]);
    assert.deepEqual(pubs, [{ v: 1, event: 'library.changed', userId: ctx.userId }]);
    put(path.join(h, 'agents/d14-a.md'), agentText);
    const r5 = await scan(ctx, rootOf(h), deps);
    assert.deepEqual([r5.created, (await repos.library.get(ctx, a)).removedAt, (await versionsOf(ctx, a)).length], [[], null, 1]);
    assert.equal(calls.filter((c) => c.payload.capId === a).length, 2);
    put(path.join(h, 'skills/d14-s/ref.md'), 'v3');
    const r6 = await scan(ctx, rootOf(h), { submit: async () => { throw new Error('redis down'); } });
    assert.deepEqual(r6.created.map((c) => [c.name, c.version]), [['d14-s', 3]]);
  });

  await check('D15', 'parallel scans: one new version per change, no gap, one created entry in total', async () => {
    const h = newHome();
    put(path.join(h, 'skills/d15-s/SKILL.md'), skillMd('d15-s', 'fifteen'));
    put(path.join(h, 'skills/d15-s/ref.md'), 'v1');
    const ctx = userCtx();
    const r0 = await scan(ctx, rootOf(h));
    const s = capIdOf(r0, 'd15-s');
    put(path.join(h, 'skills/d15-s/ref.md'), 'v2');
    const rs = await Promise.all([1, 2, 3, 4].map(() => scan(ctx, rootOf(h))));
    assert.deepEqual([rs.flatMap((r) => r.created).length, (await versionsOf(ctx, s)).map((v) => v.version)], [1, [1, 2]]);
    const h2 = newHome();
    for (const n of ['d15-a', 'd15-b', 'd15-c']) put(path.join(h2, 'skills', n, 'SKILL.md'), skillMd(n, n));
    const ctx2 = userCtx();
    const fresh = await Promise.all([1, 2, 3, 4, 5].map(() => scan(ctx2, rootOf(h2))));
    assert.equal(fresh.flatMap((r) => r.created).length, 3);
    for (const n of ['d15-a', 'd15-b', 'd15-c']) assert.deepEqual((await versionsOf(ctx2, (await capOf(ctx2, 'skill', n)).id)).map((v) => v.version), [1], n);
  });

  await check('D16', 'resolveServed: block, pin version, pin label, default label, latest, highest, dangling pin falls through', async () => {
    const vs = [{ version: 1, labels: ['production'] }, { version: 2, labels: ['staging'] }, { version: 3, labels: ['latest'] }];
    const S = C.resolveServed;
    assert.deepEqual([
      S(vs), S(vs, { defaultLabel: 'staging' }), S(vs, { override: { action: 'pin', version: 3 } }), S(vs, { override: { action: 'pin', label: 'staging' } }),
      S(vs, { override: { action: 'pin', version: 9 } }), S(vs, { override: { action: 'pin', label: 'nope' } }), S(vs, { override: { action: 'block' } }),
      S([{ version: 1, labels: [] }, { version: 2, labels: ['latest'] }]), S([{ version: 1, labels: [] }, { version: 4, labels: [] }]), S([]),
      S(vs, { override: null }),
    ], [1, 2, 3, 2, 1, 1, null, 2, 4, null, 1]);
  });

  await check('D17', 'changed: sets servedVersion, embeds the served SKILLRET text once, prunes old vectors, writes dedup pairs, publishes inval', async () => {
    const h = newHome();
    put(path.join(h, 'skills/d17-a/SKILL.md'), skillMd('d17-a', 'alpha', 'Body A\n'));
    put(path.join(h, 'skills/d17-b/SKILL.md'), skillMd('d17-b', 'beta', 'Body B\n'));
    const ctx = userCtx();
    const r = await scan(ctx, rootOf(h));
    const a = capIdOf(r, 'd17-a'); const b = capIdOf(r, 'd17-b');
    const texts = []; const pubs = [];
    const embed = async (t) => { texts.push(...t); return t.map(() => vecOf(17)); };
    const H = W.libraryHandlers({ repos, config: baseConfig(h), embed, cache: { publishInval: async (m) => { pubs.push(m); } } });
    const changed = (capId, version = 1) => H['library.changed']({ userId: ctx.userId, capId, version }, hctx());
    assert.deepEqual(await changed(a), { capId: a, servedVersion: 1, embedded: true, dedup: 0 });
    assert.deepEqual(texts, ['d17-a | alpha | Body A\n']);
    assert.equal((await repos.library.get(ctx, a)).servedVersion, 1);
    assert.deepEqual((await vectorsOf(ctx, a)).map((v) => v.textHash), [sha(texts[0])]);
    assert.deepEqual(await changed(b), { capId: b, servedVersion: 1, embedded: true, dedup: 1 });
    const pairs = (await repos.dedup.listOpen(ctx, {})).rows;
    assert.deepEqual([pairs.length, sorted([pairs[0].a, pairs[0].b]), pairs[0].similarity > 0.99], [1, sorted([a, b]), true]);
    assert.deepEqual(await changed(a), { capId: a, servedVersion: 1, embedded: false, dedup: 1 });
    put(path.join(h, 'skills/d17-a/SKILL.md'), skillMd('d17-a', 'alpha', 'Body A2\n'));
    await scan(ctx, rootOf(h));
    assert.deepEqual(await changed(a, 2), { capId: a, servedVersion: 1, embedded: false, dedup: 1 });
    await repos.library.moveLabels(ctx, { capId: a, version: 2, labels: ['production'] });
    assert.deepEqual(await changed(a, 2), { capId: a, servedVersion: 2, embedded: true, dedup: 1 });
    assert.deepEqual((await vectorsOf(ctx, a)).map((v) => v.textHash), [sha('d17-a | alpha | Body A2\n')]);
    assert.deepEqual(pubs, Array.from({ length: 5 }, () => ({ v: 1, event: 'library.changed', userId: ctx.userId })));
    put(path.join(h, 'skills/d17-c/SKILL.md'), skillMd('d17-c', 'gamma', 'abcdef'));
    const rc = await scan(ctx, rootOf(h));
    const cfg = baseConfig(h); cfg.embed.skillret_body_chars = 3;
    await W.libraryHandlers({ repos, config: cfg, embed })['library.changed']({ userId: ctx.userId, capId: capIdOf(rc, 'd17-c'), version: 1 }, hctx());
    assert.equal(texts.at(-1), 'd17-c | gamma | abc');
    const broken = W.libraryHandlers({ repos, config: baseConfig(h), embed: async () => { throw new Error('tei down'); } });
    put(path.join(h, 'skills/d17-b/SKILL.md'), skillMd('d17-b', 'beta', 'Body B2\n'));
    await scan(ctx, rootOf(h));
    await repos.library.moveLabels(ctx, { capId: b, version: 2, labels: ['production'] });
    const beforeB = await vectorsOf(ctx, b);
    await assert.rejects(broken['library.changed']({ userId: ctx.userId, capId: b, version: 2 }, hctx()), /tei down/);
    assert.deepEqual(await vectorsOf(ctx, b), beforeB);
    const ghost = randomUUID();
    assert.deepEqual(await changed(ghost), { capId: ghost, skipped: 'not_found' });
    fs.rmSync(path.join(h, 'skills/d17-b'), { recursive: true });
    await scan(ctx, rootOf(h));
    assert.deepEqual(await changed(b, 2), { capId: b, skipped: 'removed' });
  });

  await check('D18', 'scan handler: discovered roots, config limits read at call time, AbortSignal honoured', async () => {
    const h = newHome();
    put(path.join(h, 'skills/d18-s/SKILL.md'), skillMd('d18-s', 'eighteen'));
    put(path.join(h, 'skills/d18-s/a.md'), 'a');
    put(path.join(h, 'skills/d18-s/b.md'), 'b');
    const cfg = baseConfig(h); cfg.library.max_files = 2;
    const H = W.libraryHandlers({ repos, config: cfg });
    const r1 = await H['library.scan']({ userId: 'local' }, hctx());
    assert.deepEqual([r1.roots, r1.skipped.map((s) => s.code)], [[{ path: h, namespace: 'user', walked: true }], ['too_many_files']]);
    cfg.library.max_files = 200;
    const r2 = await H['library.scan']({ userId: 'local' }, hctx());
    assert.deepEqual(r2.created.map((c) => c.name), ['d18-s']);
    put(path.join(h, 'skills/d18-t/SKILL.md'), skillMd('d18-t', 'abort'));
    const ac = new AbortController(); ac.abort(new Error('stop'));
    await assert.rejects(H['library.scan']({ userId: 'local' }, hctx(ac.signal)));
    assert.equal(await capOf({ userId: 'local' }, 'skill', 'd18-t'), null);
  });

  await check('D19', 'pruneVectors keeps one text hash, is ctx-scoped, and has a tenancy case', async () => {
    const ca = userCtx(); const cb = userCtx();
    const { version } = await repos.library.createVersion(ca, {
      namespace: 'user', kind: 'skill', name: 'd19', rootPath: '/x/d19', description: '', bodyHash: 'b',
      blobs: [{ hash: 'h19', content: 'c', size: 1 }], files: [{ path: 'SKILL.md', blobHash: 'h19' }],
    });
    for (const t of ['t1', 't2', 't3']) await repos.library.upsertVector(ca, { capId: version.capId, textHash: t, embedding: vecOf(19) });
    assert.equal(await repos.library.pruneVectors(cb, version.capId, 't1'), 0);
    assert.equal((await vectorsOf(ca, version.capId)).length, 3);
    assert.equal(await repos.library.pruneVectors(ca, version.capId, 't1'), 2);
    assert.deepEqual((await vectorsOf(ca, version.capId)).map((v) => v.textHash), ['t1']);
    assert.equal(await repos.library.pruneVectors(ca, 'not-a-uuid', 't1'), 0);
    assert.match(fs.readFileSync(path.join(ROOT, CASES), 'utf8'), /\bpruneVectors\s*:/);
  });

  await check('D20', 'watchLibrary: one debounced call per burst, ignored paths, missing root tolerated, close stops it, onChange errors contained', async () => {
    const d = newHome(); let calls = 0;
    const w = W.watchLibrary({ roots: [d, path.join(d, 'missing')], onChange: () => { calls++; }, debounceMs: 300 });
    await sleep(150);
    put(path.join(d, 'skills/x/SKILL.md'), 'a'); put(path.join(d, 'skills/x/b.md'), 'b'); put(path.join(d, 'agents/y.md'), 'c');
    await sleep(1200);
    assert.equal(calls, 1);
    put(path.join(d, '.git/HEAD'), 'x'); put(path.join(d, 'skills/x/node_modules/z.js'), 'z');
    await sleep(900);
    assert.equal(calls, 1);
    w.close(); w.close();
    put(path.join(d, 'agents/z.md'), 'z');
    await sleep(900);
    assert.equal(calls, 1);
    const w2 = W.watchLibrary({ roots: [d], onChange: async () => { throw new Error('boom'); }, debounceMs: 100 });
    await sleep(150);
    put(path.join(d, 'agents/w.md'), 'w');
    await sleep(700);
    w2.close();
    assert.deepEqual(unhandled.map(String), []);
  });

  await check('D21', 'gate test file: describe library.version with the three named tests on a ctc_t31_ scratch schema', async () => {
    const f = path.join(ROOT, GATE);
    assert.equal(fs.existsSync(f), true, GATE);
    const src = fs.readFileSync(f, 'utf8');
    const has = (name) => new RegExp(`\\b(it|test)\\(\\s*['"\`]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(src);
    assert.deepEqual([/describe\(\s*['"`]library\.version['"`]/.test(src), has('file hash change → version n+1 with latest'),
      has('label moves are exclusive'), has('parallel scans make no duplicate version'), /ctc_t31_/.test(src)], [true, true, true, true, true]);
  });
} finally {
  await finish();
}
