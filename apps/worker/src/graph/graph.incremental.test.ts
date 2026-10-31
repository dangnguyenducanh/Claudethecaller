import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scratchRepos, type ScratchRepos } from '../library/testing.ts';
import { fid, fns, kit, sid, type Kit } from './testing.ts';

let s: ScratchRepos;
let k: Kit;
beforeAll(async () => {
  s = await scratchRepos('ctc_t22_');
  k = await kit(s.repos);
}, 60_000);
afterAll(async () => {
  k?.cleanup();
  await s?.drop();
});

const MAIN: Record<string, string> = {
  'src/a.ts': "import { helper } from './b.ts';\nimport fs from 'node:fs';\nexport function main() { helper(); fs.readFileSync('x'); }\n",
  'src/b.ts': 'export function helper() { return 1; }\n',
  'src/c.ts': 'export function c() { return 3; }\n',
};
const rowsOf = async (ctx: { userId: string; projectId: string }, notFile: string) => {
  const g = await s.repos.graph.loadGraph(ctx);
  const own = new Set(g.nodes.filter((n) => n.sourceFile === notFile).map((n) => n.id));
  return { nodes: g.nodes.filter((n) => n.sourceFile !== notFile), edges: g.edges.filter((e) => !own.has(e.src)), own: g.nodes.filter((n) => n.sourceFile === notFile) };
};

describe('graph.incremental', () => {
  it('edit 1 file → only its rows change', async () => {
    const pr = await k.project(MAIN);
    await k.rebuild(pr);
    const before = await rowsOf(pr.ctx, 'src/b.ts');
    pr.put('src/b.ts', 'export function helper() { return 1; }\nexport function extra() { return 2; }\n');
    const r = await k.rebuild(pr, { files: ['src/b.ts'] });
    expect(r.files.written).toEqual(['src/b.ts']);
    const after = await rowsOf(pr.ctx, 'src/b.ts');
    expect(after.nodes).toEqual(before.nodes);
    expect(after.edges).toEqual(before.edges);
    expect(after.own.map((n) => n.id).sort()).toEqual([fid('src/b.ts'), sid('src/b.ts', 'extra'), sid('src/b.ts', 'helper')].sort());
    expect(before.own.length).toBe(2);
  });

  it('callers keep edges', async () => {
    const pr = await k.project(MAIN);
    await k.rebuild(pr);
    const edge = async () => (await s.repos.graph.loadGraph(pr.ctx)).edges.find((e) => e.src === sid('src/a.ts', 'main') && e.dst === sid('src/b.ts', 'helper'));
    await expect(edge()).resolves.toMatchObject({ confidence: 'EXTRACTED', relation: 'calls' });
    const aRow = (await s.repos.graph.listSources(pr.ctx)).find((x) => x.file === 'src/a.ts');
    pr.put('src/b.ts', 'export function helper() { return 99; }\n');
    const r = await k.rebuild(pr, { files: ['src/b.ts'] });
    expect([r.files.written, r.files.dependents]).toEqual([['src/b.ts'], []]);
    expect(await edge()).toMatchObject({ confidence: 'EXTRACTED', relation: 'calls' });
    expect((await s.repos.graph.listSources(pr.ctx)).find((x) => x.file === 'src/a.ts')).toEqual(aRow);
  });

  it('guard trips above 20% loss', async () => {
    const pr = await k.project({ 'big.ts': fns(14) });
    await k.rebuild(pr);
    const count = async () => (await s.repos.graph.loadGraph(pr.ctx)).nodes.filter((n) => n.sourceFile === 'big.ts').length;
    expect(await count()).toBe(15);
    pr.put('big.ts', fns(11));
    expect((await k.rebuild(pr, { files: ['big.ts'] })).files.written).toEqual(['big.ts']);
    expect(await count()).toBe(12);
    pr.put('big.ts', fns(8));
    const r = await k.rebuild(pr, { files: ['big.ts'] });
    expect([r.files.refused, r.files.written, await count()]).toEqual([['big.ts'], [], 12]);
    const forced = await k.rebuild(pr, { files: ['big.ts'], force: true });
    expect([forced.files.refused, forced.files.written, await count()]).toEqual([[], ['big.ts'], 9]);
  });
});
