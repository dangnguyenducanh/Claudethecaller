/**
 * The F1 prompt push: `POST /v1/hook/prompt` (Claude Code UserPromptSubmit, `curl -m 0.15`) and `POST /v1/suggest` (debug and evals) share one
 * pipeline: project, `sug:` cache, three seed channels (lexical, embedding, skill), walk, rank, render, cache write.
 * Called from: the ctc-web bootstrap (`suggestRoutes(deps)` with the RAM graph store and the skill channel it already holds); evaluation/ and the
 * dashboard call `/v1/suggest`. Why: the model gets one line naming the task, file:symbol, skill and decision that apply, within 140 ms.
 * Deliberately NOT done: Fastify, auth, the `ctc:inval` subscription, building the graph, the skill matrix or rerank, `/v1/hook/pre` and the file
 * note (T5.2), memories in the line, single-flight, writes to Postgres. Untrusted: the body, every graph label, skill name, TEI reply and cached value.
 * The prompt, cwd, labels and vectors are never logged; `deps.log` gets class names only. A handler never throws.
 */
import { buildIndex, denseSeeds, lexicalSeeds, nodeRef, queryLimits, type GraphIndex, type Seed } from '@ctc/core/graph/query';
import { rankSlots, renderLine, SEED_TYPES, type Cand, type SkillSeed, type Slots } from '@ctc/core/graph/push';
import { queryText } from '@ctc/core/skills';
import { keys, ttl } from '@ctc/shared/cache';
import type { Config } from '@ctc/shared/env';
import type { Ctx, Repositories } from '@ctc/shared/repositories';
import { SuggestBody } from '@ctc/shared/schemas/suggest';
import type { Tei } from '@ctc/shared/tei';
import type { GraphStore } from '../graph/index.ts';
import { ApiError, errorBody, parse, statusOf, toApiError, type Route } from '../library/http.ts';
import { errClass, isAbs, projectOf, rootOf } from '../memory/common.ts';
import type { SkillChannel } from '../skills/index.ts';

export type Degraded = 'store' | 'embed' | 'rerank';
type SeedView = { id: string; label: string; type: string; score: number };
export type SuggestResult = {
  line: string;
  cached: boolean;
  degraded: Degraded[];
  seeds: { lexical: SeedView[]; embedding: SeedView[]; skill: SkillSeed[] };
  candidates: Slots;
  ms: { project: number; cache: number; embed: number; seeds: number; walk: number; rank: number; render: number; total: number };
};
export type Suggest = {
  run(ctx: Ctx, input: { prompt: unknown; cwd: unknown }, opts?: { signal?: AbortSignal; embedDeadlineMs?: number }): Promise<SuggestResult>;
};
export type SuggestDeps = {
  repos: Pick<Repositories, 'projects'>;
  tei: Pick<Tei, 'embed'>;
  config: Pick<Config, 'embed' | 'embedding_dim' | 'graph' | 'graph_push'>;
  graph: Pick<GraphStore, 'get'>;
  skills: Pick<SkillChannel, 'search'> & Partial<Pick<SkillChannel, 'blocked'>>;
  cache?: {
    get<T>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
    epoch: { get(kind: 'graph', userId: string, projectId: string): Promise<string | null> };
  };
  ctxOf?(req: unknown): Ctx;
  log?(message: string, fields?: Record<string, unknown>): void;
  now?(): number;
};

/**
 * Read at call time, so a test may change a field and restore it. `hookBudgetMs` and `promptChars`: FROM-SPEC (spec:299, 213). `embedDeadlineMs` 100
 * leaves 40 ms of the budget for walk, rank and render, and `lexicalChars` 500 is the query module's `queryMax`: both chosen by judgment.
 */
export const suggestLimits = { hookBudgetMs: 140, embedDeadlineMs: 100, promptChars: 20000, lexicalChars: 500 };

/** The query module's cleaning (D20: sanitize, one space, 256 code points) through its public `nodeRef`. */
const clean = (s: unknown): string =>
  nodeRef({ id: '', kind: '', type: '', label: typeof s === 'string' ? s : '', sourceFile: null, sourceLocation: null }).label;
