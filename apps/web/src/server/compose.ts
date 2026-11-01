/**
 * Wires the real dependencies of `ctc-web` (repositories, cache, queues, models, graph store, skill channel, session caps, spool drain) into the route and
 * tool factories of the earlier tasks, and owns the background work of the process (warm-up, `ctc:inval`, drain start and stop).
 * Called from: ./main.ts. Why it exists: every factory takes its dependencies as arguments (spec:88), so something must hold the one instance of each and
 * hand the same store, cache and `submit` to all of them.
 * Deliberately NOT done: Fastify and listening (./app.ts, ./listen.ts), opening or closing the database (./main.ts owns the `Db`), config loading, migrating,
 * auth, shared mode, advancing runs (the worker's loop does; `advance` stays unset), any logic of the factories.
 * Untrusted: nothing read here; the factories treat requests as untrusted.
 */
import { runnerJobId } from '@ctc/core/runner';
import type { Config } from '@ctc/shared/env';
import { applyCacheConfig, createCache } from '@ctc/shared/cache';
import { createChat, createEmbedder } from '@ctc/shared/models';
import { createQueues, submitJob } from '@ctc/shared/queues';
import { createRepositories, type Ctx, type Db } from '@ctc/shared/repositories';
import { createTei } from '@ctc/shared/tei';
import { countGuardTrips } from '../graph/common.ts';
import { createGraphStore, graphRoutes, graphTools } from '../graph/index.ts';
import { libraryRoutes, libraryTools, type LibraryApiDeps, type McpTool, type Route } from '../library/index.ts';
import { hookStartRoute, memoryRoutes, memoryTools, type MemoryApiDeps } from '../memory/index.ts';
import { createSessionCaps, preRoutes } from '../pre/index.ts';
import { runsRoutes, stepTimeoutS, workflowRoutes, workflowTools, type WorkflowApiDeps } from '../runs/index.ts';
import { createSkillChannel } from '../skills/index.ts';
import { createSpoolDrain, nudgeRoute } from '../spool/index.ts';
import { suggestRoutes } from '../suggest/index.ts';
import type { Log } from './guards.ts';

/** How often the warm-up of the RAM graph and the skill vectors is retried while Postgres or the embedder is down (spec:205). Chosen by judgment. */
const WARM_RETRY_MS = 5000;
const WARM_PROJECTS = 8;

const errClass = (e: unknown): string => (e instanceof Error ? e.constructor.name : typeof e);

export type Web = {
  routes: Route[];
  tools: McpTool[];
  mcpProject(root: string): Promise<string | undefined>;
  probes: { db(): Promise<boolean>; redis(): Promise<boolean> };
  start(): Promise<void>;
  stop(): Promise<void>;
};

export function composeWeb(o: { config: Config; db: Db; namespace: string; runsDir: string; log: Log }): Web {
  const { config, db, log } = o;
  const ctxOf = (): Ctx => ({ userId: 'local' });
  const repos = createRepositories(db);
  applyCacheConfig(config);
  const cache = createCache({ url: config.redis_url, namespace: o.namespace, log });
  const queues = createQueues({ url: config.redis_url, namespace: o.namespace });
  const embed = createEmbedder({ url: config.embed_url });
  const chat = createChat({ llm: config.llm });
  const tei = createTei({ config, cache, log });

  const submit: LibraryApiDeps['submit'] = (input) =>
    submitJob(
      {
        queues,
        create: async (row) => {
          const r = await repos.jobs.create(ctxOf(), row);
          return { id: r.job.id, created: r.created };
        },
        log,
      },
      input,
    );

  const store = createGraphStore({ repos, cache, embed, hubMin: config.graph.query.hub_min, log });
  const skills = createSkillChannel({ repos, tei, config, cache, log });
  const caps = createSessionCaps();
  const drain = createSpoolDrain({ dir: config.spool.dir, keepDays: config.spool.keep_days, queues, repos, log });

  const library: LibraryApiDeps = { repos, config, submit, cache, ctxOf, log };
  const graph = { repos, config, submit, embed, cache, store, ctxOf, log, guardTrips: (ctx: Ctx, since: Date | null) => countGuardTrips(repos, ctx, since) };
  const memory: MemoryApiDeps = { repos, config, embed, chat, submit, cache, ctxOf, log };
  const enqueue = async (ctx: Ctx, step: { id: number; runId: number; nodeId: string; visit: number; attempt: number }, id: string): Promise<void> => {
    await submit({
      queue: 'runner', kind: 'step', id,
      payload: { userId: ctx.userId, runId: String(step.runId), stepId: String(step.id), nodeId: step.nodeId, visit: step.visit, attempt: step.attempt, timeoutS: await stepTimeoutS(runs, ctx, step) },
    });
  };
  const runs: WorkflowApiDeps = {
    repos, config, ctxOf, log, library, runsDir: o.runsDir,
    enqueueStep: (ctx, step) => enqueue(ctx, step, runnerJobId(step)),
    enqueueResume: (ctx, step, jobId) => enqueue(ctx, step, jobId),
  };

  const nudge = nudgeRoute(drain);
  const routes: Route[] = [
    ...libraryRoutes(library),
    ...graphRoutes(graph),
    ...memoryRoutes(memory),
    hookStartRoute(memory),
    ...runsRoutes(runs),
    ...workflowRoutes(runs),
    ...suggestRoutes({ repos, tei, config, graph: store, skills, cache, ctxOf, log }),
    ...preRoutes({ repos, config, graph: store, cache, caps, ctxOf, log }),
    { method: nudge.method, url: nudge.url, handler: async (req, reply) => nudge.handler(req, reply) },
  ];
  const tools: McpTool[] = [
    ...graphTools({ ...graph, onToolCall: (info) => caps.markGraphCall(info) }),
    ...libraryTools(library),
    ...memoryTools(memory),
    ...workflowTools(runs),
  ];

  let stopped = false;
  let warmTimer: NodeJS.Timeout | undefined;
  let inval: { close(): Promise<void> } | undefined;

  /** Loads the RAM graph of the newest projects and the skill vectors; on a failure, tries again in 5 s. Hooks answer 204 until it has worked. */
  async function warm(): Promise<void> {
    if (stopped) return;
    let ok = false;
    try {
      const page = await repos.projects.list(ctxOf(), { limit: WARM_PROJECTS });
      for (const p of page.rows) await store.get({ ...ctxOf(), projectId: p.id });
      ok = (await skills.reload(ctxOf())).ok;
    } catch (e) {
      log('warm-up failed', { error: errClass(e) });
    }
    if (!ok && !stopped) {
      warmTimer = setTimeout(() => void warm(), WARM_RETRY_MS);
      warmTimer.unref();
    }
  }

  return {
    routes,
    tools,
    mcpProject: async (root) => (await repos.projects.byRoot(ctxOf(), root))?.id,
    probes: {
      db: () => db.kysely.selectNoFrom((eb) => eb.lit(1).as('ok')).execute().then(() => true),
      redis: async () => {
        await cache.get('health:probe');
        return cache.up;
      },
    },
    async start() {
      void warm();
      try {
        inval = await cache.subscribeInval((msg) => {
          store.onInval(msg);
          skills.onInval(msg);
        });
      } catch (e) {
        // judgment: without the subscription the stores still reload on their own age limit (60 s)
        log('inval subscription failed', { error: errClass(e) });
      }
      await drain.start();
    },
    async stop() {
      stopped = true;
      clearTimeout(warmTimer);
      await inval?.close().catch(() => undefined);
      await drain.close();
      await queues.close();
      await cache.close();
    },
  };
}
