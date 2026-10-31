import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpTool, Route } from '../library/http.ts';
import { buildApp, routeKey, serverLimits, type AppDeps } from './app.ts';

const saved = { ...serverLimits };
const apps: FastifyInstance[] = [];
afterEach(async () => {
  Object.assign(serverLimits, saved);
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

const probes = { db: async () => true, redis: async () => true };
const echo = (method: Route['method'], url: string): Route => ({
  method, url,
  async handler(req, reply) {
    return reply.code(200).send({ body: req.body ?? null, auth: req.headers?.['authorization'] ?? null });
  },
});
const tools: McpTool[] = [
  { name: 'ok_tool', description: 'returns text', inputSchema: { safeParse: (v: unknown) => v }, call: async () => ({ content: [{ type: 'text', text: 'fine' }] }) },
  { name: 'boom_tool', description: 'throws', inputSchema: { safeParse: (v: unknown) => v }, call: async () => { throw new RangeError('secret detail'); } },
];

async function make(routes: Route[], over: Partial<AppDeps> = {}) {
  const built = await buildApp({ routes, tools, probes, ...over });
  apps.push(built.app);
  return built;
}

describe('buildApp routes (D9)', () => {
  it('lists the mounted METHOD url pairs sorted, health included', async () => {
    const { routes } = await make([echo('POST', '/v1/hook/x'), echo('GET', '/api/a/:id')]);
    expect(routes).toEqual(['GET /api/a/:id', 'GET /v1/health', 'POST /v1/hook/x']);
  });

  it('refuses a duplicate METHOD url and names the pair', async () => {
    await expect(buildApp({ routes: [echo('GET', '/api/a'), echo('GET', '/api/a')], tools, probes })).rejects.toThrow('duplicate route GET /api/a');
    expect(routeKey({ method: 'GET', url: '/v1/health' })).toBe('GET /v1/health');
    await expect(buildApp({ routes: [echo('GET', '/v1/health')], tools, probes })).rejects.toThrow('duplicate route GET /v1/health');
  });

  it('answers an unknown URL with 404 not_found', async () => {
    const { app } = await make([]);
    const res = await app.inject({ method: 'GET', url: '/api/schedules' });
    expect([res.statusCode, res.json()]).toEqual([404, { error: { code: 'not_found', message: 'not found' } }]);
  });
});

describe('health (D8)', () => {
  it('is 200 with the fixed shape and never changes status when a probe is down or slow', async () => {
    serverLimits.probeMs = 30;
    const { app } = await make([], { probes: { db: async () => false, redis: () => new Promise<boolean>(() => undefined) } });
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual(['db', 'mode', 'redis', 'status', 'uptime_s']);
    expect(res.json()).toMatchObject({ status: 'ok', mode: 'local', db: 'down', redis: 'down' });
  });
});

describe('bodies and content types (D10)', () => {
  it('parses a hook body as JSON under any content type, and passes a non-JSON body as no body', async () => {
    const { app } = await make([echo('POST', '/v1/hook/x')]);
    for (const type of ['application/json', 'application/x-www-form-urlencoded', 'text/plain']) {
      const res = await app.inject({ method: 'POST', url: '/v1/hook/x', headers: { 'content-type': type }, payload: '{"a":1}' });
      expect(res.json()).toEqual({ body: { a: 1 }, auth: null });
    }
    const junk = await app.inject({ method: 'POST', url: '/v1/hook/x', headers: { 'content-type': 'application/json' }, payload: '{nope' });
    expect([junk.statusCode, junk.json()]).toEqual([200, { body: null, auth: null }]);
  });

  it('accepts a body of exactly the limit and cuts one byte more (hook: 204; api: 422 invalid)', async () => {
    serverLimits.bodyBytes = 64;
    const { app } = await make([echo('POST', '/v1/hook/x'), echo('POST', '/api/x')]);
    const fit = (n: number): string => JSON.stringify({ p: 'a'.repeat(n - 8) });
    expect(fit(64)).toHaveLength(64);
    const headers = { 'content-type': 'application/json' };
    expect((await app.inject({ method: 'POST', url: '/v1/hook/x', headers, payload: fit(64) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/x', headers, payload: fit(64) })).statusCode).toBe(200);
    const hook = await app.inject({ method: 'POST', url: '/v1/hook/x', headers, payload: fit(65) });
    expect([hook.statusCode, hook.body]).toEqual([204, '']);
    const api = await app.inject({ method: 'POST', url: '/api/x', headers, payload: fit(65) });
    expect(api.statusCode).toBe(422);
    expect(api.json().error.code).toBe('invalid');
  });

  it('answers a bad or non-JSON /api body with 422 invalid', async () => {
    const { app } = await make([echo('POST', '/api/x')]);
    const bad = await app.inject({ method: 'POST', url: '/api/x', headers: { 'content-type': 'application/json' }, payload: '{' });
    expect([bad.statusCode, bad.json()]).toEqual([422, { error: { code: 'invalid', message: 'body is not valid JSON' } }]);
    const text = await app.inject({ method: 'POST', url: '/api/x', headers: { 'content-type': 'text/plain' }, payload: '{}' });
    expect([text.statusCode, text.json().error.code]).toEqual([422, 'invalid']);
  });

  it('drops a __proto__ member from a body', async () => {
    const { app } = await make([echo('POST', '/api/x')]);
    const res = await app.inject({ method: 'POST', url: '/api/x', headers: { 'content-type': 'application/json' }, payload: '{"a":1,"__proto__":{"admin":true}}' });
    expect(res.json().body).toEqual({ a: 1 });
  });
});

describe('failure policy (D11)', () => {
  const thrower: Route = { method: 'POST', url: '/v1/hook/throw', handler: async () => { throw new TypeError('secret'); } };
  const silent: Route = { method: 'POST', url: '/v1/hook/silent', handler: async () => undefined };
  const hang: Route = { method: 'POST', url: '/v1/hook/hang', handler: () => new Promise(() => undefined) };
  const apiThrow: Route = { method: 'GET', url: '/api/throw', handler: async () => { throw new TypeError('secret detail'); } };
  const apiSilent: Route = { method: 'GET', url: '/api/silent', handler: async () => undefined };

  it('turns a throw, a missing reply and a hang on a hook route into an empty 204', async () => {
    serverLimits.hookWatchdogMs = 50;
    const { app } = await make([thrower, silent, hang]);
    for (const name of ['throw', 'silent', 'hang']) {
      const res = await app.inject({ method: 'POST', url: `/v1/hook/${name}`, payload: '{}' , headers: { 'content-type': 'application/json' } });
      expect([name, res.statusCode, res.body]).toEqual([name, 204, '']);
    }
  });

  it('shapes a throw on /api as 500 internal with the class name only', async () => {
    const { app } = await make([apiThrow, apiSilent]);
    const res = await app.inject({ method: 'GET', url: '/api/throw' });
    expect([res.statusCode, res.json()]).toEqual([500, { error: { code: 'internal', message: 'TypeError' } }]);
    expect(res.body).not.toContain('secret');
    expect((await app.inject({ method: 'GET', url: '/api/silent' })).statusCode).toBe(500);
  });

  it('lets the first reply win when a handler keeps running after the watchdog', async () => {
    serverLimits.hookWatchdogMs = 20;
    const late: Route = {
      method: 'POST', url: '/v1/hook/late',
      handler: (_req, reply) => new Promise((resolve) => setTimeout(() => resolve(reply.code(200).send('late')), 80)),
    };
    const { app } = await make([late]);
    const res = await app.inject({ method: 'POST', url: '/v1/hook/late', payload: '{}', headers: { 'content-type': 'application/json' } });
    expect([res.statusCode, res.body]).toEqual([204, '']);
    await new Promise((r) => setTimeout(r, 120));
  });
});

describe('local mode identity (D12)', () => {
  it('ignores an Authorization header: the route still answers and nothing validates the key', async () => {
    const { app } = await make([echo('GET', '/api/me')]);
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: 'Bearer ctc_not_a_key' } });
    expect(res.statusCode).toBe(200);
  });
});

describe('/mcp (D14)', () => {
  const rpc = (app: FastifyInstance, method: string, params: unknown = {}) =>
    app.inject({
      method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });

  it('is stateless: initialize names the server, answers application/json and issues no session id', async () => {
    const { app } = await make([]);
    const res = await rpc(app, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['mcp-session-id']).toBeUndefined();
    expect(res.json().result.serverInfo.name).toBe('claudethecaller');
  });

  it('lists the tools with a description and an object schema', async () => {
    const { app } = await make([]);
    const res = await rpc(app, 'tools/list');
    const list = res.json().result.tools as { name: string; description: string; inputSchema: { type: string } }[];
    expect(list.map((t) => t.name)).toEqual(['ok_tool', 'boom_tool']);
    expect(list.every((t) => t.description.length > 0 && t.inputSchema.type === 'object')).toBe(true);
  });

  it('returns a tool result unchanged, a thrown error as isError with the class name, an unknown tool as -32602', async () => {
    const { app } = await make([]);
    expect((await rpc(app, 'tools/call', { name: 'ok_tool', arguments: {} })).json().result.content[0].text).toBe('fine');
    const boom = (await rpc(app, 'tools/call', { name: 'boom_tool', arguments: {} })).json().result;
    expect([boom.isError, boom.content[0].text]).toEqual([true, 'RangeError']);
    expect((await rpc(app, 'tools/call', { name: 'nope', arguments: {} })).json().error.code).toBe(-32602);
  });

  it('answers GET and DELETE with 405 and a bad body with a JSON-RPC parse error', async () => {
    const { app } = await make([]);
    expect((await app.inject({ method: 'GET', url: '/mcp' })).statusCode).toBe(405);
    expect((await app.inject({ method: 'DELETE', url: '/mcp' })).statusCode).toBe(405);
    const bad = await app.inject({ method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json' }, payload: '{' });
    expect([bad.statusCode, bad.json().error.code]).toEqual([400, -32700]);
  });
});
