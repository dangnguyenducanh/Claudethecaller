/**
 * Incremental project graph rebuild: walk, hash, extract, resolve, guard, write per file, delete, embed, rotate the epoch.
 *
 * Called from: handler.ts (`graph.rebuild` jobs), later `POST /api/graph/build` and `ctc graph build`. Why it exists: spec:280-295,
 * a project graph that follows edits without re-reading unchanged files. Deliberately NOT done: SQL (repos only), the embedding
 * client (injected), context/capability nodes (T2.3), progress updates, a per-project lock (one worker, concurrency 1), writing under the root.
 * Untrusted: every file under the root, every `files` entry, the stored rows (may be stale).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EXTRACTOR_VERSION, contentHash, extractFile, langOf, loadGrammars, resolveGraph } from '@ctc/core/graph';
import type { ContextNode, ExtractResult, Grammars, PackageJson, ResolvedEdge } from '@ctc/core/graph';
import type { Repositories } from '@ctc/shared/repositories';
import { graphLimits, PACKAGES_SOURCE } from './limits.ts';
import { checkPaths, safeRel, walkProject, type Skip } from './walk.ts';

export type Embed = (texts: string[]) => Promise<number[][]>;
export type GraphConfig = { mode: string; graph: { languages: string[]; shrink_guard: number; debounce_s: number } };
export type Log = (message: string, fields?: Record<string, unknown>) => void;
export type RebuildCache = {
  epoch: { rotate(kind: 'graph', userId: string, projectId: string): Promise<string | null> };
  publishInval(msg: { v: 1; event: 'graph.rebuild'; userId: string; projectId: string }): Promise<void>;
};
export type RebuildResult = {
  mode: 'full' | 'files';
  counts: { walked: number; changed: number; unchanged: number; written: number; deleted: number; dependents: number; refused: number; failed: number; duplicates: number; skipped: number; embedded: number };
  files: {
    written: string[]; deleted: string[]; dependents: string[]; refused: string[];
    failed: { file: string; code: string }[]; duplicates: { id: string; file: string; owner: string }[]; skipped: { file: string; reason: string }[];
  };
  truncated: boolean;
  epoch: string | null;
};
export type RebuildOptions = {
  repos: Repositories;
  ctx: { userId: string; projectId: string };
  root: string;
  config: GraphConfig;
  files?: string[];
  force?: boolean;
  cache?: RebuildCache;
  embed?: Embed;
  log?: Log;
  signal?: AbortSignal;
  grammars?: Grammars;
};

type Replace = Parameters<Repositories['graph']['replaceSource']>[1];
type NodeIn = Replace['nodes'][number];
type Read = { ok: true; text: string } | { ok: false; reason: string };
type Item = { file: string; text: string; hash: string };

export const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (p: string): string => p.slice(0, Math.max(p.lastIndexOf('/'), 0));
const baseOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const NUL_SCAN = 8000;
const VECTOR_DIM = 1024;

/** Reads one file under the root: regular file whose real path stays inside the root, within the size limit, valid UTF-8 without NUL. */
export async function readText(rootReal: string, rel: string): Promise<Read> {
  if (!safeRel(rel)) return { ok: false, reason: 'bad_path' };
  const abs = path.join(rootReal, rel);
  try {
    const real = await fs.realpath(abs);
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return { ok: false, reason: 'symlink_outside' };
    const st = await fs.stat(real);
    if (!st.isFile()) return { ok: false, reason: 'not_file' };
    if (st.size > graphLimits.maxFileBytes) return { ok: false, reason: 'too_large' };
    const buf = await fs.readFile(real);
    if (buf.subarray(0, NUL_SCAN).includes(0)) return { ok: false, reason: 'binary' };
    try {
      return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(buf) };
    } catch {
      return { ok: false, reason: 'binary' };
    }
  } catch (e) {
    return { ok: false, reason: (e as { code?: string }).code === 'ENOENT' ? 'missing' : 'read_failed' };
  }
}

/** Node embed text: label, a newline, the node's source lines, cut to `embedTextChars` code points (label only without lines). */
export function embedText(label: string, meta: unknown, lines: string[] | null): string {
  const own = (meta as { embedText?: unknown } | null)?.embedText;
  if (typeof own === 'string') return Array.from(own.slice(0, graphLimits.embedTextChars * 2)).slice(0, graphLimits.embedTextChars).join('');
  const range = (meta as { lines?: unknown } | null)?.lines;
  let text = label;
  if (lines && Array.isArray(range)) {
    const [a, b] = range as unknown[];
    if (Number.isInteger(a) && Number.isInteger(b) && (a as number) >= 1 && (b as number) >= (a as number)) {
      text = `${label}\n${lines.slice((a as number) - 1, b as number).join('\n')}`;
    }
  }
  return Array.from(text.slice(0, graphLimits.embedTextChars * 2)).slice(0, graphLimits.embedTextChars).join('');
}

