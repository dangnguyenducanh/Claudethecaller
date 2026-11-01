/**
 * Following one running agent attempt and ending it (stage `stream` and `report`). Called from: ./index.ts, for a fresh attempt (the handler)
 * and for a reattach after a worker restart (the sweep). Why: both must behave identically (D15, D16, D17), so there is one loop.
 * Deliberately NOT done: starting the agent, the worktree and setup stages, the walker; no status is written except through the T6.1 core
 * (`transitionStep`, `failStep`) and the run-status helper `parkRun`. A quiet agent is never killed for being quiet (D6b).
 * Untrusted: every byte of the agent log and of the stderr file; they are parsed defensively and never executed.
 */
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import {
  emptyStream, exitOutcome, failStep, readStreamLine, runnerExecLimits, transitionStep, type StreamState,
} from '@ctc/core/runner';
import type { Ctx } from '@ctc/shared/repositories';
import { repoKey, runGit, withRepo } from './git.ts';
import { killIfOurs, procStartTime } from './proc.ts';
import { parkRun } from './runstatus.ts';
import { attemptPaths, errClass, isConflict, isObject, sleep, type RunnerExecDeps, type Step } from './types.ts';

export type FollowInput = {
  ctx: Ctx;
  step: Step;
  agent: string;
  pid: number | null;
  pidStartedAt: Date | null;
  /** True when this process started the group (then its start time need not be re-checked before a kill). */
  own: boolean;
  /** Epoch ms after which the attempt times out, or null. */
  deadline: number | null;
  signal?: AbortSignal | undefined;
  timeoutS: number;
  /** Set when the attempt had a worktree: the diff stat is stored after the exit. */
  diff?: { worktree: string; repo: string; base: string } | undefined;
};

/** A line longer than this without a newline is dropped; chosen by judgment, far above any real agent event. */
const MAX_PARTIAL_LINE = 8 * 1024 * 1024;
const READ_CHUNK = 256 * 1024;

/** Incremental reader of the agent log: complete lines go to `readStreamLine`, an incomplete last line waits for its newline. */
export class LogTail {
  private offset = 0;
  private partial = '';
  private readonly decoder = new StringDecoder('utf8');
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
  }

  /** Feeds every new complete line; with `flush` also the last line without a newline. A missing file is an empty log. */
  async read(agent: string, state: StreamState, flush = false): Promise<StreamState> {
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(this.file, 'r');
    } catch {
      return state;
    }
    let next = state;
    try {
      const buf = Buffer.alloc(READ_CHUNK);
      for (;;) {
        const { bytesRead } = await handle.read(buf, 0, READ_CHUNK, this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;
        const lines = (this.partial + this.decoder.write(buf.subarray(0, bytesRead))).split('\n');
        this.partial = lines.pop() ?? '';
        if (this.partial.length > MAX_PARTIAL_LINE) this.partial = '';
        for (const line of lines) next = readStreamLine(agent, next, line);
      }
    } finally {
      await handle.close();
    }
    if (flush) {
      const rest = this.partial + this.decoder.end();
      this.partial = '';
      if (rest !== '') next = readStreamLine(agent, next, rest);
    }
    return next;
  }
}

