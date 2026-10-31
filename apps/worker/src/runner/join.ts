/**
 * The join node (D18): `collect` passes the children's summaries on as a list (run inline by the engine), `merge` merges the children's branches
 * in index order into a worktree of its own, through T6.2 `runGit` and `withRepo`. Called from: ./engine.ts (`collectJoin` inline, `runJoin` as
 * the `runner.step` handler of a `join` node). Why: spec:676. A conflict fails the join with the file list; the child branches are kept.
 * Deliberately NOT done: resolving a conflict, touching a child branch, force flags, deleting anything, a push. Untrusted: branch names and
 * worktree paths read from step rows (checked with `isRef` and `underWorktrees` before they reach git), what git prints.
 */
import fs from 'node:fs';
import { advanceStage, isRef, outText, transitionStep, worktreeRecipe, type Workflow, type WorkflowNode } from '@ctc/core/runner';
import type { Ctx } from '@ctc/shared/repositories';
import { Ended, engineLimits, failNow, newest, underWorktrees, watchStep, type EngineDeps } from './common.ts';
import { ensureExcluded, gitErrorLine, repoKey, runGit, withRepo, type GitResult } from './git.ts';
import { attemptPaths, isObject, type Run, type Step } from './types.ts';

type Child = { index: number; nodeId: string; branch: string | null; worktree: string | null; summary: string };

/** The finished fan-out step that feeds `join` (its one incoming edge, D10) and its children list. */
function fanoutOf(wf: Workflow, steps: readonly Step[], join: WorkflowNode): { fan: Step; children: Child[]; base: string | null } | null {
  const from = wf.edges.find((e) => e.to === join.id)?.from;
  const fan = steps.filter((s) => s.nodeId === from && s.status === 'done').sort(newest)[0];
  if (fan === undefined || !isObject(fan.output)) return null;
  const list = Array.isArray(fan.output['children']) ? fan.output['children'] : [];
  const children = list.filter(isObject).map((c, i): Child => ({
    index: typeof c['index'] === 'number' ? c['index'] : i,
    nodeId: typeof c['nodeId'] === 'string' ? c['nodeId'] : `child ${i}`,
    branch: typeof c['branch'] === 'string' ? c['branch'] : null,
    worktree: typeof c['worktree'] === 'string' ? c['worktree'] : null,
    summary: typeof c['summary'] === 'string' ? c['summary'] : '',
  }));
  return { fan, children, base: isRef(fan.output['base']) ? fan.output['base'] : null };
}

/** `collect` (D18a): `running → done`; the caller has already moved the step to `running`. Fails the step when the fan-out is not finished. */
export async function collectJoin(deps: EngineDeps, ctx: Ctx, wf: Workflow, steps: readonly Step[], step: Step, node: WorkflowNode): Promise<void> {
  const found = fanoutOf(wf, steps, node);
  if (found === null) {
    await failNow(deps, ctx, step, 'join: fanout not finished', 'failed', undefined, 1);
    return;
  }
  const results = found.children.map((c) => c.summary);
  const summary = outText({ type: 'join', strategy: 'collect' }, { results });
  await transitionStep(deps.repos.runner, ctx, { stepId: step.id, from: 'running', to: 'done', patch: { output: { outcome: 'done', summary, results }, endedAt: new Date() } });
}

