/**
 * The `library` queue handlers: `library.scan` (scan the roots) and `library.changed` (recompute the served version, embed, dedup).
 * Called from: apps/worker main, bound into `startWorkers({ handlers })` (apps/worker/src/jobs/index.ts). Why: spec:410-419.
 * Deliberately NOT done: `llm.enrich` submit and the capability graph node (D7), a TEI client (the embedder is injected), blob cleanup.
 * Untrusted: the job payload (re-validated by runAttempt; `payload.roots` is still ignored, D1b), every file under the roots.
 */
import { bodyOf, cosine, mainPathOf, resolveServed, sha256Hex, skillretText, type Limits } from '@ctc/core/library';
import { JobDropped } from '@ctc/shared/queues';
import type { Repositories } from '@ctc/shared/repositories';
import type { Handler } from '../jobs/index.ts';
import { discoverRoots } from './roots.ts';
import { scanLibrary, type Log, type SubmitInput } from './scan.ts';

export type Embed = (texts: string[]) => Promise<number[][]>;
export type LibraryConfig = {
  mode: string;
  claude_home: string;
  embed_model: string;
  embed: { skillret_body_chars: number };
  library: { roots: string[]; default_label: string; dedup_cosine: number; max_files: number; max_bytes: number };
};
export type LibraryDeps = {
  repos: Repositories;
  config: LibraryConfig;
  submit?: (input: SubmitInput) => Promise<unknown>;
  cache?: { publishInval(msg: unknown): Promise<void> };
  embed?: Embed;
  log?: Log;
};

type Changed = { capId: string; servedVersion: number | null; embedded: boolean; dedup: number } | { capId: string; skipped: 'not_found' | 'removed' };

export function libraryHandlers(deps: LibraryDeps): { 'library.scan': Handler; 'library.changed': Handler } {
  const { repos, submit, cache, embed, log } = deps;

  const scan = async (payload: { userId: string }, ctx: { signal: AbortSignal }): Promise<unknown> => {
    const { config } = deps; // read at call time
    if (payload.userId !== 'local' || config.mode !== 'local') throw new JobDropped('scan_not_local');
    const roots = await discoverRoots({ claudeHome: config.claude_home, roots: config.library.roots });
    const limits: Limits = { maxFiles: config.library.max_files, maxBytes: config.library.max_bytes, maxNameLen: 64, maxDescription: 1024, bodyChars: config.embed.skillret_body_chars };
    return scanLibrary({
      repos, ctx: { userId: payload.userId }, roots, limits, signal: ctx.signal,
      ...(submit ? { submit } : {}), ...(cache ? { cache } : {}), ...(log ? { log } : {}),
    });
  };

  const changed = async (payload: { userId: string; capId: string }): Promise<Changed> => {
    const { config } = deps;
    const ctx = { userId: payload.userId };
    const { capId } = payload;
    const cap = await repos.library.get(ctx, capId);
    if (!cap) return { capId, skipped: 'not_found' };
    if (cap.removedAt) return { capId, skipped: 'removed' };

    const versions = await repos.library.listVersions(ctx, capId);
    const served = resolveServed(versions, { defaultLabel: config.library.default_label });
    if (served !== null && served !== cap.servedVersion) await repos.library.setServed(ctx, capId, served);

    let embedded = false;
    const row = served === null ? undefined : versions.find((v) => v.version === served);
    if (embed && row) {
      const manifest = await repos.library.manifest(ctx, row.id);
      const mainPath = mainPathOf(manifest.map((m) => m.path));
      const content = mainPath === null ? null : await repos.library.getBlob(ctx, row.id, mainPath);
      if (mainPath !== null && content !== null) {
        const body = bodyOf(cap.kind, mainPath, content);
        const text = skillretText({ name: cap.name, description: row.description, body }, config.embed.skillret_body_chars);
        const textHash = sha256Hex(text);
        const mine = (await repos.library.loadVectors(ctx)).filter((v) => v.capId === capId);
        if (!mine.some((v) => v.textHash === textHash)) {
          const [embedding] = await embed([text]);
          if (!embedding) throw new Error('embedder returned no vector');
          await repos.library.upsertVector(ctx, { capId, textHash, embedding, model: config.embed_model });
          embedded = true;
        }
        await repos.library.pruneVectors(ctx, capId, textHash);
      }
    }
    const dedup = await writeDedup(ctx, capId, config.library.dedup_cosine);
    if (cache) await cache.publishInval({ v: 1, event: 'library.changed', userId: ctx.userId });
    return { capId, servedVersion: served, embedded, dedup };
  };

  /** Pairs of this capability with every other live capability whose vector is strictly above the threshold (best vector per capability). */
  async function writeDedup(ctx: { userId: string }, capId: string, threshold: number): Promise<number> {
    const all = await repos.library.loadVectors(ctx);
    const mine = all.filter((v) => v.capId === capId);
    if (mine.length === 0) return 0;
    const best = new Map<string, number>();
    for (const o of all) {
      if (o.capId === capId) continue;
      const similarity = Math.max(...mine.map((m) => cosine(m.embedding, o.embedding)));
      if (similarity > threshold && similarity > (best.get(o.capId) ?? -1)) best.set(o.capId, similarity);
    }
    for (const [other, similarity] of best) await repos.dedup.upsertPair(ctx, { pair: [capId, other], similarity });
    return best.size;
  }

  return { 'library.scan': scan, 'library.changed': changed };
}
