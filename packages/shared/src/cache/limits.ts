/**
 * Cache limits and TTLs. Called from: cache/index.ts, epoch.ts, inval.ts, apps/web (rate limit compare).
 * Why: one exported, mutable object so a test (or an operator patch at boot) can shrink a limit; every reader
 * reads the field at call time. Deliberately NOT done: reading config files (T1.1 config owns that), validation.
 */

/** Seconds unless the name says Ms. `l1Max`, `redisTimeoutMs`, `downForMs`, `rateLimitPerMin`, `rateWindowS`: spec:141,170. The rest: chosen by judgment. */
export const cacheLimits = {
  l1Max: 256,
  redisTimeoutMs: 20,
  downForMs: 10_000,
  l1MaxAgeS: 60,
  epochMemoMs: 5000,
  epochStaleS: 60,
  epochTtlS: 2_592_000,
  rateLimitPerMin: 600,
  rateWindowS: 60,
};

/** Per-key-family TTL in seconds (spec:172-180). */
export const ttl = { emb: 604_800, sug: 3600, proj: 86_400, ovr: 300, ctx: 600, key: 300, keyMiss: 60, rl: 60 } as const;
