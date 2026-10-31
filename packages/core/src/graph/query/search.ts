/**
 * Search over the RAM graph: lexical seeds (token tiers x IDF x coverage squared), dense seeds (cosine against stored vectors), and the
 * breadth-first walk that spreads a seed's score over its neighbours (spec:305-309). Called from: apps/web/src/graph (`graph_search`,
 * `GET /api/graph/search`) and later the prompt hook and the note before a tool (T5.1, T5.2), which reuse `lexicalSeeds`, `denseSeeds`, `walkFrom`.
 * Why: one query finds the code, spec, task and decision nodes that answer a question without grepping. Deliberately NOT done: embedding the
 * query (the caller passes the vector), the skill channel, ranking "one of each kind", a latency budget. Untrusted: query, vector, types, labels.
 */
import { internalsOf, tokenize } from './build.ts';
import { byCode, clean, intOption, nodeRef, queryLimits, QueryError, weightOf, type GNode, type GraphIndex, type NodeRef } from './model.ts';

export type Seed = { id: string; score: number };
export type Hit = NodeRef & { score: number; hop: number; via: { from: string; relation: string } | null };
export type SearchResult = { query: string; total: number; hits: Hit[] };

type Raw = { id: string; hop: number; score: number; via: { from: string; relation: string } | null };

const bySeed = (a: Seed, b: Seed): number => b.score - a.score || byCode(a.id, b.id);
const typeFilter = (types: string[] | undefined): Set<string> | null => (types && types.length > 0 ? new Set(types) : null);

/** Top `max` (default `queryLimits.seeds`) nodes by token tier x IDF x coverage squared, best normalised to 1 (D12). Pure; no tokens gives `[]`. */
export function lexicalSeeds(index: GraphIndex, query: string, o: { types?: string[]; max?: number } = {}): Seed[] {
  const tokens = tokenize(typeof query === 'string' ? query : '');
  if (tokens.length === 0) return [];
  const { postings } = internalsOf(index);
  const types = typeFilter(o.types);
  const sum = new Map<string, number>();
  const matched = new Map<string, number>();
  for (const t of tokens) {
    const idf = Math.log(1 + index.nodes.size / (1 + (postings.get(t)?.length ?? 0)));
    const tier = new Map<string, number>();
    for (const [w, ids] of postings) {
      const v = w === t ? 1000 : w.startsWith(t) ? 100 : w.includes(t) ? 1 : 0;
      if (v === 0) continue;
      for (const id of ids) if (v > (tier.get(id) ?? 0)) tier.set(id, v);
    }
    for (const [id, v] of tier) {
      sum.set(id, (sum.get(id) ?? 0) + v * idf);
      matched.set(id, (matched.get(id) ?? 0) + 1);
    }
  }
  const scored: Seed[] = [];
  for (const [id, s] of sum) {
    if (types && !types.has(index.nodes.get(id)?.type ?? '')) continue;
    const c = (matched.get(id) ?? 0) / tokens.length;
    scored.push({ id, score: s * c * c });
  }
  scored.sort(bySeed);
  const top = scored.slice(0, o.max ?? queryLimits.seeds).filter((s) => s.score > 0);
  const best = top[0]?.score ?? 1;
  return top.map((s) => ({ id: s.id, score: s.score / best }));
}

/** Top `max` (default `queryLimits.denseSeeds`) nodes whose cosine to `queryVector` is at least `floor` (default `queryLimits.floor`). A vector of the wrong length or with a non-finite value gives `[]` (D5). */
export function denseSeeds(index: GraphIndex, queryVector: ArrayLike<number>, o: { types?: string[]; floor?: number; max?: number } = {}): Seed[] {
  const { vectors, dim } = internalsOf(index);
  if (dim === 0 || !queryVector || queryVector.length !== dim) return [];
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    const x = queryVector[i];
    if (typeof x !== 'number' || !Number.isFinite(x)) return [];
    norm += x * x;
  }
  if (norm === 0) return [];
  const scale = 1 / Math.sqrt(norm);
  const floor = o.floor ?? queryLimits.floor;
  const types = typeFilter(o.types);
  const found: Seed[] = [];
  for (const [id, u] of vectors) {
    if (types && !types.has(index.nodes.get(id)?.type ?? '')) continue;
    let dot = 0;
    for (let i = 0; i < dim; i++) dot += (u[i] as number) * (queryVector[i] as number);
    const cos = dot * scale;
    if (cos >= floor) found.push({ id, score: cos });
  }
  return found.sort(bySeed).slice(0, o.max ?? queryLimits.denseSeeds);
}

