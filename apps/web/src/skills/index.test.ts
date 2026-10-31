import { QUERY_INSTRUCTIONS } from '@ctc/core/skills';
import type { Repositories } from '@ctc/shared/repositories';
import { describe, expect, it } from 'vitest';
import { createSkillChannel, skillLimits, type SkillChannelDeps } from './index.ts';

const DIM = 4;
const Q = QUERY_INSTRUCTIONS.skillret;
/** unit vector at the given cosine with axis 0 */
const at = (c: number): number[] => [c, Math.sqrt(Math.max(0, 1 - c * c)), 0, 0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const names = (r: { hits: { name: string }[] }): string[] => r.hits.map((h) => h.name);
const deepFreeze = <T>(o: T): T => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };

type Row = { capId: string; namespace: string; kind: string; name: string; description: string; embedding: number[] };
type Ovr = { projectId: string | null; capId: string; action: string; label: null; version: null };
let seq = 0;
const row = (name: string, embedding: number[], o: Partial<Row> = {}): Row => ({ capId: `cap-${String(++seq).padStart(4, '0')}-${name}`, namespace: 'user', kind: 'skill', name, description: `desc ${name}`, embedding, ...o });

function world(init: { rows?: Record<string, Row[]>; ovr?: Record<string, Ovr[]> } = {}) {
  const w = { rows: init.rows ?? {}, ovr: init.ovr ?? {}, calls: [] as string[], failIndex: false, failOvr: false, delay: 0, delayAfter: 0 };
  const repos = {
    library: {
      async loadSkillIndex(ctx: { userId: string }) {
        w.calls.push('loadSkillIndex');
        if (w.delay && w.calls.filter((c) => c === 'loadSkillIndex').length > w.delayAfter) await sleep(w.delay);
        if (w.failIndex) throw new Error('db down');
        return (w.rows[ctx.userId] ?? []).map((r) => ({ ...r }));
      },
      async listOverrides(ctx: { userId: string }) {
        w.calls.push('listOverrides');
        if (w.failOvr) throw new Error('db down');
        return (w.ovr[ctx.userId] ?? []).map((r) => ({ userId: ctx.userId, ...r }));
      },
    },
  } as unknown as Repositories;
  return { w, repos };
}

type FakeTei = SkillChannelDeps['tei'] & { embeds: { texts: string[]; signal?: AbortSignal | undefined }[]; reranks: { query: string; texts: string[] }[]; qmap: Map<string, number[]>; rmap: Map<string, number>; mode: { embed: string; rerank: string } };
function fakeTei(): FakeTei {
  const t = {
    embeds: [] as FakeTei['embeds'], reranks: [] as FakeTei['reranks'], qmap: new Map<string, number[]>(), rmap: new Map<string, number>(), mode: { embed: 'ok', rerank: 'ok' },
    async embed(texts: string[], opts?: { signal?: AbortSignal }) {
      t.embeds.push({ texts, signal: opts?.signal });
      if (t.mode.embed === 'fail') throw new Error('tei down');
      if (t.mode.embed === 'baddim') return texts.map(() => [1, 0]);
      if (t.mode.embed === 'nan') return texts.map(() => [Number.NaN, 0, 0, 0]);
      return texts.map((x) => t.qmap.get(x) ?? [0, 0, 0, 1]);
    },
    async rerank(query: string, texts: string[]) {
      t.reranks.push({ query, texts });
      if (t.mode.rerank === 'fail') throw new Error('tei down');
      if (t.mode.rerank === 'short') return [1];
      return texts.map((x) => t.rmap.get(x) ?? 0);
    },
  };
  return t as FakeTei;
}
const cfg = (o: { k?: number; depth?: number; rerank_top?: number; instruction?: 'coding' | 'skillret'; ranking?: Partial<SkillChannelDeps['config']['ranking']> } = {}): SkillChannelDeps['config'] => ({
  k: o.k ?? 5, depth: o.depth ?? 50, rerank_top: o.rerank_top ?? 20, rrf_k: 60,
  ranking: { keyword_rrf_weight: 0, rerank_weight: 0, fusion: 'rrf', score_w: 0.7, rerank_by: 'sigmoid', ...o.ranking },
  embed: { text: 'skillret', instruction: o.instruction ?? 'skillret', skillret_body_chars: 8000 }, embedding_dim: DIM,
});
const U = { userId: 'u1' };

