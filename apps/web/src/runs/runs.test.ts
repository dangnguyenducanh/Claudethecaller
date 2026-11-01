import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Repositories } from '@ctc/shared/repositories';
import { payloadHash, runsLimits, runsRoutes, stepJson, withIdempotency } from './index.ts';
import fixture from './fixtures/step-row.json' with { type: 'json' };

const ctx = { userId: 'u' };

/** In-memory `repos.idempotency` with the pending-only settle and release of D20a. */
function memIdempotency() {
  const rows = new Map<string, { route: string; payloadHash: string; response: { status: number; body?: unknown } }>();
  const idempotency = {
    store: async (_c: unknown, o: { key: string; route: string; payloadHash: string; response: { status: number } }) => {
      if (rows.has(o.key)) return false;
      rows.set(o.key, { route: o.route, payloadHash: o.payloadHash, response: o.response });
      return true;
    },
    lookup: async (_c: unknown, o: { key: string; route: string }) => {
      const r = rows.get(o.key);
      return r && r.route === o.route ? { payloadHash: r.payloadHash, response: r.response } : null;
    },
    settle: async (_c: unknown, o: { key: string; response: { status: number; body?: unknown } }) => {
      const r = rows.get(o.key);
      if (!r || r.response.status !== 0) return false;
      r.response = o.response;
      return true;
    },
    release: async (_c: unknown, o: { key: string }) => rows.get(o.key)?.response.status === 0 && rows.delete(o.key),
  };
  return { rows, deps: { repos: { idempotency } as unknown as Repositories } };
}

describe('limits (D2)', () => {
  it('are pinned', () => {
    expect({ ...runsLimits }).toEqual({ idempotencyKeyMax: 200, summaryMax: 20000, reasonMax: 2000 });
  });
});

