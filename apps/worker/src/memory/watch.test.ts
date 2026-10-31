import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { watchMemoryFiles } from './index.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const mkHome = (): string => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t43-'));
  dirs.push(home);
  fs.mkdirSync(path.join(home, 'projects', '-x-proj', 'memory'), { recursive: true });
  return home;
};

describe('watchMemoryFiles', () => {
  it('fires once per burst with the sorted absolute paths of changed memory files, ignoring MEMORY.md and other files', async () => {
    const home = mkHome();
    const seen: string[][] = [];
    const w = watchMemoryFiles({ claudeHome: home, debounceMs: 100, onChange: (p) => void seen.push(p) });
    try {
      await sleep(100);
      const dir = path.join(home, 'projects', '-x-proj', 'memory');
      fs.writeFileSync(path.join(dir, 'b.md'), 'x');
      fs.writeFileSync(path.join(dir, 'a.md'), 'x');
      fs.writeFileSync(path.join(dir, 'note.txt'), 'x');
      fs.writeFileSync(path.join(dir, 'MEMORY.md'), 'x');
      fs.writeFileSync(path.join(home, 'projects', '-x-proj', 'top.md'), 'x');
      await sleep(700);
    } finally {
      w.close();
    }
    expect(seen).toEqual([[path.join(home, 'projects', '-x-proj', 'memory', 'a.md'), path.join(home, 'projects', '-x-proj', 'memory', 'b.md')]]);
  });

  it('is a no-op watcher for a missing directory, logs a failing onChange by class name, and stops on close', async () => {
    const logs: unknown[][] = [];
    watchMemoryFiles({ claudeHome: path.join(os.tmpdir(), 'ctc-t43-missing'), onChange: () => undefined, log: (...a) => void logs.push(a) }).close();
    expect(logs[0]?.[0]).toBe('memory watch not started');

    const home = mkHome();
    const failures: unknown[][] = [];
    const w = watchMemoryFiles({ claudeHome: home, debounceMs: 50, onChange: () => Promise.reject(new TypeError('boom')), log: (...a) => void failures.push(a) });
    await sleep(100);
    fs.writeFileSync(path.join(home, 'projects', '-x-proj', 'memory', 'a.md'), 'x');
    await sleep(400);
    expect(failures).toEqual([['memory watch onChange failed', { error: 'TypeError' }]]);
    w.close();
    const seen: string[][] = [];
    const w2 = watchMemoryFiles({ claudeHome: home, debounceMs: 50, onChange: (p) => void seen.push(p) });
    await sleep(100);
    fs.writeFileSync(path.join(home, 'projects', '-x-proj', 'memory', 'c.md'), 'x');
    w2.close();
    await sleep(300);
    expect(seen).toEqual([]);
  });
});
