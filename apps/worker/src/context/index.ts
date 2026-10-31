/**
 * Context layer of the project graph (T2.3): document parsing into `ctx:` nodes, the model-assisted doc extract job, and capability nodes from the F2 library.
 * Called from: apps/worker main, which wraps `graphHandlers(..)['graph.rebuild']` with `withContextPass`, `libraryHandlers(..)['library.changed']` with `withCapabilityLinks`
 * and binds `extractHandler(..)['graph.extract']`. Pure rules live in @ctc/core/context.
 * Deliberately NOT done: the worker main, TEI/Redis/`submit` wiring, query tools (T2.4).
 */
export { contextPass, type ContextPassResult } from './pass.ts';
export { withContextPass, withCapabilityLinks, type ContextDeps, type LinkDeps } from './handlers.ts';
export { extractHandler, spawnClaude, type RunClaude, type ExtractDeps } from './extract.ts';
export { linkCapability, syncCapabilities, type LinkResult, type SyncResult } from './capability.ts';
export { contextWorkerLimits } from './limits.ts';
