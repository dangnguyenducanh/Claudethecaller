import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSystemCtx } from './ctx.ts';
import { RepoError, StoreTimeoutError } from './errors.ts';
import { createDb, createRepositories, limits } from './index.ts';
import { exec, scratch, type Scratch } from './scratch.ts';

let s: Scratch;
const A = { userId: 'user-a' };
const B = { userId: 'user-b' };
const sctx = createSystemCtx('core int test');
const caught = async (p: Promise<unknown>): Promise<{ name: string; code?: string; message: string }> => {
  try {
    await p;
  } catch (error) {
    const e = error as { name: string; code?: string; message: string };
    return { name: e.name, ...(e.code ? { code: e.code } : {}), message: e.message };
  }
  throw new Error('did not reject');
};
const deepFreeze = <T extends object>(o: T): T => {
  Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v as object));
  return Object.freeze(o);
};
const keep = { ...limits };

beforeAll(async () => {
  s = await scratch();
}, 60_000);
afterAll(async () => {
  await s?.drop();
});
afterEach(() => Object.assign(limits, keep));

describe('D14 projects', () => {
  it('D16 the id is the first 8 hex of sha256(root); a second upsert updates profileHash only and a missing hash keeps it', async () => {
    const root = '/p/one';
    const p = await s.repos.projects.upsert(A, { root, profileHash: 'h1' });
    expect(p.id).toBe(createHash('sha256').update(root).digest('hex').slice(0, 8));
    expect(p.userId).toBe('user-a');
    const again = await s.repos.projects.upsert(A, { root, profileHash: 'h2' });
    expect([again.id, again.profileHash, again.createdAt]).toEqual([p.id, 'h2', p.createdAt]);
    expect((await s.repos.projects.upsert(A, { root })).profileHash).toBe('h2');
    expect((await s.repos.projects.byRoot(A, root))?.id).toBe(p.id);
  });
  it('D1 userId and user_id keys in the input are ignored; the stored user is the ctx user', async () => {
    const p = await s.repos.projects.upsert(B, { root: '/p/b-only', userId: 'user-a', user_id: 'user-a' } as never);
    expect(p.userId).toBe('user-b');
    expect(await s.repos.projects.get(A, p.id)).toBeNull();
  });
  it('D1 hostile text is stored verbatim as data', async () => {
    const root = "/p/x'; drop table projects;--";
    const p = await s.repos.projects.upsert(A, { root });
    expect((await s.repos.projects.get(A, p.id))?.root).toBe(root);
    expect((await s.repos.projects.list(A, {})).rows.length).toBeGreaterThan(0);
  });
  it('D14 epochs start at 0 and bumpEpoch is atomic: parallel bumps give distinct consecutive values', async () => {
    const p = await s.repos.projects.upsert(A, { root: '/p/epochs' });
    expect(await s.repos.projects.epochs(A, p.id)).toEqual({ graph: 0, mem: 0 });
    const got = await Promise.all(Array.from({ length: 8 }, () => s.repos.projects.bumpEpoch(A, p.id, 'graph')));
    expect([...(got as number[])].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(await s.repos.projects.epochs(A, p.id)).toEqual({ graph: 8, mem: 0 });
    expect(await s.repos.projects.bumpEpoch(A, 'nope', 'mem')).toBeNull();
    expect((await caught(s.repos.projects.bumpEpoch(A, p.id, 'x; drop' as never))).code).toBe('invalid');
  });
  it('D4 keyset pages never overlap or skip, even when rows share a timestamp', async () => {
    const user = { userId: 'user-page' };
    for (let i = 0; i < 7; i++) await s.repos.projects.upsert(user, { root: `/page/${i}` });
    await exec(s.url, `update "${s.schema}".projects set created_at = '2026-01-01T00:00:00.123456Z' where user_id = 'user-page' and root in ('/page/0','/page/1','/page/2','/page/3')`);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await s.repos.projects.list(user, { limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.rows.map((r) => r.id));
      if (!page.next) break;
      cursor = page.next;
    }
    const all = (await s.repos.projects.list(user, { limit: 500 })).rows.map((r) => r.id);
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(7);
  });
  it('D2 maxPage: equal is valid, one more is clamped; the default page is defaultPage', async () => {
    const user = { userId: 'user-page' };
    limits.maxPage = 3;
    expect((await s.repos.projects.list(user, { limit: 3 })).rows).toHaveLength(3);
    expect((await s.repos.projects.list(user, { limit: 4 })).rows).toHaveLength(3);
    expect((await s.repos.projects.list(user, { limit: 0 })).rows).toHaveLength(1);
    limits.maxPage = 500;
    limits.defaultPage = 2;
    expect((await s.repos.projects.list(user, {})).rows).toHaveLength(2);
  });
  it('D4 a bad cursor is invalid and a missing ctx never sends a query', async () => {
    expect(await caught(s.repos.projects.list(A, { cursor: '!!!' }))).toEqual({ name: 'RepoError', code: 'invalid', message: 'invalid cursor' });
    expect(await caught(s.repos.projects.get(undefined as never, 'x'))).toEqual({ name: 'TypeError', message: 'ctx.userId required' });
  });
  it('D5 an empty page for a new user is {rows: [], next: null}', async () => {
    expect(await s.repos.projects.list({ userId: 'user-new' }, {})).toEqual({ rows: [], next: null });
  });
});

describe('D14 sessions', () => {
  it('merges a later call: fills ended/tokens, never clears a set value with null', async () => {
    const p = await s.repos.projects.upsert(A, { root: '/s/one' });
    const first = await s.repos.sessions.upsert(A, { id: 'sess-1', projectId: p.id, model: 'opus', transcriptPath: '/t.jsonl' });
    expect([first.tokens, first.endedAt, first.model]).toEqual([0, null, 'opus']);
    const later = await s.repos.sessions.upsert(A, { id: 'sess-1', projectId: p.id, endedAt: '2026-01-01T00:00:00Z', tokens: 42, model: null, transcriptPath: null } as never);
    expect([later.tokens, later.endedAt?.toISOString(), later.model, later.transcriptPath]).toEqual([42, '2026-01-01T00:00:00.000Z', 'opus', '/t.jsonl']);
    const again = await s.repos.sessions.upsert(A, { id: 'sess-1', projectId: p.id });
    expect([again.tokens, again.startedAt]).toEqual([42, first.startedAt]);
  });
  it('D3 a project that is missing or not the user\'s is not_found; another user\'s session id is a conflict without data', async () => {
    const mine = await s.repos.projects.upsert(A, { root: '/s/two' });
    const theirs = await s.repos.projects.upsert(B, { root: '/s/b-two' });
    expect(await caught(s.repos.sessions.upsert(A, { id: 'x1', projectId: 'missing' }))).toEqual({ name: 'RepoError', code: 'not_found', message: 'project not found' });
    expect((await caught(s.repos.sessions.upsert(A, { id: 'x2', projectId: theirs.id }))).code).toBe('not_found');
    await s.repos.sessions.upsert(B, { id: 'sess-b-only', projectId: theirs.id, model: 'secret-model' });
    const err = await caught(s.repos.sessions.upsert(A, { id: 'sess-b-only', projectId: mine.id }));
    expect(err).toEqual({ name: 'ConflictError', code: 'conflict', message: 'session id already in use' });
    expect((await s.repos.sessions.get(B, 'sess-b-only'))?.model).toBe('secret-model');
  });
  it('lists by project, newest first', async () => {
    const p = await s.repos.projects.upsert(A, { root: '/s/three' });
    await s.repos.sessions.upsert(A, { id: 'old', projectId: p.id, startedAt: '2020-01-01T00:00:00Z' });
    await s.repos.sessions.upsert(A, { id: 'new', projectId: p.id, startedAt: '2025-01-01T00:00:00Z' });
    expect((await s.repos.sessions.list(A, { projectId: p.id })).rows.map((r) => r.id)).toEqual(['new', 'old']);
  });
});

describe('D14 history, idempotency, apiKeys, dedup', () => {
  it('history: upsert updates, listByStatus is oldest mtime first, setStatus counts', async () => {
    await s.repos.history.upsert(A, { path: '/h/2', size: 1, mtime: 20, status: 'failed' });
    await s.repos.history.upsert(A, { path: '/h/1', size: 1, mtime: 10, status: 'failed' });
    await s.repos.history.upsert(A, { path: '/h/1', size: 5, mtime: 10, status: 'failed' });
    const got = await s.repos.history.listByStatus(A, { status: 'failed' });
    expect(got.map((r) => [r.path, r.size])).toEqual([['/h/1', 5], ['/h/2', 1]]);
    expect(await s.repos.history.setStatus(A, '/h/2', 'skipped')).toBe(1);
    expect(await s.repos.history.setStatus(A, '/h/none', 'skipped')).toBe(0);
  });
  it('idempotency: a key is per user and per route; store never overwrites', async () => {
    expect(await s.repos.idempotency.store(A, { key: 'k1', route: 'POST /a', payloadHash: 'p1', response: { n: 1 } })).toBe(true);
    expect(await s.repos.idempotency.store(A, { key: 'k1', route: 'POST /a', payloadHash: 'p2', response: { n: 2 } })).toBe(false);
    expect(await s.repos.idempotency.lookup(A, { key: 'k1', route: 'POST /a' })).toEqual({ payloadHash: 'p1', response: { n: 1 } });
    expect(await s.repos.idempotency.lookup(A, { key: 'k1', route: 'POST /other' })).toBeNull();
    expect(await s.repos.idempotency.lookup(B, { key: 'k1', route: 'POST /a' })).toBeNull();
    expect(await s.repos.idempotency.store(B, { key: 'k1', route: 'POST /a', payloadHash: 'pb', response: {} })).toBe(true);
  });
  it('apiKeys: list never returns keyHash, revoke counts once', async () => {
    const k = await s.repos.apiKeys.create(A, { name: 'laptop', keyHash: 'hash-1' });
    expect(Object.keys(k).sort()).toEqual(['createdAt', 'id', 'name']);
    const list = await s.repos.apiKeys.list(A);
    expect(JSON.stringify(list)).not.toContain('hash-1');
    expect(list.map((r) => r.name)).toContain('laptop');
    expect(await s.repos.apiKeys.revoke(A, k.id)).toBe(1);
    expect(await s.repos.apiKeys.revoke(A, k.id)).toBe(0);
    expect((await caught(s.repos.apiKeys.create(B, { name: 'dup', keyHash: 'hash-1' }))).code).toBe('conflict');
  });
  it('dedup: pairs are order-free, upsert keeps the status, listOpen hides decided pairs', async () => {
    const row = await s.repos.dedup.upsertPair(A, { pair: ['m2', 'm1'], similarity: 0.9 });
    expect([row.a, row.b]).toEqual(['m1', 'm2']);
    expect((await s.repos.dedup.setStatus(A, ['m1', 'm2'], 'merged'))?.status).toBe('merged');
    const again = await s.repos.dedup.upsertPair(A, { pair: ['m1', 'm2'], similarity: 0.95 });
    expect([again.status, again.similarity]).toEqual(['merged', 0.95]);
    await s.repos.dedup.upsertPair(A, { pair: ['n1', 'n2'], similarity: 0.8 });
    expect((await s.repos.dedup.listOpen(A, {})).rows.map((r) => r.a)).toEqual(['n1']);
    expect(await s.repos.dedup.setStatus(A, ['q1', 'q2'], 'open')).toBeNull();
    expect((await caught(s.repos.dedup.upsertPair(A, { pair: ['only'] as never, similarity: 1 }))).code).toBe('invalid');
    expect((await caught(s.repos.dedup.setStatus(A, ['a', 'b'], 'nope' as never))).code).toBe('invalid');
  });
});

describe('D14 jobs and D13 system jobs', () => {
  it('D16 create uses a uuid id; a repeat of this user\'s id is created:false; another user\'s id is a conflict without data', async () => {
    const one = await s.repos.jobs.create(A, { queue: 'llm', kind: 'enrich', payload: { secret: 'a-only' } });
    expect(one.job.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(one.created).toBe(true);
    const repeat = await s.repos.jobs.create(A, { id: one.job.id, queue: 'llm', kind: 'enrich', payload: {} });
    expect([repeat.created, repeat.job.payload]).toEqual([false, { secret: 'a-only' }]);
    const err = await caught(s.repos.jobs.create(B, { id: one.job.id, queue: 'llm', kind: 'enrich', payload: {} }));
    expect(err).toEqual({ name: 'ConflictError', code: 'conflict', message: 'job id already in use' });
  });
  it('D15 timestamps come from the database clock and are Dates', async () => {
    const { job } = await s.repos.jobs.create(A, { queue: 'graph', kind: 'rebuild', payload: {} });
    expect(job.createdAt).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - job.createdAt.getTime())).toBeLessThan(60_000);
  });
  it('payload keys keep their case (no camelCase rewrite inside jsonb)', async () => {
    const { job } = await s.repos.jobs.create(A, { queue: 'graph', kind: 'rebuild', payload: { snake_key: { Inner_Key: 1 } } });
    expect((await s.repos.jobs.get(A, job.id))?.payload).toEqual({ snake_key: { Inner_Key: 1 } });
  });
  it('cancel: queued and failed become dead with error cancelled; running and unknown give null', async () => {
    const q = (await s.repos.jobs.create(A, { queue: 'llm', kind: 'k', payload: {} })).job;
    const cancelled = await s.repos.jobs.cancel(A, q.id);
    expect([cancelled?.status, cancelled?.error]).toEqual(['dead', 'cancelled']);
    expect(await s.repos.jobs.cancel(A, q.id)).toBeNull();
    const r = (await s.repos.jobs.create(A, { queue: 'llm', kind: 'k', payload: {} })).job;
    await s.repos.system.jobs.markRunning(sctx, r.id);
    expect(await s.repos.jobs.cancel(A, r.id)).toBeNull();
    await s.repos.system.jobs.markFailed(sctx, r.id, 'boom');
    expect((await s.repos.jobs.cancel(A, r.id))?.status).toBe('dead');
  });
  it('list filters by queue and status; oldestQueuedAgeS is null without queued jobs and a number with one', async () => {
    const user = { userId: 'user-jobs' };
    expect(await s.repos.jobs.oldestQueuedAgeS(user)).toBeNull();
    await s.repos.jobs.create(user, { queue: 'graph', kind: 'k', payload: {} });
    await s.repos.jobs.create(user, { queue: 'llm', kind: 'k', payload: {} });
    expect((await s.repos.jobs.list(user, { queue: 'graph' })).rows).toHaveLength(1);
    expect((await s.repos.jobs.list(user, { status: 'done' })).rows).toHaveLength(0);
    expect(typeof (await s.repos.jobs.oldestQueuedAgeS(user))).toBe('number');
  });
  it('D13 markRunning claims queued/failed/running, bumps attempts, refuses done and dead', async () => {
    const id = (await s.repos.jobs.create(A, { queue: 'llm', kind: 'k', payload: {} })).job.id;
    expect(await s.repos.system.jobs.markRunning(sctx, id)).toBe(true);
    expect(await s.repos.system.jobs.markRunning(sctx, id)).toBe(true);
    expect((await s.repos.jobs.get(A, id))?.attempts).toBe(2);
    await s.repos.system.jobs.setProgress(sctx, id, 7);
    expect((await s.repos.jobs.get(A, id))?.progress).toBe(1);
    await s.repos.system.jobs.setProgress(sctx, id, -1);
    expect((await s.repos.jobs.get(A, id))?.progress).toBe(0);
    await s.repos.system.jobs.markDone(sctx, id, { ok: true });
    const done = await s.repos.jobs.get(A, id);
    expect([done?.status, done?.result, done?.progress]).toEqual(['done', { ok: true }, 1]);
    expect(await s.repos.system.jobs.markRunning(sctx, id)).toBe(false);
    await s.repos.system.jobs.markQueued(sctx, id);
    expect((await s.repos.jobs.get(A, id))?.status).toBe('done');
    expect(await s.repos.system.jobs.markRunning(sctx, 'no-such-id')).toBe(false);
    const dead = (await s.repos.jobs.create(A, { queue: 'llm', kind: 'k', payload: {} })).job.id;
    await s.repos.system.jobs.markDead(sctx, dead, 'gave up');
    expect(await s.repos.system.jobs.markRunning(sctx, dead)).toBe(false);
    await s.repos.system.jobs.markDone(sctx, dead);
    expect((await s.repos.jobs.get(A, dead))?.status).toBe('dead');
  });
  it('D13 markFailed then markQueued keeps the error; listQueued is oldest first and clamped', async () => {
    const id = (await s.repos.jobs.create({ userId: 'user-q' }, { queue: 'cleanup', kind: 'k', payload: {} })).job.id;
    await s.repos.system.jobs.markFailed(sctx, id, 'boom');
    await s.repos.system.jobs.markQueued(sctx, id);
    const job = await s.repos.jobs.get({ userId: 'user-q' }, id);
    expect([job?.status, job?.error]).toEqual(['queued', 'boom']);
    const queued = await s.repos.system.jobs.listQueued(sctx, 1_000_000);
    expect(queued.map((j) => j.id)).toContain(id);
    expect(queued.every((j, i) => i === 0 || (queued[i - 1] as { createdAt: Date }).createdAt <= j.createdAt)).toBe(true);
    expect(await s.repos.system.jobs.listQueued(sctx, 0)).toHaveLength(1);
  });
  it('D13 findByHash skips revoked keys; a plain ctx is refused', async () => {
    const k = await s.repos.apiKeys.create(A, { name: 'k', keyHash: 'find-me' });
    expect(await s.repos.system.apiKeys.findByHash(sctx, 'find-me')).toEqual({ id: k.id, userId: 'user-a' });
    await s.repos.apiKeys.revoke(A, k.id);
    expect(await s.repos.system.apiKeys.findByHash(sctx, 'find-me')).toBeNull();
    expect(await caught((s.repos.system.apiKeys.findByHash as (...a: unknown[]) => Promise<unknown>)(A, 'find-me'))).toEqual({ name: 'TypeError', message: 'system ctx required' });
  });
  it('D13 cleanup prunes idempotency keys older than the given days and nothing else', async () => {
    await s.repos.idempotency.store(A, { key: 'old-key', route: 'r', payloadHash: 'h', response: {} });
    await exec(s.url, `update "${s.schema}".idempotency_keys set created_at = now() - interval '31 days' where key = 'old-key'`);
    expect(await s.repos.system.cleanup.pruneIdempotencyKeys(sctx)).toBe(1);
    expect(await s.repos.idempotency.lookup(A, { key: 'k1', route: 'POST /a' })).not.toBeNull();
    expect(await s.repos.system.cleanup.pruneIdempotencyKeys(sctx, 0)).toBeGreaterThan(0);
  });
});

