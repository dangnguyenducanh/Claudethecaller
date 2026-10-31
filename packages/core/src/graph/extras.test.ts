import assert from 'node:assert/strict';
import { afterEach, beforeAll, describe, it } from 'vitest';
import * as g from './index.ts';
import type { ExtractResult, Grammars } from './index.ts';

describe('graph extras', () => {
  let grammars: Grammars;
  const saved = { ...g.limits };
  beforeAll(async () => {
    grammars = await g.loadGrammars();
  });
  afterEach(() => {
    Object.assign(g.limits, saved);
  });
  const ex = (p: string, content: string, gr: Grammars = grammars): ExtractResult => g.extractFile({ path: p, content }, gr);
  const ids = (r: ExtractResult): string[] => r.nodes.map((n) => n.id);

  it('D2 labels: 256 code points are kept whole, 257 are cut to 256', () => {
    const whole = ex('d/a.md', `# ${'é'.repeat(256)}\n`).nodes[1]?.label;
    const cut = ex('d/a.md', `# ${'é'.repeat(257)}\n`).nodes[1]?.label;
    assert.deepEqual([whole?.length, cut?.length], [256, 256]);
  });

  it('D2 files: exactly maxFileBytes is extracted, one more byte is too_large', () => {
    g.limits.maxFileBytes = 6;
    assert.equal(ex('a.md', '# a\n\n\n').error, null);
    assert.equal(ex('a.md', '# a\n\n\n\n').error?.code, 'too_large');
  });

  it('D2 json: the 500th key is a node, the 501st is not; depth 6 is a node, depth 7 is not', () => {
    const flat = (n: number): string => `{${Array.from({ length: n }, (_, i) => `"k${i}":1`).join(',')}}`;
    assert.equal(ex('package.json', flat(500)).nodes.length, 501);
    assert.equal(ex('package.json', flat(501)).nodes.length, 501);
    const deep = '{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":1}}}}}}}}';
    assert.deepEqual(ids(ex('package.json', deep)).slice(-2), ['code:package_e_f', 'code:package_f_g']);
  });

  it('D2 frontmatter: a close 200 lines after the opening line still counts', () => {
    const body = (n: number): string => `---\n${'x: 1\n'.repeat(n)}---\n# H\n`;
    assert.deepEqual(ids(ex('f.md', body(199))), ['doc:f', 'doc:f_h']);
    assert.deepEqual(ids(ex('f.md', body(200))), ['doc:f', 'doc:f_h']);
    assert.deepEqual(ids(ex('f.md', body(200).replace('x: 1', '# t'))).length, 3);
  });

  it('D3 never throws on a null input or a missing grammars argument', () => {
    const r = g.extractFile(null as unknown as g.ExtractInput, undefined as unknown as Grammars);
    assert.equal(r.error?.code, 'internal');
    assert.equal(ex('a.md', '# x\n', undefined as unknown as Grammars).error, null);
    assert.equal(ex('a.ts', 'x', null as unknown as Grammars).error?.code, 'grammar_missing');
  });

  it('D4 grammar_missing message names the language and holds no content', () => {
    const r = ex('a.py', 'SECRET = 1\n', {});
    assert.deepEqual(r.error, { code: 'grammar_missing', message: 'grammar for python is not loaded' });
  });

  it('D5 BOM and CRLF give the same rows for python, bash and json', () => {
    const cases: [string, string][] = [
      ['a.py', 'class K:\n    def m(self): pass\n'],
      ['a.sh', 'f() { echo hi; }\n'],
      ['package.json', '{"a": {"b": 1}}\n'],
    ];
    for (const [p, c] of cases) {
      assert.deepEqual(ex(p, `\ufeff${c.replaceAll('\n', '\r\n')}`), ex(p, c));
    }
  });

  it('D6 repeated calls give deep-equal, unshared results', () => {
    const a = ex('src/a.ts', 'export function f() { g(); }\n');
    const b = ex('src/a.ts', 'export function f() { g(); }\n');
    assert.deepEqual(a, b);
    assert.notEqual(a.nodes, b.nodes);
    a.nodes.length = 0;
    assert.equal(b.nodes.length, 2);
  });

  it('D17 duplicate ids inside one file keep the first occurrence only', () => {
    const r = ex('pkg/d.py', 'def f(): pass\ndef f(): pass\n');
    assert.deepEqual(r.nodes.map((n) => [n.id, n.sourceLocation]), [['code:pkg_d', 'L1'], ['code:pkg_d_f', 'L1']]);
  });

  it('D19 a long receiver is cut to maxReceiverChars code points', () => {
    const r = ex('r.ts', `${'ab.'.repeat(100)}f();\n`);
    assert.equal(r.refs[0]?.receiver?.length, 128);
  });

  it('D16 headings inside fences and a heading that repeats the page id get unique ids', () => {
    const r = ex('d/p.md', '#  \n# p\n```\n# no\n```\n');
    assert.equal(new Set(ids(r)).size, r.nodes.length);
    assert.ok(!ids(r).includes('doc:d_p_no'));
  });
  it('D14 a key that normalises to empty is skipped even below the root', () => {
    assert.deepEqual(ids(ex('tsconfig.json', '{"compilerOptions":{"paths":{"@/*":["x"]}}}')), ['code:tsconfig', 'code:tsconfig_compileroptions', 'code:tsconfig_compileroptions_paths']);
    assert.deepEqual(ids(ex('x.json', '{"dependencies":{"b":{"!!!":1,"c":2}}}')), ['code:x', 'code:x_dependencies', 'code:x_dependencies_b', 'code:x_b_c']);
  });

  it('D8 a class inside a function body is not a node (ts and python); a namespace is', () => {
    assert.deepEqual(ids(ex('a.ts', 'function f2() { class Inner { im() {} } }')), ['code:a', 'code:a_f2']);
    const py = ex('b.py', 'def outer():\n    class C:\n        def cm(self): pass\n');
    assert.deepEqual(py.nodes.map((n) => [n.id, n.label, n.type]), [['code:b', 'b.py', 'file'], ['code:b_outer', 'outer()', 'function'], ['code:b_outer_cm', 'cm()', 'function']]);
    assert.deepEqual(ids(ex('p/a.ts', 'namespace NS { export function nsf() {} }')), ['code:p_a', 'code:p_a_ns', 'code:p_a_nsf']);
  });

  it('D8/D11 string-named declare module is a node; exported const/let in a namespace are variables, others are not', () => {
    assert.deepEqual(ids(ex('c.ts', "declare module 'pkg-y' { interface IY {} }")), ['code:c', 'code:c_pkg_y', 'code:c_iy']);
    assert.deepEqual(ids(ex('c.ts', 'namespace NS2 { export const ov = { a: 1 }; const priv = { b: 2 }; export let num = 3; }')), ['code:c', 'code:c_ns2', 'code:c_ov', 'code:c_num']);
    assert.deepEqual(ids(ex('a.ts', 'module Foo { export const v = 1; }')), ['code:a', 'code:a_foo', 'code:a_v']);
  });
  it('D8 declarations inside a named variable initializer are not nodes; module-level callbacks still are', () => {
    const src = 'const cb = [1].map(() => { function fx() {} class InCb { q() {} } });\nexport const w = wrap(function () { class Wc { wm() {} } });';
    assert.deepEqual(ids(ex('e.ts', src)), ['code:e', 'code:e_cb', 'code:e_w']);
    assert.deepEqual(ids(ex('c.ts', "describe('x', () => { class X {} });\n(function () { class Y {} })();")), ['code:c', 'code:c_x', 'code:c_y']);
  });
});
