import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSystemCtx } from './ctx.ts';
import { limits } from './index.ts';
import { scratch, type Scratch } from './scratch.ts';
import type { CreateVersionInput } from './library.ts';

let s: Scratch;
const A = { userId: 'user-a' };
const B = { userId: 'user-b' };
let AP: { userId: string; projectId: string };
let BP: { userId: string; projectId: string };
const sctx = createSystemCtx('graph-library int test');
const unit = (i: number): number[] => Array.from({ length: 1024 }, (_, j) => (j === i ? 1 : 0));
const caught = async (p: Promise<unknown>): Promise<{ name: string; code?: string; message: string }> => {
  try {
    await p;
  } catch (error) {
    const e = error as { name: string; code?: string; message: string };
    return { name: e.name, ...(e.code ? { code: e.code } : {}), message: e.message };
  }
  throw new Error('did not reject');
};
const keep = { ...limits };
const node = (id: string, label = id) => ({ id, kind: 'code', type: 'function', label });
const src = { contentHash: 'c1', extractorVersion: '1', builtAtCommit: 'abc' };
const skill = (name: string, files: [path: string, hash: string, content: string][] = [['SKILL.md', 'b1', 'hello']], more: Partial<CreateVersionInput> = {}): CreateVersionInput => ({
  namespace: 'user', kind: 'skill', name, rootPath: `/x/${name}`, description: 'd', frontmatter: {}, bodyHash: 'h', commitMessage: 'm',
  blobs: files.map(([, hash, content]) => ({ hash, content, size: content.length })), files: files.map(([path, blobHash]) => ({ path, blobHash })), ...more,
});

beforeAll(async () => {
  s = await scratch();
  AP = { userId: 'user-a', projectId: (await s.repos.projects.upsert(A, { root: '/gl/a' })).id };
  BP = { userId: 'user-b', projectId: (await s.repos.projects.upsert(B, { root: '/gl/b' })).id };
}, 60_000);
afterAll(async () => {
  await s?.drop();
});
afterEach(() => Object.assign(limits, keep));

