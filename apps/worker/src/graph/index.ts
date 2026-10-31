/**
 * Project graph build of the worker. Called from: apps/worker main (`graphHandlers` into `startWorkers`), later T2.4's build route and
 * the `ctc graph build` command. Pure resolution rules live in @ctc/core/graph (`resolveGraph`).
 * Deliberately NOT done: the worker main, a TEI client, `graph.extract` (T2.3), query tools (T2.4).
 */
export { graphHandlers, type GraphDeps } from './handler.ts';
export { rebuildProject, type Embed, type GraphConfig, type RebuildResult } from './rebuild.ts';
export { walkProject } from './walk.ts';
export { graphLimits, PACKAGES_SOURCE } from './limits.ts';
