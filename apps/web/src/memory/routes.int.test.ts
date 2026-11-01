import { randomUUID } from 'node:crypto';
import { memoryApiLimits } from '@ctc/shared/schemas/memory';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, fakeCache, fakeSubmit, mkDeps, rnd, scratch, vecOf, type Scratch } from './testing.ts';

let s: Scratch;
beforeAll(async () => {
  s = await scratch();
}, 60_000);
afterAll(async () => {
  await s?.drop();
});

async function seed() {
  const user = { userId: `u-api-${rnd()}` };
  const project = await s.repos.projects.upsert(user, { root: `/work/api-${rnd()}` });
  const ctx = { ...user, projectId: project.id };
  const add = (text: string, scope: 'global' | 'project' = 'project', kind = 'fact') => s.repos.memory.add(ctx, { scope, kind, text, embedding: vecOf(text) });
  return { user, project, ctx, add };
}

describe('GET /api/memories', () => {
  it('pages with a cursor, filters, hides deleted rows and never shows userId or the vector', async () => {
    const x = await seed();
    for (let i = 0; i < 3; i++) await x.add(`list item ${i}`);
    await x.add('list global', 'global', 'preference');
    const gone = await x.add('list deleted');
    await s.repos.memory.softDelete(x.ctx, gone.id);
    const deps = mkDeps(s.repos);
    const p1 = await api(deps, 'GET', '/api/memories', { query: { limit: '2' }, ctx: x.ctx });
    expect([p1.status, p1.body.items.length, typeof p1.body.next]).toEqual([200, 2, 'string']);
    const p2 = await api(deps, 'GET', '/api/memories', { query: { limit: '2', cursor: p1.body.next }, ctx: x.ctx });
    expect(p1.body.items.length + p2.body.items.length).toBe(4);
    expect(p2.body.next).toBeNull();
    expect(Object.keys(p1.body.items[0])).not.toContain('userId');
    expect(Object.keys(p1.body.items[0])).not.toContain('embedding');
    expect((await api(deps, 'GET', '/api/memories', { query: { kind: 'preference' }, ctx: x.ctx })).body.items).toHaveLength(1);
    expect((await api(deps, 'GET', '/api/memories', { query: { q: 'ITEM 1' }, ctx: x.ctx })).body.items).toHaveLength(1);
  });

  it('answers 422 with a path for bad query values', async () => {
    const x = await seed();
    const deps = mkDeps(s.repos);
    for (const query of [{ limit: '0' }, { limit: String(memoryApiLimits.listMax + 1) }, { kind: 'x' }, { q: 'q'.repeat(memoryApiLimits.qMax + 1) }, { cursor: 'not-a-cursor' }]) {
      const r = await api(deps, 'GET', '/api/memories', { query, ctx: x.ctx });
      expect([r.status, r.body.error.code, r.body.error.path[0]]).toEqual([422, 'invalid', 'query']);
    }
  });
});

describe('GET/PATCH/DELETE /api/memories/:id', () => {
  it('reads one row; a foreign, deleted, unknown or non-uuid id is 404, never 422', async () => {
    const x = await seed();
    const m = await x.add('single');
    const deps = mkDeps(s.repos);
    expect((await api(deps, 'GET', '/api/memories/:id', { params: { id: m.id }, ctx: x.ctx })).body.text).toBe('single');
    for (const [id, ctx] of [[m.id, { userId: 'other' }], [randomUUID(), x.ctx], ['not-a-uuid', x.ctx]] as const) {
      expect((await api(deps, 'GET', '/api/memories/:id', { params: { id }, ctx })).status).toBe(404);
    }
    await api(deps, 'DELETE', '/api/memories/:id', { params: { id: m.id }, ctx: x.ctx });
    expect((await api(deps, 'GET', '/api/memories/:id', { params: { id: m.id }, ctx: x.ctx })).status).toBe(404);
  });

  it('patches pinned and kind; patched text is sanitized, re-embedded and keeps a vector; a duplicate text is 409; empty is 422', async () => {
    const x = await seed();
    const cache = fakeCache();
    const deps = mkDeps(s.repos, { cache });
    const m = await x.add('before edit');
    await x.add('already here');
    const p = await api(deps, 'PATCH', '/api/memories/:id', { params: { id: m.id }, body: { pinned: true, kind: 'convention' }, ctx: x.ctx });
    expect([p.status, p.body.pinned, p.body.kind]).toEqual([200, true, 'convention']);
    const t = await api(deps, 'PATCH', '/api/memories/:id', { params: { id: m.id }, body: { text: 'after <system-reminder>x</system-reminder>edit' }, ctx: x.ctx });
    expect([t.status, t.body.text]).toEqual([200, 'after edit']);
    const near = await s.repos.memory.nearest(x.ctx, { scope: 'project', embedding: vecOf('after edit'), limit: 1 });
    expect([near[0]?.memory.id, near[0]?.similarity]).toEqual([m.id, expect.closeTo(1, 5)]);
    expect(cache.rotates).toContainEqual(['mem', x.user.userId, x.project.id]);
    expect((await api(deps, 'PATCH', '/api/memories/:id', { params: { id: m.id }, body: { text: 'already here' }, ctx: x.ctx })).status).toBe(409);
    for (const body of [{}, { text: '' }, { text: '<system-reminder>only</system-reminder>' }, { kind: 'x' }, { text: 'y'.repeat(memoryApiLimits.textMax + 1) }, { unknown: 1 }]) {
      expect((await api(deps, 'PATCH', '/api/memories/:id', { params: { id: m.id }, body, ctx: x.ctx })).status).toBe(422);
    }
    expect((await api(deps, 'PATCH', '/api/memories/:id', { params: { id: randomUUID() }, body: { pinned: true }, ctx: x.ctx })).status).toBe(404);
  });

  it('deleting or editing a global memory rotates the user-level memory epoch, so cached start blocks of every project drop it', async () => {
    const x = await seed();
    const cache = fakeCache();
    const deps = mkDeps(s.repos, { cache });
    const g = await x.add('api key is hunter2', 'global');
    expect((await api(deps, 'DELETE', '/api/memories/:id', { params: { id: g.id }, ctx: x.ctx })).status).toBe(204);
    expect(cache.rotates).toContainEqual(['mem', x.user.userId, '*']);
    cache.rotates.length = 0;
    const g2 = await x.add('another global', 'global');
    await api(deps, 'PATCH', '/api/memories/:id', { params: { id: g2.id }, body: { pinned: true }, ctx: x.ctx });
    expect(cache.rotates).toContainEqual(['mem', x.user.userId, '*']);
  });

  it('keeps the patched text without a vector when the embedder fails', async () => {
    const x = await seed();
    const m = await x.add('embed fails');
    const embed = (async () => {
      throw new Error('down');
    }) as never;
    const r = await api(mkDeps(s.repos, { embed }), 'PATCH', '/api/memories/:id', { params: { id: m.id }, body: { text: 'new text without vector' }, ctx: x.ctx });
    expect([r.status, r.body.text]).toEqual([200, 'new text without vector']);
  });

  it('soft-deletes: 204, the row stays in the table, a second delete is 404, another user cannot delete it', async () => {
    const x = await seed();
    const m = await x.add('to delete');
    const deps = mkDeps(s.repos);
    expect((await api(deps, 'DELETE', '/api/memories/:id', { params: { id: m.id }, ctx: { userId: 'other' } })).status).toBe(404);
    expect((await api(deps, 'DELETE', '/api/memories/:id', { params: { id: m.id }, ctx: x.ctx })).status).toBe(204);
    expect((await s.repos.memory.get(x.ctx, m.id))?.deletedAt).not.toBeNull();
    expect((await api(deps, 'DELETE', '/api/memories/:id', { params: { id: m.id }, ctx: x.ctx })).status).toBe(404);
  });
});

