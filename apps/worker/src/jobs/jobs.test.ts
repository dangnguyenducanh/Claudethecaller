import { UnrecoverableError } from 'bullmq';
import { afterEach, describe, expect, it } from 'vitest';
import { JobDropped, JobTimeoutError, QUEUES, createQueues, type JobRow, type JobsPort } from '@ctc/shared/queues';
import { pollOnce, runAttempt, type Handler } from './index.ts';

const llm = { userId: 'u1', capId: 'c1' };

function fakePort() {
  const rows = new Map<string, JobRow & { error?: string }>();
  const log: unknown[][] = [];
  const port: JobsPort = {
    async listQueued(limit) { return [...rows.values()].filter((r) => r.status === 'queued').slice(0, limit); },
    async markRunning(id) { const r = rows.get(id); if (!r || r.status === 'done' || r.status === 'dead') return false; r.status = 'running'; r.attempts++; log.push(['running', id]); return true; },
    async markDone(id, result) { const r = rows.get(id); if (r) r.status = 'done'; log.push(['done', id, result]); },
    async markFailed(id, error) { const r = rows.get(id); if (r) { r.status = 'failed'; r.error = error; } log.push(['failed', id, error]); },
    async markDead(id, error) { const r = rows.get(id); if (r) { r.status = 'dead'; r.error = error; } log.push(['dead', id, error]); },
    async markQueued(id) { const r = rows.get(id); if (r) r.status = 'queued'; log.push(['queued', id]); },
    async setProgress(id, p) { log.push(['progress', id, p]); },
  };
  const add = (id: string, status: JobRow['status'] = 'queued', attempts = 0, updatedAt = new Date(), queue = 'llm', kind = 'enrich') =>
    rows.set(id, { id, queue, kind, status, payload: llm, attempts, userId: 'u1', updatedAt });
  return { port, rows, log, add };
}
const base = (port: JobsPort, handler: Handler | undefined, over: Record<string, unknown> = {}) => ({
  port, handler, queue: 'llm', kind: 'enrich', jobId: 'bj', data: { id: 'j1', payload: llm }, attemptsMade: 0, maxAttempts: 3, ...over,
});
const last = (log: unknown[][]) => log[log.length - 1];

