/**
 * The Fastify composition of `ctc-web`: mounts the `Route` objects of the earlier tasks, `GET /v1/health` and `/mcp`, and decides what a bad body,
 * a throw or a hang looks like on the wire. The app is returned ready but not listening (./listen.ts binds it).
 * Called from: ./main.ts, ./switch.web.int.test.ts and ./app.test.ts. Why it exists: the factories return plain `{method, url, handler}` objects (no
 * Fastify in their tests); something has to give them a request/reply, bodies, limits and one error policy (spec:144-166).
 * Deliberately NOT done: business logic, auth (every request is `userId` `local`; an `Authorization` header is never read), rate limits, CORS, static files,
 * any route outside the given set (so `/api/schedules*` answers 404), request logging (bodies are never logged).
 * Untrusted: every URL, param, query, header and body byte.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { McpTool, Route } from '../library/http.ts';
import { createMcpHandler } from './mcp.ts';

/**
 * Read at call time (the body limit when the app is built). `bodyBytes` 1,048,576 is spec:213; the 2 s hook watchdog, the 300 ms health probe and the 3 s
 * drain of a refused body are chosen by judgment (the handlers keep their own 40, 140 and 1,200 ms budgets; the watchdog is the net under them).
 */
export const serverLimits = { bodyBytes: 1_048_576, hookWatchdogMs: 2000, probeMs: 300, drainMs: 3000 };

export type AppDeps = {
  routes: readonly Route[];
  tools: readonly McpTool[];
  probes: { db(): Promise<boolean>; redis(): Promise<boolean> };
  startedAt?: number;
  /** Project id of an absolute root, for the `x-ctc-cwd` header of `/mcp`. */
  mcpProject?(root: string): Promise<string | undefined>;
  log?: (message: string, fields?: Record<string, unknown>) => void;
};

export const routeKey = (r: { method: string; url: string }): string => `${r.method} ${r.url}`;

const errClass = (e: unknown): string => (e instanceof Error ? e.constructor.name : typeof e);

/** A body the server refuses: wrong content type on `/api` or not JSON. Becomes `422 invalid` on `/api`, a JSON-RPC parse error on `/mcp`, a `204` on a hook. */
class BodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BodyError';
  }
}

const pathOf = (url: string): string => url.split('?', 1)[0] ?? url;
/** Hook-style routes: `/v1/*` except the health probe and `/v1/suggest` (a debug and eval endpoint that answers JSON). They answer an empty `204` to anything that goes wrong (spec:164). */
const isHookPath = (url: string): boolean => pathOf(url).startsWith('/v1/') && pathOf(url) !== '/v1/health' && pathOf(url) !== '/v1/suggest';
const isMcpPath = (url: string): boolean => pathOf(url) === '/mcp';
const isJsonType = (type: string): boolean => {
  const t = type.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return t === 'application/json' || t.endsWith('+json');
};

/** `JSON.parse` that drops a `__proto__` member, the one key a naive merge would turn into a prototype write. */
const parseJson = (text: string): unknown => JSON.parse(text, (k, v: unknown) => (k === '__proto__' ? undefined : v));

const apiError = (code: string, message: string) => ({ error: { code, message } });

/** Resolves when `raw` has been read to its end, was closed, or after `serverLimits.drainMs`; whatever arrives meanwhile is discarded. */
function drained(raw: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    if (raw.readableEnded || raw.destroyed) return resolve();
    const done = (): void => (clearTimeout(timer), resolve());
    const timer = setTimeout(done, serverLimits.drainMs);
    raw.once('end', done);
    raw.once('close', done);
    raw.resume();
  });
}

/** First reply wins; later `send` calls of a handler that kept running after the watchdog fired are ignored. */
function facadeOf(reply: FastifyReply) {
  let sent = false;
  const send = (status: number, body?: unknown): void => {
    if (sent) return;
    sent = true;
    void reply.code(status).send(body);
  };
  const facade = {
    code: (n: number) => ({ send: (body?: unknown) => send(n, body) }),
    header: (key: string, value: string) => {
      if (!sent) void reply.header(key, value);
      return facade;
    },
  };
  return { facade, send, isSent: () => sent };
}

