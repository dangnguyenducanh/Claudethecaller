/**
 * Shared cache: L1 in-process LRU, L2 Redis, fail-open, epoch tokens, rate-limit counter, `ctc:inval` channel.
 *
 * Called from: apps/web (hooks within a 20 ms Redis budget, auth key cache, rate limit, RAM reload on `ctc:inval`) and
 * apps/worker. Why: a hot-path call must never wait on a slow Redis or fail because of it (spec:170, 205).
 * Redis is a cache, never the truth, and its contents are not trusted: an L2 value that does not parse is a miss and is deleted.
 * Deliberately NOT done: SQL, a semantic cache, whole-database wipes or key scans, logging values or URLs, reloading anything on `ctc:inval`.
 */
import { Redis } from 'ioredis';
import { applyCacheConfig, cacheLimits, ttl } from './limits.ts';
import { GLOBAL_MEM_EPOCH, keys } from './keys.ts';
import { createEpochs, errClass, type Core, type Log } from './epoch.ts';
import { createInval, type InvalMessage } from './inval.ts';

export { applyCacheConfig, cacheLimits, ttl, keys, GLOBAL_MEM_EPOCH };
export type { InvalMessage, Log };

export type Cache = {
  /** `false` exactly while the Redis breaker is open. */
  readonly up: boolean;
  /** `undefined` = miss (a stored `null`, `false`, `0` or `''` is a hit). */
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  getVec(key: string): Promise<Float32Array | undefined>;
  setVec(key: string, vec: ArrayLike<number>, ttlSeconds: number): Promise<void>;
  del(...keys: string[]): Promise<void>;
  /** Requests this minute for the user, this one included; `0` when Redis is down (limit skipped). */
  hitRate(userId: string): Promise<number>;
  epoch: {
    get(kind: 'graph' | 'mem', userId: string, projectId: string): Promise<string | null>;
    rotate(kind: 'graph' | 'mem', userId: string, projectId: string): Promise<string | null>;
  };
  publishInval(msg: InvalMessage): Promise<void>;
  subscribeInval(cb: (msg: InvalMessage) => void | Promise<void>): Promise<{ close(): Promise<void> }>;
  close(): Promise<void>;
};

type L1Entry = { v: string | Float32Array; exp: number };
const noop = (): void => undefined;

/** `ttlSeconds` normalised: whole seconds, 0 = store nothing. */
function normTtl(t: unknown): number {
  if (typeof t !== 'number' || !Number.isFinite(t)) throw new TypeError('ttl must be a finite number');
  return t <= 0 ? 0 : Math.max(1, Math.floor(t));
}

