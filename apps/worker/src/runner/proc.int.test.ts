import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runnerExecLimits } from '@ctc/core/runner';
import { procStartTime, runGroup } from './index.ts';
import { withRepo } from './git.ts';
import { alive, restoreLimits, sleep, until } from './testing.ts';

let tmp: string;
const spawned: number[] = [];
beforeAll(() => void (tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t62-proc-'))));
afterEach(restoreLimits);
afterAll(() => {
  for (const pid of spawned) try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
const out = (): string => path.join(tmp, `out-${n++}`);
const base = { cwd: '/', env: { PATH: process.env['PATH'] ?? '' }, timeoutMs: 20_000, maxOutputBytes: 1 << 20 };

describe('runGroup (D19, D2)', () => {
  it('runs an argv without a shell, with exactly the given env, and reports the exit code', async () => {
    const f1 = out();
    const r = await runGroup({ ...base, cmd: ['/bin/sh', '-c', 'echo hi; echo err >&2; exit 3'], outFile: f1 });
    expect(r).toEqual({ code: 3, timedOut: false, overflow: false, aborted: false });
    expect(fs.readFileSync(f1, 'utf8')).toContain('err');
    const f2 = out();
    await runGroup({ ...base, cmd: ['/bin/echo', '$(touch /tmp/ctc-t62-never)', 'a b'], outFile: f2 });
    expect(fs.readFileSync(f2, 'utf8').trim()).toBe('$(touch /tmp/ctc-t62-never) a b');
    expect(fs.existsSync('/tmp/ctc-t62-never')).toBe(false);
    const f3 = out();
    await runGroup({ ...base, cmd: ['/usr/bin/env'], env: { A: '1' }, outFile: f3 });
    expect(fs.readFileSync(f3, 'utf8').trim()).toBe('A=1');
  });

  it('caps the output: exactly the cap is fine, one byte more is overflow and the file never exceeds the cap', async () => {
    const cap = 4096;
    const f1 = out();
    const ok = await runGroup({ ...base, cmd: ['/bin/sh', '-c', `head -c ${cap} /dev/zero`], maxOutputBytes: cap, outFile: f1 });
    expect([ok.code, ok.overflow, fs.statSync(f1).size]).toEqual([0, false, cap]);
    const f2 = out();
    const over = await runGroup({ ...base, cmd: ['/bin/sh', '-c', `head -c ${cap + 1} /dev/zero`], maxOutputBytes: cap, outFile: f2 });
    expect(over.overflow).toBe(true);
    expect(fs.statSync(f2).size).toBeLessThanOrEqual(cap);
  });

  it('kills the whole group on timeout and escalates to KILL after the grace when TERM is ignored', async () => {
    runnerExecLimits.killGraceMs = 300;
    const pidFile = path.join(tmp, 'bg.pid');
    const t0 = Date.now();
    const r = await runGroup({ ...base, cmd: ['/bin/sh', '-c', 'trap "" TERM; sleep 30 & echo $! > "$0"; wait', pidFile], timeoutMs: 300, outFile: out() });
    expect([r.timedOut, r.code]).toEqual([true, null]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(550);
    await until(async () => !alive(Number(fs.readFileSync(pidFile, 'utf8').trim())), 3000);
  });

  it('stops on abort and refuses to start when already aborted', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await runGroup({ ...base, cmd: ['/bin/sh', '-c', 'sleep 30'], outFile: out(), signal: ac.signal });
    expect([r.aborted, r.timedOut]).toEqual([true, false]);
    const done = new AbortController();
    done.abort();
    expect((await runGroup({ ...base, cmd: ['/bin/sh', '-c', 'echo x > "$0"', path.join(tmp, 'never')], outFile: out(), signal: done.signal })).aborted).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'never'))).toBe(false);
  });

  it('makes the child the leader of its own group', async () => {
    const seen: string[] = [];
    await runGroup({ ...base, cmd: ['/bin/sh', '-c', 'sleep 0.3'], outFile: out(), onStart: (pid) => void seen.push(String(pid), fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '').split(' ')[2] ?? '') });
    expect(seen[0]).toBe(seen[1]);
  });
});

describe('procStartTime (D9)', () => {
  it('is the start time of a live process and null for a missing pid, a dead process and a zombie', async () => {
    const own = (await procStartTime(process.pid)) as Date;
    expect(Math.abs(own.getTime() - (Date.now() - process.uptime() * 1000))).toBeLessThan(3000);
    expect(await procStartTime(2 ** 22 + 12345)).toBeNull();
    expect(await procStartTime(-1)).toBeNull();
    const dead = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    dead.unref();
    process.kill(dead.pid as number, 'SIGKILL');
    await until(async () => (await procStartTime(dead.pid as number)) === null, 5000);
    const zp = spawn('/bin/sh', ['-c', '/bin/sh -c "exit 0" & echo $!; exec sleep 5'], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    spawned.push(zp.pid as number);
    const zpid = Number(await new Promise<string>((res) => zp.stdout.once('data', (d: Buffer) => res(String(d).trim()))));
    await sleep(300);
    expect(await procStartTime(zpid)).toBeNull();
  });
});

describe('withRepo (D12c)', () => {
  it('runs jobs of one key one at a time, in order, and keeps going after a failing job', async () => {
    const log: string[] = [];
    const job = (name: string, ms: number, fail = false) => withRepo('k', async () => {
      log.push(`start ${name}`);
      await sleep(ms);
      log.push(`end ${name}`);
      if (fail) throw new Error('x');
    });
    const results = await Promise.allSettled([job('a', 60, true), job('b', 10), withRepo('other', async () => void log.push('other'))]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
    expect(log.filter((l) => l !== 'other')).toEqual(['start a', 'end a', 'start b', 'end b']);
    expect(log.indexOf('other')).toBeLessThan(log.indexOf('end a'));
  });
});
