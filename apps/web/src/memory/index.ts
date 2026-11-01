/**
 * F3 memory on the web side: the SessionStart hook route, the eight `/api` memory routes and the four MCP memory tools, as plain objects.
 * Called from: the ctc-web bootstrap (built later). See hook.ts, routes.ts and tools.ts for what each does and does not do.
 */
export { hookStartRoute } from './hook.ts';
export { memoryRoutes } from './routes.ts';
export { memoryTools } from './tools.ts';
export type { MemoryApiDeps } from './common.ts';
