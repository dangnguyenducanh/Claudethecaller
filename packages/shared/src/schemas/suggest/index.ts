/**
 * Zod schema of the prompt hook and `/v1/suggest` body. Called from apps/web/src/suggest (both routes validate with it).
 * Why: one place defines which request bodies are valid (spec:146). Deliberately NOT done: I/O, the absolute-path check of `cwd` (the route does it),
 * cutting a long prompt (the route cuts to 20,000), refusing a blank prompt (a blank prompt is valid and answers an empty line).
 * Every value that reaches this schema is untrusted; extra keys (`session_id`, `transcript_path`, ...) are kept and ignored.
 */
import { z } from 'zod';

/** `cwdMax` 4,096 is Linux PATH_MAX, as in the memory schema. */
export const suggestApiLimits = { cwdMax: 4096 };

export const SuggestBody = z.looseObject({ prompt: z.string(), cwd: z.string().min(1).max(suggestApiLimits.cwdMax) });