/** Creates the cache. No connection is opened until the first call that needs Redis. */
export function createCache(opts: { url: string; namespace?: string; log?: Log }): Cache {
  const ns = opts.namespace ?? '';
  const log: Log = opts.log ?? noop;
  const l1 = new Map<string, L1Entry>(); // insertion order = recency
  const subs = new Set<{ close(): Promise<void> }>();
  let downUntil = 0;
  let closed = false;
  let client: Redis | undefined;
  let connecting: Promise<void> | undefined;

  const redis = (): Redis =>
    (client ??= new Redis(opts.url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      enableReadyCheck: false,
      commandTimeout: cacheLimits.redisTimeoutMs,
      retryStrategy: (n) => Math.min(50 * n, 1000),
    }).on('error', noop));

  const ensureReady = async (r: Redis): Promise<void> => {
    if (r.status === 'ready') return;
    if (r.status === 'wait' || connecting) {
      connecting ??= r.connect().finally(() => (connecting = undefined));
      return connecting;
    }
    throw new Error('redis not ready');
  };

  /** One bounded L2 call. `undefined` = skipped or failed (breaker open, closed, timeout, connection error, reply error). */
  async function l2<T>(fn: (r: Redis) => Promise<T>): Promise<{ v: T } | undefined> {
    if (closed || Date.now() < downUntil) return undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      const r = redis();
      const p = ensureReady(r).then(() => fn(r));
      p.catch(noop); // the race below may have given up on it already
      const v = await Promise.race([
        p,
        new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error('redis timeout')), cacheLimits.redisTimeoutMs))),
      ]);
      return { v };
    } catch (e) {
      if (e instanceof Error && e.name === 'ReplyError') {
        log('redis reply error', { error: 'ReplyError' });
      } else {
        downUntil = Date.now() + cacheLimits.downForMs;
        log('redis down', { error: errClass(e) });
      }
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  const l1Get = (key: string): string | Float32Array | undefined => {
    const e = l1.get(key);
    if (!e) return undefined;
    l1.delete(key);
    if (e.exp <= Date.now()) return undefined;
    l1.set(key, e);
    return e.v;
  };
  const l1Put = (key: string, v: string | Float32Array, ttlMs: number): void => {
    l1.delete(key);
    l1.set(key, { v, exp: Date.now() + Math.min(ttlMs, cacheLimits.l1MaxAgeS * 1000) });
    while (l1.size > cacheLimits.l1Max) l1.delete(l1.keys().next().value as string);
  };

  /** Reads the pipeline replies of `GET` + `PTTL`; throws the first command error. */
  const readPair = <V>(out: [Error | null, unknown][] | null): { val: V | null; pttl: number } => {
    if (!out) throw new Error('empty pipeline reply');
    for (const [err] of out) if (err) throw err;
    return { val: (out[0]?.[1] ?? null) as V | null, pttl: Number(out[1]?.[1]) };
  };
  const fillL1 = (key: string, v: string | Float32Array, pttl: number): void => {
    if (pttl > 0 || pttl === -1) l1Put(key, v, pttl > 0 ? pttl : Infinity);
  };
  const poisoned = async (key: string): Promise<undefined> => {
    log('redis value discarded', { prefix: key.split(':')[0] });
    await l2((r) => r.del(ns + key));
    return undefined;
  };

  const core: Core = { url: opts.url, ns, log, l2, clearL1: () => l1.clear(), isClosed: () => closed };
  const publish = (m: unknown): Promise<void> => inval.publish(m);
  const epochs = createEpochs(core, publish);
  const inval = createInval(core, epochs);

  return {
    get up() {
      return Date.now() >= downUntil;
    },
    async get<T>(key: string): Promise<T | undefined> {
      if (closed) return undefined;
      const hit = l1Get(key);
      if (typeof hit === 'string') return JSON.parse(hit) as T;
      const res = await l2(async (r) => readPair<string>(await r.pipeline().get(ns + key).pttl(ns + key).exec()));
      if (!res || res.v.val === null) return undefined;
      let parsed: T;
      try {
        parsed = JSON.parse(res.v.val) as T;
      } catch {
        return poisoned(key);
      }
      fillL1(key, res.v.val, res.v.pttl);
      return parsed;
    },
    async set(key, value, ttlSeconds) {
      const s = normTtl(ttlSeconds);
      if (closed || s === 0) return;
      let json: string | undefined;
      try {
        json = JSON.stringify(value);
      } catch {
        log('cache set skipped: value is not serialisable', { prefix: key.split(':')[0] });
        return;
      }
      if (json === undefined) return; // judgment: `undefined` is the miss value, so it is not stored
      l1Put(key, json, s * 1000);
      await l2((r) => r.set(ns + key, json, 'EX', s));
    },
    async getVec(key) {
      if (closed) return undefined;
      const hit = l1Get(key);
      if (hit instanceof Float32Array) return new Float32Array(hit);
      const res = await l2(async (r) => readPair<Buffer>(await r.pipeline().getBuffer(ns + key).pttl(ns + key).exec()));
      if (!res || res.v.val === null) return undefined;
      const buf = res.v.val;
      if (buf.length % 4 !== 0) return poisoned(key);
      const vec = new Float32Array(buf.length / 4);
      for (let i = 0; i < vec.length; i++) vec[i] = buf.readFloatLE(i * 4);
      fillL1(key, vec, res.v.pttl);
      return new Float32Array(vec);
    },
    async setVec(key, vec, ttlSeconds) {
      const s = normTtl(ttlSeconds);
      if (closed || s === 0) return;
      const f = Float32Array.from(vec);
      const buf = Buffer.allocUnsafe(f.length * 4);
      f.forEach((x, i) => buf.writeFloatLE(x, i * 4));
      l1Put(key, f, s * 1000);
      await l2((r) => r.set(ns + key, buf, 'EX', s));
    },
    async del(...ks) {
      for (const k of ks) l1.delete(k);
      if (ks.length && !closed) await l2((r) => r.del(...ks.map((k) => ns + k)));
    },
    async hitRate(userId) {
      const key = ns + keys.rl(userId, Math.floor(Date.now() / 60_000));
      const res = await l2(async (r) => {
        const out = await r.multi().incr(key).expire(key, cacheLimits.rateWindowS, 'NX').exec();
        const [err, n] = out?.[0] ?? [new Error('empty reply'), 0];
        if (err) throw err;
        return Number(n);
      });
      return res?.v ?? 0;
    },
    epoch: {
      get: (kind, user, project) => epochs.get(kind, user, project),
      rotate: (kind, user, project) => epochs.rotate(kind, user, project),
    },
    publishInval: (msg) => inval.publish(msg),
    async subscribeInval(cb) {
      if (closed) return { close: async () => undefined };
      const sub = await inval.subscribe(cb);
      const handle = {
        close: async () => {
          subs.delete(handle);
          await sub.close();
        },
      };
      subs.add(handle);
      return handle;
    },
    async close() {
      if (closed) return;
      closed = true;
      l1.clear();
      await Promise.all([...subs].map((s) => s.close()));
      client?.disconnect();
    },
  };
}
