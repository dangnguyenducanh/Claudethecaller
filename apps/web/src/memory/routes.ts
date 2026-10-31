/**
 * The eight `/api` memory routes (D14): list, read, patch, soft-delete, import of Claude's memory files, session summary, history list,
 * history import. Called from: the ctc-web bootstrap, which mounts each `Route` with `app.route({ method, url, handler })`; the dashboard
 * Memories page calls them. Why: the user reviews, corrects and removes what ctc remembers. Deliberately NOT done: Fastify, auth,
 * `Idempotency-Key`. Untrusted: params, query and body; a handler never throws.
 */
import { memoryHash } from '@ctc/shared/memory-hash';
import { sanitize } from '@ctc/core/sanitize';
import { ConflictError, RepoError, type Ctx } from '@ctc/shared/repositories';
import { HistoryImportBody, HistoryListQuery, MemoryIdParams, MemoryListQuery, MemoryPatchBody, SummaryParams, memoryApiLimits } from '@ctc/shared/schemas/memory';
import { ApiError, errorBody, iso, notFound, parse, statusOf, toApiError, type Route } from '../library/http.ts';
import { ctxOf, errClass, memoryView, rotateMem, type MemoryApiDeps } from './common.ts';

type Req = { params?: unknown; query?: unknown; body?: unknown };
type Result = { status: number; body?: unknown };

export function memoryRoutes(deps: MemoryApiDeps): Route[] {
  const { repos } = deps;
  const route = (method: Route['method'], url: string, run: (req: Req, ctx: Ctx) => Promise<Result>): Route => ({
    method,
    url,
    async handler(req, reply) {
      let result: Result;
      try {
        result = await run(req ?? {}, ctxOf(deps, req));
      } catch (e) {
        const err = toApiError(e);
        if (err.code === 'internal') deps.log?.(`${method} ${url} failed`, { error: errClass(e) });
        result = { status: statusOf(err), body: errorBody(err) };
      }
      return reply.code(result.status).send(result.body);
    },
  });
  const badCursor = (e: unknown): never => {
    throw e instanceof RepoError && e.code === 'invalid' ? new ApiError('invalid', e.message, { path: ['query', 'cursor'] }) : e;
  };

  return [
    route('GET', '/api/memories', async (req, ctx) => {
      const q = parse(MemoryListQuery, 'query', req.query ?? {});
      const page = await repos.memory
        .list(ctx, {
          ...(q.scope === undefined ? {} : { scope: q.scope }), ...(q.kind === undefined ? {} : { kind: q.kind }),
          ...(q.q === undefined ? {} : { q: q.q }), ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
          limit: q.limit ?? memoryApiLimits.listDefault,
        })
        .catch(badCursor);
      return { status: 200, body: { items: page.rows.map(memoryView), next: page.next } };
    }),

    route('GET', '/api/memories/:id', async (req, ctx) => {
      const m = await repos.memory.get(ctx, parse(MemoryIdParams, 'params', req.params).id);
      if (!m || m.deletedAt !== null) throw notFound('memory not found');
      return { status: 200, body: memoryView(m) };
    }),

    route('PATCH', '/api/memories/:id', async (req, ctx) => {
      const { id } = parse(MemoryIdParams, 'params', req.params);
      const body = parse(MemoryPatchBody, 'body', req.body);
      const text = body.text === undefined ? undefined : sanitize(body.text).trim();
      if (text === '') throw new ApiError('invalid', 'text is empty', { path: ['body', 'text'] });
      const patch = { ...(text === undefined ? {} : { text }), ...(body.pinned === undefined ? {} : { pinned: body.pinned }), ...(body.kind === undefined ? {} : { kind: body.kind }) };
      let m = await repos.memory.patch(ctx, id, patch);
      if (!m) throw notFound('memory not found');
      if (text !== undefined) {
        try {
          const [embedding] = await deps.embed([text]);
          if (embedding) m = (await repos.memory.rewrite(ctx, id, { text, embedding, hash: memoryHash(text) })) ?? m;
        } catch (e) {
          if (e instanceof ConflictError) throw e;
          deps.log?.('memory patch left without vector', { error: errClass(e) }); // judgment: the text change stands without a vector
        }
      }
      if (m.scope === 'project') await rotateMem(deps, ctx, m.projectId);
      return { status: 200, body: memoryView(m) };
    }),

    route('DELETE', '/api/memories/:id', async (req, ctx) => {
      const { id } = parse(MemoryIdParams, 'params', req.params);
      const m = await repos.memory.get(ctx, id);
      if ((await repos.memory.softDelete(ctx, id)) === 0) throw notFound('memory not found');
      if (m?.scope === 'project') await rotateMem(deps, ctx, m.projectId);
      return { status: 204 };
    }),

    route('POST', '/api/memories/import', async (_req, ctx) => {
      const job = await deps.submit({ queue: 'memory', kind: 'import', payload: { userId: ctx.userId } });
      return { status: 202, body: { job_id: job.id } };
    }),

    route('GET', '/api/sessions/:sid/summary', async (req, ctx) => {
      const { sid } = parse(SummaryParams, 'params', req.params);
      const s = await repos.memory.getSummary(ctx, sid);
      if (!s) throw notFound('summary not found');
      return {
        status: 200,
        body: {
          sessionId: s.sessionId, projectId: s.projectId, request: s.request, investigated: s.investigated, learned: s.learned,
          completed: s.completed, nextSteps: s.nextSteps, notes: s.notes, createdAt: iso(s.createdAt),
        },
      };
    }),

    route('GET', '/api/history', async (req, ctx) => {
      const q = parse(HistoryListQuery, 'query', req.query ?? {});
      const files = await repos.history.listByStatus(ctx, { status: q.status, limit: q.limit ?? memoryApiLimits.listDefault });
      return { status: 200, body: { items: files.map((f) => ({ path: f.path, size: f.size, mtime: f.mtime, status: f.status })) } };
    }),

    route('POST', '/api/history/import', async (req, ctx) => {
      const body = parse(HistoryImportBody, 'body', req.body ?? {});
      const payload = { userId: ctx.userId, ...(body.limit === undefined ? {} : { limit: body.limit }) };
      const job = await deps.submit({ queue: 'memory', kind: 'distill', payload });
      return { status: 202, body: { job_id: job.id } };
    }),
  ];
}