describe('D14 graph', () => {
  it('D4 every function needs ctx.projectId', async () => {
    expect(await caught(s.repos.graph.stats(A))).toEqual({ name: 'TypeError', message: 'ctx.projectId required' });
    expect(await caught(s.repos.graph.replaceSource(A, { origin: 'ast', sourceFile: 'f', nodes: [], edges: [], source: src }))).toEqual({ name: 'TypeError', message: 'ctx.projectId required' });
  });
  it('replaceSource replaces the nodes and edges of one (origin, file) and keeps other files', async () => {
    const first = await s.repos.graph.replaceSource(AP, {
      origin: 'ast', sourceFile: 'a.ts', nodes: [node('a1'), node('a2')], edges: [{ src: 'a1', dst: 'a2', relation: 'calls', confidence: 'EXTRACTED' }], source: src,
    });
    expect(first).toEqual({ deleted: 0, inserted: 3 });
    await s.repos.graph.replaceSource(AP, { origin: 'ast', sourceFile: 'b.ts', nodes: [node('b1')], edges: [], source: src });
    const second = await s.repos.graph.replaceSource(AP, { origin: 'ast', sourceFile: 'a.ts', nodes: [node('a3')], edges: [], source: { ...src, contentHash: 'c2' } });
    expect(second).toEqual({ deleted: 3, inserted: 1 });
    const g = await s.repos.graph.loadGraph(AP);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['a3', 'b1']);
    expect(g.edges).toEqual([]);
    expect((await s.repos.graph.listSources(AP)).map((x) => [x.file, x.contentHash])).toEqual([['a.ts', 'c2'], ['b.ts', 'c1']]);
    expect(await s.repos.graph.sourceNodeCount(AP, 'a.ts')).toBe(1);
  });
  it('D6(c) a failure in the middle rolls everything back: old rows stay', async () => {
    await s.repos.graph.replaceSource(AP, { origin: 'ast', sourceFile: 'tx.ts', nodes: [node('t1'), node('t2')], edges: [], source: src });
    await expect(s.repos.graph.replaceSource(AP, { origin: 'ast', sourceFile: 'tx.ts', nodes: [node('t3'), { ...node('t4'), kind: 'not-a-kind' }], edges: [], source: src })).rejects.toBeTruthy();
    expect(await s.repos.graph.sourceNodeCount(AP, 'tx.ts')).toBe(2);
    expect((await s.repos.graph.getNode(AP, 't3'))).toBeNull();
  });
  it('an edge with an unknown confidence fails the whole call before any write', async () => {
    const err = await caught(s.repos.graph.replaceSource(AP, { origin: 'ast', sourceFile: 'tx.ts', nodes: [node('t9')], edges: [{ src: 't9', dst: 't1', relation: 'calls', confidence: 'BOGUS' }], source: src }));
    expect(err).toEqual({ name: 'RepoError', code: 'invalid', message: 'bad edge confidence' });
    expect(await s.repos.graph.getNode(AP, 't9')).toBeNull();
    expect((await caught(s.repos.graph.replaceSource(AP, { origin: 'nope', sourceFile: 'tx.ts', nodes: [], edges: [], source: src }))).code).toBe('invalid');
  });
  it('rows of origin review or session are never deleted by a rebuild, and a reviewed edge is not overwritten', async () => {
    await s.repos.graph.replaceSource(AP, {
      origin: 'ast', sourceFile: 'r.ts', nodes: [node('r1'), node('r2')], edges: [{ src: 'r1', dst: 'r2', relation: 'calls', confidence: 'INFERRED' }], source: src,
    });
    const reviewed = await s.repos.graph.reviewEdge(AP, { src: 'r1', dst: 'r2', relation: 'calls', confidence: 'DROPPED' });
    expect([reviewed?.confidence, reviewed?.origin]).toEqual(['DROPPED', 'review']);
    await s.repos.graph.replaceSource(AP, { origin: 'session', sourceFile: 'r.ts', nodes: [node('s1')], edges: [], source: src });
    expect(await s.repos.graph.getNode(AP, 'r1')).not.toBeNull();
    await s.repos.graph.replaceSource(AP, {
      origin: 'ast', sourceFile: 'r.ts', nodes: [node('r1'), node('r2')], edges: [{ src: 'r1', dst: 'r2', relation: 'calls', confidence: 'EXTRACTED' }], source: src,
    });
    expect((await s.repos.graph.edgesOf(AP, 'r1')).map((e) => [e.confidence, e.origin])).toEqual([['DROPPED', 'review']]);
    expect((await caught(s.repos.graph.reviewEdge(AP, { src: 'r1', dst: 'r2', relation: 'calls', confidence: 'INFERRED' as never }))).code).toBe('invalid');
    expect(await s.repos.graph.reviewEdge(AP, { src: 'none', dst: 'none', relation: 'calls', confidence: 'CONFIRMED' })).toBeNull();
  });
  it('edgesOf returns both directions; searchLabels matches words, clamps to 50 and filters types', async () => {
    await s.repos.graph.replaceSource(AP, {
      origin: 'parser', sourceFile: 'e.md', nodes: [node('e1', 'quarterly budget'), node('e2', 'budget review'), { ...node('e3', 'budget table'), type: 'doc' }], edges: [{ src: 'e1', dst: 'e2', relation: 'refs', confidence: 'EXTRACTED' }, { src: 'e3', dst: 'e1', relation: 'refs', confidence: 'EXTRACTED' }], source: src,
    });
    expect((await s.repos.graph.edgesOf(AP, 'e1')).map((e) => `${e.src}>${e.dst}`).sort()).toEqual(['e1>e2', 'e3>e1']);
    expect((await s.repos.graph.searchLabels(AP, { query: 'budget' })).map((n) => n.id).sort()).toEqual(['e1', 'e2', 'e3']);
    expect((await s.repos.graph.searchLabels(AP, { query: 'budget', types: ['doc'] })).map((n) => n.id)).toEqual(['e3']);
    expect(await s.repos.graph.searchLabels(AP, { query: '   ' })).toEqual([]);
    expect(await s.repos.graph.searchLabels(AP, { query: "x'; drop table graph_nodes;--" })).toEqual([]);
    const many = Array.from({ length: 60 }, (_, i) => node(`m${i}`, `zebra ${i}`));
    await s.repos.graph.replaceSource(AP, { origin: 'parser', sourceFile: 'm.md', nodes: many, edges: [], source: src });
    expect(await s.repos.graph.searchLabels(AP, { query: 'zebra', limit: 500 })).toHaveLength(50);
    expect(await s.repos.graph.searchLabels(AP, { query: 'zebra', limit: 50 })).toHaveLength(50);
    expect(await s.repos.graph.searchLabels(AP, { query: 'zebra', limit: 2 })).toHaveLength(2);
  });
  it('setEmbedding and loadVectors round-trip; loadGraph carries no embedding; a wrong length is invalid', async () => {
    await s.repos.graph.replaceSource(AP, { origin: 'ast', sourceFile: 'v.ts', nodes: [node('v1')], edges: [], source: src });
    expect(await s.repos.graph.setEmbedding(AP, 'v1', unit(3), 'new-hash')).toBe(1);
    expect(await s.repos.graph.setEmbedding(AP, 'none', unit(3), 'x')).toBe(0);
    const vectors = await s.repos.graph.loadVectors(AP);
    expect(vectors.find((v) => v.id === 'v1')?.embedding).toEqual(unit(3));
    expect(JSON.stringify(await s.repos.graph.loadGraph(AP))).not.toContain('embedding');
    expect((await s.repos.graph.getNode(AP, 'v1'))?.contentHash).toBe('new-hash');
    expect((await caught(s.repos.graph.setEmbedding(AP, 'v1', [1, 2], 'x'))).code).toBe('invalid');
  });
  it('stats counts nodes by type and edges by relation', async () => {
    const st = await s.repos.graph.stats(AP);
    expect(st.nodesByType['function']).toBeGreaterThan(0);
    expect(st.edgesByRelation['calls']).toBeGreaterThan(0);
    expect(st.lastBuild).toBeInstanceOf(Date);
    expect(await s.repos.graph.stats(BP)).toEqual({ nodesByType: {}, edgesByRelation: {}, lastBuild: null });
  });
  it('D1(c) the same node id in two projects of two users stays apart', async () => {
    await s.repos.graph.replaceSource(BP, { origin: 'ast', sourceFile: 'a.ts', nodes: [node('a3', 'b version')], edges: [], source: src });
    expect((await s.repos.graph.getNode(AP, 'a3'))?.label).toBe('a3');
    expect((await s.repos.graph.getNode(BP, 'a3'))?.label).toBe('b version');
  });
});

