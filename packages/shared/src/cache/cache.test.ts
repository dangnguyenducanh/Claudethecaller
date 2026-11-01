import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { cacheLimits, createCache, keys, ttl } from './index.ts';

const DEAD = 'redis://127.0.0.1:1';
const defaults = { ...cacheLimits };
afterEach(() => Object.assign(cacheLimits, defaults));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('keys (D1, D3)', () => {
  it('builds the exact formats', () => {
    expect(keys.emb('hello')).toBe('emb:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
    expect(keys.sug('u1', 'p1', 'hello', 'e5')).toBe('sug:u1:p1:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d:e5');
    expect(keys.proj('u1', '/a:b/c')).toBe('proj:u1:/a:b/c');
    expect(keys.ovr('u1', 'p1')).toBe('ovr:u1:p1');
    expect(keys.ctx('u1', 'p1', 'm3')).toBe('ctx:u1:p1:m3');
    expect(keys.key('abc')).toBe('key:abc');
    expect(keys.rl('u1', 28000000)).toBe('rl:u1:28000000');
  });
  it('rejects parts that could collide', () => {
    for (const bad of ['a:b', '', 'a b', 'x'.repeat(129)]) expect(() => keys.ovr(bad, 'p')).toThrow(new TypeError('invalid key part: user'));
    expect(() => keys.ovr('x'.repeat(128), 'p')).not.toThrow();
  });
});

describe('limits (D2)', () => {
  it('pins the defaults', () => {
    expect(defaults).toEqual({ l1Max: 256, redisTimeoutMs: 20, downForMs: 10000, l1MaxAgeS: 60, epochMemoMs: 5000, epochStaleS: 60, epochTtlS: 2592000, rateLimitPerMin: 600, rateWindowS: 60 });
    expect(ttl).toEqual({ emb: 604800, sug: 3600, proj: 86400, ovr: 300, ctx: 600, key: 300, keyMiss: 60, rl: 60 });
  });
  it('L1 keeps l1Max entries (equal valid) and the next one evicts the least recently used', async () => {
    cacheLimits.l1Max = 2;
    const c = createCache({ url: DEAD });
    await c.set('a', 1, 60);
    await c.set('b', 2, 60);
    expect(await c.get('a')).toBe(1); // a is now most recent
    await c.set('c', 3, 60);
    expect([await c.get('a'), await c.get('b'), await c.get('c')]).toEqual([1, undefined, 3]);
    await c.close();
  });
});

describe('L1 values (D5, D10)', () => {
  it('null, false, 0 and empty string are hits; ttl <= 0 stores nothing; bad ttl throws', async () => {
    const c = createCache({ url: DEAD });
    for (const [i, v] of [null, false, 0, ''].entries()) {
      await c.set(`k${i}`, v, 60);
      expect(await c.get(`k${i}`)).toBe(v);
    }
    await c.set('zero', 1, 0);
    expect(await c.get('zero')).toBeUndefined();
    await expect(c.set('x', 1, Number.NaN)).rejects.toThrow(new TypeError('ttl must be a finite number'));
    await c.close();
    await c.close();
  });
  it('an L1 entry never outlives l1MaxAgeS and values are not aliased', async () => {
    cacheLimits.l1MaxAgeS = 0.05;
    const c = createCache({ url: DEAD });
    const v = { n: 1 };
    await c.set('k', v, 600);
    v.n = 2;
    expect(await c.get('k')).toEqual({ n: 1 });
    await sleep(80);
    expect(await c.get('k')).toBeUndefined();
    await c.close();
  });
  it('vectors round-trip and the caller array is not edited or shared', async () => {
    const c = createCache({ url: DEAD });
    const v = Float32Array.from([0.5, -1.25, 3]);
    await c.setVec('emb:v', v, 60);
    const got = await c.getVec('emb:v');
    expect(Array.from(got ?? [])).toEqual([0.5, -1.25, 3]);
    (got as Float32Array)[0] = 9;
    expect((await c.getVec('emb:v'))?.[0]).toBe(0.5);
    await c.close();
  });
});

describe('fail-open (D6, D8, D11)', () => {
  it('Redis down: misses are fast, nothing throws, epoch is unknown, rate limit skipped', async () => {
    const logs: string[] = [];
    const c = createCache({ url: DEAD, log: (m, f) => logs.push(`${m} ${JSON.stringify(f ?? {})}`) });
    await c.set('sug:u:p:x:e', { secret: 'SECRETVALUE' }, 60);
    const t = Date.now();
    for (let i = 0; i < 5; i++) expect(await c.get(`other${i}`)).toBeUndefined();
    expect(Date.now() - t).toBeLessThan(150);
    expect(c.up).toBe(false);
    expect(await c.epoch.get('graph', 'u1', 'p1')).toBeNull();
    expect(await c.epoch.rotate('graph', 'u1', 'p1')).toBeNull();
    expect(await c.hitRate('u1')).toBe(0);
    await c.publishInval({ v: 1, event: 'graph.rebuild', userId: 'u1' });
    expect(logs.join('\n')).not.toContain('SECRETVALUE');
    await c.close();
  });
  it('a Redis that never answers opens the breaker for downForMs, then one probe', async () => {
    const srv: Server = createServer(() => undefined);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    cacheLimits.downForMs = 300;
    const port = (srv.address() as { port: number }).port;
    const c = createCache({ url: `redis://127.0.0.1:${port}` });
    try {
      expect(await c.get('k')).toBeUndefined();
      expect(c.up).toBe(false);
      const t = Date.now();
      expect(await c.get('k2')).toBeUndefined();
      expect(Date.now() - t).toBeLessThan(10);
      await sleep(350);
      expect(c.up).toBe(true);
      await c.get('k3');
      expect(c.up).toBe(false);
    } finally {
      await c.close();
      srv.close();
    }
  });
  it('after close every method is a no-op returning the miss value', async () => {
    const c = createCache({ url: DEAD });
    await c.close();
    await c.set('k', 1, 60);
    expect(await c.get('k')).toBeUndefined();
    expect(await c.epoch.get('graph', 'u', 'p')).toBeNull();
  });
});

describe('applyCacheConfig', () => {
  it('writes cache.* and rate_limit_per_min into the live limits and ttl constants', async () => {
    const { applyCacheConfig, cacheLimits, ttl } = await import('./limits.ts');
    const before = { limits: { ...cacheLimits }, ttl: { ...ttl } };
    try {
      applyCacheConfig({ rate_limit_per_min: 7, cache: { l1_size: 3, redis_timeout_s: 0.05, down_for_s: 2, ttl: { sug: 11, ctx: 22, unknown: 5 } } });
      expect(cacheLimits).toMatchObject({ l1Max: 3, redisTimeoutMs: 50, downForMs: 2000, rateLimitPerMin: 7 });
      expect(ttl).toMatchObject({ sug: 11, ctx: 22, emb: before.ttl.emb });
    } finally {
      Object.assign(cacheLimits, before.limits);
      Object.assign(ttl, before.ttl);
    }
  });
});
