/**
 * Redis-down poller. Called from: startWorkers every `pollEveryMs`. Why: when Redis is down, job submits still insert
 * the `jobs` row (spec:196); this finds those rows. Redis up: re-adds stale `queued` rows to BullMQ (never runs them:
 * that would double-execute). Redis down: runs them directly, serially, one pass per tick.
 * Deliberately NOT done: exponential backoff in direct mode (a failed row waits one tick), parallelism.
 */
import { QUEUES, addToQueue, queueLimits, type JobsPort, type Queues } from '@ctc/shared/queues';
import { isFinal, maxAttemptsOf, runAttempt, type Handler, type Log } from './consumers.ts';

const LIST_LIMIT = 200;
const warnedNoHandler = new Set<string>();

export async function pollOnce(opts: {
  port: JobsPort;
  queues: Queues;
  handlers: Record<string, Handler>;
  isRedisUp: () => Promise<boolean>;
  log?: Log;
}): Promise<{ reenqueued: string[]; ran: string[] }> {
  const { port, queues, handlers, log } = opts;
  const out = { reenqueued: [] as string[], ran: [] as string[] };
  let up: boolean;
  try {
    up = await opts.isRedisUp();
  } catch {
    return out; // judgment: unknown is not "down": running directly while Redis is up would double-execute
  }
  const rows = (await port.listQueued(LIST_LIMIT))
    .filter((r) => r.queue !== 'dlq-retry' && Object.hasOwn(QUEUES, r.queue))
    .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());

  if (up) {
    const staleBefore = Date.now() - queueLimits.staleAfterMs;
    for (const row of rows) {
      if (row.updatedAt.getTime() >= staleBefore) continue;
      // judgment: the first failed add means Redis flapped; stop and let the next tick retry
      if (!(await addToQueue(queues, row, log))) break;
      out.reenqueued.push(row.id);
    }
    return out;
  }

  for (const row of rows) {
    const handler = handlers[`${row.queue}.${row.kind}`];
    if (!handler) {
      const k = `${row.queue}.${row.kind}`;
      if (!warnedNoHandler.has(k)) log?.('poller: no handler, row left untouched', { handler: k });
      warnedNoHandler.add(k);
      continue;
    }
    const maxAttempts = maxAttemptsOf(row.queue);
    const attemptsMade = row.attempts; // read before the claim: a port may hand out live rows
    try {
      const res = await runAttempt({
        port, handler, queue: row.queue, kind: row.kind, jobId: row.id,
        data: { id: row.id, payload: row.payload }, attemptsMade, maxAttempts, log,
      });
      if (!res.skipped) out.ran.push(row.id);
    } catch (e) {
      out.ran.push(row.id);
      if (!isFinal(e, attemptsMade, maxAttempts)) {
        await port.markQueued(row.id).catch(() => log?.('poller: markQueued failed', { jobId: row.id }));
      }
    }
  }
  return out;
}