describe('search output (D3, D5, D7)', () => {
  it('returns exactly the documented keys, 1-based ranks, true cosines, null rerank at weight 0, no floor', async () => {
    const { repos } = world({ rows: { u1: [row('a', at(0.6)), row('b', at(0.8)), row('neg', [-0.5, Math.sqrt(0.75), 0, 0])] } });
    const tei = fakeTei();
    tei.qmap.set(Q + 'p', [2, 0, 0, 0]);
    const r = await createSkillChannel({ repos, tei, config: cfg() }).search(U, 'p');
    expect(Object.keys(r).sort()).toEqual(['degraded', 'hits', 'ms']);
    expect(Object.keys(r.ms).sort()).toEqual(['embed', 'load', 'rank', 'rerank', 'total']);
    expect(Object.values(r.ms).every((x) => Number.isFinite(x) && x >= 0 && Math.abs(x * 10 - Math.round(x * 10)) < 1e-6)).toBe(true);
    expect(Object.keys(r.hits[0]!).sort()).toEqual(['capId', 'cosine', 'kind', 'name', 'namespace', 'rank', 'rerank']);
    expect(r.hits.map((h) => [h.name, h.rank, h.kind, h.namespace, h.rerank])).toEqual([['b', 1, 'skill', 'user', null], ['a', 2, 'skill', 'user', null], ['neg', 3, 'skill', 'user', null]]);
    expect(r.hits.map((h) => Math.round(h.cosine * 1e3) / 1e3)).toEqual([0.8, 0.6, -0.5]);
    expect(r.degraded).toEqual([]);
  });
  it('keeps same-name capabilities of different namespaces and kinds, k above the count gives all', async () => {
    const { repos } = world({ rows: { u1: [row('same', at(0.9)), row('same', at(0.8), { namespace: 'plug' }), row('o', at(0.1), { kind: 'agent' })] } });
    const tei = fakeTei();
    tei.qmap.set(Q + 'p', [1, 0, 0, 0]);
    const r = await createSkillChannel({ repos, tei, config: cfg() }).search(U, 'p', { k: 99 });
    expect(r.hits.map((h) => `${h.namespace}:${h.name}`)).toEqual(['user:same', 'plug:same', 'user:o']);
  });
  it('a user with no vectors gets no hits and no degradation', async () => {
    const r = await createSkillChannel({ repos: world().repos, tei: fakeTei(), config: cfg() }).search(U, 'p');
    expect([r.hits, r.degraded]).toEqual([[], []]);
  });
});

