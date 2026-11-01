/**
 * The `/api/graph` routes: `GET search|explain|path|affected|neighbors|stats`, `POST build` and `PATCH edges` (spec:335), as plain `Route` objects.
 * Called from: the ctc-web bootstrap (built later), which mounts them and passes `ctxOf`. Why: the dashboard and scripts ask the same graph the
 * MCP tools ask, and a person can queue a rebuild or confirm or drop an edge. Deliberately NOT done: Fastify, auth, rebuilding in-process (build
 * only submits the `graph.rebuild` job), any other write. Untrusted: every query, body and string read back from the database; a handler never rejects.
 */
import {
  GraphAffectedQuery, GraphBuildBody, GraphEdgeBody, GraphExplainQuery, GraphNeighborsQuery, GraphPathQuery, GraphSearchQuery, GraphStatsQuery,
} from '@ctc/shared/schemas/graph';
import { errorBody, iso, notFound, parse, statusOf, type Route } from '../library/http.ts';
import {
  configOf, ctxOf, doAffected, doExplain, doNeighbors, doPath, doSearch, errClass, failure, storeOf, type GraphApiDeps, type ProjectCtx,
} from './common.ts';

type Schema<A> = Parameters<typeof parse<A>>[0];
type Req = { query?: unknown; body?: unknown };

/** Exactly these eight routes, in this order. */
export function graphRoutes(deps: GraphApiDeps): Route[] {
  const cfg = configOf(deps);

  /** D1b: the project must be the caller's, else `404`. */
  async function owned(req: unknown, projectId: string): Promise<{ ctx: ProjectCtx; root: string }> {
    const base = ctxOf(deps, req);
    const p = await deps.repos.projects.get(base, projectId);
    if (!p) throw notFound('project not found');
    return { ctx: { ...base, projectId: p.id }, root: p.root };
  }

  const route = <Q extends { project_id: string }>(
    method: Route['method'],
    url: string,
    part: 'query' | 'body',
    schema: Schema<Q>,
    run: (a: Q, ctx: ProjectCtx, root: string) => Promise<{ code: number; body: unknown }>,
  ): Route => ({
    method,
    url,
    async handler(req, reply) {
      try {
        const args = parse(schema, part, (req as Req)[part]);
        const { ctx, root } = await owned(req, args.project_id);
        const { code, body } = await run(args, ctx, root);
        return reply.code(code).send(body);
      } catch (e) {
        const err = failure(deps, e);
        return reply.code(statusOf(err)).send(errorBody(err));
      }
    },
  });
  const ok = (body: unknown) => ({ code: 200, body });

  return [
    route('GET', '/api/graph/search', 'query', GraphSearchQuery, async (a, c) => ok(await doSearch(deps, cfg, c, a))),
    route('GET', '/api/graph/explain', 'query', GraphExplainQuery, async (a, c, root) => ok(await doExplain(deps, c, a.name, root))),
    route('GET', '/api/graph/path', 'query', GraphPathQuery, async (a, c) => ok(await doPath(deps, c, a))),
    route('GET', '/api/graph/affected', 'query', GraphAffectedQuery, async (a, c) => ok(await doAffected(deps, cfg, c, a))),
    route('GET', '/api/graph/neighbors', 'query', GraphNeighborsQuery, async (a, c) => ok(await doNeighbors(deps, c, a))),
    route('GET', '/api/graph/stats', 'query', GraphStatsQuery, async (_a, c) => {
      const s = await deps.repos.graph.stats(c);
      return ok({
        nodesByType: s.nodesByType,
        edgesByRelation: s.edgesByRelation,
        lastBuild: s.lastBuild ? iso(s.lastBuild) : null,
        guardTrips: (await deps.guardTrips?.(c, s.lastBuild)) ?? 0,
      });
    }),
    route('POST', '/api/graph/build', 'body', GraphBuildBody, async (a, c) => {
      const { id } = await deps.submit({
        queue: 'graph',
        kind: 'rebuild',
        payload: { userId: c.userId, projectId: c.projectId, ...(a.force !== undefined ? { force: a.force } : {}) },
      });
      return { code: 202, body: { job_id: id } };
    }),
    route('PATCH', '/api/graph/edges', 'body', GraphEdgeBody, async (a, c) => {
      const edge = await deps.repos.graph.reviewEdge(c, { src: a.src, dst: a.dst, relation: a.relation, confidence: a.confidence });
      if (!edge) throw notFound('edge not found');
      storeOf(deps).invalidate(c.userId, c.projectId);
      try {
        await deps.cache?.epoch.rotate('graph', c.userId, c.projectId);
      } catch (e) {
        deps.log?.('graph epoch rotate failed', { error: errClass(e) });
      }
      return ok({ src: edge.src, dst: edge.dst, relation: edge.relation, confidence: edge.confidence, score: edge.score, origin: edge.origin });
    }),
  ];
}