/** Breadth-first walk in both directions; see D12. Seeds are always expanded, a non-seed node at or above `hubCut` is reported but not expanded. Unordered hits. */
function walkRaw(index: GraphIndex, seeds: Seed[], depth: number): Raw[] {
  const seen = new Map<string, Raw>();
  for (const s of seeds) {
    const old = seen.get(s.id);
    if (index.nodes.has(s.id) && (!old || s.score > old.score)) seen.set(s.id, { id: s.id, hop: 0, score: s.score, via: null });
  }
  let frontier = [...seen.values()].sort((a, b) => byCode(a.id, b.id));
  for (let hop = 1; hop <= depth && frontier.length > 0; hop++) {
    const next = new Map<string, Raw>();
    for (const x of frontier) {
      if (x.hop > 0 && index.degree(x.id) >= index.hubCut) continue;
      for (const [edges, outgoing] of [[index.out(x.id), true], [index.in(x.id), false]] as const) {
        for (const e of edges) {
          const y = outgoing ? e.dst : e.src;
          if (y === x.id || seen.has(y)) continue;
          const score = x.score * 0.5 * weightOf(e.confidence);
          const cur = next.get(y);
          if (!cur || score > cur.score) next.set(y, { id: y, hop, score, via: { from: x.id, relation: e.relation } });
        }
      }
    }
    for (const r of next.values()) seen.set(r.id, r);
    if (seen.size >= queryLimits.visitMax) break;
    frontier = [...next.values()].sort((a, b) => byCode(a.id, b.id));
  }
  return [...seen.values()];
}

const byHit = (a: Raw, b: Raw): number => a.hop - b.hop || b.score - a.score || byCode(a.id, b.id);

function toHit(index: GraphIndex, r: Raw): Hit {
  return { ...nodeRef(index.nodes.get(r.id) as GNode), score: r.score, hop: r.hop, via: r.via === null ? null : { from: clean(r.via.from), relation: clean(r.via.relation) } };
}

/** D12: every node reached from `seeds` within `depth` hops (seeds included), ordered hop asc, score desc, id asc. `types` filters what is reported, not what is walked. */
export function walkFrom(index: GraphIndex, seeds: Seed[], o: { depth?: number; types?: string[] } = {}): Hit[] {
  const depth = intOption(o.depth, queryLimits.depth, 0, queryLimits.depthMax, 'depth');
  const types = typeFilter(o.types);
  return walkRaw(index, seeds, depth)
    .filter((r) => !types || types.has(index.nodes.get(r.id)?.type ?? ''))
    .sort(byHit)
    .map((r) => toHit(index, r));
}

/** D12. Throws `QueryError` `invalid` for an empty query or an out-of-range `limit`, `depth`, `seeds`. */
export function searchGraph(
  index: GraphIndex,
  o: { query: string; types?: string[]; limit?: number; queryVector?: ArrayLike<number> | null; seeds?: number; depth?: number; floor?: number },
): SearchResult {
  const limit = intOption(o.limit, queryLimits.searchDefault, 1, queryLimits.searchMax, 'limit');
  const depth = intOption(o.depth, queryLimits.depth, 0, queryLimits.depthMax, 'depth');
  const seedCount = intOption(o.seeds, queryLimits.seeds, 1, queryLimits.searchMax, 'seeds');
  const raw = typeof o.query === 'string' ? o.query.trim() : '';
  const query = raw.length > queryLimits.queryMax ? Array.from(raw).slice(0, queryLimits.queryMax).join('').trim() : raw;
  if (query === '') throw new QueryError('invalid', 'query must not be empty');
  const sel = { ...(o.types ? { types: o.types } : {}) };
  const seeds = new Map<string, Seed>();
  const dense = o.queryVector ? denseSeeds(index, o.queryVector, { ...sel, ...(o.floor !== undefined ? { floor: o.floor } : {}) }) : [];
  for (const s of [...lexicalSeeds(index, query, { ...sel, max: seedCount }), ...dense]) {
    const old = seeds.get(s.id);
    if (!old || s.score > old.score) seeds.set(s.id, s);
  }
  const types = typeFilter(o.types);
  const all = walkRaw(index, [...seeds.values()].sort(bySeed), depth)
    .filter((r) => !types || types.has(index.nodes.get(r.id)?.type ?? ''))
    .sort(byHit);
  return { query: clean(query), total: all.length, hits: all.slice(0, limit).map((r) => toHit(index, r)) };
}
