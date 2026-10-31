/**
 * Connection handle and small SQL helpers shared by every domain file.
 *
 * Called from: `createRepositories` (index.ts) and apps that open a pool with `createDb`.
 * Why: one place sets `search_path`, `statement_timeout`, the pool size and the value parsers, so no domain file repeats them.
 * Deliberately NOT done: reading `.env`, choosing the URL (the app passes it), logging, retrying.
 */
import pg from 'pg';
import { CamelCasePlugin, Kysely, PostgresDialect, sql, type RawBuilder } from 'kysely';
import { RepoError } from './errors.ts';
import { limits } from './limits.ts';

type Json = unknown;
type T = Date;

/** Kysely table types, camelCase (the CamelCasePlugin maps them to the snake_case columns). Vector and `tsv` columns are typed `string`/omitted. */
export interface Database {
  projects: { userId: string; id: string; root: string; profileHash: string | null; name: string; embedding: string | null; createdAt: T; lastActive: T; graphEpoch: number; memEpoch: number };
  sessions: { id: string; userId: string; projectId: string; startedAt: T; endedAt: T | null; model: string; tokens: number; transcriptPath: string | null; title: string; source: string; status: string; gitBranch: string | null; processedAt: T | null };
  historyFiles: { userId: string; path: string; size: number; mtime: number; status: string; sessionId: string | null; rows: number; error: string | null; importedAt: T };
  jobs: { id: string; userId: string; queue: string; kind: string; status: string; progress: number; result: Json; error: string | null; createdAt: T; payload: Json; attempts: number; updatedAt: T };
  idempotencyKeys: { userId: string; key: string; route: string; payloadHash: string; response: Json; createdAt: T };
  apiKeys: { id: number; keyHash: string; userId: string; name: string; createdAt: T; revokedAt: T | null };
  dedupReview: { id: number; userId: string; a: string; b: string; similarity: number; status: string; at: T };
  graphNodes: { userId: string; projectId: string; id: string; kind: string; type: string; label: string; sourceFile: string | null; sourceLocation: string | null; origin: string; contentHash: string; embedding: string | null; meta: Json; text: string; updatedAt: T };
  graphEdges: { userId: string; projectId: string; src: string; dst: string; relation: string; confidence: string; score: number; origin: string; sourceLocation: string | null };
  graphSources: { userId: string; projectId: string; file: string; contentHash: string; extractorVersion: string; builtAtCommit: string | null };
  capabilities: { id: string; userId: string; namespace: string; kind: string; name: string; rootPath: string; servedVersion: number | null; removedAt: T | null; enrichment: Json };
  capabilityVersions: { id: string; capId: string; version: number; bodyHash: string; description: string; frontmatter: Json; labels: string[]; commitMessage: string | null; createdAt: T };
  capFiles: { versionId: string; path: string; blobHash: string };
  capBlobs: { userId: string; hash: string; content: string; size: number };
  capVectors: { capId: string; textHash: string; embedding: string; model: string };
  overrides: { userId: string; projectId: string | null; capId: string; action: string; label: string | null; version: number | null };
  memories: { id: string; userId: string; scope: string; projectId: string | null; kind: string; text: string; hash: string; source: Json; supersededBy: string | null; confidence: number; pinned: boolean; reinforcementDates: string[]; createdAt: T; updatedAt: T; lastUsedAt: T | null; useCount: number; deletedAt: T | null; embedding: string | null };
  sessionSummaries: { sessionId: string; userId: string; projectId: string; request: string; investigated: string; learned: string; completed: string; nextSteps: string; notes: string; contentHash: string; createdAt: T };
  wfRuns: { id: number; userId: string; owner: string; workflowCapId: string | null; workflowVersion: number; status: string; state: Json; trigger: string; inputs: Json; repo: string | null; baseBranch: string | null; createdAt: T; startedAt: T | null; endedAt: T | null; legacy: Json };
  wfSteps: { id: number; runId: number; nodeId: string; visit: number; attempt: number; status: string };
  wfSchedules: { userId: string; owner: string; workflow: string; cron: string; input: string; enabled: boolean; lastFiredAt: T | null };
}

export type Db = { kysely: Kysely<Database>; close(): Promise<void> };
export type K = Kysely<Database>;

const SCHEMA = /^[a-z_][a-z0-9_]{0,40}$/;
const INT8 = 20;
const DATE = 1082;
const DATE_ARRAY = 1182;

