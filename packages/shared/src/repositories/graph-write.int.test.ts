import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RepoError } from './errors.ts';
import { scratch, type Scratch } from './scratch.ts';

let s: Scratch;
beforeAll(async () => {
  s = await scratch();
}, 60_000);
afterAll(async () => {
  await s?.drop();
});

const unit = (i: number): number[] => Array.from({ length: 1024 }, (_, j) => (j === i ? 1 : 0));
const fresh = () => ({ userId: `u-${randomBytes(4).toString('hex')}`, projectId: `p${randomBytes(4).toString('hex')}` });
const put = (ctx: { userId: string; projectId: string }, h: string, file = 'r.ts') =>
  s.repos.graph.replaceSource(ctx, {
    origin: 'ast', sourceFile: file,
    nodes: [{ id: 'n1', kind: 'code', type: 'function', label: 'n1', contentHash: h }, { id: 'n2', kind: 'code', type: 'function', label: 'n2', contentHash: 'z' }],
    edges: [{ src: 'n1', dst: 'n2', relation: 'calls', confidence: 'INFERRED', score: 0.6 }], source: { contentHash: 'f', extractorVersion: 'v' },
  });

describe('graph repository additions (D22)', () => {
  it('replaceSource keeps the embedding of a node whose content hash is unchanged', async () => {
    const ctx = fresh();
    await put(ctx, 'h1');
    await s.repos.graph.setEmbedding(ctx, 'n1', unit(0), 'h1');
    await put(ctx, 'h1');
    expect((await s.repos.graph.loadVectors(ctx)).map((v) => v.id)).toEqual(['n1']);
    await put(ctx, 'h2');
    expect(await s.repos.graph.loadVectors(ctx)).toEqual([]);
  });

  it('pendingEmbeddings pages nodes without a vector in id order and clamps the limit', async () => {
    const ctx = fresh();
    await put(ctx, 'h1');
    const page = await s.repos.graph.pendingEmbeddings(ctx, { limit: 1 });
    expect(page.map((n) => n.id)).toEqual(['n1']);
    expect(Object.keys(page[0] as object).sort()).toEqual(['contentHash', 'id', 'label', 'meta', 'sourceFile']);
    expect((await s.repos.graph.pendingEmbeddings(ctx, { afterId: 'n1' })).map((n) => n.id)).toEqual(['n2']);
    expect((await s.repos.graph.pendingEmbeddings(ctx, { limit: 0 })).length).toBe(1);
    expect((await s.repos.graph.pendingEmbeddings(ctx, { limit: 9999 })).length).toBe(2);
    await s.repos.graph.setEmbedding(ctx, 'n1', unit(1), 'h1');
    expect((await s.repos.graph.pendingEmbeddings(ctx)).map((n) => n.id)).toEqual(['n2']);
  });

  it('deleteSource removes nodes, edges leaving them and the source row; review and session origins stay', async () => {
    const ctx = fresh();
    await put(ctx, 'h1');
    await s.repos.graph.replaceSource(ctx, { origin: 'session', sourceFile: 's.ts', nodes: [{ id: 's1', kind: 'code', type: 'function', label: 's' }], edges: [], source: { contentHash: 'f', extractorVersion: 'v' } });
    expect(await s.repos.graph.deleteSource(ctx, { origin: 'session', sourceFile: 's.ts' })).toEqual({ deleted: 0 });
    expect(await s.repos.graph.getNode(ctx, 's1')).not.toBeNull();
    expect((await s.repos.graph.listSources(ctx)).map((x) => x.file)).toContain('s.ts');
    expect(await s.repos.graph.deleteSource(ctx, { origin: 'ast', sourceFile: 'r.ts' })).toEqual({ deleted: 3 });
    expect([(await s.repos.graph.listSources(ctx)).map((x) => x.file).includes('r.ts'), await s.repos.graph.getNode(ctx, 'n1')]).toEqual([false, null]);
    expect(await s.repos.graph.deleteSource(ctx, { origin: 'ast', sourceFile: 'r.ts' })).toEqual({ deleted: 0 });
  });

  it('deleteSource rejects a bad origin or an empty file with RepoError invalid and needs a project', async () => {
    const ctx = fresh();
    for (const input of [{ origin: 'nope', sourceFile: 'r.ts' }, { origin: 'ast', sourceFile: '' }]) {
      await expect(s.repos.graph.deleteSource(ctx, input)).rejects.toSatisfy((e: unknown) => e instanceof RepoError && e.code === 'invalid');
    }
    await expect(s.repos.graph.deleteSource({ userId: ctx.userId }, { origin: 'ast', sourceFile: 'r.ts' })).rejects.toThrow('ctx.projectId required');
  });
});