describe('limits and bad input (D2, D4, D5)', () => {
  it('pins the limit defaults', () => {
    expect({ ...skillLimits }).toEqual({ promptChars: 20000, maxK: 100, maxAgeMs: 60000, retryMs: 5000, maxUsers: 32 });
  });
  it('cuts the prompt at 20,000 units (equal unchanged), sends NUL and emoji as is', async () => {
    const { repos } = world({ rows: { u1: [row('a', at(0.9))] } });
    const tei = fakeTei();
    const ch = createSkillChannel({ repos, tei, config: cfg() });
    await ch.search(U, 'x'.repeat(20000));
    await ch.search(U, 'y'.repeat(20001));
    const odd = 'a\u0000b \u{1F600} \u0007';
    await ch.search(U, odd);
    expect(tei.embeds.map((e) => e.texts[0])).toEqual([Q + 'x'.repeat(20000), Q + 'y'.repeat(20000), Q + odd]);
  });
  it('clamps k to maxK and falls back to config.k for a bad k', async () => {
    const { repos } = world({ rows: { u1: [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3].map((c, i) => row(`c${i}`, at(c))) } });
    const ch = createSkillChannel({ repos, tei: fakeTei(), config: cfg() });
    for (const k of [0, -1, 2.5, '3', Number.NaN, undefined]) expect((await ch.search(U, 'p', { k } as never)).hits).toHaveLength(5);
    expect((await ch.search(U, 'p', 'junk' as never)).hits).toHaveLength(5);
    expect((await ch.search(U, 'p', { k: 7 })).hits).toHaveLength(7);
    const keep = skillLimits.maxK;
    try { skillLimits.maxK = 2; expect((await ch.search(U, 'p', { k: 3 })).hits).toHaveLength(2); } finally { skillLimits.maxK = keep; }
  });
  it('a non-string or blank prompt gives nothing and calls neither TEI nor Postgres; a bad ctx gives store', async () => {
    const { w, repos } = world({ rows: { u1: [row('a', at(0.9))] } });
    const tei = fakeTei();
    const ch = createSkillChannel({ repos, tei, config: cfg() });
    for (const p of [42, null, undefined, '', '   \n\t']) expect(await ch.search(U, p).then((r) => [r.hits, r.degraded])).toEqual([[], []]);
    expect([tei.embeds.length, w.calls.length]).toEqual([0, 0]);
    for (const bad of [{}, { userId: 7 }, null]) expect(await ch.search(bad as never, 'p').then((r) => [r.hits, r.degraded])).toEqual([[], ['store']]);
    expect(w.calls).toEqual([]);
    ch.onInval('junk'); ch.onInval({ v: 1, event: 'nope' }); ch.onInval(null);
  });
  it('skips rows with a wrong-length, zero or non-finite vector', async () => {
    const { repos } = world({ rows: { u1: [row('ok', at(0.5)), row('zero', [0, 0, 0, 0]), row('short', [1, 0]), row('nan', [Number.NaN, 0, 0, 0])] } });
    const ch = createSkillChannel({ repos, tei: fakeTei(), config: cfg() });
    expect(names(await ch.search(U, 'p', { k: 50 }))).toEqual(['ok']);
    expect(await ch.reload(U)).toEqual({ ok: true, size: 1 });
  });
  it('an aborted signal degrades embed and sends no request', async () => {
    const { repos } = world({ rows: { u1: [row('a', at(0.9))] } });
    const tei = fakeTei();
    const ac = new AbortController();
    ac.abort();
    const r = await createSkillChannel({ repos, tei, config: cfg() }).search(U, 'p', { signal: ac.signal });
    expect([r.hits, r.degraded, tei.embeds.length]).toEqual([[], ['embed'], 0]);
  });
  it('passes opts.signal to the embedder', async () => {
    const { repos } = world({ rows: { u1: [row('a', at(0.9))] } });
    const tei = fakeTei();
    const ac = new AbortController();
    await createSkillChannel({ repos, tei, config: cfg() }).search(U, 'p', { signal: ac.signal });
    expect(tei.embeds[0]!.signal).toBe(ac.signal);
  });
});

describe('isolation and silence (D1, D6, D10)', () => {
  it("never shows another user's capabilities", async () => {
    const { repos } = world({ rows: { u1: [row('mine', at(0.9))], u2: [row('theirs', at(0.9))] } });
    const ch = createSkillChannel({ repos, tei: fakeTei(), config: cfg() });
    expect(names(await ch.search(U, 'p'))).toEqual(['mine']);
    expect(names(await ch.search({ userId: 'u2' }, 'p'))).toEqual(['theirs']);
    expect((await ch.search({ userId: 'u3' }, 'p')).hits).toEqual([]);
  });
  it('never logs prompt text', async () => {
    const { repos } = world({ rows: { u1: [row('a', at(0.9))] } });
    const tei = fakeTei();
    tei.mode.embed = 'fail';
    const logs: unknown[] = [];
    const r = await createSkillChannel({ repos, tei, config: cfg(), log: (m, f) => logs.push([m, f]) }).search(U, 'SECRET-PROMPT');
    expect(r.degraded).toEqual(['embed']);
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain('SECRET');
  });
  it('touches only loadSkillIndex and listOverrides, never rerank at weight 0, accepts deep-frozen inputs, gives the same order twice', async () => {
    const { w, repos } = world({ rows: { u1: [row('c0', at(0.5)), row('c1', at(0.5)), row('c2', at(0.7))] } });
    const tei = fakeTei();
    tei.qmap.set(Q + 'p', [1, 0, 0, 0]);
    const ch = createSkillChannel({ repos, tei, config: deepFreeze(cfg()) });
    const ctx = deepFreeze({ ...U });
    const a = await ch.search(ctx, 'p', deepFreeze({ k: 3 }));
    const b = await ch.search(ctx, 'p', deepFreeze({ k: 3 }));
    expect(a.hits).toEqual(b.hits);
    expect(names(a)[0]).toBe('c2');
    expect(tei.reranks).toHaveLength(0);
    expect([...new Set(w.calls)].sort()).toEqual(['listOverrides', 'loadSkillIndex']);
  });
  it('reads config at every call; a stale-free cache is not required', async () => {
    const { repos } = world({ rows: { u1: [0.9, 0.8, 0.7].map((c, i) => row(`c${i}`, at(c))) } });
    const config = cfg({ k: 1 });
    const ch = createSkillChannel({ repos, tei: fakeTei(), config });
    expect((await ch.search(U, 'p')).hits).toHaveLength(1);
    config.k = 2;
    expect((await ch.search(U, 'p')).hits).toHaveLength(2);
  });
  it('uses config.embed.instruction for the query prefix', async () => {
    const { repos } = world({ rows: { u1: [row('a', at(0.9))] } });
    const tei = fakeTei();
    await createSkillChannel({ repos, tei, config: cfg({ instruction: 'coding' }) }).search(U, 'p');
    expect(tei.embeds[0]!.texts).toEqual([QUERY_INSTRUCTIONS.coding + 'p']);
  });
});

