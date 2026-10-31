import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { graphLimits, PACKAGES_SOURCE, walkProject } from './index.ts';
import { checkPaths } from './walk.ts';

let tmp: string;
let n = 0;
const keep = { ...graphLimits };
beforeAll(() => void (tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t22walk-'))));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
afterEach(() => void Object.assign(graphLimits, keep));
const proj = (files: Record<string, string>): string => {
  const root = path.join(tmp, `w${++n}`);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  fs.mkdirSync(root, { recursive: true });
  return root;
};
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

describe('walkProject', () => {
  it('pins the default limits (D2)', () => {
    expect({ ...graphLimits }).toEqual({ maxFileBytes: 1_048_576, maxFiles: 20_000, maxPayloadFiles: 1000, shrinkMinLoss: 3, embedBatch: 32, embedTextChars: 2000, maxPackageJson: 200, resultListMax: 100 });
    expect(PACKAGES_SOURCE).toBe('<packages>');
  });

  it('maxFileBytes is inclusive and maxFiles truncates only when one more file exists (D2)', async () => {
    const root = proj({ 'ten.ts': '0123456789', 'eleven.ts': '01234567890' });
    graphLimits.maxFileBytes = 10;
    const w = await walkProject(root);
    expect([w.files.includes('ten.ts'), w.skipped.find((x) => x.file === 'eleven.ts')?.reason]).toEqual([true, 'too_large']);
    graphLimits.maxFileBytes = 1_048_576;
    graphLimits.maxFiles = 2;
    expect(await walkProject(root)).toMatchObject({ truncated: false, files: ['eleven.ts', 'ten.ts'] });
    fs.writeFileSync(path.join(root, 'z.ts'), 'x');
    expect(await walkProject(root)).toMatchObject({ truncated: true, files: ['eleven.ts', 'ten.ts'] });
  });

  it('skips .git, node_modules, .ctc, nested ignore files with re-include, secrets and the reserved name; lists sorted (D9)', async () => {
    const root = proj({
      '.git/config': 'x', 'node_modules/x/i.js': 'x', 'sub/.ctc/wt/a.ts': 'x', '.gitignore': 'gen/\n*.log\n', 'gen/g.ts': 'x', 'app.log': 'x',
      'sub/.gitignore': '!keep.log\n', 'sub/keep.log': 'x', '.ctcignore': 'secret_dir/\n', 'secret_dir/s.ts': 'x',
      '.env.local': 'K=1', 'Key.PEM': 'x', 'id_rsa': 'x', 'credentials.json': '{}', '<packages>': 'x', 'ok.ts': 'x', 'sub/z.ts': 'x',
    });
    fs.symlinkSync(path.join(root, 'sub'), path.join(root, 'linkdir'));
    fs.symlinkSync(path.join(root, 'ok.ts'), path.join(root, 'inlink.ts'));
    const w = await walkProject(root);
    expect(w.files).toEqual([...w.files].sort(byCode));
    for (const f of ['ok.ts', 'sub/z.ts', 'sub/keep.log', 'inlink.ts', '.gitignore']) expect(w.files).toContain(f);
    expect(w.files.filter((f) => /^(\.git|node_modules|gen|secret_dir|linkdir)\/|\.ctc\/|^app\.log$|^\.env|^Key|^id_rsa|^credentials|^<packages>$/.test(f))).toEqual([]);
    const reason = (f: string) => w.skipped.find((x) => x.file === f)?.reason;
    expect(['.env.local', 'Key.PEM', 'id_rsa', 'credentials.json', '<packages>', 'app.log'].map(reason)).toEqual(['secret', 'secret', 'secret', 'secret', 'reserved', 'ignored']);
  });

  it('never reads a symlink that leaves the root (D1b)', async () => {
    const outside = path.join(tmp, `outside-${++n}.ts`);
    fs.writeFileSync(outside, 'export function stolen() {}\n');
    const root = proj({ 'ok.ts': 'x' });
    fs.symlinkSync(outside, path.join(root, 'leak.ts'));
    const w = await walkProject(root);
    expect([w.files.includes('leak.ts'), w.skipped.find((x) => x.file === 'leak.ts')?.reason]).toEqual([false, 'symlink_outside']);
  });

  it('checkPaths applies the same rules to payload entries and reports bad paths (D1c)', async () => {
    const root = proj({ 'ok.ts': 'x', '.gitignore': 'gen/\n', 'gen/g.ts': 'x', 'node_modules/m/i.ts': 'x', '.env': 'x' });
    const bad = ['../x.ts', '/etc/passwd', 'a/./b.ts', 'a\\b.ts', 'a//b.ts', 'x\u0000.ts', ''];
    const r = await checkPaths(root, [...bad, 'ok.ts', 'gen/g.ts', 'node_modules/m/i.ts', '.env', 'nope.ts']);
    expect(r.files).toEqual(['ok.ts']);
    expect(r.skipped.filter((x) => x.reason === 'bad_path').map((x) => x.file).sort(byCode)).toEqual([...bad].sort(byCode));
    expect(Object.fromEntries(r.skipped.filter((x) => x.reason !== 'bad_path').map((x) => [x.file, x.reason]))).toEqual({
      'gen/g.ts': 'ignored', 'node_modules/m/i.ts': 'ignored', '.env': 'secret', 'nope.ts': 'missing',
    });
  });

  it.skipIf(process.getuid?.() === 0)('reports an unreadable directory as a truncated walk (D8)', async () => {
    const root = proj({ 'src/a.ts': 'x', 'lib/b.ts': 'x' });
    fs.chmodSync(path.join(root, 'lib'), 0);
    try {
      expect(await walkProject(root)).toMatchObject({ files: ['src/a.ts'], truncated: true });
    } finally {
      fs.chmodSync(path.join(root, 'lib'), 0o755);
    }
  });

  it.skipIf(process.getuid?.() === 0)('reports files in a directory that cannot be stat\'ed as unreadable, not not_file (D8)', async () => {
    const root = proj({ 'src/a.ts': 'x', 'lib/b.ts': 'x' });
    fs.chmodSync(path.join(root, 'lib'), 0o644);
    try {
      const w = await walkProject(root);
      const c = await checkPaths(root, ['lib/b.ts']);
      expect([w.files, w.skipped, c.files, c.skipped]).toEqual([['src/a.ts'], [{ file: 'lib/b.ts', reason: 'unreadable' }], [], [{ file: 'lib/b.ts', reason: 'unreadable' }]]);
      fs.chmodSync(path.join(root, 'lib'), 0);
      expect((await checkPaths(root, ['lib/b.ts'])).skipped).toEqual([{ file: 'lib/b.ts', reason: 'unreadable' }]);
    } finally {
      fs.chmodSync(path.join(root, 'lib'), 0o755);
    }
  });

  it('honours the abort signal', async () => {
    const root = proj({ 'a.ts': 'x' });
    const ac = new AbortController();
    ac.abort();
    await expect(walkProject(root, { signal: ac.signal })).rejects.toThrow();
  });
});
