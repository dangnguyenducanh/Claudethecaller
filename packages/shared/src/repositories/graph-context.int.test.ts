import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scratch, type Scratch } from './scratch.ts';

let s: Scratch;
beforeAll(async () => {
  s = await scratch();
}, 60_000);
afterAll(async () => {
  await s?.drop();
});

const fresh = () => ({ userId: `u-${randomBytes(4).toString('hex')}`, projectId: `p${randomBytes(4).toString('hex')}` });
const node = (id: string) => ({ id, kind: 'context', type: 'task', label: id });
const origins = async (ctx: { userId: string; projectId: string }) => (await s.repos.graph.loadGraph(ctx)).edges.map((e) => `${e.origin}:${e.src}:${e.relation}`).sort();

describe('graph repository additions for the context layer (D17)', () => {
  it('replaceSource without source leaves graph_sources alone; a node without contentHash gets an empty one', async () => {
    const ctx = fresh();
    await s.repos.graph.replaceSource(ctx, { origin: 'ast', sourceFile: 'doc.md', nodes: [{ id: 'a1', kind: 'doc', type: 'page', label: 'a1' }], edges: [], source: { contentHash: 'h1', extractorVersion: 'v1' } });
    const before = await s.repos.graph.listSources(ctx);
    await s.repos.graph.replaceSource(ctx, { origin: 'parser', sourceFile: 'doc.md', nodes: [node('t1')], edges: [{ src: 't1', dst: 'a1', relation: 'implements', confidence: 'EXTRACTED' }] });
    expect(await s.repos.graph.listSources(ctx)).toEqual(before);
    expect((await s.repos.graph.getNode(ctx, 't1'))?.contentHash).toBe('');
  });

  it('deleteSource keepSource keeps the graph_sources row, without it the row goes', async () => {
    const ctx = fresh();
    await s.repos.graph.replaceSource(ctx, { origin: 'ast', sourceFile: 'f.ts', nodes: [{ id: 'a1', kind: 'code', type: 'file', label: 'a1' }], edges: [], source: { contentHash: 'h', extractorVersion: 'v' } });
    await s.repos.graph.deleteSource(ctx, { origin: 'ast', sourceFile: 'f.ts', keepSource: true });
    expect([(await s.repos.graph.listSources(ctx)).length, (await s.repos.graph.loadGraph(ctx)).nodes.length]).toEqual([1, 0]);
    await s.repos.graph.deleteSource(ctx, { origin: 'ast', sourceFile: 'f.ts' });
    expect((await s.repos.graph.listSources(ctx)).length).toBe(0);
  });

  it('a claude replace with no nodes swaps the claude edges leaving parser nodes and leaves parser and ast edges alone', async () => {
    const ctx = fresh();
    const f = 'doc.md';
    await s.repos.graph.replaceSource(ctx, { origin: 'ast', sourceFile: f, nodes: [{ id: 'a1', kind: 'doc', type: 'page', label: 'a1' }, { id: 'a2', kind: 'doc', type: 'heading', label: 'a2' }], edges: [{ src: 'a1', dst: 'a2', relation: 'contains', confidence: 'EXTRACTED' }], source: { contentHash: 'h', extractorVersion: 'v' } });
    await s.repos.graph.replaceSource(ctx, { origin: 'parser', sourceFile: f, nodes: [node('t1'), node('t2')], edges: [{ src: 't1', dst: 'a1', relation: 'implements', confidence: 'EXTRACTED' }] });
    await s.repos.graph.replaceSource(ctx, { origin: 'claude', sourceFile: f, nodes: [], edges: [{ src: 't2', dst: 'a1', relation: 'implements', confidence: 'INFERRED', score: 0.6 }] });
    await s.repos.graph.replaceSource(ctx, { origin: 'claude', sourceFile: f, nodes: [], edges: [{ src: 't1', dst: 'a1', relation: 'decides', confidence: 'INFERRED', score: 0.6 }] });
    expect(await origins(ctx)).toEqual(['ast:a1:contains', 'claude:t1:decides', 'parser:t1:implements']);
    await s.repos.graph.deleteSource(ctx, { origin: 'claude', sourceFile: f, keepSource: true });
    expect(await origins(ctx)).toEqual(['ast:a1:contains', 'parser:t1:implements']);
  });

  it('another user cannot replace or delete these rows', async () => {
    const a = fresh();
    const b = fresh();
    await s.repos.graph.replaceSource(a, { origin: 'parser', sourceFile: 'doc.md', nodes: [node('t1')], edges: [{ src: 't1', dst: 'x', relation: 'implements', confidence: 'EXTRACTED' }] });
    await s.repos.graph.replaceSource(b, { origin: 'parser', sourceFile: 'doc.md', nodes: [], edges: [] });
    expect(await s.repos.graph.deleteSource(b, { origin: 'parser', sourceFile: 'doc.md', keepSource: true })).toEqual({ deleted: 0 });
    expect(await origins(a)).toEqual(['parser:t1:implements']);
  });
});
