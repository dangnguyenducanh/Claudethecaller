/**
 * Zod schemas of the four F4 step-route bodies (retry, fail, cancel, report). Called from apps/web/src/runs, which has no `zod` dependency
 * and imports them from here. Why: one place defines which request values are valid. Deliberately NOT done: length cuts (the route cuts
 * `summary` and `reason`, D2), I/O, id checks (a bad id is `not_found`, D4). Every value that reaches these schemas is untrusted.
 */
import { z } from 'zod';

/** retry and cancel: no key is allowed (a `userId` key is `invalid`, D1b). */
export const EmptyBody = z.strictObject({});

/** fail: only an optional reason; its length is cut by the route, not rejected. */
export const FailBody = z.strictObject({ reason: z.string().optional() });

/** report: unknown keys are stripped (D1b), `summary` may be absent or null (D5). */
export const ReportBody = z.object({ outcome: z.enum(['done', 'failed']), summary: z.string().nullish() });
