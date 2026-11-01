/**
 * `POST /v1/hook/start`: the SessionStart block (spec:526-529) within `hookStartBudgetMs`.
 * Called from: the ctc-web bootstrap, which mounts the `Route` and serves a string reply as `text/plain`; Claude Code's SessionStart hook posts here.
 * Why: the next session starts with the last summaries and the best-ranked memories of its project. Deliberately NOT done: Fastify, auth,
 * writes to the database (the hook only reads, then writes the `ctx:` cache entry), `touch`. Untrusted: the whole body; a handler never throws,
 * every failure is an empty `204` (spec:164).
 */
import { fitStartBlock, rankRecall, recallLimits } from '@ctc/core/memory';
import { GLOBAL_MEM_EPOCH, keys, ttl } from '@ctc/shared/cache';
import type { Ctx } from '@ctc/shared/repositories';
import { HookStartBody, memoryApiLimits } from '@ctc/shared/schemas/memory';
import type { Route } from '../library/http.ts';
import { ctxOf, embedQuery, errClass, isAbs, labelOf, nowOf, projectOf, rootOf, type MemoryApiDeps } from './common.ts';

const TIMED_OUT = Symbol('timed out');

async function buildBlock(deps: MemoryApiDeps, req: unknown): Promise<string> {
  const parsed = HookStartBody.safeParse((req as { body?: unknown } | null)?.body);
  if (!parsed.success || !isAbs(parsed.data.cwd)) return '';
  const ctx: Ctx = ctxOf(deps, req);
  const root = rootOf(parsed.data.cwd);
  const label = labelOf(root);
  const { repos, cache } = deps;
  const { memory: cfg } = deps.config;

  const project = await projectOf(deps, ctx, root);
  const ctxP: Ctx = project ? { ...ctx, projectId: project.id } : ctx;

  let epoch: string | null = null;
  const cacheKey = (e: string): string => keys.ctx(ctx.userId, project?.id ?? '', e);
  if (project && cache) {
    try {
      // the block holds global memories too: a change to one rotates the user-level epoch, which is part of the key
      const [own, global] = await Promise.all([cache.epoch.get('mem', ctx.userId, project.id), cache.epoch.get('mem', ctx.userId, GLOBAL_MEM_EPOCH)]);
      epoch = typeof own === 'string' && typeof global === 'string' ? `${own}-${global}` : null;
      if (typeof epoch === 'string') {
        const hit = await cache.get<unknown>(cacheKey(epoch));
        if (typeof hit === 'string') return hit;
      }
    } catch (e) {
      deps.log?.('hook start cache read failed', { error: errClass(e) });
    }
  }

  const summaries = project ? await repos.memory.lastSummaries(ctxP, cfg.start.summaries) : [];
  // judgment: the query is cut to the search query limit; a long next-steps text must not slow the embedder
  const query = `${label} ${summaries[0]?.nextSteps ?? ''}`.trim().slice(0, memoryApiLimits.queryMax);
  const queryVector = await embedQuery(deps, query);
  // judgment: no known project (the first session of every project) means the user's global memories only, chosen in the query so other projects' rows cannot crowd them out
  const legs = await repos.memory.recallLegs(ctxP, { queryText: query, queryVector, perLeg: cfg.rrf.per_leg, anyWord: true, ...(project ? {} : { globalOnly: true }) });
  const memories = rankRecall(legs, { k: cfg.rrf.k, halfLifeDays: cfg.half_life_days, now: nowOf(deps) }).slice(0, cfg.start.memories);
  const { text } = fitStartBlock({ project: label, summaries, memories }, cfg.context_chars);

  if (project && cache && typeof epoch === 'string') {
    try {
      await cache.set(cacheKey(epoch), text, ttl.ctx);
    } catch {
      // judgment: a cache failure never fails the hook
    }
  }
  return text;
}

export function hookStartRoute(deps: MemoryApiDeps): Route {
  return {
    method: 'POST',
    url: '/v1/hook/start',
    async handler(req, reply) {
      let timer: NodeJS.Timeout | undefined;
      let text: string | typeof TIMED_OUT = '';
      try {
        // judgment: when the timer wins the work keeps running and still fills the cache for the next start
        const work = buildBlock(deps, req).catch((e: unknown) => {
          deps.log?.('hook start failed', { error: errClass(e) });
          return '';
        });
        const budget = new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), recallLimits.hookStartBudgetMs);
        });
        text = await Promise.race([work, budget]);
      } catch (e) {
        deps.log?.('hook start failed', { error: errClass(e) });
      } finally {
        clearTimeout(timer);
      }
      return text === TIMED_OUT || text === '' ? reply.code(204).send() : reply.code(200).send(text);
    },
  };
}
