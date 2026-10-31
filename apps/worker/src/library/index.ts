/**
 * Library scanner and `library` queue handlers of the worker. Called from: apps/worker main (`libraryHandlers` into `startWorkers`,
 * `watchLibrary` for the file watch), T3.2 routes (through the queue). Pure rules live in @ctc/core/library.
 * Deliberately NOT done: the worker main, a TEI client, `llm.enrich`, graph nodes (D7).
 */
export { discoverRoots, type Root } from './roots.ts';
export { scanLibrary, type ScanResult } from './scan.ts';
export { libraryHandlers, type Embed, type LibraryDeps } from './handlers.ts';
export { watchLibrary } from './watch.ts';
