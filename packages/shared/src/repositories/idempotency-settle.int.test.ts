import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scratch, type Scratch } from './scratch.ts';

let s: Scratch;
beforeAll(async () => {
  s = await scratch();
}, 60_000);
afterAll(async () => {
  await s?.drop();
});

const A = { userId: 'u-settle-a' };
const B = { userId: 'u-settle-b' };
const ref = (key: string) => ({ key, route: 'POST /x' });
const pending = (key: string) => s.repos.idempotency.store(A, { ...ref(key), payloadHash: 'h', response: { status: 0 } });

describe('idempotency settle and release (D20a)', () => {
  it('settle replaces a pending response once and never a settled one', async () => {
    await pending('s1');
    expect(await s.repos.idempotency.settle(A, { ...ref('s1'), response: { status: 201, body: { ok: 1 } } })).toBe(true);
    expect(await s.repos.idempotency.settle(A, { ...ref('s1'), response: { status: 500, body: null } })).toBe(false);
    expect((await s.repos.idempotency.lookup(A, ref('s1')))?.response).toEqual({ status: 201, body: { ok: 1 } });
  });
  it('release deletes a pending receipt and keeps a settled one', async () => {
    await pending('r1');
    expect(await s.repos.idempotency.release(A, ref('r1'))).toBe(true);
    expect(await s.repos.idempotency.lookup(A, ref('r1'))).toBeNull();
    await pending('r2');
    await s.repos.idempotency.settle(A, { ...ref('r2'), response: { status: 200, body: 1 } });
    expect(await s.repos.idempotency.release(A, ref('r2'))).toBe(false);
    expect(await s.repos.idempotency.lookup(A, ref('r2'))).not.toBeNull();
  });
  it('another user changes nothing of the caller', async () => {
    await pending('t1');
    expect([await s.repos.idempotency.settle(B, { ...ref('t1'), response: { status: 200 } }), await s.repos.idempotency.release(B, ref('t1'))]).toEqual([false, false]);
    expect((await s.repos.idempotency.lookup(A, ref('t1')))?.response).toEqual({ status: 0 });
  });
});
