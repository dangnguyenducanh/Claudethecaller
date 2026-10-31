/**
 * Skill search maths: query prefix, cosine top-n, BM25 keyword leg, rank fusion, rerank order, NDCG / recall.
 * Called from: apps/web/src/skills (the skill seed channel) and the gate test `suggest.skills`.
 * Why: these are pure functions so the web channel stays a thin loader around them and every ordering rule has one home (D15-D18, D22).
 * Deliberately NOT done: any I/O (no files, no network), embedding, reranking, Postgres, caching, logging.
 * Untrusted: every argument (rows and vectors may come from Postgres, scores from TEI); bad numbers give empty or null results, never a throw.
 */

/** The two query prefixes the embedding model was trained with; they must match exactly (D13). */
export const QUERY_INSTRUCTIONS = {
  coding: 'Instruct: Given a coding task or question, retrieve capabilities (skills, agents, commands, workflows) that help accomplish it\nQuery: ',
  skillret: 'Instruct: Given a skill search query, retrieve relevant skills that match the query\nQuery: ',
} as const;

export type Scored = { index: number; score: number };
export type Ranking = { keyword_rrf_weight: number; rerank_weight: number; fusion: string; score_w: number; rerank_by?: string };
export type KeywordIndex = { n: number; avgLen: number; lens: number[]; postings: Map<string, [number, number][]> };

/** Okapi BM25 constants (D16). */
const K1 = 1.2;
const B = 0.75;

/** Query text for the embedder: the prefix of `instruction` plus the prompt. An unknown instruction uses `skillret` (judgment: tolerant, D8). */
export function queryText(prompt: string, instruction: string): string {
  const prefix = Object.hasOwn(QUERY_INSTRUCTIONS, instruction) ? QUERY_INSTRUCTIONS[instruction as keyof typeof QUERY_INSTRUCTIONS] : QUERY_INSTRUCTIONS.skillret;
  return prefix + prompt;
}

/** L2-normalised copy of `v`, or `null` when it is empty, all zeros or holds a non-finite number. Never edits `v`. */
export function normalize(v: ArrayLike<number>): Float32Array | null {
  const out = new Float32Array(v.length);
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] as number;
    if (typeof x !== 'number' || !Number.isFinite(x)) return null;
    sum += x * x;
  }
  const norm = Math.sqrt(sum);
  if (v.length === 0 || norm === 0 || !Number.isFinite(norm)) return null;
  for (let i = 0; i < v.length; i++) out[i] = (v[i] as number) / norm;
  return out;
}

const byScore = (a: Scored, b: Scored): number => b.score - a.score || a.index - b.index;

/**
 * The `n` rows of `matrix` (`rows × dim`, rows already L2-normalised) with the highest dot product with the normalised `query`, as
 * `{ index, score }` sorted by score desc, ties by lower index. No floor. A zero / non-finite / wrong-length query or `n < 1` gives `[]`.
 */
export function topCosine(matrix: Float32Array, dim: number, query: ArrayLike<number>, n: number): Scored[] {
  const q = normalize(query);
  if (!q || q.length !== dim || dim < 1 || !(n >= 1)) return [];
  const rows = Math.floor(matrix.length / dim);
  const all: Scored[] = new Array(rows);
  for (let r = 0; r < rows; r++) {
    let dot = 0;
    const base = r * dim;
    for (let j = 0; j < dim; j++) dot += (matrix[base + j] as number) * (q[j] as number);
    all[r] = { index: r, score: dot };
  }
  return all.sort(byScore).slice(0, Math.floor(n));
}

/** NFKC, lower-cased, split on every run of non letters / digits, empty tokens dropped (D16). */
export function tokenize(s: string): string[] {
  return String(s).normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t !== '');
}

/** Inverted index over `docs` (row i = docs[i]) for `keywordTop`. */
export function buildKeywordIndex(docs: string[]): KeywordIndex {
  const postings = new Map<string, [number, number][]>();
  const lens: number[] = [];
  docs.forEach((doc, i) => {
    const tokens = tokenize(doc);
    lens.push(tokens.length);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [t, c] of tf) {
      const list = postings.get(t);
      if (list) list.push([i, c]);
      else postings.set(t, [[i, c]]);
    }
  });
  const total = lens.reduce((a, b) => a + b, 0);
  return { n: docs.length, avgLen: docs.length === 0 ? 0 : total / docs.length, lens, postings };
}

/** BM25 over the unique tokens of `query`: the `n` rows with score > 0, score desc, ties by lower index. */
export function keywordTop(index: KeywordIndex, query: string, n: number): Scored[] {
  if (!(n >= 1)) return [];
  const scores = new Map<number, number>();
  const avg = index.avgLen || 1;
  for (const t of new Set(tokenize(query))) {
    const list = index.postings.get(t);
    if (!list) continue;
    const idf = Math.log(1 + (index.n - list.length + 0.5) / (list.length + 0.5));
    for (const [i, tf] of list) {
      const len = index.lens[i] as number;
      scores.set(i, (scores.get(i) ?? 0) + (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * len) / avg)));
    }
  }
  const out: Scored[] = [];
  for (const [row, score] of scores) if (score > 0) out.push({ index: row, score });
  return out.sort(byScore).slice(0, Math.floor(n));
}

