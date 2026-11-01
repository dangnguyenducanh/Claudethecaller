import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { tempTree } from './testing.ts';
import { watchLibrary } from './index.ts';

const tree = tempTree();
afterAll(() => tree.remove());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('watchLibrary (D20)', () => {
  it('calls onChange once per burst, ignores dot and node_modules paths, tolerates a missing root, close is idempotent', async () => {
    const d = tree.home();
    let calls = 0;
    const w = watchLibrary({ roots: [d, path.join(d, 'missing')], onChange: () => void calls++, debounceMs: 300 });
    await sleep(150);
    tree.put(path.join(d, 'skills/x/SKILL.md'), 'a');
    tree.put(path.join(d, 'skills/x/b.md'), 'b');
    tree.put(path.join(d, 'agents/y.md'), 'c');
    await sleep(1200);
    expect(calls).toBe(1);
    tree.put(path.join(d, '.git/HEAD'), 'x');
    tree.put(path.join(d, 'skills/x/node_modules/z.js'), 'z');
    await sleep(900);
    expect(calls).toBe(1);
    w.close();
    w.close();
    tree.put(path.join(d, 'agents/z.md'), 'z');
    await sleep(900);
    expect(calls).toBe(1);
  });
  it('ignores writes outside the library directories such as session transcripts', async () => {
    const d = tree.home();
    let calls = 0;
    const w = watchLibrary({ roots: [d], onChange: () => void calls++, debounceMs: 200 });
    await sleep(150);
    tree.put(path.join(d, 'projects/-x/s.jsonl'), '{}\n');
    tree.put(path.join(d, 'todos/t.json'), '[]');
    await sleep(800);
    expect(calls).toBe(0);
    tree.put(path.join(d, 'plugins/installed_plugins.json'), '{}');
    await sleep(800);
    expect(calls).toBe(1);
    w.close();
  });
  it('contains a throwing or rejecting onChange', async () => {
    const d = tree.home();
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => seen.push(e);
    process.on('unhandledRejection', onUnhandled);
    const logs: string[] = [];
    const w = watchLibrary({ roots: [d], onChange: async () => { throw new Error('boom'); }, debounceMs: 100, log: (m) => logs.push(m) });
    await sleep(150);
    tree.put(path.join(d, 'agents/w.md'), 'w');
    await sleep(700);
    w.close();
    process.off('unhandledRejection', onUnhandled);
    expect([seen, logs]).toEqual([[], ['library watch onChange failed']]);
  });
});