describe('D6 never', () => {
  it('(b) does not edit a deep-frozen input', async () => {
    const input = deepFreeze({ root: '/frozen', profileHash: 'x' });
    await expect(s.repos.projects.upsert(A, input)).resolves.toMatchObject({ root: '/frozen' });
    const job = deepFreeze({ queue: 'llm', kind: 'k', payload: { a: { b: 1 } } });
    await expect(s.repos.jobs.create(A, job)).resolves.toMatchObject({ created: true });
  });
  it('(e) a statement that waits on a lock past the timeout becomes StoreTimeoutError', async () => {
    const slow = await scratchOn(100);
    try {
      const p = await slow.repos.projects.upsert(A, { root: '/lock' });
      let release!: () => void;
      let locked!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const hasLock = new Promise<void>((r) => (locked = r));
      const holder = slow.other.kysely.transaction().execute(async (trx) => {
        await sql`select 1 from projects where user_id = 'user-a' and id = ${p.id} for update`.execute(trx);
        locked();
        await gate;
      });
      await hasLock;
      try {
        const err = await slow.repos.projects.bumpEpoch(A, p.id, 'graph').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(StoreTimeoutError);
        expect(err).toBeInstanceOf(RepoError);
        expect((err as StoreTimeoutError).code).toBe('store_timeout');
      } finally {
        release();
        await holder;
      }
    } finally {
      await slow.close();
    }
  });
  it('(h) db.close() resolves and the pool refuses new work afterwards', async () => {
    const db = createDb({ url: s.url, schema: s.schema, max: 1 });
    const repos = createRepositories(db);
    await repos.projects.get(A, 'x');
    await db.close();
    await expect(repos.projects.get(A, 'x')).rejects.toBeTruthy();
  });
});

