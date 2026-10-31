/**
 * Shared plumbing of the library surface: dependency and route/tool types, the error model of D3, schema parsing, JSON mappers.
 * Called from: routes.ts, tools.ts, restore.ts, served.ts. Why: one place decides what an error looks like on the wire, so a handler
 * never throws and never leaks a message. Deliberately NOT done: Fastify, the MCP SDK (the web bootstrap task mounts the plain objects), auth.
 * Untrusted: every request value and every string read back from the database.
 */
import { RepoError, type Ctx, type Repositories } from '@ctc/shared/repositories';

export type LibraryApiDeps = {
  repos: Repositories;
  config: { mode: 'local' | 'shared' | string; claude_home: string; library: { roots: string[]; default_label: string } };
  submit(input: { queue: string; kind: string; payload: unknown; id?: string }): Promise<{ id: string }>;
  cache?: {
    get<T>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
    del(...keys: string[]): Promise<void>;
    publishInval(msg: unknown): Promise<void>;
  };
  ctxOf?(req: unknown): Ctx;
  log?(message: string, fields?: Record<string, unknown>): void;
};

export type Route = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  handler(
    req: { params?: unknown; query?: unknown; body?: unknown; headers?: Record<string, string | string[] | undefined> },
    reply: { code(n: number): { send(body?: unknown): unknown } },
  ): Promise<unknown>;
};
export type McpResult = { content: [{ type: 'text'; text: string }]; isError?: true };
export type McpTool = {
  name: string;
  description: string;
  inputSchema: { safeParse(v: unknown): unknown };
  call(ctx: Ctx, args: unknown): Promise<McpResult>;
};

export type ErrorCode =
  | 'invalid' | 'unauthorized' | 'not_found' | 'conflict' | 'stale_attempt' | 'idempotency_mismatch' | 'ambiguous' | 'store_timeout' | 'internal';
const STATUS: Record<ErrorCode, number> = {
  invalid: 422, unauthorized: 401, not_found: 404, conflict: 409, stale_attempt: 409, idempotency_mismatch: 409, ambiguous: 409, store_timeout: 504, internal: 500,
};

/** An error that becomes a reply. `extra` is merged into the error body (`path`, `candidates`). */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly extra: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.extra = extra;
  }
}

export const notFound = (message = 'not found'): ApiError => new ApiError('not_found', message);
export const conflict = (message: string): ApiError => new ApiError('conflict', message);

/** Maps any thrown value: ApiError as is, RepoError by its code, anything else is `internal` with the class name only (D3). */
export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof RepoError) return new ApiError(e.code, e.message, e.code === 'invalid' ? { path: [] } : {});
  return new ApiError('internal', e instanceof Error ? e.constructor.name : typeof e);
}

export const errorBody = (e: ApiError): { error: { code: ErrorCode; message: string } & Record<string, unknown> } => ({
  error: { code: e.code, message: e.message, ...e.extra },
});
export const statusOf = (e: ApiError): number => STATUS[e.code];

type Issue = { path: PropertyKey[]; message: string };
type Schema<T> = { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: Issue[] } } };

/** Validates one request part; the first Zod issue becomes `invalid` with `path = [part, ...issue.path]`. */
export function parse<T>(schema: Schema<T>, part: 'params' | 'query' | 'body' | 'args', value: unknown): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const path = [part, ...(issue?.path ?? []).map((p) => (typeof p === 'number' ? p : String(p)))];
  throw new ApiError('invalid', issue?.message ?? 'invalid input', { path });
}

/** The caller's ctx: `deps.ctxOf(req)` or the local user (D10). */
export const ctxFor = (deps: LibraryApiDeps, req: unknown): Ctx => deps.ctxOf?.(req) ?? { userId: 'local' };

export function iso(d: unknown): string {
  return d instanceof Date ? d.toISOString() : String(d);
}

type Row<K extends keyof Repositories['library']> = NonNullable<Awaited<ReturnType<Repositories['library'][K]>>>;
export type Capability = Row<'get'>;
export type Version = Row<'getVersion'>;

export const capabilityJson = (c: Capability) => ({
  id: c.id, namespace: c.namespace, kind: c.kind, name: c.name, rootPath: c.rootPath, servedVersion: c.servedVersion ?? null,
  removedAt: c.removedAt ? iso(c.removedAt) : null, enrichment: c.enrichment ?? null,
});

export const versionJson = (v: Version) => ({
  id: v.id, capId: v.capId, version: v.version, bodyHash: v.bodyHash, description: v.description, frontmatter: v.frontmatter ?? {},
  labels: [...v.labels], commitMessage: v.commitMessage ?? null, createdAt: iso(v.createdAt),
});
