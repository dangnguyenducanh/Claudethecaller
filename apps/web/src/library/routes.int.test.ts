import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError } from '@ctc/shared/repositories';
import { libraryRoutes } from './index.ts';
import { call, fakeCache, fakeSubmit, mkDeps, mkVersion, newUser, rnd, scratch, sha, skillMd, type Scratch } from './testing.ts';

let s: Scratch;
beforeAll(async () => {
  s = await scratch();
}, 60_000);
afterAll(async () => {
  await s?.drop();
});

describe('route set (D0, D7, D9)', () => {
  it('has exactly the ten routes and no enrich, dedup or graph route', () => {
    const urls = libraryRoutes(mkDeps(s.repos)).map((r) => `${r.method} ${r.url}`);
    expect(urls).toHaveLength(10);
    expect(urls.filter((u) => /enrich|dedup|graph/.test(u))).toEqual([]);
  });
});

describe('trust and errors (D1, D3, D4, D5, D6)', () => {
  it('another user gets 404 and an empty list; a foreign project is 404 and writes nothing', async () => {
    const a = newUser();
    const b = newUser();
    const v = await mkVersion(s.repos, a, 'owned', { 'SKILL.md': 'x' });
    const deps = mkDeps(s.repos);
    expect((await call(deps, 'GET', '/api/capabilities/:id', { params: { id: v.capId }, ctx: b })).status).toBe(404);
    expect((await call(deps, 'GET', '/api/capabilities', { ctx: b })).body.items).toEqual([]);
    const projA = await s.repos.projects.upsert(a, { root: `/t32/${rnd()}` });
    const put = await call(deps, 'PUT', '/api/projects/:pid/capabilities/:id/override', { params: { pid: projA.id, id: v.capId }, body: { action: 'block' }, ctx: b });
    expect(put.status).toBe(404);
    expect(await s.repos.library.listOverrides({ ...a, projectId: projA.id })).toEqual([]);
  });
  it('an unknown body key such as userId is 422 and changes nothing', async () => {
    const a = newUser();
    const v = await mkVersion(s.repos, a, 'strict', { 'SKILL.md': 'x' });
    const r = await call(mkDeps(s.repos), 'PATCH', '/api/capabilities/:id/versions/:v/labels', { params: { id: v.capId, v: '1' }, body: { labels: ['beta'], userId: 'x' }, ctx: a });
    expect([r.status, r.body.error.code, r.body.error.path[0]]).toEqual([422, 'invalid', 'body']);
    expect((await s.repos.library.getVersion(a, v.capId, 1))?.labels).toEqual(['latest', 'production']);
  });
  it('error bodies: 404 shape, 500 carries the class name only, params are checked before the body', async () => {
    const a = newUser();
    const v = await mkVersion(s.repos, a, 'errs', { 'SKILL.md': 'x' });
    const deps = mkDeps(s.repos, { userId: a.userId });
    const nf = await call(deps, 'GET', '/api/capabilities/:id', { params: { id: randomUUID() } });
    expect([nf.status, Object.keys(nf.body.error).sort()]).toEqual([404, ['code', 'message']]);
    expect((await call(deps, 'GET', '/api/capabilities/:id', { params: { id: 'not-a-uuid' } })).status).toBe(404);
    const broken = { ...deps, repos: { ...s.repos, library: { ...s.repos.library, get: async () => { throw new TypeError('secret'); } } } };
    const internal = await call(broken, 'GET', '/api/capabilities/:id', { params: { id: v.capId } });
    expect([internal.status, internal.body]).toEqual([500, { error: { code: 'internal', message: 'TypeError' } }]);
    const order = await call(deps, 'PATCH', '/api/capabilities/:id/versions/:v/labels', { params: { id: v.capId, v: 'x' }, body: { nope: 1 } });
    expect([order.status, order.body.error.path]).toEqual([422, ['params', 'v']]);
    expect((await call(deps, 'GET', '/api/capabilities', { query: { cursor: 'garbage' } })).status).toBe(422);
  });
  it('junk requests always get exactly one reply', async () => {
    const deps = mkDeps(s.repos);
    for (const route of libraryRoutes(deps)) {
      for (const junk of [{ params: null, query: null, body: null }, { params: 'x', query: 5, body: [1] }, { params: { id: {}, v: [], pid: 1 }, query: { limit: {} }, body: 'str' }]) {
        const r = await call(deps, route.method, route.url, junk);
        expect(r.sends).toBe(1);
        expect(r.status).toBeGreaterThanOrEqual(200);
      }
    }
  });
  it('accepts no query, an empty q and a body on POST /api/index; frozen requests are not edited', async () => {
    const a = newUser();
    const v = await mkVersion(s.repos, a, 'tolerant', { 'SKILL.md': 'x' });
    await mkVersion(s.repos, a, 'tolerant', { 'SKILL.md': 'y' });
    const deps = mkDeps(s.repos, { userId: a.userId });
    expect((await call(deps, 'GET', '/api/capabilities', {})).body.items.map((c: { name: string }) => c.name)).toEqual(['tolerant']);
    expect((await call(deps, 'GET', '/api/capabilities', { query: { q: '' } })).status).toBe(200);
    expect((await call(deps, 'POST', '/api/index', { body: { roots: ['/etc'] } })).status).toBe(202);
    const frozen = Object.freeze({ params: Object.freeze({ id: v.capId, v: '2' }), query: Object.freeze({}), body: Object.freeze({ labels: Object.freeze(['production']) }) });
    expect((await call(deps, 'PATCH', '/api/capabilities/:id/versions/:v/labels', frozen)).status).toBe(200);
  });
});