describe('runAttempt (D18)', () => {
  it('claims, runs, marks done and returns the result', async () => {
    const f = fakePort(); f.add('j1');
    expect(await runAttempt(base(f.port, async () => ({ ok: 1 })))).toEqual({ skipped: false, result: { ok: 1 } });
    expect(f.log.map((l) => l[0])).toEqual(['running', 'done']);
  });
  it('failure with attempts left is failed, the last attempt is dead, and the error is rethrown', async () => {
    const f = fakePort(); f.add('j1');
    await expect(runAttempt(base(f.port, async () => { throw new Error('boom'); }))).rejects.toThrow('boom');
    expect(last(f.log)).toEqual(['failed', 'j1', 'Error: boom']);
    f.add('j1');
    await expect(runAttempt(base(f.port, async () => { throw new Error('boom'); }, { attemptsMade: 2 }))).rejects.toThrow('boom');
    expect(last(f.log)?.[0]).toBe('dead');
  });
  it('unrecoverable and dropped errors are dead at once; dropped text is dropped:<code>', async () => {
    const f = fakePort(); f.add('j1');
    await expect(runAttempt(base(f.port, async () => { throw new UnrecoverableError('stop'); }))).rejects.toThrow('stop');
    expect(last(f.log)?.[0]).toBe('dead');
    f.add('j1');
    await expect(runAttempt(base(f.port, async () => { throw new JobDropped('bad_reply'); }))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(last(f.log)).toEqual(['dead', 'j1', 'dropped:bad_reply']);
  });
  it('a row that cannot be claimed is skipped without calling the handler', async () => {
    const f = fakePort(); f.add('j1', 'done');
    let called = false;
    expect(await runAttempt(base(f.port, async () => { called = true; }))).toEqual({ skipped: true });
    expect(called).toBe(false);
  });
  it('an invalid payload is dead with payload_invalid and never runs', async () => {
    const f = fakePort(); f.add('j1');
    await expect(runAttempt(base(f.port, async () => 1, { data: { id: 'j1', payload: { userId: 'u1' } } }))).rejects.toThrow('payload_invalid');
    expect(last(f.log)).toEqual(['dead', 'j1', 'payload_invalid']);
  });
  it('a missing handler is a normal failure with error no_handler', async () => {
    const f = fakePort(); f.add('j1');
    await expect(runAttempt(base(f.port, undefined))).rejects.toThrow('no_handler');
    expect(last(f.log)).toEqual(['failed', 'j1', 'no_handler']);
  });
  it('a failing markDone is retried and then accepted without failing the job', async () => {
    const f = fakePort(); f.add('j1');
    let tries = 0;
    const port = { ...f.port, markDone: async () => { tries++; throw new Error('db'); } };
    expect(await runAttempt(base(port, async () => 'ok'))).toEqual({ skipped: false, result: 'ok' });
    expect(tries).toBe(3);
  });
});

describe('timeout (D19)', () => {
  const keep = QUEUES.llm?.kinds.enrich?.timeoutS ?? null;
  afterEach(() => { (QUEUES.llm as { kinds: Record<string, { timeoutS: number | null }> }).kinds.enrich = { timeoutS: keep }; });
  it('aborts the signal and rejects with JobTimeoutError', async () => {
    (QUEUES.llm as { kinds: Record<string, { timeoutS: number | null }> }).kinds.enrich = { timeoutS: 0.05 };
    const f = fakePort(); f.add('j1');
    let aborted = false;
    const handler: Handler = (_p, ctx) => new Promise((_res, rej) => ctx.signal.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')); }));
    await expect(runAttempt(base(f.port, handler, { maxAttempts: 2 }))).rejects.toBeInstanceOf(JobTimeoutError);
    expect(aborted).toBe(true);
    expect(last(f.log)?.[0]).toBe('failed');
  });
});

describe('pollOnce, Redis down (D20, D8)', () => {
  const queues = createQueues({ url: 'redis://127.0.0.1:1' });
  const down = async () => false;
  it('runs queued rows directly, serially, with attempts; a failure goes back to queued, then dead', async () => {
    const f = fakePort(); f.add('d1'); f.add('d2');
    const handlers = { 'llm.enrich': (async (_p, ctx) => { if (ctx.jobId === 'd2') throw new Error('flaky'); return 'ok'; }) as Handler };
    const t1 = await pollOnce({ port: f.port, queues, handlers, isRedisUp: down });
    expect([t1.ran, f.rows.get('d1')?.status, f.rows.get('d2')?.status, f.rows.get('d2')?.attempts]).toEqual([['d1', 'd2'], 'done', 'queued', 1]);
    await pollOnce({ port: f.port, queues, handlers, isRedisUp: down });
    expect([f.rows.get('d2')?.status, f.rows.get('d2')?.attempts]).toEqual(['dead', 2]);
  });
  it('leaves a row without a handler untouched', async () => {
    const f = fakePort(); f.add('r1', 'queued', 0, new Date(), 'llm', 'summarize');
    const res = await pollOnce({ port: f.port, queues, handlers: {}, isRedisUp: down });
    expect([res.ran, f.rows.get('r1')?.status, f.rows.get('r1')?.attempts]).toEqual([[], 'queued', 0]);
  });
  it('does nothing when the Redis check itself throws (never runs a job while Redis may be up)', async () => {
    const f = fakePort(); f.add('r1');
    const res = await pollOnce({ port: f.port, queues, handlers: { 'llm.enrich': async () => 1 }, isRedisUp: async () => { throw new Error('x'); } });
    expect(res).toEqual({ reenqueued: [], ran: [] });
    expect(f.rows.get('r1')?.status).toBe('queued');
  });
});