describe('RAM matrix lifecycle (D14)', () => {
  it('one load per user (single flight), background reload on invalidate / onInval / age, never waiting', async () => {
    const { w, repos } = world({ rows: { u1: [row('old', at(0.5))] } });
    const tei = fakeTei();
    tei.qmap.set(Q + 'p', [1, 0, 0, 0]);
    let clock = 1_000_000;
    w.delay = 300; w.delayAfter = 1;
    const ch = createSkillChannel({ repos, tei, config: cfg(), now: () => clock });
    await Promise.all([ch.search(U, 'p'), ch.search(U, 'p')]);
    expect(w.calls.filter((c) => c === 'loadSkillIndex')).toHaveLength(1);
    w.rows['u1'] = [row('old', at(0.5)), row('new', at(0.9))];
    expect(names(await ch.search(U, 'p'))).toEqual(['old']);
    ch.invalidate('u1');
    const t0 = Date.now();
    expect(names(await ch.search(U, 'p'))).toEqual(['old']);
    expect(Date.now() - t0).toBeLessThan(200);
    await sleep(450);
    expect(names(await ch.search(U, 'p'))[0]).toBe('new');
    const n = w.calls.filter((c) => c === 'loadSkillIndex').length;
    w.rows['u1'] = [row('third', at(0.95))];
    ch.onInval({ v: 1, event: 'library.changed', userId: 'u1' });
    await ch.search(U, 'p');
    await sleep(450);
    expect(names(await ch.search(U, 'p'))).toEqual(['third']);
    expect(w.calls.filter((c) => c === 'loadSkillIndex')).toHaveLength(n + 1);
    clock += 60_001;
    await ch.search(U, 'p');
    await sleep(450);
    expect(w.calls.filter((c) => c === 'loadSkillIndex')).toHaveLength(n + 2);
    clock += 1;
    await ch.search(U, 'p');
    expect(w.calls.filter((c) => c === 'loadSkillIndex')).toHaveLength(n + 2);
    expect(await ch.reload(U)).toEqual({ ok: true, size: 1 });
  });
  it('invalidate() with no argument marks every user; onInval ignores other users and events', async () => {
    const { w, repos } = world({ rows: { a: [row('x', at(0.5))], b: [row('y', at(0.5))] } });
    const ch = createSkillChannel({ repos, tei: fakeTei(), config: cfg() });
    await ch.search({ userId: 'a' }, 'p'); await ch.search({ userId: 'b' }, 'p');
    ch.onInval({ v: 1, event: 'ovr.changed', userId: 'a' });
    await ch.search({ userId: 'a' }, 'p');
    expect(w.calls.filter((c) => c === 'loadSkillIndex')).toHaveLength(2);
    ch.invalidate();
    await ch.search({ userId: 'a' }, 'p'); await ch.search({ userId: 'b' }, 'p');
    await sleep(20);
    expect(w.calls.filter((c) => c === 'loadSkillIndex')).toHaveLength(4);
  });
  it('a failed load keeps the old matrix, pauses retries for retryMs, and returns store when there is none', async () => {
    const { w, repos } = world({ rows: { u1: [row('a', at(0.5))] } });
    let clock = 1_000_000;
    w.failIndex = true;
    const ch = createSkillChannel({ repos, tei: fakeTei(), config: cfg(), now: () => clock });
    expect((await ch.search(U, 'p')).degraded).toEqual(['store']);
    await ch.search(U, 'p');
    expect(w.calls).toHaveLength(1);
    clock += 5001;
    w.failIndex = false;
    expect(names(await ch.search(U, 'p'))).toEqual(['a']);
    w.failIndex = true;
    expect(await ch.reload(U)).toEqual({ ok: false, size: 1 });
    ch.invalidate('u1');
    clock += 5001;
    expect(names(await ch.search(U, 'p'))).toEqual(['a']);
    expect(await createSkillChannel({ repos, tei: fakeTei(), config: cfg() }).reload(U)).toEqual({ ok: false, size: 0 });
  });
  it('drops the least recently searched user beyond maxUsers', async () => {
    const { w, repos } = world({ rows: { u1: [row('a', at(0.5))], v: [row('b', at(0.5))] } });
    const keep = skillLimits.maxUsers;
    try {
      skillLimits.maxUsers = 1;
      const ch = createSkillChannel({ repos, tei: fakeTei(), config: cfg() });
      await ch.search(U, 'p'); await ch.search({ userId: 'v' }, 'p'); await ch.search(U, 'p');
      expect(w.calls.filter((c) => c === 'loadSkillIndex')).toHaveLength(3);
    } finally { skillLimits.maxUsers = keep; }
  });
});

