/**
 * Start-up checks and the JSON log line of `ctc-worker`: the dev-instance isolation guards, the schema and namespace env values, the log writer.
 * Called from: ./main.ts (before any connection is opened) and ./guards.test.ts. The same rules as apps/web/src/server/guards.ts, kept as a copy because
 * an app does not import another app's source. Why it exists: a dev run (`CTC_HOME` set) must never reach the live
 * daemon port, its Redis or any database but the scratch one, even when an env variable is missed (owner rule O12), and a bad value must stop the start
 * with the setting's name and never a password.
 * Deliberately NOT done: opening a connection, reading `~/.claude` or `~/.claudethecaller`, shared mode, any logging of a URL.
 * Untrusted: every env value and every config value.
 */

/** Dev instances run on 18400-18499: the range the owner reserved for dev runs; everything below it belongs to the live services. */
export const devPorts = { min: 18400, max: 18499 };

/** The only Postgres and Redis a dev instance may use (the scratch services). */
export const scratch = { postgres: { host: '127.0.0.1', port: '18304' }, redis: { host: '127.0.0.1', port: '18395' } };

/** Same pattern as `createDb` (packages/shared/src/repositories/db.ts), so a bad value is refused here with a message instead of a TypeError. */
export const SCHEMA = /^[a-z_][a-z0-9_]{0,40}$/;

export type Log = (message: string, fields?: Record<string, unknown>) => void;

/** One JSON object per line on stdout; `msg` always wins over a field of the same name. Callers pass class names and counts, never URLs or bodies. */
export const jsonLog: Log = (message, fields = {}) => {
  process.stdout.write(`${JSON.stringify({ ...fields, msg: message })}\n`);
};

export type Refusal = { setting: string; reason: string };

const hostPort = (url: string): { host: string; port: string } | null => {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: u.port };
  } catch {
    return null;
  }
};

/**
 * Why a dev instance (`CTC_HOME` set) must not start with this config, or `null`. The messages name the setting only: a URL, and so a password,
 * is never part of them.
 */
export function devRefusal(config: { port: number; database_url: string | null; redis_url: string }): Refusal | null {
  if (config.port < devPorts.min || config.port > devPorts.max) {
    return { setting: 'port', reason: `port ${config.port} is outside ${devPorts.min}-${devPorts.max}` };
  }
  const db = config.database_url === null ? null : hostPort(config.database_url);
  if (db !== null && (db.host !== scratch.postgres.host || db.port !== scratch.postgres.port)) {
    return { setting: 'database_url', reason: `database_url is not the scratch Postgres ${scratch.postgres.host}:${scratch.postgres.port}` };
  }
  const redis = hostPort(config.redis_url);
  if (redis === null || redis.host !== scratch.redis.host || redis.port !== scratch.redis.port) {
    return { setting: 'redis_url', reason: `redis_url is not the scratch Redis ${scratch.redis.host}:${scratch.redis.port}` };
  }
  return null;
}

/** `CTC_DB_SCHEMA` (default `ctc`), or a refusal naming it. */
export function schemaOf(env: Record<string, string | undefined>): { schema: string } | Refusal {
  const raw = env['CTC_DB_SCHEMA'];
  if (raw === undefined || raw === '') return { schema: 'ctc' };
  return SCHEMA.test(raw) ? { schema: raw } : { setting: 'CTC_DB_SCHEMA', reason: `CTC_DB_SCHEMA must match ${SCHEMA.source}` };
}

/** `CTC_REDIS_NAMESPACE` (default empty): the key prefix of the cache and of the BullMQ keys. */
export const namespaceOf = (env: Record<string, string | undefined>): string => env['CTC_REDIS_NAMESPACE'] ?? '';

export const isRefusal = (v: { schema: string } | Refusal): v is Refusal => 'reason' in v;

/** Prints the refusal as one log line and exits 78 (EX_CONFIG, so a unit can use `RestartPreventExitStatus=78`). */
export function refuse(r: Refusal): never {
  jsonLog('refused', { setting: r.setting, reason: r.reason });
  process.stderr.write(`${r.reason}\n`);
  return process.exit(78);
}
