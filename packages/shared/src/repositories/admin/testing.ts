/** Test helper: scratch databases named `ctc_t12_<random>` on the server named by CTC_TEST_ADMIN_URL; nothing else is created or dropped. */
import { randomBytes } from 'node:crypto';
import pg from 'pg';

export const ADMIN_URL = process.env['CTC_TEST_ADMIN_URL'];

const withDatabase = (url: string, name: string): string => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

async function admin(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** Runs `fn` with the URL of a fresh empty database, then drops it. */
export async function withDb<T>(fn: (url: string, name: string) => Promise<T>): Promise<T> {
  const name = `ctc_t12_${randomBytes(4).toString('hex')}`;
  await admin(`create database ${name}`);
  try {
    return await fn(withDatabase(ADMIN_URL as string, name), name);
  } finally {
    await admin(`drop database if exists ${name} with (force)`);
  }
}

/** Runs one or more statements; returns the rows of the last one. */
export async function sql(url: string, text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    const res = await client.query(text, params);
    return (Array.isArray(res) ? (res.at(-1) as pg.QueryResult).rows : res.rows) as Record<string, unknown>[];
  } finally {
    await client.end();
  }
}

export async function scalar(url: string, text: string): Promise<unknown> {
  const rows = await sql(url, text);
  return Object.values(rows[0] ?? {})[0];
}