describe('ranking knobs (D6d, D17, D18)', () => {
  const rows = (): Row[] => [row('dense', at(0.9), { description: 'nothing shared' }), row('word', at(0.8), { description: 'zebra quokka' })];
  it('keyword weight lifts a keyword match; weight 0 does no keyword work; fusion score follows score_w', async () => {
    const tei = fakeTei();
    tei.qmap.set(Q + 'zebra quokka', [1, 0, 0, 0]);
    const run = (ranking: Partial<SkillChannelDeps['config']['ranking']>) => createSkillChannel({ repos: world({ rows: { u1: rows() } }).repos, tei, config: cfg({ ranking }) }).search(U, 'zebra quokka');
    expect(names(await run({ keyword_rrf_weight: 0 }))).toEqual(['dense', 'word']);
    expect(names(await run({ keyword_rrf_weight: 1 }))).toEqual(['word', 'dense']);
    expect(names(await run({ fusion: 'score', score_w: 0.5 }))).toEqual(['word', 'dense']);
    expect(names(await run({ fusion: 'score', score_w: 1 }))).toEqual(['dense', 'word']);
  });
  const three = (): Row[] => [row('a', at(0.9), { description: 'da' }), row('b', at(0.8), { description: 'db' }), row('c', at(0.7), { description: 'dc' })];
  const rr = (tei: FakeTei) => { tei.qmap.set(Q + 'p', [1, 0, 0, 0]); tei.rmap.set('a | da', -5); tei.rmap.set('b | db', 0); tei.rmap.set('c | dc', 5); };
  it('reranks the pool with RRF weight, reports sigmoid or logit, appends the rest with null', async () => {
    const run = (tei: FakeTei, o: Parameters<typeof cfg>[0]) => createSkillChannel({ repos: world({ rows: { u1: three() } }).repos, tei, config: cfg(o) }).search(U, 'p');
    const t1 = fakeTei(); rr(t1);
    const r = await run(t1, { ranking: { rerank_weight: 1 } });
    expect(names(r)).toEqual(['a', 'c', 'b']);
    expect(t1.reranks).toEqual([{ query: 'p', texts: ['a | da', 'b | db', 'c | dc'] }]);
    expect(r.hits.map((h) => (h.rerank === null ? null : Math.round(h.rerank * 1e4) / 1e4))).toEqual([0.0067, 0.9933, 0.5]);
    const t2 = fakeTei(); rr(t2);
    expect((await run(t2, { ranking: { rerank_weight: 1, rerank_by: 'logit' } })).hits.map((h) => h.rerank)).toEqual([-5, 5, 0]);
    const t3 = fakeTei(); rr(t3);
    const top2 = await run(t3, { rerank_top: 2, ranking: { rerank_weight: 1 } });
    expect([names(top2), top2.hits[2]!.rerank]).toEqual([['a', 'b', 'c'], null]);
    const t4 = fakeTei(); rr(t4);
    expect(names(await run(t4, { ranking: { rerank_weight: 3 } }))).toEqual(['c', 'b', 'a']);
  });
  it('a rerank failure or a bad rerank reply keeps the first order and degrades rerank only', async () => {
    for (const m of ['fail', 'short']) {
      const t = fakeTei(); rr(t); t.mode.rerank = m;
      const r = await createSkillChannel({ repos: world({ rows: { u1: three() } }).repos, tei: t, config: cfg({ ranking: { rerank_weight: 1 } }) }).search(U, 'p');
      expect([names(r), r.degraded, r.hits.map((h) => h.rerank)]).toEqual([['a', 'b', 'c'], ['rerank'], [null, null, null]]);
    }
  });
});

