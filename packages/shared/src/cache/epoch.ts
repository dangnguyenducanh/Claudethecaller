/**
 * Epoch tokens: per-project random tokens in Redis (`epoch:<kind>:<user>:<project>`) that are part of cache keys, so a
 * graph rebuild or memory write kills old keys by changing the token (spec:182). Called from: cache/index.ts (exposed as
 * `cache.epoch`), inval.ts (memo updates from `epoch` messages). Deliberately NOT done: the Postgres `graph_epoch` poll
 * (apps/web), counters (a random token cannot resurrect old keys after a Redis restart).
 */
import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { cacheLimits } from './limits.ts';
import { keyPart } from './keys.ts';

export type Log = (message: string, fields?: Record<string, unknown>) => void;
export type EpochKind = 'graph' | 'mem';

/** What epoch.ts and inval.ts need from the cache: a bounded L2 call (undefined when skipped or failed), the log, the namespace. */
export type Core = {
  readonly url: string;
  readonly ns: string;
  readonly log: Log;
  l2<T>(fn: (r: Redis) => Promise<T>): Promise<{ v: T } | undefined>;
  clearL1(): void;
  isClosed(): boolean;
};

export const errClass = (e: unknown): string => (e instanceof Error ? e.constructor.name : typeof e);

export function createEpochs(core: Core, publish: (msg: unknown) => Promise<void>) {
  const memo = new Map<string, { token: string; at: number }>();

  const keyOf = (kind: string, user: string, project: string): string => {
    if (kind !== 'graph' && kind !== 'mem') throw new TypeError('invalid key part: kind');
    return `epoch:${kind}:${keyPart('user', user)}:${keyPart('project', project)}`;
  };
  const remember = (key: string, token: string): void => void memo.set(key, { token, at: Date.now() });

  return {
    /** Token for the project, creating it on first sight; `null` = unknown (Redis down and no fresh memo): do not cache by epoch. */
    async get(kind: EpochKind, user: string, project: string): Promise<string | null> {
      const key = keyOf(kind, user, project);
      const m = memo.get(key);
      const now = Date.now();
      if (m && now - m.at < cacheLimits.epochMemoMs) return m.token;
      const res = core.isClosed()
        ? undefined
        : await core.l2(async (r) => {
            let v = await r.get(core.ns + key);
            if (v === null) {
              await r.set(core.ns + key, randomBytes(6).toString('hex'), 'EX', cacheLimits.epochTtlS, 'NX');
              v = await r.get(core.ns + key);
            }
            return v;
          });
      // judgment: a value in Redis that cannot be part of a key is treated like "Redis failed".
      if (res && typeof res.v === 'string' && /^[^:\s]{1,128}$/.test(res.v)) {
        remember(key, res.v);
        return res.v;
      }
      return m && now - m.at < cacheLimits.epochStaleS * 1000 ? m.token : null;
    },
    /** New random token for everyone; `null` when Redis is down (nothing was rotated). */
    async rotate(kind: EpochKind, user: string, project: string): Promise<string | null> {
      const key = keyOf(kind, user, project);
      const token = randomBytes(6).toString('hex');
      const res = await core.l2((r) => r.set(core.ns + key, token, 'EX', cacheLimits.epochTtlS));
      if (!res) return null;
      remember(key, token);
      await publish({ v: 1, event: 'epoch', kind, userId: user, projectId: project, epoch: token });
      return token;
    },
    /** Memo update from a received `epoch` message; values that are not valid key parts are ignored. */
    adopt(kind: string, user: string, project: string, token: string): void {
      try {
        remember(keyOf(kind, user, project), keyPart('epoch', token));
      } catch {
        /* judgment: a malformed message is ignored */
      }
    },
  };
}
