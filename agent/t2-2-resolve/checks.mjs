// checks for T2.2 resolve, incremental rebuild, shrink guard, `graph` queue: one runnable example per decision id (D0..D24).
// Prints `PASS D# ...` or `FAIL D# expected=<..> got=<..>`; last line `CHECKS: <n> pass, <m> fail`; exit 1 on any FAIL.
// Needs: env CTC_SCRATCH_PG_URL (scratch Postgres 127.0.0.1:18304 only), the T1.2 migrations, T2.1's grammars. Run from the repo root:
//   node --import tsx agent/t2-2-resolve/checks.mjs      (tsx lets Node import the .ts sources)
// Fixture projects are temp directories under os.tmpdir(), removed at the end; this repository and ~/.claude are never indexed.
// Scratch schema `ctc_t22chk_<random>`, dropped at the end. Fixture values are this file's own.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(new URL('../../', import.meta.url).pathname);
const CORE = 'packages/core/src/graph/index.ts';
const WORKER = 'apps/worker/src/graph/index.ts';
const REPOS = 'packages/shared/src/repositories/index.ts';
const ADMIN = 'packages/shared/src/repositories/admin/index.ts';
const GATE_RESOLVE = 'packages/core/src/graph/graph.resolve.test.ts';
const GATE_INCR = 'apps/worker/src/graph/graph.incremental.test.ts';
const CASES = 'packages/shared/src/repositories/tenancy.cases.ts';
// T2.1's files in packages/core/src/graph: everything else there is this task's (D24 purity check).
const T21_FILES = ['bash.ts', 'build.ts', 'extract.ts', 'grammars.ts', 'ids.ts', 'index.ts', 'json.ts', 'markdown.ts', 'python.ts', 'sql.ts', 'tsjs.ts', 'types.ts'];
const IDS = Array.from({ length: 25 }, (_, i) => `D${i}`);
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
const rnd = () => randomBytes(4).toString('hex');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const sorted = (a) => [...a].sort();
const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

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
if (typeof C.resolveGraph !== 'function' || typeof W.rebuildProject !== 'function') await failAll('module not built: resolveGraph / rebuildProject missing');
const req = createRequire(path.join(ROOT, 'packages/shared/package.json'));
const { sql } = req('kysely');
let grammars;
try { grammars = await C.loadGrammars(); } catch (e) { await failAll(`grammars not loadable: ${e?.name}: ${e?.message}`); }
const schema = `ctc_t22chk_${rnd()}`;
let db; let repos;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t22chk-'));
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
const LANGS = ['ts', 'tsx', 'js', 'python', 'bash', 'sql', 'json', 'markdown'];
const cfg = (o = {}) => ({ mode: 'local', graph: { languages: LANGS, shrink_guard: 0.2, debounce_s: 3, ...o } });
const fid = (p) => `code:${C.makeId(C.fileStem(p))}`;
const sid = (p, ...names) => `code:${C.makeId(C.fileStem(p), ...names)}`;
const put = (root, rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
let dirs = 0;
/** A temp project with `files` ({rel: text}) and a projects row; userId 'local' so the handler accepts it. */
async function project(files = {}, userId = 'local') {
  const root = path.join(tmp, `p${++dirs}`);
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, text] of Object.entries(files)) put(root, rel, text);
  const p = await repos.projects.upsert({ userId }, { root });
  return { root, ctx: { userId, projectId: p.id }, put: (rel, text) => put(root, rel, text) };
}
const rebuild = (pr, o = {}) => W.rebuildProject({ repos, ctx: pr.ctx, root: pr.root, config: cfg(), grammars, ...o });
const hctx = (o = {}) => ({ jobId: `j-${rnd()}`, attempt: 1, signal: new AbortController().signal, setProgress: async () => {}, ...o });
const handler = (o = {}) => W.graphHandlers({ repos, config: cfg(), grammars, ...o })['graph.rebuild'];
const ex = (p, content) => C.extractFile({ path: p, content }, grammars);
const resolve = (srcs, o = {}) => {
  const results = Object.entries(srcs).map(([p, s]) => ex(p, s));
  return C.resolveGraph({ results, context: [], files: sorted([...Object.keys(srcs), ...(o.files ?? [])]), packages: o.packages ?? [], ...o.input });
};
const allEdges = (out) => Object.values(out.edges).flat();
const from = (out, src, rel) => allEdges(out).filter((e) => e.src === src && (!rel || e.relation === rel)).map((e) => [e.dst, e.relation, e.confidence, e.score]).sort((a, b) => byCode(a[0], b[0]));
const fns = (n, body = '') => Array.from({ length: n }, (_, i) => `export function f${i}() { ${body} }`).join('\n') + '\n';
const dropped = (code) => (e) => e?.name === 'UnrecoverableError' && e?.message === `dropped:${code}`;
const vec = () => Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; }
const snapshot = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); const st = fs.lstatSync(p); out.push(`${p}|${st.size}|${st.mtimeMs}`); if (e.isDirectory()) walk(p); } };
  walk(dir); return out.sort();
};
const nodesOf = async (ctx, file) => (await repos.graph.loadGraph(ctx)).nodes.filter((n) => n.sourceFile === file);
const sources = async (ctx) => (await repos.graph.listSources(ctx)).map((s) => s.file);
const withLimits = async (obj, patch, fn) => { const keep = { ...obj }; Object.assign(obj, patch); try { return await fn(); } finally { Object.assign(obj, keep); } };

