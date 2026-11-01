import { describe, expect, it } from 'vitest';
import { graphRoutes, graphTools } from './index.ts';
import { CTX, VECTOR_OF_WIDGET, fakeDeps } from './testing.ts';

const toolsOf = (deps: Parameters<typeof graphTools>[0]) => Object.fromEntries(graphTools(deps).map((t) => [t.name, t]));
type Json = { error: { code: string; message: string; nearest: unknown[]; candidates: unknown[]; path: unknown[] } };
const body = (r: { content: { text: string }[] }): Json => JSON.parse(r.content[0]?.text ?? '') as Json;
async function route(deps: Parameters<typeof graphRoutes>[0], method: string, url: string, req: Record<string, unknown>) {
  const rt = graphRoutes(deps).find((r) => r.method === method && r.url === url);
  if (!rt) throw new Error(`no route ${method} ${url}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: { status: number; body: Record<string, any> } = { status: 200, body: {} };
  await rt.handler(req, { code: (n) => ((out.status = n), { send: (b) => ((out.body = b as typeof out.body), b) }) });
  return out;
}

describe('graph tools', () => {
  it('D9 names and order are frozen; D8 an empty search is a normal reply', async () => {
    const { deps } = fakeDeps();
    const tools = graphTools(deps);
    expect(tools.map((t) => t.name)).toEqual(['graph_search', 'graph_explain', 'graph_path', 'graph_affected', 'graph_neighbors']);
    expect(tools.every((t) => t.description.length > 10 && typeof t.inputSchema.safeParse === 'function')).toBe(true);
    expect(graphRoutes(deps).map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET /api/graph/search', 'GET /api/graph/explain', 'GET /api/graph/path', 'GET /api/graph/affected', 'GET /api/graph/neighbors', 'GET /api/graph/stats', 'POST /api/graph/build', 'PATCH /api/graph/edges',
    ]);
    const r = await toolsOf(deps).graph_search!.call(CTX, { query: 'qqqqqq' });
    expect([r.isError, r.content[0].text]).toEqual([undefined, 'no matches']);
  });

  it('D18 the tools answer with the render text, take the project from ctx or cwd, and report each call', async () => {
    const { deps, st } = fakeDeps();
    const t = toolsOf(deps);
    const s = await t.graph_search!.call(CTX, { query: 'widget runner' });
    expect(s.content[0].text.split('\n')[0]).toBe('seed 1.00 T9.1 Build the widget runner [task] specs/x/spec.md:12 (ctx:T9.1)');
    expect(st.calls.at(-1)).toEqual({ userId: 'u1', projectId: 'p1', tool: 'graph_search' });
    const ex = await t.graph_explain!.call(CTX, { name: 'Widget' });
    expect(ex.content[0].text.split('\n').slice(1, 4)).toEqual(['  line8', '  line9', '  line10']);
    const byCwd = await t.graph_neighbors!.call({ userId: 'u1' }, { name: 'Widget', cwd: '/proj/', direction: 'in', limit: 2 });
    expect([byCwd.isError, byCwd.content[0].text.split('\n').length]).toEqual([undefined, 3]);
    const none = await t.graph_neighbors!.call({ userId: 'u1' }, { name: 'Widget', cwd: '/nowhere' });
    expect([none.isError, body(none).error.message, st.calls.at(-1)]).toEqual([true, 'project not found', { userId: 'u1', projectId: null, tool: 'graph_neighbors' }]);
    expect((await t.graph_path!.call(CTX, { from: 'a.ts', to: 'Widget' })).content[0].text.split('\n')).toHaveLength(3);
    expect((await t.graph_path!.call(CTX, { from: 'Widget', to: 'a.ts', max_hops: 1 })).content[0].text).toBe('no path within 1 hops');
    expect((await t.graph_affected!.call(CTX, { name: 'code:b_help', depth: 3 })).content[0].text.split('\n')[0]).toMatch(/affects 3 nodes:$/);
    const amb = await t.graph_affected!.call(CTX, { name: 'helper' });
    expect([amb.isError, body(amb).error.code, body(amb).error.candidates.length]).toEqual([true, 'ambiguous', 2]);
    const thrower = fakeDeps({ deps: { onToolCall: () => { throw new Error('boom'); } } });
    expect((await toolsOf(thrower.deps).graph_search!.call(CTX, { query: 'widget runner' })).isError).toBeUndefined();
  });

  it('D1 an unknown key (userId) is invalid; D4 the error path names the argument', async () => {
    const { deps } = fakeDeps();
    const t = toolsOf(deps);
    expect(body(await t.graph_search!.call(CTX, { query: 'x', userId: 'evil' })).error.code).toBe('invalid');
    expect(body(await t.graph_search!.call(CTX, { query: 'x', limit: 0 })).error).toMatchObject({ code: 'invalid', path: ['args', 'limit'] });
    const nf = body(await t.graph_explain!.call(CTX, { name: 'zzzz' }));
    expect([nf.error.code, nf.error.message, Array.isArray(nf.error.nearest)]).toEqual(['not_found', "no node matching 'zzzz'", true]);
  });

  it('D18 the embedder is optional: a failure, a wrong length or a missing embedder drops only the dense channel', async () => {
    const lexical = (await toolsOf(fakeDeps({ deps: { embed: async () => { throw new Error('tei down'); } } }).deps).graph_search!.call(CTX, { query: 'widget runner' })).content[0].text;
    expect(lexical.startsWith('seed 1.00 T9.1')).toBe(true);
    expect((await toolsOf(fakeDeps({ deps: { embed: async () => [[1, 2, 3]] } }).deps).graph_search!.call(CTX, { query: 'zzzz' })).content[0].text).toBe('no matches');
    const dense = await toolsOf(fakeDeps({ deps: { embed: async () => [VECTOR_OF_WIDGET] } }).deps).graph_search!.call(CTX, { query: 'zzzz' });
    expect(dense.content[0].text.split('\n')[0]).toMatch(/^seed 1\.00 Widget \[class\]/);
  });

  it('D21 config values reach core; a missing section throws a TypeError when the tools or routes are built', async () => {
    const lines = (await toolsOf(fakeDeps({ query: { budget_tokens: 30 } }).deps).graph_search!.call(CTX, { query: 'widget runner' })).content[0].text.split('\n');
    expect(lines.at(-1)).toMatch(/^\[truncated: \d+ more\]$/);
    const one = await route(fakeDeps({ query: { seeds: 1 } }).deps, 'GET', '/api/graph/search', { query: { project_id: 'p1', query: 'widget runner' } });
    expect(one.body.hits.filter((h: { hop: number }) => h.hop === 0)).toHaveLength(1);
    const shallow = await route(fakeDeps({ query: { depth: 1 } }).deps, 'GET', '/api/graph/search', { query: { project_id: 'p1', query: 'widget runner' } });
    expect(Math.max(...shallow.body.hits.map((h: { hop: number }) => h.hop))).toBeLessThanOrEqual(1);
    expect(() => graphTools({ ...fakeDeps().deps, config: {} } as never)).toThrow(TypeError);
    expect(() => graphRoutes({ ...fakeDeps().deps, config: { graph: {} } } as never)).toThrow(TypeError);
  });
});

describe('graph routes', () => {
  it('D19 queries reply with JSON, coerce text arguments, and answer 404 for another user and 422 for a bad value', async () => {
    const { deps } = fakeDeps();
    const s = await route(deps, 'GET', '/api/graph/search', { query: { project_id: 'p1', query: 'widget runner', limit: '4' } });
    expect([s.status, s.body.hits.length]).toEqual([200, 4]);
    const e = await route(deps, 'GET', '/api/graph/explain', { query: { project_id: 'p1', name: 'Widget' } });
    expect([e.status, e.body.node.id, e.body.excerpt.split('\n')[0]]).toEqual([200, 'code:b_W', 'line8']);
    const p = await route(deps, 'GET', '/api/graph/path', { query: { project_id: 'p1', from: 'Widget', to: 'a.ts', directed: 'false' } });
    expect([p.body.found, p.body.hops.length]).toEqual([true, 2]);
    expect((await route(deps, 'GET', '/api/graph/affected', { query: { project_id: 'p1', name: 'code:b_help', depth: '3' } })).body.total).toBe(3);
    expect((await route(deps, 'GET', '/api/graph/neighbors', { query: { project_id: 'p1', name: 'Widget', direction: 'in', relation: 'contains' } })).body.total).toBe(1);
    const amb = await route(deps, 'GET', '/api/graph/explain', { query: { project_id: 'p1', name: 'helper' } });
    expect([amb.status, Object.keys(amb.body.error).sort()]).toEqual([409, ['candidates', 'code', 'message']]);
    expect((await route(deps, 'GET', '/api/graph/explain', { query: { project_id: 'p1', name: 'zzzz' } })).status).toBe(404);
    const other = await route(deps, 'GET', '/api/graph/search', { query: { project_id: 'p1', query: 'x' }, ctx: { userId: 'u2' } });
    expect([other.status, other.body.error.code]).toEqual([404, 'not_found']);
    const bad = await route(deps, 'GET', '/api/graph/search', { query: { project_id: 'p1', query: 'x', limit: '51' } });
    expect([bad.status, bad.body.error.path]).toEqual([422, ['query', 'limit']]);
    expect((await route(deps, 'GET', '/api/graph/search', { query: { project_id: 'p1', query: 'x', cwd: '/tmp' } })).status).toBe(422);
  });

  it('D19 stats map the repository row; guardTrips comes from the hook', async () => {
    const plain = await route(fakeDeps().deps, 'GET', '/api/graph/stats', { query: { project_id: 'p1' } });
    expect(plain.body).toEqual({ nodesByType: { file: 3 }, edgesByRelation: { calls: 2 }, lastBuild: '2026-01-02T03:04:05.000Z', guardTrips: 0 });
    const g7 = await route(fakeDeps({ deps: { guardTrips: async () => 7 } }).deps, 'GET', '/api/graph/stats', { query: { project_id: 'p1' } });
    expect(g7.body.guardTrips).toBe(7);
  });

  it('D19 build submits the graph.rebuild job and answers 202; edge review writes, rotates the epoch and invalidates the store', async () => {
    const { deps, st } = fakeDeps();
    const b = await route(deps, 'POST', '/api/graph/build', { body: { project_id: 'p1', force: true } });
    expect([b.status, b.body, st.submits.at(-1)]).toEqual([202, { job_id: 'job-1' }, { queue: 'graph', kind: 'rebuild', payload: { userId: 'u1', projectId: 'p1', force: true } }]);
    await route(deps, 'POST', '/api/graph/build', { body: { project_id: 'p1' } });
    expect((st.submits.at(-1) as { payload: object }).payload).toEqual({ userId: 'u1', projectId: 'p1' });
    expect((await route(deps, 'POST', '/api/graph/build', { body: { project_id: 'p2' } })).status).toBe(404);
    await route(deps, 'GET', '/api/graph/stats', { query: { project_id: 'p1' } });
    await route(deps, 'GET', '/api/graph/explain', { query: { project_id: 'p1', name: 'Widget' } });
    expect(st.loads).toBe(1);
    const ed = await route(deps, 'PATCH', '/api/graph/edges', { body: { project_id: 'p1', src: 'code:a', dst: 'code:b', relation: 'imports', confidence: 'DROPPED' } });
    expect([ed.status, ed.body.origin, st.rotates.at(-1)]).toEqual([200, 'review', ['graph', 'u1', 'p1']]);
    await route(deps, 'GET', '/api/graph/explain', { query: { project_id: 'p1', name: 'Widget' } });
    expect(st.loads).toBe(2);
    expect((await route(deps, 'PATCH', '/api/graph/edges', { body: { project_id: 'p1', src: 'a', dst: 'b', relation: 'calls', confidence: 'EXTRACTED' } })).status).toBe(422);
    expect((await route(fakeDeps({ review: null }).deps, 'PATCH', '/api/graph/edges', { body: { project_id: 'p1', src: 'x', dst: 'y', relation: 'calls', confidence: 'CONFIRMED' } })).status).toBe(404);
    const redisDown = fakeDeps({ deps: { cache: { epoch: { get: async () => 'e', rotate: async () => { throw new Error('redis down'); } } } } });
    expect((await route(redisDown.deps, 'PATCH', '/api/graph/edges', { body: { project_id: 'p1', src: 'a', dst: 'b', relation: 'calls', confidence: 'CONFIRMED' } })).status).toBe(200);
  });

  it('D6 reads write nothing', async () => {
    const { deps, st } = fakeDeps();
    for (const [url, q] of [['search', { query: 'x' }], ['explain', { name: 'Widget' }], ['path', { from: 'a.ts', to: 'Widget' }], ['affected', { name: 'Widget' }], ['neighbors', { name: 'Widget' }], ['stats', {}]] as const) {
      expect((await route(deps, 'GET', `/api/graph/${url}`, { query: { project_id: 'p1', ...q } })).status).toBe(200);
    }
    expect([st.submits.length, st.reviews.length, st.rotates.length]).toEqual([0, 0, 0]);
  });
});
