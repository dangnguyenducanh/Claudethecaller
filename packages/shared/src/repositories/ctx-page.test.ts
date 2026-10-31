import { describe, expect, it, afterEach } from 'vitest';
import { createSystemCtx, isSystemCtx, isUuid, needProject, requireUser } from './ctx.ts';
import { createDb, jsonb, setList, vec } from './db.ts';
import { ConflictError, RepoError, StoreTimeoutError } from './errors.ts';
import { clampLimit, limits } from './limits.ts';
import { decodeCursor, encodeCursor } from './page.ts';

const message = (fn: () => unknown): { name: string; message: string; code?: string } => {
  try {
    fn();
  } catch (error) {
    const e = error as { name: string; message: string; code?: string };
    return { name: e.name, message: e.message, ...(e.code ? { code: e.code } : {}) };
  }
  throw new Error('did not throw');
};

describe('D4 ctx', () => {
  it.each([undefined, null, {}, { userId: '' }, { userId: '  \t' }, { userId: 7 }])('refuses %j with ctx.userId required', (ctx) => {
    expect(message(() => requireUser(ctx))).toEqual({ name: 'TypeError', message: 'ctx.userId required' });
  });
  it('accepts a non-blank userId and ignores projectId there', () => {
    expect(() => requireUser({ userId: 'u' })).not.toThrow();
  });
  it('needProject returns the id or throws ctx.projectId required', () => {
    expect(needProject({ userId: 'u', projectId: 'p' })).toBe('p');
    expect(message(() => needProject({ userId: 'u' }))).toEqual({ name: 'TypeError', message: 'ctx.projectId required' });
    expect(message(() => needProject({ userId: 'u', projectId: ' ' }))).toEqual({ name: 'TypeError', message: 'ctx.projectId required' });
  });
});

describe('D13 SystemCtx', () => {
  it('needs a non-empty reason and is recognised only when issued by createSystemCtx', () => {
    expect(message(() => createSystemCtx(''))).toEqual({ name: 'TypeError', message: 'reason required' });
    expect(message(() => createSystemCtx('   '))).toEqual({ name: 'TypeError', message: 'reason required' });
    const sctx = createSystemCtx('worker poll');
    expect(isSystemCtx(sctx)).toBe(true);
    expect(isSystemCtx({ reason: 'worker poll' })).toBe(false);
    expect(isSystemCtx({ userId: 'u' })).toBe(false);
    expect(Object.isFrozen(sctx)).toBe(true);
  });
});

describe('D3 errors', () => {
  it('carry a code and share the RepoError base', () => {
    const c = new ConflictError('x');
    const t = new StoreTimeoutError();
    const i = new RepoError('invalid', 'bad', 'why');
    expect([c.code, t.code, i.code, i.detail]).toEqual(['conflict', 'store_timeout', 'invalid', 'why']);
    expect([c instanceof RepoError, t instanceof RepoError, c instanceof Error]).toEqual([true, true, true]);
    expect([c.name, t.name]).toEqual(['ConflictError', 'StoreTimeoutError']);
  });
});

describe('D2 limits', () => {
  const keep = { ...limits };
  afterEach(() => Object.assign(limits, keep));
  it('pins the defaults', () => {
    expect({ ...limits }).toEqual({ maxPage: 500, defaultPage: 50, statementTimeoutMs: 5000, manyIds: 20 });
  });
  it('clamps a limit into 1..maxPage: equal is valid, one more is clamped, below 1 is 1', () => {
    expect([clampLimit(500), clampLimit(501), clampLimit(0), clampLimit(-3), clampLimit(1)]).toEqual([500, 500, 1, 1, 1]);
    limits.maxPage = 3;
    expect([clampLimit(3), clampLimit(4)]).toEqual([3, 3]);
  });
  it('uses defaultPage for a missing or non-numeric limit, and reads it at call time', () => {
    expect([clampLimit(undefined), clampLimit('9'), clampLimit(Number.NaN)]).toEqual([50, 50, 50]);
    limits.defaultPage = 7;
    expect(clampLimit(undefined)).toBe(7);
  });
  it('truncates a fractional limit', () => {
    expect(clampLimit(2.9)).toBe(2);
  });
});

describe('D4 cursor', () => {
  it('round-trips a pair', () => {
    expect(decodeCursor(encodeCursor('2026-01-02T03:04:05.123456Z', 'id-1'))).toEqual({ t: '2026-01-02T03:04:05.123456Z', id: 'id-1' });
  });
  it.each(['', '!!!not-a-cursor', Buffer.from('{"t":1,"id":"x"}').toString('base64url'), Buffer.from('{"t":"yesterday","id":"x"}').toString('base64url'), Buffer.from('[]').toString('base64url')])(
    'rejects %j as invalid',
    (cursor) => {
      expect(message(() => decodeCursor(cursor))).toEqual({ name: 'RepoError', message: 'invalid cursor', code: 'invalid' });
    },
  );
});

describe('D1 untrusted input never reaches SQL as an identifier', () => {
  it('setList only emits the columns of the fixed map and drops unknown keys', () => {
    const parts = setList({ branch: 'x', userId: 'user-a', user_id: 'user-a', 'status; drop table x': 1 }, { branch: { col: 'branch' }, error: { col: 'error' } });
    expect(parts).toHaveLength(1);
  });
  it('an empty patch gives no assignments', () => {
    expect(setList({}, { branch: { col: 'branch' } })).toEqual([]);
    expect(setList(undefined, { branch: { col: 'branch' } })).toEqual([]);
  });
  it('vec refuses anything but 1024 finite numbers', () => {
    expect(message(() => vec([1, 2]))).toEqual({ name: 'RepoError', message: 'embedding must be 1024 finite numbers', code: 'invalid' });
    expect(() => vec(Array.from({ length: 1024 }, () => 0.5))).not.toThrow();
    expect(() => vec(Array.from({ length: 1024 }, () => Number.NaN))).toThrow();
    expect(() => vec('[0]')).toThrow();
  });
  it('jsonb accepts undefined', () => {
    expect(() => jsonb(undefined)).not.toThrow();
  });
});

describe('D9 createDb arguments', () => {
  it.each(['bad;drop schema x', 'Upper', '1abc', '', 'a'.repeat(42), 'a-b'])('refuses schema %j with a TypeError', (schema) => {
    expect(message(() => createDb({ url: 'postgres://u@127.0.0.1:1/x', schema })).name).toBe('TypeError');
  });
  it('accepts a 41-character schema (the limit is inclusive) and closes without ever connecting', async () => {
    const db = createDb({ url: 'postgres://u@127.0.0.1:1/x', schema: `a${'b'.repeat(40)}` });
    await db.close();
  });
  it('refuses a negative statement timeout', () => {
    expect(message(() => createDb({ url: 'postgres://u@127.0.0.1:1/x', statementTimeoutMs: -1 })).name).toBe('TypeError');
  });
});

describe('D4 uuid ids', () => {
  it('isUuid only accepts uuids', () => {
    expect([isUuid('0b9f6e8e-6a1e-4d6f-8a47-0f3c9b6a9d11'), isUuid('x'), isUuid(7), isUuid("1'; drop table x;--")]).toEqual([true, false, false, false]);
  });
});