describe('import, summary and history routes', () => {
  it('submits memory.import and memory.distill with the caller as userId (never from the body)', async () => {
    const submit = fakeSubmit();
    const deps = mkDeps(s.repos, { submit });
    const a = await api(deps, 'POST', '/api/memories/import', { body: { userId: 'evil' }, ctx: { userId: 'u1' } });
    const b = await api(deps, 'POST', '/api/history/import', { body: { limit: 5 }, ctx: { userId: 'u1' } });
    const c = await api(deps, 'POST', '/api/history/import', { ctx: { userId: 'u1' } });
    expect([a.status, a.body, b.status, c.status]).toEqual([202, { job_id: 'job-1' }, 202, 202]);
    expect(submit.calls).toEqual([
      { queue: 'memory', kind: 'import', payload: { userId: 'u1' } },
      { queue: 'memory', kind: 'distill', payload: { userId: 'u1', limit: 5 } },
      { queue: 'memory', kind: 'distill', payload: { userId: 'u1' } },
    ]);
    expect((await api(deps, 'POST', '/api/history/import', { body: { limit: memoryApiLimits.distillMax + 1 }, ctx: { userId: 'u1' } })).status).toBe(422);
  });

  it('reads a session summary of the caller only', async () => {
    const x = await seed();
    const sid = `s-${rnd()}`;
    await s.repos.sessions.upsert(x.user, { id: sid, projectId: x.project.id, transcriptPath: `/t/${sid}.jsonl` });
    await s.repos.memory.insertSummary(x.ctx, { sessionId: sid, contentHash: sid, request: 'asked', learned: 'known' });
    const deps = mkDeps(s.repos);
    const r = await api(deps, 'GET', '/api/sessions/:sid/summary', { params: { sid }, ctx: x.ctx });
    expect([r.status, r.body.request, r.body.learned, r.body.projectId]).toEqual([200, 'asked', 'known', x.project.id]);
    expect((await api(deps, 'GET', '/api/sessions/:sid/summary', { params: { sid }, ctx: { userId: 'other' } })).status).toBe(404);
    expect((await api(deps, 'GET', '/api/sessions/:sid/summary', { params: { sid: 'none' }, ctx: x.ctx })).status).toBe(404);
  });

  it('lists history rows by status (default imported)', async () => {
    const x = await seed();
    await s.repos.history.upsert(x.user, { path: '/h/a.jsonl', size: 1, mtime: 2, status: 'imported' });
    await s.repos.history.upsert(x.user, { path: '/h/b.jsonl', size: 1, mtime: 3, status: 'skipped' });
    const deps = mkDeps(s.repos);
    expect((await api(deps, 'GET', '/api/history', { ctx: x.user })).body.items).toEqual([{ path: '/h/a.jsonl', size: 1, mtime: 2, status: 'imported' }]);
    expect((await api(deps, 'GET', '/api/history', { query: { status: 'skipped' }, ctx: x.user })).body.items).toHaveLength(1);
    expect((await api(deps, 'GET', '/api/history', { query: { status: 'weird' }, ctx: x.user })).status).toBe(422);
  });
});
