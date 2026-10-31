/**
 * Wires the real dependencies of `ctc-worker` into the handler factories of the earlier tasks and returns the one handler table for `startWorkers`.
 * Called from: ./main.ts and ./switch.worker.int.test.ts. Why it exists: every factory takes its dependencies as arguments (spec:88); something has to hold
 * the one repository set, cache, embedder, chat client and `submit`, and decide which wrapper goes around which handler.
 * Deliberately NOT done: starting workers, loops or watchers (./main.ts), config loading, opening or closing the database, an `llm.enrich` handler (no task
 * builds it; a submitted `llm.enrich` job stays queued and shows its age on the Jobs page, spec:202), `runnerHandlers` on its own (the engine wraps it).
 * Untrusted: nothing read here; the handlers re-validate their payloads.
 */
import { createCache } from '@ctc/shared/cache';
import type { Config } from '@ctc/shared/env';
import { createChat, createEmbedder } from '@ctc/shared/models';
import { createQueues, submitJob, type JobRow, type JobsPort } from '@ctc/shared/queues';
import { createRepositories, createSystemCtx, type Ctx, type Db } from '@ctc/shared/repositories';
import { extractHandler, spawnClaude, withCapabilityLinks, withContextPass, type RunClaude } from '../context/index.ts';
import { graphHandlers } from '../graph/index.ts';
import type { Handler } from '../jobs/index.ts';
import { blobCleanupHandlers, libraryHandlers } from '../library/index.ts';
import { memoryHandlers, memoryJobHandlers } from '../memory/index.ts';
import { cleanupHandlers, workflowHandlers, type EngineDeps } from '../runner/index.ts';
import type { Log } from './guards.ts';

/** The twelve keys of the handler table (spec:81, spec:186-196). `llm.enrich` is missing on purpose; `dlq-retry.run` is the framework's. */
export const HANDLER_KEYS = [
  'cleanup.blobs', 'cleanup.receipts', 'cleanup.worktree', 'graph.extract', 'graph.rebuild', 'library.changed', 'library.scan',
  'llm.extract', 'llm.summarize', 'memory.distill', 'memory.import', 'runner.step',
] as const;

const ctx = (): Ctx => ({ userId: 'local' });

/** Merges handler tables; a key that two modules both define is a boot error (the key is named). */
export function mergeHandlers(...tables: Record<string, Handler>[]): Record<string, Handler> {
  const out: Record<string, Handler> = {};
  for (const table of tables) {
    for (const [key, handler] of Object.entries(table)) {
      if (Object.hasOwn(out, key)) throw new Error(`duplicate handler key ${key}`);
      out[key] = handler;
    }
  }
  return out;
}

/** Stands in for `claude -p` in a dev run: a dev instance must not start the real CLI (it would write session files under the real home). The handler drops the job. */
const noClaude: RunClaude = async () => {
  throw Object.assign(new Error('claude is not started by a dev instance'), { code: 'ENOENT' });
};

export type Worker = {
  handlers: Record<string, Handler>;
  port: JobsPort;
  engine: EngineDeps;
  submit: (input: { queue: string; kind: string; payload: unknown; id?: string }) => Promise<{ id: string }>;
  close(): Promise<void>;
};

export function composeWorker(o: { config: Config; db: Db; namespace: string; runsDir: string; dev: boolean; log: Log }): Worker {
  const { config, db, log } = o;
  const repos = createRepositories(db);
  const cache = createCache({ url: config.redis_url, namespace: o.namespace, log });
  const queues = createQueues({ url: config.redis_url, namespace: o.namespace });
  const embed = createEmbedder({ url: config.embed_url });
  const chat = createChat({ llm: config.llm });

  const submit: Worker['submit'] = (input) =>
    submitJob(
      {
        queues,
        create: async (row) => {
          const r = await repos.jobs.create(ctx(), row);
          return { id: r.job.id, created: r.created };
        },
        log,
      },
      input,
    );

  const sctx = createSystemCtx('ctc-worker job rows');
  const jobs = repos.system.jobs;
  const port: JobsPort = {
    listQueued: async (limit) => (await jobs.listQueued(sctx, limit)) as JobRow[],
    markRunning: (id) => jobs.markRunning(sctx, id),
    markDone: (id, result) => jobs.markDone(sctx, id, result),
    markFailed: (id, error) => jobs.markFailed(sctx, id, error),
    markDead: (id, error) => jobs.markDead(sctx, id, error),
    markQueued: (id) => jobs.markQueued(sctx, id),
    setProgress: (id, progress) => jobs.setProgress(sctx, id, progress),
  };

  const engine: EngineDeps = { repos, config, runsDir: o.runsDir, reportBase: `http://127.0.0.1:${config.port}`, submit, log };
  const library = libraryHandlers({ repos, config, submit, cache, embed, log });
  const graph = graphHandlers({ repos, config, cache, embed, log });
  const handlers = mergeHandlers(
    { 'graph.rebuild': withContextPass(graph['graph.rebuild'], { repos, config, cache, embed, submit, log }) },
    { 'library.scan': library['library.scan'], 'library.changed': withCapabilityLinks(library['library.changed'], { repos, cache, log }) },
    extractHandler({ repos, config, runClaude: o.dev ? noClaude : spawnClaude(), cache, log }),
    memoryHandlers({ repos, config, embed, chat, cache, log }),
    memoryJobHandlers({ repos, config, embed, chat, submit, cache, log }),
    workflowHandlers(engine),
    cleanupHandlers(engine),
    blobCleanupHandlers({ repos, log }),
  );

  return {
    handlers, port, engine, submit,
    async close() {
      await queues.close();
      await cache.close();
    },
  };
}
