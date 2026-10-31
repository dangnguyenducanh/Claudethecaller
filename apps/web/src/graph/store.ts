/**
 * `createGraphStore`: the RAM graph of the projects this process serves, one built `GraphIndex` per (user, project), reloaded when it is
 * invalidated, when its Redis epoch changes or when it is older than `maxAgeMs`. Called from: tools.ts and routes.ts (one store per bootstrap),
 * and later T5.1 and T5.2 (their hot paths read the same index). Why: spec:80 keeps the graph in RAM so a query never waits on Postgres.
 * Deliberately NOT done: the `ctc:inval` subscription itself and the Postgres `graph_epoch` poll (the web bootstrap calls `onInval`), writing rows.
 * Untrusted: every row of the graph and every inval message.
 */
import { buildIndex, type GraphIndex } from '@ctc/core/graph/query';
import type { Embed } from '@ctc/shared/models';
import type { Ctx, Repositories } from '@ctc/shared/repositories';

export type LoadedGraph = { index: GraphIndex; loadedAt: number; epoch: string | null };
export type GraphStore = {
  get(ctx: Ctx & { projectId: string }): Promise<LoadedGraph>;
  invalidate(userId: string, projectId?: string): void;
  onInval(msg: unknown): void;
};

type Entry = { loaded: LoadedGraph; checkedAt: number };

const errClass = (e: unknown): string => (e instanceof Error ? e.constructor.name : typeof e);
const keyOf = (userId: string, projectId: string): string => `${userId}\u0000${projectId}`;

/** `maxProjects` 8 and `maxAgeMs` 60000 (spec:205 heals a missed message within 60 s): chosen by judgment / FROM-SPEC. */
export function createGraphStore(o: {
  repos: Repositories;
  cache?: { epoch: { get(kind: 'graph', userId: string, projectId: string): Promise<string | null> } };
  embed?: Embed;
  hubMin?: number;
  now?: () => number;
  maxProjects?: number;
  maxAgeMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}): GraphStore {
  const now = o.now ?? Date.now;
  const maxProjects = o.maxProjects ?? 8;
  const maxAgeMs = o.maxAgeMs ?? 60_000;
  const entries = new Map<string, Entry>();
  const loading = new Map<string, Promise<LoadedGraph>>();

  async function epochOf(userId: string, projectId: string): Promise<string | null> {
    try {
      return (await o.cache?.epoch.get('graph', userId, projectId)) ?? null;
    } catch {
      // judgment: Redis down means "unknown epoch": the age check still reloads within `maxAgeMs`
      return null;
    }
  }

  async function load(ctx: Ctx & { projectId: string }): Promise<LoadedGraph> {
    const c = { userId: ctx.userId, projectId: ctx.projectId };
    const epoch = await epochOf(c.userId, c.projectId);
    const [graph, vectors] = await Promise.all([o.repos.graph.loadGraph(c), o.embed ? o.repos.graph.loadVectors(c) : Promise.resolve(undefined)]);
    const index = buildIndex({ nodes: graph.nodes, edges: graph.edges, ...(vectors ? { vectors } : {}), ...(o.hubMin !== undefined ? { hubMin: o.hubMin } : {}) });
    return { index, loadedAt: now(), epoch };
  }

  function invalidate(userId: string, projectId?: string): void {
    const drop = (k: string): void => {
      entries.delete(k);
      loading.delete(k);
    };
    if (projectId !== undefined) return drop(keyOf(userId, projectId));
    for (const k of [...entries.keys(), ...loading.keys()]) if (k.startsWith(`${userId}\u0000`)) drop(k);
  }

  return {
    async get(ctx) {
      const key = keyOf(ctx.userId, ctx.projectId);
      const entry = entries.get(key);
      if (entry) {
        const fresh = now() - entry.checkedAt <= maxAgeMs;
        const stored = entry.loaded.epoch;
        const current = fresh && stored !== null ? await epochOf(ctx.userId, ctx.projectId) : null;
        if (fresh && (current === null || current === stored)) {
          entries.delete(key);
          entries.set(key, entry);
          return entry.loaded;
        }
      }
      let pending = loading.get(key);
      if (!pending) {
        const p: Promise<LoadedGraph> = load(ctx)
          .then(
            (loaded) => {
              if (loading.get(key) === p) {
                entries.delete(key);
                entries.set(key, { loaded, checkedAt: now() });
                while (entries.size > maxProjects) entries.delete(entries.keys().next().value as string);
              }
              return loaded;
            },
            (e: unknown) => {
              const stale = entries.get(key);
              if (!stale) throw e;
              // judgment: a failed reload keeps serving the stale index and tries again after `maxAgeMs`
              o.log?.('graph reload failed, serving the stale index', { error: errClass(e) });
              stale.checkedAt = now();
              return stale.loaded;
            },
          )
          .finally(() => {
            if (loading.get(key) === p) loading.delete(key);
          });
        loading.set(key, p);
        pending = p;
      }
      return pending;
    },
    invalidate,
    onInval(msg) {
      const m = msg as { event?: unknown; kind?: unknown; userId?: unknown; projectId?: unknown } | null;
      if (!m || typeof m !== 'object' || typeof m.userId !== 'string') return;
      const hit = m.event === 'graph.rebuild' || m.event === 'library.changed' || (m.event === 'epoch' && m.kind === 'graph');
      if (hit) invalidate(m.userId, typeof m.projectId === 'string' ? m.projectId : undefined);
    },
  };
}
