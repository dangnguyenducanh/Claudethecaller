/**
 * Process helpers of the runner cold path: run an argv as the leader of its own process group with capped output, kill a group, read the start
 * time of a pid. Called from: ./index.ts (git, repo setup, restart sweep) and ./follow.ts (agent). Why: one place owns signalling, so the rule
 * "a pid is signalled only while its start time matches" and "TERM, grace, KILL" are written once (D19).
 * Deliberately NOT done: any shell (the callers pass an argv; the two `sh -c` live in index.ts), status writes, restarting anything.
 * Untrusted: argv strings and cwd (passed through as-is, never joined into a shell line), every byte a child writes (capped, written to a file).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { runnerExecLimits } from '@ctc/core/runner';

export type RunGroupOptions = {
  cmd: string[]; cwd: string; env: Record<string, string>; timeoutMs: number; maxOutputBytes: number; outFile: string;
  signal?: AbortSignal; onStart?(pid: number): void | Promise<void>;
};
export type RunGroupResult = { code: number | null; timedOut: boolean; overflow: boolean; aborted: boolean };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Linux `USER_HZ`; /proc start times are in ticks. chosen by judgment: it is 100 on every Linux build this runs on. */
const TICKS_PER_SECOND = 100;

/** The worker environment without any `CTC_*` variable (D1c): its database and Redis URLs must never reach repo code or an agent. */
export function scrubbedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('CTC_')) env[k] = v;
  return { ...env, ...extra };
}

/** Start time of a live, non-zombie process (`/proc/<pid>/stat` field 22 plus `btime`); null when it does not exist, is a zombie, or /proc is unreadable. */
export async function procStartTime(pid: number): Promise<Date | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stat = await fs.promises.readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // fields[0] is field 3 (state)
    const state = fields[0];
    const ticks = Number(fields[19]);
    if (state === 'Z' || state === 'X' || !Number.isFinite(ticks)) return null;
    const btime = /^btime (\d+)$/m.exec(await fs.promises.readFile('/proc/stat', 'utf8'));
    if (btime === null) return null;
    return new Date(Number(btime[1]) * 1000 + Math.round((ticks * 1000) / TICKS_PER_SECOND));
  } catch {
    return null;
  }
}

/** True while some member of the group `pgid` exists. */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const signalGroup = (pgid: number, sig: NodeJS.Signals): void => {
  try {
    process.kill(-pgid, sig);
  } catch {
    // ESRCH: nothing left to signal
  }
};

/** TERM to the whole group, `killGraceMs` for it to leave, then KILL when any member is left. Callers check ownership first (D19). */
export async function killGroup(pgid: number): Promise<void> {
  signalGroup(pgid, 'SIGTERM');
  const end = Date.now() + runnerExecLimits.killGraceMs;
  while (Date.now() < end) {
    if (!groupAlive(pgid)) return;
    await sleep(25);
  }
  if (groupAlive(pgid)) signalGroup(pgid, 'SIGKILL');
}

/** Kills the group of `pid` only while its start time still matches `startedAt` (or always when this process started it: `own`). */
export async function killIfOurs(pid: number | null, startedAt: Date | null, own: boolean): Promise<void> {
  if (pid === null) return;
  if (!own) {
    const now = await procStartTime(pid);
    if (now === null || startedAt === null || Math.abs(now.getTime() - startedAt.getTime()) > runnerExecLimits.pidStartToleranceMs) return;
  }
  await killGroup(pid);
}

/**
 * Runs `cmd` (argv, no shell) as leader of a new process group; stdout and stderr go to `outFile` (appended, mode 0600) up to `maxOutputBytes`.
 * On timeout, overflow or abort the group is killed (TERM, grace, KILL). Resolves after the leader exited; members left after a normal exit are
 * killed so nothing started here outlives the call. Rejects only when the process cannot be started (e.g. ENOENT).
 */
export async function runGroup(o: RunGroupOptions): Promise<RunGroupResult> {
  const result: RunGroupResult = { code: null, timedOut: false, overflow: false, aborted: false };
  if (o.signal?.aborted) return { ...result, aborted: true };
  const fd = fs.openSync(o.outFile, 'a', 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(o.cmd[0] ?? '', o.cmd.slice(1), { cwd: o.cwd, env: o.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
  let written = 0;
  let killing: Promise<void> | null = null;
  const stop = (): void => {
    if (killing === null && child.pid !== undefined) killing = killGroup(child.pid);
  };
  const onData = (chunk: Buffer): void => {
    if (result.overflow) return;
    const room = o.maxOutputBytes - written;
    if (chunk.length > room) {
      result.overflow = true;
      if (room > 0) fs.writeSync(fd, chunk, 0, room);
      written = o.maxOutputBytes;
      stop();
      return;
    }
    fs.writeSync(fd, chunk);
    written += chunk.length;
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  const timer = setTimeout(() => {
    result.timedOut = true;
    stop();
  }, o.timeoutMs);
  const onAbort = (): void => {
    result.aborted = true;
    stop();
  };
  o.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const exited = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => {
        result.code = code;
        if (child.pid !== undefined && groupAlive(child.pid)) signalGroup(child.pid, 'SIGKILL');
        setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          resolve();
        }, 100); // a process that left the group may keep the pipes open; the output so far is enough
      });
    });
    if (child.pid !== undefined && o.onStart !== undefined) {
      try {
        await o.onStart(child.pid);
      } catch (e) {
        stop();
        await exited.catch(() => undefined);
        await killing;
        throw e;
      }
    }
    await exited;
    await killing;
    return result;
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', onAbort);
    fs.closeSync(fd);
  }
}
