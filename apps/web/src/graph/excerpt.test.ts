import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { GNode } from '@ctc/core/graph/query';
import { readExcerpt } from './index.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t24-'));
const root = path.join(tmp, 'proj');
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.writeFileSync(path.join(root, 'src/b.ts'), `${Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join('\n')}\n`);
fs.writeFileSync(path.join(tmp, 'outside.txt'), 'secret outside\n');
fs.symlinkSync(path.join(tmp, 'outside.txt'), path.join(root, 'src/link.ts'));
fs.writeFileSync(path.join(root, 'src/bin.ts'), Buffer.from([65, 0, 66, 10]));
fs.writeFileSync(path.join(root, 'src/latin.ts'), Buffer.from([0xe9, 0xe9, 10]));
fs.writeFileSync(path.join(root, 'src/huge.ts'), 'x\n'.repeat(600_000));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const nodeOf = (o: Partial<GNode>): GNode => ({ id: 'n', kind: 'code', type: 'function', label: 'x', sourceFile: 'src/b.ts', sourceLocation: null, meta: {}, ...o });

describe('readExcerpt', () => {
  it('D13 reads the lines of meta.lines, else of the L<N> location, at most 40 from the first', async () => {
    expect(await readExcerpt(root, nodeOf({ meta: { lines: [8, 90] } }))).toBe(Array.from({ length: 40 }, (_, i) => `line${i + 8}`).join('\n'));
    expect(await readExcerpt(root, nodeOf({ meta: { lines: [98, 100] } }))).toBe('line98\nline99\nline100');
    expect(await readExcerpt(root, nodeOf({ sourceLocation: 'L5' }))).toBe(Array.from({ length: 40 }, (_, i) => `line${i + 5}`).join('\n'));
    expect(await readExcerpt(root, nodeOf({}))).toBeNull();
    expect(await readExcerpt(root, nodeOf({ meta: { lines: [2, 3] } }), async () => 'p\nq\nr\ns\n')).toBe('q\nr');
  });

  it('D1 never opens a path that leaves the root: symlink, .., ., absolute, empty and NUL are refused', async () => {
    for (const f of ['src/link.ts', '../outside.txt', '/etc/passwd', 'src/../src/b.ts', '', 'src/b.ts\0x', './src/b.ts']) {
      expect(await readExcerpt(root, nodeOf({ sourceFile: f, meta: { lines: [1, 3] } })), JSON.stringify(f)).toBeNull();
    }
    expect(await readExcerpt(root, nodeOf({ sourceFile: null, meta: { lines: [1, 3] } }))).toBeNull();
    let called = false;
    await readExcerpt(root, nodeOf({ sourceFile: '../x', meta: { lines: [1, 2] } }), async () => ((called = true), 'a'));
    expect(called).toBe(false);
  });

  it('D13 a binary, non UTF-8, huge or missing file gives null, never an error', async () => {
    for (const f of ['src/bin.ts', 'src/latin.ts', 'src/huge.ts', 'src/missing.ts']) expect(await readExcerpt(root, nodeOf({ sourceFile: f, meta: { lines: [1, 2] } })), f).toBeNull();
  });
});
