/**
 * The shell node (D15): one `sh -c` line per step, run through T6.2 `runGroup` in the carried worktree or the repo. Called from: ./engine.ts (the
 * `runner.step` handler for a `shell` node). Why: a workflow needs plain commands (tests, `ls`, `git status`) between agent steps. Deliberately NOT
 * done: a pid on the step (a crash is T6.2's restart sweep, which makes it `start_unknown`; the engine never re-runs a shell), killing a quiet
 * shell, a fallback from a missing worktree to the main checkout. Untrusted: the command text (only the node's own `run` reaches `sh -c`; every
 * substituted value is single-quoted), what the command prints.
 */
import fs from 'node:fs';
import { advanceStage, renderTemplate, transitionStep, type Workflow, type WorkflowNode } from '@ctc/core/runner';
import type { Ctx } from '@ctc/shared/repositories';
import { cut, engineLimits, Ended, failNow, scopeFor, upstreamWorktree, watchStep, type EngineDeps } from './common.ts';
import { runGroup, scrubbedEnv } from './proc.ts';
import { attemptPaths, type Run, type Step } from './types.ts';
import { workflowLimits } from '@ctc/core/runner';

/** Last `chars` characters of a file (UTF-8, lossy at the cut). */
export async function tailOf(file: string, chars: number): Promise<string> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, chars * 4);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return buf.toString('utf8').slice(-chars);
  } finally {
    await fh.close();
  }
}

/** Runs a claimed (`running`) shell step to its final status. Unwinds with `Ended` when the step was cancelled. */
export async function runShell(
  deps: EngineDeps, a: { ctx: Ctx; step: Step; run: Run; wf: Workflow; node: WorkflowNode; signal: AbortSignal },
): Promise<void> {
  const { ctx, run, wf, node } = a;
  const port = deps.repos.runner;
  let step = a.step;
  const steps = await port.listSteps(ctx, run.id);
  const carried = upstreamWorktree(wf, steps, node.id);
  const cwd = node.cwd === 'repo' ? run.repo : carried;
  if (cwd === null || !cwd.startsWith('/')) {
    await failNow(deps, ctx, step, 'no worktree to run in');
    throw new Ended();
  }
  const line = cut(renderTemplate(node.run ?? '', scopeFor(wf, run, steps), { shell: true }).text);
  const paths = attemptPaths(deps.runsDir, run.id, step.id);
  const outFile = paths.log.replace(/\.jsonl$/, '.out');
  await fs.promises.mkdir(paths.dir, { recursive: true, mode: 0o700 });
  step = (await port.setStepFields(ctx, step.id, { logPath: outFile })) ?? step;
  step = await advanceStage(port, ctx, step, 'spawn');
  const timeoutS = node.timeoutS ?? workflowLimits.shellTimeoutS;
  const cap = engineLimits.shellOutputMaxBytes;
  const watch = watchStep(deps, ctx, step.id, a.signal);
  let res;
  try {
    res = await runGroup({
      cmd: ['/bin/sh', '-c', line], cwd, outFile, maxOutputBytes: cap, timeoutMs: timeoutS * 1000, signal: watch.signal,
      env: scrubbedEnv({ CTC_ROOT_PATH: run.repo ?? '', CTC_WORKTREE_PATH: carried ?? '', CTC_RUN_ID: String(run.id), CTC_STEP_ID: String(step.id) }),
    });
  } catch (e) {
    watch.stop();
    await failNow(deps, ctx, step, `shell failed: ${(e as NodeJS.ErrnoException).code ?? 'spawn'}`);
    throw new Ended();
  }
  watch.stop();
  const live = await port.getStep(ctx, step.id);
  if (live === null || live.status !== 'running') throw new Ended();
  const tail = await tailOf(outFile, workflowLimits.outTailChars).catch(() => '');
  const output = (outcome: string) => ({ outcome, summary: tail, exitCode: res.code, stdoutTail: tail });
  const patch = (outcome: string) => ({ stage: 'report', output: output(outcome) });
  if (res.aborted || res.timedOut) await failNow(deps, ctx, live, `shell timed out after ${timeoutS} s`, 'timeout', patch('failed'));
  else if (res.overflow) await failNow(deps, ctx, live, `shell output over ${Number((cap / 1048576).toFixed(2))} MB`, 'failed', patch('failed'));
  else if (res.code !== 0) await failNow(deps, ctx, live, `shell failed: exit ${res.code ?? 'signal'}`, 'failed', patch('failed'));
  else await transitionStep(port, ctx, { stepId: live.id, from: 'running', to: 'done', patch: { ...patch('done'), endedAt: new Date() } });
}
