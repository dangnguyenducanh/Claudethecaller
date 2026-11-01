import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EXTRACTOR_VERSION, contentHash } from '@ctc/core/graph';
import { scratchRepos, type ScratchRepos } from '../library/testing.ts';
import { graphLimits } from './index.ts';
import { fid, fns, kit, sid, vec, type Kit } from './testing.ts';

let s: ScratchRepos;
let k: Kit;
const keep = { ...graphLimits };
beforeAll(async () => {
  s = await scratchRepos('ctc_t22_');
  k = await kit(s.repos);
}, 60_000);
afterAll(async () => {
  k?.cleanup();
  await s?.drop();
});
afterEach(() => void Object.assign(graphLimits, keep));

const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const MAIN: Record<string, string> = {
  'src/a.ts': "import { helper } from './b.ts';\nimport * as u from './util.ts';\nimport fs from 'node:fs';\nimport { f2 } from './b.ts';\nexport function main() { helper(); u.fmt(); fs.readFileSync('x'); f2(); }\n",
  'src/b.ts': "export function helper() { return 1; }\nexport { fmt as f2 } from './util.ts';\n",
  'src/util.ts': 'export function fmt() { return 2; }\n',
};
const nodesOf = async (ctx: { userId: string; projectId: string }, file: string) => (await s.repos.graph.loadGraph(ctx)).nodes.filter((n) => n.sourceFile === file);
const sources = async (ctx: { userId: string; projectId: string }) => (await s.repos.graph.listSources(ctx)).map((x) => x.file);
const snapshot = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      out.push(`${p}|${st.size}|${st.mtimeMs}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
};

describe('rebuildProject', () => {
  it('returns a JSON-safe result with the documented keys (D3)', async () => {
    const pr = await k.project({ 'ok.ts': 'export function ok() {}\n' });
    const r = await k.rebuild(pr);
    expect(r).toEqual(JSON.parse(JSON.stringify(r)));
    expect(Object.keys(r).sort()).toEqual(['counts', 'epoch', 'files', 'mode', 'truncated']);
    expect(Object.keys(r.counts).sort()).toEqual(['changed', 'deleted', 'dependents', 'duplicates', 'embedded', 'failed', 'refused', 'skipped', 'unchanged', 'walked', 'written']);
    expect(Object.keys(r.files).sort()).toEqual(['deleted', 'dependents', 'duplicates', 'failed', 'refused', 'skipped', 'written']);
    expect(r.mode).toBe('full');
  });

  it('cuts result lists to resultListMax while counts stay exact (D2, D3)', async () => {
    const pr = await k.project({ 'a.ts': 'x', 'b.ts': 'x', 'c.ts': 'x' });
    graphLimits.resultListMax = 2;
    const r = await k.rebuild(pr);
    expect([r.counts.written, r.files.written]).toEqual([3, ['a.ts', 'b.ts']]);
  });

  it('handles odd input: empty project, files: [], duplicates, BOM and CRLF, bad package.json (D5)', async () => {
    const empty = await k.project();
    const r0 = await k.rebuild(empty);
    expect([Object.values(r0.counts).every((n) => n === 0), r0.epoch, await sources(empty.ctx)]).toEqual([true, null, []]);
    const pr = await k.project({ 'w.ts': '﻿export function w() {}\r\nexport function v() {}\r\n', 'package.json': '{ not json', 'e.ts': '// nothing\n' });
    const r1 = await k.rebuild(pr, { files: [] });
    expect([r1.mode, r1.counts.written, await sources(pr.ctx)]).toEqual(['files', 0, []]);
    expect((await k.rebuild(pr, { files: ['w.ts', 'w.ts', 'never.ts'] })).files.written).toEqual(['w.ts']);
    expect((await nodesOf(pr.ctx, 'w.ts')).map((n) => n.id).sort()).toEqual([fid('w.ts'), sid('w.ts', 'v'), sid('w.ts', 'w')].sort());
    await k.rebuild(pr);
    expect((await nodesOf(pr.ctx, 'e.ts')).map((n) => n.type)).toEqual(['file']);
  });

  it('never writes under the root and never touches non-ast rows (D6)', async () => {
    const pr = await k.project({ ...MAIN, '.gitignore': 'x\n' });
    const before = snapshot(pr.root);
    await k.rebuild(pr);
    await k.rebuild(pr, { force: true });
    expect(snapshot(pr.root)).toEqual(before);
    const src = { contentHash: 's', extractorVersion: 'v' };
    await s.repos.graph.replaceSource(pr.ctx, { origin: 'session', sourceFile: 'src/a.ts', nodes: [{ id: 'sess-1', kind: 'code', type: 'function', label: 's' }], edges: [], source: src });
    await s.repos.graph.replaceSource(pr.ctx, { origin: 'parser', sourceFile: 'src/a.ts', nodes: [{ id: 'parser-1', kind: 'code', type: 'function', label: 'p' }], edges: [], source: src });
    await k.rebuild(pr, { force: true });
    const ids = (await s.repos.graph.loadGraph(pr.ctx)).nodes.map((n) => n.id);
    expect([ids.includes('sess-1'), ids.includes('parser-1')]).toEqual([true, true]);
  });

  it('writes no references, rationale_for or ctx nodes and a null built_at_commit (D7)', async () => {
    const pr = await k.project({ ...MAIN, 'docs/x.md': '# T2.1 spec\nUses `helper` and skill tdd. D3 decides.\n' });
    await k.rebuild(pr);
    const g = await s.repos.graph.loadGraph(pr.ctx);
    expect(g.edges.filter((e) => ['references', 'rationale_for', 'part_of', 'decides', 'uses'].includes(e.relation))).toEqual([]);
    expect(g.nodes.filter((n) => /^(ctx|skill|agent|command|workflow):/.test(n.id))).toEqual([]);
    expect((await s.repos.graph.listSources(pr.ctx)).map((x) => x.builtAtCommit).filter((x) => x !== null)).toEqual([]);
  });

  it('hashes files, skips unchanged ones and rebuilds on an extractor_version change (D10)', async () => {
    const pr = await k.project({ ...MAIN, 'bin.ts': 'a\u0000b' });
    const r1 = await k.rebuild(pr);
    expect([r1.counts.written, r1.files.skipped.find((x) => x.file === 'bin.ts')?.reason]).toEqual([3, 'binary']);
    const r2 = await k.rebuild(pr);
    expect([r2.counts.changed, r2.counts.written, r2.counts.unchanged, r2.epoch]).toEqual([0, 0, 3, null]);
    const old = await nodesOf(pr.ctx, 'src/b.ts');
    await s.repos.graph.replaceSource(pr.ctx, {
      origin: 'ast', sourceFile: 'src/b.ts', nodes: old.map((n) => ({ id: n.id, kind: n.kind, type: n.type, label: n.label, contentHash: n.contentHash, meta: n.meta })), edges: [],
      source: { contentHash: contentHash('src/b.ts', MAIN['src/b.ts'] as string), extractorVersion: 'old' },
    });
    expect((await k.rebuild(pr)).files.written).toEqual(['src/b.ts']);
    expect((await k.rebuild(pr, { force: true })).counts.written).toBe(3);
    const row = (await s.repos.graph.listSources(pr.ctx)).find((x) => x.file === 'src/util.ts');
    expect([row?.contentHash, row?.extractorVersion]).toEqual([contentHash('src/util.ts', MAIN['src/util.ts'] as string), EXTRACTOR_VERSION]);
  });

  it('writes per-file ast rows, node hash = sha256(embed text), reexports on the file node, duplicate ids to the smaller path (D15)', async () => {
    const pr = await k.project({ ...MAIN, 'foo.ts': 'export function a() {}\n', 'foo.py': 'def b():\n    pass\n' });
    const r = await k.rebuild(pr);
    expect(r.files.duplicates).toEqual([{ id: 'code:foo', file: 'foo.ts', owner: 'foo.py' }]);
    const g = await s.repos.graph.loadGraph(pr.ctx);
    const node = (id: string) => g.nodes.find((n) => n.id === id);
    expect([node('code:foo')?.sourceFile, node(sid('foo.ts', 'a'))?.sourceFile]).toEqual(['foo.py', 'foo.ts']);
    expect((await sources(pr.ctx)).filter((f) => f.startsWith('foo')).sort()).toEqual(['foo.py', 'foo.ts']);
    expect((node(fid('src/b.ts'))?.meta as { reexports: unknown }).reexports).toEqual([{ specifier: './util.ts', names: [{ imported: 'fmt', local: 'f2' }] }]);
    expect(node(sid('src/util.ts', 'fmt'))?.contentHash).toBe(sha('fmt()\nexport function fmt() { return 2; }'));
    expect(g.nodes.filter((n) => n.sourceFile !== '<packages>').map((n) => n.origin).filter((o) => o !== 'ast')).toEqual([]);
    const known = new Set(g.nodes.map((n) => n.id));
    expect(g.edges.filter((e) => !known.has(e.src))).toEqual([]);
    expect((await s.repos.graph.listSources(pr.ctx)).find((x) => x.file === 'src/util.ts')).toMatchObject({ contentHash: contentHash('src/util.ts', MAIN['src/util.ts'] as string), extractorVersion: EXTRACTOR_VERSION });
  });

  it('applies the shrink guard per file: floor, exact 20%, refusal keeps rows, force writes (D16)', async () => {
    const pr = await k.project({ 'big.ts': fns(14), 'small.ts': fns(4) });
    await k.rebuild(pr);
    pr.put('big.ts', fns(8));
    const r = await k.rebuild(pr, { files: ['big.ts'] });
    expect([r.files.refused, r.counts.refused, (await nodesOf(pr.ctx, 'big.ts')).length]).toEqual([['big.ts'], 1, 15]);
    pr.put('small.ts', fns(2));
    expect((await k.rebuild(pr, { files: ['small.ts'] })).files.written).toEqual(['small.ts']);
    graphLimits.shrinkMinLoss = 1;
    pr.put('small.ts', fns(1));
    expect((await k.rebuild(pr, { files: ['small.ts'] })).files.refused).toEqual(['small.ts']);
  });

  it('deletes rows of removed files; dependents of removed ids are rewritten so no edge dangles (D17)', async () => {
    const pr = await k.project({ ...MAIN, 'c.ts': 'export function c() {}\n' });
    await k.rebuild(pr);
    pr.put('src/b.ts', "export function helper2() { return 1; }\nexport { fmt as f2 } from './util.ts';\n");
    const r2 = await k.rebuild(pr, { files: ['src/b.ts'] });
    expect(r2.files.dependents).toEqual(['src/a.ts']);
    const g = await s.repos.graph.loadGraph(pr.ctx);
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(g.edges.filter((e) => e.dst.startsWith('code:') && !e.dst.startsWith('code:pkg:') && !ids.has(e.dst))).toEqual([]);
    pr.remove('c.ts');
    const r3 = await k.rebuild(pr);
    expect([r3.files.deleted, (await sources(pr.ctx)).includes('c.ts'), (await nodesOf(pr.ctx, 'c.ts')).length]).toEqual([['c.ts'], false, 0]);
  });

  it('keeps the rows of files a truncated walk did not see (D6, D17)', async () => {
    const pr = await k.project({ 'a.ts': 'export function a() {}\n', 'b.ts': 'export function b() {}\n' });
    await k.rebuild(pr);
    graphLimits.maxFiles = 1;
    const r = await k.rebuild(pr);
    expect([r.truncated, r.files.deleted, await sources(pr.ctx)]).toEqual([true, [], ['a.ts', 'b.ts']]);
  });

  it.skipIf(process.getuid?.() === 0)('keeps the rows of files whose directory cannot be stat\'ed, full walk or files mode (D6, D8, D17)', async () => {
    const pr = await k.project({ 'src/a.ts': 'export function a() {}\n', 'lib/b.ts': 'export function b() {}\n' });
    await k.rebuild(pr);
    const lib = path.join(pr.root, 'lib');
    try {
      for (const mode of [0o644, 0o000]) {
        fs.chmodSync(lib, mode);
        for (const opts of [{}, { files: ['lib/b.ts'] }]) {
          const r = await k.rebuild(pr, opts);
          expect([mode, r.files.deleted, r.truncated || r.files.failed.some((f) => f.file === 'lib/b.ts'), await sources(pr.ctx)]).toEqual([mode, [], true, ['lib/b.ts', 'src/a.ts']]);
        }
      }
    } finally {
      fs.chmodSync(lib, 0o755);
    }
  });

  it('keeps package nodes in <packages> and removes them with their last importer (D18)', async () => {
    const pr = await k.project({ 'p.ts': "import { z } from 'zod-x';\nexport function f() { return z; }\n" });
    await k.rebuild(pr);
    const pkg = (await s.repos.graph.loadGraph(pr.ctx)).nodes.find((n) => n.id === 'code:pkg:zod-x');
    expect([pkg?.sourceFile, pkg?.type, (await sources(pr.ctx)).includes('<packages>')]).toEqual(['<packages>', 'package', true]);
    pr.put('p.ts', 'export function f() { return 1; }\n');
    const r = await k.rebuild(pr);
    expect([(await sources(pr.ctx)).includes('<packages>'), (await nodesOf(pr.ctx, '<packages>')).length, r.files.written, r.files.deleted]).toEqual([false, 0, ['p.ts'], []]);
  });

  it('rotates the epoch and publishes ctc:inval only when something changed; failures are ignored (D19)', async () => {
    const calls: unknown[][] = [];
    const cache = { epoch: { rotate: async (...a: unknown[]) => { calls.push(['rotate', ...a]); return 'tok-1'; } }, publishInval: async (m: unknown) => void calls.push(['inval', m]) };
    const pr = await k.project({ 'e.ts': 'export function e() {}\n' }, `u-${Math.random().toString(16).slice(2)}`);
    const r1 = await k.rebuild(pr, { cache });
    expect([r1.epoch, calls]).toEqual(['tok-1', [['rotate', 'graph', pr.ctx.userId, pr.ctx.projectId], ['inval', { v: 1, event: 'graph.rebuild', userId: pr.ctx.userId, projectId: pr.ctx.projectId }]]]);
    expect([(await k.rebuild(pr, { cache })).epoch, calls.length]).toEqual([null, 2]);
    pr.put('e.ts', 'export function e() {}\nexport function e2() {}\n');
    const boom = { epoch: { rotate: async () => { throw new Error('redis down'); } }, publishInval: async () => { throw new Error('redis down'); } };
    const r3 = await k.rebuild(pr, { cache: boom });
    expect([r3.files.written, r3.epoch]).toEqual([['e.ts'], null]);
  });

  it('embeds pending nodes in batches, keeps vectors of unchanged nodes, skips bad vectors, survives an embed failure (D20)', async () => {
    const batches: string[][] = [];
    const embed = async (texts: string[]) => { batches.push(texts); return texts.map(() => vec()); };
    const pr = await k.project({ 'e.ts': 'export function one() { return 1; }\nexport function two() { return 2; }\n' }, `u-${Math.random().toString(16).slice(2)}`);
    graphLimits.embedBatch = 2;
    const r1 = await k.rebuild(pr, { embed });
    expect([r1.counts.embedded, batches.map((b) => b.length)]).toEqual([3, [2, 1]]);
    expect(batches.flat()).toContain('one()\nexport function one() { return 1; }');
    batches.length = 0;
    expect([(await k.rebuild(pr, { embed })).counts.embedded, batches.length]).toEqual([0, 0]);
    pr.put('e.ts', 'export function one() { return 1; }\nexport function two() { return 3; }\n');
    expect((await k.rebuild(pr, { embed })).counts.embedded).toBe(2);
    expect((await s.repos.graph.loadVectors(pr.ctx)).length).toBe(3);
    const pr2 = await k.project({ 'f.ts': 'export function f() {}\n' }, `u-${Math.random().toString(16).slice(2)}`);
    const bad = await k.rebuild(pr2, { embed: async (t: string[]) => t.map(() => [1, 2, 3]) });
    expect([bad.counts.embedded, (await s.repos.graph.pendingEmbeddings(pr2.ctx, {})).length]).toEqual([0, 2]);
    expect((await k.rebuild(pr2, { embed: async () => { throw new Error('tei down'); } })).counts.embedded).toBe(0);
    expect((await k.rebuild(pr2, { embed: async () => [] })).counts.embedded).toBe(0);
  });

  it('files mode rebuilds only the listed files; more than maxPayloadFiles is a full walk (D21)', async () => {
    const pr = await k.project({ 'x.ts': 'export function x() {}\n', 'y.ts': 'export function y() {}\n' });
    graphLimits.maxPayloadFiles = 1;
    expect((await k.rebuild(pr, { files: ['x.ts'] })).mode).toBe('files');
    expect((await k.rebuild(pr, { files: ['x.ts', 'y.ts'] })).mode).toBe('full');
  });

  it('stops on the abort signal after a write and still reports the epoch step (D19)', async () => {
    const calls: string[] = [];
    const cache = { epoch: { rotate: async () => { calls.push('rotate'); return 't'; } }, publishInval: async () => void calls.push('inval') };
    const pr = await k.project({ 'a.ts': 'export function a() {}\n', 'b.ts': 'export function b() {}\n' });
    const ac = new AbortController();
    const origin = s.repos.graph.replaceSource;
    let n = 0;
    s.repos.graph.replaceSource = async (...a: Parameters<typeof origin>) => {
      const out = await origin(...a);
      if (++n === 1) ac.abort();
      return out;
    };
    try {
      await expect(k.rebuild(pr, { cache, signal: ac.signal })).rejects.toThrow();
    } finally {
      s.repos.graph.replaceSource = origin;
    }
    expect([n, calls, await sources(pr.ctx)]).toEqual([1, ['rotate', 'inval'], ['a.ts']]);
  });
});
