/**
 * Queue names, per-queue options, limits, job-id encoding and the BullMQ producer handles.
 * Called from: apps/web (job submits), apps/worker (consumers, poller, dlq-retry). Why: one table (spec:186-196) that
 * producers and consumers both read, so they cannot disagree on timeouts or attempts.
 * Deliberately NOT done: SQL (the `jobs` row is reached through `JobsPort`), job handlers, BullMQ Flow.
 */
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export type QueueDef = {
  concurrency: number;
  attempts: number;
  backoff?: { type: 'exponential'; delay: number };
  maxStalledCount: number;
  /** `timeoutS: null` = no timer; for `runner.step` the timeout comes from the payload (`timeoutMs`). */
  kinds: Record<string, { timeoutS: number | null }>;
};

const exp5s = { type: 'exponential', delay: 5000 } as const;
const kind = (timeoutS: number | null) => ({ timeoutS });

/** Read at call time: a test may assign to it. Numbers: spec:186-196; `llm`/`cleanup` backoff and `maxStalledCount` 1: chosen by judgment. */
export const QUEUES: Record<string, QueueDef> = {
  graph: { concurrency: 1, attempts: 3, backoff: exp5s, maxStalledCount: 1, kinds: { rebuild: kind(300), extract: kind(null) } },
  library: { concurrency: 1, attempts: 3, backoff: exp5s, maxStalledCount: 1, kinds: { scan: kind(300), changed: kind(300) } },
  llm: { concurrency: 1, attempts: 2, backoff: exp5s, maxStalledCount: 1, kinds: { enrich: kind(120), extract: kind(120), summarize: kind(120) } },
  memory: { concurrency: 1, attempts: 3, backoff: exp5s, maxStalledCount: 1, kinds: { import: kind(null), distill: kind(null) } },
  // runner: a stalled step is never re-queued (spec:196); F4 retries are explicit attempts
  runner: { concurrency: 3, attempts: 1, maxStalledCount: 0, kinds: { step: kind(null) } },
  cleanup: { concurrency: 1, attempts: 3, backoff: exp5s, maxStalledCount: 1, kinds: { worktree: kind(600), blobs: kind(600), receipts: kind(600) } },
  'dlq-retry': { concurrency: 1, attempts: 1, maxStalledCount: 1, kinds: { run: kind(null) } },
};

/** `pollEveryMs`, `dlqEveryMs`, `dlqMaxRetries`: spec:194-196. The rest: chosen by judgment. */
export const queueLimits = {
  submitTimeoutMs: 1000,
  pollEveryMs: 5000,
  staleAfterMs: 10_000,
  dlqEveryMs: 600_000,
  dlqMaxRetries: 5,
  dlqScan: 200,
  closeGraceMs: 5000,
  removeOnCompleteCount: 100,
  removeOnFailAgeS: 604_800,
  retryWriteTries: 3,
};

/** Timeout of one attempt in ms, or `null` (no timer). `runner.step` reads `payload.timeoutS`. Values are read at call time. */
export function timeoutMs(queue: string, kindName: string, payload?: unknown): number | null {
  const def = QUEUES[queue]?.kinds[kindName];
  if (!def) return null;
  let s = def.timeoutS;
  if (s === null && queue === 'runner') {
    const t = (payload as { timeoutS?: unknown } | null | undefined)?.timeoutS;
    s = typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : null;
  }
  return s === null ? null : s * 1000;
}

/** BullMQ rejects ids with a colon or plain integers; the encoding is injective. `run:r1:node:n1` -> `j|run|r1|node|n1`. */
export const bullJobId = (id: string): string =>
  'j|' + id.replaceAll('%', '%25').replaceAll('|', '%7C').replaceAll(':', '|');

export type Queues = { names: string[]; get(name: string): Queue; close(): Promise<void> };

/**
 * BullMQ producer handles on one shared connection. Nothing connects before the first `get`. The connection has no
 * offline queue, so an add fails at once when Redis is down; `namespace` prefixes the BullMQ keys (`<namespace>bull`).
 */
export function createQueues(opts: { url: string; namespace?: string }): Queues {
  const prefix = `${opts.namespace ?? ''}bull`;
  const open = new Map<string, Queue>();
  let client: Redis | undefined;
  let closed = false;
  return {
    names: Object.keys(QUEUES),
    get(name) {
      if (closed) throw new Error('closed');
      const def = QUEUES[name];
      if (!def) throw new Error(`unknown queue: ${name}`);
      client ??= new Redis(opts.url, {
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        retryStrategy: (n) => Math.min(50 * n, 1000),
      }).on('error', () => undefined);
      let q = open.get(name);
      if (!q) {
        q = new Queue(name, {
          connection: client,
          prefix,
          defaultJobOptions: {
            attempts: def.attempts,
            ...(def.backoff ? { backoff: def.backoff } : {}),
            removeOnComplete: { count: queueLimits.removeOnCompleteCount },
            removeOnFail: { age: queueLimits.removeOnFailAgeS },
          },
        }).on('error', () => undefined);
        open.set(name, q);
      }
      return q;
    },
    async close() {
      if (closed) return;
      closed = true;
      client?.disconnect(); // first: a Queue still waiting for a connection that never comes would otherwise block close()
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...open.values()].map((q) => q.close())),
        new Promise((res) => (timer = setTimeout(res, 2000))),
      ]);
      clearTimeout(timer);
    },
  };
}
