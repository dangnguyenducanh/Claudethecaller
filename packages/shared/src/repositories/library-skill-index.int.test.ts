import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scratch, type Scratch } from './scratch.ts';

let s: Scratch;
beforeAll(async () => {
  s = await scratch();
}, 60_000);
afterAll(async () => {
  await s?.drop();
});

const sha = (x: string): string => createHash('sha256').update(x).digest('hex');
const user = (): { userId: string } => ({ userId: `u-${randomBytes(3).toString('hex')}` });
const vec = (i: number, x = 1): number[] => Array.from({ length: 1024 }, (_, j) => (j === i ? x : 0));

async function addCap(ctx: { userId: string }, name: string, o: { description?: string; vector?: number[] | null; served?: boolean; namespace?: string } = {}): Promise<string> {
  const { version } = await s.repos.library.createVersion(ctx, {
    namespace: o.namespace ?? 'user', kind: 'skill', name, rootPath: `/x/${name}`, description: o.description ?? `desc ${name}`, bodyHash: sha(name),
    blobs: [{ hash: sha(name), content: name, size: name.length }], files: [{ path: 'SKILL.md', blobHash: sha(name) }],
  });
  if (o.served !== false) await s.repos.library.setServed(ctx, version.capId, version.version);
  if (o.vector !== null) await s.repos.library.upsertVector(ctx, { capId: version.capId, textHash: sha(`t-${name}`), embedding: o.vector ?? vec(1), model: 'm' });
  return version.capId;
}

describe('loadSkillIndex (D21)', () => {
  it('returns live capabilities of the caller that have a vector, with the served description, one row each, ordered by cap id', async () => {
    const u = user();
    const other = user();
    const two = await addCap(u, 'two', { description: 'old desc', vector: vec(1, 0.5) });
    await s.repos.library.createVersion(u, {
      namespace: 'user', kind: 'skill', name: 'two', rootPath: '/x/two', description: 'new desc', bodyHash: sha('v2'),
      blobs: [{ hash: sha('v2 body'), content: 'v2 body', size: 7 }], files: [{ path: 'SKILL.md', blobHash: sha('v2 body') }],
    });
    await s.repos.library.setServed(u, two, 1);
    await s.repos.library.upsertVector(u, { capId: two, textHash: '0', embedding: vec(2), model: 'm' });
    await addCap(u, 'novec', { vector: null });
    const gone = await addCap(u, 'gone');
    await s.repos.library.markRemoved(u, gone);
    const unserved = await addCap(u, 'unserved', { served: false });
    await addCap(other, 'other');

    const rows = await s.repos.library.loadSkillIndex(u);
    expect(rows.map((r) => r.name).sort()).toEqual(['two', 'unserved']);
    expect(Object.keys(rows[0]!).sort()).toEqual(['capId', 'description', 'embedding', 'kind', 'name', 'namespace']);
    expect(rows.map((r) => r.capId)).toEqual(rows.map((r) => r.capId).sort());
    const t = rows.find((r) => r.capId === two)!;
    expect([t.description, t.embedding.length, t.embedding[2]]).toEqual(['old desc', 1024, 1]);
    expect(rows.find((r) => r.capId === unserved)!.description).toBe('');
    expect(await s.repos.library.loadSkillIndex(user())).toEqual([]);
  });
});
