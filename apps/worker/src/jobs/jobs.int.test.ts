import { Redis } from 'ioredis';
import { UnrecoverableError } from 'bullmq';
import { afterAll, describe, expect, it } from 'vitest';
import { JobDropped, bullJobId, createQueues, queueLimits, submitJob, type JobRow, type JobsPort } from '@ctc/shared/queues';
import { dlqRetryOnce, pollOnce, startWorkers, type Handler } from './index.ts';

const url = process.env.CTC_SCRATCH_REDIS_URL ?? '';
const raw = new Redis(url, { maxRetriesPerRequest: 1 });
const spaces: string[] = [];
const closers: (() => Promise<unknown>)[] = [];
const ns = () => { const n = `t14vtw${Math.random().toString(16).slice(2, 10)}:`; spaces.push(n); return n; };
const llm = { userId: 'u1', capId: 'c1' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(25); }
  return false;
}
function fakePort() {
  const rows = new Map<string, JobRow & { error?: string }>();
  const port: JobsPort = {
    async listQueued(limit) { return [...rows.values()].filter((r) => r.status === 'queued').slice(0, limit); },
    async markRunning(id) { const r = rows.get(id); if (!r || r.status === 'done' || r.status === 'dead') return false; r.status = 'running'; r.attempts++; return true; },
    async markDone(id) { const r = rows.get(id); if (r) r.status = 'done'; },
    async markFailed(id, error) { const r = rows.get(id); if (r) { r.status = 'failed'; r.error = error; } },
    async markDead(id, error) { const r = rows.get(id); if (r) { r.status = 'dead'; r.error = error; } },
    async markQueued(id) { const r = rows.get(id); if (r) r.status = 'queued'; },
    async setProgress() { /* not under test */ },
  };
  const add = (id: string, queue: string, kind: string, payload: unknown, updatedAt = new Date()) =>
    rows.set(id, { id, queue, kind, status: 'queued', payload, attempts: 0, userId: 'u1', updatedAt });
  return { port, rows, add };
}
afterAll(async () => {
  for (const c of closers.reverse()) await c();
  for (const n of spaces) { const [, ks] = await raw.scan('0', 'MATCH', `${n}*`, 'COUNT', 1000); if (ks.length) await raw.del(...ks); }
  raw.disconnect();
});

describe('pollOnce, Redis up (D20)', () => {
  it('re-adds stale queued rows only and never runs them', async () => {
    const q = createQueues({ url, namespace: ns() }); closers.push(() => q.close());
    const f = fakePort();
    f.add('old', 'llm', 'enrich', llm, new Date(Date.now() - 60_000)); f.add('fresh', 'llm', 'enrich', llm);
    let ran = false;
    const res = await pollOnce({ port: f.port, queues: q, handlers: { 'llm.enrich': (async () => { ran = true; }) as Handler }, isRedisUp: async () => true });
    expect(res).toEqual({ reenqueued: ['old'], ran: [] });
    expect(ran).toBe(false);
    expect(await q.get('llm').getJob(bullJobId('old'))).toBeDefined();
    expect(await q.get('llm').getJob(bullJobId('fresh'))).toBeUndefined();
  });
});

