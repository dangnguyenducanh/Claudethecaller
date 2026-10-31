/** Module constants, read at call time so a test can assign to them and restore them. */
export const limits = {
  /** FROM-SPEC (spec:146 "limit <= 500"). */
  maxPage: 500,
  /** chosen by judgment: the dashboard-sized page. */
  defaultPage: 50,
  /** FROM-SPEC (spec:161): 5 s on `/api`; workers pass their own value to `createDb`. */
  statementTimeoutMs: 5000,
  /** FROM-SPEC (spec:536 "`mem_get` ids <= 20"). */
  manyIds: 20,
};

/** Clamps a caller's limit into `1..max`; a missing or non-numeric limit gives `fallback`. */
export function clampLimit(limit: unknown, max: number = limits.maxPage, fallback: number = limits.defaultPage): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return Math.min(fallback, max);
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}
