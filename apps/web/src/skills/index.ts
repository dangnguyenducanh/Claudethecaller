/**
 * Skill seed channel: a RAM matrix of each user's served capability vectors and the search over it
 * (`dense 50 + keyword 50 -> RRF k 60 -> rerank top 20 -> top 5`, config/retrieval.yaml).
 * Called from: T5.1 `/v1/hook/prompt` and `/v1/suggest` (`search`), the ctc-web bootstrap (`reload` at start, `onInval` on `ctc:inval`).
 * Why: the prompt hook answers from RAM, so a warm search never waits on Postgres (spec:204); vectors come from `cap_vectors`, which T3.1 writes.
 * Deliberately NOT done: embedding documents or writing anything (T3.1), HTTP routes, the 140 ms budget, the floor and the prompt line (T5.1),
 * pins in ranking, pgvector search, the abstain gate, query blending, a kind filter. Only `loadSkillIndex` and `listOverrides` touch `repos`.
 * Untrusted: the prompt, `opts`, every TEI reply, every row read from Postgres. Never logs prompt text, descriptions, vectors or URLs.
 */
import { buildKeywordIndex, finalOrder, firstOrder, keywordTop, normalize, queryText, sigmoid, topCosine, type KeywordIndex, type Scored } from '@ctc/core/skills';
import type { Config } from '@ctc/shared/env';
import type { Ctx, Repositories } from '@ctc/shared/repositories';
import type { Tei } from '@ctc/shared/tei';
import type { LibraryApiDeps } from '../library/http.ts';
import { overrideRows } from '../library/served.ts';

export type Degraded = 'store' | 'embed' | 'rerank';
export type SkillHit = { capId: string; namespace: string; kind: string; name: string; rank: number; cosine: number; rerank: number | null };
export type SkillSearch = {
  hits: SkillHit[];
  degraded: Degraded[];
  ms: { load: number; embed: number; rank: number; rerank: number; total: number };
};
export type SkillChannelDeps = {
  repos: Repositories;
  tei: Pick<Tei, 'embed' | 'rerank'>;
  config: Pick<Config, 'k' | 'depth' | 'rerank_top' | 'rrf_k' | 'ranking' | 'embed' | 'embedding_dim'>;
  cache?: Pick<NonNullable<LibraryApiDeps['cache']>, 'get' | 'set'>;
  log?(message: string, fields?: Record<string, unknown>): void;
  now?: () => number;
};
export type SkillChannel = {
  search(ctx: Ctx, prompt: unknown, opts?: { k?: number; signal?: AbortSignal }): Promise<SkillSearch>;
  reload(ctx: Ctx): Promise<{ ok: boolean; size: number }>;
  invalidate(userId?: string): void;
  onInval(msg: unknown): void;
};

/** Exported and mutable so a test can change a field and restore it; read at call time (D2). `maxK`, `retryMs`, `maxUsers`: chosen by judgment. */
export const skillLimits = { promptChars: 20000, maxK: 100, maxAgeMs: 60000, retryMs: 5000, maxUsers: 32 };

type Meta = { capId: string; namespace: string; kind: string; name: string; description: string };
type Data = { dim: number; matrix: Float32Array; meta: Meta[]; kw?: KeywordIndex; loadedAt: number };
type Entry = { data?: Data; stale: boolean; gen: number; loading?: Promise<boolean>; failedAt?: number; used: number };

const round1 = (x: number): number => Math.round(x * 10) / 10;
const errName = (e: unknown): string => (e instanceof Error ? e.constructor.name : typeof e);
const isStr = (x: unknown): x is string => typeof x === 'string';

