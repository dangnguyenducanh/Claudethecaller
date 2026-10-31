/**
 * F2 read and change surface of the skill library: `/api` capability routes, the two MCP tools, the per-project served version.
 * Called from: the ctc-web bootstrap (mounts `libraryRoutes`, registers `libraryTools`), T5.1 and T3.3 (`servedVersion`).
 * Deliberately NOT done: Fastify and the MCP SDK (plain objects, D9), auth, enrich and dedup routes (D7).
 */
export { libraryRoutes } from './routes.ts';
export { libraryTools } from './tools.ts';
export { servedVersion, overrideRows } from './served.ts';
export type { LibraryApiDeps, McpResult, McpTool, Route } from './http.ts';
