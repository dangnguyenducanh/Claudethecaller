import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { beforeAll, describe, it } from 'vitest';
import * as g from './index.ts';
import type { ExtractResult, Grammars, PackageJson, ResolveOutput } from './index.ts';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
type Row = [string, string, string, number];

describe('graph.resolve', () => {
  let grammars: Grammars;
  beforeAll(async () => {
    grammars = await g.loadGrammars();
  });

  const ex = (p: string, content: string): ExtractResult => g.extractFile({ path: p, content }, grammars);
  const fid = (p: string): string => `code:${g.makeId(g.fileStem(p))}`;
  const sid = (p: string, ...names: string[]): string => `code:${g.makeId(g.fileStem(p), ...names)}`;
  const resolve = (srcs: Record<string, string>, o: { files?: string[]; packages?: PackageJson[] } = {}): ResolveOutput =>
    g.resolveGraph({
      results: Object.entries(srcs).map(([p, s]) => ex(p, s)),
      context: [],
      files: [...Object.keys(srcs), ...(o.files ?? [])].sort(byCode),
      packages: o.packages ?? [],
    });
  const all = (out: ResolveOutput) => Object.values(out.edges).flat();
  const from = (out: ResolveOutput, src: string, rel?: string): Row[] =>
    all(out)
      .filter((e) => e.src === src && (!rel || e.relation === rel))
      .map((e): Row => [e.dst, e.relation, e.confidence, e.score])
      .sort((a, b) => byCode(a[0], b[0]));
  const rows = (r: Row[]): Row[] => r.sort((a, b) => byCode(a[0], b[0]));
  const withLimits = (patch: Partial<typeof g.resolveLimits>, fn: () => void): void => {
    const keep = { ...g.resolveLimits };
    Object.assign(g.resolveLimits, patch);
    try {
      fn();
    } finally {
      Object.assign(g.resolveLimits, keep);
    }
  };

  const MAIN: Record<string, string> = {
    'src/a.ts':
      "import { helper } from './b.ts';\nimport * as u from './util.ts';\nimport fs from 'node:fs';\nimport { f2 } from './b.ts';\nexport function main() { helper(); u.fmt(); fs.readFileSync('x'); f2(); }\n",
    'src/b.ts': "export function helper() { return 1; }\nexport { fmt as f2 } from './util.ts';\n",
    'src/util.ts': 'export function fmt() { return 2; }\n',
  };

  it('a call becomes EXTRACTED only with an import edge', () => {
    const out = resolve(MAIN);
    assert.deepEqual(
      from(out, sid('src/a.ts', 'main'), 'calls'),
      rows([[sid('src/b.ts', 'helper'), 'calls', 'EXTRACTED', 1], [sid('src/util.ts', 'fmt'), 'calls', 'EXTRACTED', 1]]),
    );
    const noImport = resolve({ ...MAIN, 'src/a.ts': 'export function main() { helper(); }\n' });
    assert.deepEqual(from(noImport, sid('src/a.ts', 'main'), 'calls'), [[sid('src/b.ts', 'helper'), 'calls', 'INFERRED', 0.85]]);
    const twin = resolve({ ...MAIN, 'src/a.ts': 'export function main() { helper(); }\n', 'src/c.ts': 'export function helper() {}\n' });
    assert.deepEqual(
      from(twin, sid('src/a.ts', 'main'), 'calls'),
      rows([[sid('src/b.ts', 'helper'), 'calls', 'AMBIGUOUS', 0.3], [sid('src/c.ts', 'helper'), 'calls', 'AMBIGUOUS', 0.3]]),
    );
    const py = resolve({ 'pkg/m.py': 'from .n import g as gg\ndef f():\n    gg()\n', 'pkg/n.py': 'def g():\n    pass\n' });
    assert.deepEqual(from(py, sid('pkg/m.py', 'f'), 'calls'), [[sid('pkg/n.py', 'g'), 'calls', 'EXTRACTED', 1]]);
  });

  it('ambiguous names become AMBIGUOUS', () => {
    const srcs: Record<string, string> = { 'a.ts': 'export function main() { dup(); }\n', 'x/b.ts': 'export function dup() {}\n', 'y/c.ts': 'export function dup() {}\n' };
    const two = resolve(srcs);
    assert.deepEqual(
      from(two, sid('a.ts', 'main'), 'calls'),
      rows([[sid('x/b.ts', 'dup'), 'calls', 'AMBIGUOUS', 0.3], [sid('y/c.ts', 'dup'), 'calls', 'AMBIGUOUS', 0.3]]),
    );
    const six: Record<string, string> = { 'a.ts': srcs['a.ts'] as string };
    for (let i = 0; i < 6; i++) six[`d${i}/m.ts`] = 'export function dup() {}\n';
    assert.deepEqual(from(resolve(six), sid('a.ts', 'main'), 'calls'), []);
    withLimits({ maxAmbiguous: 6 }, () => assert.equal(from(resolve(six), sid('a.ts', 'main'), 'calls').length, 6));
    withLimits({ maxAmbiguous: 1 }, () => assert.deepEqual(from(resolve(srcs), sid('a.ts', 'main'), 'calls'), []));
  });

  it('pins the defaults and the scores', () => {
    assert.deepEqual({ ...g.resolveLimits }, { maxAmbiguous: 5, maxReexportHops: 5 });
    assert.deepEqual({ ...g.SCORES }, { sameFile: 0.95, samePackage: 0.85, nameOnly: 0.6, ambiguous: 0.3, extracted: 1 });
  });

  it('tiers: same file, same package, name only; this.x() stays in the class; unknown names give no edge', () => {
    const srcs: Record<string, string> = {
      'p1/a.ts': 'function loc() {}\nexport function main() { loc(); near(); far(); nowhere(); main(); }\nexport class K { run() { this.go(); } go() {} }\n',
      'p1/b.ts': 'export function near() {}\n',
      'p2/d.ts': 'export function far() {}\n',
    };
    const out = resolve(srcs, { files: ['p1/package.json', 'p2/package.json'] });
    assert.deepEqual(
      from(out, sid('p1/a.ts', 'main'), 'calls'),
      rows([[sid('p1/a.ts', 'loc'), 'calls', 'INFERRED', 0.95], [sid('p1/b.ts', 'near'), 'calls', 'INFERRED', 0.85], [sid('p2/d.ts', 'far'), 'calls', 'INFERRED', 0.6]]),
    );
    assert.deepEqual(from(out, sid('p1/a.ts', 'K', 'run'), 'calls'), [[sid('p1/a.ts', 'K', 'go'), 'calls', 'INFERRED', 0.95]]);
  });

  it('other receivers match methods only and never by name alone; an external package call gives no edge', () => {
    const out = resolve(
      {
        'a.ts': "import fs from 'node:fs';\nexport function main(o: any) { o.run(); o.top(); fs.top(); }\n",
        'b.ts': 'export function top() {}\n',
        'p/c.ts': 'export class C { run() {} }\n',
      },
      { files: ['p/package.json'] },
    );
    assert.deepEqual(from(out, sid('a.ts', 'main'), 'calls'), []);
    const same = resolve({ 'a.ts': 'export function main(o: any) { o.run(); }\nclass B { run() {} }\n' });
    assert.deepEqual(from(same, sid('a.ts', 'main'), 'calls'), [[sid('a.ts', 'B', 'run'), 'calls', 'INFERRED', 0.95]]);
  });

  it('class bases and implements become inherits and implements edges', () => {
    const out = resolve({
      'a.ts': "import { Base } from './b.ts';\nexport class K extends Base implements I {}\ninterface I {}\n",
      'b.ts': 'export class Base {}\n',
    });
    assert.deepEqual(from(out, sid('a.ts', 'K')), rows([[sid('b.ts', 'Base'), 'inherits', 'EXTRACTED', 1], [sid('a.ts', 'I'), 'implements', 'INFERRED', 0.95]]));
  });

  it('specifiers: .js to .ts, index files, workspace exports, unknown package node, python and bash', () => {
    const srcs: Record<string, string> = {
      'src/a.ts': "import { b } from './b.js';\nimport * as d from './dir';\nimport { z } from 'lodash';\nimport { q } from '@w/lib';\nimport 'https://x.test/m.js';\n",
      'src/b.ts': 'export const b = 1;\n',
      'src/dir/index.ts': 'export const i = 1;\n',
      'packages/lib/src/main.ts': 'export const q = 1;\n',
      'pkg/__init__.py': '',
      'pkg/m.py': 'from .n import g\nimport os\nfrom pkg import n\n',
      'pkg/n.py': 'def g():\n    pass\n',
      's.sh': 'source ./lib.sh\n',
      'lib.sh': 'x=1\n',
    };
    const out = resolve(srcs, { packages: [{ dir: 'packages/lib', name: '@w/lib', exports: { '.': './src/main.ts' } }], files: ['packages/lib/package.json'] });
    const imp = (src: string): Row[] => from(out, src).filter((e) => e[1] === 'imports' || e[1] === 'imports_from');
    assert.deepEqual(
      imp(fid('src/a.ts')),
      rows([
        ['code:pkg:lodash', 'imports_from', 'EXTRACTED', 1],
        [fid('packages/lib/src/main.ts'), 'imports_from', 'EXTRACTED', 1],
        [fid('src/b.ts'), 'imports_from', 'EXTRACTED', 1],
        [fid('src/dir/index.ts'), 'imports', 'EXTRACTED', 1],
      ]),
    );
    assert.deepEqual(
      imp(fid('pkg/m.py')),
      rows([['code:pkg:os', 'imports', 'EXTRACTED', 1], [fid('pkg/__init__.py'), 'imports_from', 'EXTRACTED', 1], [fid('pkg/n.py'), 'imports_from', 'EXTRACTED', 1]]),
    );
    assert.deepEqual(imp(fid('s.sh')), [[fid('lib.sh'), 'imports', 'EXTRACTED', 1]]);
    assert.deepEqual(out.packages.map((p) => p.id), ['code:pkg:lodash', 'code:pkg:os']);
  });

  it('re-exports prove a call (also from stored context nodes) and are returned for the file node', () => {
    const out = resolve(MAIN);
    assert.deepEqual(out.reexports['src/b.ts'], [{ specifier: './util.ts', names: [{ imported: 'fmt', local: 'f2' }] }]);
    const context = [
      { id: fid('src/b.ts'), type: 'file', label: 'b.ts', sourceFile: 'src/b.ts', meta: { reexports: out.reexports['src/b.ts'] } },
      { id: sid('src/b.ts', 'helper'), type: 'function', label: 'helper()', sourceFile: 'src/b.ts' },
      { id: fid('src/util.ts'), type: 'file', label: 'util.ts', sourceFile: 'src/util.ts' },
      { id: sid('src/util.ts', 'fmt'), type: 'function', label: 'fmt()', sourceFile: 'src/util.ts' },
    ];
    const again = g.resolveGraph({ results: [ex('src/a.ts', MAIN['src/a.ts'] as string)], context, files: Object.keys(MAIN), packages: [] });
    assert.deepEqual(from(again, sid('src/a.ts', 'main'), 'calls'), from(out, sid('src/a.ts', 'main'), 'calls'));
    const viaAlias = "import { f2 } from './b.ts';\nexport function main() { f2(); }\n";
    const chain = (): ResolveOutput => g.resolveGraph({ results: [ex('src/a.ts', viaAlias)], context, files: Object.keys(MAIN), packages: [] });
    assert.deepEqual(from(chain(), sid('src/a.ts', 'main'), 'calls'), [[sid('src/util.ts', 'fmt'), 'calls', 'EXTRACTED', 1]]);
    withLimits({ maxReexportHops: 0 }, () => assert.deepEqual(from(chain(), sid('src/a.ts', 'main'), 'calls'), []));
  });

  it('mentions: link and path::symbol EXTRACTED, one symbol INFERRED, unknown symbol nothing', () => {
    const out = resolve({ ...MAIN, 'docs/x.md': '# Top\nSee [b](../src/b.ts) and `src/util.ts::fmt` and `helper()` and `a.b.c`.\n' });
    const top = `doc:${g.makeId(g.fileStem('docs/x.md'), 'top')}`;
    assert.deepEqual(
      from(out, top, 'mentions'),
      rows([
        [fid('src/b.ts'), 'mentions', 'EXTRACTED', 1],
        [sid('src/util.ts', 'fmt'), 'mentions', 'EXTRACTED', 1],
        [sid('src/b.ts', 'helper'), 'mentions', 'INFERRED', 0.6],
      ]),
    );
  });

  it('output shape: a key per file, sorted unique edges, no contains edges, input untouched, deterministic', () => {
    const results = Object.entries(MAIN).map(([p, s]) => ex(p, s));
    const input = { results, context: [], files: Object.keys(MAIN).sort(byCode), packages: [] };
    const frozen = JSON.stringify(input);
    const out = g.resolveGraph(input);
    assert.equal(JSON.stringify(input), frozen);
    assert.deepEqual(g.resolveGraph(input), out);
    assert.deepEqual(Object.keys(out.edges).sort(byCode), Object.keys(MAIN).sort(byCode));
    for (const list of Object.values(out.edges)) {
      const keys = list.map((e) => [e.src, e.relation, e.dst].join('\0'));
      assert.deepEqual(keys, [...keys].sort(byCode));
      assert.equal(new Set(keys).size, keys.length);
      assert.equal(list.some((e) => (e.relation as string) === 'contains'), false);
      for (const e of list) assert.match(e.sourceLocation, /^L\d+$/);
    }
    assert.deepEqual(out.packages, [{ id: 'code:pkg:node:fs', kind: 'code', type: 'package', label: 'node:fs', sourceLocation: null, meta: {} }]);
  });

  it('never throws on junk input', () => {
    const junk: unknown[] = [
      undefined, null, 5, 'x', {}, { results: 'x' },
      { results: [null, 5, { file: 'a.ts', error: null, nodes: 'x' }] },
      { results: [], context: null, files: [1, 2], packages: [null, { dir: 5 }] },
      { results: [{ ...ex('a.ts', 'f()'), refs: [null, { from: 1 }], imports: 'x' }] },
    ];
    for (const j of junk) assert.equal(typeof g.resolveGraph(j as never).edges, 'object');
  });

  it('contentHash = sha256(body + path); markdown skips frontmatter; never throws', () => {
    assert.equal(g.contentHash('a.ts', 'export {}\n'), sha('export {}\na.ts'));
    assert.equal(g.contentHash('x.md', '---\na: 1\n---\nbody\n'), sha('body\nx.md'));
    assert.equal(g.contentHash('x.md', '---\na: 2\n---\nbody\n'), g.contentHash('x.md', '---\na: 1\n---\nbody\n'));
    assert.equal(g.contentHash('x.md', '---\nunclosed\nbody\n'), sha('---\nunclosed\nbody\nx.md'));
    assert.equal(g.contentHash('a.ts', '---\na\n---\nb'), sha('---\na\n---\nba.ts'));
    for (const [p, c] of [[undefined, null], [5, {}]] as const) assert.match(g.contentHash(p as never, c as never), /^[0-9a-f]{64}$/);
  });
});
