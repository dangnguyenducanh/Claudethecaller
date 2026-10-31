#!/usr/bin/env node
/**
 * `ctc-worker`: the process that runs the BullMQ consumers, the Redis-down poller, the workflow loop, the cleanup schedules and the file watchers.
 * Called from: systemd (`deploy/systemd/ctc-worker.service`), a human, and apps/web/src/server/switch.live.int.test.ts. Why it exists: the earlier tasks built
 * the handlers, the loop and the watchers as separate functions; this is the one place that loads the config, checks the schema stamp and starts them in the
 * order of agent/t6-3-runner-gates D0a: sweep the runner once, start the workers, then the loops and watchers.
 * Env: the same as apps/web/src/server/main.ts (`CTC_HOME`, `CTC_PORT`, `CTC_DATABASE_URL`, `CTC_REDIS_URL`, `CTC_DB_SCHEMA`, `CTC_REDIS_NAMESPACE`, ...).
 * Exit codes: 0 after a clean stop, 78 for a bad config, a refused dev setting, a schema stamp mismatch or shared mode, 1 for anything else.
 * Deliberately NOT done: migrating, shared mode, an `llm.enrich` handler, watching a library or memory root that does not exist, starting `claude` in a
 * dev run (`CTC_HOME` set), any HTTP listener (the web process serves the report route the agents call).
 * Untrusted: every env value; secrets are never logged.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfigOrExit } from '@ctc/shared/env';
import { queueLimits } from '@ctc/shared/queues';
import { createDb } from '@ctc/shared/repositories';
import { assertSchemaVersion, MigrationError } from '@ctc/shared/repositories/admin';
import { startWorkers } from '../jobs/index.ts';
import { startBlobCleanup, watchLibrary } from '../library/index.ts';
import { watchMemoryFiles } from '../memory/index.ts';
import { execDepsOf, scheduleCleanup, startRunnerLoop, sweepRunner } from '../runner/index.ts';
import { composeWorker } from './compose.ts';
import { devRefusal, isRefusal, jsonLog as log, namespaceOf, refuse, schemaOf } from './guards.ts';

/** `TimeoutStopSec` of the unit (deploy/systemd/ctc-worker.service). */
const STOP_BUDGET_MS = 15_000;
/** How often finished runs are looked at for worktree cleanup; the job id makes a repeat the same job. Chosen by judgment (the blob cleanup uses 6 h too). */
const CLEANUP_EVERY_MS = 21_600_000;

const errClass = (e: unknown): string => (e instanceof Error ? e.constructor.name : typeof e);

async function main(): Promise<void> {
  const env = process.env;
  const dev = (env['CTC_HOME'] ?? '') !== '';
  const home = dev ? (env['CTC_HOME'] as string) : os.homedir();
  const config = loadConfigOrExit(dev ? { home } : {});
  if (config.mode === 'shared') refuse({ setting: 'mode', reason: 'shared mode is not wired in this build' });
  if (dev) {
    const refusal = devRefusal(config);
    if (refusal !== null) refuse(refusal);
  }
  if (config.database_url === null) refuse({ setting: 'database_url', reason: 'database_url is not set' });
  const schemaChoice = schemaOf(env);
  if (isRefusal(schemaChoice)) refuse(schemaChoice);
  const { schema } = schemaChoice;
  const url = config.database_url as string;

  try {
    await assertSchemaVersion({ url, schema });
  } catch (e) {
    if (e instanceof MigrationError && (e.code === 'schema_too_new' || e.code === 'schema_behind')) refuse({ setting: 'schema', reason: e.message });
    // judgment: any other error here (the database is down, say) is not a stamp error; the jobs table is the truth and the poller retries
    log('schema check skipped', { error: errClass(e) });
  }

  const db = createDb({ url, schema, max: config.db_pool.max });
  const worker = composeWorker({ config, db, namespace: namespaceOf(env), runsDir: path.join(home, '.claudethecaller', 'runs'), dev, log });
  const { engine, submit } = worker;

  const closers: (() => void | Promise<void>)[] = [];
  let stopping = false;
  const shutdown = async (code: number): Promise<never> => {
    if (stopping) process.exit(1);
    stopping = true;
    setTimeout(() => process.exit(1), STOP_BUDGET_MS).unref();
    for (const close of closers.reverse()) await Promise.resolve(close()).catch(() => undefined);
    await worker.close().catch(() => undefined);
    await db.close().catch(() => undefined);
    return process.exit(code);
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      log('stopping', { signal });
      void shutdown(0);
    });
  }
  process.on('unhandledRejection', (e) => log('unhandled rejection', { error: errClass(e) }));

  try {
    // before the workers: a step that was running when the last worker died is settled first (apps/worker/src/runner/index.ts sweepRunner)
    const swept = await sweepRunner(execDepsOf(engine)).catch((e: unknown) => {
      log('runner sweep failed', { error: errClass(e) });
      return null;
    });
    if (swept !== null) log('runner swept', { steps: swept.actions.length });

    const workers = await startWorkers({ url: config.redis_url, namespace: namespaceOf(env), port: worker.port, handlers: worker.handlers, log });
    closers.push(() => workers.close({ graceMs: queueLimits.closeGraceMs }));

    const loop = startRunnerLoop(engine);
    closers.push(() => loop.stop());
    const cleanup = (): void => void scheduleCleanup(engine).catch((e: unknown) => log('cleanup schedule failed', { error: errClass(e) }));
    cleanup();
    const cleanupTimer = setInterval(cleanup, CLEANUP_EVERY_MS);
    cleanupTimer.unref();
    closers.push(() => clearInterval(cleanupTimer));
    const blobs = startBlobCleanup({ submit, log });
    closers.push(() => blobs.close());

    const roots = config.library.roots.filter((r) => fs.existsSync(r));
    if (roots.length > 0) {
      const watch = watchLibrary({ roots, onChange: async () => void (await submit({ queue: 'library', kind: 'scan', payload: { userId: 'local' } })), log });
      closers.push(() => watch.close());
    }
    if (fs.existsSync(path.join(config.claude_home, 'projects'))) {
      const watch = watchMemoryFiles({
        claudeHome: config.claude_home,
        onChange: async (paths) => void (await submit({ queue: 'memory', kind: 'import', payload: { userId: 'local', paths } })),
        log,
      });
      closers.push(() => watch.close());
    }
    log('ready', { app: 'ctc-worker', handlers: Object.keys(worker.handlers).sort(), queues: workers.queues });
  } catch (e) {
    log('start failed', { error: errClass(e) });
    await shutdown(1);
  }
}

main().catch((e: unknown) => {
  log('start failed', { error: errClass(e) });
  process.exit(1);
});
