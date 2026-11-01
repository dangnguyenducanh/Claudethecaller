/**
 * `buildIndex`: the read-only RAM index of one project's graph (nodes by id, live edges per node, degrees, hub cut, label token index, vectors).
 * Called from: apps/web/src/graph (the RAM store), search.ts, resolve.ts, walk.ts (through `internalsOf`), and later the prompt hook (T5.1).
 * Why: every query reads the same structure, built once per graph load. Deliberately NOT done: reading the database, embedding anything,
 * editing the rows it is given (D6b). Untrusted: every field of every node, edge and vector.
 */
import { byCode, keyOf, normConfidence, queryLimits, weightOf, type GEdge, type GNode, type GraphIndex } from './model.ts';

/** What the queries need besides the public `GraphIndex`; reached through `internalsOf` only. */
export type Internals = {
  /** Distinct lowercase label tokens of length >= `tokenMin` per node. */
  tokensOf: Map<string, string[]>;
  /** Token -> ids of the nodes whose label has that token. */
  postings: Map<string, string[]>;
  /** Length of every vector in `vectors`; 0 when none are usable. */
  dim: number;
  /** Unit vectors by node id (empty when no usable vectors were given). */
  vectors: Map<string, Float32Array>;
  byKey: Map<string, string[]>;
  byKeyLower: Map<string, string[]>;
};

const INTERNALS = new WeakMap<GraphIndex, Internals>();
export const internalsOf = (index: GraphIndex): Internals => INTERNALS.get(index) as Internals;

/** Lowercase runs of letters and digits, distinct, at least `min` characters (D12). */
export function tokenize(text: string, min: number = queryLimits.tokenMin): string[] {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) if (m[0].length >= min) out.add(m[0]);
  return [...out];
}

function unitVectors(vectors: { id: string; embedding: ArrayLike<number> }[], nodes: ReadonlyMap<string, GNode>): { map: Map<string, Float32Array>; dim: number } {
  const map = new Map<string, Float32Array>();
  const dim = vectors[0]?.embedding.length ?? 0;
  // judgment: vectors of mixed lengths or with a non-finite value are all ignored (the dense channel is skipped, the lexical one still serves)
  for (const v of vectors) {
    if (v.embedding.length !== dim) return { map: new Map(), dim: 0 };
    for (let i = 0; i < dim; i++) if (!Number.isFinite(v.embedding[i])) return { map: new Map(), dim: 0 };
  }
  for (const v of vectors) {
    if (!nodes.has(v.id)) continue;
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += (v.embedding[i] as number) ** 2;
    if (norm === 0) continue;
    const u = new Float32Array(dim);
    const s = 1 / Math.sqrt(norm);
    for (let i = 0; i < dim; i++) u[i] = (v.embedding[i] as number) * s;
    map.set(v.id, u);
  }
  return { map, dim };
}

/** D10. Copies what it keeps; the arguments are never edited. */
export function buildIndex(o: { nodes: GNode[]; edges: GEdge[]; vectors?: { id: string; embedding: ArrayLike<number> }[]; hubMin?: number }): GraphIndex {
  const nodes = new Map<string, GNode>();
  for (const n of o.nodes) if (!nodes.has(n.id)) nodes.set(n.id, n);
  const kept = new Map<string, GEdge>();
  for (const e of o.edges) {
    if (!nodes.has(e.src) || !nodes.has(e.dst) || e.confidence === 'DROPPED') continue;
    const edge: GEdge = { src: e.src, dst: e.dst, relation: e.relation, confidence: normConfidence(e.confidence), score: typeof e.score === 'number' ? e.score : 1 };
    const key = `${e.src}\u0000${e.dst}\u0000${e.relation}`;
    const old = kept.get(key);
    if (!old || weightOf(edge.confidence) > weightOf(old.confidence)) kept.set(key, edge);
  }
  const push = <T>(m: Map<string, T[]>, k: string, v: T): void => {
    const l = m.get(k);
    if (l) l.push(v);
    else m.set(k, [v]);
  };
  const outs = new Map<string, GEdge[]>();
  const ins = new Map<string, GEdge[]>();
  for (const e of kept.values()) {
    push(outs, e.src, e);
    push(ins, e.dst, e);
  }
  for (const l of outs.values()) l.sort((a, b) => byCode(a.relation, b.relation) || byCode(a.dst, b.dst));
  for (const l of ins.values()) l.sort((a, b) => byCode(a.relation, b.relation) || byCode(a.src, b.src));
  const none: readonly GEdge[] = [];
  const degree = (id: string): number => (outs.get(id)?.length ?? 0) + (ins.get(id)?.length ?? 0);

  const degrees = [...nodes.keys()].map(degree).sort((a, b) => a - b);
  const p99 = degrees.length === 0 ? 0 : (degrees[Math.ceil(0.99 * degrees.length) - 1] as number);
  const hubCut = Math.max(o.hubMin ?? queryLimits.hubMin, p99);

  const tokensOf = new Map<string, string[]>();
  const postings = new Map<string, string[]>();
  const byKey = new Map<string, string[]>();
  const byKeyLower = new Map<string, string[]>();
  for (const n of nodes.values()) {
    const tokens = tokenize(n.label);
    tokensOf.set(n.id, tokens);
    for (const t of tokens) push(postings, t, n.id);
    const k = keyOf(n.label);
    push(byKey, k, n.id);
    push(byKeyLower, k.toLowerCase(), n.id);
  }
  const vec = unitVectors(o.vectors ?? [], nodes);

  const index: GraphIndex = { nodes, hubCut, degree, out: (id) => outs.get(id) ?? none, in: (id) => ins.get(id) ?? none };
  INTERNALS.set(index, { tokensOf, postings, dim: vec.dim, vectors: vec.map, byKey, byKeyLower });
  return index;
}
