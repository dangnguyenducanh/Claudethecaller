/**
 * Shared plumbing of the F3 memory surface: the dependency type, the caller's ctx, project lookup (cache first), the query embedding and the
 * JSON view of a memory. Called from: hook.ts, tools.ts, routes.ts. Why: one place decides what a project is for a path and what leaves the API.
 * Deliberately NOT done: Fastify, the MCP SDK, auth (the web bootstrap task mounts the plain objects). Untrusted: every request value and every
 * string read back from the database; nothing here edits its arguments.
 */
import path from 'node:path';
import { keys, ttl } from '@ctc/shared/cache';
import type { Chat, Embed } from '@ctc/shared/models';
import type { Ctx, Repositories } from '@ctc/shared/repositories';
import { iso } from '../library/http.ts';

export type MemoryApiDeps = {
  repos: Repositories;
  config: {
    memory: { context_chars: number; rrf: { k: number; per_leg: number }; bands: { noop: number; update: number }; half_life_days: number; start: { summaries: number; memories: number } };
  };
  embed: Embed;
  chat: Chat;
  submit(input: { queue: string; kind: string; payload: unknown; id?: string }): Promise<{ id: string }>;
  cache?: {
    get<T>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
    epoch: { get(kind: 'mem', userId: string, projectId: string): Promise<string | null>; rotate(kind: 'mem', userId: string, projectId: string): Promise<string | null> };
  };
  ctxOf?(req: unknown): Ctx;
  log?(message: string, fields?: Record<string, unknown>): void;
  now?(): number;
  today?(): string;
};

type Memory = Awaited<ReturnType<Repositories['memory']['get']>> & object;

export const errClass = (e: unknown): string => (e instanceof Error ? e.constructor.name : typeof e);
export const ctxOf = (deps: MemoryApiDeps, req: unknown): Ctx => deps.ctxOf?.(req) ?? { userId: 'local' };
export const nowOf = (deps: MemoryApiDeps): number => deps.now?.() ?? Date.now();
export const todayOf = (deps: MemoryApiDeps): string => deps.today?.() ?? new Date(nowOf(deps)).toISOString().slice(0, 10);

/** `cwd` without trailing slashes; `/` stays `/`. */
export const rootOf = (cwd: string): string => cwd.replace(/\/+$/, '') || '/';
/** The last path segment of a root; `/` for the root itself. */
export const labelOf = (root: string): string => (root === '/' ? '/' : (root.split('/').pop() ?? root));
export const isAbs = (cwd: unknown): cwd is string => typeof cwd === 'string' && path.posix.isAbsolute(cwd);

/** The user's project of `root`: the `proj:` cache first (a cache error is a miss), then the store; a found project is cached, a miss is not. */
export async function projectOf(deps: MemoryApiDeps, ctx: Ctx, root: string): Promise<{ id: string; root: string } | null> {
  const key = keys.proj(ctx.userId, root);
  try {
    const hit = await deps.cache?.get<{ id: string; root: string }>(key);
    if (hit && typeof hit.id === 'string') return hit;
  } catch {
    // judgment: a cache failure is a miss
  }
  const p = await deps.repos.projects.byRoot(ctx, root);
  if (!p) return null;
  const value = { id: p.id, root: p.root };
  try {
    await deps.cache?.set(key, value, ttl.proj);
  } catch {
    // judgment: a cache failure never fails the read
  }
  return value;
}

/** `ctx` plus the project of the call: `ctx.projectId`, else the project of an absolute `cwd`; unknown means no project. */
export async function callCtx(deps: MemoryApiDeps, ctx: Ctx, cwd: string | undefined): Promise<Ctx> {
  if (ctx.projectId !== undefined || !isAbs(cwd)) return ctx;
  const p = await projectOf(deps, ctx, rootOf(cwd));
  return p ? { ...ctx, projectId: p.id } : ctx;
}

/** One 1024-dimension vector for `text`, or `null` when the embedder fails or answers with anything else (the full-text leg alone then serves). */
export async function embedQuery(deps: MemoryApiDeps, text: string): Promise<number[] | null> {
  try {
    const [v] = await deps.embed([text]);
    return Array.isArray(v) && v.length === 1024 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? v : null;
  } catch {
    return null;
  }
}

/** Forgets the project's cached start blocks. Errors are logged by class name and ignored. */
export async function rotateMem(deps: MemoryApiDeps, ctx: Ctx, projectId: string | null | undefined): Promise<void> {
  if (!deps.cache || !projectId) return;
  try {
    await deps.cache.epoch.rotate('mem', ctx.userId, projectId);
  } catch (e) {
    deps.log?.('mem epoch rotate failed', { error: errClass(e) });
  }
}

export const memoryView = (m: Memory) => ({
  id: m.id, scope: m.scope, projectId: m.projectId, kind: m.kind, text: m.text, source: m.source, confidence: m.confidence, pinned: m.pinned,
  reinforcementDates: m.reinforcementDates.map((d) => (typeof d === 'string' ? d.slice(0, 10) : iso(d).slice(0, 10))), supersededBy: m.supersededBy,
  createdAt: iso(m.createdAt), updatedAt: iso(m.updatedAt), lastUsedAt: m.lastUsedAt ? iso(m.lastUsedAt) : null, useCount: m.useCount,
});
