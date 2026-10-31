/**
 * Served version of a capability for one project (D12). Called from: tools.ts (`get_capability`), index.ts (T5.1 prompt line and T3.3 skill
 * channel call `servedVersion`). Why: a project pin or block changes what that project reads, so the rule `override → production → latest`
 * lives in core `resolveServed` and this file only finds the override. Deliberately NOT done: reading `capabilities.served_version`
 * (override-free, T3.1 D16), recomputing embeddings.
 */
import { resolveServed, type Override } from '@ctc/core/library';
import { keys, ttl } from '@ctc/shared/cache';
import type { Ctx } from '@ctc/shared/repositories';
import type { LibraryApiDeps } from './http.ts';

type OverrideRow = { projectId: string | null; capId: string; action: string; label: string | null; version: number | null };

/** Override rows of the ctx (globals plus its project's), cache-aside under `ovr:` when there is a cache and a project. */
async function overrideRows(deps: LibraryApiDeps, ctx: Ctx): Promise<OverrideRow[]> {
  const { cache } = deps;
  let key: string | undefined;
  if (cache && ctx.projectId) {
    try {
      key = keys.ovr(ctx.userId, ctx.projectId);
    } catch {
      key = undefined; // a TypeError from keys.ovr means "do not cache" (D10)
    }
  }
  if (cache && key) {
    try {
      const hit = await cache.get<OverrideRow[]>(key);
      if (Array.isArray(hit)) return hit;
    } catch (e) {
      deps.log?.('ovr cache get failed', { error: e instanceof Error ? e.constructor.name : typeof e });
    }
  }
  const found = await deps.repos.library.listOverrides(ctx);
  if (cache && key) {
    try {
      await cache.set(key, found, ttl.ovr);
    } catch (e) {
      deps.log?.('ovr cache set failed', { error: e instanceof Error ? e.constructor.name : typeof e });
    }
  }
  return found;
}

/** The override that applies to `capId`: the project's own row, else the global one, else `null`. */
async function overrideOf(deps: LibraryApiDeps, ctx: Ctx, capId: string): Promise<Override | null> {
  const mine = (await overrideRows(deps, ctx)).filter((r) => r.capId === capId);
  const row = mine.find((r) => ctx.projectId !== undefined && r.projectId === ctx.projectId) ?? mine.find((r) => r.projectId === null);
  if (!row || (row.action !== 'pin' && row.action !== 'block')) return null;
  return { action: row.action, label: row.label, version: row.version };
}

/** Same as `servedVersion` for versions the caller already read. */
export async function servedFrom(deps: LibraryApiDeps, ctx: Ctx, capId: string, versions: readonly { version: number; labels: readonly string[] }[]): Promise<number | null> {
  if (versions.length === 0) return null;
  const override = await overrideOf(deps, ctx, capId);
  return resolveServed(versions, { override, defaultLabel: deps.config.library.default_label });
}

/** The version `ctx` reads for `capId`, or `null` (blocked, no versions, or not the caller's capability). */
export async function servedVersion(deps: LibraryApiDeps, ctx: Ctx, capId: string): Promise<number | null> {
  return servedFrom(deps, ctx, capId, await deps.repos.library.listVersions(ctx, capId));
}
