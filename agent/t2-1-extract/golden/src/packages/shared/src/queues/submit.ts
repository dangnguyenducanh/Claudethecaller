/**
 * Job submit and the shared job types. Called from: apps/web (`/api`, hooks), apps/worker (poller re-adds).
 * Why: the `jobs` row in Postgres is the truth and is written BEFORE BullMQ; if Redis is down the row stays `queued`
 * and the worker's poller picks it up (spec:196). Deliberately NOT done: SQL (`create` is passed in), retries of the add.
 */
import { randomUUID } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import { bullJobId, queueLimits, type Queues } from './defs.ts';
import { PayloadInvalidError, parsePayload } from './payloads.ts';

export type JobRow = {
  id: string;
  queue: string;
  kind: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'dead';
  payload: unknown;
  attempts: number;
  userId: string;
  updatedAt: Date;
};

/** T1.3 `repos.system.jobs.*` without the leading `SystemCtx`. `markRunning` is the claim: `false` = not claimable. */
export type JobsPort = {
  listQueued(limit: number): Promise<JobRow[]>;
  markRunning(id: string): Promise<boolean>;
  markDone(id: string, result?: unknown): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  markDead(id: string, error: string): Promise<void>;
  markQueued(id: string): Promise<void>;
  setProgress(id: string, progress: number): Promise<void>;
};

/** Attempt exceeded its timeout (a normal failure: retried while attempts are left). */
export class JobTimeoutError extends Error {
  readonly code = 'timeout';
  constructor(message: string) {
    super(message);
    this.name = 'JobTimeoutError';
  }
}

/** A handler throws this to end the job at once, without retry and without `dlq-retry`; the row error is `dropped:<code>`. */
export class JobDropped extends UnrecoverableError {
  readonly code: string;
  constructor(code: string) {
    super(`dropped:${code}`);
    this.name = 'UnrecoverableError'; // BullMQ also recognises it by name
    this.code = code;
  }
}

/** Adds the BullMQ job for a `jobs` row. Returns `false` (never throws) when Redis is down, slow or the add fails. */
export async function addToQueue(
  queues: Queues,
  row: { id: string; queue: string; kind: string; payload: unknown },
  log?: (message: string, fields?: Record<string, unknown>) => void,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const add = queues.get(row.queue).add(row.kind, { id: row.id, payload: row.payload }, { jobId: bullJobId(row.id) });
    add.catch(() => undefined); // the race may have given up already
    await Promise.race([
      add,
      new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error('add timeout')), queueLimits.submitTimeoutMs))),
    ]);
    return true;
  } catch (e) {
    log?.('job add failed', { queue: row.queue, error: e instanceof Error ? e.constructor.name : typeof e });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validates the payload (before anything is written), creates the row, then adds the BullMQ job. A throw from `create`
 * propagates (nothing was enqueued). A failed add is not an error: `enqueued: false`, the row stays `queued`.
 */
export async function submitJob(
  deps: {
    queues: Queues;
    create(row: { id: string; queue: string; kind: string; payload: unknown }): Promise<{ id: string; created: boolean }>;
    log?: (message: string, fields?: Record<string, unknown>) => void;
  },
  input: { queue: string; kind: string; payload: unknown; id?: string },
): Promise<{ id: string; created: boolean; enqueued: boolean }> {
  const payload = parsePayload(input.queue, input.kind, input.payload);
  if (input.id !== undefined && (typeof input.id !== 'string' || input.id === '')) {
    throw new PayloadInvalidError([{ path: ['id'], message: 'id must be a non-empty string' }]);
  }
  const row = { id: input.id ?? randomUUID(), queue: input.queue, kind: input.kind, payload };
  const created = await deps.create(row);
  // judgment: also added when `created` is false, an earlier add may have failed (BullMQ ignores a duplicate id)
  const enqueued = await addToQueue(deps.queues, { ...row, id: created.id }, deps.log);
  return { id: created.id, created: created.created, enqueued };
}
