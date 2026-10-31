/**
 * Library scan: files under the roots become immutable versions, labels, a manifest and blobs; vanished capabilities are soft-removed.
 * Called from: the `library.scan` handler (handlers.ts) and tests. Why: spec:410-414 (hash every file, compare with the latest manifest,
 * create version n+1 only when it differs). Deliberately NOT done: any lock of its own (createVersion's advisory lock and re-check make
 * parallel scans safe, D15), writing under a root, hard deletes, embedding, graph nodes, `llm.enrich` (D7).
 * Untrusted: every file under a root. `ctx` and `roots` are chosen by the caller (the handler enforces the local-only rule, D1a).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildVersion, libraryLimits, peekName, sameManifest, type Limits, type Skip } from '@ctc/core/library';
import type { Ctx, Repositories } from '@ctc/shared/repositories';
import type { Root } from './roots.ts';
import { walkRoot, type Found } from './walk.ts';

export type { Root };
export type ScanResult = {
  roots: { path: string; namespace: string; walked: boolean }[];
  created: { capId: string; namespace: string; kind: string; name: string; version: number }[];
  unchanged: number;
  removed: { capId: string; namespace: string; kind: string; name: string }[];
  skipped: Skip[];
  warnings: Skip[];
};
export type SubmitInput = { queue: string; kind: string; payload: unknown; id?: string };
export type Log = (message: string, fields?: Record<string, unknown>) => void;
export type ScanDeps = {
  repos: Repositories;
  ctx: Ctx;
  roots: readonly Root[];
  limits?: Limits;
  submit?: (input: SubmitInput) => Promise<unknown>;
  cache?: { publishInval(msg: unknown): Promise<void> };
  log?: Log;
  signal?: AbortSignal;
};

const identity = (namespace: string, kind: string, name: string): string => `${namespace}\0${kind}\0${name}`;
const errName = (e: unknown): string => (e instanceof Error ? e.constructor.name : typeof e);

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function scanLibrary(deps: ScanDeps): Promise<ScanResult> {
  const { repos, ctx, submit, cache, log, signal } = deps;
  const limits: Limits = { ...(deps.limits ?? libraryLimits) };
  const roots = deps.roots.map((r) => ({ path: path.resolve(r.path), namespace: r.namespace }));
  const result: ScanResult = { roots: [], created: [], unchanged: 0, removed: [], skipped: [], warnings: [] };
  signal?.throwIfAborted();

  const claimed = new Set<string>(); // identities versioned or unchanged in this scan (duplicate_name check)
  const protectedIds = new Set<string>(); // identities that must not be removed: claimed plus skipped ones
  const protectedSkillDirs = new Set<string>(); // namespace + rootPath of skipped skills
  const toSubmit: { capId: string; version: number }[] = [];

  const skip = (f: Found, s: Skip, mainBytes: Uint8Array | undefined, namespace: string): void => {
    result.skipped.push(s);
    protectedIds.add(identity(namespace, f.kind, f.defaultName));
    const declared = mainBytes ? peekName(f.kind, f.mainPath, mainBytes) : null;
    if (declared !== null) protectedIds.add(identity(namespace, f.kind, declared));
    if (f.kind === 'skill') protectedSkillDirs.add(`${namespace}\0${f.rootPath}`);
  };

  for (const root of roots) {
    const walked = await isDirectory(root.path);
    const rootEntry = { path: root.path, namespace: root.namespace, walked };
    result.roots.push(rootEntry);
    if (!walked) continue;
    const incomplete: Skip[] = [];
    for await (const found of walkRoot(root.path, limits, signal, incomplete)) {
      signal?.throwIfAborted();
      const main = found.files.find((f) => f.path === found.mainPath)?.bytes;
      result.warnings.push(...found.warnings);
      if (found.skip) {
        skip(found, found.skip, main, root.namespace);
        continue;
      }
      const built = buildVersion(
        { kind: found.kind, namespace: root.namespace, defaultName: found.defaultName, rootPath: found.rootPath, mainPath: found.mainPath, files: found.files },
        limits,
      );
      if (!built.ok) {
        skip(found, built.skip, main, root.namespace);
        continue;
      }
      const { input } = built;
      const id = identity(root.namespace, input.kind, input.name);
      if (claimed.has(id)) {
        skip(found, { path: path.join(found.rootPath, found.mainPath), code: 'duplicate_name', message: 'another capability in this scan has the same namespace, kind and name' }, undefined, root.namespace);
        continue;
      }
      claimed.add(id);
      protectedIds.add(id);
      result.warnings.push(...built.warnings);

      const existing = await repos.library.byName(ctx, { namespace: input.namespace, kind: input.kind, name: input.name });
      if (existing && existing.removedAt === null && existing.rootPath === input.rootPath) {
        const latest = (await repos.library.listVersions(ctx, existing.id)).find((v) => v.labels.includes('latest'));
        if (latest && sameManifest(await repos.library.manifest(ctx, latest.id), input.files)) {
          result.unchanged++;
          continue;
        }
      }
      const { version, created } = await repos.library.createVersion(ctx, { ...input, commitMessage: 'scan' });
      if (created) result.created.push({ capId: version.capId, namespace: input.namespace, kind: input.kind, name: input.name, version: version.version });
      else result.unchanged++;
      // a capability that came back without a new version is submitted too: its served version and vector must be recomputed
      if (created || existing?.removedAt) toSubmit.push({ capId: version.capId, version: version.version });
    }
    if (incomplete.length > 0) {
      rootEntry.walked = false; // an unlistable capability directory is not "nothing here": nothing of this namespace is removed (D8)
      result.skipped.push(...incomplete);
    }
  }

  const walkedNamespaces = new Set(result.roots.filter((r) => r.walked).map((r) => r.namespace));
  const fully = new Set([...walkedNamespaces].filter((ns) => result.roots.filter((r) => r.namespace === ns).every((r) => r.walked)));
  if (fully.size > 0) {
    let cursor: string | undefined;
    do {
      signal?.throwIfAborted();
      const page = await repos.library.listCapabilities(ctx, { limit: 500, ...(cursor === undefined ? {} : { cursor }) });
      for (const cap of page.rows) {
        if (!fully.has(cap.namespace) || protectedIds.has(identity(cap.namespace, cap.kind, cap.name))) continue;
        if (cap.kind === 'skill' && protectedSkillDirs.has(`${cap.namespace}\0${cap.rootPath}`)) continue;
        if ((await repos.library.markRemoved(ctx, cap.id)) > 0) result.removed.push({ capId: cap.id, namespace: cap.namespace, kind: cap.kind, name: cap.name });
      }
      cursor = page.next ?? undefined;
    } while (cursor !== undefined);
  }

  if (submit) {
    for (const t of toSubmit) {
      try {
        await submit({ queue: 'library', kind: 'changed', payload: { userId: ctx.userId, capId: t.capId, version: t.version }, id: `library.changed:${t.capId}:${t.version}` });
      } catch (e) {
        log?.('library.changed submit failed', { capId: t.capId, error: errName(e) });
      }
    }
  }
  if (result.removed.length > 0 && cache) {
    try {
      await cache.publishInval({ v: 1, event: 'library.changed', userId: ctx.userId });
    } catch (e) {
      log?.('library inval publish failed', { error: errName(e) });
    }
  }
  return result;
}