const MAIN = {
  'src/a.ts': "import { helper } from './b.ts';\nimport * as u from './util.ts';\nimport fs from 'node:fs';\nimport { f2 } from './b.ts';\nexport function main() { helper(); u.fmt(); fs.readFileSync('x'); f2(); }\n",
  'src/b.ts': "export function helper() { return 1; }\nexport { fmt as f2 } from './util.ts';\n",
  'src/util.ts': 'export function fmt() { return 2; }\n',
};

try {
  await check('D0', 'public names exported; handler map has graph.rebuild; repos.graph has deleteSource and pendingEmbeddings', async () => {
    const want = { core: ['resolveGraph', 'contentHash', 'resolveLimits', 'SCORES'], worker: ['graphHandlers', 'rebuildProject', 'walkProject', 'graphLimits', 'PACKAGES_SOURCE'] };
    const missing = [...want.core.filter((n) => !(n in C)).map((n) => `core.${n}`), ...want.worker.filter((n) => !(n in W)).map((n) => `worker.${n}`)];
    assert.deepEqual(missing, []);
    assert.equal(W.PACKAGES_SOURCE, '<packages>');
    assert.equal(typeof handler(), 'function');
    assert.deepEqual([typeof repos.graph.deleteSource, typeof repos.graph.pendingEmbeddings], ['function', 'function']);
  });

  await check('D1', 'not local → dropped:rebuild_not_local before reading; bad payload paths skipped bad_path; outside symlinks never read', async () => {
    const pr = await project({ 'ok.ts': 'export function ok() {}\n' });
    await assert.rejects(W.graphHandlers({ repos, config: { ...cfg(), mode: 'shared' }, grammars })['graph.rebuild']({ userId: 'local', projectId: pr.ctx.projectId }, hctx()), dropped('rebuild_not_local'));
    await assert.rejects(handler()({ userId: 'user-b', projectId: pr.ctx.projectId }, hctx()), dropped('rebuild_not_local'));
    assert.deepEqual(await sources(pr.ctx), []);
    const badPaths = ['../x.ts', '/etc/passwd', 'a/./b.ts', 'a\\b.ts', 'a//b.ts', 'x\u0000.ts', ''];
    const r = await rebuild(pr, { files: [...badPaths, 'ok.ts'] });
    assert.deepEqual(sorted(r.files.skipped.filter((s) => s.reason === 'bad_path').map((s) => s.file)), sorted(badPaths));
    assert.deepEqual(r.files.written, ['ok.ts']);
    const outside = put(tmp, 'outside-secret.ts', 'export function stolen() {}\n');
    fs.symlinkSync(outside, path.join(pr.root, 'leak.ts'));
    const w = await W.walkProject(pr.root);
    assert.deepEqual([w.files.includes('leak.ts'), w.skipped.some((s) => s.file === 'leak.ts' && s.reason === 'symlink_outside')], [false, true]);
    await rebuild(pr);
    assert.equal((await repos.graph.loadGraph(pr.ctx)).nodes.some((n) => /stolen/.test(n.label)), false);
  });

  await check('D2', 'limits pinned; maxFileBytes inclusive; maxFiles truncates only when one more file exists; read at call time', async () => {
    assert.deepEqual({ ...W.graphLimits }, { maxFileBytes: 1_048_576, maxFiles: 20_000, maxPayloadFiles: 1000, shrinkMinLoss: 3, embedBatch: 32, embedTextChars: 2000, maxPackageJson: 200, resultListMax: 100 });
    assert.deepEqual({ ...C.resolveLimits }, { maxAmbiguous: 5, maxReexportHops: 5 });
    assert.deepEqual({ ...C.SCORES }, { sameFile: 0.95, samePackage: 0.85, nameOnly: 0.6, ambiguous: 0.3, extracted: 1 });
    const pr = await project({ 'ten.ts': '0123456789', 'eleven.ts': '01234567890' });
    await withLimits(W.graphLimits, { maxFileBytes: 10 }, async () => {
      const w = await W.walkProject(pr.root);
      assert.deepEqual([w.files.includes('ten.ts'), w.skipped.find((s) => s.file === 'eleven.ts')?.reason], [true, 'too_large']);
    });
    await withLimits(W.graphLimits, { maxFiles: 2 }, async () => {
      assert.deepEqual([(await W.walkProject(pr.root)).files.length, (await W.walkProject(pr.root)).truncated], [2, false]);
      pr.put('z.ts', 'x');
      const w = await W.walkProject(pr.root);
      assert.deepEqual([w.files.length, w.truncated], [2, true]);
    });
  });

  await check('D3', 'shapes: contentHash hex, resolveGraph keys, RebuildResult JSON-safe; extract failure → Error extract_failed after the rest was written', async () => {
    assert.match(C.contentHash('a.ts', 'x'), /^[0-9a-f]{64}$/);
    const out = resolve(MAIN);
    assert.deepEqual(sorted(Object.keys(out)), ['edges', 'packages', 'reexports']);
    assert.deepEqual(sorted(Object.keys(out.edges)), sorted(Object.keys(MAIN)));
    for (const list of Object.values(out.edges)) {
      const keys = list.map((e) => [e.src, e.relation, e.dst].join('\u0000'));
      assert.deepEqual(keys, [...keys].sort(byCode));
      assert.equal(new Set(keys).size, keys.length);
      for (const e of list) assert.match(e.sourceLocation, /^L\d+$/);
    }
    assert.deepEqual(out.packages, [{ id: 'code:pkg:node:fs', kind: 'code', type: 'package', label: 'node:fs', sourceLocation: null, meta: {} }]);
    const pr = await project({ 'ok.ts': 'export function ok() {}\n', 'big.ts': 'export function big() { return 12345; }\n' });
    const r = await rebuild(pr);
    assert.deepEqual(r, JSON.parse(JSON.stringify(r)));
    assert.deepEqual(sorted(Object.keys(r)), ['counts', 'epoch', 'files', 'mode', 'truncated']);
    assert.deepEqual(sorted(Object.keys(r.counts)), sorted(['walked', 'changed', 'unchanged', 'written', 'deleted', 'dependents', 'refused', 'failed', 'duplicates', 'skipped', 'embedded']));
    assert.deepEqual(sorted(Object.keys(r.files)), sorted(['written', 'deleted', 'dependents', 'refused', 'failed', 'duplicates', 'skipped']));
    assert.equal(r.mode, 'full');
    pr.put('big.ts', 'export function big() { return 1234567890; }\n');
    pr.put('ok.ts', 'function o(){}\nfunction k(){}\n');
    const before = await nodesOf(pr.ctx, 'big.ts');
    await withLimits(C.limits, { maxFileBytes: 30 }, async () => {
      await assert.rejects(handler()({ userId: 'local', projectId: pr.ctx.projectId }, hctx()),
        (e) => !(e?.name === 'UnrecoverableError') && e instanceof Error && e.message === 'extract_failed: big.ts (too_large)');
    });
    assert.deepEqual(await nodesOf(pr.ctx, 'big.ts'), before);
    assert.equal((await nodesOf(pr.ctx, 'ok.ts')).length, 3);
  });

  await check('D4', 'resolveGraph/contentHash never throw on junk; handler order: project_not_found, root_missing (rows kept)', async () => {
    const junk = [undefined, null, 5, 'x', {}, { results: 'x' }, { results: [null, 5, { file: 'a.ts', error: null, nodes: 'x' }] },
      { results: [], context: null, files: [1, 2], packages: [null, { dir: 5 }] }, { results: [{ ...ex('a.ts', 'f()'), refs: [null, { from: 1 }], imports: 'x' }] }];
    for (const j of junk) assert.equal(typeof C.resolveGraph(j)?.edges, 'object');
    for (const j of [[undefined, null], [5, {}], ['a.md', null]]) assert.equal(typeof C.contentHash(...j), 'string');
    await assert.rejects(handler()({ userId: 'local', projectId: `nope${rnd()}` }, hctx()), dropped('project_not_found'));
    const gone = path.join(tmp, `gone-${rnd()}`);
    const p = await repos.projects.upsert({ userId: 'local' }, { root: gone });
    const ctx = { userId: 'local', projectId: p.id };
    await repos.graph.replaceSource(ctx, { origin: 'ast', sourceFile: 'k.ts', nodes: [{ id: 'code:k', kind: 'code', type: 'file', label: 'k.ts' }], edges: [], source: { contentHash: 'h', extractorVersion: 'v' } });
    await assert.rejects(handler()({ userId: 'local', projectId: p.id }, hctx()), dropped('root_missing'));
    assert.deepEqual(await sources(ctx), ['k.ts']);
  });

  await check('D5', 'odd input: empty project, files: [], duplicates in files, BOM+CRLF, bad package.json, symbol-less file', async () => {
    const empty = await project();
    const r0 = await rebuild(empty);
    assert.deepEqual([Object.values(r0.counts).every((n) => n === 0), r0.epoch, await sources(empty.ctx)], [true, null, []]);
    const pr = await project({ 'w.ts': '\uFEFFexport function w() {}\r\nexport function v() {}\r\n', 'package.json': '{ not json', 'e.ts': '// nothing\n' });
    const r1 = await rebuild(pr, { files: [] });
    assert.deepEqual([r1.mode, r1.counts.written, await sources(pr.ctx)], ['files', 0, []]);
    const r2 = await rebuild(pr, { files: ['w.ts', 'w.ts', 'never.ts'] });
    assert.deepEqual(r2.files.written, ['w.ts']);
    const ids = (await nodesOf(pr.ctx, 'w.ts')).map((n) => n.id);
    assert.deepEqual(sorted(ids), sorted([fid('w.ts'), sid('w.ts', 'w'), sid('w.ts', 'v')]));
    await rebuild(pr);
    assert.deepEqual((await nodesOf(pr.ctx, 'e.ts')).map((n) => n.type), ['file']);
  });

  await check('D6', 'never writes under root, never mutates resolveGraph input, deterministic, never touches non-ast rows', async () => {
    const pr = await project({ ...MAIN, '.gitignore': 'x\n' });
    const before = snapshot(pr.root);
    await rebuild(pr);
    await rebuild(pr, { force: true });
    assert.deepEqual(snapshot(pr.root), before);
    const results = Object.entries(MAIN).map(([p, s]) => ex(p, s));
    const input = deepFreeze({ results, context: [], files: sorted(Object.keys(MAIN)), packages: [] });
    const a = C.resolveGraph(input);
    assert.deepEqual(C.resolveGraph(input), a);
    await repos.graph.replaceSource(pr.ctx, { origin: 'session', sourceFile: 'src/a.ts', nodes: [{ id: 'sess-1', kind: 'code', type: 'function', label: 's' }], edges: [], source: { contentHash: 's', extractorVersion: 'v' } });
    await repos.graph.replaceSource(pr.ctx, { origin: 'parser', sourceFile: 'src/a.ts', nodes: [{ id: 'parser-1', kind: 'code', type: 'function', label: 'p' }], edges: [], source: { contentHash: 's', extractorVersion: 'v' } });
    await rebuild(pr, { force: true });
    const ids = (await repos.graph.loadGraph(pr.ctx)).nodes.map((n) => n.id);
    assert.deepEqual([ids.includes('sess-1'), ids.includes('parser-1')], [true, true]);
  });

  await check('D7', 'non-goals: only graph.rebuild handled; no references/rationale_for edges, no ctx:/capability nodes; builtAtCommit null', async () => {
    assert.deepEqual(Object.keys(W.graphHandlers({ repos, config: cfg(), grammars })), ['graph.rebuild']);
    const pr = await project({ ...MAIN, 'docs/x.md': '# T2.1 spec\nUses `helper` and skill tdd. D3 decides.\n' });
    await rebuild(pr);
    const g = await repos.graph.loadGraph(pr.ctx);
    assert.deepEqual(g.edges.filter((e) => ['references', 'rationale_for', 'part_of', 'decides', 'uses'].includes(e.relation)), []);
    assert.deepEqual(g.nodes.filter((n) => /^(ctx|skill|agent|command|workflow):/.test(n.id)), []);
    assert.deepEqual((await repos.graph.listSources(pr.ctx)).map((s) => s.builtAtCommit).filter((x) => x !== null), []);
  });

  await check('D8', 'silence rule: an unresolvable call gives no edge; judgment: comments present in the module', async () => {
    const out = resolve({ 'q.ts': 'export function q() { nowhere(); }\n' });
    assert.deepEqual(allEdges(out).filter((e) => e.relation === 'calls'), []);
    const src = [];
    for (const d of ['packages/core/src/graph', 'apps/worker/src/graph']) {
      for (const f of fs.readdirSync(path.join(ROOT, d))) if (f.endsWith('.ts') && !f.endsWith('.test.ts') && !T21_FILES.includes(f)) src.push(fs.readFileSync(path.join(ROOT, d, f), 'utf8'));
    }
    assert.equal(src.some((s) => /judgment:/.test(s)), true);
  });

  await check('D9', 'walk: skipped dirs, nested .gitignore/.ctcignore with re-include, secrets, reserved, symlinked dirs; sorted', async () => {
    const pr = await project({
      '.git/config': 'x', 'node_modules/x/i.js': 'x', 'sub/.ctc/wt/a.ts': 'x', '.gitignore': 'gen/\n*.log\n', 'gen/g.ts': 'x', 'app.log': 'x',
      'sub/.gitignore': '!keep.log\n', 'sub/keep.log': 'x', '.ctcignore': 'secret_dir/\n', 'secret_dir/s.ts': 'x',
      '.env.local': 'K=1', 'Key.PEM': 'x', 'id_rsa': 'x', 'credentials.json': '{}', '<packages>': 'x', 'ok.ts': 'x', 'sub/z.ts': 'x',
    });
    fs.symlinkSync(path.join(pr.root, 'sub'), path.join(pr.root, 'linkdir'));
    fs.symlinkSync(path.join(pr.root, 'ok.ts'), path.join(pr.root, 'inlink.ts'));
    const w = await W.walkProject(pr.root);
    assert.deepEqual(w.files, [...w.files].sort(byCode));
    for (const f of ['ok.ts', 'sub/z.ts', 'sub/keep.log', 'inlink.ts']) assert.equal(w.files.includes(f), true, f);
    const leaked = w.files.filter((f) => /^(\.git|node_modules|gen|secret_dir|linkdir)\/|\.ctc\/|^app\.log$|^\.env|^Key|^id_rsa|^credentials|^<packages>$/.test(f));
    assert.deepEqual(leaked, []);
    const reason = (f) => w.skipped.find((s) => s.file === f)?.reason;
    assert.deepEqual(['.env.local', 'Key.PEM', 'id_rsa', 'credentials.json', '<packages>'].map(reason), ['secret', 'secret', 'secret', 'secret', 'reserved']);
  });

  await check('D10', 'contentHash = sha256(body + relPath), markdown body after frontmatter; unchanged files not written; extractor_version change rebuilds', async () => {
    assert.equal(C.contentHash('a.ts', 'export {}\n'), sha('export {}\na.ts'));
    assert.equal(C.contentHash('x.md', '---\na: 1\n---\nbody\n'), sha('body\nx.md'));
    assert.equal(C.contentHash('x.md', '---\na: 2\n---\nbody\n'), C.contentHash('x.md', '---\na: 1\n---\nbody\n'));
    const pr = await project({ ...MAIN, 'bin.ts': 'a\u0000b' });
    const r1 = await rebuild(pr);
    assert.deepEqual([r1.counts.written, r1.files.skipped.find((s) => s.file === 'bin.ts')?.reason], [3, 'binary']);
    const r2 = await rebuild(pr);
    assert.deepEqual([r2.counts.changed, r2.counts.written, r2.counts.unchanged, r2.epoch], [0, 0, 3, null]);
    await sql`update graph_sources set extractor_version = 'old' where project_id = ${pr.ctx.projectId} and file = 'src/b.ts'`.execute(db.kysely);
    const r3 = await rebuild(pr);
    assert.deepEqual(r3.files.written, ['src/b.ts']);
    assert.deepEqual((await rebuild(pr, { force: true })).counts.written, 3);
    const src = (await repos.graph.listSources(pr.ctx)).find((s) => s.file === 'src/util.ts');
    assert.deepEqual([src.contentHash, src.extractorVersion], [C.contentHash('src/util.ts', MAIN['src/util.ts']), C.EXTRACTOR_VERSION]);
  });

  await check('D11', 'specifiers: .js→.ts, index, workspace exports, unknown package node, python relative/absolute/package, bash source', async () => {
    const srcs = {
      'src/a.ts': "import { b } from './b.js';\nimport * as d from './dir';\nimport { z } from 'lodash';\nimport { q } from '@w/lib';\nimport 'https://x.test/m.js';\n",
      'src/b.ts': 'export const b = 1;\n', 'src/dir/index.ts': 'export const i = 1;\n', 'packages/lib/src/main.ts': 'export const q = 1;\n',
      'pkg/__init__.py': '', 'pkg/m.py': 'from .n import g\nimport os\nfrom pkg import n\n', 'pkg/n.py': 'def g():\n    pass\n',
      's.sh': 'source ./lib.sh\n', 'lib.sh': 'x=1\n',
    };
    const out = resolve(srcs, { packages: [{ dir: 'packages/lib', name: '@w/lib', exports: { '.': './src/main.ts' } }], files: ['packages/lib/package.json'] });
    const imp = (src) => from(out, src).filter((e) => e[1] === 'imports' || e[1] === 'imports_from');
    assert.deepEqual(imp(fid('src/a.ts')), [
      ['code:pkg:lodash', 'imports_from', 'EXTRACTED', 1], [fid('packages/lib/src/main.ts'), 'imports_from', 'EXTRACTED', 1],
      [fid('src/b.ts'), 'imports_from', 'EXTRACTED', 1], [fid('src/dir/index.ts'), 'imports', 'EXTRACTED', 1],
    ].sort((a, b) => byCode(a[0], b[0])));
    assert.deepEqual(imp(fid('pkg/m.py')), [
      ['code:pkg:os', 'imports', 'EXTRACTED', 1], [fid('pkg/__init__.py'), 'imports_from', 'EXTRACTED', 1], [fid('pkg/n.py'), 'imports_from', 'EXTRACTED', 1],
    ].sort((a, b) => byCode(a[0], b[0])));
    assert.deepEqual(imp(fid('s.sh')), [[fid('lib.sh'), 'imports', 'EXTRACTED', 1]]);
    assert.deepEqual(out.packages.map((p) => p.id), ['code:pkg:lodash', 'code:pkg:os']);
  });

  await check('D12', 'EXTRACTED only through an import proof (named, namespace, re-export); external package calls give no edge', async () => {
    const out = resolve(MAIN);
    assert.deepEqual(from(out, sid('src/a.ts', 'main'), 'calls'), [
      [sid('src/b.ts', 'helper'), 'calls', 'EXTRACTED', 1], [sid('src/util.ts', 'fmt'), 'calls', 'EXTRACTED', 1],
    ].sort((a, b) => byCode(a[0], b[0])));
    assert.deepEqual(out.reexports['src/b.ts'], [{ specifier: './util.ts', names: [{ imported: 'fmt', local: 'f2' }] }]);
    const noImport = resolve({ ...MAIN, 'src/a.ts': 'export function main() { helper(); }\n' });
    assert.deepEqual(from(noImport, sid('src/a.ts', 'main'), 'calls'), [[sid('src/b.ts', 'helper'), 'calls', 'INFERRED', 0.85]]);
    const py = resolve({ 'pkg/m.py': 'from .n import g as gg\ndef f():\n    gg()\n', 'pkg/n.py': 'def g():\n    pass\n' });
    assert.deepEqual(from(py, sid('pkg/m.py', 'f'), 'calls'), [[sid('pkg/n.py', 'g'), 'calls', 'EXTRACTED', 1]]);
    const ctxOut = C.resolveGraph({ results: [ex('src/a.ts', MAIN['src/a.ts'])], files: sorted(Object.keys(MAIN)), packages: [],
      context: [{ id: fid('src/b.ts'), type: 'file', label: 'b.ts', sourceFile: 'src/b.ts', meta: { reexports: [{ specifier: './util.ts', names: [{ imported: 'fmt', local: 'f2' }] }] } },
        { id: sid('src/b.ts', 'helper'), type: 'function', label: 'helper()', sourceFile: 'src/b.ts' },
        { id: fid('src/util.ts'), type: 'file', label: 'util.ts', sourceFile: 'src/util.ts' }, { id: sid('src/util.ts', 'fmt'), type: 'function', label: 'fmt()', sourceFile: 'src/util.ts' }] });
    assert.deepEqual(from(ctxOut, sid('src/a.ts', 'main'), 'calls'), from(out, sid('src/a.ts', 'main'), 'calls'));
  });

  await check('D13', 'tiers: same file 0.95 → same package 0.85 → name only 0.6; 2..maxAmbiguous AMBIGUOUS 0.3; more → none; this.x() 0.95', async () => {
    const srcs = {
      'p1/a.ts': 'function loc() {}\nexport function main() { loc(); near(); far(); dup(); many(); main(); }\nexport class K { run() { this.go(); } go() {} }\n',
      'p1/b.ts': 'export function near() {}\nexport function dup() {}\n', 'p1/c.ts': 'export function dup() {}\n', 'p2/d.ts': 'export function far() {}\n',
    };
    for (let i = 0; i < 6; i++) srcs[`p3/m${i}.ts`] = 'export function many() {}\n';
    const out = resolve(srcs, { files: ['p1/package.json', 'p2/package.json'] });
    assert.deepEqual(from(out, sid('p1/a.ts', 'main'), 'calls'), [
      [sid('p1/a.ts', 'loc'), 'calls', 'INFERRED', 0.95], [sid('p1/b.ts', 'near'), 'calls', 'INFERRED', 0.85], [sid('p2/d.ts', 'far'), 'calls', 'INFERRED', 0.6],
      [sid('p1/b.ts', 'dup'), 'calls', 'AMBIGUOUS', 0.3], [sid('p1/c.ts', 'dup'), 'calls', 'AMBIGUOUS', 0.3],
    ].sort((a, b) => byCode(a[0], b[0])));
    assert.deepEqual(from(out, sid('p1/a.ts', 'K', 'run'), 'calls'), [[sid('p1/a.ts', 'K', 'go'), 'calls', 'INFERRED', 0.95]]);
    await withLimits(C.resolveLimits, { maxAmbiguous: 6 }, async () => {
      const again = resolve(srcs, { files: ['p1/package.json', 'p2/package.json'] });
      assert.equal(from(again, sid('p1/a.ts', 'main'), 'calls').filter((e) => e[0].endsWith('_many')).length, 6);
    });
  });

  await check('D14', 'mentions: link and path_symbol EXTRACTED, single symbol INFERRED 0.6, unknown symbol nothing', async () => {
    const srcs = { ...MAIN, 'docs/x.md': '# Top\nSee [b](../src/b.ts) and `src/util.ts::fmt` and `helper()` and `a.b.c`.\n' };
    const out = resolve(srcs);
    const top = `doc:${C.makeId(C.fileStem('docs/x.md'), 'top')}`;
    assert.deepEqual(from(out, top, 'mentions'), [
      [fid('src/b.ts'), 'mentions', 'EXTRACTED', 1], [sid('src/util.ts', 'fmt'), 'mentions', 'EXTRACTED', 1], [sid('src/b.ts', 'helper'), 'mentions', 'INFERRED', 0.6],
    ].sort((a, b) => byCode(a[0], b[0])));
  });

  await check('D15', 'write: per-file ast rows, node hash = sha256(embed text), reexports meta on the file node; duplicate ids: smaller path owns', async () => {
    const pr = await project({ ...MAIN, 'foo.ts': 'export function a() {}\n', 'foo.py': 'def b():\n    pass\n' });
    const r = await rebuild(pr);
    assert.deepEqual(r.files.duplicates, [{ id: 'code:foo', file: 'foo.ts', owner: 'foo.py' }]);
    const g = await repos.graph.loadGraph(pr.ctx);
    const node = (id) => g.nodes.find((n) => n.id === id);
    assert.deepEqual([node('code:foo')?.sourceFile, node(sid('foo.ts', 'a'))?.sourceFile], ['foo.py', 'foo.ts']);
    assert.deepEqual(sorted(await sources(pr.ctx)).filter((f) => f.startsWith('foo')), ['foo.py', 'foo.ts']);
    assert.deepEqual(node(fid('src/b.ts')).meta.reexports, [{ specifier: './util.ts', names: [{ imported: 'fmt', local: 'f2' }] }]);
    assert.equal(node(sid('src/util.ts', 'fmt')).contentHash, sha('fmt()\nexport function fmt() { return 2; }'));
    assert.deepEqual(g.nodes.filter((n) => n.sourceFile !== '<packages>').map((n) => n.origin).filter((o) => o !== 'ast'), []);
    const fileIds = new Map(g.nodes.map((n) => [n.id, n.sourceFile]));
    const stray = g.edges.filter((e) => !fileIds.has(e.src));
    assert.deepEqual(stray, []);
  });

  await check('D16', 'shrink guard: exactly 20% written, more refused with rows kept, under shrinkMinLoss written, force writes; handler error text', async () => {
    const pr = await project({ 'big.ts': fns(14), 'small.ts': fns(4) });
    await rebuild(pr);
    pr.put('big.ts', fns(11));
    assert.deepEqual((await rebuild(pr, { files: ['big.ts'] })).files.written, ['big.ts']);
    pr.put('big.ts', fns(8));
    const r = await rebuild(pr, { files: ['big.ts'] });
    assert.deepEqual([r.files.refused, r.counts.refused, (await nodesOf(pr.ctx, 'big.ts')).length], [['big.ts'], 1, 12]);
    await assert.rejects(handler()({ userId: 'local', projectId: pr.ctx.projectId, files: ['big.ts'] }, hctx()), dropped('shrink_guard: big.ts'));
    assert.equal((await nodesOf(pr.ctx, 'big.ts')).length, 12);
    assert.deepEqual((await handler()({ userId: 'local', projectId: pr.ctx.projectId, files: ['big.ts'], force: true }, hctx())).files.written, ['big.ts']);
    assert.equal((await nodesOf(pr.ctx, 'big.ts')).length, 9);
    pr.put('small.ts', fns(2));
    assert.deepEqual((await rebuild(pr, { files: ['small.ts'] })).files.written, ['small.ts']);
  });

  await check('D17', 'deletions remove rows; unchanged callers keep edges; dependents of removed ids are rewritten so no edge dangles', async () => {
    const pr = await project({ ...MAIN, 'c.ts': 'export function c() {}\n' });
    await rebuild(pr);
    const edge = async () => (await repos.graph.loadGraph(pr.ctx)).edges.find((e) => e.src === sid('src/a.ts', 'main') && e.dst === sid('src/b.ts', 'helper'));
    pr.put('src/b.ts', MAIN['src/b.ts'] + 'export function extra() {}\n');
    const r1 = await rebuild(pr, { files: ['src/b.ts'] });
    assert.deepEqual([r1.files.written, r1.files.dependents, (await edge())?.confidence], [['src/b.ts'], [], 'EXTRACTED']);
    pr.put('src/b.ts', "export function helper2() { return 1; }\nexport { fmt as f2 } from './util.ts';\n");
    const r2 = await rebuild(pr, { files: ['src/b.ts'] });
    assert.deepEqual(r2.files.dependents, ['src/a.ts']);
    const g = await repos.graph.loadGraph(pr.ctx);
    const ids = new Set(g.nodes.map((n) => n.id));
    assert.deepEqual(g.edges.filter((e) => e.dst.startsWith('code:') && !e.dst.startsWith('code:pkg:') && !ids.has(e.dst)).map((e) => e.dst), []);
    fs.rmSync(path.join(pr.root, 'c.ts'));
    const r3 = await rebuild(pr);
    assert.deepEqual([r3.files.deleted, (await sources(pr.ctx)).includes('c.ts'), (await nodesOf(pr.ctx, 'c.ts')).length], [['c.ts'], false, 0]);
  });

  await check('D18', 'package nodes live in <packages>; removed with their last importer', async () => {
    const pr = await project({ 'p.ts': "import { z } from 'zod-x';\nexport function f() { return z; }\n" });
    await rebuild(pr);
    const pkg = (await repos.graph.loadGraph(pr.ctx)).nodes.find((n) => n.id === 'code:pkg:zod-x');
    assert.deepEqual([pkg?.sourceFile, pkg?.type, (await sources(pr.ctx)).includes('<packages>')], ['<packages>', 'package', true]);
    pr.put('p.ts', 'export function f() { return 1; }\n');
    await rebuild(pr);
    assert.deepEqual([(await sources(pr.ctx)).includes('<packages>'), (await nodesOf(pr.ctx, '<packages>')).length], [false, 0]);
  });

  await check('D19', 'epoch rotate + ctc:inval only when something was written; failures ignored', async () => {
    const calls = [];
    const cache = { epoch: { rotate: async (...a) => { calls.push(['rotate', ...a]); return 'tok-1'; } }, publishInval: async (m) => { calls.push(['inval', m]); } };
    const pr = await project({ 'e.ts': 'export function e() {}\n' }, `u-${rnd()}`);
    const r1 = await rebuild(pr, { cache });
    assert.deepEqual([r1.epoch, calls], ['tok-1', [['rotate', 'graph', pr.ctx.userId, pr.ctx.projectId], ['inval', { v: 1, event: 'graph.rebuild', userId: pr.ctx.userId, projectId: pr.ctx.projectId }]]]);
    const r2 = await rebuild(pr, { cache });
    assert.deepEqual([r2.epoch, calls.length], [null, 2]);
    pr.put('e.ts', 'export function e() {}\nexport function e2() {}\n');
    const boom = { epoch: { rotate: async () => { throw new Error('redis down'); } }, publishInval: async () => { throw new Error('redis down'); } };
    const r3 = await rebuild(pr, { cache: boom });
    assert.deepEqual([r3.files.written, r3.epoch], [['e.ts'], null]);
  });

  await check('D20', 'embed: all pending nodes in batches ≤ embedBatch, text = label + source lines; unchanged nodes keep vectors; bad vectors skipped', async () => {
    const batches = [];
    const embed = async (texts) => { batches.push(texts); return texts.map(() => vec()); };
    const pr = await project({ 'e.ts': 'export function one() { return 1; }\nexport function two() { return 2; }\n' }, `u-${rnd()}`);
    await withLimits(W.graphLimits, { embedBatch: 2 }, async () => {
      const r1 = await rebuild(pr, { embed });
      assert.deepEqual([r1.counts.embedded, batches.map((b) => b.length)], [3, [2, 1]]);
    });
    assert.equal(batches.flat().includes('one()\nexport function one() { return 1; }'), true);
    batches.length = 0;
    assert.deepEqual([(await rebuild(pr, { embed })).counts.embedded, batches.length], [0, 0]);
    pr.put('e.ts', 'export function one() { return 1; }\nexport function two() { return 3; }\n');
    assert.equal((await rebuild(pr, { embed })).counts.embedded, 2);
    assert.equal((await repos.graph.loadVectors(pr.ctx)).length, 3);
    const pr2 = await project({ 'f.ts': 'export function f() {}\n' }, `u-${rnd()}`);
    const r = await rebuild(pr2, { embed: async (t) => t.map(() => [1, 2, 3]) });
    assert.deepEqual([r.counts.embedded, (await repos.graph.pendingEmbeddings(pr2.ctx, {})).length], [0, 2]);
    const r4 = await rebuild(pr2, { embed: async () => { throw new Error('tei down'); } });
    assert.equal(r4.counts.embedded, 0);
  });

  await check('D21', 'handler: debounce by job age, force skips it, abort stops the wait, > maxPayloadFiles → full mode', async () => {
    const pr = await project({ 'x.ts': 'export function x() {}\n', 'y.ts': 'export function y() {}\n' });
    const payload = { userId: 'local', projectId: pr.ctx.projectId, files: ['x.ts'] };
    const { job } = await repos.jobs.create({ userId: 'local' }, { queue: 'graph', kind: 'rebuild', payload });
    const h = W.graphHandlers({ repos, config: cfg({ debounce_s: 1 }), grammars })['graph.rebuild'];
    let t = Date.now();
    await h(payload, hctx({ jobId: job.id }));
    assert.equal(Date.now() - t >= 700, true, 'waited for the debounce');
    const { job: j2 } = await repos.jobs.create({ userId: 'local' }, { queue: 'graph', kind: 'rebuild', payload });
    t = Date.now();
    await h({ ...payload, force: true }, hctx({ jobId: j2.id }));
    assert.equal(Date.now() - t < 700, true, 'force does not wait');
    const { job: j3 } = await repos.jobs.create({ userId: 'local' }, { queue: 'graph', kind: 'rebuild', payload });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    t = Date.now();
    await assert.rejects(W.graphHandlers({ repos, config: cfg({ debounce_s: 30 }), grammars })['graph.rebuild'](payload, hctx({ jobId: j3.id, signal: ac.signal })));
    assert.equal(Date.now() - t < 3000, true, 'abort ends the wait');
    await withLimits(W.graphLimits, { maxPayloadFiles: 1 }, async () => {
      assert.equal((await rebuild(pr, { files: ['x.ts'] })).mode, 'files');
      assert.equal((await rebuild(pr, { files: ['x.ts', 'y.ts'] })).mode, 'full');
    });
  });

  await check('D22', 'repos: replaceSource keeps equal-hash embeddings; deleteSource; pendingEmbeddings paging; tenancy cases added', async () => {
    const ctx = { userId: `u-${rnd()}`, projectId: `p${rnd()}` };
    const put1 = (h) => repos.graph.replaceSource(ctx, { origin: 'ast', sourceFile: 'r.ts', nodes: [{ id: 'n1', kind: 'code', type: 'function', label: 'n1', contentHash: h }, { id: 'n2', kind: 'code', type: 'function', label: 'n2', contentHash: 'z' }], edges: [{ src: 'n1', dst: 'n2', relation: 'calls', confidence: 'INFERRED', score: 0.6 }], source: { contentHash: 'f', extractorVersion: 'v' } });
    await put1('h1');
    await repos.graph.setEmbedding(ctx, 'n1', vec(), 'h1');
    await put1('h1');
    assert.deepEqual((await repos.graph.loadVectors(ctx)).map((v) => v.id), ['n1']);
    await put1('h2');
    assert.deepEqual(await repos.graph.loadVectors(ctx), []);
    const pend = await repos.graph.pendingEmbeddings(ctx, { limit: 1 });
    assert.deepEqual([pend.length, pend[0].id, (await repos.graph.pendingEmbeddings(ctx, { afterId: 'n1' })).map((n) => n.id)], [1, 'n1', ['n2']]);
    assert.deepEqual(sorted(Object.keys(pend[0])), ['contentHash', 'id', 'label', 'meta', 'sourceFile']);
    assert.equal((await repos.graph.pendingEmbeddings(ctx, { limit: 0 })).length, 1);
    await repos.graph.replaceSource(ctx, { origin: 'session', sourceFile: 's.ts', nodes: [{ id: 's1', kind: 'code', type: 'function', label: 's' }], edges: [], source: { contentHash: 'f', extractorVersion: 'v' } });
    assert.deepEqual(await repos.graph.deleteSource(ctx, { origin: 'session', sourceFile: 's.ts' }), { deleted: 0 });
    assert.equal((await repos.graph.getNode(ctx, 's1')) !== null, true);
    assert.deepEqual(await repos.graph.deleteSource(ctx, { origin: 'ast', sourceFile: 'r.ts' }), { deleted: 3 });
    assert.deepEqual([(await sources(ctx)).includes('r.ts'), await repos.graph.getNode(ctx, 'n1')], [false, null]);
    await assert.rejects(repos.graph.deleteSource(ctx, { origin: 'nope', sourceFile: 'r.ts' }), (e) => e instanceof R.RepoError && e.code === 'invalid');
    await assert.rejects(repos.graph.deleteSource(ctx, { origin: 'ast', sourceFile: '' }), (e) => e instanceof R.RepoError && e.code === 'invalid');
    const cases = fs.readFileSync(path.join(ROOT, CASES), 'utf8');
    assert.deepEqual([/\bdeleteSource\s*:/.test(cases), /\bpendingEmbeddings\s*:/.test(cases)], [true, true]);
  });

  await check('D23', 'gate test files: describe graph.resolve / graph.incremental with the named tests on ctc_t22_ scratch schemas', async () => {
    const has = (src, name) => new RegExp(`\\b(it|test)\\(\\s*['"\`]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(src);
    const read = (rel) => (fs.existsSync(path.join(ROOT, rel)) ? fs.readFileSync(path.join(ROOT, rel), 'utf8') : '');
    const a = read(GATE_RESOLVE); const b = read(GATE_INCR);
    assert.deepEqual([
      /describe\(\s*['"`]graph\.resolve['"`]/.test(a), has(a, 'a call becomes EXTRACTED only with an import edge'), has(a, 'ambiguous names become AMBIGUOUS'),
      /describe\(\s*['"`]graph\.incremental['"`]/.test(b), has(b, 'edit 1 file → only its rows change'), has(b, 'callers keep edges'), has(b, 'guard trips above 20% loss'), /ctc_t22_/.test(b),
    ], [true, true, true, true, true, true, true, true]);
  });

  await check('D24', 'exports exactly as listed; core resolver is pure; ignore@7.0.14 exact in apps/worker', async () => {
    const runtime = (m) => sorted(Object.keys(m));
    assert.deepEqual(runtime(W), sorted(['graphHandlers', 'rebuildProject', 'walkProject', 'graphLimits', 'PACKAGES_SOURCE']));
    assert.deepEqual(runtime(C), sorted(['extractFile', 'GrammarError', 'loadGrammars', 'cleanLabel', 'fileStem', 'langOf', 'makeId', 'normalizeId', 'EXTRACTOR_VERSION', 'limits',
      'resolveGraph', 'contentHash', 'resolveLimits', 'SCORES']));
    const dir = path.join(ROOT, 'packages/core/src/graph');
    const impure = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !T21_FILES.includes(f))
      .filter((f) => /from\s+['"](node:)?(fs|fs\/promises|child_process|net|http|https)['"]/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    assert.deepEqual(impure, []);
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/worker/package.json'), 'utf8'));
    assert.equal(pkg.dependencies?.ignore, '7.0.14');
  });
} finally {
  await finish();
}
