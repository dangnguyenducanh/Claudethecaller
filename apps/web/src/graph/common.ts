/**
 * Shared plumbing of the F1 graph surface: the dependency type, the config read at build time, the store per deps, the query embedding, the
 * mapping of `QueryError` to the wire error, and the five query operations both the MCP tools and the routes run. Called from: tools.ts and
 * routes.ts. Why: one place decides what a project is for a call and what an error looks like on the wire. Deliberately NOT done: Fastify, the MCP
 * SDK, auth (the web bootstrap mounts the plain objects), any write. Untrusted: every request value and every string read back from the database.
 */
import {
  affectedBy, explainNode, findPath, neighborsOf, queryLimits, QueryError, resolveName, searchGraph,
  type AffectedResult, type ExplainResult, type NeighborsResult, type PathResult, type SearchResult,
} from '@ctc/core/graph/query';
import type { Embed } from '@ctc/shared/models';
import type { Ctx, Repositories } from '@ctc/shared/repositories';
import { ApiError, toApiError } from '../library/http.ts';
import { readExcerpt } from './excerpt.ts';
import { createGraphStore, type GraphStore } from './store.ts';

export type GraphApiDeps = {
  repos: Repositories;
  config: { graph: { query: { seeds: number; depth: number; hub_min: number; budget_tokens: number } }; graph_push: { floor: number } };
  submit(input: { queue: string; kind: string; payload: unknown; id?: string }): Promise<{ id: string }>;
  embed?: Embed;
  cache?: { epoch: { get(kind: 'graph', userId: string, projectId: string): Promise<string | null>; rotate(kind: 'graph', userId: string, projectId: string): Promise<string | null> } };
  store?: GraphStore;
  ctxOf?(req: unknown): Ctx;
  log?(message: string, fields?: Record<string, unknown>): void;
  readText?(root: string, rel: string): Promise<string | null>;
  /** Rebuilds of the project that ended on the shrink guard after `since` (the last node write), i.e. the ones a force rebuild has not answered yet. */
  guardTrips?(ctx: Ctx, since: Date | null): Promise<number>;
  onToolCall?(info: { userId: string; projectId: string | null; tool: string }): void;
  now?(): number;
};

export type GraphConfig = { seeds: number; depth: number; hubMin: number; budgetTokens: number; floor: number };
export type ProjectCtx = Ctx & { projectId: string };

export const errClass = (e: unknown): string => (e instanceof Error ? e.constructor.name : typeof e);
export const ctxOf = (deps: GraphApiDeps, req: unknown): Ctx => deps.ctxOf?.(req) ?? { userId: 'local' };

/** D21: a missing section of `deps.config` is a programmer error and throws a `TypeError` here, at build time. */
export function configOf(deps: GraphApiDeps): GraphConfig {
  const { seeds, depth, hub_min, budget_tokens } = deps.config.graph.query;
  const { floor } = deps.config.graph_push;
  return { seeds, depth, hubMin: hub_min, budgetTokens: budget_tokens, floor };
}

const stores = new WeakMap<object, GraphStore>();
/** `deps.store` when the bootstrap shares one, else one store per `deps` object so tools and routes of the same deps share it. */
export function storeOf(deps: GraphApiDeps): GraphStore {
  if (deps.store) return deps.store;
  let s = stores.get(deps);
  if (!s) {
    s = createGraphStore({
      repos: deps.repos,
      ...(deps.cache ? { cache: deps.cache } : {}),
      ...(deps.embed ? { embed: deps.embed } : {}),
      hubMin: deps.config.graph.query.hub_min,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.log ? { log: deps.log } : {}),
    });
    stores.set(deps, s);
  }
  return s;
}

