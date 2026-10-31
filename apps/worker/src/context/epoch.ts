/**
 * Epoch bump and invalidation after the context layer wrote rows (D10e, as T2.2 D19).
 * Called from: pass.ts, capability.ts, extract.ts. Deliberately NOT done: throwing, because the rows are already committed.
 */
import type { Repositories } from '@ctc/shared/repositories';
import type { Log, RebuildCache } from '../graph/rebuild.ts';

const errName = (e: unknown): string => (e instanceof Error ? e.constructor.name : typeof e);

/** Bumps `projects.graph_epoch`, rotates the cache epoch and publishes `graph.rebuild`; each failure is logged and ignored. Returns the new cache epoch or `null`. */
export async function announceWrite(o: { repos: Repositories; ctx: { userId: string; projectId: string }; cache: RebuildCache | undefined; log: Log }): Promise<string | null> {
  const { repos, ctx, cache, log } = o;
  let epoch: string | null = null;
  try {
    await repos.projects.bumpEpoch(ctx, ctx.projectId, 'graph');
  } catch (e) {
    log('graph epoch bump failed', { error: errName(e) });
  }
  if (!cache) return null;
  try {
    epoch = await cache.epoch.rotate('graph', ctx.userId, ctx.projectId);
  } catch (e) {
    log('graph epoch rotate failed', { error: errName(e) });
  }
  try {
    await cache.publishInval({ v: 1, event: 'graph.rebuild', userId: ctx.userId, projectId: ctx.projectId });
  } catch (e) {
    log('graph inval publish failed', { error: errName(e) });
  }
  return epoch;
}