/** Creates one channel (one per process). `deps.config` is read at every call. */
export function createSkillChannel(deps: SkillChannelDeps): SkillChannel {
  const now = deps.now ?? Date.now;
  const users = new Map<string, Entry>();
  let tick = 0;

  const entryOf = (userId: string): Entry => {
    let e = users.get(userId);
    if (!e) {
      e = { stale: false, gen: 0, used: 0 };
      users.set(userId, e);
      while (users.size > Math.max(1, skillLimits.maxUsers)) {
        let oldest: string | undefined;
        for (const [id, x] of users) if (id !== userId && (oldest === undefined || x.used < (users.get(oldest) as Entry).used)) oldest = id;
        if (oldest === undefined) break;
        users.delete(oldest);
      }
    }
    e.used = ++tick;
    return e;
  };

  /** Loads the user's index (single flight); resolves `true` when a matrix was stored, never rejects. */
  const load = (userId: string, e: Entry): Promise<boolean> => {
    if (e.loading) return e.loading;
    const dim = deps.config.embedding_dim;
    const gen = e.gen;
    e.loading = (async () => {
      try {
        const got = await deps.repos.library.loadSkillIndex({ userId });
        const meta: Meta[] = [];
        const vecs: Float32Array[] = [];
        for (const r of got) {
          // judgment: a row with a wrong-length, zero or non-finite vector (or odd fields) is skipped, not fatal (D4, D8).
          const v = r && Array.isArray(r.embedding) && r.embedding.length === dim ? normalize(r.embedding) : null;
          if (!v || !isStr(r.capId) || !isStr(r.name)) continue;
          vecs.push(v);
          meta.push({ capId: r.capId, namespace: String(r.namespace), kind: String(r.kind), name: r.name, description: isStr(r.description) ? r.description : '' });
        }
        const matrix = new Float32Array(vecs.length * dim);
        vecs.forEach((v, i) => matrix.set(v, i * dim));
        e.data = { dim, matrix, meta, loadedAt: now() };
        e.stale = e.gen !== gen;
        delete e.failedAt;
        return true;
      } catch (err) {
        e.failedAt = now();
        deps.log?.('skill index load failed', { error: errName(err) });
        return false;
      } finally {
        delete e.loading;
      }
    })();
    return e.loading;
  };

  const recentlyFailed = (e: Entry): boolean => e.failedAt !== undefined && now() - e.failedAt < skillLimits.retryMs;

  const blockedIds = async (ctx: Ctx): Promise<Set<string>> => {
    const blocked = new Set<string>();
    try {
      const rows = await overrideRows({ repos: deps.repos, ...(deps.cache ? { cache: deps.cache } : {}), ...(deps.log ? { log: deps.log } : {}) }, ctx);
      const applicable = new Map<string, string>();
      for (const r of Array.isArray(rows) ? rows : []) {
        if (r.projectId === null) {
          if (!applicable.has(r.capId)) applicable.set(r.capId, r.action);
        } else if (ctx.projectId !== undefined && r.projectId === ctx.projectId) applicable.set(r.capId, r.action);
      }
      for (const [id, action] of applicable) if (action === 'block') blocked.add(id);
    } catch (err) {
      // judgment: fail open like the hooks; a blocked skill may show while overrides cannot be read.
      deps.log?.('override read failed', { error: errName(err) });
    }
    return blocked;
  };

  const channel: SkillChannel = {
    async search(ctx, prompt, opts) {
      const t0 = performance.now();
      const ms = { load: 0, embed: 0, rank: 0, rerank: 0, total: 0 };
      const degraded = new Set<Degraded>();
      const done = (hits: SkillHit[]): SkillSearch => {
        ms.total = performance.now() - t0;
        for (const key of Object.keys(ms) as (keyof typeof ms)[]) ms[key] = round1(Math.max(0, ms[key]));
        return { hits, degraded: (['store', 'embed', 'rerank'] as const).filter((d) => degraded.has(d)), ms };
      };
      try {
        if (!isStr(prompt)) return done([]);
        const cut = prompt.slice(0, skillLimits.promptChars);
        if (cut.trim() === '') return done([]);
        const o = typeof opts === 'object' && opts !== null ? opts : {};
        const signal = o.signal instanceof AbortSignal ? { signal: o.signal } : {};
        const { config } = deps;
        const maxK = Math.max(1, skillLimits.maxK);
        const k = Math.min(typeof o.k === 'number' && Number.isInteger(o.k) && o.k >= 1 ? o.k : config.k, maxK);

        if (typeof ctx !== 'object' || ctx === null || !isStr(ctx.userId)) {
          degraded.add('store');
          return done([]);
        }
        const clean: Ctx = isStr(ctx.projectId) ? { userId: ctx.userId, projectId: ctx.projectId } : { userId: ctx.userId };
        const entry = entryOf(clean.userId);
        if (!entry.data) {
          if (!recentlyFailed(entry)) {
            const tLoad = performance.now();
            await load(clean.userId, entry);
            ms.load = performance.now() - tLoad;
          }
        } else if ((entry.stale || now() - entry.data.loadedAt > skillLimits.maxAgeMs) && !entry.loading && !recentlyFailed(entry)) {
          void load(clean.userId, entry);
        }
        const data = entry.data;
        if (!data) {
          degraded.add('store');
          return done([]);
        }

        let qvec: Float32Array | null = null;
        const tEmbed = performance.now();
        try {
          if (o.signal instanceof AbortSignal && o.signal.aborted) throw new Error('aborted');
          const out = await deps.tei.embed([queryText(cut, config.embed.instruction)], signal);
          const first = Array.isArray(out) && out.length === 1 ? out[0] : undefined;
          qvec = Array.isArray(first) && first.length === data.dim ? normalize(first) : null;
        } catch (err) {
          deps.log?.('query embed failed', { error: errName(err), code: (err as { code?: unknown } | null)?.code });
        }
        ms.embed = performance.now() - tEmbed;
        if (!qvec) {
          degraded.add('embed');
          return done([]);
        }

        const tRank = performance.now();
        const blocked = await blockedIds(clean);
        const extra = blocked.size;
        const keepOpen = (s: Scored[], n: number): Scored[] => s.filter((x) => !blocked.has((data.meta[x.index] as Meta).capId)).slice(0, n);
        const dense = keepOpen(topCosine(data.matrix, data.dim, qvec, config.depth + extra), config.depth);
        // judgment: with `rrf` and a zero keyword weight the keyword leg cannot change the order, so it is not computed (D6d).
        const useKeyword = config.ranking.fusion === 'score' || config.ranking.keyword_rrf_weight > 0;
        let keyword: Scored[] = [];
        if (useKeyword) {
          data.kw ??= buildKeywordIndex(data.meta.map((m) => `${m.name} ${m.description}`));
          keyword = keepOpen(keywordTop(data.kw, cut, config.depth + extra), config.depth);
        }
        const cosineOf = (i: number): number => {
          let dot = 0;
          const base = i * data.dim;
          for (let j = 0; j < data.dim; j++) dot += (data.matrix[base + j] as number) * (qvec[j] as number);
          return dot;
        };
        const ids = data.meta.map((m) => m.capId);
        const first = firstOrder({ dense, keyword, ids, cosine: cosineOf, ranking: config.ranking, rrfK: config.rrf_k });
        ms.rank = performance.now() - tRank;

        const byId = new Map(data.meta.map((m, i) => [m.capId, i]));
        const pool = first.slice(0, config.rerank_top);
        let logits: number[] | undefined;
        if (config.ranking.rerank_weight > 0 && pool.length > 0) {
          const tRerank = performance.now();
          try {
            const texts = pool.map((id) => {
              const m = data.meta[byId.get(id) as number] as Meta;
              return `${m.name} | ${m.description}`;
            });
            const got = await deps.tei.rerank(cut, texts, signal);
            if (!Array.isArray(got) || got.length !== pool.length || !got.every((x) => typeof x === 'number' && Number.isFinite(x))) throw new Error('bad rerank reply');
            logits = got;
          } catch (err) {
            degraded.add('rerank');
            deps.log?.('rerank failed', { error: errName(err), code: (err as { code?: unknown } | null)?.code });
          }
          ms.rerank = performance.now() - tRerank;
        }
        const tFinal = performance.now();
        const order = finalOrder(first, logits, { rerankTop: config.rerank_top, rerankWeight: config.ranking.rerank_weight, rrfK: config.rrf_k });
        const rerankOf = new Map<string, number>();
        if (logits) pool.forEach((id, i) => rerankOf.set(id, config.ranking.rerank_by === 'logit' ? (logits[i] as number) : sigmoid(logits[i] as number)));
        const hits = order.slice(0, k).map((id, i): SkillHit => {
          const row = byId.get(id) as number;
          const m = data.meta[row] as Meta;
          return { capId: m.capId, namespace: m.namespace, kind: m.kind, name: m.name, rank: i + 1, cosine: cosineOf(row), rerank: rerankOf.get(id) ?? null };
        });
        ms.rank += performance.now() - tFinal;
        return done(hits);
      } catch (err) {
        // judgment: a bug or odd input must not fail a hook; answer with what is known and say the store side is degraded.
        deps.log?.('skill search failed', { error: errName(err) });
        degraded.add('store');
        return done([]);
      }
    },

    async reload(ctx) {
      try {
        if (typeof ctx !== 'object' || ctx === null || !isStr(ctx.userId)) return { ok: false, size: 0 };
        const entry = entryOf(ctx.userId);
        const ok = await load(ctx.userId, entry);
        return { ok, size: entry.data?.meta.length ?? 0 };
      } catch (err) {
        deps.log?.('skill reload failed', { error: errName(err) });
        return { ok: false, size: 0 };
      }
    },

    invalidate(userId) {
      for (const [id, e] of users) {
        if (userId === undefined || id === userId) {
          e.stale = true;
          e.gen++;
        }
      }
    },

    onInval(msg) {
      if (typeof msg !== 'object' || msg === null) return;
      const m = msg as { event?: unknown; userId?: unknown };
      if (m.event === 'library.changed' && isStr(m.userId)) channel.invalidate(m.userId);
    },
  };
  return channel;
}