/** One 1024-dimension vector for `text`, or `null` when there is no embedder or it fails or answers with anything else (the lexical channel alone then serves). */
async function embedQuery(deps: GraphApiDeps, text: string): Promise<number[] | null> {
  if (!deps.embed) return null;
  try {
    const [v] = await deps.embed([text]);
    return Array.isArray(v) && v.length === 1024 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? v : null;
  } catch {
    return null;
  }
}

/** D4 / D3: `QueryError` becomes the wire error with its extras; anything else goes through `toApiError` (class name only). */
export function failure(deps: GraphApiDeps, e: unknown): ApiError {
  if (e instanceof QueryError) {
    const extra = e.code === 'invalid' ? { path: [] } : e.code === 'not_found' && e.nearest ? { nearest: e.nearest } : e.code === 'ambiguous' && e.candidates ? { candidates: e.candidates } : {};
    return new ApiError(e.code, e.message, extra);
  }
  const err = toApiError(e);
  if (err.code === 'internal') deps.log?.('graph request failed', { error: errClass(e) });
  return err;
}

export async function doSearch(deps: GraphApiDeps, cfg: GraphConfig, ctx: ProjectCtx, a: { query: string; types?: string[] | undefined; limit: number }): Promise<SearchResult> {
  const text = a.query.trim().slice(0, queryLimits.queryMax);
  const [loaded, queryVector] = await Promise.all([storeOf(deps).get(ctx), embedQuery(deps, text)]);
  return searchGraph(loaded.index, {
    query: a.query,
    ...(a.types ? { types: a.types } : {}),
    limit: a.limit,
    ...(queryVector ? { queryVector } : {}),
    seeds: cfg.seeds,
    depth: cfg.depth,
    floor: cfg.floor,
  });
}

/** The excerpt is read from the project root through `deps.readText` (default: the safe reader of excerpt.ts). */
export async function doExplain(deps: GraphApiDeps, ctx: ProjectCtx, name: string, root?: string): Promise<ExplainResult> {
  const { index } = await storeOf(deps).get(ctx);
  const node = resolveName(index, name);
  const dir = root ?? (await deps.repos.projects.get(ctx, ctx.projectId))?.root;
  const excerpt = dir === undefined ? null : await readExcerpt(dir, node, deps.readText);
  return explainNode(index, node.id, { excerpt });
}

export async function doPath(deps: GraphApiDeps, ctx: ProjectCtx, a: { from: string; to: string; max_hops: number; directed: boolean }): Promise<PathResult> {
  return findPath((await storeOf(deps).get(ctx)).index, a.from, a.to, { maxHops: a.max_hops, directed: a.directed });
}

export async function doAffected(deps: GraphApiDeps, cfg: GraphConfig, ctx: ProjectCtx, a: { name: string; depth?: number | undefined }): Promise<AffectedResult> {
  return affectedBy((await storeOf(deps).get(ctx)).index, a.name, { depth: a.depth ?? cfg.depth });
}

export async function doNeighbors(deps: GraphApiDeps, ctx: ProjectCtx, a: { name: string; relation?: string | undefined; direction: 'in' | 'out' | 'both'; limit?: number | undefined }): Promise<NeighborsResult> {
  return neighborsOf((await storeOf(deps).get(ctx)).index, a.name, {
    ...(a.relation !== undefined ? { relation: a.relation } : {}),
    direction: a.direction,
    ...(a.limit !== undefined ? { limit: a.limit } : {}),
  });
}

/** `GraphApiDeps.guardTrips` over the jobs rows: dead `graph` jobs of the project whose error names the shrink guard, newest 100 looked at. */
export async function countGuardTrips(repos: Repositories, ctx: Ctx, since: Date | null): Promise<number> {
  const page = await repos.jobs.list(ctx, { queue: 'graph', status: 'dead', limit: 100 });
  return page.rows.filter(
    (j) => (j.payload as { projectId?: unknown } | null)?.projectId === ctx.projectId && (j.error ?? '').includes('shrink_guard') && (since === null || j.updatedAt > since),
  ).length;
}