const SEED_LIST = [...SEED_TYPES];
const EMPTY_INDEX: GraphIndex = buildIndex({ nodes: [], edges: [] });
const TIMED_OUT = Symbol('timed out');
const ZERO_MS = { project: 0, cache: 0, embed: 0, seeds: 0, walk: 0, rank: 0, render: 0, total: 0 };
const round1 = (x: number): number => Math.round(Math.max(0, Number.isFinite(x) ? x : 0) * 10) / 10;
const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;
const noSlots = (): Slots => ({ task: [], file: [], skill: [], decision: [] });
const empty = (ms: SuggestResult['ms'] = ZERO_MS): SuggestResult => ({
  line: '', cached: false, degraded: [], seeds: { lexical: [], embedding: [], skill: [] }, candidates: noSlots(), ms: { ...ms },
});
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isPos = (x: unknown): x is number => isNum(x) && x > 0;
const userOf = (ctx: unknown): Ctx => (isObj(ctx) && isStr(ctx['userId']) && ctx['userId'] !== '' ? { userId: ctx['userId'] } : { userId: 'local' });

const seedView = (s: unknown): s is SeedView => isObj(s) && isStr(s['id']) && isStr(s['label']) && isStr(s['type']) && isNum(s['score']);
const skillView = (s: unknown): s is SkillSeed => isObj(s) && isStr(s['kind']) && isStr(s['name']) && isNum(s['score']);
const candView = (c: unknown): c is Cand =>
  isObj(c) && isStr(c['id']) && isStr(c['label']) && isStr(c['type']) && (c['file'] === null || isStr(c['file'])) && (c['line'] === null || isNum(c['line'])) && isNum(c['score']) && isNum(c['hop']);
const listOf = <T>(x: unknown, ok: (v: unknown) => v is T): T[] | null => (Array.isArray(x) && x.every(ok) ? (x as T[]) : null);

/** D1: a cached value is used only when every part has the documented shape and the line is one `ctc: ` line within `maxChars`; else it is a miss. */
function fromCache(v: unknown, maxChars: number): Pick<SuggestResult, 'line' | 'seeds' | 'candidates'> | null {
  if (!isObj(v) || !isStr(v['line']) || !isObj(v['seeds']) || !isObj(v['candidates'])) return null;
  const line = v['line'];
  if (line !== '' && (!line.startsWith('ctc: ') || /[\r\n]/.test(line) || Array.from(line).length > maxChars)) return null;
  const s = v['seeds'];
  const c = v['candidates'];
  const lexical = listOf(s['lexical'], seedView);
  const embedding = listOf(s['embedding'], seedView);
  const skill = listOf(s['skill'], skillView);
  const task = listOf(c['task'], candView);
  const file = listOf(c['file'], candView);
  const cskill = listOf(c['skill'], candView);
  const decision = listOf(c['decision'], candView);
  if (!lexical || !embedding || !skill || !task || !file || !cskill || !decision) return null;
  return { line, seeds: { lexical, embedding, skill }, candidates: { task, file, skill: cskill, decision } };
}

