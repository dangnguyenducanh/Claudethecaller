/**
 * Capability linking: copies a user's F2 library capability into project graphs as `skill:` / `agent:` / `command:` / `workflow:` nodes with `uses` / `invokes` / `contains` edges.
 *
 * Called from: handlers.ts (`withCapabilityLinks` after `library.changed`, `withContextPass` for an empty capability layer). Why it exists: spec:286, DECISIONS D13.
 * Deliberately NOT done: embedding (the next context pass or rebuild embeds the node), `graph_sources` rows, touching rows of another origin, reading another user's rows.
 * Untrusted: library rows (names, YAML, blobs); a capability that cannot be read is skipped, never fatal.
 */
import { parseCapability } from '@ctc/core/context';
import { bodyOf, mainPathOf } from '@ctc/core/library';
import type { Repositories } from '@ctc/shared/repositories';
import type { Log, RebuildCache } from '../graph/rebuild.ts';
import { announceWrite } from './epoch.ts';
import { contextWorkerLimits } from './limits.ts';

export type LinkResult = { capId: string; projectId: string; status: 'linked' | 'unchanged' | 'removed' | 'skipped'; reason?: string; nodes?: number; edges?: number };
export type SyncResult = { linked: number; unchanged: number; skipped: number };
export type LinkOptions = { repos: Repositories; userId: string; projectId: string; capId: string; cache?: RebuildCache; log?: Log };

const KINDS = ['skill', 'agent', 'command', 'workflow'] as const;
const PAGE = 200;
const noop = (): void => undefined;
const lt = (a: string, b: string): boolean => a < b;

/** Synthetic source file of the rows of one capability: never a real path, so no file walk touches it. */
const sourceOf = (kind: string, name: string): string => `<cap:${kind}:${name}>`;

/**
 * Brings the rows of one capability in one project graph up to date: removed -> rows deleted, no served version / duplicate name / unreadable files -> skipped,
 * same node hash -> unchanged, else one `replaceSource` with origin `parser`. Idempotent; only reads the library rows of `userId`.
 */
export async function linkCapability(o: LinkOptions): Promise<LinkResult> {
  const { repos, userId, projectId, capId } = o;
  const log = o.log ?? noop;
  const user = { userId };
  const ctx = { userId, projectId };
  const res = (status: LinkResult['status'], extra: { reason?: string; nodes?: number; edges?: number } = {}): LinkResult => ({ capId, projectId, status, ...extra });
  const skip = (reason: string): LinkResult => res('skipped', { reason });
  const cap = await repos.library.get(user, capId);
  if (!cap) return skip('not_found');
  const source = sourceOf(cap.kind, cap.name);
  if (cap.removedAt) {
    const { deleted } = await repos.graph.deleteSource(ctx, { origin: 'parser', sourceFile: source, keepSource: true });
    if (deleted > 0) await announceWrite({ repos, ctx, cache: o.cache, log });
    return res('removed');
  }
  if (cap.servedVersion === null) return skip('no_served_version');
  const kind = KINDS.find((k) => k === cap.kind);
  if (!kind) return skip('bad_capability');
  // judgment: of two live capabilities with one kind and name the smaller (namespace, id) wins, and only one that is served can win
  const rivals = (await repos.library.listByName(user, cap.name)).filter((c) => c.kind === cap.kind && c.id !== cap.id && c.servedVersion !== null);
  if (rivals.some((c) => lt(c.namespace, cap.namespace) || (c.namespace === cap.namespace && lt(c.id, cap.id)))) return skip('duplicate_name');
  const version = await repos.library.getVersion(user, capId, cap.servedVersion);
  if (!version) return skip('no_served_version');
  const mainPath = mainPathOf((await repos.library.manifest(user, version.id)).map((m) => m.path));
  if (mainPath === null) return skip('no_main_file');
  const content = await repos.library.getBlob(user, version.id, mainPath);
  if (content === null) return skip('blob_missing');
  const parsed = parseCapability({
    kind, name: cap.name, description: version.description, frontmatter: version.frontmatter, body: bodyOf(cap.kind, mainPath, content),
    servedVersion: cap.servedVersion, bodyHash: version.bodyHash,
  });
  if (parsed.nodes.length === 0) return skip('bad_capability');
  const stored = await repos.graph.getNode(ctx, `${kind}:${cap.name}`);
  if (stored && stored.contentHash === parsed.hash) return res('unchanged');
  await repos.graph.replaceSource(ctx, {
    origin: 'parser',
    sourceFile: source,
    nodes: parsed.nodes.map((n) => ({ id: n.id, kind: n.kind, type: n.type, label: n.label, sourceLocation: n.sourceLocation, contentHash: n.contentHash, meta: n.meta })),
    edges: parsed.edges.map((e) => ({ src: e.src, dst: e.dst, relation: e.relation, confidence: e.confidence, score: e.score, sourceLocation: e.sourceLocation })),
  });
  await announceWrite({ repos, ctx, cache: o.cache, log });
  return res('linked', { nodes: parsed.nodes.length, edges: parsed.edges.length });
}

/** Links every live capability of the user into one project (pages of 200, at most `maxSyncCaps`). A removed capability's rows go when its own `library.changed` runs. */
export async function syncCapabilities(o: { repos: Repositories; ctx: { userId: string; projectId: string }; cache?: RebuildCache; log?: Log; signal?: AbortSignal }): Promise<SyncResult> {
  const out: SyncResult = { linked: 0, unchanged: 0, skipped: 0 };
  let seen = 0;
  let cursor: string | undefined;
  for (;;) {
    o.signal?.throwIfAborted();
    const page = await o.repos.library.listCapabilities({ userId: o.ctx.userId }, { limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
    for (const cap of page.rows) {
      if (seen >= contextWorkerLimits.maxSyncCaps) return out;
      seen++;
      const r = await linkCapability({ repos: o.repos, userId: o.ctx.userId, projectId: o.ctx.projectId, capId: cap.id, ...(o.cache ? { cache: o.cache } : {}), ...(o.log ? { log: o.log } : {}) });
      if (r.status === 'linked') out.linked++;
      else if (r.status === 'unchanged') out.unchanged++;
      else out.skipped++;
    }
    if (page.next === null || page.rows.length === 0) return out;
    cursor = page.next;
  }
}
