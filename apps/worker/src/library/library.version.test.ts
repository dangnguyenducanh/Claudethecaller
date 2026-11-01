import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diffManifests } from '@ctc/core/library';
import { RepoError } from '@ctc/shared/repositories';
import { libraryHandlers, scanLibrary } from './index.ts';
import { handlerCtx, libConfig, scratchRepos, skillMd, tempTree, type ScratchRepos } from './testing.ts';

let s: ScratchRepos;
const tree = tempTree();
let n = 0;

beforeAll(async () => {
  s = await scratchRepos('ctc_t31_');
}, 60_000);
afterAll(async () => {
  tree.remove();
  await s?.drop();
});

/** A fresh user, a fresh home with one two-file skill, scanned once. */
async function fixture() {
  const userId = `u-${++n}-${Math.random().toString(16).slice(2, 8)}`;
  const ctx = { userId };
  const home = tree.home();
  tree.put(path.join(home, 'skills/gate-skill/SKILL.md'), skillMd('gate-skill', 'gate'));
  const ref = tree.put(path.join(home, 'skills/gate-skill/ref.md'), 'one');
  const roots = [{ path: home, namespace: 'user' }];
  const scan = () => scanLibrary({ repos: s.repos, ctx, roots });
  const first = await scan();
  const capId = first.created[0]?.capId as string;
  const versions = async () => [...(await s.repos.library.listVersions(ctx, capId))].sort((a, b) => a.version - b.version);
  return { ctx, home, ref, scan, first, capId, versions };
}

describe('library.version', () => {
  it('file hash change → version n+1 with latest', async () => {
    const f = await fixture();
    expect((await f.versions()).map((v) => [v.version, [...v.labels].sort()])).toEqual([[1, ['latest', 'production']]]);
    fs.writeFileSync(f.ref, 'two');
    const second = await f.scan();
    expect(second.created.map((c) => [c.name, c.version])).toEqual([['gate-skill', 2]]);
    const [v1, v2] = await f.versions();
    expect([v1?.labels, v2?.labels]).toEqual([['production'], ['latest']]);
    const m1 = await s.repos.library.manifest(f.ctx, v1?.id as string);
    const m2 = await s.repos.library.manifest(f.ctx, v2?.id as string);
    expect(diffManifests(m1, m2)).toEqual({ added: [], removed: [], changed: ['ref.md'] });
    const third = await f.scan();
    expect([third.created, third.unchanged]).toEqual([[], 1]);
    expect(await f.versions()).toHaveLength(2);
  });

  it('label moves are exclusive', async () => {
    const f = await fixture();
    fs.writeFileSync(f.ref, 'two');
    await f.scan();
    await s.repos.library.moveLabels(f.ctx, { capId: f.capId, version: 2, labels: ['production', 'staging'] });
    await s.repos.library.moveLabels(f.ctx, { capId: f.capId, version: 1, labels: ['staging'] });
    const labels = (await f.versions()).map((v) => [...v.labels].sort());
    expect(labels).toEqual([['staging'], ['latest', 'production']]);
    for (const label of ['latest', 'production', 'staging']) expect(labels.filter((l) => l.includes(label))).toHaveLength(1);
    await expect(s.repos.library.moveLabels(f.ctx, { capId: f.capId, version: 1, labels: ['latest'] })).rejects.toSatisfy((e) => e instanceof RepoError && e.code === 'invalid');
    const handlers = libraryHandlers({ repos: s.repos, config: libConfig(f.home) });
    const out = await handlers['library.changed']({ userId: f.ctx.userId, capId: f.capId, version: 2 } as never, handlerCtx());
    expect(out).toEqual({ capId: f.capId, servedVersion: 2, embedded: false, dedup: 0 });
    expect((await s.repos.library.get(f.ctx, f.capId))?.servedVersion).toBe(2);
  });

  it('parallel scans make no duplicate version', async () => {
    const f = await fixture();
    fs.writeFileSync(f.ref, 'two');
    const results = await Promise.all([1, 2, 3, 4].map(() => f.scan()));
    expect(results.flatMap((r) => r.created)).toHaveLength(1);
    expect((await f.versions()).map((v) => v.version)).toEqual([1, 2]);
  });
});
