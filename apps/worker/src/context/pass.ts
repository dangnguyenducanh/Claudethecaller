/**
 * Context pass: reads the repo documents, parses them into `ctx:` nodes, resolves their code references against the stored `ast` graph and writes the rows with origin `parser`.
 *
 * Called from: handlers.ts (`withContextPass`, after the T2.2 rebuild) and tests. Why it exists: spec:284 "Parse context", DECISIONS D7, D10, D11.
 * Deliberately NOT done: SQL (repos only), writing under the root, parsing capabilities (capability.ts), the model call (extract.ts), re-resolving the code edges of an
 * unchanged document when only the code changed (they follow the next time that document is processed), deleting `ast`, `review` or `session` rows.
 * Untrusted: every file under the root, every `files` entry, the stored rows.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { isContextPath, parseContext, resolveRefs } from '@ctc/core/context';
import type { ContextParse } from '@ctc/core/context';
import type { Repositories } from '@ctc/shared/repositories';
import { graphLimits, PACKAGES_SOURCE } from '../graph/limits.ts';
import { embedText, readText, sha, type Embed, type Log, type RebuildCache } from '../graph/rebuild.ts';
import { checkPaths, walkProject, type Skip } from '../graph/walk.ts';
import type { SubmitInput } from '../library/scan.ts';
import { announceWrite } from './epoch.ts';
import { contextWorkerLimits } from './limits.ts';

export type Submit = (input: SubmitInput) => Promise<unknown>;
export type PassCache = RebuildCache;
export type ContextPassOptions = {
  repos: Repositories;
  ctx: { userId: string; projectId: string };
  root: string;
  files?: string[];
  force?: boolean;
  cache?: PassCache;
  embed?: Embed;
  submit?: Submit;
  log?: Log;
  signal?: AbortSignal;
};
export type ContextPassResult = {
  mode: 'full' | 'files';
  counts: { candidates: number; changed: number; unchanged: number; written: number; deleted: number; failed: number; ignored: number; edges: number; embedded: number; submitted: number };
  files: { written: string[]; deleted: string[]; failed: { file: string; code: string }[] };
  truncated: boolean;
  epoch: string | null;
};

type Parsed = { file: string; text: string; parse: ContextParse };
type RowEdge = { src: string; dst: string; relation: string; confidence: string; score: number };
type RowEdgeOut = RowEdge & { sourceLocation: string | null };
type Plan = { item: Parsed; edges: RowEdgeOut[]; changed: boolean };

const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const noop = (): void => undefined;
const VECTOR_DIM = 1024;
const isVector = (v: unknown): v is number[] => Array.isArray(v) && v.length === VECTOR_DIM && v.every((x) => typeof x === 'number' && Number.isFinite(x));
const cut = <T>(l: T[]): T[] => l.slice(0, contextWorkerLimits.resultListMax);
const synthetic = (f: string): boolean => f.startsWith('<');

/** JSON with sorted keys: Postgres `jsonb` does not keep key order, so stored and parsed `meta` are compared in this form. */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => byCode(a, b))) : x));
const edgeKey = (e: RowEdge): string => `${e.src}\0${e.dst}\0${e.relation}\0${e.confidence}\0${e.score.toFixed(3)}`;

/**
 * Brings the `parser` rows of the repo documents up to date. `files` = only those (more than `maxPayloadFiles` entries: a full walk); `force` = write unchanged documents too.
 * Reports per-file problems in the result and throws only for repository errors and the abort reason (after the epoch step ran). Returns a JSON-safe result.
 */
