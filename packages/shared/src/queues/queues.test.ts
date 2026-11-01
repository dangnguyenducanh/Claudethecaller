import { afterEach, describe, expect, it } from 'vitest';
import { PayloadInvalidError, QUEUES, bullJobId, parsePayload, payloads, queueLimits, submitJob, timeoutMs } from './index.ts';
import type { Queues } from './index.ts';

const keepTimeout = QUEUES.llm?.kinds.enrich?.timeoutS;
afterEach(() => {
  (QUEUES.llm as { kinds: Record<string, { timeoutS: number | null }> }).kinds.enrich = { timeoutS: keepTimeout ?? null };
});
const llm = { userId: 'u1', capId: 'c1' };

describe('table (D15, D2)', () => {
  it('has the 7 queues with the spec numbers', () => {
    const rows = Object.entries(QUEUES).map(([n, d]) => [n, d.concurrency, d.attempts, d.backoff?.type, d.maxStalledCount]);
    expect(rows).toEqual([
      ['graph', 1, 3, 'exponential', 1], ['library', 1, 3, 'exponential', 1], ['llm', 1, 2, 'exponential', 1],
      ['memory', 1, 3, 'exponential', 1], ['runner', 3, 1, undefined, 0], ['cleanup', 1, 3, 'exponential', 1], ['dlq-retry', 1, 1, undefined, 1],
    ]);
    expect(Object.keys(QUEUES.llm?.kinds ?? {})).toEqual(['enrich', 'extract', 'summarize']);
  });
  it('pins the queue limits', () => {
    expect(queueLimits).toEqual({ submitTimeoutMs: 1000, pollEveryMs: 5000, staleAfterMs: 10000, dlqEveryMs: 600000, dlqMaxRetries: 5, dlqScan: 200, closeGraceMs: 5000, removeOnCompleteCount: 100, removeOnFailAgeS: 604800, retryWriteTries: 3 });
  });
});

describe('bullJobId (D3)', () => {
  it('encodes injectively and avoids colons and integers', () => {
    expect(bullJobId('run:r1:node:n1:visit:1:attempt:2')).toBe('j|run|r1|node|n1|visit|1|attempt|2');
    expect(bullJobId('a|b:c%d')).toBe('j|a%7Cb|c%25d');
    expect(bullJobId('a:b')).not.toBe(bullJobId('a|b'));
    expect(bullJobId('42')).toBe('j|42');
  });
});

describe('payloads (D4, D16)', () => {
  const ok: Record<string, unknown> = {
    'graph.rebuild': { userId: 'u1', projectId: 'p1' }, 'graph.extract': { userId: 'u1', projectId: 'p1', files: ['a'] }, 'library.scan': { userId: 'u1' },
    'library.changed': { userId: 'u1', capId: 'c', version: 1 }, 'llm.enrich': llm, 'llm.extract': { userId: 'u1', sessionId: 's' }, 'llm.summarize': { userId: 'u1', sessionId: 's' },
    'memory.import': { userId: 'u1' }, 'memory.distill': { userId: 'u1' }, 'runner.step': { userId: 'u1', runId: 'r', stepId: 's', nodeId: 'n', visit: 1, attempt: 1, timeoutS: 60 },
    'cleanup.worktree': { userId: 'u1', runId: 'r' }, 'cleanup.blobs': {}, 'cleanup.receipts': {}, 'dlq-retry.run': {},
  };
  it('every pair has exactly one strict schema that rejects extra keys and empty userId', () => {
    const pairs = Object.entries(QUEUES).flatMap(([q, d]) => Object.keys(d.kinds).map((k) => `${q}.${k}`));
    expect(Object.keys(payloads).sort()).toEqual(pairs.sort());
    for (const [pair, p] of Object.entries(ok)) {
      const [q, k] = pair.split('.') as [string, string];
      expect(parsePayload(q, k, p)).toEqual(p);
      expect(() => parsePayload(q, k, { ...(p as object), extra: 1 })).toThrow(PayloadInvalidError);
      if ('userId' in (p as object)) expect(() => parsePayload(q, k, { ...(p as object), userId: '' })).toThrow(PayloadInvalidError);
    }
  });
  it('reports every issue; the message is the first one', () => {
    try {
      parsePayload('llm', 'enrich', { userId: 1, capId: 2 });
      expect.unreachable();
    } catch (e) {
      const err = e as PayloadInvalidError;
      expect([err.code, err.issues.length, err.message.startsWith('userId')]).toEqual(['invalid', 2, true]);
    }
    expect(() => parsePayload('zzz', 'x', {})).toThrow(PayloadInvalidError);
    expect(() => parsePayload('llm', 'nope', {})).toThrow(PayloadInvalidError);
  });
  it('submitJob rejects before create is called or Redis is touched (D4, D7)', async () => {
    let created = 0;
    const queues = { get: () => { throw new Error('touched'); } } as unknown as Queues;
    const deps = { queues, create: async (r: { id: string }) => ({ id: r.id, created: !!++created }) };
    await expect(submitJob(deps, { queue: 'llm', kind: 'enrich', payload: { userId: 'u1' } })).rejects.toBeInstanceOf(PayloadInvalidError);
    await expect(submitJob(deps, { queue: 'llm', kind: 'enrich', payload: llm, id: '' })).rejects.toBeInstanceOf(PayloadInvalidError);
    expect(created).toBe(0);
  });
  it('submitJob propagates a create failure without adding a job (D17)', async () => {
    const queues = { get: () => { throw new Error('touched'); } } as unknown as Queues;
    await expect(submitJob({ queues, create: async () => { throw new Error('db down'); } }, { queue: 'llm', kind: 'enrich', payload: llm })).rejects.toThrow('db down');
  });
});

describe('timeoutMs (D19)', () => {
  it('reads the table, the runner payload, and the table at call time', () => {
    expect([timeoutMs('graph', 'rebuild'), timeoutMs('graph', 'extract'), timeoutMs('llm', 'enrich'), timeoutMs('memory', 'import'), timeoutMs('cleanup', 'blobs')]).toEqual([300000, null, 120000, null, 600000]);
    expect(timeoutMs('runner', 'step', { timeoutS: 7 })).toBe(7000);
    expect(timeoutMs('runner', 'step')).toBeNull();
    (QUEUES.llm as { kinds: Record<string, { timeoutS: number | null }> }).kinds.enrich = { timeoutS: 1 };
    expect(timeoutMs('llm', 'enrich')).toBe(1000);
  });
});
