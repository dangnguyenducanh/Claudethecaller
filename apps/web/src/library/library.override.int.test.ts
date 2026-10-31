import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keys } from '@ctc/shared/cache';
import { call, fakeCache, mkDeps, mkVersion, newUser, okJson, rnd, scratch, tool, type FakeCache, type Scratch } from './testing.ts';
import { servedVersion } from './index.ts';

let s: Scratch;
beforeAll(async () => {
  s = await scratch();
}, 60_000);
afterAll(async () => {
  await s?.drop();
});

/** One user, two projects, a capability with v1 `production`, v2 `beta`, v3 `latest`. */
async function setup() {
  const user = newUser();
  const cache: FakeCache = fakeCache();
  const deps = mkDeps(s.repos, { cache, userId: user.userId });
  const name = `ovr-${rnd()}`;
  const v1 = await mkVersion(s.repos, user, name, { 'SKILL.md': 'one' });
  await mkVersion(s.repos, user, name, { 'SKILL.md': 'two' });
  await mkVersion(s.repos, user, name, { 'SKILL.md': 'three' });
  await s.repos.library.moveLabels(user, { capId: v1.capId, version: 2, labels: ['beta'] });
  const p1 = (await s.repos.projects.upsert(user, { root: `/t32/${rnd()}` })).id;
  const p2 = (await s.repos.projects.upsert(user, { root: `/t32/${rnd()}` })).id;
  const ctxs = { P1: { ...user, projectId: p1 }, P2: { ...user, projectId: p2 }, none: user };
  const served = async (ctx: typeof user): Promise<number> => okJson(await tool(deps, 'get_capability', ctx, { name })).version;
  return { user, cache, deps, name, capId: v1.capId, p1, ctxs, served };
}

describe('library.override', () => {
  it('pin by label changes the served version for that project only', async () => {
    const t = await setup();
    expect([await t.served(t.ctxs.P1), await t.served(t.ctxs.P2), await t.served(t.ctxs.none)]).toEqual([1, 1, 1]);
    expect(t.cache.store.has(keys.ovr(t.user.userId, t.p1))).toBe(true);

    const put = await call(t.deps, 'PUT', '/api/projects/:pid/capabilities/:id/override', { params: { pid: t.p1, id: t.capId }, body: { action: 'pin', label: 'beta' } });
    expect(put.status).toBe(200);
    expect(t.cache.store.has(keys.ovr(t.user.userId, t.p1))).toBe(false);

    expect([await t.served(t.ctxs.P1), await t.served(t.ctxs.P2), await t.served(t.ctxs.none)]).toEqual([2, 1, 1]);
  });

  it('pin by version changes the served version for that project only', async () => {
    const t = await setup();
    const put = await call(t.deps, 'PUT', '/api/projects/:pid/capabilities/:id/override', { params: { pid: t.p1, id: t.capId }, body: { action: 'pin', version: 3 } });
    expect(put.status).toBe(200);
    expect([await t.served(t.ctxs.P1), await t.served(t.ctxs.P2)]).toEqual([3, 1]);
    for (const ctx of Object.values(t.ctxs)) expect(await servedVersion(t.deps, ctx, t.capId)).toBe(await t.served(ctx));

    const del = await call(t.deps, 'DELETE', '/api/projects/:pid/capabilities/:id/override', { params: { pid: t.p1, id: t.capId } });
    expect(del.status).toBe(204);
    expect(await t.served(t.ctxs.P1)).toBe(1);
  });
});
