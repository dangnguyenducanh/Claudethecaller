/**
 * Zod schemas of F3 memory: the SessionStart hook body, the four MCP tools and the `/api` memory routes. Called from apps/web/src/memory
 * (handlers validate with them). Why: one place defines which request values are valid. Deliberately NOT done: I/O, uuid checks of ids (an id
 * that is not the caller's is `not_found`, never `invalid`), cutting long queries (the tool cuts, spec:213), absolute-path checks of `cwd`.
 * Every value that reaches these schemas is untrusted.
 */
import { z } from 'zod';

/**
 * `listMax` / `searchMax` / `timelineMax` / `getMax`: spec:146, spec:533-536. `textMax` repeats `memoryLimits.maxMemoryChars` and `distillMax` repeats
 * `recallLimits.distillMax` of @ctc/core/memory (`@ctc/shared` cannot import `@ctc/core`; keep them equal). `cwdMax` is Linux PATH_MAX.
 * `listDefault`, `qMax`, `cursorMax` as the library API; `searchDefault`, `queryMax`, `timelineDefault`: chosen by judgment.
 */
export const memoryApiLimits = {
  listDefault: 50,
  listMax: 500,
  qMax: 200,
  cursorMax: 512,
  textMax: 300,
  queryMax: 500,
  searchDefault: 20,
  searchMax: 50,
  timelineDefault: 3,
  timelineMax: 10,
  getMax: 20,
  cwdMax: 4096,
  distillMax: 500,
};

const KINDS = ['preference', 'convention', 'fact', 'skill_outcome'] as const;
const kind = z.enum(KINDS);
const scope = z.enum(['global', 'project']);
const cwd = z.string().min(1).max(memoryApiLimits.cwdMax);
/** An integer or a digit string in `1..max` (query strings arrive as text). */
const bounded = (max: number, what: string) =>
  z
    .union([z.number().int().min(1).max(max), z.string().regex(/^[0-9]+$/)])
    .transform((v) => Number(v))
    .refine((n) => Number.isInteger(n) && n >= 1 && n <= max, `${what} must be an integer from 1 to ${max}`);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => Number.isFinite(Date.parse(`${s}T00:00:00Z`)), 'since must be a real date');

export const HookStartBody = z.looseObject({ cwd });
export const MemSearchArgs = z.object({
  query: z.string().min(1),
  scope: scope.optional(),
  kind: kind.optional(),
  since: day.optional(),
  limit: z.number().int().min(1).max(memoryApiLimits.searchMax).default(memoryApiLimits.searchDefault),
  cwd: cwd.optional(),
});
export const MemTimelineArgs = z.object({
  anchor_id: z.string().min(1),
  before: z.number().int().min(0).max(memoryApiLimits.timelineMax).default(memoryApiLimits.timelineDefault),
  after: z.number().int().min(0).max(memoryApiLimits.timelineMax).default(memoryApiLimits.timelineDefault),
  cwd: cwd.optional(),
});
export const MemGetArgs = z.object({ ids: z.array(z.string()).min(1).max(memoryApiLimits.getMax) });
export const SaveMemoryArgs = z.object({ text: z.string().min(1).max(memoryApiLimits.textMax), kind, scope, cwd: cwd.optional() });

export const MemoryListQuery = z.object({
  scope: scope.optional(),
  kind: kind.optional(),
  q: z.string().max(memoryApiLimits.qMax).optional(),
  limit: bounded(memoryApiLimits.listMax, 'limit').optional(),
  cursor: z.string().max(memoryApiLimits.cursorMax).optional(),
});
export const MemoryIdParams = z.object({ id: z.string() });
export const MemoryPatchBody = z
  .strictObject({ text: z.string().min(1).max(memoryApiLimits.textMax).optional(), pinned: z.boolean().optional(), kind: kind.optional() })
  .refine((b) => Object.keys(b).length > 0, { message: 'give text, pinned or kind' });
export const SummaryParams = z.object({ sid: z.string() });
export const HistoryListQuery = z.object({
  status: z.enum(['imported', 'skipped', 'failed']).default('imported'),
  limit: bounded(memoryApiLimits.listMax, 'limit').optional(),
});
export const HistoryImportBody = z.strictObject({ limit: bounded(memoryApiLimits.distillMax, 'limit').optional() });
