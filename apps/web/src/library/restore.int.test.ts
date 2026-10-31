import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, fakeSubmit, LOCAL, mkDeps, mkVersion, newUser, scratch, skillMd, tempDir, type Scratch } from './testing.ts';

let s: Scratch;
const tmp = tempDir();
beforeAll(async () => {
  s = await scratch();
}, 60_000);
afterAll(async () => {
  tmp.remove();
  await s?.drop();
});

let homes = 0;
const newHome = (): string => {
  const d = tmp.sub(`h${++homes}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const read = (p: string): string => fs.readFileSync(p, 'utf8');
const treeFiles = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name))).sort();
const restore = (deps: ReturnType<typeof mkDeps>, capId: string, version: unknown, ctx = LOCAL) =>
  call(deps, 'POST', '/api/capabilities/:id/restore', { params: { id: capId }, body: { version }, ctx });

describe('restore (D18)', () => {
  it('writes the old files atomically, keeps the mode, creates `restore v1` with latest only, leaves production, submits library.changed, and is idempotent', async () => {
    const home = newHome();
    const submit = fakeSubmit();
    const deps = mkDeps(s.repos, { home, submit });
    const rp = path.join(home, 'skills', 'r18');
    const f1 = { 'SKILL.md': skillMd('r18', 'd', 'one\n'), 'ref.md': 'r1', 'scripts/run.sh': '#!/bin/sh\necho 1\n' };
    const f2 = { 'SKILL.md': skillMd('r18', 'd', 'two\n'), 'ref.md': 'r2', 'scripts/run.sh': '#!/bin/sh\necho 2\n' };
    const v1 = await mkVersion(s.repos, LOCAL, 'r18', f1, { rootPath: rp });
    await mkVersion(s.repos, LOCAL, 'r18', f2, { rootPath: rp, commitMessage: 'scan' });
    for (const [p, t] of Object.entries(f2)) tmp.put(path.join(rp, p), t);
    fs.chmodSync(path.join(rp, 'scripts/run.sh'), 0o755);
    tmp.put(path.join(rp, 'extra.md'), 'extra');

    const r = await restore(deps, v1.capId, 1);
    expect([r.status, r.body]).toEqual([200, { version: 3, created: true, written: ['SKILL.md', 'ref.md', 'scripts/run.sh'] }]);
    for (const [p, t] of Object.entries(f1)) expect(read(path.join(rp, p))).toBe(t);
    expect(fs.statSync(path.join(rp, 'scripts/run.sh')).mode & 0o777).toBe(0o755);
    expect(treeFiles(rp)).toEqual(['SKILL.md', 'extra.md', 'ref.md', 'scripts/run.sh']);
    const vs = [...(await s.repos.library.listVersions(LOCAL, v1.capId))].sort((a, b) => a.version - b.version);
    expect(vs.map((x) => [x.version, x.labels, x.commitMessage])).toEqual([[1, ['production'], 'test'], [2, [], 'scan'], [3, ['latest'], 'restore v1']]);
    expect(submit.calls.map((c) => [c.queue, c.kind, c.payload])).toEqual([['library', 'changed', { userId: 'local', capId: v1.capId, version: 3 }]]);

    const again = await restore(deps, v1.capId, 1);
    expect([again.status, again.body.version, again.body.created, submit.calls.length]).toEqual([200, 3, false, 1]);
    expect((await restore(deps, v1.capId, 9)).status).toBe(404);
    expect((await call(deps, 'POST', '/api/capabilities/:id/restore', { params: { id: v1.capId }, body: {} })).status).toBe(422);
  });
  it('restores a removed capability into folders that do not exist yet', async () => {
    const home = newHome();
    const rp = path.join(home, 'skills', 'r18-gone');
    const gone = await mkVersion(s.repos, LOCAL, 'r18-gone', { 'SKILL.md': 'back', 'deep/a/b.md': 'b' }, { rootPath: rp });
    await s.repos.library.markRemoved(LOCAL, gone.capId);
    const r = await restore(mkDeps(s.repos, { home }), gone.capId, 1);
    expect([r.status, read(path.join(rp, 'SKILL.md')), read(path.join(rp, 'deep/a/b.md'))]).toEqual([200, 'back', 'b']);
  });
  it('refuses a version imported from python', async () => {
    const home = newHome();
    const rp = path.join(home, 'skills', 'r18-imp');
    const imp = await mkVersion(s.repos, LOCAL, 'r18-imp', { 'SKILL.md': 'python body only' }, { rootPath: rp, commitMessage: 'imported from python' });
    const r = await restore(mkDeps(s.repos, { home }), imp.capId, 1);
    expect([r.status, r.body.error.code, fs.existsSync(rp)]).toEqual([409, 'conflict', false]);
  });
  it.skipIf(process.getuid?.() === 0)('an unwritable folder is 500, every old file stays and no temp file is left', async () => {
    const home = newHome();
    const rp = path.join(home, 'skills', 'r18-ro');
    const v = await mkVersion(s.repos, LOCAL, 'r18-ro', { 'SKILL.md': 'new main', 'sub/x.md': 'new x' }, { rootPath: rp });
    tmp.put(path.join(rp, 'SKILL.md'), 'old main');
    tmp.put(path.join(rp, 'sub/x.md'), 'old x');
    fs.chmodSync(path.join(rp, 'sub'), 0o555);
    const r = await restore(mkDeps(s.repos, { home }), v.capId, 1);
    fs.chmodSync(path.join(rp, 'sub'), 0o755);
    expect([r.status, r.body.error.code, read(path.join(rp, 'SKILL.md')), read(path.join(rp, 'sub/x.md'))]).toEqual([500, 'internal', 'old main', 'old x']);
    expect(treeFiles(rp).filter((f) => f.includes('ctc-restore'))).toEqual([]);
  });
});

describe('restore guards (D1, D6, D10)', () => {
  it('writes only in local mode for the local user, and reads the mode at call time', async () => {
    const home = newHome();
    const rp = path.join(home, 'skills', 'g1');
    const v = await mkVersion(s.repos, LOCAL, 'g1', { 'SKILL.md': 'x' }, { rootPath: rp });
    const shared = await restore(mkDeps(s.repos, { home, mode: 'shared' }), v.capId, 1);
    expect([shared.status, shared.body.error.code]).toEqual([409, 'conflict']);
    const other = newUser();
    const ov = await mkVersion(s.repos, other, 'g1-remote', { 'SKILL.md': 'x' }, { rootPath: path.join(home, 'skills', 'g1-remote') });
    const remote = await restore(mkDeps(s.repos, { home }), ov.capId, 1, other);
    expect([remote.status, remote.body.error.code]).toEqual([409, 'conflict']);
    const deps = mkDeps(s.repos, { home });
    deps.config.mode = 'shared';
    expect((await restore(deps, v.capId, 1)).status).toBe(409);
    expect(fs.existsSync(rp) || fs.existsSync(path.join(home, 'skills', 'g1-remote'))).toBe(false);
  });
  it('refuses a folder outside claude_home and the configured roots', async () => {
    const home = newHome();
    const outside = fs.mkdtempSync(path.join(tmp.dir, 'outside-'));
    const v = await mkVersion(s.repos, LOCAL, 'g1-out', { 'SKILL.md': 'o' }, { rootPath: path.join(outside, 'skills', 'g1-out') });
    const r = await restore(mkDeps(s.repos, { home }), v.capId, 1);
    expect([r.status, r.body.error.code, fs.readdirSync(outside)]).toEqual([409, 'conflict', []]);
    const rel = await mkVersion(s.repos, LOCAL, 'g1-rel', { 'SKILL.md': 'o' }, { rootPath: 'relative/path' });
    expect((await restore(mkDeps(s.repos, { home }), rel.capId, 1)).status).toBe(409);
  });
  it('refuses a version with an unsafe manifest path before writing anything', async () => {
    const home = newHome();
    for (const [i, unsafe] of ['.env', '../evil.md', 'a//b.md', 'sub/./x.md', '.git/hooks/pre-commit'].entries()) {
      const rp = path.join(home, 'skills', `g1-unsafe${i}`);
      const v = await mkVersion(s.repos, LOCAL, `g1-unsafe${i}`, { 'SKILL.md': 'u', [unsafe]: 'evil' }, { rootPath: rp });
      const r = await restore(mkDeps(s.repos, { home }), v.capId, 1);
      expect([unsafe, r.status, fs.existsSync(path.join(rp, 'SKILL.md'))]).toEqual([unsafe, 409, false]);
    }
    expect(fs.existsSync(path.join(home, 'skills', 'evil.md'))).toBe(false);
  });
  it('never deletes: extra, hidden and node_modules files stay', async () => {
    const home = newHome();
    const rp = path.join(home, 'skills', 'g6-keep');
    const v = await mkVersion(s.repos, LOCAL, 'g6-keep', { 'SKILL.md': 'k1', 'sub/x.md': 'x1' }, { rootPath: rp });
    for (const [p, t] of Object.entries({ 'SKILL.md': 'k2', 'extra.md': 'e', '.keep': 'dot', 'node_modules/m.js': 'm' })) tmp.put(path.join(rp, p), t);
    const r = await restore(mkDeps(s.repos, { home }), v.capId, 1);
    expect(r.status).toBe(200);
    expect(['SKILL.md', 'sub/x.md', 'extra.md', '.keep', 'node_modules/m.js'].map((p) => read(path.join(rp, p)))).toEqual(['k1', 'x1', 'e', 'dot', 'm']);
  });
  it('never writes through a symlink that leaves the folder, and writes nothing at all', async () => {
    const home = newHome();
    const outside = fs.mkdtempSync(path.join(tmp.dir, 'outside6-'));
    const rp = path.join(home, 'skills', 'g6-link');
    fs.mkdirSync(rp, { recursive: true });
    fs.symlinkSync(outside, path.join(rp, 'sub'));
    const v = await mkVersion(s.repos, LOCAL, 'g6-link', { 'SKILL.md': 'l1', 'sub/x.md': 'evil' }, { rootPath: rp });
    const r = await restore(mkDeps(s.repos, { home }), v.capId, 1);
    expect([r.status, r.body.error?.code, fs.readdirSync(outside), fs.existsSync(path.join(rp, 'SKILL.md'))]).toEqual([409, 'conflict', [], false]);
    expect(treeFiles(rp).filter((f) => f.includes('ctc-restore'))).toEqual([]);
  });
});
