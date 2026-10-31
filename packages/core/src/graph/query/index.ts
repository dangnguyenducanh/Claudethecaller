/**
 * Graph query core: name resolution, search (lexical and dense seeds plus a walk), explain, shortest path, affected set, neighbors and the
 * text renderers, all pure functions on a RAM index of one project's graph.
 * Called from: apps/web/src/graph (the five MCP tools, `/api/graph`, the RAM store), and later T5.1 and T5.2.
 * Deliberately NOT done: any I/O, building or writing the graph (packages/core/src/graph and apps/worker), the prompt line. See model.ts, build.ts,
 * resolve.ts, search.ts, walk.ts and render.ts.
 */
export { queryLimits, QueryError, nodeRef } from './model.ts';
export type { GNode, GEdge, GraphIndex, NodeRef } from './model.ts';
export { buildIndex } from './build.ts';
export { resolveName } from './resolve.ts';
export { lexicalSeeds, denseSeeds, walkFrom, searchGraph } from './search.ts';
export type { Hit, SearchResult, Seed } from './search.ts';
export { explainNode, findPath, affectedBy, neighborsOf } from './walk.ts';
export type { ExplainResult, PathResult, AffectedResult, NeighborsResult } from './walk.ts';
export { renderSearch, renderExplain, renderPath, renderAffected, renderNeighbors } from './render.ts';
