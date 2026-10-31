/**
 * Zod payload schemas for every (queue, kind) pair, keyed `'<queue>.<kind>'` (spec:196). Called from: submit.ts (before
 * anything is written) and apps/worker consumers (re-validated at consume time: Redis contents are not trusted).
 * Fields are placeholders; later tasks add fields here. Deliberately NOT done: coercion, defaults, stripping (unknown keys are rejected).
 */
import { z } from 'zod';
import { QUEUES } from './defs.ts';

const userId = z.string().min(1).max(128);
const id = z.string().min(1);
const posInt = z.int().min(1);

export const payloads: Record<string, z.ZodType> = {
  'graph.rebuild': z.strictObject({ userId, projectId: id, force: z.boolean().optional(), files: z.array(z.string()).optional() }),
  'graph.extract': z.strictObject({ userId, projectId: id, files: z.array(z.string()) }),
  'library.scan': z.strictObject({ userId, roots: z.array(z.string()).optional() }),
  'library.changed': z.strictObject({ userId, capId: id, version: posInt }),
  'llm.enrich': z.strictObject({ userId, capId: id }),
  'llm.extract': z.strictObject({ userId, projectId: id.optional(), sessionId: id, transcriptPath: z.string().optional() }),
  'llm.summarize': z.strictObject({ userId, projectId: id.optional(), sessionId: id }),
  'memory.import': z.strictObject({ userId, paths: z.array(z.string()).optional() }),
  'memory.distill': z.strictObject({ userId, limit: posInt.optional() }),
  'runner.step': z.strictObject({ userId, runId: id, stepId: id, nodeId: id, visit: posInt, attempt: posInt, timeoutS: posInt }),
  'cleanup.worktree': z.strictObject({ userId, runId: id }),
  'cleanup.blobs': z.strictObject({}),
  'cleanup.receipts': z.strictObject({}),
  'dlq-retry.run': z.strictObject({}),
};

export type PayloadIssue = { path: PropertyKey[]; message: string };

/** Code `invalid` (spec:152). `issues` has every problem, `message` the first one. */
export class PayloadInvalidError extends Error {
  readonly code = 'invalid';
  readonly issues: readonly PayloadIssue[];
  constructor(issues: readonly PayloadIssue[]) {
    const first = issues[0];
    super(first ? [first.path.map(String).join('.'), first.message].filter(Boolean).join(': ') : 'invalid payload');
    this.name = 'PayloadInvalidError';
    this.issues = issues;
  }
}

/** Validated copy of `data` for the pair, or a `PayloadInvalidError` (unknown queue or kind included). Never edits `data`. */
export function parsePayload(queue: string, kind: string, data: unknown): unknown {
  const def = Object.hasOwn(QUEUES, queue) ? QUEUES[queue] : undefined;
  if (!def) throw new PayloadInvalidError([{ path: ['queue'], message: `unknown queue ${queue}` }]);
  const schema = Object.hasOwn(def.kinds, kind) ? payloads[`${queue}.${kind}`] : undefined;
  if (!schema) throw new PayloadInvalidError([{ path: ['kind'], message: `unknown kind ${kind} for queue ${queue}` }]);
  const res = schema.safeParse(data);
  if (!res.success) throw new PayloadInvalidError(res.error.issues);
  return res.data;
}