describe('D14 library', () => {
  it('createVersion: v1 gets latest+production, an equal manifest creates nothing, a changed one makes v2 and moves latest', async () => {
    const one = await s.repos.library.createVersion(A, skill('flow'));
    expect([one.created, one.version.version, one.version.labels.slice().sort()]).toEqual([true, 1, ['latest', 'production']]);
    const same = await s.repos.library.createVersion(A, skill('flow', [['SKILL.md', 'b1', 'hello']], { description: 'changed text only' }));
    expect([same.created, same.version.id]).toEqual([false, one.version.id]);
    const two = await s.repos.library.createVersion(A, skill('flow', [['SKILL.md', 'b2', 'hello v2']]));
    expect([two.created, two.version.version, two.version.labels]).toEqual([true, 2, ['latest']]);
    const versions = await s.repos.library.listVersions(A, one.version.capId);
    expect(versions.map((v) => [v.version, v.labels.slice().sort()])).toEqual([[2, ['latest']], [1, ['production']]]);
    expect((await s.repos.library.getVersion(A, one.version.capId, 1))?.id).toBe(one.version.id);
    expect((await s.repos.library.getVersionById(A, two.version.id))?.version).toBe(2);
    expect(await s.repos.library.getVersion(A, one.version.capId, 9)).toBeNull();
  });
  it('D7 no file-count or size limit here (the scanner owns them)', async () => {
    const files = Array.from({ length: 201 }, (_, i): [string, string, string] => [`f${i}.md`, 'b1', 'hello']);
    expect((await s.repos.library.createVersion(A, skill('many-files', files))).created).toBe(true);
  });
  it('D14 concurrent createVersion calls for one name produce consecutive versions (advisory lock)', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => s.repos.library.createVersion(A, skill('race', [['SKILL.md', `r${i}`, `body ${i}`]]))));
    expect(results.every((r) => r.created)).toBe(true);
    expect(results.map((r) => r.version.version).sort()).toEqual([1, 2, 3, 4, 5]);
    const cap = await s.repos.library.byName(A, { namespace: 'user', kind: 'skill', name: 'race' });
    const versions = await s.repos.library.listVersions(A, cap?.id as string);
    expect(versions.filter((v) => v.labels.includes('latest'))).toHaveLength(1);
  });
  it('a file that points to a blob nobody provided is invalid, and duplicate paths are invalid', async () => {
    const bad = skill('bad-blob');
    bad.files = [{ path: 'SKILL.md', blobHash: 'missing' }];
    expect((await caught(s.repos.library.createVersion(A, bad))).code).toBe('invalid');
    expect(await s.repos.library.byName(A, { namespace: 'user', kind: 'skill', name: 'bad-blob' })).toBeNull();
    const dup = skill('dup-path', [['SKILL.md', 'b1', 'x'], ['SKILL.md', 'b1', 'x']]);
    expect((await caught(s.repos.library.createVersion(A, dup))).code).toBe('invalid');
  });
  it('manifest, getBlob: per version, per user; blobs are stored once per user', async () => {
    const r = await s.repos.library.createVersion(A, skill('files', [['SKILL.md', 'fb1', 'main'], ['ref/x.md', 'fb2', 'extra']]));
    const m = await s.repos.library.manifest(A, r.version.id);
    expect(m).toEqual([{ path: 'SKILL.md', size: 4, blobHash: 'fb1' }, { path: 'ref/x.md', size: 5, blobHash: 'fb2' }]);
    expect(await s.repos.library.getBlob(A, r.version.id, 'ref/x.md')).toBe('extra');
    expect(await s.repos.library.getBlob(A, r.version.id, 'nope.md')).toBeNull();
    await s.repos.library.createVersion(B, skill('files', [['SKILL.md', 'fb1', 'b content']]));
    expect(await s.repos.library.getBlob(A, r.version.id, 'SKILL.md')).toBe('main');
  });
  it('moveLabels: moves a label from another version, keeps latest, refuses latest', async () => {
    const cap = await s.repos.library.byName(A, { namespace: 'user', kind: 'skill', name: 'flow' });
    const moved = await s.repos.library.moveLabels(A, { capId: cap?.id as string, version: 2, labels: ['production'] });
    expect(moved?.labels.slice().sort()).toEqual(['latest', 'production']);
    const versions = await s.repos.library.listVersions(A, cap?.id as string);
    expect(versions.map((v) => [v.version, v.labels.slice().sort()])).toEqual([[2, ['latest', 'production']], [1, []]]);
    expect(await caught(s.repos.library.moveLabels(A, { capId: cap?.id as string, version: 1, labels: ['production', 'latest'] }))).toEqual({ name: 'RepoError', code: 'invalid', message: 'latest cannot be moved' });
    expect(await s.repos.library.moveLabels(A, { capId: cap?.id as string, version: 99, labels: ['x'] })).toBeNull();
    expect((await s.repos.library.moveLabels(A, { capId: cap?.id as string, version: 1, labels: [] }))?.labels).toEqual([]);
  });
  it('moveLabels: a version locked by another transaction is a ConflictError, not a hang', async () => {
    const cap = await s.repos.library.byName(A, { namespace: 'user', kind: 'skill', name: 'flow' });
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const hasLock = new Promise<void>((r) => (locked = r));
    const { sql } = await import('kysely');
    const holder = s.db.kysely.transaction().execute(async (trx) => {
      await sql`select 1 from capability_versions where cap_id = ${cap?.id as string} and version = 1 for update`.execute(trx);
      locked();
      await gate;
    });
    await hasLock;
    try {
      expect(await caught(s.repos.library.moveLabels(A, { capId: cap?.id as string, version: 1, labels: ['staging'] }))).toEqual({ name: 'ConflictError', code: 'conflict', message: 'version is being changed' });
    } finally {
      release();
      await holder;
    }
  });
  it('listCapabilities filters by kind, label and text; markRemoved hides and is idempotent; creating again revives', async () => {
    const mk = (name: string) => s.repos.library.createVersion(A, skill(name, [['SKILL.md', `h-${name}`, name]]));
    const alpha = (await mk('alpha-tool')).version.capId;
    await mk('beta-tool');
    await s.repos.library.createVersion(A, { ...skill('gamma-agent', [['AGENT.md', 'hg', 'g']]), kind: 'agent' });
    const names = async (o: object) => (await s.repos.library.listCapabilities(A, { limit: 500, ...o })).rows.map((c) => c.name);
    expect(await names({ kind: 'agent' })).toEqual(['gamma-agent']);
    expect(await names({ q: 'ALPHA' })).toEqual(['alpha-tool']);
    expect(await names({ label: 'production', q: 'beta' })).toEqual(['beta-tool']);
    expect(await names({ label: 'staging', q: 'tool' })).toEqual([]);
    expect(await s.repos.library.markRemoved(A, alpha)).toBe(1);
    expect(await s.repos.library.markRemoved(A, alpha)).toBe(0);
    expect(await names({ q: 'alpha' })).toEqual([]);
    expect((await s.repos.library.get(A, alpha))?.removedAt).toBeInstanceOf(Date);
    await mk('alpha-tool');
    expect(await names({ q: 'alpha' })).toEqual(['alpha-tool']);
    const page = await s.repos.library.listCapabilities(A, { limit: 2 });
    expect(page.rows).toHaveLength(2);
    expect(page.next).toEqual(expect.any(String));
  });
  it('setServed needs an existing version; a non-uuid id is null/0, not a cast error', async () => {
    const cap = await s.repos.library.byName(A, { namespace: 'user', kind: 'skill', name: 'flow' });
    expect(await s.repos.library.setServed(A, cap?.id as string, 2)).toBe(1);
    expect(await s.repos.library.setServed(A, cap?.id as string, 77)).toBe(0);
    expect((await s.repos.library.get(A, cap?.id as string))?.servedVersion).toBe(2);
    expect(await s.repos.library.get(A, 'not-a-uuid')).toBeNull();
    expect(await s.repos.library.listVersions(A, "x'; drop")).toEqual([]);
    expect(await s.repos.library.markRemoved(A, 'nope')).toBe(0);
  });
  it('overrides: one per (project, capability); version and label must exist; global and project rows are separate', async () => {
    const cap = (await s.repos.library.byName(A, { namespace: 'user', kind: 'skill', name: 'flow' }))?.id as string;
    const first = await s.repos.library.upsertOverride(AP, { capId: cap, action: 'pin', version: 1 });
    expect([first.projectId, first.action, first.version]).toEqual([AP.projectId, 'pin', 1]);
    const second = await s.repos.library.upsertOverride(AP, { capId: cap, action: 'block' });
    expect([second.action, second.version]).toEqual(['block', null]);
    await s.repos.library.upsertOverride(A, { capId: cap, action: 'pin', label: 'production' });
    expect((await s.repos.library.listOverrides(AP)).map((o) => [o.projectId, o.action])).toEqual([[null, 'pin'], [AP.projectId, 'block']]);
    expect((await s.repos.library.listOverrides(A)).map((o) => o.projectId)).toEqual([null]);
    expect(await caught(s.repos.library.upsertOverride(AP, { capId: cap, action: 'pin', version: 99 }))).toEqual({ name: 'RepoError', code: 'not_found', message: 'capability, version or label not found' });
    expect((await caught(s.repos.library.upsertOverride(AP, { capId: cap, action: 'pin', label: 'nope' }))).code).toBe('not_found');
    expect((await caught(s.repos.library.upsertOverride(AP, { capId: 'not-a-uuid', action: 'pin' }))).code).toBe('not_found');
    expect(await s.repos.library.clearOverride(AP, cap)).toBe(1);
    expect(await s.repos.library.clearOverride(AP, cap)).toBe(0);
    expect((await s.repos.library.listOverrides(A)).map((o) => o.projectId)).toEqual([null]);
  });
  it('vectors: upsert replaces by (capability, text hash); loadVectors skips removed capabilities', async () => {
    const cap = (await s.repos.library.byName(A, { namespace: 'user', kind: 'skill', name: 'beta-tool' }))?.id as string;
    expect(await s.repos.library.upsertVector(A, { capId: cap, textHash: 't1', embedding: unit(0) })).toBe(1);
    expect(await s.repos.library.upsertVector(A, { capId: cap, textHash: 't1', embedding: unit(1), model: 'm' })).toBe(1);
    const got = (await s.repos.library.loadVectors(A)).filter((v) => v.capId === cap);
    expect(got).toEqual([{ capId: cap, textHash: 't1', embedding: unit(1) }]);
    expect(await s.repos.library.upsertVector(A, { capId: '00000000-0000-4000-8000-000000000000', textHash: 'x', embedding: unit(0) })).toBe(0);
    expect((await caught(s.repos.library.upsertVector(A, { capId: cap, textHash: 'x', embedding: [1] }))).code).toBe('invalid');
    await s.repos.library.markRemoved(A, cap);
    expect((await s.repos.library.loadVectors(A)).filter((v) => v.capId === cap)).toEqual([]);
  });
  it('D13 deleteUnreferencedBlobs removes only blobs no file references, per owner', async () => {
    await s.repos.library.createVersion(A, skill('blobs', [['SKILL.md', 'keep-me', 'k']]));
    const { exec } = await import('./scratch.ts');
    await exec(s.url, `insert into "${s.schema}".cap_blobs (user_id, hash, content, size) values ('user-a', 'orphan', 'o', 1), ('user-b', 'keep-me', 'b has the same hash but no file', 1)`);
    expect(await s.repos.system.cleanup.deleteUnreferencedBlobs(sctx)).toBeGreaterThanOrEqual(2);
    const left = await exec(s.url, `select user_id, hash from "${s.schema}".cap_blobs where hash in ('orphan', 'keep-me') order by 1`);
    expect(left.rows).toEqual([{ user_id: 'user-a', hash: 'keep-me' }]);
  });
});
