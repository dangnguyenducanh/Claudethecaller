/**
 * Cleanup of a finished run (D22): archive the logs as `.gz`, `git worktree remove` every clean ctc worktree of the run (never forced, never a
 * branch), prune old idempotency receipts. Called from: the worker main binds `cleanupHandlers(deps)` into `startWorkers({ handlers })`; the boot
 * or a timer calls `scheduleCleanup(deps)`. Why: spec:687. Deliberately NOT done: a force flag (a dirty or locked worktree is kept and reported:
 * an agent that did not commit would lose work), deleting a branch, touching any path outside `<repo>/<worktree.dir>/<runId>/`.
 * Untrusted: the worktree path stored in a step row (checked with `underWorktrees` before git sees it).
 */
import fs from 'node:fs';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { JobDropped } from '@ctc/shared/queues';
import { createSystemCtx, type Ctx } from '@ctc/shared/repositories';
import type { Handler } from '../jobs/index.ts';
import { FINAL_RUN, nowOf, underWorktrees, type EngineDeps } from './common.ts';
import { gitErrorLine, repoKey, runGit, withRepo } from './git.ts';
import { attemptPaths } from './types.ts';

const DAY_MS = 86_400_000;
type Kept = { stepId: number; reason: string };
type Result = { runId: string; removed: number; kept: Kept[]; archived: number; due: boolean };

/** Gzips `file` to `file.gz` and deletes `file` only after the copy is complete and its gunzipped length equals the original. */
async function archive(file: string): Promise<boolean> {
  const size = await fs.promises.stat(file).then((s) => (s.isFile() ? s.size : -1), () => -1);
  if (size < 0) return false;
  const gz = `${file}.gz`;
  await pipeline(fs.createReadStream(file), zlib.createGzip(), fs.createWriteStream(gz, { mode: 0o600 }));
  let length = 0;
  const count = new Writable({ write: (chunk: Buffer, _enc, cb) => ((length += chunk.length), cb()) });
  await pipeline(fs.createReadStream(gz), zlib.createGunzip(), count);
  if (length !== size) return false;
  await fs.promises.rm(file);
  return true;
}

function reasonOf(text: string): string {
  if (/modified or untracked files/.test(text)) return 'dirty';
  if (/locked/.test(text)) return 'locked';
  return `git: ${text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? 'failed'}`;
}

export function cleanupHandlers(deps: EngineDeps): { 'cleanup.worktree': Handler; 'cleanup.receipts': Handler } {
  const worktree = async (payload: { userId: string; runId: string }): Promise<Result> => {
    const ctx: Ctx = { userId: payload.userId };
    const port = deps.repos.runner;
    const run = await port.getRun(ctx, Number(payload.runId));
    if (run === null) throw new JobDropped('run_not_found');
    const keepDays = deps.config.runner.worktree.keep_days;
    const due = FINAL_RUN.includes(run.status) && run.endedAt !== null && nowOf(deps).getTime() - run.endedAt.getTime() >= keepDays * DAY_MS;
    if (!due) return { runId: payload.runId, removed: 0, kept: [], archived: 0, due: false };
    const result: Result = { runId: payload.runId, removed: 0, kept: [], archived: 0, due: true };
    const key = run.repo === null ? null : await repoKey(run.repo);
    const handled = new Set<string>();
    for (const step of await port.listSteps(ctx, run.id)) {
      const p = attemptPaths(deps.runsDir, run.id, step.id);
      for (const file of [p.log, p.log.replace(/\.jsonl$/, '.out'), p.err, p.setup]) {
        try {
          if (await archive(file)) result.archived++;
        } catch (e) {
          deps.log?.('log archive failed', { runId: run.id, stepId: step.id, error: e instanceof Error ? e.constructor.name : typeof e });
        }
      }
      const wt = step.worktree;
      if (key === null || run.repo === null || !underWorktrees(deps, run, wt) || handled.has(wt) || !fs.existsSync(wt)) continue;
      handled.add(wt);
      const r = await withRepo(key, () => runGit({ repo: run.repo as string, args: ['worktree', 'remove', wt], outFile: p.git, timeoutMs: 60_000 }));
      if (r.code === 0) result.removed++;
      else result.kept.push({ stepId: step.id, reason: reasonOf(r.text || gitErrorLine(r)) });
    }
    return result;
  };
  const receipts = async (): Promise<{ pruned: number }> => ({
    pruned: await deps.repos.system.cleanup.pruneIdempotencyKeys(createSystemCtx('cleanup receipts'), 30),
  });
  return { 'cleanup.worktree': worktree as unknown as Handler, 'cleanup.receipts': receipts as unknown as Handler };
}

/** Submits one `cleanup.worktree` job per run finished more than `keep_days` ago (job id `cleanup:worktree:<runId>`, so a repeat is the same job). */
export async function scheduleCleanup(deps: EngineDeps): Promise<{ submitted: number }> {
  const runs = await deps.repos.system.cleanup.listFinishedRuns(createSystemCtx('cleanup schedule'), deps.config.runner.worktree.keep_days);
  for (const run of runs) {
    await deps.submit({ queue: 'cleanup', kind: 'worktree', id: `cleanup:worktree:${run.id}`, payload: { userId: run.userId, runId: String(run.id) } });
  }
  return { submitted: runs.length };
}
