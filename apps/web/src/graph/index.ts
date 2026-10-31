/**
 * F1 graph queries on the web side: the five MCP tools, the `/api/graph` routes and the RAM graph store, as plain objects.
 * Called from: the ctc-web bootstrap (built later), which mounts them and feeds `store.onInval` from the `ctc:inval` subscription.
 * Deliberately NOT done: Fastify, the MCP SDK, auth, building the graph. See tools.ts, routes.ts, store.ts and excerpt.ts.
 */
export { graphRoutes } from './routes.ts';
export { graphTools } from './tools.ts';
export { createGraphStore } from './store.ts';
export { readExcerpt } from './excerpt.ts';
export type { GraphStore, LoadedGraph } from './store.ts';
export type { GraphApiDeps } from './common.ts';
