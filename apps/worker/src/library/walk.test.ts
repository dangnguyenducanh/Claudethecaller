import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { libraryLimits, type Skip } from '@ctc/core/library';
import { skillMd, tempTree } from './testing.ts';
import { walkRoot, type Found } from './walk.ts';

const tree = tempTree();
afterAll(() => tree.remove());
const all = async (root: string, limits = libraryLimits): Promise<Found[]> => {
  const out: Found[] = [];
  for await (const f of walkRoot(root, limits)) out.push(f);
  return out;
};
const snapshot = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).map((e) => `${e.parentPath}/${e.name}|${fs.lstatSync(path.join(e.parentPath, e.name)).mtimeMs}`).sort();

describe('walkRoot layout (D11)', () => {
  it('finds skills, agents, commands and workflows in order, with rootPath and manifest paths', async () => {
    const h = tree.home();
    tree.put(path.join(h, 'skills/b-multi/SKILL.md'), skillMd('b-multi', 'm'));
    tree.put(path.join(h, 'skills/b-multi/refs/a.md'), 'a');
    tree.put(path.join(h, 'skills/a-nosk/README.md'), 'not a skill');
    tree.put(path.join(h, 'agents/ag.md'), skillMd('ag', 'a'));
    tree.put(path.join(h, 'agents/sub/deep.md'), skillMd('deep', 'd'));
    tree.put(path.join(h, 'commands/cm.md'), skillMd('cm', 'c'));
    tree.put(path.join(h, 'ctc-workflows/w1.yaml'), 'name: w1\n');
    tree.put(path.join(h, 'workflows/w2.json'), '{}');
    tree.put(path.join(h, 'workflows/w3.md'), 'x');
    tree.put(path.join(h, 'workflows/w4.txt'), 'x');
    const found = await all(h);
    expect(found.map((f) => [f.kind, f.defaultName, f.rootPath, f.files.map((x) => x.path).sort()])).toEqual([
      ['skill', 'b-multi', path.join(h, 'skills/b-multi'), ['SKILL.md', 'refs/a.md']],
      ['agent', 'ag', path.join(h, 'agents'), ['ag.md']],
      ['command', 'cm', path.join(h, 'commands'), ['cm.md']],
      ['workflow', 'w1', path.join(h, 'ctc-workflows'), ['w1.yaml']],
      ['workflow', 'w2', path.join(h, 'workflows'), ['w2.json']],
      ['workflow', 'w3', path.join(h, 'workflows'), ['w3.md']],
    ]);
  });
  it('follows a symlinked skill directory and keeps its rootPath as found', async () => {
    const h = tree.home();
    const target = tree.put(path.join(tree.dir, 'elsewhere/linked/SKILL.md'), skillMd('linked', 'l'));
    fs.mkdirSync(path.join(h, 'skills'));
    fs.symlinkSync(path.dirname(target), path.join(h, 'skills/linked'));
    const [f] = await all(h);
    expect([f?.rootPath, f?.files.map((x) => x.path), f?.skip]).toEqual([path.join(h, 'skills/linked'), ['SKILL.md'], null]);
  });
});