describe('read routes (D2, D15)', () => {
  it('lists with filter and keyset paging; limit 500 is valid and 501 is 422', async () => {
    const a = newUser();
    await mkVersion(s.repos, a, 'r-skill', { 'SKILL.md': 'x' });
    await mkVersion(s.repos, a, 'r-agent', { 'r-agent.md': 'x' }, { kind: 'agent' });
    const deps = mkDeps(s.repos, { userId: a.userId });
    const agents = await call(deps, 'GET', '/api/capabilities', { query: { kind: 'agent' } });
    expect([agents.body.items.map((c: { name: string }) => c.name), agents.body.next]).toEqual([['r-agent'], null]);
    const p1 = await call(deps, 'GET', '/api/capabilities', { query: { limit: '1' } });
    const p2 = await call(deps, 'GET', '/api/capabilities', { query: { limit: '1', cursor: p1.body.next } });
    expect([...p1.body.items, ...p2.body.items].map((c: { name: string }) => c.name).sort()).toEqual(['r-agent', 'r-skill']);
    expect((await call(deps, 'GET', '/api/capabilities', { query: { limit: '500' } })).status).toBe(200);
    const over = await call(deps, 'GET', '/api/capabilities', { query: { limit: '501' } });
    expect([over.status, over.body.error.path]).toEqual([422, ['query', 'limit']]);
  });
  it('returns capability and version JSON, the manifest with the body, and the diff', async () => {
    const a = newUser();
    const s1 = await mkVersion(s.repos, a, 'rd', { 'SKILL.md': skillMd('rd', 'd', 'one\n'), 'a.md': 'a1', 'gone.md': 'g' });
    const s2 = await mkVersion(s.repos, a, 'rd', { 'SKILL.md': skillMd('rd', 'd', 'two\n'), 'a.md': 'a1', 'new.md': 'n' });
    const deps = mkDeps(s.repos, { userId: a.userId });
    const cap = await call(deps, 'GET', '/api/capabilities/:id', { params: { id: s1.capId } });
    expect(Object.keys(cap.body).sort()).toEqual(['enrichment', 'id', 'kind', 'name', 'namespace', 'removedAt', 'rootPath', 'servedVersion']);
    const vs = await call(deps, 'GET', '/api/capabilities/:id/versions', { params: { id: s1.capId } });
    expect(vs.body.items.map((x: { version: number }) => x.version)).toEqual([2, 1]);
    expect(Object.keys(vs.body.items[0]).sort()).toEqual(['bodyHash', 'capId', 'commitMessage', 'createdAt', 'description', 'frontmatter', 'id', 'labels', 'version']);
    expect((await call(deps, 'GET', '/api/capabilities/:id/versions', { params: { id: randomUUID() } })).status).toBe(404);
    const one = await call(deps, 'GET', '/api/capabilities/:id/versions/:v', { params: { id: s1.capId, v: '2' } });
    expect([one.body.id, one.body.body, one.body.files.map((f: { path: string }) => f.path), one.body.files[0].blobHash]).toEqual([s2.id, 'two\n', ['SKILL.md', 'a.md', 'new.md'], sha(skillMd('rd', 'd', 'two\n'))]);
    const diff = await call(deps, 'GET', '/api/capabilities/:id/versions/:v/diff', { params: { id: s1.capId, v: '2' }, query: { against: '1' } });
    expect(diff.body).toEqual({ from: 1, to: 2, added: ['new.md'], removed: ['gone.md'], changed: ['SKILL.md'] });
    expect((await call(deps, 'GET', '/api/capabilities/:id/versions/:v/diff', { params: { id: s1.capId, v: '2' }, query: {} })).body.error.path).toEqual(['query', 'against']);
    expect((await call(deps, 'GET', '/api/capabilities/:id/versions/:v/diff', { params: { id: s1.capId, v: '2' }, query: { against: '7' } })).status).toBe(404);
    for (const bad of ['abc', '0', '-1', '1.5']) expect((await call(deps, 'GET', '/api/capabilities/:id/versions/:v', { params: { id: s1.capId, v: bad } })).body.error.path).toEqual(['params', 'v']);
  });
});

