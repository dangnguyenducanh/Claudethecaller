import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keys } from '@ctc/shared/cache';
import { fakeCache, mkDeps, mkVersion, newUser, rnd, scratch, type Scratch } from './testing.ts';
import { servedVersion } from './index.ts';

let s: Scratch;
beforeAll(async () => {
  s = await scratch();
}, 60_000);
afterAll(async () => {
  await s?.drop();
});

describe('servedVersion (D12)', () => {
  it('uses the default label, lets the project row beat the global row, ignores the served_version column, and reads rows cache-aside under ovr:', async () => {
    const u = newUser();
    const cache = fakeCache();
    const deps = mkDeps(s.repos, { userId: u.userId, cache });
    const v1 = await mkVersion(s.repos, u, 'srv', { 'SKILL.md': 'a' });
    await mkVersion(s.repos, u, 'srv', { 'SKILL.md': 'b' });
    const capId = v1.capId;
    const p1 = (await s.repos.projects.upsert(u, { root: `/t32/${rnd()}` })).id;
    const p2 = (await s.repos.projects.upsert(u, { root: `/t32/${rnd()}` })).id;
    const P1 = { ...u, projectId: p1 };
    const P2 = { ...u, projectId: p2 };
    expect(await servedVersion(deps, u, capId)).toBe(1);
    await s.repos.library.setServed(u, capId, 2);
    expect(await servedVersion(deps, u, capId)).toBe(1);
    await s.repos.library.upsertOverride(u, { capId, action: 'pin', version: 2 });
    await s.repos.library.upsertOverride(P1, { capId, action: 'pin', version: 1 });
    expect([await servedVersion(deps, P1, capId), await servedVersion(deps, P2, capId), await servedVersion(deps, u, capId)]).toEqual([1, 2, 2]);
    const key = keys.ovr(u.userId, p1);
    expect(cache.log.some((e) => e[0] === 'set' && e[1] === key && e[2] === 300)).toBe(true);
    await s.repos.library.upsertOverride(P1, { capId, action: 'block' });
    expect(await servedVersion(deps, P1, capId)).toBe(1);
    await cache.del(key);
    expect(await servedVersion(deps, P1, capId)).toBeNull();
    expect(await servedVersion(mkDeps(s.repos, { userId: u.userId }), P1, capId)).toBeNull();
  });
  it('a foreign or unknown capability id is null', async () => {
    const u = newUser();
    const v = await mkVersion(s.repos, u, 'srv-foreign', { 'SKILL.md': 'a' });
    const deps = mkDeps(s.repos);
    expect([await servedVersion(deps, newUser(), v.capId), await servedVersion(deps, u, randomUUID()), await servedVersion(deps, u, 'nope')]).toEqual([null, null, null]);
  });
  it('config is read at call time and ctxOf defaults to the local user', async () => {
    const deps = mkDeps(s.repos);
    delete (deps as { ctxOf?: unknown }).ctxOf;
    const v = await mkVersion(s.repos, { userId: 'local' }, `srv-local-${rnd()}`, { 'SKILL.md': 'a' });
    await s.repos.library.moveLabels({ userId: 'local' }, { capId: v.capId, version: 1, labels: ['stable'] });
    deps.config.library.default_label = 'stable';
    expect(await servedVersion(deps, { userId: 'local' }, v.capId)).toBe(1);
  });
});
