/**
 * Zod schema of one spool file envelope (`{v, event, received_at, payload}`) and its field limits. Called from: apps/web/src/spool
 * (the drain parses every file with it). Why here: apps/web has no direct `zod` dependency and Zod schemas live in packages/shared.
 * Deliberately NOT done: any I/O, routing, reading transcripts. Spool files are untrusted: a wrong envelope field makes the
 * parse fail (the drain moves the file to corrupt/); a wrong payload field counts as absent; unknown keys are ignored.
 */
import { z } from 'zod';

/** Tool names whose PostToolUse events change a file in the project (spec:508). */
export const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit'] as const;

/** Inclusive maximum string lengths. Chosen by judgment: they bound what reaches job payloads. */
export const spoolFieldLimits = { event: 32, sessionId: 256, toolName: 128, path: 4096 } as const;

const badChars = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const cleanString = (max: number) => z.string().min(1).max(max).refine((v) => !badChars.test(v));

const optionalString = (max: number) => cleanString(max).optional().catch(undefined);

const Payload = z.looseObject({
  session_id: optionalString(spoolFieldLimits.sessionId),
  cwd: optionalString(spoolFieldLimits.path),
  transcript_path: optionalString(spoolFieldLimits.path),
  tool_name: optionalString(spoolFieldLimits.toolName),
  tool_input: z.looseObject({ file_path: optionalString(spoolFieldLimits.path) }).optional().catch(undefined),
});

/** The envelope of D4. Event-specific required fields (session_id, cwd, file_path) are checked by the drain: the schema only types them. */
export const SpoolFileSchema = z.looseObject({
  v: z.literal(1),
  event: cleanString(spoolFieldLimits.event),
  received_at: z.iso.datetime(),
  payload: Payload,
});

export type SpoolFile = z.infer<typeof SpoolFileSchema>;
