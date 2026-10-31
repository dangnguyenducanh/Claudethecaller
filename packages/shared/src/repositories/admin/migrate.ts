/**
 * Numbered SQL migrations for the TypeScript service's Postgres schema (`ctc` by default).
 *
 * Called from: `ctc migrate` (apps/cli); every app at start through `assertSchemaVersion`; the importer (from-python.ts) for connections and errors.
 * Why: the schema is built from `packages/shared/migrations/NNNN_name.sql` and stamped in `<schema>.schema_migrations`, so an older binary
 * refuses to start on a newer database and an edited, already-applied file is caught by its checksum.
 * Deliberately NOT done: down migrations, dropping or rewriting anything, repositories or queries, printing a URL or password.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

export type ErrorCode =
  | 'bad_name'
  | 'gap'
  | 'duplicate'
  | 'checksum_mismatch'
  | 'schema_too_new'
  | 'schema_behind'
  | 'bad_schema_name'
  | 'sql_failed'
  | 'same_schema'
  | 'bad_source'
  | 'unmapped_value'
  | 'import_failed';

/** Every failure of this module. `message` is `<code>: <detail>`; extra problems follow on their own lines. Never carries a URL or password. */
export class MigrationError extends Error {
  code: ErrorCode;

  constructor(code: ErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'MigrationError';
    this.code = code;
  }
}

export type Migration = { version: number; name: string; file: string; sql: string; checksum: string };

export type MigrateResult = {
  schema: string;
  before: number;
  after: number;
  applied: { version: number; name: string }[];
  pending: { version: number; name: string }[];
};

/** Postgres identifier limit is 63 bytes; same shape as the Python store (src/ctc/storage/store.py:71). */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const FILE_NAME = /^([0-9]{4})_([a-z0-9_]+)\.sql$/;
/** Same key as the Python schema script (src/ctc/storage/schema.sql:6), so extension creation by either stack is serialized. */
const LOCK_KEY = 7426001;
/** chosen by judgment: long enough for a cold pooler, short enough that a dead host fails the CLI quickly. */
export const CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_DIR = join(import.meta.dirname, '..', '..', '..', 'migrations');

export function assertSchemaName(schema: string): void {
  if (!SCHEMA_NAME.test(schema)) throw new MigrationError('bad_schema_name', `schema name must match ${SCHEMA_NAME.source}`);
}

/** Removes every given URL, and the passwords inside them, from a message. */
export function redact(message: string, ...urls: string[]): string {
  let out = message;
  for (const url of urls) {
    out = out.split(url).join('<url>');
    try {
      const password = new URL(url).password;
      for (const p of password ? [password, decodeURIComponent(password)] : []) out = out.split(p).join('***');
    } catch {
      // not a parseable URL: nothing more to strip
    }
  }
  return out;
}

/** Types returned as the server's own text, so timestamps, JSON, dates and floats reach the target without rounding or re-serialisation. */
const RAW_TYPES = new Set([114, 700, 701, 1082, 1114, 1184, 3802]);

/** Opens a connection. A `source` connection is one read-only repeatable-read transaction for its whole life and returns exact text for `RAW_TYPES`. */
export async function connect(url: string, source = false): Promise<pg.Client> {
  const getTypeParser = ((oid: number, format?: 'text' | 'binary') =>
    RAW_TYPES.has(oid) ? (v: string) => v : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser;
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    ...(source ? { types: { getTypeParser } } : {}),
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw new MigrationError(source ? 'bad_source' : 'sql_failed', `cannot connect: ${redact(firstLine(error), url)}`);
  }
  if (source) await client.query('begin transaction isolation level repeatable read read only');
  return client;
}

export const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';

/** Reads and validates the migration files of `dir` (default `packages/shared/migrations`); non-`.sql` files are ignored. */
export function loadMigrations(dir: string = DEFAULT_DIR): Migration[] {
  const problems: { code: ErrorCode; detail: string }[] = [];
  const byVersion = new Map<number, Migration[]>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const match = FILE_NAME.exec(file);
    if (!match) {
      problems.push({ code: 'bad_name', detail: `${file} (must match ${FILE_NAME.source})` });
      continue;
    }
    const raw = readFileSync(join(dir, file));
    const migration: Migration = {
      version: Number(match[1]),
      name: match[2] as string,
      file,
      sql: raw.toString('utf8'),
      checksum: createHash('sha256').update(raw).digest('hex'),
    };
    byVersion.set(migration.version, [...(byVersion.get(migration.version) ?? []), migration]);
  }
  const versions = [...byVersion.keys()].sort((a, b) => a - b);
  for (const v of versions) {
    const same = byVersion.get(v) as Migration[];
    if (same.length > 1) problems.push({ code: 'duplicate', detail: `version ${v}: ${same.map((m) => m.file).join(', ')}` });
  }
  const last = versions.at(-1) ?? 0;
  const missing = Array.from({ length: last }, (_, i) => i + 1).filter((v) => !byVersion.has(v));
  if (missing.length > 0) problems.push({ code: 'gap', detail: `missing version ${missing.join(', ')}` });
  const first = problems[0];
  if (first) throw Object.assign(new MigrationError(first.code, first.detail), { message: problems.map((p) => `${p.code}: ${p.detail}`).join('\n') });
  return versions.map((v) => (byVersion.get(v) as Migration[])[0] as Migration);
}