describe('D9 createDb', () => {
  it('rejects a statement timeout above the int4 limit', () => {
    expect(() => createDb({ url: s.url, schema: s.schema, statementTimeoutMs: 3e9 })).toThrow(TypeError);
  });

  it('sets search_path and the statement timeout on every connection; the default timeout is limits.statementTimeoutMs', async () => {
    const db = createDb({ url: s.url, schema: s.schema });
    try {
      const r = await sql<{ p: string; t: string }>`select current_setting('search_path') as p, current_setting('statement_timeout') as t`.execute(db.kysely);
      expect(r.rows[0]).toEqual({ p: `${s.schema},extensions,public`, t: '5s' });
      limits.statementTimeoutMs = 1234;
      const other = createDb({ url: s.url, schema: s.schema });
      try {
        expect((await sql<{ t: string }>`select current_setting('statement_timeout') as t`.execute(other.kysely)).rows[0]?.t).toBe('1234ms');
      } finally {
        await other.close();
      }
    } finally {
      await db.close();
    }
  });
  it('(h) never opens more than max connections', async () => {
    const db = createDb({ url: s.url, schema: s.schema, max: 2 });
    try {
      const pids = await Promise.all(Array.from({ length: 6 }, () => sql<{ pid: number }>`select pg_sleep(0.05), pg_backend_pid() as pid`.execute(db.kysely)));
      expect(new Set(pids.map((r) => r.rows[0]?.pid)).size).toBeLessThanOrEqual(2);
    } finally {
      await db.close();
    }
  });
});

describe('D7 non-goals', () => {
  it('has no retry rule, no maxFailures limit and no HTTP codes', () => {
    expect((s.repos.runner as Record<string, unknown>)['retryStep']).toBeUndefined();
    expect((limits as Record<string, unknown>)['maxFailures']).toBeUndefined();
    expect(Object.keys(limits).sort()).toEqual(['defaultPage', 'manyIds', 'maxPage', 'statementTimeoutMs']);
  });
});

async function scratchOn(statementTimeoutMs: number): Promise<{ repos: Scratch['repos']; other: Scratch['db']; close(): Promise<void> }> {
  const db = createDb({ url: s.url, schema: s.schema, statementTimeoutMs });
  return { repos: createRepositories(db), other: s.db, close: () => db.close() };
}
