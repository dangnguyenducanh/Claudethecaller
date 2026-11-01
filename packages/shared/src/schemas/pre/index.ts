/**
 * Zod schema of the pre-tool hook body (`POST /v1/hook/pre`). Called from apps/web/src/pre. Why: one place defines which request bodies are valid (spec:146).
 * Deliberately NOT done: I/O, the absolute-path check of `cwd` and the `session_id` rule (the route does them; a bad `session_id` is ignored, not a rejection).
 * Every value that reaches this schema is untrusted; extra keys (`session_id`, `transcript_path`, ...) are kept and ignored.
 */
import { z } from 'zod';

/** `cwdMax` 4,096 is Linux PATH_MAX as in the memory and suggest schemas; `toolNameMax` and `sessionIdMax` chosen by judgment. */
export const preApiLimits = { cwdMax: 4096, toolNameMax: 64, sessionIdMax: 128 };

export const PreBody = z.looseObject({
  cwd: z.string().min(1).max(preApiLimits.cwdMax),
  tool_name: z.string().min(1).max(preApiLimits.toolNameMax),
  tool_input: z.record(z.string(), z.unknown()).default({}),
});