export async function contextPass(o: ContextPassOptions): Promise<ContextPassResult> {
  const { repos, ctx, signal } = o;
  const log = o.log ?? noop;
  const force = o.force === true;
  signal?.throwIfAborted();
  const rootReal = await fs.realpath(o.root);
  const listed = o.files === undefined ? null : [...new Set(o.files)].sort(byCode);
  const mode: 'full' | 'files' = listed === null || listed.length > contextWorkerLimits.maxPayloadFiles ? 'full' : 'files';
  const failed: { file: string; code: string }[] = [];
  const opts = signal ? { signal } : {};
  let included: string[];
  let skipped: Skip[];
  let truncated = false;
  let ignored = 0;
  let wanted: string[] = [];
  if (mode === 'full') {
    const w = await walkProject(rootReal, opts);
    included = w.files;
    skipped = w.skipped;
    truncated = w.truncated;
  } else {
    wanted = (listed as string[]).filter(isContextPath);
    ignored = (listed as string[]).length - wanted.length;
    const c = await checkPaths(rootReal, wanted, opts);
    included = c.files;
    skipped = c.skipped;
  }
  // judgment: a file that cannot be stat'ed may still exist, so it counts as a failed read and keeps its rows
  for (const s of skipped) if (s.reason === 'unreadable') failed.push({ file: s.file, code: 'read_failed' });
  const candidates = included.filter(isContextPath);

  // ---- read and parse -----------------------------------------------------------------------------------------------------------
  const parsed: Parsed[] = [];
  const gone = new Set<string>();
  let aborted = false;
  for (const f of candidates) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    const r = await readText(rootReal, f);
    if (!r.ok) {
      // judgment: only a file that vanished between the walk and the read counts as gone; any other read problem keeps the old rows
      if (r.reason === 'missing') gone.add(f);
      else failed.push({ file: f, code: r.reason });
      continue;
    }
    const parse = parseContext({ path: f, content: r.text });
    if (parse.error) failed.push({ file: f, code: parse.error.code });
    else parsed.push({ file: f, text: r.text, parse });
  }

  // ---- what is stored -------------------------------------------------------------------------------------------------------------
  const graph = await repos.graph.loadGraph(ctx);
  const storedNodes = new Map<string, typeof graph.nodes>();
  const nodeFile = new Map<string, string>();
  for (const n of graph.nodes) {
    if (n.origin !== 'parser' || n.sourceFile === null || synthetic(n.sourceFile)) continue;
    nodeFile.set(n.id, n.sourceFile);
    const l = storedNodes.get(n.sourceFile);
    if (l) l.push(n);
    else storedNodes.set(n.sourceFile, [n]);
  }
  const storedEdges = new Map<string, RowEdge[]>();
  const foreign = new Set<string>();
  for (const e of graph.edges) {
    if (e.origin === 'review' || e.origin === 'session') foreign.add(`${e.src}\0${e.dst}\0${e.relation}`);
    const f = nodeFile.get(e.src);
    if (e.origin !== 'parser' || f === undefined) continue;
    const l = storedEdges.get(f);
    if (l) l.push(e);
    else storedEdges.set(f, [e]);
  }

  // ---- deletions ----------------------------------------------------------------------------------------------------------------------
  const readable = new Set([...parsed.map((p) => p.file), ...failed.map((f) => f.file)]);
  const deletable = new Set<string>();
  if (!aborted) {
    if (mode === 'full') {
      if (!truncated) for (const f of storedNodes.keys()) if (!readable.has(f)) deletable.add(f);
    } else for (const f of wanted) if (storedNodes.has(f) && !readable.has(f)) deletable.add(f);
    for (const f of gone) if (storedNodes.has(f)) deletable.add(f);
    for (const p of parsed) if (p.parse.nodes.length === 0 && storedNodes.has(p.file)) deletable.add(p.file);
  }
  const deleted = [...deletable].sort(byCode);

  // ---- resolve and compare -------------------------------------------------------------------------------------------------------------
  const touched = new Set([...parsed.map((p) => p.file), ...deleted]);
  const refNodes = [
    ...graph.nodes.filter((n) => !(n.origin === 'parser' && n.sourceFile !== null && touched.has(n.sourceFile))).map((n) => ({ id: n.id, type: n.type, label: n.label, sourceFile: n.sourceFile })),
    ...parsed.flatMap((p) => p.parse.nodes.map((n) => ({ id: n.id, type: n.type, label: n.label, sourceFile: p.file }))),
  ];
  const plans: Plan[] = [];
  for (const p of parsed) {
    if (p.parse.nodes.length === 0) continue;
    const resolved = resolveRefs(p.parse.refs, refNodes);
    const all = new Map<string, RowEdgeOut>();
    for (const e of [...p.parse.edges, ...resolved]) all.set(`${e.src}\0${e.dst}\0${e.relation}`, e);
    const edges = [...all.values()].sort((a, b) => byCode(a.src, b.src) || byCode(a.dst, b.dst) || byCode(a.relation, b.relation));
    const lines = p.text.split('\n');
    const old = storedNodes.get(p.file) ?? [];
    const fresh = new Map(p.parse.nodes.map((n) => [n.id, n]));
    let same = old.length === fresh.size;
    for (const s of old) {
      const n = fresh.get(s.id);
      // judgment: the embed loop may have replaced the content hash by the hash of the embed text; both mean "unchanged"
      same &&= !!n && s.type === n.type && s.label === n.label && s.sourceLocation === n.sourceLocation && canon(s.meta) === canon(n.meta) && (s.contentHash === n.contentHash || s.contentHash === sha(embedText(n.label, n.meta, lines)));
    }
    if (same) {
      const have = new Set((storedEdges.get(p.file) ?? []).map(edgeKey));
      const want = edges.filter((e) => !foreign.has(`${e.src}\0${e.dst}\0${e.relation}`)).map(edgeKey);
      same = have.size === want.length && want.every((k) => have.has(k));
    }
    plans.push({ item: p, edges, changed: force || !same });
  }

  // ---- write ------------------------------------------------------------------------------------------------------------------------------
  let wrote = false;
  let failure: unknown;
  const written: string[] = [];
  const submits: { file: string; id: string }[] = [];
  let edgeCount = 0;
  try {
    for (const f of deleted) {
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      await repos.graph.deleteSource(ctx, { origin: 'claude', sourceFile: f, keepSource: true });
      await repos.graph.deleteSource(ctx, { origin: 'parser', sourceFile: f, keepSource: true });
      wrote = true;
    }
    for (const pl of plans) {
      if (!pl.changed) continue;
      if (aborted || signal?.aborted) {
        aborted = true;
        break;
      }
      const { item } = pl;
      await repos.graph.replaceSource(ctx, {
        origin: 'parser',
        sourceFile: item.file,
        nodes: item.parse.nodes.map((n) => ({ id: n.id, kind: n.kind, type: n.type, label: n.label, sourceLocation: n.sourceLocation, contentHash: n.contentHash, meta: n.meta })),
        edges: pl.edges.map((e) => ({ src: e.src, dst: e.dst, relation: e.relation, confidence: e.confidence, score: e.score, sourceLocation: e.sourceLocation })),
      });
      wrote = true;
      written.push(item.file);
      edgeCount += pl.edges.length;
      if (o.submit && item.parse.nodes.some((n) => n.type === 'task' || n.type === 'decision')) {
        submits.push({ file: item.file, id: createHash('sha256').update(`${item.file}\0${item.parse.nodes.map((n) => n.contentHash).join('\n')}`).digest('hex').slice(0, 16) });
      }
    }
  } catch (e) {
    failure = e;
  }

  // ---- epoch and invalidation: the rows are committed, so a failure here is logged and ignored ------------------------------------
  const epoch = wrote ? await announceWrite({ repos, ctx, cache: o.cache, log }) : null;
  if (failure !== undefined) throw failure;
  if (aborted) throw signal?.reason ?? new DOMException('aborted', 'AbortError');

  // ---- extract jobs ---------------------------------------------------------------------------------------------------------------------
  let submitted = 0;
  if (o.submit) {
    for (const s of submits.slice(0, contextWorkerLimits.maxExtractSubmit)) {
      try {
        await o.submit({ queue: 'graph', kind: 'extract', payload: { userId: ctx.userId, projectId: ctx.projectId, files: [s.file] }, id: `graph.extract:${ctx.projectId}:${s.id}` });
        submitted++;
      } catch (e) {
        log('graph extract submit failed', { error: e instanceof Error ? e.constructor.name : typeof e });
      }
    }
  }

  // ---- embeddings (D11) ---------------------------------------------------------------------------------------------------------------------
  let embedded = 0;
  if (o.embed) {
    const texts = new Map(parsed.map((p) => [p.file, p.text]));
    const fileLines = new Map<string, string[] | null>();
    const linesOf = async (f: string | null): Promise<string[] | null> => {
      if (f === null || f === PACKAGES_SOURCE || synthetic(f)) return null;
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
        const n = page[i] as (typeof page)[number];
        if (!isVector(v)) {
          log('graph embed skipped a bad vector', { id: n.id });
          continue;
        }
        // judgment: the node keeps its own content hash; replacing it by the hash of the embed text would make the next pass see a change
        await repos.graph.setEmbedding(ctx, n.id, v, n.contentHash);
        embedded++;
      }
      afterId = (page[page.length - 1] as { id: string }).id;
    }
  }

  const changedCount = plans.filter((p) => p.changed).length;
  const failedSorted = [...failed].sort((a, b) => byCode(a.file, b.file));
  return {
    mode,
    counts: {
      candidates: candidates.length, changed: changedCount, unchanged: plans.length - changedCount, written: written.length, deleted: deleted.length,
      failed: failedSorted.length, ignored, edges: edgeCount, embedded, submitted,
    },
    files: { written: cut(written.sort(byCode)), deleted: cut(deleted), failed: cut(failedSorted) },
    truncated,
    epoch,
  };
}
