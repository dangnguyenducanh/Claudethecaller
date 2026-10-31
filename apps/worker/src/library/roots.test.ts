import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { discoverRoots } from './index.ts';
import { tempTree } from './testing.ts';

const tree = tempTree();
afterAll(() => tree.remove());
const sha8 = (p: string) => createHash('sha256').update(path.resolve(p)).digest('hex').slice(0, 8);

describe('discoverRoots (D10)', () => {
  it('names the claude home user, other roots root@<hash8>, then plugin roots sorted by key; duplicates dropped', async () => {
    const h = tree.home();
    const extra = tree.home();
    const p1 = path.join(tree.dir, 'plug-z');
    const p2 = path.join(tree.dir, 'plug-a');
    fs.mkdirSync(p1);
    fs.mkdirSync(p2);
    tree.put(path.join(h, 'plugins/installed_plugins.json'), JSON.stringify({
      version: 2, plugins: { 'zeta@mk': [{ installPath: p1 }], 'alpha@mk': [{ installPath: p2 }, { installPath: p2 }], 'bad@mk': [{ nope: 1 }], 'rel@mk': [{ installPath: 'relative/dir' }] },
    }));
    expect(await discoverRoots({ claudeHome: h, roots: [h, extra, h] })).toEqual([
      { path: h, namespace: 'user' }, { path: extra, namespace: `root@${sha8(extra)}` }, { path: p2, namespace: 'alpha' }, { path: p1, namespace: 'zeta' },
    ]);
  });
  it('accepts the single-entry plugin shape and ignores a malformed index', async () => {
    const h = tree.home();
    const p = path.join(tree.dir, 'solo');
    fs.mkdirSync(p);
    tree.put(path.join(h, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'solo@m': { installPath: p } } }));
    expect(await discoverRoots({ claudeHome: h, roots: [h] })).toEqual([{ path: h, namespace: 'user' }, { path: p, namespace: 'solo' }]);
    const bad = tree.home();
    tree.put(path.join(bad, 'plugins/installed_plugins.json'), '{not json');
    expect(await discoverRoots({ claudeHome: bad, roots: [bad] })).toEqual([{ path: bad, namespace: 'user' }]);
    expect(await discoverRoots({ claudeHome: path.join(tree.dir, 'missing'), roots: [] })).toEqual([]);
  });
  it('treats a symlink to the claude home as the user root and keeps roots that do not exist', async () => {
    const h = tree.home();
    const link = path.join(tree.dir, 'home-link');
    fs.symlinkSync(h, link);
    const gone = path.join(tree.dir, 'gone');
    expect(await discoverRoots({ claudeHome: h, roots: [link, gone] })).toEqual([{ path: link, namespace: 'user' }, { path: gone, namespace: `root@${sha8(gone)}` }]);
  });
});
