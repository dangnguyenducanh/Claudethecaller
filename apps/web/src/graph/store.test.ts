import { describe, expect, it } from 'vitest';
import { createGraphStore } from './index.ts';
import { CTX, fakeDeps } from './testing.ts';

type Over = Parameters<typeof fakeDeps>[0];
const mk = (over: Over = {}, o: Partial<Parameters<typeof createGraphStore>[0]> = {}, withEmbed = false) => {
  const f = fakeDeps(over);
  const store = createGraphStore({
    repos: f.deps.repos,
    cache: f.deps.cache as never,
    now: f.deps.now as never,
    ...(withEmbed ? { embed: (async () => [[0]]) as never } : {}),
    ...o,
  });
  return { ...f, store };
};

describe('graph store', () => {
  it('D17 loads once, invalidates by call and by message, ignores other messages', async () => {
    const t = mk({}, {}, true);
    const a = await t.store.get(CTX);
    expect([(await t.store.get(CTX)).index === a.index, t.st.loads, t.st.vecLoads, a.epoch, typeof a.loadedAt]).toEqual([true, 1, 1, 'e1', 'number']);
    t.store.invalidate('u1', 'p1');
    await t.store.get(CTX);
    t.store.onInval({ v: 1, event: 'graph.rebuild', userId: 'u1', projectId: 'p1' });
    await t.store.get(CTX);
    expect(t.st.loads).toBe(3);
    t.store.onInval({ v: 1, event: 'epoch', kind: 'mem', userId: 'u1', projectId: 'p1' });
    t.store.onInval({ v: 1, event: 'ovr.changed', userId: 'u1', projectId: 'p1' });
    t.store.onInval({ v: 1, event: 'graph.rebuild', userId: 'u2', projectId: 'p1' });
    t.store.onInval('garbage');
    await t.store.get(CTX);
    expect(t.st.loads).toBe(3);
    t.store.onInval({ v: 1, event: 'epoch', kind: 'graph', userId: 'u1', projectId: 'p1' });
    await t.store.get(CTX);
    t.store.onInval({ v: 1, event: 'library.changed', userId: 'u1' });
    await t.store.get(CTX);
    expect(t.st.loads).toBe(5);
  });

  it('D17 reloads when the Redis epoch changes and ignores an unknown epoch', async () => {
    const t = mk();
    await t.store.get(CTX);
    t.epoch.v = 'e2';
    expect((await t.store.get(CTX)).epoch).toBe('e2');
    await t.store.get(CTX);
    t.epoch.v = null;
    await t.store.get(CTX);
    expect(t.st.loads).toBe(2);
    const unknown = mk({ epoch: { v: null } });
    await unknown.store.get(CTX);
    await unknown.store.get(CTX);
    expect(unknown.st.loads).toBe(1);
  });

  it('D17 reloads after maxAgeMs, shares concurrent loads, serves the stale index when a reload fails', async () => {
    let clock = 1_000_000;
    const t = mk({}, { now: () => clock });
    await t.store.get(CTX);
    clock += 59_000;
    await t.store.get(CTX);
    expect(t.st.loads).toBe(1);
    clock += 2_000;
    await t.store.get(CTX);
    expect(t.st.loads).toBe(2);
    const c = mk();
    const got = await Promise.all([c.store.get(CTX), c.store.get(CTX), c.store.get(CTX)]);
    expect([c.st.loads, got[0].index === got[2].index]).toEqual([1, true]);
    let now = 1_000_000;
    const f = mk({ loadFails: (n) => n === 2 }, { now: () => now });
    const first = await f.store.get(CTX);
    now += 61_000;
    expect([(await f.store.get(CTX)).index === first.index, f.st.loads]).toEqual([true, 2]);
    await expect(mk({ loadFails: () => true }).store.get(CTX)).rejects.toThrow();
  });

  it('D17 keeps at most maxProjects entries (least recently used out) and passes hubMin to the index', async () => {
    const t = mk({}, { maxProjects: 2 });
    for (const projectId of ['p1', 'p2', 'p3']) await t.store.get({ userId: 'u1', projectId });
    await t.store.get({ userId: 'u1', projectId: 'p1' });
    expect(t.st.loads).toBe(4);
    expect((await mk({}, { hubMin: 100 }).store.get(CTX)).index.hubCut).toBe(100);
    expect(mk().st.vecLoads).toBe(0);
  });
});