const stampTable = (schema: string): string => `"${schema}".schema_migrations`;

export async function readStamps(client: pg.Client, schema: string): Promise<Map<number, string>> {
  const exists = await client.query('select to_regclass($1) as t', [stampTable(schema)]);
  if (exists.rows[0].t === null) return new Map();
  const rows = await client.query(`select version, checksum from ${stampTable(schema)}`);
  return new Map(rows.rows.map((r: { version: number; checksum: string }) => [Number(r.version), r.checksum]));
}

export const maxVersion = (stamps: Map<number, string>): number => Math.max(0, ...stamps.keys());

/** Current stamp of the schema: `max(version)` of `schema_migrations`, 0 when the schema or the table is missing. */
export async function schemaVersion(o: { url: string; schema?: string }): Promise<number> {
  const schema = o.schema ?? 'ctc';
  assertSchemaName(schema);
  const client = await connect(o.url);
  try {
    return maxVersion(await readStamps(client, schema));
  } catch (error) {
    throw new MigrationError('sql_failed', redact(firstLine(error), o.url));
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Throws `schema_too_new` when the database is ahead of the files and `schema_behind` when it is behind. */
export async function assertSchemaVersion(o: { url: string; schema?: string; dir?: string }): Promise<void> {
  const schema = o.schema ?? 'ctc';
  const latest = loadMigrations(o.dir).at(-1)?.version ?? 0;
  const have = await schemaVersion({ url: o.url, schema });
  if (have > latest) throw new MigrationError('schema_too_new', `schema ${schema} is at version ${have}, this binary knows ${latest}`);
  if (have < latest) throw new MigrationError('schema_behind', `schema ${schema} is at version ${have}, needs ${latest}; run: ctc migrate`);
}

function checkHistory(migrations: Migration[], stamps: Map<number, string>, schema: string): void {
  const latest = migrations.at(-1)?.version ?? 0;
  const unknown = [...stamps.keys()].filter((v) => !migrations.some((m) => m.version === v));
  if (unknown.length > 0) {
    throw new MigrationError('schema_too_new', `schema ${schema} has applied version ${unknown.sort((a, b) => a - b).join(', ')} with no file (files end at ${latest})`);
  }
  for (const m of migrations) {
    const applied = stamps.get(m.version);
    if (applied !== undefined && applied !== m.checksum) {
      throw new MigrationError('checksum_mismatch', `${m.file} (applied sha256 ${applied.slice(0, 8)}…, file sha256 ${m.checksum.slice(0, 8)}…)`);
    }
  }
}

/** Applies pending migrations in order, one transaction per file under the advisory lock; with `dryRun` only reports what would run. */
export async function migrate(o: { url: string; schema?: string; dir?: string; dryRun?: boolean }): Promise<MigrateResult> {
  const schema = o.schema ?? 'ctc';
  assertSchemaName(schema);
  const migrations = loadMigrations(o.dir);
  const client = await connect(o.url);
  const quoted = `"${schema}"`;
  try {
    let stamps = await readStamps(client, schema);
    checkHistory(migrations, stamps, schema);
    const before = maxVersion(stamps);
    const brief = (m: Migration): { version: number; name: string } => ({ version: m.version, name: m.name });
    if (o.dryRun) {
      const pending = migrations.filter((m) => !stamps.has(m.version)).map(brief);
      return { schema, before, after: before, applied: [], pending };
    }
    await transaction(client, async () => {
      await client.query(`create schema if not exists ${quoted}`);
      await client.query(
        `create table if not exists ${stampTable(schema)} (version int primary key, name text not null, checksum text not null, applied_at timestamptz not null default now())`,
      );
      await client.query(`alter table ${stampTable(schema)} enable row level security`);
    });
    const applied: { version: number; name: string }[] = [];
    for (const m of migrations) {
      if (stamps.has(m.version)) continue;
      const ran = await transaction(client, async () => {
        stamps = await readStamps(client, schema);
        if (stamps.has(m.version)) {
          checkHistory([m], new Map([[m.version, stamps.get(m.version) as string]]), schema);
          return false;
        }
        try {
          await client.query(m.sql.replaceAll('{schema}', quoted));
        } catch (error) {
          if (error instanceof MigrationError) throw error;
          throw new MigrationError('sql_failed', `${m.file}: ${redact(firstLine(error), o.url)}`);
        }
        await client.query(`insert into ${stampTable(schema)} (version, name, checksum) values ($1, $2, $3)`, [m.version, m.name, m.checksum]);
        return true;
      });
      if (ran) applied.push(brief(m));
    }
    const after = maxVersion(await readStamps(client, schema));
    return { schema, before, after, applied, pending: [] };
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError('sql_failed', redact(firstLine(error), o.url));
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** `begin; advisory lock; fn; commit`, rolled back when `fn` throws. */
async function transaction<T>(client: pg.Client, fn: () => Promise<T>): Promise<T> {
  await client.query('begin');
  try {
    await client.query('select pg_advisory_xact_lock($1)', [LOCK_KEY]);
    const result = await fn();
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}
