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

const make = (ctx: { userId: string }, namespace: string, kind: string, name: string) =>
  s.repos.library.createVersion(ctx, {
    namespace, kind, name, rootPath: `/x/${namespace}/${name}`, description: 'd', bodyHash: 'h',
    blobs: [{ hash: `h-${namespace}-${kind}`, content: 'x', size: 1 }], files: [{ path: 'SKILL.md', blobHash: `h-${namespace}-${kind}` }],
  });

describe('listByName (D11)', () => {
  it('lists live capabilities of the caller with that name, ordered by namespace then kind', async () => {
    const u = { userId: `u-${randomBytes(3).toString('hex')}` };
    await make(u, 'zeta', 'skill', 'same');
    await make(u, 'alpha', 'command', 'same');
    await make(u, 'alpha', 'agent', 'same');
    const gone = await make(u, 'beta', 'skill', 'same');
    await make(u, 'alpha', 'skill', 'other');
    await s.repos.library.markRemoved(u, gone.version.capId);
    const got = await s.repos.library.listByName(u, 'same');
    expect(got.map((c) => `${c.namespace}/${c.kind}`)).toEqual(['alpha/agent', 'alpha/command', 'zeta/skill']);
  });
  it('never returns another user\'s rows', async () => {
    const a = { userId: `u-${randomBytes(3).toString('hex')}` };
    await make(a, 'user', 'skill', 'private');
    expect(await s.repos.library.listByName({ userId: `u-${randomBytes(3).toString('hex')}` }, 'private')).toEqual([]);
  });
});
