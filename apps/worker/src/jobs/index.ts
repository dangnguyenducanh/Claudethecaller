/**
 * Worker job framework: BullMQ consumers per queue, the Redis-down poller, `dlq-retry`, graceful close.
 * Called from: apps/worker main (handlers are added by T2.2, T3.1, T4.x, T6.x). Redis is a job carrier, never the truth:
 * the `jobs` row (JobsPort) is. Deliberately NOT done: handlers, SQL, installing units.
 */
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUES, createQueues, queueLimits } from '@ctc/shared/queues';
import type { JobsPort } from '@ctc/shared/queues';
import { maxAttemptsOf, runAttempt, type Handler, type Log } from './consumers.ts';
import { dlqRetryOnce } from './dlq-retry.ts';
import { pollOnce } from './poller.ts';

export { runAttempt, pollOnce, dlqRetryOnce };
export type { Handler };

const DLQ = 'dlq-retry';
const noop = (): void => undefined;
const retryStrategy = (n: number): number => Math.min(50 * n, 1000);
const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/** `handlers` is keyed `'<queue>.<kind>'`. Connects at once but resolves even when Redis is down. */
export async function startWorkers(opts: {
  url: string;
  namespace?: string;
  port: JobsPort;
  handlers: Record<string, Handler>;
  queues?: string[];
  isRedisUp?: () => Promise<boolean>;
  poll?: boolean;
  dlq?: boolean;
  log?: Log;
}): Promise<{ queues: string[]; close(o?: { graceMs?: number }): Promise<void> }> {
  const { port, handlers } = opts;
  const ns = opts.namespace ?? '';
  const log: Log = opts.log ?? noop;
  const wantDlq = opts.dlq ?? true;
  const wantPoll = opts.poll ?? true;
  const names = (opts.queues ?? [...new Set(Object.keys(handlers).map((k) => k.split('.')[0] as string))]).filter(
    (q) => q !== DLQ && Object.hasOwn(QUEUES, q),
  );
  if (wantDlq) names.push(DLQ);

  const queues = createQueues({ url: opts.url, namespace: ns });
  // dedicated command connection: no offline queue, so a ping or an INCR fails at once while Redis is down
  const ctl = new Redis(opts.url, { enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy }).on('error', noop);
  const conn = new Redis(opts.url, { maxRetriesPerRequest: null, retryStrategy }).on('error', noop);
  const isRedisUp =
    opts.isRedisUp ??
    (async () => {
      if (ctl.status === 'connecting' || ctl.status === 'connect') {
        // first tick runs before the handshake ends: bound-wait so an UP Redis is not mistaken for down
        await new Promise<void>((res) => {
          const done = (): void => { clearTimeout(t); ctl.off('ready', done); ctl.off('close', done); res(); };
          const t = setTimeout(done, 500);
          ctl.once('ready', done);
          ctl.once('close', done);
        });
      }
      if (ctl.status !== 'ready') return false;
      let timer: NodeJS.Timeout | undefined;
      try {
        const ping = ctl.ping();
        ping.catch(noop);
        return (await Promise.race([ping, new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error('ping timeout')), 500)))])) === 'PONG';
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    });

  const active = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>): Promise<T> => {
    active.add(p);
    const done = (): void => void active.delete(p);
    p.then(done, done);
    return p;
  };

  const workers = names.map((name) => {
    const def = QUEUES[name];
    const w = new Worker<unknown, unknown>(
      name,
      (job) =>
        track<unknown>(
          name === DLQ
            ? dlqRetryOnce({ queues, redis: ctl, port, namespace: ns, log })
            : runAttempt({
                port, handler: handlers[`${name}.${job.name}`], queue: name, kind: job.name,
                jobId: job.id ?? '', data: job.data, attemptsMade: job.attemptsMade, maxAttempts: maxAttemptsOf(name), log,
              }),
        ),
      { connection: conn, prefix: `${ns}bull`, concurrency: def?.concurrency ?? 1, maxStalledCount: def?.maxStalledCount ?? 1 },
    );
    w.on('error', (e) => log('worker error', { queue: name, error: e.constructor.name }));
    return w;
  });

  let closed = false;
  let scheduled = !wantDlq;
  let scheduling = false;
  let ticking = false;
  const tick = async (): Promise<void> => {
    if (ticking || closed) return;
    ticking = true;
    try {
      if (!scheduled && !scheduling) {
        // not awaited: BullMQ waits for a Redis that may be down, and the poll below must still run this tick
        scheduling = true;
        queues
          .get(DLQ)
          .upsertJobScheduler(DLQ, { every: queueLimits.dlqEveryMs }, { name: 'run', data: {} })
          .then(() => void (scheduled = true))
          .catch((e) => log('worker tick failed', { error: e instanceof Error ? e.constructor.name : typeof e }))
          .finally(() => void (scheduling = false));
      }
      if (wantPoll) await pollOnce({ port, queues, handlers, isRedisUp, log });
    } catch (e) {
      log('worker tick failed', { error: e instanceof Error ? e.constructor.name : typeof e });
    } finally {
      ticking = false;
    }
  };
  const timer = wantPoll || wantDlq ? setInterval(() => void tick(), queueLimits.pollEveryMs) : undefined;
  if (timer) void tick();

  // judgment: wait briefly for the workers to connect, never for ever (Redis may be down: the poller covers that)
  let waitTimer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled(workers.map((w) => w.waitUntilReady())),
    new Promise((res) => (waitTimer = setTimeout(res, queueLimits.submitTimeoutMs))),
  ]);
  clearTimeout(waitTimer);

  return {
    queues: names,
    async close({ graceMs = queueLimits.closeGraceMs } = {}) {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await Promise.allSettled(workers.map((w) => w.pause(true))); // stop taking jobs; do not wait for active ones
      const deadline = Date.now() + graceMs;
      while (active.size > 0 && Date.now() < deadline) await sleep(25);
      // force: a job still active stays `running` in its row; stalled detection re-queues it (not `runner`)
      await Promise.race([Promise.allSettled(workers.map((w) => w.close(true))), sleep(2000)]);
      ctl.disconnect();
      conn.disconnect();
      await queues.close();
    },
  };
}
