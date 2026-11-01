import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '@ctc/shared/repositories';
import type { Handler } from '../jobs/index.ts';
import { blobCleanupHandlers, blobCleanupJobId, startBlobCleanup } from './index.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('blobCleanupJobId (D20c)', () => {
  it('is the ISO week in UTC, including week 53 and a year boundary', () => {
    expect(blobCleanupJobId(new Date('2026-10-31T12:00:00Z'))).toBe('cleanup.blobs:2026-W44');
    expect(blobCleanupJobId(new Date('2027-01-01T12:00:00Z'))).toBe('cleanup.blobs:2026-W53');
    expect(blobCleanupJobId(new Date('2026-01-05T00:00:00Z'))).toBe('cleanup.blobs:2026-W02');
    expect(blobCleanupJobId(new Date('2024-12-30T23:59:59Z'))).toBe('cleanup.blobs:2025-W01');
  });
  it('is the same for every instant of one week and changes at Monday 00:00 UTC', () => {
    expect(blobCleanupJobId(new Date('2026-10-26T00:00:00Z'))).toBe(blobCleanupJobId(new Date('2026-11-01T23:59:59Z')));
    expect(blobCleanupJobId(new Date('2026-11-02T00:00:00Z'))).toBe('cleanup.blobs:2026-W45');
  });
});

describe('blobCleanupHandlers (D20a)', () => {
  it('is keyed cleanup.blobs, returns { deleted } and lets errors propagate', async () => {
    const calls: unknown[] = [];
    const repos = { system: { cleanup: { deleteUnreferencedBlobs: async (ctx: unknown) => (calls.push(ctx), 3) } } } as unknown as Repositories;
    const handlers = blobCleanupHandlers({ repos });
    expect(Object.keys(handlers)).toEqual(['cleanup.blobs']);
    const hctx = { jobId: 'j', attempt: 1, signal: new AbortController().signal, setProgress: async () => undefined };
    const run = (h: Handler) => (h as unknown as (p: unknown, c: typeof hctx) => Promise<unknown>)({}, hctx);
    expect(await run(handlers['cleanup.blobs'])).toEqual({ deleted: 3 });
    expect(calls).toHaveLength(1);
    const failing = { system: { cleanup: { deleteUnreferencedBlobs: async () => { throw new Error('lock timeout'); } } } } as unknown as Repositories;
    await expect(run(blobCleanupHandlers({ repos: failing })['cleanup.blobs'])).rejects.toThrow('lock timeout');
  });
});

describe('startBlobCleanup (D20d)', () => {
  it('submits at once with the weekly id and then every everyMs; close stops it and is idempotent', async () => {
    vi.useFakeTimers();
    const calls: unknown[] = [];
    const submit = async (input: unknown) => (calls.push(input), { id: 'x' });
    const t = startBlobCleanup({ submit, everyMs: 1000, now: () => new Date('2026-10-31T12:00:00Z') });
    await vi.advanceTimersByTimeAsync(2500);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({ queue: 'cleanup', kind: 'blobs', payload: {}, id: 'cleanup.blobs:2026-W44' });
    t.close();
    t.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(3);
  });
  it('logs a rejected or synchronously throwing submit and never throws', async () => {
    vi.useFakeTimers();
    const logs: unknown[][] = [];
    const log = (m: string, f?: Record<string, unknown>) => void logs.push([m, f]);
    const a = startBlobCleanup({ submit: async () => { throw new Error('down'); }, everyMs: 1000, log });
    const b = startBlobCleanup({ submit: () => { throw new TypeError('sync'); }, everyMs: 1000, log });
    await vi.advanceTimersByTimeAsync(10);
    a.close();
    b.close();
    expect(logs.map((l) => (l[1] as { error: string }).error).sort()).toEqual(['Error', 'TypeError']);
  });
});
