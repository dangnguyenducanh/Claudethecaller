import { describe, expect, it } from 'vitest';
import {
  buildKeywordIndex, finalOrder, firstOrder, keywordTop, ndcgAt, normalize, QUERY_INSTRUCTIONS, queryText, recallAt, rrf, sigmoid, tokenize, topCosine,
} from './index.ts';

const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;

describe('queryText (D13)', () => {
  it('pins the two instruction strings and falls back to skillret', () => {
    expect({ ...QUERY_INSTRUCTIONS }).toEqual({
      coding: 'Instruct: Given a coding task or question, retrieve capabilities (skills, agents, commands, workflows) that help accomplish it\nQuery: ',
      skillret: 'Instruct: Given a skill search query, retrieve relevant skills that match the query\nQuery: ',
    });
    expect(queryText('p', 'coding')).toBe(QUERY_INSTRUCTIONS.coding + 'p');
    expect(queryText('p', 'nope')).toBe(QUERY_INSTRUCTIONS.skillret + 'p');
    expect(queryText('p', 'constructor')).toBe(QUERY_INSTRUCTIONS.skillret + 'p');
  });
});

describe('normalize and topCosine (D15)', () => {
  it('normalises, returns null for zero or non-finite', () => {
    expect(Array.from(normalize([3, 4]) as Float32Array)).toEqual([Math.fround(0.6), Math.fround(0.8)]);
    expect(normalize([0, 0])).toBeNull();
    expect(normalize([1, Number.NaN])).toBeNull();
    expect(normalize([])).toBeNull();
  });
  it('ranks by cosine, ties by lower index, cuts at n, zero query is empty', () => {
    const rows = [[1, 0], [0, 1], [1, 1], [1, 0]].map((r) => normalize(r) as Float32Array);
    const m = new Float32Array(8);
    rows.forEach((r, i) => m.set(r, i * 2));
    expect(topCosine(m, 2, [3, 0], 3).map((s) => [s.index, Math.round(s.score * 1e4) / 1e4])).toEqual([[0, 1], [3, 1], [2, 0.7071]]);
    expect(topCosine(m, 2, [0, 0], 3)).toEqual([]);
    expect(topCosine(m, 2, [1, 0, 0], 3)).toEqual([]);
    expect(topCosine(m, 2, [1, 0], 0)).toEqual([]);
    expect(topCosine(m, 2, [1, 0], 99)).toHaveLength(4);
  });
  it('does not edit its inputs', () => {
    const m = new Float32Array([1, 0]);
    const q = Object.freeze([2, 0]);
    expect(topCosine(m, 2, q, 1)).toHaveLength(1);
    expect(Array.from(m)).toEqual([1, 0]);
    expect(q).toEqual([2, 0]);
  });
});

describe('keyword leg (D16)', () => {
  it('tokenizes with NFKC, lower case and non letter/digit splits', () => {
    expect(tokenize('Héllo-World_x 42 ÄB ﬁle')).toEqual(['héllo', 'world', 'x', '42', 'äb', 'file']);
    expect(tokenize('')).toEqual([]);
  });
  it('scores BM25 (k1 1.2, b 0.75), only > 0, ties by lower index', () => {
    const idx = buildKeywordIndex(['tdd red green', 'red', 'blue sky', 'red']);
    const got = keywordTop(idx, 'Red tdd red', 10);
    const N = 4;
    const avg = 7 / 4;
    const idf = (df: number): number => Math.log(1 + (N - df + 0.5) / (df + 0.5));
    const bm = (tf: number, len: number): number => (tf * 2.2) / (tf + 1.2 * (1 - 0.75 + 0.75 * (len / avg)));
    expect(got.map((s) => s.index)).toEqual([0, 1, 3]);
    expect(near(got[0]!.score, idf(3) * bm(1, 3) + idf(1) * bm(1, 3))).toBe(true);
    expect(near(got[1]!.score, idf(3) * bm(1, 1))).toBe(true);
    expect(keywordTop(idx, 'zzz', 5)).toEqual([]);
    expect(keywordTop(idx, 'red', 1)).toHaveLength(1);
    expect(keywordTop(buildKeywordIndex([]), 'red', 5)).toEqual([]);
  });
});

