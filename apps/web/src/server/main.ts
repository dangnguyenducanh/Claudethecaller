#!/usr/bin/env node
/**
 * `ctc-web`: the process that serves the hooks, the `/api` routes and `/mcp` on `127.0.0.1:<port>` and a unix socket.
 * Called from: systemd (`deploy/systemd/ctc-web.service`), a human, and ./switch.live.int.test.ts. Why it exists: the earlier tasks built the routes, tools
 * and the spool drain as plain objects; this is the one place that loads the config, checks the schema stamp, builds them and keeps them running (spec:80-91).
 * Env: the config variables of packages/shared/src/env (all through `loadConfigOrExit`) plus `CTC_DB_SCHEMA` (default `ctc`) and `CTC_REDIS_NAMESPACE`.
 * Exit codes: 0 after a clean stop, 78 for a bad config, a refused dev setting, a schema stamp mismatch, shared mode or no bind within 60 s, 1 for anything else.
 * Deliberately NOT done: migrating (the stamp is only checked; `ctc migrate` migrates), shared mode and API keys, static dashboard files, the Python
 * service's `/api/schedules*`, reading or writing `~/.claude` in a dev run (`CTC_HOME` set moves every `~` of the config under it).
 * Untrusted: every env value; secrets are never logged.
 */
import os from 'node:os';
import path from 'node:path';
import { loadConfigOrExit } from '@ctc/shared/env';
import { createDb } from '@ctc/shared/repositories';
import { assertSchemaVersion, MigrationError } from '@ctc/shared/repositories/admin';
import { buildApp } from './app.ts';
import { composeWeb } from './compose.ts';
import { devRefusal, isRefusal, jsonLog as log, namespaceOf, refuse, schemaOf } from './guards.ts';
import { BindError, listenPort, listenSocket, type Listener } from './listen.ts';

/** `TimeoutStopSec` of the unit (deploy/systemd/ctc-web.service). */
const STOP_BUDGET_MS = 15_000;

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
    // judgment: any other error here (the database is down, say) is not a stamp error; hooks must still answer from RAM (spec:204)
    log('schema check skipped', { error: errClass(e) });
  }

  const db = createDb({ url, schema, max: config.db_pool.max });
  const web = composeWeb({ config, db, namespace: namespaceOf(env), runsDir: path.join(home, '.claudethecaller', 'runs'), log });
  const { app, routes } = await buildApp({ routes: web.routes, tools: web.tools, probes: web.probes, log });
  await web.start();

  const listeners: Listener[] = [];
  let stopping = false;
  const shutdown = async (code: number): Promise<never> => {
    if (stopping) process.exit(1);
    stopping = true;
    setTimeout(() => process.exit(1), STOP_BUDGET_MS).unref();
    await Promise.allSettled(listeners.map((l) => l.close()));
    await web.stop().catch(() => undefined);
    await app.close().catch(() => undefined);
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
    listeners.push(await listenPort(app.routing, config.port, log));
    const socket = await listenSocket(app.routing, config.socket, log);
    if (socket !== null) listeners.push(socket);
  } catch (e) {
    log('bind failed', { error: errClass(e) });
    await shutdown(e instanceof BindError ? 78 : 1);
  }
  log('ready', { app: 'ctc-web', port: config.port, routes, socket: listeners.length > 1 });
}

main().catch((e: unknown) => {
  log('start failed', { error: errClass(e) });
  process.exit(e instanceof BindError ? 78 : 1);
});
