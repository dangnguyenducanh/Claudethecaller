/**
 * Zod schemas of the F2 library surface: `/api` capability routes and the two MCP tools. Called from apps/web/src/library
 * (routes and tools validate with them) and, later, the dashboard. Why: one place defines which request values are valid, so the
 * route handlers and the tools share the same bounds. Deliberately NOT done: I/O, repository calls, uuid checks of ids (an id that is
 * not the caller's is `not_found`, never `invalid`, D4). Every value that reaches these schemas is untrusted.
 */
import { z } from 'zod';

/** Spec limits: spec:146 (`limit` ≤ 500), spec:158 (10 candidates). The other numbers were chosen by judgment (D2). */
export const libraryApiLimits = {
  listDefault: 50,
  listMax: 500,
  labelsMax: 20,
  qMax: 200,
  cursorMax: 512,
  nameMax: 200,
  pathMax: 1024,
  candidatesMax: 10,
};

/** Same literal as `LABEL_RE` of @ctc/core/library (spec:389); `@ctc/shared` cannot import `@ctc/core`. */
const LABEL_RE = /^[a-z0-9_\-.]{1,36}$/;
const KINDS = ['skill', 'agent', 'command', 'workflow'] as const;
const MAX_VERSION = 999_999_999;

function parseBounded(v: unknown, max: number): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^[0-9]+$/.test(v) ? Number(v) : Number.NaN;
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

/** An integer or a digit string in `1..999999999`, else `null`. */
export const parseVersionNumber = (v: unknown): number | null => parseBounded(v, MAX_VERSION);

const bounded = (max: number, what: string) =>
  z
    .union([z.number().int().min(1).max(max), z.string().regex(/^[0-9]+$/)])
    .transform((v) => Number(v))
    .refine((n) => Number.isInteger(n) && n >= 1 && n <= max, `${what} must be an integer from 1 to ${max}`);
const versionNumber = bounded(MAX_VERSION, 'version');
const label = z.string().regex(LABEL_RE, 'label must match [a-z0-9_.-]{1,36}');
const bothGiven = 'give label or version, not both';

export const CapabilityListQuery = z.object({
  kind: z.enum(KINDS).optional(),
  label: label.optional(),
  q: z.string().max(libraryApiLimits.qMax).optional(),
  limit: bounded(libraryApiLimits.listMax, 'limit').optional(),
  cursor: z.string().max(libraryApiLimits.cursorMax).optional(),
});
export const VersionParams = z.object({ id: z.string(), v: versionNumber });
export const DiffQuery = z.object({ against: versionNumber });
export const LabelsBody = z.strictObject({ labels: z.array(label).min(1).max(libraryApiLimits.labelsMax) });
export const RestoreBody = z.strictObject({ version: versionNumber });
export const OverrideParams = z.object({ pid: z.string(), id: z.string() });
export const OverrideBody = z.discriminatedUnion('action', [
  z
    .strictObject({ action: z.literal('pin'), label: label.optional(), version: versionNumber.optional() })
    .refine((b) => (b.label === undefined) !== (b.version === undefined), { message: bothGiven }),
  z.strictObject({ action: z.literal('block') }),
]);
export const GetCapabilityArgs = z
  .object({ name: z.string().trim().min(1).max(libraryApiLimits.nameMax), label: label.optional(), version: versionNumber.optional() })
  .refine((a) => a.label === undefined || a.version === undefined, { message: bothGiven });
export const LoadResourceArgs = z.object({ version_id: z.string().min(1).max(64), path: z.string().min(1).max(libraryApiLimits.pathMax) });

export type CapabilityListQuery = z.infer<typeof CapabilityListQuery>;
export type VersionParams = z.infer<typeof VersionParams>;
export type DiffQuery = z.infer<typeof DiffQuery>;
export type LabelsBody = z.infer<typeof LabelsBody>;
export type RestoreBody = z.infer<typeof RestoreBody>;
export type OverrideParams = z.infer<typeof OverrideParams>;
export type OverrideBody = z.infer<typeof OverrideBody>;
export type GetCapabilityArgs = z.infer<typeof GetCapabilityArgs>;
export type LoadResourceArgs = z.infer<typeof LoadResourceArgs>;
