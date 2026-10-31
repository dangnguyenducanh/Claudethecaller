import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cacheLimits, createCache, type Cache } from './index.ts';

const url = process.env.CTC_SCRATCH_REDIS_URL ?? '';
const raw = new Redis(url, { maxRetriesPerRequest: 1 });
const spaces: string[] = [];
const open: Cache[] = [];
const ns = () => {
  const n = `t14vtc${Math.random().toString(16).slice(2, 10)}:`;
  spaces.push(n);
  return n;
};
const mk = (namespace: string, extra: { url?: string } = {}) => {
  const c = createCache({ url, namespace, ...extra });
  open.push(c);
  return c;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const defaults = { ...cacheLimits };
afterEach(() => Object.assign(cacheLimits, defaults));
beforeAll(async () => expect(await raw.ping()).toBe('PONG'));
afterAll(async () => {
  await Promise.all(open.map((c) => c.close()));
  for (const n of spaces) {
    const [, ks] = await raw.scan('0', 'MATCH', `${n}*`, 'COUNT', 1000);
    if (ks.length) await raw.del(...ks);
  }
  raw.disconnect();
});

describe('L2 (D1, D10)', () => {
  it('shares values between caches, fills L1, del clears both, and discards poisoned values', async () => {
    const n = ns();
    const a = mk(n);
    const b = mk(n);
    await a.set('x', { n: 1 }, 60);
    expect(await b.get('x')).toEqual({ n: 1 });
    await raw.del(`${n}x`);
    expect(await b.get('x')).toEqual({ n: 1 }); // L1
    await b.del('x');
    expect(await b.get('x')).toBeUndefined();
    await raw.set(`${n}p`, '{not json');
    expect(await a.get('p')).toBeUndefined();
    expect(await raw.exists(`${n}p`)).toBe(0);
  });
  it('stores vectors as raw float32 bytes and treats a ragged value as a miss', async () => {
    const n = ns();
    const a = mk(n);
    await a.setVec('v', Float32Array.from({ length: 1024 }, (_, i) => i / 1000), 60);
    expect(await raw.strlen(`${n}v`)).toBe(4096);
    expect(Math.abs(((await mk(n).getVec('v'))?.[5] ?? 0) - 0.005)).toBeLessThan(1e-6);
    await raw.set(`${n}bad`, 'abcde');
    expect(await mk(n).getVec('bad')).toBeUndefined();
    expect(await raw.exists(`${n}bad`)).toBe(0);
  });
  it('writes ttl as whole seconds, at least 1', async () => {
    const n = ns();
    await mk(n).set('f', 1, 0.5);
    expect(await raw.ttl(`${n}f`)).toBe(1);
  });
});

describe('epochs (D12)', () => {
  it('keeps a stable token, rotate changes it for every process, kinds are independent', async () => {
    cacheLimits.epochMemoMs = 0;
    const n = ns();
    const a = mk(n);
    const b = mk(n);
    const t1 = await a.epoch.get('graph', 'u1', 'p1');
    expect(t1).toMatch(/^[0-9a-f]{12}$/);
    expect(await a.epoch.get('graph', 'u1', 'p1')).toBe(t1);
    const t2 = await a.epoch.rotate('graph', 'u1', 'p1');
    expect(t2).not.toBe(t1);
    expect(await b.epoch.get('graph', 'u1', 'p1')).toBe(t2);
    expect(await b.epoch.get('mem', 'u1', 'p1')).not.toBe(t2);
  });
});

describe('ctc:inval (D13)', () => {
  it('delivers, isolates callback errors, clears L1 except on epoch, ignores bad messages, stops on close', async () => {
    const n = ns();
    const p = mk(n);
    const s = mk(n);
    const got: string[] = [];
    let first = true;
    const sub = await s.subscribeInval(async (m) => {
      got.push(m.event);
      if (first) {
        first = false;
        throw new Error('boom');
      }
    });
    await p.publishInval({ v: 1, event: 'graph.rebuild', userId: 'u1', projectId: 'p1' });
    await p.publishInval({ v: 1, event: 'library.changed', userId: 'u1' });
    await sleep(150);
    expect(got).toEqual(['graph.rebuild', 'library.changed']);
    await s.set('k', 1, 60);
    await raw.del(`${n}k`);
    await p.epoch.rotate('graph', 'u1', 'p9');
    await sleep(150);
    expect(got.at(-1)).toBe('epoch');
    expect(await s.get('k')).toBe(1); // epoch keeps L1
    await p.publishInval({ v: 1, event: 'ovr.changed', userId: 'u1' });
    await sleep(150);
    expect(await s.get('k')).toBeUndefined(); // other events clear L1
    await raw.publish(`${n}ctc:inval`, '{"v":1,"event":"zzz","userId":"u"}');
    await raw.publish(`${n}ctc:inval`, '{"v":2,"event":"graph.rebuild","userId":"u"}');
    await raw.publish(`${n}ctc:inval`, 'not json');
    await sleep(150);
    expect(got).toHaveLength(4);
    await sub.close();
    await p.publishInval({ v: 1, event: 'graph.rebuild', userId: 'u1' });
    await sleep(150);
    expect(got).toHaveLength(4);
  });
});

describe('rate limit (D14)', () => {
  it('counts in a fixed minute window with an expiry of rateWindowS', async () => {
    const n = ns();
    const c = mk(n);
    const a = await c.hitRate('u1');
    const b = await c.hitRate('u1');
    expect(a).toBeGreaterThanOrEqual(1);
    expect([a + 1, 1]).toContain(b);
    const [, ks] = await raw.scan('0', 'MATCH', `${n}rl:u1:*`, 'COUNT', 1000);
    const ttlS = await raw.ttl(ks[0] as string);
    expect(ttlS).toBeGreaterThan(0);
    expect(ttlS).toBeLessThanOrEqual(60);
  });
});
