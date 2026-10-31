import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { bullJobId, createQueues, submitJob } from './index.ts';

const url = process.env.CTC_SCRATCH_REDIS_URL ?? '';
const raw = new Redis(url, { maxRetriesPerRequest: 1 });
const spaces: string[] = [];
const ns = () => {
  const n = `t14vtq${Math.random().toString(16).slice(2, 10)}:`;
  spaces.push(n);
  return n;
};
const llm = { userId: 'u1', capId: 'c1' };
const closers: (() => Promise<void>)[] = [];
const mk = (namespace: string, u = url) => {
  const q = createQueues({ url: u, namespace });
  closers.push(() => q.close());
  return q;
};
afterAll(async () => {
  for (const c of closers) await c();
  for (const n of spaces) {
    const [, ks] = await raw.scan('0', 'MATCH', `${n}*`, 'COUNT', 1000);
    if (ks.length) await raw.del(...ks);
  }
  raw.disconnect();
});

describe('createQueues (D9, D15)', () => {
  it('prefixes BullMQ keys with the namespace and sets default job options', async () => {
    const n = ns();
    const q = mk(n);
    const o = q.get('graph').defaultJobOptions;
    expect([o.attempts, o.backoff, o.removeOnComplete, o.removeOnFail]).toEqual([3, { type: 'exponential', delay: 5000 }, { count: 100 }, { age: 604800 }]);
    expect(q.get('runner').defaultJobOptions.backoff).toBeUndefined();
    await q.get('graph').getJobCounts('waiting');
    const [, ks] = await raw.scan('0', 'MATCH', `${n}bull:*`, 'COUNT', 1000);
    expect(ks.length).toBeGreaterThan(0);
  });
  it('close resolves twice and get then rejects', async () => {
    const q = createQueues({ url, namespace: ns() });
    await q.close();
    await q.close();
    expect(() => q.get('llm')).toThrow('closed');
  });
});

describe('submitJob (D5, D17)', () => {
  it('writes the row first, enqueues once per id, and encodes the runner id', async () => {
    const q = mk(ns());
    const order: string[] = [];
    let seen = 0;
    const deps = { queues: q, create: async (r: { id: string }) => { order.push('create'); return { id: r.id, created: seen++ === 0 }; } };
    const id = 'run:r1:node:n1:visit:1:attempt:1';
    const payload = { userId: 'u1', runId: 'r1', stepId: 's1', nodeId: 'n1', visit: 1, attempt: 1, timeoutS: 60 };
    const r1 = await submitJob(deps, { queue: 'runner', kind: 'step', id, payload });
    const r2 = await submitJob(deps, { queue: 'runner', kind: 'step', id, payload });
    expect([r1, r2.created, r2.enqueued, order]).toEqual([{ id, created: true, enqueued: true }, false, true, ['create', 'create']]);
    expect((await q.get('runner').getJobCounts('waiting')).waiting).toBe(1);
    const job = await q.get('runner').getJob(bullJobId(id));
    expect([job?.name, job?.data]).toEqual(['step', { id, payload }]);
  });
  it('Redis down: the row is created and enqueued is false, within the submit timeout', async () => {
    const q = mk(ns(), 'redis://127.0.0.1:1');
    let n = 0;
    const t = Date.now();
    const r = await submitJob({ queues: q, create: async (row) => { n++; return { id: row.id, created: true }; } }, { queue: 'llm', kind: 'enrich', payload: llm });
    expect([r.created, r.enqueued, n]).toEqual([true, false, 1]);
    expect(Date.now() - t).toBeLessThan(1500);
  });
});
