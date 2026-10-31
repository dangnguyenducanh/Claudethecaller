/**
 * `dlq-retry`: every `dlqEveryMs` re-runs each failed BullMQ job up to `dlqMaxRetries` times (spec:194).
 * Called from: the `dlq-retry` worker started by startWorkers. Why: a job that exhausted its attempts gets a second,
 * slower chance. Never touches `runner` (explicit F4 attempts, spec:192) or a `dropped:` failure.
 * Deliberately NOT done: SQL (JobsPort), more than `dlqScan` jobs per queue per pass, whole-database wipes or key scans (only INCR on its own counter).
 */
import type { Redis } from 'ioredis';
import { QUEUES, queueLimits, type JobsPort, type Queues } from '@ctc/shared/queues';
import type { Log } from './consumers.ts';

const COUNTER_TTL_S = 30 * 86_400;

/** Returns jobs-row ids. If Redis (or the port) fails mid-scan, stops and returns what was done. */
export async function dlqRetryOnce(opts: {
  queues: Queues;
  redis: Redis;
  port: JobsPort;
  maxRetries?: number;
  namespace?: string;
  log?: Log;
}): Promise<{ retried: string[]; gaveUp: string[]; skipped: string[] }> {
  const { queues, redis, port, log } = opts;
  const maxRetries = opts.maxRetries ?? queueLimits.dlqMaxRetries;
  const ns = opts.namespace ?? '';
  const out = { retried: [] as string[], gaveUp: [] as string[], skipped: [] as string[] };
  try {
    for (const name of Object.keys(QUEUES)) {
      if (name === 'runner' || name === 'dlq-retry') continue;
      const failed = await queues.get(name).getJobs(['failed'], 0, queueLimits.dlqScan - 1, true);
      for (const job of failed) {
        const rowId = (job.data as { id?: unknown } | null)?.id;
        if (typeof rowId !== 'string' || !job.id) continue;
        const reason = job.failedReason ?? '';
        if (reason.startsWith('dropped:')) {
          out.skipped.push(rowId);
          continue;
        }
        const key = `${ns}dlq:${name}:${job.id}`;
        const res = await redis.multi().incr(key).expire(key, COUNTER_TTL_S, 'NX').exec();
        const n = Number(res?.[0]?.[1]);
        if (n <= maxRetries) {
          await port.markQueued(rowId); // a `dead` row cannot be claimed, so first
          await job.retry('failed');
          out.retried.push(rowId);
        } else if (n === maxRetries + 1) {
          await port.markDead(rowId, `dlq_gave_up: ${reason}`);
          out.gaveUp.push(rowId);
        }
      }
    }
  } catch (e) {
    log?.('dlq-retry stopped', { error: e instanceof Error ? e.constructor.name : typeof e });
  }
  return out;
}