/** The exit record written by the wrapper (D14b): the decimal exit status, or null when absent or not a number. */
export async function readExitRecord(file: string): Promise<number | null> {
  try {
    const text = (await fs.promises.readFile(file, 'utf8')).trim();
    return /^\d{1,3}$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
}

/** Last 4 KB of a file as text; empty when it does not exist. */
async function fileTail(file: string): Promise<string> {
  try {
    const handle = await fs.promises.open(file, 'r');
    try {
      const { size } = await handle.stat();
      const len = Math.min(size, 4096);
      const buf = Buffer.alloc(len);
      await handle.read(buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

const usageFields = (s: StreamState): Record<string, unknown> => ({
  ...(s.usage === null ? {} : { usage: s.usage }), ...(s.costUsd === null ? {} : { costUsd: s.costUsd }),
});

/** `running → start_unknown` and the run `waiting` (D15d, D18). A step another writer moved meanwhile is left alone. */
export async function markStartUnknown(deps: RunnerExecDeps, ctx: Ctx, step: Step, state: StreamState): Promise<void> {
  try {
    await transitionStep(deps.repos.runner, ctx, {
      stepId: step.id, from: 'running', to: 'start_unknown',
      patch: { liveness: 'start_unknown', promptOutcome: state.events > 0 ? 'delivered' : 'unconfirmed' },
    });
  } catch (e) {
    if (isConflict(e)) return;
    throw e;
  }
  await parkRun(deps, ctx, step.runId, 'waiting');
}

/**
 * Ends a step whose agent exited (`exitCode` set) or was stopped after another writer ended the step (`exitCode` null). A step still `running`
 * gets the exit outcome (D16b); otherwise only usage and cost are stored. With `diff`, the diff stat is merged into `output` (D16c).
 */
export async function finalizeAttempt(
  deps: RunnerExecDeps, f: Pick<FollowInput, 'ctx' | 'step' | 'diff'>, state: StreamState, exitCode: number | null, stderrTail: string,
): Promise<void> {
  const { ctx } = f;
  const port = deps.repos.runner;
  const cur = await port.getStep(ctx, f.step.id);
  if (cur === null) return;
  const extras = usageFields(state);
  const promptOutcome = state.events > 0 ? 'delivered' : 'not_delivered';
  if (cur.status === 'running' && exitCode !== null) {
    const out = exitOutcome({ exitCode, stream: state, stderrTail });
    try {
      const patch = { stage: 'report', output: out.output, ...extras, promptOutcome };
      if (out.to === 'done') await transitionStep(port, ctx, { stepId: cur.id, from: 'running', to: 'done', patch: { ...patch, endedAt: new Date() } });
      else await failStep(port, ctx, { step: cur, to: 'failed', error: out.error ?? `exit ${exitCode}`, patch, maxFailures: deps.config.runner.max_failures });
    } catch (e) {
      if (!isConflict(e)) throw e;
      if (Object.keys(extras).length > 0) await port.setStepFields(ctx, cur.id, extras);
    }
  } else if (Object.keys(extras).length > 0) {
    await port.setStepFields(ctx, cur.id, extras);
  }
  if (f.diff === undefined) return;
  const after = await port.getStep(ctx, cur.id);
  if (after === null || !isObject(after.output)) return;
  const stat = await diffStat(deps, f.diff, attemptPaths(deps.runsDir, cur.runId, cur.id).git);
  await port.setStepFields(ctx, cur.id, { output: { ...after.output, diffStat: stat } });
}

/** `git diff --shortstat <base>` in the worktree: trimmed text, `''` for no change, null when git failed (D16c). */
async function diffStat(deps: RunnerExecDeps, d: NonNullable<FollowInput['diff']>, outFile: string): Promise<string | null> {
  try {
    const key = await repoKey(d.repo);
    const r = await withRepo(key, () => runGit({ repo: d.worktree, args: ['diff', '--shortstat', d.base], outFile, timeoutMs: runnerExecLimits.gitTimeoutMs }));
    return r.code === 0 && !r.timedOut && !r.overflow ? r.text.trim() : null;
  } catch (e) {
    deps.log?.('diff stat failed', { error: errClass(e) });
    return null;
  }
}

/** The attempt ran out of time: `running → timeout` (D17). Nothing is written when the step already left `running`. */
export async function timeoutStep(deps: RunnerExecDeps, ctx: Ctx, stepId: number, timeoutS: number): Promise<void> {
  const cur = await deps.repos.runner.getStep(ctx, stepId);
  if (cur === null || cur.status !== 'running') return;
  try {
    await failStep(deps.repos.runner, ctx, { step: cur, to: 'timeout', error: `timeout after ${timeoutS} s`, maxFailures: deps.config.runner.max_failures });
  } catch (e) {
    if (!isConflict(e)) throw e;
  }
}

/**
 * Follows the agent of `f.step` until the attempt ends: reads the log every `tailPollMs`, re-reads the step every `statusPollMs`, and ends by
 * the exit record (D16), a cancel or a report (D15b), quota (D15c), a vanished leader (D15d) or the deadline or abort (D17). Writes only
 * through the T6.1 core and the run helper; resolves when the attempt has ended and the group is stopped.
 */
export async function follow(deps: RunnerExecDeps, f: FollowInput): Promise<void> {
  const { ctx } = f;
  const port = deps.repos.runner;
  const id = f.step.id;
  const paths = attemptPaths(deps.runsDir, f.step.runId, id);
  const tail = new LogTail(paths.log);
  let state = emptyStream();
  let delivered = f.step.promptOutcome === 'delivered';
  let usageKey = '';
  let usageAt = 0;
  let statusAt = Date.now();
  let goneAt: number | null = null;
  let quotaDone = false;
  const kill = (): Promise<void> => killIfOurs(f.pid, f.pidStartedAt, f.own);
  const waitExit = async (ms: number): Promise<void> => {
    const end = Date.now() + ms;
    while (Date.now() < end && (await readExitRecord(paths.exit)) === null) await sleep(Math.min(runnerExecLimits.tailPollMs, 50));
  };
  /** `running → quota`; false when the step already left `running`. */
  const parkQuota = async (): Promise<boolean> => {
    quotaDone = true;
    const until = state.quota?.resetsAt ?? null;
    try {
      await transitionStep(port, ctx, {
        stepId: id, from: 'running', to: 'quota', patch: { error: until === null ? 'usage limit' : `usage limit until ${until}`, ...usageFields(state) },
      });
      await parkRun(deps, ctx, f.step.runId, 'quota');
      await waitExit(runnerExecLimits.quotaExitGraceMs);
      await kill();
      return true;
    } catch (e) {
      if (!isConflict(e)) throw e;
      return false;
    }
  };
  const settle = async (code: number | null): Promise<void> => {
    state = await tail.read(f.agent, state, true);
    await finalizeAttempt(deps, f, state, code, code === null ? '' : await fileTail(paths.err));
  };

  for (;;) {
    const L = runnerExecLimits;
    state = await tail.read(f.agent, state);
    if (!delivered && state.events > 0) {
      delivered = true;
      await port.setStepFields(ctx, id, { promptOutcome: 'delivered' });
    }
    const key = JSON.stringify([state.usage, state.costUsd]);
    if (key !== usageKey && Date.now() - usageAt >= L.statusPollMs && Object.keys(usageFields(state)).length > 0) {
      usageKey = key;
      usageAt = Date.now();
      await port.setStepFields(ctx, id, usageFields(state));
    }

    const code = await readExitRecord(paths.exit);
    if (code !== null) {
      await kill(); // members left after the leader exited; a reattach (own=false) finds the leader gone and its start time unmatchable, so it leaves them
      state = await tail.read(f.agent, state, true);
      // `claude -p` prints the limit event and exits: that is a quota stop, not a failed attempt
      if (state.quota !== null && !quotaDone && (await parkQuota())) return;
      return settle(code);
    }

    if (f.signal?.aborted === true || (f.deadline !== null && Date.now() >= f.deadline)) {
      await kill();
      return timeoutStep(deps, ctx, id, f.timeoutS);
    }

    if (state.quota !== null && !quotaDone && (await parkQuota())) return;

    if (Date.now() - statusAt >= L.statusPollMs) {
      statusAt = Date.now();
      const cur = await port.getStep(ctx, id);
      if (cur === null || cur.status === 'cancelled') {
        await kill();
        return;
      }
      if (cur.status !== 'running') {
        await waitExit(L.reportExitGraceMs);
        await kill();
        return settle(null);
      }
    }

    if (f.pid !== null) {
      const started = await procStartTime(f.pid);
      const alive = started !== null && (f.pidStartedAt === null || Math.abs(started.getTime() - f.pidStartedAt.getTime()) <= L.pidStartToleranceMs);
      if (alive) {
        goneAt = null;
      } else {
        goneAt ??= Date.now();
        if (Date.now() - goneAt >= L.exitRecordGraceMs) {
          state = await tail.read(f.agent, state, true);
          return markStartUnknown(deps, ctx, f.step, state);
        }
      }
    }
    await sleep(L.tailPollMs);
  }
}