describe('overrides (D7, D19)', () => {
  const caps = () => [row('global', at(0.9)), row('proj', at(0.8)), row('free', at(0.7))];
  it('a global block hides everywhere, a project block only in that project, a project pin over a global block shows it', async () => {
    const rows = caps();
    const [g, p] = [rows[0]!.capId, rows[1]!.capId];
    const { repos } = world({ rows: { u1: rows }, ovr: { u1: [
      { projectId: null, capId: g, action: 'block', label: null, version: null },
      { projectId: 'p1', capId: p, action: 'block', label: null, version: null },
    ] } });
    const tei = fakeTei();
    tei.qmap.set(Q + 'p', [1, 0, 0, 0]);
    const ch = createSkillChannel({ repos, tei, config: cfg() });
    expect(names(await ch.search({ userId: 'u1', projectId: 'p1' }, 'p'))).toEqual(['free']);
    expect(names(await ch.search({ userId: 'u1', projectId: 'p2' }, 'p'))).toEqual(['proj', 'free']);
    expect(names(await ch.search(U, 'p'))).toEqual(['proj', 'free']);
    const pin = world({ rows: { u1: rows }, ovr: { u1: [
      { projectId: null, capId: g, action: 'block', label: null, version: null },
      { projectId: 'p1', capId: g, action: 'pin', label: null, version: null },
    ] } });
    expect(names(await createSkillChannel({ repos: pin.repos, tei, config: cfg() }).search({ userId: 'u1', projectId: 'p1' }, 'p'))).toEqual(['global', 'proj', 'free']);
  });
  it('blocked rows are removed before the depth cut', async () => {
    const rows = [0.9, 0.8, 0.7, 0.6].map((c, i) => row(`c${i}`, at(c)));
    const { repos } = world({ rows: { u1: rows }, ovr: { u1: [{ projectId: null, capId: rows[0]!.capId, action: 'block', label: null, version: null }] } });
    const tei = fakeTei();
    tei.qmap.set(Q + 'p', [1, 0, 0, 0]);
    expect(names(await createSkillChannel({ repos, tei, config: cfg({ depth: 2 }) }).search(U, 'p', { k: 10 }))).toEqual(['c1', 'c2']);
  });
  it('an override read failure means no filter and no throw', async () => {
    const rows = caps();
    const { w, repos } = world({ rows: { u1: rows }, ovr: { u1: [{ projectId: null, capId: rows[0]!.capId, action: 'block', label: null, version: null }] } });
    w.failOvr = true;
    const tei = fakeTei();
    tei.qmap.set(Q + 'p', [1, 0, 0, 0]);
    expect(names(await createSkillChannel({ repos, tei, config: cfg() }).search(U, 'p'))).toEqual(['global', 'proj', 'free']);
  });
});

describe('degradation order (D20)', () => {
  it('no matrix gives store and no TEI call; a bad embed reply gives embed; both lists are in order', async () => {
    const down = world({ rows: { u1: [row('a', at(0.9))] } });
    down.w.failIndex = true;
    const tei = fakeTei();
    const r1 = await createSkillChannel({ repos: down.repos, tei, config: cfg() }).search(U, 'p');
    expect([r1.degraded, tei.embeds.length]).toEqual([['store'], 0]);
    for (const m of ['baddim', 'nan', 'fail']) {
      const t = fakeTei(); t.mode.embed = m;
      const r = await createSkillChannel({ repos: world({ rows: { u1: [row('a', at(0.9))] } }).repos, tei: t, config: cfg() }).search(U, 'p');
      expect([r.hits, r.degraded]).toEqual([[], ['embed']]);
    }
  });
});
