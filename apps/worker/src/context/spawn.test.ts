import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { spawnClaude } from './index.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t23-bin-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const bin = (name: string, body: string): string => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return f;
};
const run = (b: string, o: { timeoutMs?: number; maxChars?: number } = {}, signal = new AbortController().signal) => spawnClaude({ bin: b, ...o })({ prompt: 'PROMPT-TEXT', signal });

describe('spawnClaude (fake shell scripts only, never the real claude binary)', () => {
  it('sends the prompt on stdin with `-p --model haiku` in a fresh temp directory that is removed afterwards (D15)', async () => {
    expect(await run(bin('echo-claude', 'cat'))).toBe('PROMPT-TEXT');
    expect((await run(bin('args-claude', 'cat >/dev/null; echo "$@"'))).trim()).toBe('-p --model haiku');
    const cwd = (await run(bin('pwd-claude', 'cat >/dev/null; pwd'))).trim();
    expect(cwd.startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
    expect(fs.existsSync(cwd)).toBe(false);
  });

  it('rejects on exit code, missing binary, timeout, abort and oversized replies without leaking stderr (D15)', async () => {
    await expect(run(bin('fail-claude', 'cat >/dev/null; echo SECRETERR >&2; exit 3'))).rejects.toSatisfy((e: Error) => !/SECRETERR/.test(e.message));
    await expect(run(path.join(dir, 'does-not-exist'))).rejects.toMatchObject({ code: 'ENOENT' });
    const t0 = Date.now();
    await expect(run(bin('slow-claude', 'exec sleep 20'), { timeoutMs: 300 })).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(5000);
    await expect(run(bin('big-claude', 'cat >/dev/null; head -c 5000 /dev/zero | tr "\\0" a'), { maxChars: 100 })).rejects.toThrow();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const t1 = Date.now();
    await expect(run(bin('slow2-claude', 'exec sleep 20'), {}, ac.signal)).rejects.toThrow();
    expect(Date.now() - t1).toBeLessThan(5000);
  });
});