describe('label move (D16)', () => {
  it('moves labels exclusively, submits library.changed and never moves latest', async () => {
    const a = newUser();
    const submit = fakeSubmit();
    const deps = mkDeps(s.repos, { userId: a.userId, submit });
    const v1 = await mkVersion(s.repos, a, 'lm', { 'SKILL.md': 'one' });
    await mkVersion(s.repos, a, 'lm', { 'SKILL.md': 'two' });
    const mv = await call(deps, 'PATCH', '/api/capabilities/:id/versions/:v/labels', { params: { id: v1.capId, v: '2' }, body: { labels: ['production'] } });
    expect([mv.status, mv.body.version, mv.body.labels]).toEqual([200, 2, ['latest', 'production']]);
    expect(submit.calls).toEqual([{ queue: 'library', kind: 'changed', payload: { userId: a.userId, capId: v1.capId, version: 2 } }]);
    const latest = await call(deps, 'PATCH', '/api/capabilities/:id/versions/:v/labels', { params: { id: v1.capId, v: '1' }, body: { labels: ['latest'] } });
    expect([latest.status, latest.body.error.code]).toEqual([422, 'invalid']);
    for (const labels of [['Bad Label'], [], Array.from({ length: 21 }, (_, i) => `l${i}`)]) {
      expect((await call(deps, 'PATCH', '/api/capabilities/:id/versions/:v/labels', { params: { id: v1.capId, v: '1' }, body: { labels } })).status).toBe(422);
    }
    expect((await call(deps, 'PATCH', '/api/capabilities/:id/versions/:v/labels', { params: { id: v1.capId, v: '9' }, body: { labels: ['beta'] } })).status).toBe(404);
    expect((await call(deps, 'PATCH', '/api/capabilities/:id/versions/:v/labels', { params: { id: v1.capId, v: '2' }, body: { labels: Array.from({ length: 20 }, (_, i) => `l${i}`) } })).status).toBe(200);
  });
  it('a submit failure is logged and the reply stays 200', async () => {
    const a = newUser();
    const v = await mkVersion(s.repos, a, 'lm-fail', { 'SKILL.md': 'one' });
    const logs: string[] = [];
    const deps = { ...mkDeps(s.repos, { userId: a.userId, submit: fakeSubmit(new Error('redis gone')) }), log: (m: string) => void logs.push(m) };
    expect((await call(deps, 'PATCH', '/api/capabilities/:id/versions/:v/labels', { params: { id: v.capId, v: '1' }, body: { labels: ['beta'] } })).status).toBe(200);
    expect(logs).toHaveLength(1);
  });
  it('a lock held by someone else (the repo ConflictError) is 409', async () => {
    const a = newUser();
    const v = await mkVersion(s.repos, a, 'lm-lock', { 'SKILL.md': 'one' });
    const locked = async () => { throw new ConflictError('version is being changed'); };
    const deps = { ...mkDeps(s.repos, { userId: a.userId }), repos: { ...s.repos, library: { ...s.repos.library, moveLabels: locked } } };
    const held = await call(deps, 'PATCH', '/api/capabilities/:id/versions/:v/labels', { params: { id: v.capId, v: '1' }, body: { labels: ['beta'] } });
    expect([held.status, held.body.error.code]).toEqual([409, 'conflict']);
  });
});