describe('payloadHash (D18)', () => {
  it('sorts keys at every depth, keeps array order and drops undefined members', () => {
    expect(payloadHash({ b: 1, a: { y: 1, z: 2 } })).toBe(payloadHash({ a: { z: 2, y: 1 }, b: 1 }));
    expect(payloadHash({ x: [1, 2] })).not.toBe(payloadHash({ x: [2, 1] }));
    expect(payloadHash({ a: 1, b: undefined })).toBe(payloadHash({ a: 1 }));
    expect(payloadHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
    expect(payloadHash(undefined)).toBe(payloadHash(null));
  });
});

describe('withIdempotency (D18)', () => {
  it('without a key runs every time and stores nothing', async () => {
    const m = memIdempotency();
    let n = 0;
    const exec = async () => ({ status: 200, body: ++n });
    await withIdempotency(m.deps, ctx, { key: undefined, route: 'r', payload: {} }, exec);
    expect([(await withIdempotency(m.deps, ctx, { key: undefined, route: 'r', payload: {} }, exec)).replayed, n, m.rows.size]).toEqual([false, 2, 0]);
  });
  it('reserves first, settles a 4xx and replays it without running again', async () => {
    const m = memIdempotency();
    let n = 0;
    const exec = async () => ({ status: 409, body: { n: ++n } });
    const first = await withIdempotency(m.deps, ctx, { key: 'k', route: 'r', payload: { a: 1 } }, exec);
    const again = await withIdempotency(m.deps, ctx, { key: 'k', route: 'r', payload: { a: 1 } }, exec);
    expect([first, again, n]).toEqual([{ status: 409, body: { n: 1 }, replayed: false }, { status: 409, body: { n: 1 }, replayed: true }, 1]);
  });
  it('a different payload or another route is idempotency_mismatch and never runs exec', async () => {
    const m = memIdempotency();
    let n = 0;
    const exec = async () => ({ status: 200, body: ++n });
    await withIdempotency(m.deps, ctx, { key: 'k', route: 'r', payload: { a: 1 } }, exec);
    const other = await withIdempotency(m.deps, ctx, { key: 'k', route: 'r', payload: { a: 2 } }, exec);
    const route = await withIdempotency(m.deps, ctx, { key: 'k', route: 'r2', payload: { a: 1 } }, exec);
    expect([other.status, (other.body as { error: { code: string } }).error.code, route.status, n]).toEqual([409, 'idempotency_mismatch', 409, 1]);
  });
  it('a pending receipt is 409 conflict (in progress) and never runs exec', async () => {
    const m = memIdempotency();
    await m.deps.repos.idempotency.store(ctx, { key: 'k', route: 'r', payloadHash: payloadHash({}), response: { status: 0 } });
    let ran = false;
    const r = await withIdempotency(m.deps, ctx, { key: 'k', route: 'r', payload: {} }, async () => { ran = true; return { status: 200, body: null }; });
    expect([r.status, (r.body as { error: { code: string } }).error.code, ran]).toEqual([409, 'conflict', false]);
  });
  it('a 5xx result or a throw releases the key, so the next try runs again', async () => {
    const m = memIdempotency();
    const r5 = await withIdempotency(m.deps, ctx, { key: 'k', route: 'r', payload: {} }, async () => ({ status: 503, body: {} }));
    expect([r5.status, m.rows.size]).toEqual([503, 0]);
    await expect(withIdempotency(m.deps, ctx, { key: 'k', route: 'r', payload: {} }, async () => { throw new TypeError('x'); })).rejects.toThrow(TypeError);
    expect(m.rows.size).toBe(0);
    expect((await withIdempotency(m.deps, ctx, { key: 'k', route: 'r', payload: {} }, async () => ({ status: 200, body: 1 }))).replayed).toBe(false);
  });
});

describe('stepJson (D21)', () => {
  it('has exactly the public keys, ISO dates and no secret', () => {
    const row = { ...fixture, startedAt: new Date(fixture.startedAt), pidStartedAt: null } as unknown as Parameters<typeof stepJson>[0];
    const j = stepJson(row);
    expect(Object.keys(j).sort()).toEqual(['attempt', 'endedAt', 'error', 'failureCount', 'id', 'liveness', 'nodeId', 'output', 'parentStepId', 'promptOutcome', 'resolution', 'retryOfStepId', 'runId', 'stage', 'startedAt', 'status', 'visit']);
    expect([j.startedAt, j.endedAt, j.stage]).toEqual([fixture.startedAt, null, 'spawn']);
    expect(JSON.stringify(j)).not.toMatch(/tokenHash|aaaaaaaa|4242/);
    expect(JSON.parse(JSON.stringify(j))).toEqual(j);
  });
});

describe('route set and source rules (D6, D7, D8, D9)', () => {
  const fake = { runner: {}, idempotency: {} } as unknown as Repositories;
  const sources = (dir: string): [string, string][] =>
    fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'testing.ts').map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
  it('has exactly the four POST routes of D9 and none for approve, continue or run creation', () => {
    const urls = runsRoutes({ repos: fake }).map((r) => `${r.method} ${r.url}`).sort();
    expect(urls).toEqual(['POST /api/runs/:rid/cancel', 'POST /api/runs/:rid/steps/:sid/fail', 'POST /api/runs/:rid/steps/:sid/report', 'POST /api/runs/:rid/steps/:sid/retry']);
  });
  it('never writes a status itself, touches the file system, spawns or imports zod/fastify', () => {
    const all = sources(import.meta.dirname);
    expect(all.filter(([, t]) => /runner\s*\.\s*transition\s*\(|setRunStatus\s*\(|setStepFields\s*\(/.test(t)).map(([f]) => f)).toEqual([]);
    expect(all.filter(([, t]) => /from\s+['"](node:)?(fs|child_process|net|http|https)['"]|from\s+['"](zod|fastify)['"]/.test(t)).map(([f]) => f)).toEqual([]);
    expect(all.some(([, t]) => /judgment:/.test(t))).toBe(true);
  });
  it('junk requests get exactly one reply and never throw', async () => {
    const calls: number[] = [];
    for (const route of runsRoutes({ repos: fake })) {
      for (const req of [undefined, {}, { params: null, headers: null, body: 'junk' }, { params: { rid: '1', sid: '1' }, headers: { 'idempotency-key': 5 }, body: [] }]) {
        let sends = 0;
        await route.handler(req as never, { code: () => ({ send: () => { sends++; } }) });
        calls.push(sends);
      }
    }
    expect(calls.every((n) => n === 1)).toBe(true);
  });
});
