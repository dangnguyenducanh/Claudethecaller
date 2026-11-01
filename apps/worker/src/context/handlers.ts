/**
 * Handler composition: the context pass after `graph.rebuild`, capability linking after `library.changed`.
 *
 * Called from: apps/worker main, which binds the wrapped handlers into `startWorkers({ handlers })`. Why it exists: DECISIONS D13, D16; the pinned handler maps of
 * `graphHandlers` and `libraryHandlers` stay unchanged. Deliberately NOT done: changing the inner handlers, running anything when the inner handler failed.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Repositories } from '@ctc/shared/repositories';
import type { Handler } from '../jobs/index.ts';
import type { Embed, GraphConfig, Log, RebuildCache } from '../graph/rebuild.ts';
import { linkCapability, syncCapabilities, type SyncResult } from './capability.ts';
import { contextWorkerLimits } from './limits.ts';
import { contextPass, type ContextPassResult, type Submit } from './pass.ts';

export type ContextDeps = { repos: Repositories; config: GraphConfig; cache?: RebuildCache; embed?: Embed; submit?: Submit; log?: Log };
export type LinkDeps = { repos: Repositories; cache?: RebuildCache; log?: Log };
type HandlerCtx = Parameters<Handler>[1];
const LAYER_TYPES = ['skill', 'agent', 'command', 'workflow'];

const wrap = (inner: unknown, key: string, extra: unknown): unknown =>
  typeof inner === 'object' && inner !== null && !Array.isArray(inner) ? { ...inner, [key]: extra } : { result: inner, [key]: extra };

/**
 * Runs the inner `graph.rebuild` handler, then (local mode, user `local`) the context pass for the same payload, and the capability sync when the project graph has no
 * capability node yet. An inner error propagates and nothing else runs; an error of the pass propagates too (the job is retried, the inner work is hash-gated).
 */
export function withContextPass(handler: Handler, deps: ContextDeps): Handler {
  const run = async (payload: { userId: string; projectId: string; files?: string[]; force?: boolean }, hctx: HandlerCtx): Promise<unknown> => {
    const inner = await handler(payload as never, hctx);
    const { repos, config } = deps; // read at call time
    if (config.mode !== 'local' || payload.userId !== 'local') return inner;
    const ctx = { userId: payload.userId, projectId: payload.projectId };
    const project = await repos.projects.get({ userId: payload.userId }, payload.projectId);
    const isDir = project !== null && path.isAbsolute(project.root) && (await fs.stat(project.root).then((s) => s.isDirectory(), () => false));
    if (!project || !isDir) return inner;
    const context: ContextPassResult = await contextPass({
      repos, ctx, root: project.root, signal: hctx.signal,
      ...(payload.files ? { files: payload.files } : {}), ...(payload.force !== undefined ? { force: payload.force } : {}),
      ...(deps.cache ? { cache: deps.cache } : {}), ...(deps.embed ? { embed: deps.embed } : {}), ...(deps.submit ? { submit: deps.submit } : {}), ...(deps.log ? { log: deps.log } : {}),
    });
    const result = wrap(inner, 'context', context) as Record<string, unknown>;
    const stats = await repos.graph.stats(ctx);
    if (LAYER_TYPES.some((t) => (stats.nodesByType[t] ?? 0) > 0)) return result;
    const capabilities: SyncResult = await syncCapabilities({
      repos, ctx, signal: hctx.signal, ...(deps.cache ? { cache: deps.cache } : {}), ...(deps.log ? { log: deps.log } : {}),
    });
    return { ...result, capabilities };
  };
  return run as unknown as Handler;
}

/**
 * Runs the inner `library.changed` handler first (its error propagates and nothing is linked), then links `payload.capId` into every project of `payload.userId`
 * (at most `maxProjects`). A link error for one project is logged and counted, never thrown: the library work already succeeded.
 */
export function withCapabilityLinks(handler: Handler, deps: LinkDeps): Handler {
  const run = async (payload: { userId: string; capId: string }, hctx: HandlerCtx): Promise<unknown> => {
    const inner = await handler(payload as never, hctx);
    const { repos } = deps; // read at call time
    const log = deps.log ?? (() => undefined);
    const graph = { projects: 0, linked: 0, removed: 0, unchanged: 0, skipped: 0, failed: 0 };
    const page = await repos.projects.list({ userId: payload.userId }, { limit: contextWorkerLimits.maxProjects });
    for (const p of page.rows.slice(0, contextWorkerLimits.maxProjects)) {
      hctx.signal.throwIfAborted();
      graph.projects++;
      try {
        const r = await linkCapability({ repos, userId: payload.userId, projectId: p.id, capId: payload.capId, ...(deps.cache ? { cache: deps.cache } : {}), log });
        graph[r.status]++;
      } catch (e) {
        graph.failed++;
        log('capability link failed', { projectId: p.id, error: e instanceof Error ? e.constructor.name : typeof e });
      }
    }
    return wrap(inner, 'graph', graph);
  };
  return run as unknown as Handler;
}
