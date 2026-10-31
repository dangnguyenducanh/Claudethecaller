// checks for T2.3 context id parsers, doc extract, capability nodes: one runnable example per decision id (D0..D22).
// Prints `PASS D# ...` or `FAIL D# expected=<..> got=<..>`; last line `CHECKS: <n> pass, <m> fail`; exit 1 on any FAIL.
// Needs: env CTC_SCRATCH_PG_URL (scratch Postgres 127.0.0.1:18304 only), the T1.2 migrations, T2.1's grammars. Run from the repo root:
//   node --import tsx agent/t2-3-parsers/checks.mjs      (tsx lets Node import the .ts sources)
// Fixture projects are temp directories under os.tmpdir(), removed at the end; this repository's own documents are only READ (D5, D21),
// ~/.claude is never touched and the real `claude` binary is never started (fake runClaude and fake shell scripts only).
// Scratch schema `ctc_t23chk_<random>`, dropped at the end. Fixture values are this file's own.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(new URL('../../', import.meta.url).pathname);
const CORE = 'packages/core/src/context/index.ts';
const WORKER = 'apps/worker/src/context/index.ts';
const GRAPH_CORE = 'packages/core/src/graph/index.ts';
const GRAPH_WORKER = 'apps/worker/src/graph/index.ts';
const LIB_CORE = 'packages/core/src/library/index.ts';
const LIB_WORKER = 'apps/worker/src/library/index.ts';
const REPOS = 'packages/shared/src/repositories/index.ts';
const ADMIN = 'packages/shared/src/repositories/admin/index.ts';
const GATE = 'packages/core/src/context/parser.fixtures.test.ts';
const FIXDIR = 'packages/core/src/context/__fixtures__';
const IDS = Array.from({ length: 23 }, (_, i) => `D${i}`);
let pass = 0; let fail = 0;
const done = new Set();
const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
function ok(id, msg) { pass++; done.add(id); console.log(`PASS ${id} ${msg}`); }
function bad(id, expected, got) { fail++; done.add(id); console.log(`FAIL ${id} expected=${show(expected)} got=${show(got)}`); }
async function check(id, msg, fn) {
  let timer;
  try {
    await Promise.race([fn(), new Promise((_, rej) => (timer = setTimeout(() => rej(new Error('check timed out after 90 s')), 90_000)))]);
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
const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (a) => [...a].sort(byCode);
const edgeCmp = (a, b) => byCode(a.src, b.src) || byCode(a.dst, b.dst) || byCode(a.relation, b.relation);

// ---- load -----------------------------------------------------------------------------------------------------------
const url = process.env.CTC_SCRATCH_PG_URL;
if (!url) await failAll('env CTC_SCRATCH_PG_URL not set');
const pu = new URL(url);
if (pu.hostname !== '127.0.0.1' || pu.port !== '18304') await failAll(`refusing ${pu.hostname}:${pu.port}, only the scratch Postgres 127.0.0.1:18304`);
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
let C; let W; let G; let WG; let L; let WL; let R; let A;
for (const rel of [CORE, WORKER]) if (!fs.existsSync(path.join(ROOT, rel))) await failAll(`module not built: ${rel} is missing`);
try {
  C = await load(CORE); W = await load(WORKER); G = await load(GRAPH_CORE); WG = await load(GRAPH_WORKER);
  L = await load(LIB_CORE); WL = await load(LIB_WORKER); R = await load(REPOS); A = await load(ADMIN);
} catch (e) { await failAll(`module not importable: ${e?.code ?? e?.name}: ${String(e?.message).split('\n')[0]}`); }
if (typeof C.parseContext !== 'function' || typeof W.contextPass !== 'function') await failAll('module not built: parseContext / contextPass missing');
let grammars;
try { grammars = await G.loadGrammars(); } catch (e) { await failAll(`grammars not loadable: ${e?.name}: ${e?.message}`); }
const schema = `ctc_t23chk_${rnd()}`;
let db; let repos;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t23chk-'));
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
const cfg = (o = {}) => ({ mode: 'local', graph: { languages: LANGS, shrink_guard: 0.2, debounce_s: 0, ...o } });
const fid = (p) => `code:${G.makeId(G.fileStem(p))}`;
const sid = (p, ...names) => `code:${G.makeId(G.fileStem(p), ...names)}`;
const vec = () => Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
const put = (root, rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
const hctx = (o = {}) => ({ jobId: `j-${rnd()}`, attempt: 1, signal: new AbortController().signal, setProgress: async () => {}, ...o });
const dropped = (code) => (e) => e?.name === 'UnrecoverableError' && e?.message === `dropped:${code}`;
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
const withLimits = async (obj, patch, fn) => { const keep = { ...obj }; Object.assign(obj, patch); try { return await fn(); } finally { Object.assign(obj, keep); } };
const snapshot = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); const st = fs.lstatSync(p); out.push(`${p}|${st.size}|${st.mtimeMs}`); if (e.isDirectory()) walk(p); } };
  walk(dir); return out.sort();
};
let dirs = 0;
async function project(files = {}, userId = 'local') {
  const root = path.join(tmp, `p${++dirs}`);
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, text] of Object.entries(files)) put(root, rel, text);
  const p = await repos.projects.upsert({ userId }, { root });
  return { root, ctx: { userId, projectId: p.id }, put: (rel, text) => put(root, rel, text) };
}
const ast = (pr, o = {}) => WG.rebuildProject({ repos, ctx: pr.ctx, root: pr.root, config: cfg(), grammars, ...o });
const pass_ = (pr, o = {}) => W.contextPass({ repos, ctx: pr.ctx, root: pr.root, ...o });
const parserNodes = async (ctx, file) => (await repos.graph.loadGraph(ctx)).nodes.filter((n) => n.origin === 'parser' && (file === undefined || n.sourceFile === file));
const edgesOf = async (ctx, origin, pred = () => true) => (await repos.graph.loadGraph(ctx)).edges.filter((e) => e.origin === origin && pred(e));
const stripTime = (rows) => rows.map(({ updatedAt, ...r }) => r);

// ---- document fixtures (this file's own) -------------------------------------------------------------------------------------
const SPEC_LINES = [
  '# Feature Specification: Demo thing', '', '### User Story 1 - Load a file (Priority: P1)',
  '- **FR-001**: The system MUST load files from `src/load.ts::loadFile`.', '- **SC-001**: Load in under 1 s.',
  '```text', '| T9.9 | in fence | x |', '```',
  '| Phase | Task | Done when |', '|---|---|---|',
  '| 1 | T1.1 parse files in `src/parse.ts` and `./lib/a.ts::go` | tests |',
  '| | T1.2 | second cell label | x |',
  '| D1 | pick sqlite | **sqlite**, see `docs/db.md` |',
  '- [x] T1.3 `[P]` [US1] finish checklist item',
  '- [ ] T1.1 duplicate id is ignored',
  '#### T2.0: heading task',
];
const SPEC_PATH = 'specs/900-demo/spec.md';
const SPEC_TEXT = SPEC_LINES.join('\n') + '\n';
const SP = (id) => `ctx:specs/900-demo/spec:${id}`;
const CLAUDE_LINES = [
  '# Notes', '', '**Decisions**',
  '- 2026-10-20 \u2014 Built from scratch: refs only, see `src/a.ts::x`. Second sentence.', '  continuation line here',
  '- 2026-10-20 \u2014 Second on the same day.', '- 2026-10-21 - Hyphen separator works.', '- 2026-1-21 \u2014 not a date',
];
const CLAUDE_TEXT = CLAUDE_LINES.join('\n') + '\n';
const ISSUE_PATH = '.scratch/feat-x/issues/03-links.md';
const ISSUE_LINES = [
  '# 03 \u2014 Links and build (G3)', '', 'Status: ready-for-agent', 'Blocked by: 01, 02',
  'Touches: src/ctc/graph/link.py, src/ctc/graph/build.py, tests/test_link.py', '', '```', 'see src/in/fence.ts', '```', '## What to build', 'Also `lib/z.ts::go` here.',
];
const ISSUE_TEXT = ISSUE_LINES.join('\n') + '\n';
const brief = (n) => ({ id: n.id, type: n.type, label: n.label, loc: n.sourceLocation });
const parse = (p, content) => C.parseContext({ path: p, content });
const cut = (o, ...keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

const SKILL = { kind: 'skill', name: 'tdd', description: 'Test first', frontmatter: { name: 'tdd', skills: ['plan', 'Bad_Name'], commands: 'review, ship' },
  body: 'Use skill:plan then agent:reviewer and command:ship. Also skill:tdd (self) and workflow:x and ctx:skill:no and skill:Bad.', servedVersion: 2, bodyHash: 'b'.repeat(64) };
const WF = { kind: 'workflow', name: 'ship-it', description: 'd', servedVersion: 1, bodyHash: 'c'.repeat(64), body: '', frontmatter: { name: 'ship-it', nodes: [
  { id: 'start', type: 'trigger' }, { id: 'impl', type: 'agent', prompt: 'Run skill:tdd then command:review' }, { id: 'impl', type: 'shell', run: 'skill:dup' },
  { id: 'bad id!', type: 'shell' }, { id: 'gate', type: 'approval', question: 'ok? agent:reviewer' }], edges: [] } };
const stableJson = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => byCode(a, b))) : x));
const capHash = (i) => sha(`ctc-ctx-1\0${i.kind}\0${i.name}\0${i.servedVersion ?? ''}\0${i.description}\0${i.bodyHash}\0${stableJson(i.frontmatter)}`);