describe('fusion (D17)', () => {
  it('rrf sums weight / (k + rank)', () => {
    const m = rrf([['a', 'b'], ['b', 'c']], [1, 0.5], 60);
    expect(near(m.get('a') as number, 1 / 61)).toBe(true);
    expect(near(m.get('b') as number, 1 / 62 + 0.5 / 61)).toBe(true);
    expect(near(m.get('c') as number, 0.5 / 62)).toBe(true);
  });
  const ids = ['a', 'b', 'c'];
  const base = { ids, cosine: (i: number) => [0.9, 0.8, 0.1][i] as number, rrfK: 60 };
  it('rrf: keyword weight lifts a keyword-only match; weight 0 leaves the dense order', () => {
    const dense = [{ index: 0, score: 0.9 }, { index: 1, score: 0.8 }];
    const keyword = [{ index: 2, score: 3 }, { index: 1, score: 1 }];
    const r = (w: number) => firstOrder({ ...base, dense, keyword, ranking: { keyword_rrf_weight: w, fusion: 'rrf', score_w: 0.7 } });
    expect(r(0)).toEqual(['a', 'b', 'c']);
    expect(r(1)).toEqual(['b', 'a', 'c']);
  });
  it('score fusion: (1 - score_w) * kw / max + score_w * cosine; keyword-only ids use their cosine', () => {
    const dense = [{ index: 0, score: 0.9 }];
    const keyword = [{ index: 2, score: 4 }, { index: 1, score: 2 }];
    const s = (w: number) => firstOrder({ ...base, dense, keyword, ranking: { keyword_rrf_weight: 0, fusion: 'score', score_w: w } });
    expect(s(1)).toEqual(['a', 'b', 'c']);
    expect(s(0.5)).toEqual(['b', 'c', 'a']);
    expect(s(0)).toEqual(['c', 'b', 'a']);
  });
  it('breaks ties by dense rank, keyword rank, then capId', () => {
    const tie = firstOrder({ ids: ['y', 'x'], cosine: () => 0, rrfK: 60, dense: [], keyword: [], ranking: { keyword_rrf_weight: 0, fusion: 'rrf', score_w: 0 } });
    expect(tie).toEqual([]);
    const both = firstOrder({
      ids: ['y', 'x'], cosine: () => 0.5, rrfK: 60, dense: [{ index: 0, score: 0.5 }, { index: 1, score: 0.5 }], keyword: [],
      ranking: { keyword_rrf_weight: 0, fusion: 'score', score_w: 1 },
    });
    expect(both).toEqual(['y', 'x']);
    const byId = firstOrder({
      ids: ['y', 'x'], cosine: () => 0.5, rrfK: 60, dense: [], keyword: [{ index: 0, score: 1 }, { index: 1, score: 1 }],
      ranking: { keyword_rrf_weight: 0, fusion: 'score', score_w: 0 },
    });
    expect(byId).toEqual(['y', 'x']);
  });
});

describe('finalOrder (D18)', () => {
  const first = ['a', 'b', 'c'];
  const o = { rerankTop: 20, rerankWeight: 1, rrfK: 60 };
  it('fuses the pool order with the rerank order; ties keep the first order', () => {
    expect(finalOrder(first, [-5, 0, 5], o)).toEqual(['a', 'c', 'b']);
    expect(finalOrder(first, [-5, 0, 5], { ...o, rerankWeight: 3 })).toEqual(['c', 'b', 'a']);
  });
  it('only the pool is re-sorted; the rest follows unchanged', () => {
    expect(finalOrder(first, [-5, 0], { ...o, rerankTop: 2 })).toEqual(['a', 'b', 'c']);
    expect(finalOrder(first, [0, 9], { ...o, rerankTop: 2, rerankWeight: 5 })).toEqual(['b', 'a', 'c']);
  });
  it('weight 0, no logits or a length mismatch leave the first order', () => {
    expect(finalOrder(first, [0, 0, 9], { ...o, rerankWeight: 0 })).toEqual(first);
    expect(finalOrder(first, undefined, o)).toEqual(first);
    expect(finalOrder(first, [1], o)).toEqual(first);
  });
  it('sigmoid', () => {
    expect(near(sigmoid(0), 0.5)).toBe(true);
    expect(sigmoid(-1000)).toBe(0);
  });
});

describe('metrics (D22)', () => {
  const idcg2 = 1 + 1 / Math.log2(3);
  it('ndcgAt: linear gain, log2, repeats once, no relevant gives 0', () => {
    expect(near(ndcgAt(['a', 'x', 'b'], { a: 1, b: 1 }, 10), 1.5 / idcg2)).toBe(true);
    expect(near(ndcgAt(['a', 'a', 'b'], { a: 1, b: 1 }, 10), 1.5 / idcg2)).toBe(true);
    expect(near(ndcgAt(['b', 'a'], { a: 2, b: 1 }), (1 + 2 / Math.log2(3)) / (2 + 1 / Math.log2(3)))).toBe(true);
    expect(ndcgAt(['x', 'a'], { a: 1 }, 1)).toBe(0);
    expect(ndcgAt(['a'], {}, 10)).toBe(0);
    expect(ndcgAt(['constructor'], { a: 1 })).toBe(0);
  });
  it('recallAt', () => {
    const rel = { a: 1, b: 1, c: 0 };
    expect([recallAt(['x', 'a'], rel, 1), recallAt(['x', 'a'], rel, 2), recallAt(['a'], { a: 0 }, 5)]).toEqual([0, 0.5, 0]);
  });
});