/** `merge` (D18b, c) for a claimed (`running`) step. Unwinds with `Ended` once the step has its final status (done, failed, cancelled). */
export async function runJoin(
  deps: EngineDeps, a: { ctx: Ctx; step: Step; run: Run; wf: Workflow; node: WorkflowNode; signal: AbortSignal },
): Promise<void> {
  const { ctx, run, wf, node } = a;
  const port = deps.repos.runner;
  const cfg = deps.config.runner;
  let step = a.step;
  const fail = async (error: string): Promise<never> => {
    await failNow(deps, ctx, step, error);
    throw new Ended();
  };
  const repo = run.repo;
  if (repo === null || !repo.startsWith('/')) return fail('join: no repository');
  const found = fanoutOf(wf, await port.listSteps(ctx, run.id), node);
  if (found === null) return fail('join: fanout not finished');
  const paths = attemptPaths(deps.runsDir, run.id, step.id);
  await fs.promises.mkdir(paths.dir, { recursive: true, mode: 0o700 });
  const watch = watchStep(deps, ctx, step.id, a.signal);
  const end = Date.now() + engineLimits.mergeTimeoutS * 1000;
  const key = await repoKey(repo);
  const git = async (cwd: string, args: string[]): Promise<GitResult> => {
    const left = end - Date.now();
    if (left <= 0) throw new Error('join timed out');
    return withRepo(key, () => runGit({ repo: cwd, args, outFile: paths.git, timeoutMs: left, signal: watch.signal }));
  };
  try {
    const identity = async (cwd: string): Promise<string[]> => {
      const r = await git(cwd, ['config', 'user.email']);
      return r.code === 0 && r.text.trim() !== '' ? [] : ['-c', 'user.name=ctc', '-c', 'user.email=ctc@localhost'];
    };
    // judgment: a child that did not commit would merge as a silent no-op, so its leftovers are committed to its own branch first.
    for (const c of found.children) {
      if (!underWorktrees(deps, run, c.worktree) || !fs.existsSync(c.worktree)) continue;
      const dirty = await git(c.worktree, ['status', '--porcelain']);
      if (dirty.code !== 0 || dirty.text.trim() === '') continue;
      const who = await identity(c.worktree);
      const add = await git(c.worktree, ['add', '-A']);
      const commit = add.code === 0 ? await git(c.worktree, [...who, 'commit', '--no-verify', '-m', `ctc: checkpoint ${c.nodeId}`]) : add;
      if (commit.code !== 0) return fail(`merge failed: ${gitErrorLine(commit)}`);
    }

    const base = found.base ?? (isRef(run.baseBranch) ? run.baseBranch : 'HEAD');
    let rec: ReturnType<typeof worktreeRecipe>;
    try {
      rec = worktreeRecipe({ repo, dir: cfg.worktree.dir, workflow: wf.name, runId: run.id, nodeId: step.nodeId, stepId: step.id, visit: step.visit, attempt: step.attempt, base });
    } catch (e) {
      return fail(`join: ${(e as Error).message}`);
    }
    step = await advanceStage(port, ctx, step, 'worktree');
    step = (await port.setStepFields(ctx, step.id, { worktree: rec.path, branch: rec.branch })) ?? step;
    const add = await withRepo(key, async () => {
      await ensureExcluded({ repo, dir: cfg.worktree.dir, outFile: paths.git, timeoutMs: 30000 });
      const r = await runGit({ repo, args: rec.add, outFile: paths.git, timeoutMs: cfg.worktree.add_timeout_s * 1000, signal: watch.signal });
      if (r.code === 0) await runGit({ repo, args: rec.config, outFile: paths.git, timeoutMs: 30000 });
      return r;
    });
    if (add.code !== 0 && !add.aborted) return fail(`join: worktree failed: ${gitErrorLine(add)}`);

    const who = await identity(rec.path);
    const merged: string[] = [];
    for (const c of found.children) {
      const branch = c.branch;
      if (!isRef(branch)) continue;
      const r = await git(rec.path, [...who, 'merge', '--no-ff', '-m', `ctc: merge ${branch}`, branch]);
      if (r.aborted) break;
      if (r.code !== 0) {
        const unmerged = await git(rec.path, ['diff', '--name-only', '--diff-filter=U']);
        const files = unmerged.text.split('\n').map((l) => l.trim()).filter((l) => l !== '').sort().slice(0, 20);
        await git(rec.path, ['merge', '--abort']);
        return fail(files.length > 0 ? `merge conflict: ${files.join(', ')} (branch ${branch})` : `merge failed: ${gitErrorLine(r)}`);
      }
      merged.push(branch);
    }
    const live = await port.getStep(ctx, step.id);
    if (live === null || live.status !== 'running') throw new Ended();
    await transitionStep(port, ctx, {
      stepId: live.id, from: 'running', to: 'done',
      patch: { stage: 'report', endedAt: new Date(), output: { outcome: 'done', summary: `merged ${merged.length} branches`, merged, branch: rec.branch, worktree: rec.path } },
    });
  } catch (e) {
    if (e instanceof Ended) throw e;
    const live = await port.getStep(ctx, step.id);
    if (live === null || live.status !== 'running') throw new Ended();
    if (watch.reason() === 'job' || (e as Error).message === 'join timed out') {
      await failNow(deps, ctx, live, 'join: timed out', 'timeout');
      throw new Ended();
    }
    throw e;
  } finally {
    watch.stop();
  }
}