describe('workers, dlq-retry and close (D6, D21, D23)', () => {
  it('startup race: a stale queued row with Redis up is re-added and run by BullMQ, never by the poller (D6, D20)', async () => {
    const n = ns(); const f = fakePort(); const q = createQueues({ url, namespace: n }); closers.push(() => q.close());
    f.add('race1', 'graph', 'rebuild', { userId: 'u1', projectId: 'p1' }, new Date(0));
    const via: string[] = [];
    const handler: Handler = async () => { via.push(/poller\.ts/.test(new Error().stack ?? '') ? 'poller-direct' : 'bullmq'); };
    const w = await startWorkers({ url, namespace: n, port: f.port, handlers: { 'graph.rebuild': handler }, dlq: false });
    closers.push(() => w.close({ graceMs: 100 }));
    expect(await waitFor(() => via.length > 0, 5000)).toBe(true);
    expect(via).toEqual(['bullmq']);
  });
  it('runs jobs through BullMQ; dlq-retry retries 5 times then gives up, never touches dropped or runner failures', async () => {
    const n = ns(); const f = fakePort(); const q = createQueues({ url, namespace: n }); closers.push(() => q.close());
    const handlers: Record<string, Handler> = {
      'llm.enrich': (async () => { throw new UnrecoverableError('boom'); }) as Handler,
      'llm.extract': (async () => { throw new JobDropped('bad_reply'); }) as Handler,
      'llm.summarize': (async () => 'fine') as Handler,
      'runner.step': (async () => { throw new Error('runner boom'); }) as Handler,
    };
    const w = await startWorkers({ url, namespace: n, port: f.port, handlers, poll: false, dlq: false }); closers.push(() => w.close());
    const deps = { queues: q, create: async (row: { id: string; queue: string; kind: string; payload: unknown }) => { f.add(row.id, row.queue, row.kind, row.payload); return { id: row.id, created: true }; } };
    const sub = async (queue: string, kind: string, payload: unknown) => (await submitJob(deps, { queue, kind, payload })).id;
    const ok = await sub('llm', 'summarize', { userId: 'u1', sessionId: 's' });
    expect(await waitFor(() => f.rows.get(ok)?.status === 'done')).toBe(true);
    const a = await sub('llm', 'enrich', llm);
    const failed = async (name: string) => (await q.get(name).getFailedCount());
    const settled = () => waitFor(async () => f.rows.get(a)?.status === 'dead' && (await failed('llm')) === 1);
    expect(await settled()).toBe(true);
    const results = [];
    for (let i = 0; i < 6; i++) { results.push(await dlqRetryOnce({ queues: q, redis: raw, port: f.port, namespace: n })); await settled(); }
    expect(results.slice(0, 5).every((r) => r.retried.includes(a))).toBe(true);
    expect(results[5]?.gaveUp).toContain(a);
    expect(f.rows.get(a)?.error).toMatch(/^dlq_gave_up/);
    const b = await sub('llm', 'extract', { userId: 'u1', sessionId: 's' });
    const r = await sub('runner', 'step', { userId: 'u1', runId: 'r', stepId: 's', nodeId: 'n', visit: 1, attempt: 1, timeoutS: 60 });
    expect(await waitFor(async () => (await failed('runner')) === 1 && f.rows.get(b)?.status === 'dead')).toBe(true);
    const last = await dlqRetryOnce({ queues: q, redis: raw, port: f.port, namespace: n });
    expect(last.skipped).toContain(b);
    for (const list of [last.retried, last.gaveUp, last.skipped]) expect(list).not.toContain(r);
  });
  it('close resolves within the grace period with a stuck job and twice; only handler queues get workers', async () => {
    const n = ns(); const f = fakePort(); const q = createQueues({ url, namespace: n }); closers.push(() => q.close());
    expect((await startWorkers({ url, namespace: n, port: f.port, handlers: {}, poll: false, dlq: false })).queues).toEqual([]);
    const keep = queueLimits.closeGraceMs; queueLimits.closeGraceMs = 100;
    try {
      const w = await startWorkers({ url, namespace: n, port: f.port, handlers: { 'llm.enrich': (() => new Promise(() => undefined)) as Handler }, poll: false, dlq: false });
      expect(w.queues).toEqual(['llm']);
      const id = (await submitJob({ queues: q, create: async (row) => { f.add(row.id, row.queue, row.kind, row.payload); return { id: row.id, created: true }; } }, { queue: 'llm', kind: 'enrich', payload: llm })).id;
      expect(await waitFor(() => f.rows.get(id)?.status === 'running', 3000)).toBe(true);
      const t = Date.now(); await w.close(); await w.close();
      expect(Date.now() - t).toBeLessThan(3000);
    } finally { queueLimits.closeGraceMs = keep; }
  });
});