/** Weighted reciprocal rank fusion: `Σ weights[l] / (k + rank_l(id))`, ranks 1-based; a missing weight is 1. */
export function rrf(lists: string[][], weights: number[], k: number): Map<string, number> {
  const out = new Map<string, number>();
  lists.forEach((list, l) => {
    const w = weights[l] ?? 1;
    list.forEach((id, i) => out.set(id, (out.get(id) ?? 0) + w / (k + i + 1)));
  });
  return out;
}

export type FirstInput = {
  dense: Scored[];
  keyword: Scored[];
  ids: readonly string[];
  /** Cosine of row `i` with the prompt vector (used by `fusion: 'score'`). */
  cosine(i: number): number;
  ranking: Pick<Ranking, 'keyword_rrf_weight' | 'fusion' | 'score_w'>;
  rrfK: number;
};

/**
 * First order over the union of both legs (D17): capIds, best first. `fusion 'rrf'` = weighted RRF (dense weight 1);
 * `fusion 'score'` = `(1 - score_w) * keyword / max keyword + score_w * cosine`. Ties: dense rank, keyword rank, capId in code-unit order.
 */
export function firstOrder(a: FirstInput): string[] {
  const denseRank = new Map<number, number>();
  const kwRank = new Map<number, number>();
  a.dense.forEach((s, r) => denseRank.set(s.index, r));
  a.keyword.forEach((s, r) => kwRank.set(s.index, r));
  const union = [...new Set([...denseRank.keys(), ...kwRank.keys()])];
  const score = new Map<number, number>();
  if (a.ranking.fusion === 'score') {
    const max = a.keyword.reduce((m, s) => Math.max(m, s.score), 0);
    const kw = new Map(a.keyword.map((s) => [s.index, s.score]));
    for (const i of union) {
      const k = max > 0 ? (kw.get(i) ?? 0) / max : 0;
      score.set(i, (1 - a.ranking.score_w) * k + a.ranking.score_w * a.cosine(i));
    }
  } else {
    const fused = rrf(
      [a.dense.map((s) => a.ids[s.index] as string), a.keyword.map((s) => a.ids[s.index] as string)],
      [1, a.ranking.keyword_rrf_weight],
      a.rrfK,
    );
    for (const i of union) score.set(i, fused.get(a.ids[i] as string) ?? 0);
  }
  const pos = (m: Map<number, number>, i: number): number => m.get(i) ?? Number.POSITIVE_INFINITY;
  return union
    .sort((x, y) => {
      const byFused = (score.get(y) as number) - (score.get(x) as number);
      if (byFused !== 0) return byFused;
      const d = pos(denseRank, x) - pos(denseRank, y);
      if (d !== 0 && !Number.isNaN(d)) return d;
      const k = pos(kwRank, x) - pos(kwRank, y);
      if (k !== 0 && !Number.isNaN(k)) return k;
      const ix = a.ids[x] as string;
      const iy = a.ids[y] as string;
      return ix < iy ? -1 : ix > iy ? 1 : 0;
    })
    .map((i) => a.ids[i] as string);
}

/**
 * Final order (D18): the first `rerankTop` of `first` are re-sorted by `rrf([pool, rerankOrder], [1, weight], rrfK)` (ties by first-order
 * position) and followed by the rest. `logits[i]` is the reranker score of `first[i]`. Weight 0, no logits or a length mismatch: `first` unchanged.
 */
export function finalOrder(first: string[], logits: readonly number[] | undefined, o: { rerankTop: number; rerankWeight: number; rrfK: number }): string[] {
  const top = Math.max(0, Math.floor(o.rerankTop));
  const pool = first.slice(0, top);
  if (o.rerankWeight === 0 || !logits || logits.length !== pool.length) return first.slice();
  const rerankOrder = pool.map((_, i) => i).sort((x, y) => (logits[y] as number) - (logits[x] as number) || x - y).map((i) => pool[i] as string);
  const fused = rrf([pool, rerankOrder], [1, o.rerankWeight], o.rrfK);
  const position = new Map(pool.map((id, i) => [id, i]));
  const sorted = pool.slice().sort((x, y) => (fused.get(y) as number) - (fused.get(x) as number) || (position.get(x) as number) - (position.get(y) as number));
  return [...sorted, ...first.slice(top)];
}

export const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/** NDCG@k with linear gain; an id repeated in `ranked` counts once, at its first position; `0` when nothing is relevant (D22). */
export function ndcgAt(ranked: string[], rel: Record<string, number>, k = 10): number {
  const gain = (id: string): number => (Object.hasOwn(rel, id) ? Math.max(0, rel[id] as number) : 0);
  const seen = new Set<string>();
  let dcg = 0;
  ranked.slice(0, k).forEach((id, i) => {
    if (seen.has(id)) return;
    seen.add(id);
    dcg += gain(id) / Math.log2(i + 2);
  });
  const ideal = Object.keys(rel).map(gain).sort((a, b) => b - a).slice(0, k);
  const idcg = ideal.reduce((s, g, i) => s + g / Math.log2(i + 2), 0);
  return idcg === 0 ? 0 : dcg / idcg;
}

/** Share of the relevant ids (`rel > 0`) found in the first `k` of `ranked`; `0` when none is relevant. */
export function recallAt(ranked: string[], rel: Record<string, number>, k: number): number {
  const relevant = Object.keys(rel).filter((id) => (rel[id] as number) > 0);
  if (relevant.length === 0) return 0;
  const top = new Set(ranked.slice(0, k));
  return relevant.filter((id) => top.has(id)).length / relevant.length;
}