export async function buildApp(deps: AppDeps): Promise<{ app: FastifyInstance; routes: string[] }> {
  const startedAt = deps.startedAt ?? Date.now();
  const log = deps.log;
  const bounded = (p: Promise<boolean>): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([p.catch(() => false), new Promise<boolean>((res) => (timer = setTimeout(() => res(false), serverLimits.probeMs)))]).finally(() => clearTimeout(timer));
  };
  const health: Route = {
    method: 'GET',
    url: '/v1/health',
    async handler(_req, reply) {
      const [db, redis] = await Promise.all([bounded(deps.probes.db()), bounded(deps.probes.redis())]);
      return reply.code(200).send({ status: 'ok', mode: 'local', uptime_s: Math.round((Date.now() - startedAt) / 1000), db: db ? 'up' : 'down', redis: redis ? 'up' : 'down' });
    },
  };
  const all = [...deps.routes, health];
  const keys = new Set<string>();
  for (const r of all) {
    const key = routeKey(r);
    if (keys.has(key)) throw new Error(`duplicate route ${key}`);
    keys.add(key);
  }

  const app = Fastify({ logger: false, bodyLimit: serverLimits.bodyBytes, exposeHeadRoutes: false });

  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: serverLimits.bodyBytes }, (req, body, done) => {
    const text = (body as Buffer).toString('utf8');
    if (isHookPath(req.url)) {
      try {
        done(null, text === '' ? undefined : parseJson(text));
      } catch {
        // judgment: a hook body that is not JSON reaches the handler as "no body"; the handler's own invalid path answers (D10)
        done(null, undefined);
      }
      return;
    }
    if (!isJsonType(String(req.headers['content-type'] ?? ''))) return done(new BodyError('content-type must be application/json'));
    try {
      done(null, text === '' ? undefined : parseJson(text));
    } catch {
      done(new BodyError('body is not valid JSON'));
    }
  });

  app.setNotFoundHandler((_req, reply) => void reply.code(404).send(apiError('not_found', 'not found')));
  app.setErrorHandler(async (err: Error & { statusCode?: number }, req, reply) => {
    const clientError = err instanceof BodyError || (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500);
    // a refused body is read to its end (bounded in time) before the reply: a client that is still writing would otherwise see the connection reset, not the answer
    if (clientError) await drained(req.raw);
    if (isMcpPath(req.url)) {
      return reply.code(clientError ? 400 : 500).send({ jsonrpc: '2.0', id: null, error: clientError ? { code: -32700, message: 'Parse error' } : { code: -32603, message: 'Internal error' } });
    }
    if (isHookPath(req.url)) return reply.code(204).send();
    if (clientError) return reply.code(422).send(apiError('invalid', err instanceof BodyError ? err.message : 'request body rejected'));
    log?.('request failed', { error: errClass(err) });
    return reply.code(500).send(apiError('internal', errClass(err)));
  });

  for (const r of all) {
    const hook = isHookPath(r.url);
    app.route({
      method: r.method,
      url: r.url,
      async handler(req, reply) {
        const { facade, send, isSent } = facadeOf(reply);
        let timer: NodeJS.Timeout | undefined;
        try {
          const work = Promise.resolve(r.handler({ params: req.params, query: req.query, body: req.body, headers: req.headers }, facade));
          if (hook) {
            await Promise.race([work, new Promise<void>((res) => (timer = setTimeout(res, serverLimits.hookWatchdogMs)))]);
          } else await work;
        } catch (e) {
          log?.('handler failed', { route: routeKey(r), error: errClass(e) });
          if (hook) send(204);
          else send(500, apiError('internal', errClass(e)));
        } finally {
          clearTimeout(timer);
        }
        if (!isSent()) {
          if (hook) send(204);
          else send(500, apiError('internal', 'NoReply'));
        }
        return reply;
      },
    });
  }

  const handleMcp = createMcpHandler(deps.tools, log, deps.mcpProject);
  app.route({
    method: 'POST',
    url: '/mcp',
    async handler(req, reply) {
      reply.hijack();
      const res: ServerResponse = reply.raw;
      try {
        await handleMcp(req.raw as IncomingMessage, res, req.body);
      } catch (e) {
        log?.('mcp failed', { error: errClass(e) });
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }));
        } else res.end();
      }
    },
  });
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({
      method,
      url: '/mcp',
      handler: (_req, reply) =>
        reply.code(405).header('allow', 'POST').send({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed.' } }),
    });
  }

  await app.ready();
  return { app, routes: [...keys].sort() };
}