/** Rejects when `ms` passes; the work's own late rejection is swallowed. Without a positive `ms` the work is returned as is. */
function bounded<T>(work: Promise<T>, ms: number | undefined, what: string): Promise<T> {
  if (!isPos(ms)) return work;
  work.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} deadline`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** Creates the pipeline. `deps.config` and `suggestLimits` are read at every call. */
export function createSuggest(deps: SuggestDeps): Suggest {
  const log = (message: string, e: unknown): void => deps.log?.(message, { error: errClass(e) });

  async function run(ctxIn: Ctx, input: { prompt: unknown; cwd: unknown }, opts: { signal?: AbortSignal; embedDeadlineMs?: number } = {}): Promise<SuggestResult> {
    const t0 = performance.now();
    const ms = { ...ZERO_MS };
    const finish = (r: SuggestResult): SuggestResult => {
      r.ms = { ...ms, total: performance.now() - t0 };
      for (const k of Object.keys(r.ms) as (keyof SuggestResult['ms'])[]) r.ms[k] = round1(r.ms[k]);
      return r;
    };
    try {
      const body = SuggestBody.safeParse({ prompt: isObj(input) ? input['prompt'] : undefined, cwd: isObj(input) ? input['cwd'] : undefined });
      if (!body.success || !isAbs(body.data.cwd)) return finish(empty());
      const prompt = body.data.prompt.slice(0, suggestLimits.promptChars);
      if (prompt.trim() === '') return finish(empty());
      const ctx = userOf(ctxIn);
      const { config } = deps;
      const floor = config.graph_push.floor;
      const maxChars = config.graph_push.max_chars;

      // 2 project
      const tProject = performance.now();
      let project: { id: string; root: string } | null = null;
      try {
        project = await projectOf(deps, ctx, rootOf(body.data.cwd));
      } catch (e) {
        // judgment: a failing project lookup means "no project": the answer comes from the skill seeds alone
        log('suggest project lookup failed', e);
      }
      ms.project = performance.now() - tProject;
      const ctxP: Ctx & { projectId?: string } = project ? { ...ctx, projectId: project.id } : ctx;

      // 3 epoch, then the sug: key
      const tCache = performance.now();
      let cacheKey: string | null = null;
      if (project && deps.cache) {
        try {
          const epoch = await deps.cache.epoch.get('graph', ctx.userId, project.id);
          if (isStr(epoch)) {
            cacheKey = keys.sug(ctx.userId, project.id, prompt, epoch);
            const hit = fromCache(await deps.cache.get<unknown>(cacheKey), maxChars);
            if (hit) {
              ms.cache = performance.now() - tCache;
              return finish({ ...hit, cached: true, degraded: [], ms: ZERO_MS });
            }
          }
        } catch (e) {
          // judgment: a failing cache read is a miss (and the key is not written either when the epoch is unknown)
          log('suggest cache read failed', e);
        }
      }
      ms.cache = performance.now() - tCache;

      // 4 seeds: the store, the embedding and the skill channel run concurrently
      const degraded = new Set<Degraded>();
      const deadline = opts.embedDeadlineMs;
      const signals = [opts.signal, isPos(deadline) ? AbortSignal.timeout(deadline) : undefined].filter((s): s is AbortSignal => s instanceof AbortSignal);
      const signal = signals.length === 0 ? undefined : AbortSignal.any(signals);
      const sig = signal ? { signal } : {};
      const tSeeds = performance.now();

      const graphLeg = project
        ? deps.graph.get({ ...ctx, projectId: project.id }).then((g) => g.index, (e: unknown) => {
            degraded.add('store');
            log('suggest graph load failed', e);
            return EMPTY_INDEX;
          })
        : Promise.resolve(EMPTY_INDEX);

      const embedLeg = project
        ? (async (): Promise<number[] | null> => {
            const tEmbed = performance.now();
            try {
              const out = await bounded(deps.tei.embed([queryText(prompt, config.embed.instruction)], sig), deadline, 'embed');
              const v = Array.isArray(out) && out.length === 1 ? out[0] : undefined;
              if (!Array.isArray(v) || v.length !== config.embedding_dim || !v.every(isNum)) throw new Error('bad embedding');
              return v;
            } catch (e) {
              degraded.add('embed');
              log('suggest embed failed', e);
              return null;
            } finally {
              ms.embed = performance.now() - tEmbed;
            }
          })()
        : Promise.resolve(null);

      const skillLeg = (async (): Promise<SkillSeed[]> => {
        try {
          const found = await bounded(deps.skills.search(ctxP as Ctx, prompt, sig), deadline, 'skill search');
          for (const d of found.degraded) degraded.add(d);
          const seeds: SkillSeed[] = [];
          for (const h of found.hits) {
            const kind = clean(h.kind);
            const name = clean(h.name);
            if (kind !== '' && name !== '' && isNum(h.cosine) && h.cosine >= floor) seeds.push({ kind, name, score: round4(h.cosine) });
          }
          return seeds;
        } catch (e) {
          // judgment: a channel that fails or passes the deadline gives no skill seeds; a deadline counts as the embedder being slow
          degraded.add(isStr((e as Error | null)?.message) && (e as Error).message.endsWith('deadline') ? 'embed' : 'store');
          log('suggest skill search failed', e);
          return [];
        }
      })();

      const [index, vector, skills] = await Promise.all([graphLeg, embedLeg, skillLeg]);
      const lexical = lexicalSeeds(index, prompt.slice(0, suggestLimits.lexicalChars), { types: SEED_LIST, max: config.graph.query.seeds });
      const dense = vector ? denseSeeds(index, vector, { types: SEED_LIST, floor, max: queryLimits.denseSeeds }) : [];
      ms.seeds = performance.now() - tSeeds;

      // 5 and 6 walk and rank (rankSlots walks, so `walk` holds both)
      const tWalk = performance.now();
      const d = config.graph.query.depth;
      const perSlot = Number.isInteger(config.graph_push.max_pointers) && config.graph_push.max_pointers > 0 ? config.graph_push.max_pointers : 3;
      // a skill the user blocked must not come back through a `serves` edge of the graph either
      const blockedSkills = await deps.skills.blocked?.(ctxP as Ctx).catch(() => undefined);
      const slots = rankSlots(index, { seeds: [...lexical, ...dense], skills, ...(blockedSkills === undefined ? {} : { blockedSkills }), depth: Number.isInteger(d) && d >= 1 && d <= 3 ? d : 2, perSlot });
      ms.walk = performance.now() - tWalk;

      // 7 render
      const tRender = performance.now();
      const line = renderLine(slots, { maxChars });
      ms.render = performance.now() - tRender;

      const view = (s: Seed): SeedView => {
        const n = index.nodes.get(s.id);
        const r = n ? nodeRef(n) : null;
        return { id: r?.id ?? clean(s.id), label: r?.label ?? '', type: r?.type ?? '', score: round4(s.score) };
      };
      const result: SuggestResult = {
        line,
        cached: false,
        degraded: (['store', 'embed', 'rerank'] as const).filter((x) => degraded.has(x)),
        seeds: { lexical: lexical.map(view), embedding: dense.map(view), skill: skills },
        candidates: slots,
        ms: ZERO_MS,
      };

      // 8 start the cache write, never wait for it
      if (cacheKey !== null && deps.cache && result.degraded.length === 0) {
        try {
          deps.cache.set(cacheKey, { line, seeds: result.seeds, candidates: result.candidates }, ttl.sug).catch((e: unknown) => log('suggest cache write failed', e));
        } catch (e) {
          log('suggest cache write failed', e);
        }
      }
      return finish(result);
    } catch (e) {
      // judgment: a bug or odd input must not fail a hook; answer with nothing and say the store side is degraded
      log('suggest failed', e);
      const r = empty();
      r.degraded = ['store'];
      return finish(r);
    }
  }

  return { run };
}

/** `POST /v1/hook/prompt` then `POST /v1/suggest`, in this order. */
export function suggestRoutes(deps: SuggestDeps): Route[] {
  const suggest = createSuggest(deps);
  const ctxFor = (req: unknown): Ctx => {
    try {
      return userOf(deps.ctxOf?.(req));
    } catch {
      return { userId: 'local' };
    }
  };

  const hook: Route = {
    method: 'POST',
    url: '/v1/hook/prompt',
    async handler(req, reply) {
      let timer: NodeJS.Timeout | undefined;
      let line: string | typeof TIMED_OUT = '';
      try {
        const body = SuggestBody.safeParse(req?.body);
        if (body.success && isAbs(body.data.cwd)) {
          // judgment: when the timer wins the work keeps running and still fills `sug:` for the next identical prompt (D18)
          const work = suggest.run(ctxFor(req), body.data, { embedDeadlineMs: suggestLimits.embedDeadlineMs }).then((r) => r.line, () => '');
          const budget = new Promise<typeof TIMED_OUT>((resolve) => {
            timer = setTimeout(() => resolve(TIMED_OUT), suggestLimits.hookBudgetMs);
          });
          line = await Promise.race([work, budget]);
        }
      } catch (e) {
        log('hook prompt failed', e);
      } finally {
        clearTimeout(timer);
      }
      return line === TIMED_OUT || line === '' ? reply.code(204).send() : reply.code(200).send(line);
    },
  };

  const suggestRoute: Route = {
    method: 'POST',
    url: '/v1/suggest',
    async handler(req, reply) {
      try {
        const body = parse(SuggestBody, 'body', req?.body);
        if (!isAbs(body.cwd)) throw new ApiError('invalid', 'cwd must be an absolute path', { path: ['body', 'cwd'] });
        const result = await suggest.run(ctxFor(req), body);
        if (result.degraded.includes('embed')) throw new ApiError('model_unavailable', 'embedding service unavailable');
        return reply.code(200).send(result);
      } catch (e) {
        const err = toApiError(e);
        return reply.code(statusOf(err)).send(errorBody(err));
      }
    },
  };

  function log(message: string, e: unknown): void {
    deps.log?.(message, { error: errClass(e) });
  }
  return [hook, suggestRoute];
}
