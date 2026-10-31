import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, it } from 'vitest';
import * as g from './index.ts';
import type { ExtractResult, Grammars } from './index.ts';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(MODULE_DIR, '../..');
const show = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

describe('graph', () => {
let grammars: Grammars;
beforeAll(async () => {
  grammars = await g.loadGrammars();
});

const LIMITS = { maxFileBytes: 1048576, parseTimeoutMs: 5000, maxLabelChars: 256, jsonMaxDepth: 6, jsonMaxPairs: 500, frontmatterMaxLines: 200, maxReceiverChars: 128 };
const ex = (p: string, content: string, gr: Grammars = grammars): ExtractResult => g.extractFile({ path: p, content }, gr);
const ids = (r: ExtractResult): string[] => r.nodes.map((n) => n.id).sort();
const rows = (r: ExtractResult): string[][] => r.nodes.map((n) => [n.id, n.type, n.label, n.sourceLocation]);
const parents = (r: ExtractResult): Record<string, string | null> => Object.fromEntries(r.nodes.map((n) => [n.id, r.edges.find((e) => e.dst === n.id && e.relation === 'contains')?.src ?? null]));
const withLimits = async (patch: Partial<typeof g.limits>, fn: () => unknown): Promise<void> => {
  const saved = { ...g.limits };
  Object.assign(g.limits, patch);
  try { await fn(); } finally { Object.assign(g.limits, saved); }
};
const noErr = (r: ExtractResult): void => assert.equal(r.error, null, `unexpected error ${show(r.error)}`);

// fixtures (own values) -------------------------------------------------------------------------------------------
const A_TS = [
  'export class A { m() {} static s() {} get g() { return 1; } }',
  'interface I { f(): void }',
  'type T = string;',
  'enum E { X }',
  'function top() { function nested() {} }',
  'export const arrow = () => 1;',
  'const obj = { a: 1 };',
  'const n = 5;',
  'export const N = 5;',
  'let later = [1];',
  'function over(a: string): void;',
  'function over(a: number): void;',
  'function over(a: unknown): void {}',
  '',
].join('\n');
const A_ROWS = [
  ['code:src_a', 'file', 'a.ts', 'L1'], ['code:src_a_a', 'class', 'A', 'L1'], ['code:src_a_a_m', 'method', '.m()', 'L1'],
  ['code:src_a_a_s', 'method', '.s()', 'L1'], ['code:src_a_a_g', 'method', '.g()', 'L1'], ['code:src_a_i', 'interface', 'I', 'L2'],
  ['code:src_a_i_f', 'method', '.f()', 'L2'], ['code:src_a_t', 'type', 'T', 'L3'], ['code:src_a_e', 'type', 'E', 'L4'],
  ['code:src_a_e_x', 'variable', 'X', 'L4'], ['code:src_a_top', 'function', 'top()', 'L5'], ['code:src_a_top_nested', 'function', 'nested()', 'L5'],
  ['code:src_a_arrow', 'function', 'arrow()', 'L6'], ['code:src_a_obj', 'variable', 'obj', 'L7'], ['code:src_a_n', 'variable', 'N', 'L9'],
  ['code:src_a_later', 'variable', 'later', 'L10'], ['code:src_a_over', 'function', 'over()', 'L13'],
];
const A_PARENTS = {
  'code:src_a': null, 'code:src_a_a': 'code:src_a', 'code:src_a_a_m': 'code:src_a_a', 'code:src_a_a_s': 'code:src_a_a', 'code:src_a_a_g': 'code:src_a_a',
  'code:src_a_i': 'code:src_a', 'code:src_a_i_f': 'code:src_a_i', 'code:src_a_t': 'code:src_a', 'code:src_a_e': 'code:src_a', 'code:src_a_e_x': 'code:src_a_e',
  'code:src_a_top': 'code:src_a', 'code:src_a_top_nested': 'code:src_a_top', 'code:src_a_arrow': 'code:src_a', 'code:src_a_obj': 'code:src_a',
  'code:src_a_n': 'code:src_a', 'code:src_a_later': 'code:src_a', 'code:src_a_over': 'code:src_a',
};
const M_PY = 'import os\nclass K:\n    def __init__(self): pass\n    class In:\n        def z(self): pass\ndef f():\n    def g(): pass\n    return os.path.join("a")\n@decor\ndef h(): pass\nX = 1\ndef f(): pass\n';
const RUN_SH = '#!/bin/sh\ngreet() { echo hi; }\nfunction bye { greet; }\nsource ./x.sh\nbye\n';
const GUIDE_MD = '# Title\n\n## Use `a.ts::A` and `top()`\n\nSee [b](./b.md#x) and ![img](i.png) and [w](https://x.y).\n\n```\n## fenced\n```\n\n## Use `a.ts::A` and `top()`\n\n### Ünï\n';


  it('D0 one file in: file + symbol nodes, a contains edge, GraphNodeInput/GraphEdgeInput-compatible shapes', async () => {
    const r = ex('src/one.ts', 'export function f() {}\n');
    noErr(r);
    assert.deepEqual(r.nodes.map((n) => n.id), ['code:src_one', 'code:src_one_f']);
    assert.deepEqual(Object.keys(r.nodes[1] ?? {}).sort(), ['id', 'kind', 'label', 'meta', 'sourceLocation', 'type']);
    assert.deepEqual(r.edges, [{ src: 'code:src_one', dst: 'code:src_one_f', relation: 'contains', confidence: 'EXTRACTED', sourceLocation: 'L1' }]);
    assert.equal(r.file, 'src/one.ts');
    assert.equal(r.lang, 'ts');
  });

  it('D1 labels: control chars become spaces and are cut to maxLabelChars; content is never run', async () => {
    const r = ex('docs/x.md', '# a\u0007b\u2028c\u0085d\n## ' + 'x'.repeat(300) + '\n');
    noErr(r);
    const h = r.nodes.filter((n) => n.type === 'heading');
    assert.deepEqual(h.map((n) => [n.id, n.label]), [['doc:docs_x_a_b_c_d', 'a b c d'], ['doc:docs_x_' + 'x'.repeat(300), 'x'.repeat(256)]]);
    assert.equal(g.cleanLabel('a\tb\u0000c'), 'a b c');
    const marker = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'ctc-t21-')), 'pwned');
    const evil = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');\nimport(${JSON.stringify('file://' + marker)});\n`;
    for (const p of ['src/evil.js', 'src/evil.ts']) noErr(ex(p, evil));
    assert.equal(fs.existsSync(marker), false, 'extract executed file content');
  });

  it('D2 limits: defaults pinned, read at call time, equal is valid and one more is an error', async () => {
    assert.deepEqual({ ...g.limits }, LIMITS);
    assert.equal(g.EXTRACTOR_VERSION, 'ctc-ts-1');
    await withLimits({ maxFileBytes: 10 }, () => {
      assert.equal(ex('n.md', 'ééééé').error, null); // 10 bytes
      assert.equal(ex('n.md', 'éééééa').error?.code, 'too_large'); // 11 bytes
    });
    await withLimits({ maxLabelChars: 5 }, () => {
      const r = ex('docs/x.md', '# abcdefgh\n');
      assert.deepEqual(r.nodes.map((n) => [n.id, n.label]), [['doc:docs_x', 'x.md'], ['doc:docs_x_abcdefgh', 'abcde']]);
    });
    await withLimits({ jsonMaxPairs: 2 }, () => assert.deepEqual(ids(ex('package.json', '{"a":1,"b":2,"c":3}')), ['code:package', 'code:package_a', 'code:package_b']));
    await withLimits({ jsonMaxDepth: 1 }, () => assert.deepEqual(ids(ex('package.json', '{"a":{"b":{"c":1}}}')), ['code:package', 'code:package_a', 'code:package_a_b']));
    assert.deepEqual(ids(ex('package.json', '{"a":{"b":{"c":1}}}')), ['code:package', 'code:package_a', 'code:package_a_b', 'code:package_b_c']);
    const fm = '---\n# c\n---\n# H\n';
    assert.deepEqual(ids(ex('f.md', fm)), ['doc:f', 'doc:f_h']);
    await withLimits({ frontmatterMaxLines: 2 }, () => assert.deepEqual(ids(ex('f.md', fm)), ['doc:f', 'doc:f_h']));
    await withLimits({ frontmatterMaxLines: 1 }, () => assert.deepEqual(ids(ex('f.md', fm)), ['doc:f', 'doc:f_c', 'doc:f_h']));
    await withLimits({ maxReceiverChars: 3 }, () => assert.deepEqual(ex('r.ts', 'a.bcdef.g();\n').refs, [{ from: 'code:r', name: 'g', receiver: 'a.b', kind: 'call', line: 1 }]));
    const big = Array.from({ length: 12000 }, (_, i) => `export function f${i}(a: number): number { return a + ${i}; }`).join('\n');
    await withLimits({ parseTimeoutMs: 0 }, () => {
      const r = ex('big.ts', big);
      assert.deepEqual([r.error?.code, r.nodes.length], ['parse_timeout', 0]);
    });
    assert.equal(ex('big.ts', big).error, null);
  });

  it('D3 result shape; any error gives empty arrays, a short message without content, lang or null', async () => {
    const keys = ['edges', 'error', 'file', 'imports', 'lang', 'mentions', 'nodes', 'refs'];
    const okR = ex('a.md', '# x\n');
    assert.deepEqual(Object.keys(okR).sort(), keys);
    const secret = 'SECRET-CONTENT-0xdeadbeef ';
    await withLimits({ maxFileBytes: 20 }, () => {
      const r = ex('docs/big.md', secret.repeat(3));
      assert.deepEqual({ ...r, error: r.error?.code }, { file: 'docs/big.md', lang: 'markdown', nodes: [], edges: [], imports: [], refs: [], mentions: [], error: 'too_large' });
      const message = r.error?.message ?? '';
      assert.ok(message.length > 0 && message.length <= 200 && !message.includes('SECRET'), message);
      assert.ok(!message.includes('\n'));
    });
    const u = ex('lib/a.rb', 'puts 1');
    assert.deepEqual([u.lang, u.error?.code, u.nodes.length], [null, 'unsupported', 0]);
  });

  it('D4 bad input is reported, never thrown, first error wins', async () => {
    for (const p of ['', '/abs.ts', 'C:\\x.ts', '\\\\srv\\x.ts', 'a\\b.ts', 'a//b.ts', './a.ts', 'a/../b.ts', 'a/', 'a\u0000.ts', 'x/./y.md']) {
      const r = ex(p, 'x');
      assert.deepEqual([p, r.error?.code, r.lang, r.nodes.length], [p, 'bad_path', null, 0]);
    }
    assert.equal(g.extractFile({ path: 3 as unknown as string, content: 'x' }, grammars).error?.code, 'bad_path');
    assert.deepEqual(ex('a.py', 7 as unknown as string).error, { code: 'internal', message: 'content must be a string' });
    assert.deepEqual(ex('/abs.rb', 7 as unknown as string).error?.code, 'bad_path');
    assert.equal(ex('a.py', 'x = 1\n', {}).error?.code, 'grammar_missing');
    assert.equal(ex('a.ts', 'x\n', {}).error?.code, 'grammar_missing');
    assert.equal(ex('a.md', '# x\n', {}).error, null);
    assert.equal(ex('a.sql', 'create table t (x int);\n', {}).error, null);
  });

  it('D5 odd but harmless input: BOM, CRLF, empty, odd paths, upper-case ext, syntax errors, unicode', async () => {
    const lf = 'export function f() {}\nclass K {}\n';
    assert.deepEqual(rows(ex('src/c.ts', '\ufeff' + lf.replaceAll('\n', '\r\n'))), rows(ex('src/c.ts', lf)));
    assert.deepEqual(rows(ex('d.md', '# T\r\n## U\r\n')), [['doc:d', 'page', 'd.md', 'L1'], ['doc:d_t', 'heading', 'T', 'L1'], ['doc:d_u', 'heading', 'U', 'L2']]);
    const e = ex('src/e.ts', '');
    noErr(e);
    assert.deepEqual(e.nodes.map((n) => [n.id, n.meta.lines]), [['code:src_e', [1, 1]]]);
    assert.equal(ex('a b/c.d-e.ts', '').nodes[0]?.id, 'code:a_b_c_d_e');
    assert.deepEqual([ex('X.TS', '').lang, ex('README.MD', '').lang, ex('.claude/x.md', '').nodes[0]?.id], ['ts', 'markdown', 'doc:claude_x']);
    assert.equal(ex('_.ts', '').nodes[0]?.id, 'code:ts');
    assert.equal(ex('🙂.md', '').nodes[0]?.id, 'doc:md');
    assert.equal(ex('🙂', '').error?.code, 'unsupported');
    assert.equal(ex('src/broken.ts', 'function f( {\nclass K {}\n').error, null);
    assert.deepEqual(rows(ex('x.ts', 'const größe = () => 1;\n'))[1], ['code:x_grösse', 'function', 'größe()', 'L1']);
  });

  it('D6 never throws, never mutates input, deterministic, bounded on deep nesting, ids/edges consistent', async () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const junk = () => Array.from({ length: 2000 }, () => String.fromCharCode(Math.floor(rnd() * 0x3000))).join('');
    const paths = ['j.ts', 'j.tsx', 'j.js', 'j.py', 'j.sh', 'j.sql', 'package.json', 'j.md'];
    for (const p of paths) {
      for (let i = 0; i < 5; i++) {
        const content = junk();
        const input = Object.freeze({ path: p, content });
        const r1 = g.extractFile(input, grammars);
        const r2 = g.extractFile(input, grammars);
        assert.deepEqual(r1, r2, `not deterministic on ${p}`);
        assert.equal(input.content, content);
        const nodeIds = new Set(r1.nodes.map((n) => n.id));
        assert.equal(nodeIds.size, r1.nodes.length, `duplicate ids on ${p}`);
        assert.ok(r1.nodes.every((n) => /^(code|doc):/.test(n.id)), `unprefixed id on ${p}`);
        assert.ok(r1.edges.every((e) => nodeIds.has(e.src) && nodeIds.has(e.dst)), `dangling edge on ${p}`);
      }
    }
    const t0 = Date.now();
    for (const [p, c] of [['package.json', '['.repeat(100000)], ['package.json', '{"a":'.repeat(50000)], ['deep.ts', 'a('.repeat(50000)], ['deep.py', '('.repeat(50000)], ['deep.md', '#'.repeat(100000)]]) {
      const r = ex(p as string, c as string);
      assert.ok(r.error === null || ['parse_timeout', 'internal'].includes(r.error.code), `${p}: ${show(r.error)}`);
    }
    assert.ok(Date.now() - t0 < 60000, `deep inputs took ${Date.now() - t0} ms`);
    Object.freeze(grammars);
    assert.deepEqual(ids(ex('z.ts', 'function z() {}\n')), ['code:z', 'code:z_z'], 'extractFile must not write to the grammars object');
  });

  it('D7 non-goals: only contains edges, no ref_/rationale/ctx nodes, no resolution, no extra exports', async () => {
    const r = ex('src/i.ts', "import { x } from './y';\nx();\n");
    assert.deepEqual([...new Set(r.edges.map((e) => e.relation))], []);
    assert.deepEqual(ids(r), ['code:src_i']);
    const p = ex('pkg/d.py', '"""Module doc."""\ndef f():\n    """Why f exists."""\n    return 1\n');
    assert.deepEqual(ids(p), ['code:pkg_d', 'code:pkg_d_f']);
    const md = ex('specs/s.md', '# T2.1 graph ids\nDecision D3 applies to `T2.1`.\n');
    assert.ok(md.nodes.every((n) => n.id.startsWith('doc:')));
    const pj = ex('package.json', '{"dependencies": {"zod": "4"}}');
    assert.ok(pj.nodes.every((n) => !n.id.includes('ref_')), show(ids(pj)));
    for (const name of ['contextId', 'capabilityId', 'resolve']) assert.equal((g as Record<string, unknown>)[name], undefined, `unexpected export ${name}`);
  });

  it('D8 silence rule: the module records its judgment calls', async () => {
    const files = fs.readdirSync(MODULE_DIR, { recursive: true, encoding: 'utf8' }).filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f));
    const n = files.reduce((acc, f) => acc + (fs.readFileSync(path.join(MODULE_DIR, f), 'utf8').match(/judgment:/g)?.length ?? 0), 0);
    assert.ok(n >= 1, `no "judgment:" comment in ${MODULE_DIR}`);
  });

  it('D9 ids: normalizeId/makeId/fileStem and the code:/doc: forms', async () => {
    assert.equal(g.makeId('src/ctc/decision/bundle', 'suggestion_line'), 'src_ctc_decision_bundle_suggestion_line');
    assert.deepEqual(['ſtraße', 'ᏣᎳᎩ', 'ΣΑΣ ὅς', 'हिन्दी', 'İslemYap', 'ﬁle', '__init__', 'a..b--c', '___'].map(g.normalizeId),
      ['strasse', 'ᏣᎳᎩ', 'σασ_ὅσ', 'ह_न_द', 'i_slemyap', 'file', 'init', 'a_b_c', '']);
    assert.deepEqual([g.makeId('', 'x'), g.makeId('._a.b_.'), g.makeId('a', 'b', 'c'), g.makeId('ꮳ')], ['x', 'a_b', 'a_b_c', 'Ꮳ']);
    assert.deepEqual(['a/b.test.ts', 'README.md', 'x.d.ts', 'Makefile', '.claude/x.md'].map(g.fileStem), ['a/b.test', 'README', 'x.d', 'Makefile', '.claude/x']);
    assert.ok(ex('bin/run.sh', RUN_SH).nodes.some((n) => n.id === 'code:bin_run_sh__entry'));
    assert.deepEqual(ids(ex('specs/007-ctc/spec.md', '## 2.2 Graph model\n')), ['doc:specs_007_ctc_spec', 'doc:specs_007_ctc_spec_2_2_graph_model']);
  });

  it('D10 langOf by last extension; grammars load twice; jsx parses with the js grammar', async () => {
    const want = { 'a.ts': 'ts', 'a.mts': 'ts', 'a.cts': 'ts', 'a.tsx': 'tsx', 'a.js': 'js', 'a.mjs': 'js', 'a.cjs': 'js', 'a.jsx': 'js', 'a.py': 'python', 'a.pyi': 'python',
      'a.sh': 'bash', 'a.bash': 'bash', 'a.sql': 'sql', 'a.json': 'json', 'a.md': 'markdown', 'a.mdx': 'markdown', 'A.PY': 'python', 'a.rb': null, Makefile: null, 'a.ts.bak': null };
    assert.deepEqual(Object.fromEntries(Object.keys(want).map((k) => [k, g.langOf(k)])), want);
    const again = await g.loadGrammars();
    assert.deepEqual(rows(ex('v.jsx', 'export const V = () => <Card/>;\n', again)), [['code:v', 'file', 'v.jsx', 'L1'], ['code:v_v', 'function', 'V()', 'L1']]);
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
    assert.deepEqual(Object.fromEntries(['web-tree-sitter', 'tree-sitter-typescript', 'tree-sitter-javascript', 'tree-sitter-python', 'tree-sitter-bash', 'tree-sitter-json'].map((d) => [d, pkg.dependencies?.[d]])),
      { 'web-tree-sitter': '0.25.10', 'tree-sitter-typescript': '0.23.2', 'tree-sitter-javascript': '0.25.0', 'tree-sitter-python': '0.25.0', 'tree-sitter-bash': '0.25.1', 'tree-sitter-json': '0.24.8' });
  });

  it('D11 ts/js nodes: classes, interfaces, types, enums, functions, methods, consts, overloads', async () => {
    const r = ex('src/a.ts', A_TS);
    noErr(r);
    assert.deepEqual(rows(r), A_ROWS);
    assert.deepEqual(parents(r), A_PARENTS);
    const cb = ex('src/b.ts', "var v = [1];\ndescribe('x', () => { const inner = [1]; function cb() {} });\nconst s = 'x' + 1;\n");
    assert.deepEqual([rows(cb), parents(cb)['code:src_b_cb']], [[['code:src_b', 'file', 'b.ts', 'L1'], ['code:src_b_cb', 'function', 'cb()', 'L2']], 'code:src_b']);
    const t = ex('src/c.tsx', 'export default function Page() { return <div/>; }\nexport const { a, b: c } = make();\n');
    assert.deepEqual(rows(t), [['code:src_c', 'file', 'c.tsx', 'L1'], ['code:src_c_page', 'function', 'Page()', 'L1'], ['code:src_c_a', 'variable', 'a', 'L2'], ['code:src_c_b', 'variable', 'b', 'L2']]);
  });

  it('D12 python nodes: classes, methods, nested defs, decorators, first duplicate wins, defs under if __main__', async () => {
    const r = ex('pkg/m.py', M_PY);
    noErr(r);
    assert.deepEqual(rows(r), [
      ['code:pkg_m', 'file', 'm.py', 'L1'], ['code:pkg_m_k', 'class', 'K', 'L2'], ['code:pkg_m_k_init', 'method', '.__init__()', 'L3'],
      ['code:pkg_m_k_in', 'class', 'In', 'L4'], ['code:pkg_m_k_in_z', 'method', '.z()', 'L5'], ['code:pkg_m_f', 'function', 'f()', 'L6'],
      ['code:pkg_m_f_g', 'function', 'g()', 'L7'], ['code:pkg_m_h', 'function', 'h()', 'L10']]);
    assert.deepEqual(parents(r), { 'code:pkg_m': null, 'code:pkg_m_k': 'code:pkg_m', 'code:pkg_m_k_init': 'code:pkg_m_k', 'code:pkg_m_k_in': 'code:pkg_m_k',
      'code:pkg_m_k_in_z': 'code:pkg_m_k_in', 'code:pkg_m_f': 'code:pkg_m', 'code:pkg_m_f_g': 'code:pkg_m_f', 'code:pkg_m_h': 'code:pkg_m' });
    const m2 = ex('pkg/n.py', 'if __name__ == "__main__":\n    def run(): pass\n    lam = lambda: 1\n');
    assert.deepEqual([rows(m2), parents(m2)['code:pkg_n_run']], [[['code:pkg_n', 'file', 'n.py', 'L1'], ['code:pkg_n_run', 'function', 'run()', 'L2']], 'code:pkg_n']);
  });

  it('D13 bash nodes: both function styles, the script entry, all parented to the file', async () => {
    const r = ex('bin/run.sh', RUN_SH);
    noErr(r);
    assert.deepEqual(rows(r), [['code:bin_run', 'file', 'run.sh', 'L1'], ['code:bin_run_sh__entry', 'function', 'run.sh script', 'L1'],
      ['code:bin_run_greet', 'function', 'greet()', 'L2'], ['code:bin_run_bye', 'function', 'bye()', 'L3']]);
    assert.ok(Object.entries(parents(r)).every(([k, v]) => (k === 'code:bin_run' ? v === null : v === 'code:bin_run')), show(parents(r)));
    assert.deepEqual(r.nodes[1]?.meta.lines, [1, 5]);
  });

  it('D14 json: config keys by immediate parent, data JSON gives the file node only', async () => {
    const r = ex('tsconfig.json', '{"compilerOptions": {"strict": true, "paths": {"a": ["b"]}}, "x": [1]}\n');
    noErr(r);
    assert.deepEqual(rows(r), [['code:tsconfig', 'file', 'tsconfig.json', 'L1'], ['code:tsconfig_compileroptions', 'key', 'compilerOptions', 'L1'],
      ['code:tsconfig_compileroptions_strict', 'key', 'strict', 'L1'], ['code:tsconfig_compileroptions_paths', 'key', 'paths', 'L1'],
      ['code:tsconfig_paths_a', 'key', 'a', 'L1'], ['code:tsconfig_x', 'key', 'x', 'L1']]);
    assert.equal(parents(r)['code:tsconfig_paths_a'], 'code:tsconfig_compileroptions_paths');
    assert.deepEqual(ids(ex('data/rows.json', '[1, 2]')), ['code:data_rows']);
    assert.deepEqual(ids(ex('data/x.json', '{"a": {"b": 1}}')), ['code:data_x']);
    assert.deepEqual(ids(ex('cfg/x.json', '{"extends": "base", "a": {"__": 1, "b": 2}}')), ['code:cfg_x', 'code:cfg_x_a', 'code:cfg_x_a_b', 'code:cfg_x_extends']);
    assert.deepEqual(ids(ex('s/schema.json', '{"$schema": "x", "$defs": {"a": {}}}')), ['code:s_schema']);
  });

  it('D15 sql: statement scanner, comments/strings/dollar bodies skipped, schema prefixes dropped', async () => {
    const sql = "create table {schema}.graph_nodes (\n  id text\n);\n-- create table fake (x int);\nCREATE OR REPLACE FUNCTION ctc.f() returns int as $$ create table inner_t(x int); $$ language sql;\ncreate index i on t(x);\ncreate type \"Mood\" as enum ('create table q (x int)');\n/* create view v2 as select 1; */\ncreate materialized view if not exists mv as select 1;\n";
    const r = ex('db/m.sql', sql, {});
    noErr(r);
    assert.deepEqual(rows(r), [['code:db_m', 'file', 'm.sql', 'L1'], ['code:db_m_graph_nodes', 'table', 'graph_nodes', 'L1'], ['code:db_m_f', 'function', 'f', 'L5'],
      ['code:db_m_mood', 'type', 'Mood', 'L7'], ['code:db_m_mv', 'table', 'mv', 'L9']]);
    assert.deepEqual(r.nodes[1]?.meta.lines, [1, 3]);
    assert.deepEqual([r.imports, r.refs, r.mentions], [[], [], []]);
  });

  it('D16 markdown: ATX headings only, fences and frontmatter skipped, duplicate titles get the line, nesting by level', async () => {
    const r = ex('docs/guide.md', GUIDE_MD);
    noErr(r);
    assert.deepEqual(rows(r), [['doc:docs_guide', 'page', 'guide.md', 'L1'], ['doc:docs_guide_title', 'heading', 'Title', 'L1'],
      ['doc:docs_guide_use_a_ts_a_and_top', 'heading', 'Use `a.ts::A` and `top()`', 'L3'], ['doc:docs_guide_use_a_ts_a_and_top_11', 'heading', 'Use `a.ts::A` and `top()`', 'L11'],
      ['doc:docs_guide_ünï', 'heading', 'Ünï', 'L13']]);
    assert.ok(r.nodes.every((n) => n.kind === 'doc'));
    assert.deepEqual(parents(r), { 'doc:docs_guide': null, 'doc:docs_guide_title': 'doc:docs_guide', 'doc:docs_guide_use_a_ts_a_and_top': 'doc:docs_guide_title',
      'doc:docs_guide_use_a_ts_a_and_top_11': 'doc:docs_guide_title', 'doc:docs_guide_ünï': 'doc:docs_guide_use_a_ts_a_and_top_11' });
    assert.deepEqual(r.nodes.map((n) => n.meta.lines), [[1, 13], [1, 13], [3, 10], [11, 13], [13, 13]]);
    assert.deepEqual(ids(ex('d/s.md', 'Title\n=====\n    # indented\n#tag\n####### seven\n~~~\n# tilde is not a fence\n~~~\n')), ['doc:d_s', 'doc:d_s_tilde_is_not_a_fence']);
    assert.deepEqual(rows(ex('d/h.md', '## Size ###\n'))[1], ['doc:d_h_size', 'heading', 'Size ###', 'L1']);
  });

  it('D17 order, meta.lines, one contains edge per child, first duplicate wins', async () => {
    const r = ex('src/a.ts', A_TS);
    assert.deepEqual(r.nodes.map((n) => n.id), A_ROWS.map((x) => x[0]));
    assert.deepEqual(r.edges.map((e) => e.dst), A_ROWS.slice(1).map((x) => x[0]));
    assert.ok(r.edges.every((e) => e.relation === 'contains' && e.confidence === 'EXTRACTED'));
    assert.deepEqual(r.edges.map((e) => e.sourceLocation), A_ROWS.slice(1).map((x) => x[3]));
    const c = ex('src/k.ts', 'export class A {\n  m() {}\n}\nclass C { get x() { return 1; } set x(v) {} }\n');
    assert.deepEqual(c.nodes.map((n) => [n.id, n.meta.lines]), [['code:src_k', [1, 4]], ['code:src_k_a', [1, 3]], ['code:src_k_a_m', [2, 2]], ['code:src_k_c', [4, 4]], ['code:src_k_c_x', [4, 4]]]);
    const p = ex('pkg/m.py', M_PY);
    assert.deepEqual(p.nodes.find((n) => n.id === 'code:pkg_m_f')?.meta.lines, [6, 8]);
  });

  it('D18 raw imports: ts/js, python, bash', async () => {
    const ts = "import d, { a as b, type c } from 'x';\nimport * as ns from './y.ts';\nimport 'side';\nimport type { T } from 't';\nexport { a as z } from 'x';\nexport * from 'w';\nexport * as all from 'v';\nconst r = require('cjs');\nconst lazy = () => import('dyn');\nimport(name);\n";
    assert.deepEqual(ex('src/m.ts', ts).imports, [
      { from: 'code:src_m', specifier: 'x', names: [{ imported: 'default', local: 'd' }, { imported: 'a', local: 'b' }, { imported: 'c', local: 'c' }], typeOnly: false, kind: 'import', line: 1 },
      { from: 'code:src_m', specifier: './y.ts', names: [{ imported: '*', local: 'ns' }], typeOnly: false, kind: 'import', line: 2 },
      { from: 'code:src_m', specifier: 'side', names: [], typeOnly: false, kind: 'import', line: 3 },
      { from: 'code:src_m', specifier: 't', names: [{ imported: 'T', local: 'T' }], typeOnly: true, kind: 'import', line: 4 },
      { from: 'code:src_m', specifier: 'x', names: [{ imported: 'a', local: 'z' }], typeOnly: false, kind: 'reexport', line: 5 },
      { from: 'code:src_m', specifier: 'w', names: [{ imported: '*', local: '*' }], typeOnly: false, kind: 'reexport', line: 6 },
      { from: 'code:src_m', specifier: 'v', names: [{ imported: '*', local: 'all' }], typeOnly: false, kind: 'reexport', line: 7 },
      { from: 'code:src_m', specifier: 'cjs', names: [], typeOnly: false, kind: 'require', line: 8 },
      { from: 'code:src_m', specifier: 'dyn', names: [], typeOnly: false, kind: 'dynamic', line: 9 }]);
    const py = 'import a.b\nimport a.b as c\nfrom ..m import x as y, z\nfrom . import q\nfrom m import *\nif TYPE_CHECKING:\n    from t import T\ndef f():\n    import inner\n';
    const I = (specifier: string, names: { imported: string; local: string }[], line: number, typeOnly = false) => ({ from: 'code:pkg_i', specifier, names, typeOnly, kind: 'import' as const, line });
    assert.deepEqual(ex('pkg/i.py', py).imports, [I('a.b', [{ imported: '*', local: 'a.b' }], 1), I('a.b', [{ imported: '*', local: 'c' }], 2),
      I('..m', [{ imported: 'x', local: 'y' }, { imported: 'z', local: 'z' }], 3), I('.', [{ imported: 'q', local: 'q' }], 4),
      I('m', [{ imported: '*', local: '*' }], 5), I('t', [{ imported: 'T', local: 'T' }], 7, true), I('inner', [{ imported: '*', local: 'inner' }], 9)]);
    assert.deepEqual(ex('bin/s.sh', 'source ./x.sh\n. "lib/y.sh"\nsource "$DIR/z.sh"\n').imports, [
      { from: 'code:bin_s', specifier: './x.sh', names: [], typeOnly: false, kind: 'source', line: 1 },
      { from: 'code:bin_s', specifier: 'lib/y.sh', names: [], typeOnly: false, kind: 'source', line: 2 }]);
    assert.deepEqual([ex('a.md', '# x\n').imports, ex('package.json', '{"a":1}').imports], [[], []]);
  });

  it('D19 raw refs: calls, new, jsx, heritage; innermost from; dedup; bash commands', async () => {
    const ts = 'class A extends B implements C, D {\n  m() { this.n(); foo(); a.b.c(); new X(); foo(); }\n}\ntop();\nf()();\n';
    const R = (from: string, name: string, receiver: string | null, kind: 'call' | 'new' | 'jsx' | 'extends' | 'implements', line: number) => ({ from, name, receiver, kind, line });
    assert.deepEqual(ex('src/r.ts', ts).refs, [R('code:src_r_a', 'B', null, 'extends', 1), R('code:src_r_a', 'C', null, 'implements', 1), R('code:src_r_a', 'D', null, 'implements', 1),
      R('code:src_r_a_m', 'n', 'this', 'call', 2), R('code:src_r_a_m', 'foo', null, 'call', 2), R('code:src_r_a_m', 'c', 'a.b', 'call', 2), R('code:src_r_a_m', 'X', null, 'new', 2),
      R('code:src_r', 'top', null, 'call', 4), R('code:src_r', 'f', null, 'call', 5)]);
    assert.deepEqual(ex('src/v.tsx', 'export const V = () => <div><Card/><UI.Panel x={1}></UI.Panel></div>;\n').refs,
      [R('code:src_v_v', 'Card', null, 'jsx', 1), R('code:src_v_v', 'Panel', 'UI', 'jsx', 1)]);
    assert.deepEqual(ex('pkg/k.py', 'class K(Base, m.Mixin, metaclass=M):\n    def f(self):\n        os.path.join("a")\n').refs,
      [R('code:pkg_k_k', 'Base', null, 'extends', 1), R('code:pkg_k_k', 'Mixin', 'm', 'extends', 1), R('code:pkg_k_k_f', 'join', 'os.path', 'call', 3)]);
    assert.deepEqual(ex('bin/run.sh', RUN_SH).refs, [R('code:bin_run_greet', 'echo', null, 'call', 2), R('code:bin_run_bye', 'greet', null, 'call', 3),
      R('code:bin_run_sh__entry', 'source', null, 'call', 4), R('code:bin_run_sh__entry', 'bye', null, 'call', 5)]);
  });

  it('D20 raw mentions: code spans (symbol, path_symbol), links without schemes/images, owner heading, dedup', async () => {
    const M = (from: string, kind: 'symbol' | 'path_symbol' | 'link', target: string, line: number) => ({ from, kind, target, line });
    assert.deepEqual(ex('docs/guide.md', GUIDE_MD).mentions, [
      M('doc:docs_guide_use_a_ts_a_and_top', 'path_symbol', 'a.ts::A', 3), M('doc:docs_guide_use_a_ts_a_and_top', 'symbol', 'top', 3),
      M('doc:docs_guide_use_a_ts_a_and_top', 'link', './b.md', 5),
      M('doc:docs_guide_use_a_ts_a_and_top_11', 'path_symbol', 'a.ts::A', 11), M('doc:docs_guide_use_a_ts_a_and_top_11', 'symbol', 'top', 11)]);
    assert.deepEqual(ex('d/p.md', '---\nx: `inFront`\n---\nIntro `createCache` and `not a symbol` and `pkg.mod.fn()`\n[r]: docs/x.md "t"\n[m](mailto:a@b) [s](//cdn/x) [a](#top) [q](<sp ace.md>)\n# H\n`createCache`\n').mentions, [
      M('doc:d_p', 'symbol', 'createCache', 4), M('doc:d_p', 'symbol', 'pkg.mod.fn', 4), M('doc:d_p', 'link', 'docs/x.md', 5), M('doc:d_p', 'link', 'sp ace.md', 6),
      M('doc:d_p_h', 'symbol', 'createCache', 8)]);
  });

  it('D22 exports exactly the D22 list plus the T2.2 resolver; deps include the six exact pins; core index.ts unchanged', async () => {
    const want = ['EXTRACTOR_VERSION', 'GrammarError', 'cleanLabel', 'extractFile', 'fileStem', 'langOf', 'limits', 'loadGrammars', 'makeId', 'normalizeId',
      'resolveGraph', 'contentHash', 'resolveLimits', 'SCORES'];
    assert.deepEqual(Object.keys(g).sort(), want.sort());
    assert.ok(new g.GrammarError('x') instanceof Error && new g.GrammarError('x').code === 'grammar_missing');
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    const pins = { 'web-tree-sitter': '0.25.10', 'tree-sitter-typescript': '0.23.2', 'tree-sitter-javascript': '0.25.0', 'tree-sitter-python': '0.25.0', 'tree-sitter-bash': '0.25.1', 'tree-sitter-json': '0.24.8' };
    assert.deepEqual({ ...pkg.dependencies, ...pins }, pkg.dependencies);
    assert.equal(fs.readFileSync(path.join(PKG_DIR, 'src/index.ts'), 'utf8'), "export const name = '@ctc/core';\n");
  });
});
