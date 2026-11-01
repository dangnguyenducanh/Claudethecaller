/**
 * One job attempt: validate, claim, run the handler under its timeout, write the outcome to the `jobs` row.
 * Called from: startWorkers (the BullMQ processor) and poller.ts (Redis-down mode). Why: the row is the truth; the
 * `markRunning` claim is the guard against running one job on two workers. Deliberately NOT done: SQL (JobsPort), the
 * handlers themselves (later tasks), BullMQ backoff (BullMQ applies it to the error this rethrows).
 */
import { UnrecoverableError } from 'bullmq';
import { JobDropped, JobTimeoutError, PayloadInvalidError, QUEUES, parsePayload, queueLimits, timeoutMs, type JobsPort } from '@ctc/shared/queues';

export type Log = (message: string, fields?: Record<string, unknown>) => void;

export type Handler = (
  payload: never,
  ctx: { jobId: string; attempt: number; signal: AbortSignal; setProgress(n: number): Promise<void> },
) => Promise<unknown>;

export type AttemptInput = {
  port: JobsPort;
  handler: Handler | undefined;
  queue: string;
  kind: string;
  jobId: string;
  data: unknown;
  attemptsMade: number;
  maxAttempts: number;
  log?: Log | undefined;
};

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
export const errText = (e: unknown): string => {
  if (e instanceof JobDropped) return e.message;
  const s = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
  return s.slice(0, 1000);
};

/** `UnrecoverableError` is also matched by name: BullMQ does the same, and two copies of the package may be loaded. */
export const isFinal = (e: unknown, attemptsMade: number, maxAttempts: number): boolean =>
  e instanceof UnrecoverableError || (e as { name?: unknown } | null)?.name === 'UnrecoverableError' || attemptsMade + 1 >= maxAttempts;

class NoHandler extends Error {
  constructor() {
    super('no_handler');
  }
}

/**
 * Runs one attempt of the job in `data = { id, payload }`. Returns `{ skipped: true }` when the row cannot be claimed;
 * throws (after writing `failed` or `dead`) when the attempt failed, so BullMQ applies backoff or moves the job to failed.
 */
export async function runAttempt(input: AttemptInput): Promise<{ skipped: true } | { skipped: false; result: unknown }> {
  const { port, handler, queue, kind, attemptsMade, maxAttempts, log } = input;
  const data = input.data as { id?: unknown; payload?: unknown } | null;
  const id = data?.id;
  if (typeof id !== 'string') throw new UnrecoverableError('payload_invalid');

  let payload: unknown;
  try {
    payload = parsePayload(queue, kind, data?.payload);
  } catch (e) {
    if (!(e instanceof PayloadInvalidError)) throw e;
    await port.markDead(id, 'payload_invalid');
    throw new UnrecoverableError('payload_invalid');
  }

  if (!(await port.markRunning(id))) return { skipped: true };

  const ac = new AbortController();
  const ms = timeoutMs(queue, kind, payload);
  let timer: NodeJS.Timeout | undefined;
  try {
    const ctx = { jobId: id, attempt: attemptsMade + 1, signal: ac.signal, setProgress: (n: number) => port.setProgress(id, n) };
    const run = Promise.resolve().then(() => (handler ? handler(payload as never, ctx) : Promise.reject(new NoHandler())));
    const result =
      ms === null
        ? await run
        : await Promise.race([
            run,
            new Promise<never>((_, rej) => {
              timer = setTimeout(() => {
                rej(new JobTimeoutError(`timeout after ${ms / 1000} s`)); // reject first: the abort may make `run` reject too
                ac.abort();
              }, ms);
            }),
          ]);
    for (let i = 1; i <= queueLimits.retryWriteTries; i++) {
      try {
        await port.markDone(id, result);
        break;
      } catch (e) {
        if (i === queueLimits.retryWriteTries) {
          // judgment: the job is complete; a stale `running` row is accepted
          log?.('markDone failed', { jobId: id, error: e instanceof Error ? e.constructor.name : typeof e });
        } else {
          await sleep(100);
        }
      }
    }
    return { skipped: false, result };
  } catch (err) {
    const text = err instanceof NoHandler ? 'no_handler' : errText(err);
    try {
      await (isFinal(err, attemptsMade, maxAttempts) ? port.markDead(id, text) : port.markFailed(id, text));
    } catch (e) {
      log?.('row write failed after job failure', { jobId: id, error: e instanceof Error ? e.constructor.name : typeof e });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Max attempts of a queue from the table; 1 for an unknown queue. */
export const maxAttemptsOf = (queue: string): number => QUEUES[queue]?.attempts ?? 1;
