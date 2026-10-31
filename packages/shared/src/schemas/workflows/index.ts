/**
 * Zod schemas of the F4 workflow routes and MCP tools: start a run, approve a gate, list runs, `run_workflow`, `workflow_status`. Called from
 * apps/web/src/runs (`workflows.ts`, `start.ts`, `tools.ts`), which has no `zod` dependency. Why: one place defines which request values are
 * valid. Deliberately NOT done: the size and path rules of `repo`, `base` and `inputs` (they are `startLimits` in apps/web, read at call time),
 * I/O, id lookups (a bad id is `not_found`, D4). Every value that reaches these schemas is untrusted.
 */
import { z } from 'zod';

const digits = /^[1-9][0-9]{0,15}$/;
const id = z.union([z.number().int().positive(), z.string().regex(digits, 'must be a positive integer')]).transform((v) => Number(v));
const inputs = z.record(z.string(), z.unknown());

/** `POST /api/workflows/:id/runs`; `repo` and `base` may be null (same as absent). */
export const StartRunBody = z.strictObject({ inputs: inputs.nullish(), repo: z.string().nullish(), base: z.string().nullish() });

/** `POST /api/runs/:rid/approve` */
export const ApproveBody = z.strictObject({ step_id: id, option_id: z.string().min(1).max(40) });

/** `GET /api/runs` */
export const RunListQuery = z.object({
  limit: z.union([z.number().int(), z.string().regex(/^[0-9]+$/)]).transform((v) => Number(v)).refine((n) => n >= 1 && n <= 500, 'limit must be an integer from 1 to 500').optional(),
  cursor: z.string().max(512).optional(),
});

/** MCP `run_workflow` */
export const RunWorkflowArgs = z.strictObject({ name: z.string().min(1).max(200), inputs: inputs.nullish(), repo: z.string().nullish(), base: z.string().nullish() });

/** MCP `workflow_status` */
export const WorkflowStatusArgs = z.strictObject({ run_id: id });
