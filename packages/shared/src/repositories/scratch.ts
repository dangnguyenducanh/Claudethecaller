/** Test helper (not exported from index.ts): a throw-away schema `ctc_t13_<random>` in the scratch Postgres, migrated with the T1.2 migrations. */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate } from './admin/index.ts';
import { createDb, type Db } from './db.ts';
import { createRepositories, type Repositories } from './index.ts';

const SCRATCH_HOST = '127.0.0.1';
const SCRATCH_PORT = '18304';

export function scratchUrl(): string {
  const url = process.env['CTC_SCRATCH_PG_URL'] ?? process.env['CTC_TEST_DATABASE_URL'] ?? '';
  const u = new URL(url);
  if (u.hostname !== SCRATCH_HOST || u.port !== SCRATCH_PORT) throw new Error(`refusing ${u.hostname}:${u.port}, only the scratch Postgres ${SCRATCH_HOST}:${SCRATCH_PORT}`);
  return url;
}

export type Scratch = { url: string; schema: string; db: Db; repos: Repositories; drop(): Promise<void> };

/**
 * Migrates a fresh schema and opens a `Db` on it.
 * `epochColumns`: projects.graph_epoch / projects.mem_epoch are assumed by D10 but T1.2's migrations do not create them yet
 * (schema-assumptions.test.ts reports that); they are added to the throw-away schema only so the functions that use them can be tested.
 */
export async function scratch(o: { statementTimeoutMs?: number } = {}): Promise<Scratch> {
  const url = scratchUrl();
  const schema = `ctc_t13_${randomBytes(4).toString('hex')}`;
  await migrate({ url, schema });
  await exec(url, `alter table "${schema}".projects add column if not exists graph_epoch bigint not null default 0, add column if not exists mem_epoch bigint not null default 0`);
  const db = createDb({ url, schema, ...(o.statementTimeoutMs === undefined ? {} : { statementTimeoutMs: o.statementTimeoutMs }) });
  const repos = createRepositories(db);
  return {
    url, schema, db, repos,
    async drop() {
      await db.close();
      await exec(url, `drop schema if exists "${schema}" cascade`);
    },
  };
}

export async function exec(url: string, text: string): Promise<pg.QueryResult> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    return await client.query(text);
  } finally {
    await client.end();
  }
}
