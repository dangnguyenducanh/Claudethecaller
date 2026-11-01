/** Caller identity. `userId` comes from the verified API key (or `local`), never from a request body. */
export type Ctx = { userId: string; projectId?: string };

declare const systemBrand: unique symbol;
/** Cross-user context for the allowlisted `system` functions only; a plain `Ctx` does not fit. */
export type SystemCtx = { readonly [systemBrand]: true; readonly reason: string };

const issued = new WeakSet<object>();

/** Creates the only value `repos.system` accepts. `reason` says why the caller needs to see every user. */
export function createSystemCtx(reason: string): SystemCtx {
  if (typeof reason !== 'string' || reason.trim() === '') throw new TypeError('reason required');
  const sctx = Object.freeze({ reason }) as unknown as SystemCtx;
  issued.add(sctx);
  return sctx;
}

export const isSystemCtx = (v: unknown): v is SystemCtx => typeof v === 'object' && v !== null && issued.has(v);

/** Throws `TypeError('ctx.userId required')` unless `ctx` has a non-blank string `userId`. */
export function requireUser(ctx: unknown): asserts ctx is Ctx {
  const u = (ctx as { userId?: unknown } | null | undefined)?.userId;
  if (typeof u !== 'string' || u.trim() === '') throw new TypeError('ctx.userId required');
}

/** Returns `ctx.projectId` or throws `TypeError('ctx.projectId required')`. The id is only meaningful together with `userId` (D1c). */
export function needProject(ctx: Ctx): string {
  const p = ctx.projectId;
  if (typeof p !== 'string' || p.trim() === '') throw new TypeError('ctx.projectId required');
  return p;
}

/** Ids that are not uuids can never match a uuid column; reading them gives `null` instead of a cast error. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