describe('override routes (D17) and index (D19)', () => {
  it('pin by version or label and block give 200 rows; bad bodies are 422; unknown version or label is 404; DELETE is 204', async () => {
    const a = newUser();
    const cache = fakeCache();
    const deps = mkDeps(s.repos, { userId: a.userId, cache });
    const v = await mkVersion(s.repos, a, 'ov', { 'SKILL.md': 'one' });
    const pid = (await s.repos.projects.upsert(a, { root: `/t32/${rnd()}` })).id;
    const put = (body: unknown) => call(deps, 'PUT', '/api/projects/:pid/capabilities/:id/override', { params: { pid, id: v.capId }, body });
    expect((await put({ action: 'pin', version: 1 })).body).toEqual({ projectId: pid, capId: v.capId, action: 'pin', label: null, version: 1 });
    expect((await put({ action: 'pin', label: 'production' })).body).toEqual({ projectId: pid, capId: v.capId, action: 'pin', label: 'production', version: null });
    expect((await put({ action: 'block' })).body).toEqual({ projectId: pid, capId: v.capId, action: 'block', label: null, version: null });
    for (const body of [{ action: 'pin' }, { action: 'pin', label: 'production', version: 1 }, { action: 'block', label: 'production' }, { action: 'block', version: 1 }, { action: 'nope' }, {}]) {
      expect((await put(body)).status).toBe(422);
    }
    expect([(await put({ action: 'pin', version: 5 })).status, (await put({ action: 'pin', label: 'nolabel' })).status]).toEqual([404, 404]);
    expect((await call(deps, 'PUT', '/api/projects/:pid/capabilities/:id/override', { params: { pid: 'deadbeef', id: v.capId }, body: { action: 'block' } })).status).toBe(404);
    expect(cache.log.some((e) => e[0] === 'pub' && JSON.stringify(e[1]) === JSON.stringify({ v: 1, event: 'ovr.changed', userId: a.userId, projectId: pid }))).toBe(true);
    const del = await call(deps, 'DELETE', '/api/projects/:pid/capabilities/:id/override', { params: { pid, id: v.capId } });
    expect([del.status, del.body]).toEqual([204, undefined]);
    expect(await s.repos.library.listOverrides({ ...a, projectId: pid })).toEqual([]);
    expect((await call(deps, 'DELETE', '/api/projects/:pid/capabilities/:id/override', { params: { pid, id: v.capId } })).status).toBe(204);
  });
  it('works without a cache; POST /api/index submits library.scan for the caller and a submit failure is 500 internal', async () => {
    const a = newUser();
    const v = await mkVersion(s.repos, a, 'ov-nocache', { 'SKILL.md': 'one' });
    const pid = (await s.repos.projects.upsert(a, { root: `/t32/${rnd()}` })).id;
    const submit = fakeSubmit();
    const deps = mkDeps(s.repos, { userId: a.userId, submit });
    expect((await call(deps, 'PUT', '/api/projects/:pid/capabilities/:id/override', { params: { pid, id: v.capId }, body: { action: 'block' } })).status).toBe(200);
    const idx = await call(deps, 'POST', '/api/index', {});
    expect([idx.status, idx.body]).toEqual([202, { job_id: 'job-1' }]);
    expect(submit.calls.map((c) => [c.queue, c.kind, c.payload])).toEqual([['library', 'scan', { userId: a.userId }]]);
    const f = await call(mkDeps(s.repos, { submit: fakeSubmit(new TypeError('boom')) }), 'POST', '/api/index', {});
    expect([f.status, f.body]).toEqual([500, { error: { code: 'internal', message: 'TypeError' } }]);
  });
});
