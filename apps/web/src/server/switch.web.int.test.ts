import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@ctc/shared/env';
import { createDb, type Db } from '@ctc/shared/repositories';
import { migrate } from '@ctc/shared/repositories/admin';
import { buildApp } from './app.ts';
import { composeWeb, type Web } from './compose.ts';
import { deleteNamespace } from './redis-clean.ts';

const PG = process.env['CTC_SCRATCH_PG_URL'] ?? '';
const REDIS = process.env['CTC_SCRATCH_REDIS_URL'] ?? 'redis://127.0.0.1:18395';
const ROUTES = [
  'POST /v1/hook/prompt', 'POST /v1/hook/pre', 'POST /v1/hook/start', 'POST /v1/suggest', 'POST /v1/spool/nudge', 'GET /v1/health', 'GET /api/capabilities', 'GET /api/capabilities/:id',
  'GET /api/capabilities/:id/versions', 'GET /api/capabilities/:id/versions/:v', 'GET /api/capabilities/:id/versions/:v/diff', 'PATCH /api/capabilities/:id/versions/:v/labels',
  'POST /api/capabilities/:id/restore', 'PUT /api/projects/:pid/capabilities/:id/override', 'DELETE /api/projects/:pid/capabilities/:id/override', 'POST /api/index',
  ...['search', 'explain', 'path', 'affected', 'neighbors', 'stats'].map((x) => `GET /api/graph/${x}`), 'POST /api/graph/build', 'PATCH /api/graph/edges', 'GET /api/memories', 'GET /api/memories/:id',
  'PATCH /api/memories/:id', 'DELETE /api/memories/:id', 'POST /api/memories/import', 'GET /api/sessions/:sid/summary', 'GET /api/history', 'POST /api/history/import', 'GET /api/workflows',
  'GET /api/workflows/:id', 'POST /api/workflows/:id/runs', 'GET /api/runs', 'GET /api/runs/:rid', 'POST /api/runs/:rid/approve', 'POST /api/runs/:rid/continue', 'GET /api/runs/:rid/steps/:sid/log',
  'POST /api/runs/:rid/steps/:sid/retry', 'POST /api/runs/:rid/steps/:sid/fail', 'POST /api/runs/:rid/steps/:sid/report', 'POST /api/runs/:rid/cancel',
].sort();
const TOOLS = [
  'graph_search', 'graph_explain', 'graph_path', 'graph_affected', 'graph_neighbors', 'get_capability', 'load_capability_resource', 'mem_search', 'mem_timeline', 'mem_get', 'save_memory',
  'run_workflow', 'workflow_status',
].sort();

const schema = `ctc_t71_${randomBytes(4).toString('hex')}`;
const namespace = `t71w${randomBytes(4).toString('hex')}:`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t71-'));
let db: Db;
let web: Web;
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  await migrate({ url: PG, schema });
  db = createDb({ url: PG, schema });
  const config = loadConfig({ home, env: { CTC_DATABASE_URL: PG, CTC_REDIS_URL: `${REDIS}/0`, CTC_PORT: '18410' } });
  web = composeWeb({ config, db, namespace, runsDir: path.join(home, 'runs'), log: () => undefined });
}, 60_000);
afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await web?.stop();
  await deleteNamespace(`${REDIS}/0`, namespace);
  await db?.kysely.schema.dropSchema(schema).ifExists().cascade().execute();
  await db?.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const build = async (routes = web.routes) => {
  const built = await buildApp({ routes, tools: web.tools, probes: web.probes });
  apps.push(built.app);
  return built;
};

describe('switch.web', () => {
  it('mounts the expected route table and refuses a duplicate', async () => {
    const { routes } = await build();
    expect(routes).toEqual(ROUTES);
    const first = web.routes[0];
    expect(first).toBeDefined();
    await expect(buildApp({ routes: [...web.routes, first as (typeof web.routes)[number]], tools: web.tools, probes: web.probes })).rejects.toThrow(/duplicate route /);
    expect(web.routes.some((r) => /schedules/.test(r.url))).toBe(false);
  });

  it('answers a bad hook body with an empty 204', async () => {
    const { app } = await build();
    const bodies: (string | Buffer)[] = [
      Buffer.alloc(1_048_577, 0x61), Buffer.from([0, 1, 2, 0x7b, 0xff]), '{"cwd":"/etc","prompt":{"x":1},"userId":"someone-else"}', '[]', 'null', '"str"',
      '{"cwd":5}', `{"cwd":"/${'a'.repeat(5000)}","prompt":"x"}`, '{"cwd":"../relative","tool_name":["Edit"]}', '{"session_id":{"a":1}}',
    ];
    for (const route of ['prompt', 'pre', 'start']) {
      for (const payload of bodies) {
        const res = await app.inject({ method: 'POST', url: `/v1/hook/${route}`, headers: { 'content-type': 'application/json' }, payload });
        expect([route, res.statusCode, res.body]).toEqual([route, 204, '']);
      }
    }
    expect((await app.inject({ method: 'GET', url: '/v1/health' })).json()).toMatchObject({ status: 'ok', db: 'up' });
    const api = await app.inject({ method: 'GET', url: '/api/runs', headers: { 'x-user-id': 'someone-else', authorization: 'Bearer ctc_bogus' } });
    expect(api.statusCode).toBe(200);
  });

  it('lists exactly the 13 MCP tools', async () => {
    const { app } = await build();
    const res = await app.inject({
      method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const tools = res.json().result.tools as { name: string; description: string; inputSchema: { type: string } }[];
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
    expect(tools.every((t) => t.description.length > 0 && t.inputSchema.type === 'object')).toBe(true);
    const bad = await app.inject({
      method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'workflow_status', arguments: { run_id: 12345 } } }),
    });
    expect(bad.json().result?.isError === true || bad.json().error !== undefined).toBe(true);
  });
});