describe('walkRoot safety (D1, D6)', () => {
  it('stores no dot, node_modules or __pycache__ files and no symlink that leaves the skill; never writes', async () => {
    const h = tree.home();
    const dir = path.join(h, 'skills/safe');
    tree.put(path.join(dir, 'SKILL.md'), skillMd('safe', 's'));
    tree.put(path.join(dir, 'inside.md'), 'in');
    tree.put(path.join(dir, '.env'), 'TOKEN=x');
    tree.put(path.join(dir, '.git/config'), 'x');
    tree.put(path.join(dir, 'node_modules/x.js'), 'x');
    tree.put(path.join(dir, '__pycache__/x.pyc'), 'x');
    const secret = tree.put(path.join(tree.dir, 'secret.txt'), 'secret');
    fs.symlinkSync(secret, path.join(dir, 'leak.md'));
    fs.symlinkSync(path.join(dir, 'inside.md'), path.join(dir, 'alias.md'));
    fs.symlinkSync(path.join(dir, 'missing'), path.join(dir, 'dangling.md'));
    const before = snapshot(h);
    const [f] = await all(h);
    expect(f?.files.map((x) => x.path).sort()).toEqual(['SKILL.md', 'alias.md', 'inside.md']);
    expect(f?.warnings.map((w) => [w.code, w.path]).sort()).toEqual([['symlink_outside', path.join(dir, 'dangling.md')], ['symlink_outside', path.join(dir, 'leak.md')]]);
    expect(snapshot(h)).toEqual(before);
  });
  it('does not follow a symlinked directory, so a loop ends', async () => {
    const h = tree.home();
    const dir = path.join(h, 'skills/loop');
    tree.put(path.join(dir, 'SKILL.md'), skillMd('loop', 'l'));
    fs.symlinkSync(dir, path.join(dir, 'self'));
    const [f] = await all(h);
    expect(f?.files.map((x) => x.path)).toEqual(['SKILL.md']);
  });
  it('counts from stat before reading: too many files and too large are skipped without content', async () => {
    const h = tree.home();
    tree.put(path.join(h, 'skills/many/SKILL.md'), skillMd('many', 'm'));
    tree.put(path.join(h, 'skills/many/a.md'), 'a');
    tree.put(path.join(h, 'skills/many/b.md'), 'b');
    tree.put(path.join(h, 'skills/big/SKILL.md'), skillMd('big', 'b'));
    tree.put(path.join(h, 'skills/big/pad.bin'), 'p'.repeat(100));
    const found = await all(h, { ...libraryLimits, maxFiles: 2, maxBytes: 80 });
    expect(found.map((f) => [f.defaultName, f.skip?.code, f.files.length])).toEqual([['big', 'too_large', 0], ['many', 'too_many_files', 0]]);
  });
  it('a skill whose SKILL.md links outside is unreadable, not versioned', async () => {
    const h = tree.home();
    const secret = tree.put(path.join(tree.dir, 'outside-skill.md'), skillMd('x', 'x'));
    fs.mkdirSync(path.join(h, 'skills/out'), { recursive: true });
    fs.symlinkSync(secret, path.join(h, 'skills/out/SKILL.md'));
    const [f] = await all(h);
    expect([f?.skip?.code, f?.warnings.map((w) => w.code)]).toEqual(['unreadable', ['symlink_outside']]);
  });
  it('an agent file that links outside the root is skipped as symlink_outside, one that links inside is read', async () => {
    const h = tree.home();
    const secret = tree.put(path.join(tree.dir, 'host-secret.txt'), 'TOPSECRET');
    tree.put(path.join(h, 'agents/real.md'), skillMd('real', 'r'));
    fs.symlinkSync(secret, path.join(h, 'agents/leak.md'));
    fs.symlinkSync(path.join(h, 'agents/real.md'), path.join(h, 'agents/alias.md'));
    const found = await all(h);
    expect(found.map((f) => [f.defaultName, f.skip?.code ?? null, f.files.length])).toEqual([['alias', null, 1], ['leak', 'symlink_outside', 0], ['real', null, 1]]);
  });
  it('reads the agents of a symlinked agents directory', async () => {
    const h = tree.home();
    const elsewhere = path.join(tree.dir, 'dot/agents');
    tree.put(path.join(elsewhere, 'x.md'), skillMd('x', 'x'));
    fs.symlinkSync(elsewhere, path.join(h, 'agents'));
    const found = await all(h);
    expect(found.map((f) => [f.defaultName, f.skip?.code ?? null, f.files.length])).toEqual([['x', null, 1]]);
  });
  it('a subdirectory that cannot be listed makes the skill unreadable instead of losing its files', async () => {
    const h = tree.home();
    tree.put(path.join(h, 'skills/s1/SKILL.md'), skillMd('s1', 's'));
    tree.put(path.join(h, 'skills/s1/refs/a.md'), 'a');
    fs.chmodSync(path.join(h, 'skills/s1/refs'), 0);
    try {
      const [f] = await all(h);
      expect([f?.skip?.code, f?.files.length]).toEqual(['unreadable', 0]);
    } finally {
      fs.chmodSync(path.join(h, 'skills/s1/refs'), 0o755);
    }
  });
  it.each([0, 0o600])('a skill directory that can be listed but not entered (mode %o) is unreadable, not skipped silently', async (mode) => {
    const h = tree.home();
    tree.put(path.join(h, 'skills/s1/SKILL.md'), skillMd('s1', 's'));
    fs.chmodSync(path.join(h, 'skills/s1'), mode);
    try {
      const found = await all(h);
      expect(found.map((f) => [f.defaultName, f.skip?.code])).toEqual([['s1', 'unreadable']]);
    } finally {
      fs.chmodSync(path.join(h, 'skills/s1'), 0o755);
    }
  });
  it('reports a capability directory that exists but cannot be listed as incomplete; a missing one is not', async () => {
    const h = tree.home();
    tree.put(path.join(h, 'skills/s1/SKILL.md'), skillMd('s1', 's'));
    tree.put(path.join(h, 'agents/a.md'), skillMd('a', 'a'));
    fs.chmodSync(path.join(h, 'skills'), 0);
    const incomplete: Skip[] = [];
    try {
      const found: Found[] = [];
      for await (const f of walkRoot(h, libraryLimits, undefined, incomplete)) found.push(f);
      expect([found.map((f) => f.defaultName), incomplete.map((x) => [x.code, x.path])]).toEqual([['a'], [['unreadable', path.join(h, 'skills')]]]);
    } finally {
      fs.chmodSync(path.join(h, 'skills'), 0o755);
    }
  });
});