/** `bigint` columns that fit 2^53 become numbers; `date` stays `YYYY-MM-DD` text (a JS Date would shift it by the local zone). */
const getTypeParser = ((oid: number, format?: 'text' | 'binary') => {
  if (oid === INT8) return (v: string) => (Number.isSafeInteger(Number(v)) ? Number(v) : v);
  if (oid === DATE) return (v: string) => v;
  if (oid === DATE_ARRAY) return (v: string) => (v === '{}' ? [] : v.slice(1, -1).split(','));
  return pg.types.getTypeParser(oid, format);
}) as typeof pg.types.getTypeParser;

/**
 * Opens a pool whose every connection has `statement_timeout` and `search_path = <schema>, extensions, public`
 * (`extensions` holds the pgvector type, `public` is kept for older installs). Throws `TypeError` for a bad schema name.
 */
export function createDb(opts: { url: string; schema?: string; max?: number; statementTimeoutMs?: number }): Db {
  const schema = opts.schema ?? 'ctc';
  if (!SCHEMA.test(schema)) throw new TypeError(`schema must match ${SCHEMA.source}`);
  const timeout = Math.trunc(opts.statementTimeoutMs ?? limits.statementTimeoutMs);
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 2147483647) throw new TypeError('statementTimeoutMs must be between 0 and 2147483647');
  const pool = new pg.Pool({
    connectionString: opts.url,
    max: opts.max ?? 5,
    connectionTimeoutMillis: 5000,
    types: { getTypeParser },
    options: `-c search_path=${schema},extensions,public -c statement_timeout=${timeout}`,
  });
  pool.on('error', () => undefined);
  const kysely = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin({ maintainNestedObjectKeys: true })],
  });
  return { kysely, close: () => kysely.destroy() };
}

export async function rows<R>(k: K, q: RawBuilder<R>): Promise<R[]> {
  return (await q.execute(k)).rows;
}

export async function first<R>(k: K, q: RawBuilder<R>): Promise<R | null> {
  return (await rows(k, q))[0] ?? null;
}

/** Rows changed by an insert/update/delete without `returning`. */
export async function changed(k: K, q: RawBuilder<unknown>): Promise<number> {
  return Number((await q.execute(k)).numAffectedRows ?? 0);
}

export const jsonb = (v: unknown): RawBuilder<unknown> => sql`${JSON.stringify(v ?? null)}::jsonb`;

export const VECTOR_DIM = 1024;

/** A pgvector literal from a number array; `RepoError('invalid')` unless it is exactly 1024 finite numbers. */
export function vec(e: unknown): RawBuilder<unknown> {
  if (!Array.isArray(e) || e.length !== VECTOR_DIM || !e.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    throw new RepoError('invalid', `embedding must be ${VECTOR_DIM} finite numbers`);
  }
  return sql`${`[${e.join(',')}]`}::vector`;
}

export const parseVec = (s: string): number[] => JSON.parse(s) as number[];

/** Fixed map from an input key to its column and cast; only these keys of a patch ever reach SQL (D1a, D1b). */
export type Cols = Record<string, { col: string; type?: 'jsonb' | 'timestamptz' | 'text' | 'int' | 'bigint' | 'real' | 'boolean' }>;

/** The `{col, value}` pairs for the keys of `patch` that `allowed` names and that are not `undefined`; unknown keys are ignored. */
export function pick(patch: object | undefined, allowed: Cols): { col: RawBuilder<unknown>; value: RawBuilder<unknown> }[] {
  const out: { col: RawBuilder<unknown>; value: RawBuilder<unknown> }[] = [];
  for (const [key, spec] of Object.entries(allowed)) {
    if (!patch || !Object.hasOwn(patch, key)) continue;
    const v = (patch as Record<string, unknown>)[key];
    if (v === undefined) continue;
    const value = v === null ? sql`null` : spec.type === 'jsonb' ? jsonb(v) : spec.type ? sql`${v}::${sql.raw(spec.type)}` : sql`${v}`;
    out.push({ col: sql.raw(`"${spec.col}"`), value });
  }
  return out;
}

export const setList = (patch: object | undefined, allowed: Cols): RawBuilder<unknown>[] =>
  pick(patch, allowed).map(({ col, value }) => sql`${col} = ${value}`);