// library helpers: a capability with one SKILL.md version, served
async function capability(userId, { kind = 'skill', name, text, namespace = 'user', serve = true, version }) {
  const b = L.buildVersion({ kind, namespace, defaultName: name, rootPath: `/virtual/${kind}s/${name}`, mainPath: kind === 'workflow' ? 'wf.yaml' : kind === 'skill' ? 'SKILL.md' : `${name}.md`, files: [{ path: kind === 'workflow' ? 'wf.yaml' : kind === 'skill' ? 'SKILL.md' : `${name}.md`, bytes: Buffer.from(text) }] });
  assert.equal(b.ok, true, `fixture capability must build: ${show(b)}`);
  await repos.library.createVersion({ userId }, b.input);
  const cap = await repos.library.byName({ userId }, { namespace, kind, name });
  if (serve) await repos.library.setServed({ userId }, cap.id, version ?? 1);
  return repos.library.get({ userId }, cap.id);
}
const skillText = (body, extra = '') => `---\nname: tdd\ndescription: Test first\nskills: [plan]\n${extra}---\n${body}\n`;

const REAL = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

try {
  await check('D0', 'public names exported; example id from the spec; handler factories are functions', async () => {
    const want = { core: ['parseContext', 'isContextPath', 'resolveRefs', 'parseCapability', 'buildExtractPrompt', 'parseExtractReply', 'contextLimits', 'CONTEXT_VERSION'],
      worker: ['contextPass', 'withContextPass', 'extractHandler', 'spawnClaude', 'linkCapability', 'syncCapabilities', 'withCapabilityLinks', 'contextWorkerLimits'] };
    assert.deepEqual([...want.core.filter((n) => !(n in C)).map((n) => `core.${n}`), ...want.worker.filter((n) => !(n in W)).map((n) => `worker.${n}`)], []);
    const p = parse('specs/007-ctc/spec.md', '| | T2.1 ids | graph.ids |\n');
    assert.deepEqual(p.nodes.map((n) => n.id), ['ctx:specs/007-ctc/spec:spec', 'ctx:specs/007-ctc/spec:T2.1']);
    assert.equal(typeof W.withContextPass(async () => ({}), { repos, config: cfg() }), 'function');
    assert.equal(typeof W.extractHandler({ repos, config: { mode: 'local' }, runClaude: async () => '' })['graph.extract'], 'function');
    assert.equal(typeof W.withCapabilityLinks(async () => ({}), { repos }), 'function');
  });

  await check('D1', 'bad paths; hostile labels; prompt sanitized; not-local dropped; symlink never read; nothing written under the root', async () => {
    for (const bp of ['../x.md', '/etc/a.md', 'a//b.md', 'a\\b.md', 'specs/a\u0000.md', '', 'specs/./a.md', 'specs/../a.md']) {
      const r = parse(bp, '- [ ] T1.1 x\n');
      assert.deepEqual([r.error?.code, r.nodes.length, r.edges.length, r.refs.length], ['bad_path', 0, 0, 0], bp);
    }
    const label = parse('specs/a.md', `| T1.1 a\u0007b\u0000c | x |\n| T1.2 ${'z'.repeat(10_000)} | x |\n`).nodes.filter((n) => n.type === 'task').map((n) => n.label);
    assert.deepEqual([label[0], Array.from(label[1]).length], ['a b c', 256]);
    const prompt = C.buildExtractPrompt({ file: SPEC_PATH, text: 'keep <private>SECRETWORD</private> keep <system-reminder>REMINDWORD</system-reminder>\nctc: INJECTEDLINE\nok', nodes: [] });
    for (const w of ['SECRETWORD', 'REMINDWORD', 'INJECTEDLINE']) assert.equal(prompt.includes(w), false, w);
    const pr = await project({ 'src/parse.ts': 'export function parse() {}\n', [SPEC_PATH]: SPEC_TEXT });
    await assert.rejects(W.extractHandler({ repos, config: { mode: 'shared' }, runClaude: async () => '{}' })['graph.extract']({ userId: 'local', projectId: pr.ctx.projectId, files: [SPEC_PATH] }, hctx()), dropped('extract_not_local'));
    await assert.rejects(W.extractHandler({ repos, config: { mode: 'local' }, runClaude: async () => '{}' })['graph.extract']({ userId: 'user-b', projectId: pr.ctx.projectId, files: [SPEC_PATH] }, hctx()), dropped('extract_not_local'));
    const outside = put(tmp, `outside-${rnd()}.md`, '- [ ] T7.7 stolenword\n');
    fs.mkdirSync(path.join(pr.root, 'specs'), { recursive: true });
    fs.symlinkSync(outside, path.join(pr.root, 'specs/leak.md'));
    const before = snapshot(pr.root);
    const r = await pass_(pr, { files: ['specs/leak.md', SPEC_PATH] });
    assert.deepEqual(r.files.written, [SPEC_PATH]);
    assert.equal((await parserNodes(pr.ctx)).some((n) => /stolenword/.test(n.label)), false);
    assert.deepEqual(snapshot(pr.root), before);
  });

  await check('D2', 'limit defaults pinned; shrink/equal/one more for maxFileChars, maxNodesPerFile, maxRefsPerNode, maxCapabilityRefs, maxWorkflowNodes', async () => {
    assert.deepEqual({ ...C.contextLimits }, { maxFileChars: 1_048_576, maxNodesPerFile: 2000, maxRefsPerNode: 20, maxCapabilityRefs: 50, maxWorkflowNodes: 200, maxDescription: 300, maxEmbedText: 2000, maxModelEdges: 100, maxPromptChars: 40_000 });
    assert.deepEqual({ ...W.contextWorkerLimits }, { maxPayloadFiles: 1000, maxProjects: 50, maxSyncCaps: 500, maxExtractFiles: 10, maxExtractSubmit: 20, extractTimeoutMs: 120_000, extractMaxReplyChars: 200_000, resultListMax: 100 });
    await withLimits(C.contextLimits, { maxFileChars: 50 }, () => {
      const exact = '- [ ] T1.1 ' + 'a'.repeat(39);
      assert.equal(exact.length, 50);
      assert.deepEqual([parse('specs/a.md', exact).error, parse('specs/a.md', exact).nodes.length], [null, 2]);
      const over = parse('specs/a.md', exact + 'a');
      assert.deepEqual([over.error?.code, over.nodes.length], ['too_large', 0]);
    });
    await withLimits(C.contextLimits, { maxNodesPerFile: 2 }, () => {
      const r = parse('specs/a.md', '- [ ] T1 a\n- [ ] T2 b\n- [ ] T3 c\n');
      assert.deepEqual([r.nodes.filter((n) => n.type === 'task').map((n) => n.id.split(':').pop()), r.truncated], [['T1', 'T2'], true]);
    });
    await withLimits(C.contextLimits, { maxRefsPerNode: 2 }, () => {
      assert.deepEqual(parse('specs/a.md', '| T1.1 a/b.ts c/d.ts e/f.ts | x |\n').refs.map((x) => x.target), ['a/b.ts', 'c/d.ts']);
    });
    await withLimits(C.contextLimits, { maxCapabilityRefs: 2 }, () => {
      const out = C.parseCapability({ ...SKILL, frontmatter: {}, body: 'skill:a skill:b skill:c' });
      assert.deepEqual(out.edges.map((e) => e.dst), ['skill:a', 'skill:b']);
    });
    await withLimits(C.contextLimits, { maxWorkflowNodes: 2 }, () => {
      assert.equal(C.parseCapability(WF).nodes.filter((n) => n.type === 'workflow_step').length, 2);
    });
  });

  await check('D3', 'shapes: nodes, edges, refs, hashes, ordering, determinism, frozen input, version', async () => {
    assert.equal(C.CONTEXT_VERSION, 'ctc-ctx-1');
    const input = deepFreeze({ path: SPEC_PATH, content: SPEC_TEXT });
    const r = C.parseContext(input);
    assert.deepEqual(C.parseContext(input), r);
    assert.deepEqual([r.file, r.error, r.truncated], [SPEC_PATH, null, false]);
    const t12 = r.nodes.find((n) => n.id === SP('T1.2'));
    assert.deepEqual({ ...cut(t12, 'kind', 'type', 'label', 'sourceLocation'), lines: t12.meta.lines }, { kind: 'context', type: 'task', label: 'second cell label', sourceLocation: 'L12', lines: [12, 12] });
    assert.equal(t12.contentHash, sha(`ctc-ctx-1\0${SP('T1.2')}\0task\0second cell label\0${SPEC_LINES[11]}`));
    assert.deepEqual(r.edges, [...r.edges].sort(edgeCmp));
    assert.deepEqual(r.edges.every((e) => e.confidence === 'EXTRACTED' && e.score === 1 && e.relation === 'part_of' && e.dst === SP('spec')), true);
    assert.deepEqual(parse('docs/readme.md', '- [ ] T1 x\n'), { file: 'docs/readme.md', nodes: [], edges: [], refs: [], truncated: false, error: null });
  });

  await check('D4', 'isContextPath table; dispatch (CLAUDE.md and issue files skip the document rules; skills are not parsed)', async () => {
    const yes = ['CLAUDE.md', 'specs/a.md', 'specs/007-ctc/spec.md', '.scratch/f/spec.md', '.scratch/f/issues/01-a.md', '.claude/prds/x.md', '.claude/plans/y.md', '.claude/plans/sub/y.md'];
    const no = ['sub/CLAUDE.md', 'claude.md', 'specs/a.txt', 'specs/', 'specs.md', 'docs/a.md', '.claude/skills/x/SKILL.md', '.claude/agents/a.md', '.claude/commands/c.md', 'README.md', '.scratch/x.txt', 'specs', 'Specs/a.md'];
    assert.deepEqual([yes.filter((p) => !C.isContextPath(p)), no.filter((p) => C.isContextPath(p))], [[], []]);
    assert.equal(C.parseContext({ path: '.claude/skills/x/SKILL.md', content: '- [ ] T1 x\n' }).nodes.length, 0);
    assert.deepEqual(parse('CLAUDE.md', '- [ ] T1.1 not a task here\n- 2026-10-20 \u2014 A decision.\n').nodes.map((n) => n.id), ['ctx:CLAUDE:D2026-10-20']);
    assert.deepEqual(parse(ISSUE_PATH, ISSUE_TEXT + '- [ ] T5.5 inner checklist\n').nodes.map((n) => n.id), ['ctx:.scratch/feat-x/issues/03-links:issue-03']);
  });

  await check('D5', 'document rules: ids, types, labels, meta, fences, duplicates, part_of, CRLF/BOM, bold ids, escaped pipes; real repo documents', async () => {
    const r = parse(SPEC_PATH, SPEC_TEXT);
    assert.deepEqual(r.nodes.map(brief), [
      { id: SP('spec'), type: 'spec', label: 'Demo thing', loc: 'L1' }, { id: SP('US1'), type: 'requirement', label: 'Load a file', loc: 'L3' },
      { id: SP('FR-001'), type: 'requirement', label: 'The system MUST load files from `src/load.ts::loadFile`.', loc: 'L4' }, { id: SP('SC-001'), type: 'requirement', label: 'Load in under 1 s.', loc: 'L5' },
      { id: SP('T1.1'), type: 'task', label: 'parse files in `src/parse.ts` and `./lib/a.ts::go`', loc: 'L11' }, { id: SP('T1.2'), type: 'task', label: 'second cell label', loc: 'L12' },
      { id: SP('D1'), type: 'decision', label: 'pick sqlite', loc: 'L13' }, { id: SP('T1.3'), type: 'task', label: 'finish checklist item', loc: 'L14' }, { id: SP('T2.0'), type: 'task', label: 'heading task', loc: 'L16' }]);
    const m = (id) => r.nodes.find((n) => n.id === SP(id)).meta;
    assert.deepEqual([m('spec').lines, m('T1.3').done, m('T1.3').parallel, m('US1').priority, m('D1').value, m('T1.3').lines], [[1, 16], true, true, 'P1', '**sqlite**, see `docs/db.md`', [14, 14]]);
    assert.deepEqual(r.edges.map((e) => e.src), ['FR-001', 'SC-001', 'T1.1', 'T1.2', 'T1.3', 'T2.0', 'US1'].map(SP));
    const crlf = parse(SPEC_PATH, '\uFEFF' + SPEC_LINES.join('\r\n') + '\r\n');
    assert.deepEqual(crlf.nodes.map(brief), r.nodes.map(brief));
    const odd = parse('specs/b.md', '| **T3.1** | bold id | x |\n| T3.2 has a\\|pipe | x |\n- [ ] T3.3\n- D4: bullet decision\n## T3.4\n');
    assert.deepEqual(odd.nodes.map((n) => [n.id.split(':').pop(), n.label]), [['T3.1', 'bold id'], ['T3.2', 'has a\\|pipe'], ['T3.3', 'T3.3'], ['D4', 'bullet decision'], ['T3.4', 'T3.4'], ['spec', 'b']].sort((a, b) => (a[0] === 'spec' ? -1 : b[0] === 'spec' ? 1 : 0)));
    assert.deepEqual(parse('specs/c.md', '| D1 | only a decision | x |\n').nodes.map((n) => n.type), ['decision']);
    const ids = (p, type) => new Set(parse(p, REAL(p)).nodes.filter((n) => n.type === type).map((n) => n.id.split(':').pop()));
    const want007 = ['T0.1', 'T0.2', 'T0.3', 'T1.1', 'T1.2', 'T1.3', 'T1.4', 'T2.1', 'T2.2', 'T2.3', 'T2.4', 'T3.1', 'T3.2', 'T3.3', 'T4.1', 'T4.2', 'T4.3', 'T5.1', 'T5.2', 'T6.1', 'T6.2', 'T6.3', 'T7.1', 'T7.2'];
    const t7 = ids('specs/007-ctc/spec.md', 'task');
    assert.deepEqual([want007.filter((x) => !t7.has(x)), [...ids('specs/007-ctc/spec.md', 'decision')].filter((x) => /^D\d+$/.test(x)).length >= 10], [[], true]);
    assert.ok(ids('specs/006-merged-core/spec.md', 'task').size >= 24);
    assert.ok(ids('specs/002-context-coding-graph/tasks.md', 'task').size >= 55);
    const reqs = [...ids('specs/002-context-coding-graph/spec.md', 'requirement')];
    assert.deepEqual([reqs.filter((x) => x.startsWith('FR-')).length >= 30, reqs.filter((x) => x.startsWith('SC-')).length >= 7, reqs.filter((x) => /^US\d+$/.test(x)).length >= 8], [true, true, true]);
  });

  await check('D6', 'issue file (ticket = task, part_of ref, Touches refs, fences) and CLAUDE.md dated decisions (ids, labels, lines, refs)', async () => {
    const i = parse(ISSUE_PATH, ISSUE_TEXT);
    const id = 'ctx:.scratch/feat-x/issues/03-links:issue-03';
    assert.deepEqual(i.nodes.map(brief), [{ id, type: 'task', label: 'Links and build (G3)', loc: 'L1' }]);
    assert.deepEqual([i.nodes[0].meta.lines, i.nodes[0].meta.status, i.nodes[0].meta.blockedBy, i.edges], [[1, 11], 'ready-for-agent', '01, 02', []]);
    assert.deepEqual(i.refs, [
      { from: id, relation: 'part_of', kind: 'node', target: 'ctx:.scratch/feat-x/spec:spec', line: 1 },
      { from: id, relation: 'implements', kind: 'path', target: 'src/ctc/graph/link.py', line: 5 }, { from: id, relation: 'implements', kind: 'path', target: 'src/ctc/graph/build.py', line: 5 },
      { from: id, relation: 'implements', kind: 'path', target: 'tests/test_link.py', line: 5 }, { from: id, relation: 'implements', kind: 'path_symbol', target: 'lib/z.ts::go', line: 11 }]);
    assert.equal(parse('.scratch/f/issues/12-x.md', '# x\n').nodes[0].id, 'ctx:.scratch/f/issues/12-x:issue-12');
    const c = parse('CLAUDE.md', CLAUDE_TEXT);
    const D = (s) => `ctx:CLAUDE:${s}`;
    assert.deepEqual(c.nodes.map(brief), [
      { id: D('D2026-10-20'), type: 'decision', label: 'Built from scratch: refs only, see `src/a.ts::x`', loc: 'L4' },
      { id: D('D2026-10-20-2'), type: 'decision', label: 'Second on the same day', loc: 'L6' }, { id: D('D2026-10-21'), type: 'decision', label: 'Hyphen separator works', loc: 'L7' }]);
    assert.deepEqual([c.nodes[0].meta.lines, c.nodes[0].meta.date, c.nodes[1].meta.lines, c.edges], [[4, 5], '2026-10-20', [6, 6], []]);
    assert.deepEqual(c.refs, [{ from: D('D2026-10-20'), relation: 'decides', kind: 'path_symbol', target: 'src/a.ts::x', line: 4 }]);
    assert.ok(parse('CLAUDE.md', REAL('CLAUDE.md')).nodes.length >= 20);
  });

  await check('D7', 'worker writes origin parser rows with the parsed shapes, graph_sources and ast rows untouched, no other origin touched', async () => {
    const pr = await project({ 'src/parse.ts': 'export function parse() {}\n', 'lib/a.ts': 'export function go() {}\n', 'docs/db.md': '# DB\n', [SPEC_PATH]: SPEC_TEXT, 'CLAUDE.md': CLAUDE_TEXT });
    await ast(pr);
    const src0 = await repos.graph.listSources(pr.ctx);
    const astRows0 = stripTime((await repos.graph.loadGraph(pr.ctx)).nodes);
    const r = await pass_(pr);
    assert.deepEqual([r.counts.written, r.files.written], [2, ['CLAUDE.md', SPEC_PATH]]);
    assert.deepEqual(await repos.graph.listSources(pr.ctx), src0);
    assert.deepEqual(stripTime((await repos.graph.loadGraph(pr.ctx)).nodes.filter((n) => n.origin === 'ast')), astRows0.filter((n) => n.origin === 'ast'));
    const nodes = await parserNodes(pr.ctx, SPEC_PATH);
    assert.deepEqual(nodes.map((n) => n.id).sort(byCode), C.parseContext({ path: SPEC_PATH, content: SPEC_TEXT }).nodes.map((n) => n.id).sort(byCode));
    assert.deepEqual([...new Set(nodes.map((n) => n.kind))], ['context']);
    const page = (await repos.graph.loadGraph(pr.ctx)).nodes.find((n) => n.sourceFile === 'docs/db.md' && n.type === 'page');
    const got = (await edgesOf(pr.ctx, 'parser', (e) => e.relation !== 'part_of' && e.src.startsWith('ctx:specs/'))).map((e) => [e.src, e.dst, e.relation, e.confidence, e.score]).sort((a, b) => byCode(a.join(), b.join()));
    assert.deepEqual(got, [[SP('D1'), page.id, 'decides', 'EXTRACTED', 1], [SP('T1.1'), sid('lib/a.ts', 'go'), 'implements', 'EXTRACTED', 1], [SP('T1.1'), fid('src/parse.ts'), 'implements', 'EXTRACTED', 1]].sort((a, b) => byCode(a.join(), b.join())));
    assert.equal((await edgesOf(pr.ctx, 'parser', (e) => e.relation === 'part_of')).length, 7);
  });

  await check('D8', 'silence rule: judgment comments in the new sources', async () => {
    const files = [...fs.readdirSync(path.join(ROOT, 'packages/core/src/context'), { recursive: true, encoding: 'utf8' }), ...fs.readdirSync(path.join(ROOT, 'apps/worker/src/context'), { recursive: true, encoding: 'utf8' })];
    assert.ok(files.length > 6);
    const src = [['packages/core/src/context', 'parse.ts'], ['packages/core/src/context', 'refs.ts'], ['apps/worker/src/context', 'pass.ts'], ['apps/worker/src/context', 'capability.ts'], ['apps/worker/src/context', 'extract.ts']]
      .map(([d, f]) => (fs.existsSync(path.join(ROOT, d, f)) ? fs.readFileSync(path.join(ROOT, d, f), 'utf8') : '')).join('\n');
    assert.ok((src.match(/judgment:/g) ?? []).length >= 5, 'at least 5 `judgment:` comments across parse/refs/pass/capability/extract');
  });

  await check('D9', 'refs: token rules, relations, dedup, caps, URL/dotted names ignored; resolveRefs tiers, ambiguity, inferred, order, frozen input', async () => {
    const r = parse(SPEC_PATH, SPEC_TEXT);
    assert.deepEqual(r.refs.map((x) => [x.from, x.relation, x.kind, x.target, x.line]), [
      [SP('T1.1'), 'implements', 'path', 'src/parse.ts', 11], [SP('T1.1'), 'implements', 'path_symbol', 'lib/a.ts::go', 11], [SP('D1'), 'decides', 'path', 'docs/db.md', 13]]);
    const t = parse('specs/x.md', '| T1.1 see https://example.com/a/b.html and a.b.c and v1.2 and `x/y.ts` and x/y.ts and w/z.ts::Sym() | x |\n').refs.map((x) => `${x.kind}:${x.target}`);
    assert.deepEqual(t, ['path:x/y.ts', 'path_symbol:w/z.ts::Sym']);
    const n = (id, type, label, sourceFile) => ({ id, type, label, sourceFile });
    const nodes = deepFreeze([n('code:f', 'file', 'src/parse.ts', 'src/parse.ts'), n('code:f_parse', 'function', 'parse', 'src/parse.ts'), n('code:a', 'file', 'lib/a.ts', 'lib/a.ts'), n('code:a_go', 'method', 'go()', 'lib/a.ts'),
      n('code:b_dup1', 'function', 'dup', 'lib/b.ts'), n('code:b_dup2', 'function', 'dup', 'lib/b.ts'), n('code:d1', 'function', 'many', 'lib/d.ts'), n('code:d2', 'function', 'many', 'lib/d.ts'), n('code:d3', 'function', 'many', 'lib/d.ts'), n('code:d4', 'function', 'many', 'lib/d.ts'),
      n('code:p', 'page', 'docs/p.md', 'docs/p.md'), n('ctx:x:spec', 'spec', 'x', 'x.md'), n('code:syn', 'file', '<packages>', '<packages>'), n('<cap:skill:tdd>', 'skill', 'tdd', '<cap:skill:tdd>'), n('code:nul', 'file', 'nul', null)]);
    const ref = (kind, target, relation = 'implements') => ({ from: 'ctx:t', relation, kind, target, line: 4 });
    const refs = deepFreeze([ref('path', 'src/parse.ts'), ref('path_symbol', 'lib/a.ts::go'), ref('path_symbol', 'lib/b.ts::dup'), ref('path_symbol', 'lib/a.ts::missing'), ref('path', 'nowhere.ts'), ref('node', 'ctx:x:spec', 'part_of'),
      ref('node', 'ctx:none:spec', 'part_of'), ref('path_symbol', 'lib/d.ts::many'), ref('path', 'docs/p.md'), ref('path', '<packages>'), ref('path', 'nul')]);
    const out = C.resolveRefs(refs, nodes);
    const sum = out.map((e) => [e.src, e.dst, e.relation, e.confidence, e.score, e.sourceLocation]);
    assert.deepEqual(sum, [
      ['ctx:t', 'code:a', 'implements', 'INFERRED', 0.6, 'L4'], ['ctx:t', 'code:a_go', 'implements', 'EXTRACTED', 1, 'L4'], ['ctx:t', 'code:b_dup1', 'implements', 'AMBIGUOUS', 0.3, 'L4'],
      ['ctx:t', 'code:b_dup2', 'implements', 'AMBIGUOUS', 0.3, 'L4'], ['ctx:t', 'code:f', 'implements', 'EXTRACTED', 1, 'L4'], ['ctx:t', 'code:p', 'implements', 'EXTRACTED', 1, 'L4'], ['ctx:t', 'ctx:x:spec', 'part_of', 'EXTRACTED', 1, 'L4']]);
    const inf = C.resolveRefs(refs, nodes, { inferred: true }).map((e) => [e.dst, e.confidence, e.score]);
    assert.deepEqual(inf.filter((x) => x[0] === 'code:f' || x[0] === 'code:b_dup1'), [['code:b_dup1', 'AMBIGUOUS', 0.3], ['code:f', 'INFERRED', 0.6]]);
    assert.deepEqual(C.resolveRefs(refs, nodes), out);
  });

  await check('D10', 'context pass: scope, unchanged skip, one-file edit, force, deletion order, truncation keeps rows, epoch/inval, submit, abort', async () => {
    const files = { 'src/parse.ts': 'export function parse() {}\n', 'lib/a.ts': 'export function go() {}\n', [SPEC_PATH]: SPEC_TEXT, 'CLAUDE.md': CLAUDE_TEXT, 'README.md': '# Readme\n- [ ] T1.1 not a context path\n' };
    const pr = await project(files, `u-${rnd()}`);
    await ast(pr);
    const calls = []; const subs = [];
    const cache = { epoch: { rotate: async (...a) => { calls.push(['rotate', ...a]); return 'e1'; } }, publishInval: async (m) => { calls.push(['inval', m]); } };
    const submit = async (i) => { subs.push(i); };
    const r1 = await pass_(pr, { cache, submit });
    assert.deepEqual([r1.mode, r1.counts.candidates, r1.counts.written, r1.counts.unchanged, r1.epoch], ['full', 2, 2, 0, 'e1']);
    assert.deepEqual(calls.map((c) => c[0]), ['rotate', 'inval']);
    assert.deepEqual(calls[1][1], { v: 1, event: 'graph.rebuild', userId: pr.ctx.userId, projectId: pr.ctx.projectId });
    assert.equal(subs.length, 2);
    const s0 = subs.find((s) => s.payload.files[0] === SPEC_PATH);
    assert.deepEqual([s0.queue, s0.kind, s0.payload, s0.id.startsWith(`graph.extract:${pr.ctx.projectId}:`) && /^[0-9a-f]{16}$/.test(s0.id.slice(`graph.extract:${pr.ctx.projectId}:`.length))], ['graph', 'extract', { userId: pr.ctx.userId, projectId: pr.ctx.projectId, files: [SPEC_PATH] }, true]);
    const rows1 = await parserNodes(pr.ctx);
    calls.length = 0; subs.length = 0;
    const r2 = await pass_(pr, { cache, submit });
    assert.deepEqual([r2.counts.written, r2.counts.unchanged, calls.length, subs.length], [0, 2, 0, 0]);
    assert.deepEqual(await parserNodes(pr.ctx), rows1);
    pr.put(SPEC_PATH, SPEC_TEXT.replace('second cell label', 'changed label'));
    const claudeRowsBefore = rows1.filter((n) => n.sourceFile === 'CLAUDE.md');
    const r3 = await pass_(pr, { cache, submit });
    assert.deepEqual([r3.files.written, r3.counts.unchanged], [[SPEC_PATH], 1]);
    assert.deepEqual((await parserNodes(pr.ctx)).filter((n) => n.sourceFile === 'CLAUDE.md'), claudeRowsBefore);
    assert.equal((await parserNodes(pr.ctx, SPEC_PATH)).find((n) => n.id === SP('T1.2')).label, 'changed label');
    const r4 = await pass_(pr, { force: true });
    assert.deepEqual([r4.counts.written, r4.counts.unchanged], [2, 0]);
    const m = await pass_(pr, { files: ['README.md', SPEC_PATH, 'src/parse.ts'] });
    assert.deepEqual([m.mode, m.counts.ignored, m.counts.candidates, m.counts.unchanged], ['files', 2, 1, 1]);
    await assert.rejects(pass_(pr, { signal: AbortSignal.abort(new Error('stopnow')) }), /stopnow/);
    // deletion: claude rows go first, then parser rows; a truncated walk deletes nothing
    await repos.graph.replaceSource(pr.ctx, { origin: 'claude', sourceFile: SPEC_PATH, nodes: [], edges: [{ src: SP('T1.2'), dst: fid('src/parse.ts'), relation: 'implements', confidence: 'INFERRED', score: 0.6 }] });
    fs.rmSync(path.join(pr.root, SPEC_PATH));
    await withLimits(WG.graphLimits, { maxFiles: 1 }, async () => {
      const t = await pass_(pr);
      assert.deepEqual([t.truncated, t.counts.deleted], [true, 0]);
    });
    assert.ok((await parserNodes(pr.ctx, SPEC_PATH)).length > 0);
    const r5 = await pass_(pr);
    assert.deepEqual([r5.files.deleted, (await parserNodes(pr.ctx, SPEC_PATH)).length, (await edgesOf(pr.ctx, 'claude')).length], [[SPEC_PATH], 0, 0]);
    const r6 = await pass_(pr, { files: ['CLAUDE.md'], submit: async () => { throw new Error('boom'); }, force: true });
    assert.equal(r6.counts.written, 1);
    pr.put(SPEC_PATH, SPEC_TEXT);
    await withLimits(W.contextWorkerLimits, { maxExtractSubmit: 1 }, async () => {
      subs.length = 0;
      await pass_(pr, { force: true, submit });
      assert.equal(subs.length, 1);
    });
  });

  await check('D11', 'embeddings: every pass, any origin, embedText reuse, meta.embedText override, failures tolerated; rebuild.ts exports', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'apps/worker/src/graph/rebuild.ts'), 'utf8');
    for (const re of [/export function embedText/, /export async function readText/, /export const sha\b/, /embedText/]) assert.match(src, re);
    assert.match(src, /meta[^\n]*embedText|embedText[^\n]*meta/);
    const pr = await project({ [SPEC_PATH]: SPEC_TEXT, 'src/parse.ts': 'export function parse() {}\n' }, `u-${rnd()}`);
    await ast(pr);
    const texts = [];
    const embed = async (t) => { texts.push(...t); return t.map(vec); };
    const r = await pass_(pr, { embed });
    assert.ok(r.counts.embedded > 0);
    const have = new Set((await repos.graph.loadVectors(pr.ctx)).map((v) => v.id));
    for (const n of await parserNodes(pr.ctx)) assert.ok(have.has(n.id), `no vector for ${n.id}`);
    assert.ok(texts.includes(`second cell label\n${SPEC_LINES[11]}`), 'task text = label + source line');
    assert.equal((await pass_(pr, { embed })).counts.embedded, 0);
    const u = pr.ctx.userId;
    const cap = await capability(u, { name: 'tdd', text: skillText('Use agent:reviewer.') });
    await W.linkCapability({ repos, userId: u, projectId: pr.ctx.projectId, capId: cap.id });
    texts.length = 0;
    const r2 = await pass_(pr, { files: [], embed });
    assert.equal(r2.counts.embedded, 1);
    assert.deepEqual(texts, ['tdd\nTest first']);
    const down = await pass_(pr, { force: true, embed: async () => { throw new Error('tei down'); } });
    assert.equal(down.counts.embedded, 0);
  });

  await check('D12', 'parseCapability: skill uses edges, hash recipe, workflow steps/contains/invokes, invalid name, frozen input, embedText', async () => {
    const out = C.parseCapability(deepFreeze({ ...SKILL }));
    assert.equal(out.hash, capHash(SKILL));
    assert.deepEqual(out.nodes.map((n) => [n.id, n.kind, n.type, n.label, n.sourceLocation, n.contentHash, n.meta]), [['skill:tdd', 'capability', 'skill', 'tdd', null, out.hash, { description: 'Test first', servedVersion: 2, embedText: 'tdd\nTest first' }]]);
    assert.deepEqual(out.edges.map((e) => [e.src, e.dst, e.relation, e.confidence, e.score, e.sourceLocation]), ['agent:reviewer', 'command:review', 'command:ship', 'skill:plan'].map((d) => ['skill:tdd', d, 'uses', 'EXTRACTED', 1, null]));
    assert.notEqual(C.parseCapability({ ...SKILL, description: 'other' }).hash, out.hash);
    assert.notEqual(C.parseCapability({ ...SKILL, servedVersion: 3 }).hash, out.hash);
    assert.equal(C.parseCapability({ ...SKILL, frontmatter: { commands: 'review, ship', name: 'tdd', skills: ['plan', 'Bad_Name'] } }).hash, out.hash);
    assert.deepEqual(C.parseCapability({ ...SKILL, name: 'Bad Name' }), { nodes: [], edges: [], hash: '' });
    assert.deepEqual(C.parseCapability({ ...SKILL, name: '__proto__' }), { nodes: [], edges: [], hash: '' });
    const agent = C.parseCapability({ ...SKILL, kind: 'agent', name: 'rev', frontmatter: { skills: 'tdd,plan' }, body: '' });
    assert.deepEqual([agent.nodes[0].id, agent.nodes[0].type, agent.edges.map((e) => e.dst)], ['agent:rev', 'agent', ['skill:plan', 'skill:tdd']]);
    const wf = C.parseCapability(deepFreeze(structuredClone(WF)));
    assert.deepEqual(wf.nodes.map((n) => [n.id, n.type, n.label, n.meta.nodeType ?? null]), [['workflow:ship-it', 'workflow', 'ship-it', null], ['workflow:ship-it:start', 'workflow_step', 'start', 'trigger'],
      ['workflow:ship-it:impl', 'workflow_step', 'impl', 'agent'], ['workflow:ship-it:gate', 'workflow_step', 'gate', 'approval']]);
    assert.equal(wf.nodes[2].contentHash, sha(`${wf.hash}\0impl`));
    const want = [['workflow:ship-it', 'workflow:ship-it:start', 'contains'], ['workflow:ship-it', 'workflow:ship-it:impl', 'contains'], ['workflow:ship-it', 'workflow:ship-it:gate', 'contains'],
      ['workflow:ship-it:impl', 'skill:tdd', 'invokes'], ['workflow:ship-it:impl', 'command:review', 'invokes'], ['workflow:ship-it:gate', 'agent:reviewer', 'invokes']].map(([src, dst, relation]) => ({ src, dst, relation }));
    assert.deepEqual(wf.edges.map((e) => ({ src: e.src, dst: e.dst, relation: e.relation })), want.sort(edgeCmp));
    assert.deepEqual(C.parseCapability({ ...WF, frontmatter: { name: 'ship-it', nodes: 'nope' } }).nodes.length, 1);
    const hostile = JSON.parse('{"__proto__": {"skills": ["evil"]}, "constructor": 1}');
    assert.doesNotThrow(() => C.parseCapability({ ...SKILL, frontmatter: hostile }));
  });

  await check('D13', 'linkCapability: linked/unchanged/relinked/removed/skipped reasons, duplicate-name tie-break, all projects, sync, wrapper', async () => {
    const u = `u-${rnd()}`;
    const p1 = await project({}, u); const p2 = await project({}, u); const other = await project({}, `u-${rnd()}`);
    const cap = await capability(u, { name: 'tdd', text: skillText('Use agent:reviewer.') });
    const link = (pr, c = cap) => W.linkCapability({ repos, userId: u, projectId: pr.ctx.projectId, capId: c.id });
    const r1 = await link(p1);
    assert.deepEqual([r1.status, r1.capId, r1.projectId], ['linked', cap.id, p1.ctx.projectId]);
    const node = await repos.graph.getNode(p1.ctx, 'skill:tdd');
    assert.deepEqual([node.type, node.kind, node.origin, node.sourceFile, node.label], ['skill', 'capability', 'parser', '<cap:skill:tdd>', 'tdd']);
    assert.deepEqual((await edgesOf(p1.ctx, 'parser')).map((e) => [e.src, e.dst, e.relation]).sort((a, b) => byCode(a.join(), b.join())), [['skill:tdd', 'agent:reviewer', 'uses'], ['skill:tdd', 'skill:plan', 'uses']]);
    assert.equal((await link(p1)).status, 'unchanged');
    assert.equal((await repos.graph.listSources(p1.ctx)).length, 0);
    assert.equal(await repos.graph.getNode(p2.ctx, 'skill:tdd'), null);
    assert.equal(await repos.graph.getNode(other.ctx, 'skill:tdd'), null);
    const b2 = L.buildVersion({ kind: 'skill', namespace: 'user', defaultName: 'tdd', rootPath: '/virtual/skills/tdd', mainPath: 'SKILL.md', files: [{ path: 'SKILL.md', bytes: Buffer.from(skillText('Use agent:other.')) }] });
    await repos.library.createVersion({ userId: u }, b2.input);
    await repos.library.setServed({ userId: u }, cap.id, 2);
    const fresh = await repos.library.get({ userId: u }, cap.id);
    assert.equal((await link(p1, fresh)).status, 'linked');
    assert.ok((await edgesOf(p1.ctx, 'parser')).some((e) => e.dst === 'agent:other') && !(await edgesOf(p1.ctx, 'parser')).some((e) => e.dst === 'agent:reviewer'));
    const noServe = await capability(u, { name: 'later', text: skillText('x').replace('name: tdd', 'name: later'), serve: false });
    assert.deepEqual([(await link(p1, noServe)).status, (await link(p1, noServe)).reason], ['skipped', 'no_served_version']);
    const dup = await capability(u, { name: 'tdd', namespace: 'zzz', text: skillText('Use agent:dup.') });
    assert.deepEqual([(await link(p1, dup)).status, (await link(p1, dup)).reason], ['skipped', 'duplicate_name']);
    assert.deepEqual([(await W.linkCapability({ repos, userId: u, projectId: p1.ctx.projectId, capId: '00000000-0000-0000-0000-000000000000' })).reason], ['not_found']);
    // wrapper: inner first, then every project of the user; a failing project does not fail the job
    const bad = { ...repos, graph: { ...repos.graph, replaceSource: async (ctx, ...a) => { if (ctx.projectId === p2.ctx.projectId) throw new Error('boom'); return repos.graph.replaceSource(ctx, ...a); } } };
    const wrapped = W.withCapabilityLinks(async () => ({ ok: 1 }), { repos: bad });
    const res = await wrapped({ userId: u, capId: fresh.id, version: 2 }, hctx());
    assert.deepEqual([res.ok, res.graph.projects, res.graph.failed, res.graph.unchanged, res.graph.linked], [1, 2, 1, 1, 0]);
    await assert.rejects(W.withCapabilityLinks(async () => { throw new Error('inner'); }, { repos })({ userId: u, capId: fresh.id, version: 2 }, hctx()), /inner/);
    assert.equal(await repos.graph.getNode(p2.ctx, 'skill:tdd'), null);
    assert.deepEqual((await W.withCapabilityLinks(async () => 5, { repos })({ userId: u, capId: fresh.id, version: 2 }, hctx())).result, 5);
    await withLimits(W.contextWorkerLimits, { maxProjects: 1 }, async () => {
      const r = await W.withCapabilityLinks(async () => ({}), { repos })({ userId: u, capId: fresh.id, version: 2 }, hctx());
      assert.equal(r.graph.projects, 1);
    });
    // sync into a project created later; removal
    const p3 = await project({}, u);
    const s = await W.syncCapabilities({ repos, ctx: p3.ctx });
    assert.deepEqual([s.linked, s.skipped, s.unchanged, await repos.graph.getNode(p3.ctx, 'skill:tdd') !== null], [1, 2, 0, true]);
    assert.equal((await W.syncCapabilities({ repos, ctx: p3.ctx })).linked, 0);
    await repos.library.markRemoved({ userId: u }, fresh.id);
    assert.equal((await link(p1, fresh)).status, 'removed');
    assert.equal(await repos.graph.getNode(p1.ctx, 'skill:tdd'), null);
  });

  await check('D14', 'extract prompt layout/sanitize/cut; reply forms, strict validation, drops, cap, never throws', async () => {
    const nodes = [{ id: SP('T1.1'), type: 'task', label: 'parse files' }, { id: SP('D1'), type: 'decision', label: 'pick sqlite' }];
    const p = C.buildExtractPrompt({ file: SPEC_PATH, text: 'hello doc', nodes });
    assert.deepEqual(C.buildExtractPrompt({ file: SPEC_PATH, text: 'hello doc', nodes }), p);
    const lines = p.split('\n');
    assert.equal(lines.at(-1), 'Reply with JSON only: {"edges":[{"from":"<id>","relation":"implements|decides","to":"<path>[::symbol]"}]}');
    for (const w of ['T1.1 | task | parse files', 'D1 | decision | pick sqlite', '<<<DOC', 'DOC>>>', 'hello doc']) assert.ok(lines.includes(w) || lines.some((l) => l === w), w);
    assert.ok(lines.indexOf('<<<DOC') < lines.indexOf('hello doc') && lines.indexOf('hello doc') < lines.indexOf('DOC>>>'));
    await withLimits(C.contextLimits, { maxPromptChars: 10 }, () => {
      const cutp = C.buildExtractPrompt({ file: SPEC_PATH, text: 'abcdefghijKLMNOP', nodes: [] });
      assert.ok(cutp.includes('abcdefghij') && !cutp.includes('abcdefghijK'));
    });
    const o = { file: SPEC_PATH, nodes: deepFreeze([{ id: SP('T1.1'), type: 'task' }, { id: SP('D1'), type: 'decision' }]) };
    const good = '{"edges":[{"from":"T1.1","relation":"implements","to":"./src/parse.ts"},{"from":"D1","relation":"decides","to":"docs/db.md::x"},{"from":"D1","relation":"decides","to":"docs/db.md::x"},' +
      '{"from":"D1","relation":"implements","to":"src/a.ts"},{"from":"T9","relation":"implements","to":"src/a.ts"},{"from":"T1.1","relation":"implements","to":"not a path"},{"from":"T1.1","relation":"serves","to":"src/a.ts"},5]}';
    const want = { ok: true, edges: [{ src: SP('T1.1'), relation: 'implements', kind: 'path', target: 'src/parse.ts' }, { src: SP('D1'), relation: 'decides', kind: 'path_symbol', target: 'docs/db.md::x' }], dropped: 6 };
    assert.deepEqual(C.parseExtractReply(good, o), want);
    assert.deepEqual(C.parseExtractReply('```json\n' + good + '\n```', o), want);
    assert.deepEqual(C.parseExtractReply('Sure! Here it is: ' + good + ' Hope it helps.', o), want);
    for (const junk of ['', 'null', '[]', '{"edges":5}', '{', 'no json here', '{"edges":{}}', '\u0000'.repeat(10), 'x'.repeat(1_000_000)]) {
      const r = C.parseExtractReply(junk, o);
      assert.deepEqual([r.ok, r.code, r.message?.includes('no json here')], [false, 'bad_reply', false], junk.slice(0, 20));
    }
    await withLimits(C.contextLimits, { maxModelEdges: 2 }, () => {
      const many = JSON.stringify({ edges: ['a', 'b', 'c'].map((n) => ({ from: 'T1.1', relation: 'implements', to: `src/${n}.ts` })) });
      const r = C.parseExtractReply(many, o);
      assert.deepEqual([r.edges.map((e) => e.target), r.dropped], [['src/a.ts', 'src/b.ts'], 1]);
    });
  });

  await check('D15', 'extract job: INFERRED claude edges, parser edge kept, replace/clear, failures, ENOENT dropped, guards; spawnClaude with a fake binary', async () => {
    const pr = await project({ 'src/parse.ts': 'export function parse() {}\n', 'src/other.ts': 'export function other() {}\n', [SPEC_PATH]: SPEC_TEXT, 'specs/empty.md': '# Nothing here\n' });
    await ast(pr); await pass_(pr);
    const prompts = [];
    let reply = JSON.stringify({ edges: [{ from: 'T1.1', relation: 'implements', to: 'src/parse.ts' }, { from: 'T1.2', relation: 'implements', to: 'src/other.ts' }, { from: 'D1', relation: 'decides', to: 'src/nowhere.ts' }] });
    const mk = (o = {}) => W.extractHandler({ repos, config: { mode: 'local' }, runClaude: async ({ prompt }) => { prompts.push(prompt); return reply; }, ...o })['graph.extract'];
    const payload = (files) => ({ userId: 'local', projectId: pr.ctx.projectId, files });
    const res = await mk()(payload([SPEC_PATH, 'specs/empty.md', 'README.md', 'src/parse.ts']), hctx());
    assert.deepEqual([res.counts, res.files.extracted, res.files.skipped.map((s) => [s.file, s.reason]).sort(), res.files.failed], [{ requested: 4, extracted: 1, edges: 1, skipped: 3, failed: 0 },
      [{ file: SPEC_PATH, edges: 1 }], [['README.md', 'not_context'], ['specs/empty.md', 'no_context_nodes'], ['src/parse.ts', 'not_context']], []]);
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].includes('T1.2 | task | second cell label'));
    const claude = await edgesOf(pr.ctx, 'claude');
    assert.deepEqual(claude.map((e) => [e.src, e.dst, e.relation, e.confidence, e.score]), [[SP('T1.2'), fid('src/other.ts'), 'implements', 'INFERRED', 0.6]]);
    const parserKept = (await edgesOf(pr.ctx, 'parser', (e) => e.src === SP('T1.1') && e.dst === fid('src/parse.ts')))[0];
    assert.deepEqual([parserKept.confidence, parserKept.score], ['EXTRACTED', 1]);
    reply = '{"edges":[]}';
    await mk()(payload([SPEC_PATH]), hctx());
    assert.equal((await edgesOf(pr.ctx, 'claude')).length, 0);
    reply = JSON.stringify({ edges: [{ from: 'T1.2', relation: 'implements', to: 'src/other.ts' }] });
    await mk()(payload([SPEC_PATH]), hctx());
    const parserRows = await parserNodes(pr.ctx, SPEC_PATH);
    reply = 'garbage';
    await assert.rejects(mk()(payload([SPEC_PATH]), hctx()), (e) => /^extract_failed: /.test(e.message) && e.message.includes(`${SPEC_PATH} (bad_reply)`) && e.name !== 'UnrecoverableError');
    assert.equal((await edgesOf(pr.ctx, 'claude')).length, 1, 'a failed extract keeps the previous claude edges');
    assert.deepEqual(await parserNodes(pr.ctx, SPEC_PATH), parserRows);
    await assert.rejects(mk({ runClaude: async () => { throw new Error('exit 2'); } })(payload([SPEC_PATH]), hctx()), /^Error: extract_failed: /);
    await assert.rejects(mk({ runClaude: async () => { throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }); } })(payload([SPEC_PATH]), hctx()), dropped('claude_not_found'));
    await assert.rejects(mk()({ userId: 'local', projectId: 'nope', files: [SPEC_PATH] }, hctx()), dropped('project_not_found'));
    reply = '{"edges":[]}';
    await withLimits(W.contextWorkerLimits, { maxExtractFiles: 1 }, async () => {
      const r = await mk()(payload([SPEC_PATH, 'specs/empty.md']), hctx());
      assert.deepEqual(r.files.skipped.filter((s) => s.reason === 'over_limit').map((s) => s.file), ['specs/empty.md']);
    });
    // spawnClaude with fake binaries
    const bin = (name, body) => { const f = path.join(tmp, name); fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return f; };
    assert.equal(await W.spawnClaude({ bin: bin('echo-claude', 'cat') })({ prompt: 'PROMPT-TEXT', signal: new AbortController().signal }), 'PROMPT-TEXT');
    const args = await W.spawnClaude({ bin: bin('args-claude', 'cat >/dev/null; echo "$@"') })({ prompt: 'x', signal: new AbortController().signal });
    assert.equal(args.trim(), '-p --model haiku');
    const cwd = (await W.spawnClaude({ bin: bin('pwd-claude', 'cat >/dev/null; pwd') })({ prompt: 'x', signal: new AbortController().signal })).trim();
    assert.ok(cwd.startsWith(fs.realpathSync(os.tmpdir())) && !fs.existsSync(cwd) && cwd !== ROOT, `fresh temp cwd removed afterwards: ${cwd}`);
    await assert.rejects(W.spawnClaude({ bin: bin('fail-claude', 'cat >/dev/null; echo SECRETERR >&2; exit 3') })({ prompt: 'x', signal: new AbortController().signal }), (e) => !/SECRETERR/.test(e.message));
    await assert.rejects(W.spawnClaude({ bin: path.join(tmp, 'does-not-exist') })({ prompt: 'x', signal: new AbortController().signal }), (e) => e.code === 'ENOENT');
    const t0 = Date.now();
    await assert.rejects(W.spawnClaude({ bin: bin('slow-claude', 'exec sleep 20'), timeoutMs: 300 })({ prompt: 'x', signal: new AbortController().signal }));
    assert.ok(Date.now() - t0 < 5000, 'timeout kills the process');
    await assert.rejects(W.spawnClaude({ bin: bin('big-claude', 'cat >/dev/null; head -c 5000 /dev/zero | tr "\\0" a'), maxChars: 100 })({ prompt: 'x', signal: new AbortController().signal }));
    const ac = new AbortController(); setTimeout(() => ac.abort(), 150);
    const t1 = Date.now();
    await assert.rejects(W.spawnClaude({ bin: bin('slow2-claude', 'exec sleep 20') })({ prompt: 'x', signal: ac.signal }));
    assert.ok(Date.now() - t1 < 5000);
  });

  await check('D16', 'composition: inner first, error skips the pass, shared mode unchanged, result shape, bootstrap sync, handler key pins', async () => {
    const pr = await project({ 'src/parse.ts': 'export function parse() {}\n', [SPEC_PATH]: SPEC_TEXT });
    const deps = (o = {}) => ({ repos, config: cfg(), ...o });
    const wrapped = W.withContextPass(async () => ({ a: 1 }), deps());
    const payload = { userId: 'local', projectId: pr.ctx.projectId, files: [SPEC_PATH] };
    await assert.rejects(W.withContextPass(async () => { throw new Error('inner'); }, deps())(payload, hctx()), /inner/);
    assert.equal((await parserNodes(pr.ctx)).length, 0);
    assert.deepEqual(await W.withContextPass(async () => ({ a: 1 }), deps({ config: { ...cfg(), mode: 'shared' } }))(payload, hctx()), { a: 1 });
    assert.deepEqual(await W.withContextPass(async () => ({ a: 1 }), deps())({ ...payload, userId: 'user-b' }, hctx()), { a: 1 });
    assert.deepEqual(await W.withContextPass(async () => ({ a: 1 }), deps())({ ...payload, projectId: 'nope' }, hctx()), { a: 1 });
    // capability bootstrap: the user has a library capability and the project graph has no capability node yet
    await capability('local', { name: 'tdd', text: skillText('Use agent:reviewer.') });
    const res = await wrapped(payload, hctx());
    assert.deepEqual([res.a, res.context.counts.written, res.context.mode, res.capabilities.linked >= 1], [1, 1, 'files', true]);
    assert.ok((await repos.graph.getNode(pr.ctx, 'skill:tdd')) !== null);
    assert.equal('capabilities' in (await wrapped(payload, hctx())), false);
    assert.deepEqual((await W.withContextPass(async () => 5, deps())(payload, hctx())).result, 5);
    const rebuild = WG.graphHandlers({ repos, config: cfg(), grammars });
    assert.deepEqual(Object.keys(rebuild), ['graph.rebuild']);
    assert.deepEqual(Object.keys(W.extractHandler({ repos, config: { mode: 'local' }, runClaude: async () => '' })), ['graph.extract']);
    assert.deepEqual(Object.keys(WL.libraryHandlers({ repos, config: { mode: 'local', claude_home: tmp, embed_model: 'm', embed: { skillret_body_chars: 8000 }, library: { roots: [], default_label: 'production', dedup_cosine: 0.97, max_files: 200, max_bytes: 1048576 } } })).sort(), ['library.changed', 'library.scan']);
    assert.deepEqual(Object.keys(W).sort(), ['contextPass', 'contextWorkerLimits', 'extractHandler', 'linkCapability', 'spawnClaude', 'syncCapabilities', 'withCapabilityLinks', 'withContextPass']);
  });

  await check('D17', 'repository: source omitted keeps graph_sources, keepSource, claude edges from parser nodes replaced by file; other origins and users untouched', async () => {
    const pr = await project({}, `u-${rnd()}`); const b = await project({}, `u-${rnd()}`);
    const f = 'doc.md';
    const node = (id) => ({ id, kind: 'context', type: 'task', label: id });
    await repos.graph.replaceSource(pr.ctx, { origin: 'ast', sourceFile: f, nodes: [{ id: 'a1', kind: 'code', type: 'file', label: 'a1' }], edges: [], source: { contentHash: 'h1', extractorVersion: 'v1' } });
    const src0 = await repos.graph.listSources(pr.ctx);
    await repos.graph.replaceSource(pr.ctx, { origin: 'parser', sourceFile: f, nodes: [node('t1'), node('t2')], edges: [{ src: 't1', dst: 'a1', relation: 'implements', confidence: 'EXTRACTED' }] });
    assert.deepEqual(await repos.graph.listSources(pr.ctx), src0);
    await repos.graph.replaceSource(pr.ctx, { origin: 'claude', sourceFile: f, nodes: [], edges: [{ src: 't2', dst: 'a1', relation: 'implements', confidence: 'INFERRED', score: 0.6 }] });
    await repos.graph.replaceSource(pr.ctx, { origin: 'claude', sourceFile: f, nodes: [], edges: [{ src: 't1', dst: 'a1', relation: 'decides', confidence: 'INFERRED', score: 0.6 }] });
    const edges = (await repos.graph.loadGraph(pr.ctx)).edges.map((e) => `${e.origin}:${e.src}:${e.relation}`).sort();
    assert.deepEqual(edges, ['claude:t1:decides', 'parser:t1:implements']);
    await repos.graph.replaceSource(b.ctx, { origin: 'claude', sourceFile: f, nodes: [], edges: [] });
    assert.equal((await repos.graph.loadGraph(pr.ctx)).edges.length, 2);
    await repos.graph.deleteSource(pr.ctx, { origin: 'claude', sourceFile: f, keepSource: true });
    assert.deepEqual((await repos.graph.loadGraph(pr.ctx)).edges.map((e) => e.origin), ['parser']);
    await repos.graph.deleteSource(pr.ctx, { origin: 'parser', sourceFile: f, keepSource: true });
    assert.deepEqual([(await repos.graph.listSources(pr.ctx)).length, (await repos.graph.loadGraph(pr.ctx)).nodes.map((n) => n.id)], [1, ['a1']]);
    await repos.graph.deleteSource(pr.ctx, { origin: 'ast', sourceFile: f });
    assert.equal((await repos.graph.listSources(pr.ctx)).length, 0);
    const cases = fs.readFileSync(path.join(ROOT, 'packages/shared/src/repositories/tenancy.cases.ts'), 'utf8');
    assert.match(cases, /deleteSource/);
  });

  await check('D18', 'must never: root untouched, ast/review rows untouched, other project untouched, frozen inputs, junk never throws, deterministic', async () => {
    const files = { 'src/parse.ts': 'export function parse() {}\n', [SPEC_PATH]: SPEC_TEXT, 'CLAUDE.md': CLAUDE_TEXT };
    const a = await project(files, `u-${rnd()}`); const b = await project(files, `u-${rnd()}`);
    await ast(a); await ast(b); await pass_(a);
    const bBefore = stripTime((await repos.graph.loadGraph(b.ctx)).nodes);
    const astBefore = stripTime((await repos.graph.loadGraph(a.ctx)).nodes.filter((n) => n.origin === 'ast'));
    await repos.graph.reviewEdge(a.ctx, { src: SP('T1.1'), dst: fid('src/parse.ts'), relation: 'implements', confidence: 'CONFIRMED' });
    const snap = snapshot(a.root);
    await pass_(a, { force: true });
    assert.deepEqual(snapshot(a.root), snap);
    assert.deepEqual(stripTime((await repos.graph.loadGraph(a.ctx)).nodes.filter((n) => n.origin === 'ast')), astBefore);
    const reviewed = (await repos.graph.loadGraph(a.ctx)).edges.find((e) => e.src === SP('T1.1') && e.dst === fid('src/parse.ts'));
    assert.deepEqual([reviewed.origin, reviewed.confidence], ['review', 'CONFIRMED']);
    assert.deepEqual(stripTime((await repos.graph.loadGraph(b.ctx)).nodes), bBefore);
    let seed = 7; const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const alphabet = ['|', '-', '[', ']', 'T', '1', '.', ' ', '`', '*', '#', '\n', '\r', 'D', 'FR-', '::', '/', 'a.ts', '\u0000', '\u2014', '\u{1F600}', '```', '__proto__', 'constructor'];
    for (let i = 0; i < 300; i++) {
      const text = Array.from({ length: 1 + Math.floor(rand() * 60) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('');
      const p = ['specs/a.md', 'CLAUDE.md', '.scratch/f/issues/01-x.md', 'weird\u0000.md'][i % 4];
      const input = deepFreeze({ path: p, content: text });
      const r = C.parseContext(input);
      assert.deepEqual(C.parseContext(input), r);
      assert.equal(new Set(r.nodes.map((n) => n.id)).size, r.nodes.length);
      C.parseExtractReply(text, { file: 'specs/a.md', nodes: [] }); C.isContextPath(text);
      C.buildExtractPrompt({ file: p, text, nodes: [] });
      C.parseCapability({ ...SKILL, body: text, description: text.slice(0, 20) });
      C.resolveRefs(r.refs, []);
    }
    assert.doesNotThrow(() => { C.parseContext({ path: SPEC_PATH, content: 'x'.repeat(1_048_577) }); C.parseContext({ path: SPEC_PATH, content: '- [ ] T1.1 ' + 'q'.repeat(1_000_000) }); });
  });

  await check('D19', 'non-goals observable: no skills parsed from .claude, no serves/references, only the four context types, no graph.extract in graphHandlers, tasks.md not linked to spec.md', async () => {
    assert.equal(parse('.claude/skills/x/SKILL.md', REAL('CLAUDE.md')).nodes.length, 0);
    const all = ['specs/007-ctc/spec.md', 'specs/002-context-coding-graph/tasks.md', 'specs/002-context-coding-graph/spec.md', 'CLAUDE.md'].map((p) => parse(p, REAL(p)));
    const types = new Set(all.flatMap((r) => r.nodes.map((n) => n.type)));
    assert.deepEqual([...types].filter((t) => !['spec', 'requirement', 'task', 'decision'].includes(t)), []);
    assert.deepEqual(new Set(all.flatMap((r) => r.edges.map((e) => e.relation))), new Set(['part_of']));
    const tasks = all[1];
    assert.ok(tasks.edges.length > 0 && tasks.edges.every((e) => e.dst === 'ctx:specs/002-context-coding-graph/tasks:spec'));
    assert.equal(Object.hasOwn(WG.graphHandlers({ repos, config: cfg(), grammars }), 'graph.extract'), false);
    const cp = C.parseCapability(SKILL);
    assert.deepEqual([...new Set([...cp.edges, ...C.parseCapability(WF).edges].map((e) => e.relation))].sort(), ['contains', 'invokes', 'uses']);
  });

  await check('D20', 'failure modes: unreadable file keeps rows, embed down / Redis down tolerated, generic claude failure keeps parser rows, capability without served version skipped', async () => {
    const pr = await project({ [SPEC_PATH]: SPEC_TEXT, 'CLAUDE.md': CLAUDE_TEXT });
    await ast(pr);
    const bad = { epoch: { rotate: async () => { throw new Error('redis down'); } }, publishInval: async () => { throw new Error('redis down'); } };
    const logs = [];
    const r = await pass_(pr, { cache: bad, log: (m) => logs.push(m), embed: async () => { throw new Error('tei down'); } });
    assert.deepEqual([r.counts.written, r.epoch, r.counts.embedded], [2, null, 0]);
    assert.ok(logs.length >= 2);
    if (process.getuid && process.getuid() !== 0) {
      const f = path.join(pr.root, SPEC_PATH);
      fs.writeFileSync(f, SPEC_TEXT.replace('heading task', 'edited'));
      fs.chmodSync(f, 0o000);
      try {
        const before = await parserNodes(pr.ctx, SPEC_PATH);
        const x = await pass_(pr);
        assert.deepEqual([x.files.failed, await parserNodes(pr.ctx, SPEC_PATH)], [[{ file: SPEC_PATH, code: 'read_failed' }], before]);
      } finally { fs.chmodSync(f, 0o644); }
    }
    await pass_(pr);
    await assert.rejects(W.extractHandler({ repos, config: { mode: 'local' }, runClaude: async () => { throw new Error('quota'); } })['graph.extract']({ userId: 'local', projectId: pr.ctx.projectId, files: [SPEC_PATH] }, hctx()), /extract_failed/);
    assert.ok((await parserNodes(pr.ctx, SPEC_PATH)).length > 0);
    const u = `u-${rnd()}`;
    const p = await project({}, u);
    const cap = await capability(u, { name: 'noserve', text: skillText('x').replace('name: tdd', 'name: noserve'), serve: false });
    assert.equal((await W.linkCapability({ repos, userId: u, projectId: p.ctx.projectId, capId: cap.id })).status, 'skipped');
  });

  await check('D21', 'gate test file and fixtures exist and are faithful real excerpts; 007 excerpt parses to 24 tasks and 10 decisions', async () => {
    const gate = fs.readFileSync(path.join(ROOT, GATE), 'utf8');
    assert.match(gate, /describe\(\s*['"`]parser fixtures['"`]/);
    for (const name of ['007 spec tables', 'checklists and requirements', 'issue file and CLAUDE.md decisions', 'fences, duplicates and malformed rows', 'refs and resolution', 'capability nodes', 'extract reply']) {
      assert.ok(new RegExp(`\\b(it|test)\\(\\s*['"\`]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(gate), `gate test missing: ${name}`);
    }
    const real = { 'spec007.md.txt': 'specs/007-ctc/spec.md', 'spec006.md.txt': 'specs/006-merged-core/spec.md', 'tasks002.md.txt': 'specs/002-context-coding-graph/tasks.md',
      'spec002.md.txt': 'specs/002-context-coding-graph/spec.md', 'issue03.md.txt': '.scratch/context-coding-graph/issues/03-links-build-claudemem.md', 'claude-decisions.md.txt': 'CLAUDE.md' };
    for (const [fx, src] of Object.entries(real)) {
      const f = path.join(ROOT, FIXDIR, fx);
      assert.ok(fs.existsSync(f), `fixture missing: ${fx}`);
      const have = new Set(REAL(src).split('\n'));
      const stray = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim() !== '' && !have.has(l));
      assert.deepEqual(stray, [], `${fx} has lines that are not in ${src}`);
      const exp = path.join(ROOT, FIXDIR, fx.replace(/\.md\.txt$/, '.expected.json'));
      assert.ok(fs.existsSync(exp), `expected json missing for ${fx}`);
      JSON.parse(fs.readFileSync(exp, 'utf8'));
    }
    const ex = parse('specs/007-ctc/spec.md', fs.readFileSync(path.join(ROOT, FIXDIR, 'spec007.md.txt'), 'utf8'));
    const ids = (t) => ex.nodes.filter((n) => n.type === t).map((n) => n.id.split(':').pop());
    assert.deepEqual([ids('task').length, ids('decision').sort(byCode)], [24, ['D1', 'D10', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9']]);
    assert.equal(ex.nodes.filter((n) => n.type === 'requirement').length, 0);
  });

  await check('D22', 'layout and exports: core index exports exactly the list, core is pure (no fs, no apps import), T2.1/T2.2 export pins and frozen files untouched', async () => {
    assert.deepEqual(Object.keys(C).sort(), ['CONTEXT_VERSION', 'buildExtractPrompt', 'contextLimits', 'isContextPath', 'parseCapability', 'parseContext', 'parseExtractReply', 'resolveRefs']);
    for (const f of ['index', 'types', 'limits', 'parse', 'refs', 'capability', 'extract']) assert.ok(fs.existsSync(path.join(ROOT, 'packages/core/src/context', `${f}.ts`)), `core/context/${f}.ts`);
    for (const f of ['index', 'limits', 'pass', 'capability', 'extract', 'handlers', 'epoch']) assert.ok(fs.existsSync(path.join(ROOT, 'apps/worker/src/context', `${f}.ts`)), `worker/context/${f}.ts`);
    const coreSrc = fs.readdirSync(path.join(ROOT, 'packages/core/src/context')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    for (const f of coreSrc) {
      const t = fs.readFileSync(path.join(ROOT, 'packages/core/src/context', f), 'utf8');
      assert.doesNotMatch(t, /from ['"](node:fs|fs|node:child_process|node:path)['"]/, `${f} must be pure`);
      assert.doesNotMatch(t, /apps\//, `${f} must not import from apps`);
    }
    assert.deepEqual(Object.keys(G).sort(), ['EXTRACTOR_VERSION', 'GrammarError', 'SCORES', 'cleanLabel', 'contentHash', 'extractFile', 'fileStem', 'langOf', 'limits', 'loadGrammars', 'makeId', 'normalizeId', 'resolveGraph', 'resolveLimits']);
    assert.equal(fs.readFileSync(path.join(ROOT, 'packages/core/src/index.ts'), 'utf8'), "export const name = '@ctc/core';\n");
  });
} catch (e) {
  console.log(`note: checks aborted by an unexpected error: ${e?.stack ?? e}`);
}
await finish();