const cut = <T>(l: T[]): T[] => l.slice(0, graphLimits.resultListMax);
const noop = (): void => undefined;
const isVector = (v: unknown): v is number[] => Array.isArray(v) && v.length === VECTOR_DIM && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/**
 * Brings the stored `ast` graph of the project at `root` up to date. `files` = only those files (more than `maxPayloadFiles` entries:
 * a full walk); `force` = re-extract unchanged files and bypass the shrink guard. Reports per-file problems in the result and throws only for
 * repository errors, the abort signal (after the epoch step ran) and `GrammarError`. Returns a JSON-safe result.
 */
export async function rebuildProject(o: RebuildOptions): Promise<RebuildResult> {
  const { repos, ctx, config, signal } = o;
  const log = o.log ?? noop;
  const force = o.force === true;
  const rootReal = await fs.realpath(o.root);
  const enabled = new Set(config.graph.languages);
  const inSet = (f: string): boolean => {
    const l = langOf(f);
    return l !== null && enabled.has(l);
  };
  const listed = o.files === undefined ? null : [...new Set(o.files)].sort(byCode);
  const mode: 'full' | 'files' = listed === null || listed.length > graphLimits.maxPayloadFiles ? 'full' : 'files';
  const skipped: Skip[] = [];
  const failed: { file: string; code: string }[] = [];
  const addSkips = (list: Skip[]): void => {
    for (const x of list) {
      // judgment (D8): a file that cannot be stat'ed may still exist, so it is a failed read and keeps its rows
      if (x.reason === 'unreadable') failed.push({ file: x.file, code: 'read_failed' });
      else skipped.push(x);
    }
  };
  const grammars = o.grammars ?? (await loadGrammars());

  // ---- what is in scope -----------------------------------------------------------------------------------------------
  let included: string[];
  let truncated = false;
  if (mode === 'full') {
    const w = await walkProject(rootReal, signal ? { signal } : {});
    included = w.files;
    truncated = w.truncated;
    addSkips(w.skipped);
  } else {
    const c = await checkPaths(rootReal, listed ?? [], signal ? { signal } : {});
    included = c.files;
    addSkips(c.skipped);
  }
  const extractSet = included.filter((f) => {
    if (inSet(f)) return true;
    if (mode === 'files') skipped.push({ file: f, reason: 'language' });
    return false;
  });
  const stored = new Map((await repos.graph.listSources(ctx)).map((s) => [s.file, s]));

  // ---- read and hash --------------------------------------------------------------------------------------------------
  const changedItems: Item[] = [];
  let unchanged = 0;
  const gone = new Set<string>();
  for (const f of extractSet) {
    signal?.throwIfAborted();
    const r = await readText(rootReal, f);
    if (!r.ok) {
      if (r.reason === 'read_failed') failed.push({ file: f, code: 'read_failed' });
      else {
        skipped.push({ file: f, reason: r.reason });
        gone.add(f);
      }
      continue;
    }
    const hash = contentHash(f, r.text);
    const old = stored.get(f);
    if (force || !old || old.contentHash !== hash || old.extractorVersion !== EXTRACTOR_VERSION) changedItems.push({ file: f, text: r.text, hash });
    else unchanged++;
  }
  const changedCount = changedItems.length;

  // ---- deletions: files that are no longer part of the graph -----------------------------------------------------------------
  const deletable = new Set<string>();
  const skippedNow = new Set([...skipped.map((s) => s.file), ...[...gone]]);
  if (mode === 'full' && !truncated) {
    const keep = new Set(extractSet.filter((f) => !gone.has(f)));
    for (const f of stored.keys()) if (f !== PACKAGES_SOURCE && !keep.has(f) && !failed.some((x) => x.file === f)) deletable.add(f);
  }
  for (const f of skippedNow) if (stored.has(f) && f !== PACKAGES_SOURCE) deletable.add(f);
  const deleted = [...deletable].sort(byCode);

  // ---- extract --------------------------------------------------------------------------------------------------------------
  const texts = new Map<string, string>(changedItems.map((i) => [i.file, i.text]));
  const hashes = new Map<string, string>(changedItems.map((i) => [i.file, i.hash]));
  const extractItems = (items: Item[]): ExtractResult[] => {
    const out: ExtractResult[] = [];
    for (const i of items) {
      const r = extractFile({ path: i.file, content: i.text }, grammars);
      if (r.error) failed.push({ file: i.file, code: r.error.code });
      else out.push(r);
    }
    return out;
  };
  let results = extractItems(changedItems);

  // ---- node sets, duplicates, shrink guard ------------------------------------------------------------------------------------
  const graph = await repos.graph.loadGraph(ctx);
  const nodeFile = new Map(graph.nodes.map((n) => [n.id, n.sourceFile]));
  const storedAst = new Map<string, string[]>();
  for (const n of graph.nodes) {
    if (n.origin !== 'ast' || n.sourceFile === null) continue;
    const l = storedAst.get(n.sourceFile);
    if (l) l.push(n.id);
    else storedAst.set(n.sourceFile, [n.id]);
  }
  const duplicates: { id: string; file: string; owner: string }[] = [];
  const keptIds = new Map<string, Set<string>>();
  const claim = (list: ExtractResult[]): void => {
    const runFiles = new Set([...list.map((r) => r.file), ...deleted]);
    const claimed = new Map<string, string>();
    for (const r of [...list].sort((a, b) => byCode(a.file, b.file))) {
      const keep = new Set<string>();
      for (const n of r.nodes) {
        const stale = nodeFile.get(n.id);
        const owner = stale !== undefined && stale !== null && stale !== r.file && !runFiles.has(stale) ? stale : claimed.get(n.id);
        if (owner !== undefined) duplicates.push({ id: n.id, file: r.file, owner });
        else {
          claimed.set(n.id, r.file);
          keep.add(n.id);
        }
      }
      keptIds.set(r.file, keep);
    }
  };
  claim(results);

  const refused: string[] = [];
  const guarded = (list: ExtractResult[]): ExtractResult[] =>
    list.filter((r) => {
      const old = storedAst.get(r.file)?.length ?? 0;
      const loss = old - (keptIds.get(r.file)?.size ?? 0);
      if (!force && loss >= graphLimits.shrinkMinLoss && loss / old > config.graph.shrink_guard) {
        refused.push(r.file);
        return false;
      }
      return true;
    });
  results = guarded(results);

  // ---- dependents: unchanged files whose stored edges point at an id that is gone ---------------------------------------------------
  const newIds = new Set<string>();
  for (const r of results) for (const id of keptIds.get(r.file) ?? []) newIds.add(id);
  const removed = new Set<string>();
  for (const f of [...results.map((r) => r.file), ...deleted]) for (const id of storedAst.get(f) ?? []) if (!newIds.has(id)) removed.add(id);
  const dependents: string[] = [];
  if (removed.size > 0) {
    const busy = new Set([...changedItems.map((i) => i.file), ...deleted]);
    const found = new Set<string>();
    for (const e of graph.edges) {
      if (e.origin !== 'ast' || !removed.has(e.dst)) continue;
      const f = nodeFile.get(e.src);
      if (f && !busy.has(f) && !gone.has(f) && stored.has(f) && inSet(f)) found.add(f);
    }
    const items: Item[] = [];
    // judgment: a candidate that a full walk would not include now (ignored, secret, symlink, missing) keeps its rows
    const reachable = (await checkPaths(rootReal, [...found].sort(byCode), signal ? { signal } : {})).files;
    for (const f of reachable) {
      const r = await readText(rootReal, f);
      if (!r.ok) continue; // judgment: a dependent that cannot be read keeps its rows
      texts.set(f, r.text);
      hashes.set(f, contentHash(f, r.text));
      items.push({ file: f, text: r.text, hash: hashes.get(f) as string });
    }
    const extra = extractItems(items);
    claim([...results, ...extra]);
    const kept = guarded(extra);
    dependents.push(...kept.map((r) => r.file));
    results = [...results, ...kept];
  }
  results.sort((a, b) => byCode(a.file, b.file));

  // ---- resolve ---------------------------------------------------------------------------------------------------------------------
  const resultFiles = new Set(results.map((r) => r.file));
  const deletedSet = new Set(deleted);
  const context: ContextNode[] = graph.nodes.filter(
    (n) => n.origin === 'ast' && n.sourceFile !== null && n.sourceFile !== PACKAGES_SOURCE && !resultFiles.has(n.sourceFile) && !deletedSet.has(n.sourceFile),
  );
  const resolutionFiles = mode === 'full' ? included : [...new Set([...stored.keys(), ...included])].filter((f) => f !== PACKAGES_SOURCE && !deletedSet.has(f));
  const packages: PackageJson[] = [];
  for (const f of resolutionFiles.filter((x) => baseOf(x) === 'package.json').slice(0, graphLimits.maxPackageJson)) {
    const text = texts.get(f) ?? (await (async () => { const r = await readText(rootReal, f); return r.ok ? r.text : null; })());
    if (text === null) continue;
    try {
      const j = JSON.parse(text) as { name?: unknown; exports?: unknown; main?: unknown };
      if (typeof j?.name === 'string') packages.push({ dir: dirOf(f), name: j.name, exports: j.exports, main: j.main });
    } catch {
      // judgment: a package.json that is not valid JSON is ignored for specifier resolution
    }
  }
  const resolved = resolveGraph({ results, context, files: resolutionFiles, packages });

  // ---- write ---------------------------------------------------------------------------------------------------------------------------
  let wrote = false;
  let aborted = false;
  const written: string[] = [];
  const writtenAll: string[] = [];
  const pkgLabels = new Map(resolved.packages.map((p) => [p.id, p.label]));
  const writtenEdgesPackages = new Set<string>();
  let failure: unknown;
  try {
    for (const f of deleted) {
      if (signal?.aborted) { aborted = true; break; }
      await repos.graph.deleteSource(ctx, { origin: 'ast', sourceFile: f });
      wrote = true;
    }
    for (const r of results) {
      if (aborted || signal?.aborted) { aborted = true; break; }
      const keep = keptIds.get(r.file) ?? new Set<string>();
      const lines = (texts.get(r.file) as string).split('\n');
      const reexports = resolved.reexports[r.file];
      const nodes: NodeIn[] = r.nodes
        .filter((n) => keep.has(n.id))
        .map((n) => {
          const meta = n.type === 'file' && reexports && reexports.length > 0 ? { ...n.meta, reexports } : n.meta;
          return { id: n.id, kind: n.kind, type: n.type, label: n.label, sourceLocation: n.sourceLocation, contentHash: sha(embedText(n.label, n.meta, lines)), meta };
        });
      const edges: Replace['edges'] = [
        // judgment: a `contains` edge to a node that a duplicate id handed to another file is dropped too (it would point into that file)
        ...r.edges.filter((e) => keep.has(e.src) && keep.has(e.dst)),
        ...(resolved.edges[r.file] ?? []).filter((e: ResolvedEdge) => keep.has(e.src)),
      ];
      await repos.graph.replaceSource(ctx, {
        origin: 'ast', sourceFile: r.file, nodes, edges,
        source: { contentHash: hashes.get(r.file) as string, extractorVersion: EXTRACTOR_VERSION, builtAtCommit: null },
      });
      wrote = true;
      writtenAll.push(r.file);
      if (!dependents.includes(r.file)) written.push(r.file);
      for (const e of edges) if (e.dst.startsWith('code:pkg:')) writtenEdgesPackages.add(e.dst);
    }

    // ---- package nodes (D18) ----------------------------------------------------------------------------------------------------------
    if (!aborted) {
      const touched = new Set([...writtenAll, ...deleted]);
      const needed = new Map<string, string>();
      for (const e of graph.edges) {
        const f = nodeFile.get(e.src);
        if (e.origin === 'ast' && e.dst.startsWith('code:pkg:') && f && !touched.has(f) && f !== PACKAGES_SOURCE) needed.set(e.dst, '');
      }
      for (const id of writtenEdgesPackages) needed.set(id, '');
      const storedPkg = graph.nodes.filter((n) => n.sourceFile === PACKAGES_SOURCE);
      for (const n of storedPkg) pkgLabels.set(n.id, pkgLabels.get(n.id) ?? n.label);
      const ids = [...needed.keys()].sort(byCode);
      const storedIds = storedPkg.map((n) => n.id).sort(byCode);
      const same = ids.length === storedIds.length && ids.every((id, i) => id === storedIds[i]);
      if (!same) {
        if (ids.length === 0) await repos.graph.deleteSource(ctx, { origin: 'ast', sourceFile: PACKAGES_SOURCE });
        else {
          await repos.graph.replaceSource(ctx, {
            origin: 'ast', sourceFile: PACKAGES_SOURCE,
            nodes: ids.map((id) => {
              const label = pkgLabels.get(id) ?? id.slice('code:pkg:'.length);
              return { id, kind: 'code', type: 'package', label, sourceLocation: null, contentHash: sha(label), meta: {} };
            }),
            edges: [],
            source: { contentHash: sha(ids.join('\n')), extractorVersion: EXTRACTOR_VERSION, builtAtCommit: null },
          });
        }
        wrote = true;
      }
    }
  } catch (e) {
    failure = e; // the epoch step below still runs for what was committed, then the error is rethrown
  }

  // ---- epoch and invalidation (D19): the rows are committed, so a failure here is logged and ignored ------------------------------------
  let epoch: string | null = null;
  if (wrote) {
    try {
      await repos.projects.bumpEpoch(ctx, ctx.projectId, 'graph');
    } catch (e) {
      log('graph epoch bump failed', { error: e instanceof Error ? e.constructor.name : typeof e });
    }
    if (o.cache) {
      try {
        epoch = await o.cache.epoch.rotate('graph', ctx.userId, ctx.projectId);
      } catch (e) {
        log('graph epoch rotate failed', { error: e instanceof Error ? e.constructor.name : typeof e });
      }
      try {
        await o.cache.publishInval({ v: 1, event: 'graph.rebuild', userId: ctx.userId, projectId: ctx.projectId });
      } catch (e) {
        log('graph inval publish failed', { error: e instanceof Error ? e.constructor.name : typeof e });
      }
    }
  }
  if (failure !== undefined) throw failure;
  if (aborted) throw signal?.reason ?? new DOMException('aborted', 'AbortError');

  // ---- embeddings (D20) -----------------------------------------------------------------------------------------------------------------
  let embedded = 0;
  if (o.embed) {
    const fileLines = new Map<string, string[] | null>();
    const linesOf = async (f: string | null): Promise<string[] | null> => {
      if (f === null || f === PACKAGES_SOURCE) return null;
      if (!fileLines.has(f)) {
        const mem = texts.get(f);
        const r = mem === undefined ? await readText(rootReal, f) : { ok: true as const, text: mem };
        if (fileLines.size > 64) fileLines.clear();
        fileLines.set(f, r.ok ? r.text.split('\n') : null);
      }
      return fileLines.get(f) ?? null;
    };
    let afterId: string | undefined;
    for (;;) {
      if (signal?.aborted) break;
      const page = await repos.graph.pendingEmbeddings(ctx, { limit: graphLimits.embedBatch, ...(afterId === undefined ? {} : { afterId }) });
      if (page.length === 0) break;
      const batch: string[] = [];
      for (const n of page) batch.push(embedText(n.label, n.meta, await linesOf(n.sourceFile)));
      let vectors: number[][];
      try {
        vectors = await o.embed(batch);
      } catch (e) {
        log('graph embed failed', { error: e instanceof Error ? e.constructor.name : typeof e });
        break;
      }
      for (let i = 0; i < page.length; i++) {
        const v = vectors?.[i];
        if (!isVector(v)) {
          log('graph embed skipped a bad vector', { id: page[i]?.id });
          continue;
        }
        await repos.graph.setEmbedding(ctx, (page[i] as { id: string }).id, v, sha(batch[i] as string));
        embedded++;
      }
      afterId = (page[page.length - 1] as { id: string }).id;
    }
  }

  const dupSorted = duplicates.sort((a, b) => byCode(a.file, b.file) || byCode(a.id, b.id));
  const dedupDup = dupSorted.filter((d, i) => i === 0 || d.id !== (dupSorted[i - 1] as typeof d).id || d.file !== (dupSorted[i - 1] as typeof d).file);
  const skippedSorted = skipped.sort((a, b) => byCode(a.file, b.file) || byCode(a.reason, b.reason));
  const failedSorted = failed.sort((a, b) => byCode(a.file, b.file));
  const sortedRefused = [...new Set(refused)].sort(byCode);
  return {
    mode,
    counts: {
      walked: included.length, changed: changedCount, unchanged, written: written.length, deleted: deleted.length, dependents: dependents.length,
      refused: sortedRefused.length, failed: failedSorted.length, duplicates: dedupDup.length, skipped: skippedSorted.length, embedded,
    },
    files: {
      written: cut(written.sort(byCode)), deleted: cut(deleted), dependents: cut(dependents.sort(byCode)), refused: cut(sortedRefused),
      failed: cut(failedSorted), duplicates: cut(dedupDup), skipped: cut(skippedSorted),
    },
    truncated,
    epoch,
  };
}
