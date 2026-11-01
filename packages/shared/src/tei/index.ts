/**
 * HTTP client for the two Text Embeddings Inference servers: `/embed` (vectors) and `/rerank` (logits).
 * Called from: apps/web/src/skills (query embedding, rerank), the worker main (may bind `embed` as the T3.1 `Embed`), the gate test.
 * Why: one place owns batching (32 per request), timeouts, the `emb:` cache and the validation of every reply.
 * Deliberately NOT done: retries, the query prefix (the channel adds it), a rerank cache, logging of texts or URLs, a connection pool.
 * Untrusted: every reply (shape, length, numbers); a reply that is off in any way is `TeiError('bad_reply')`, never partly used.
 */
import { keys } from '../cache/keys.ts';
import { ttl } from '../cache/limits.ts';

/** Both TEI servers report `max_client_batch_size: 32` on `/info` (D2). */
export const teiLimits = { batch: 32 };

export type TeiErrorCode = 'timeout' | 'aborted' | 'http' | 'unreachable' | 'bad_reply';

/** `message` is `tei <embed|rerank> <code>` plus ` <status>` for `http`: no URL, no input text, no reply body (D1, D3). */
export class TeiError extends Error {
  override name = 'TeiError';
  code: TeiErrorCode;
  status?: number;

  constructor(op: 'embed' | 'rerank', code: TeiErrorCode, status?: number) {
    super(`tei ${op} ${code}${status === undefined ? '' : ` ${status}`}`);
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export type TeiDeps = {
  config: { embed_url: string; rerank_url: string; embed_model: string; embedding_dim: number; timeout_s: number; batch_timeout_s: number };
  cache?: {
    getVec(key: string): Promise<Float32Array | undefined>;
    setVec(key: string, vec: ArrayLike<number>, ttlSeconds: number): Promise<void>;
  };
  fetch?: typeof fetch;
  log?(message: string, fields?: Record<string, unknown>): void;
};

export type Tei = {
  embed(texts: string[], opts?: { signal?: AbortSignal }): Promise<number[][]>;
  rerank(query: string, texts: string[], opts?: { signal?: AbortSignal }): Promise<number[]>;
};

type Opts = { signal?: AbortSignal } | undefined;

const finiteNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Creates the client; `deps.config` is read at every call. */
export function createTei(deps: TeiDeps): Tei {
  const post = async (op: 'embed' | 'rerank', baseUrl: string, body: unknown, timeoutS: number, signal: AbortSignal | undefined): Promise<unknown> => {
    if (signal?.aborted) throw new TeiError(op, 'aborted');
    const own = AbortSignal.timeout(Math.max(1, Math.round(timeoutS * 1000)));
    const combined = signal ? AbortSignal.any([signal, own]) : own;
    const fail = (): TeiError => (signal?.aborted ? new TeiError(op, 'aborted') : own.aborted ? new TeiError(op, 'timeout') : new TeiError(op, 'unreachable'));
    let res: Response;
    try {
      res = await (deps.fetch ?? fetch)(`${baseUrl.replace(/\/+$/, '')}/${op}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch {
      throw fail();
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new TeiError(op, 'http', res.status);
    }
    try {
      return await res.json();
    } catch {
      const e = fail();
      throw e.code === 'unreachable' ? new TeiError(op, 'bad_reply') : e;
    }
  };

  const cacheKey = (text: string): string => keys.emb(`${deps.config.embed_model}\u0000${text}`);
  const logCache = (what: string, e: unknown): void => deps.log?.(`tei cache ${what} failed`, { error: e instanceof Error ? e.constructor.name : typeof e });

  return {
    async embed(texts: string[], opts: Opts = {}): Promise<number[][]> {
      if (texts.length === 0) return [];
      const { config } = deps;
      const dim = config.embedding_dim;
      const found = new Map<string, number[]>();
      const unique = [...new Set(texts)];
      if (deps.cache) {
        const cache = deps.cache;
        await Promise.all(
          unique.map(async (t) => {
            try {
              const v = await cache.getVec(cacheKey(t));
              // judgment: a cached vector of the wrong length is a miss, not an error.
              if (v && v.length === dim) found.set(t, Array.from(v));
            } catch (e) {
              logCache('get', e);
            }
          }),
        );
      }
      const missing = unique.filter((t) => !found.has(t));
      for (let i = 0; i < missing.length; i += teiLimits.batch) {
        const batch = missing.slice(i, i + teiLimits.batch);
        const reply = await post('embed', config.embed_url, { inputs: batch, truncate: true }, batch.length === 1 ? config.timeout_s : config.batch_timeout_s, opts?.signal);
        if (!Array.isArray(reply) || reply.length !== batch.length) throw new TeiError('embed', 'bad_reply');
        const vecs = reply.map((v: unknown) => {
          if (!Array.isArray(v) || v.length !== dim || !v.every(finiteNumber)) throw new TeiError('embed', 'bad_reply');
          return v as number[];
        });
        batch.forEach((t, j) => found.set(t, vecs[j] as number[]));
        if (deps.cache) {
          const cache = deps.cache;
          await Promise.all(
            batch.map(async (t, j) => {
              try {
                await cache.setVec(cacheKey(t), vecs[j] as number[], ttl.emb);
              } catch (e) {
                logCache('set', e);
              }
            }),
          );
        }
      }
      return texts.map((t) => found.get(t) as number[]);
    },

    async rerank(query: string, texts: string[], opts: Opts = {}): Promise<number[]> {
      if (texts.length === 0) return [];
      const { config } = deps;
      const out: number[] = [];
      for (let i = 0; i < texts.length; i += teiLimits.batch) {
        const batch = texts.slice(i, i + teiLimits.batch);
        const reply = await post('rerank', config.rerank_url, { query, texts: batch, raw_scores: true, truncate: true }, config.timeout_s, opts?.signal);
        if (!Array.isArray(reply) || reply.length !== batch.length) throw new TeiError('rerank', 'bad_reply');
        const logits: number[] = new Array(batch.length);
        const seen = new Set<number>();
        for (const r of reply as { index?: unknown; score?: unknown }[]) {
          const idx = r?.index;
          if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= batch.length || seen.has(idx) || !finiteNumber(r.score)) {
            throw new TeiError('rerank', 'bad_reply');
          }
          seen.add(idx);
          logits[idx] = r.score;
        }
        out.push(...logits);
      }
      return out;
    },
  };
}
