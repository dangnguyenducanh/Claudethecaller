import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkDeps, mkVersion, newUser, okJson, okText, scratch, skillMd, tool, type Scratch } from './testing.ts';

let s: Scratch;
beforeAll(async () => {
  s = await scratch();
}, 60_000);
afterAll(async () => {
  await s?.drop();
});

describe('library.mcp', () => {
  it('get_capability and load_capability_resource stay on the returned version after a new version lands', async () => {
    const user = newUser();
    const deps = mkDeps(s.repos);
    const v1Files = { 'SKILL.md': skillMd('pinned-read', 'first', 'body one\n'), 'ref.md': 'reference one\n' };
    const v1 = await mkVersion(s.repos, user, 'pinned-read', v1Files);

    const first = okJson(await tool(deps, 'get_capability', user, { name: 'pinned-read' }));
    expect(first.version_id).toBe(v1.id);
    expect(first.version).toBe(1);

    const v2 = await mkVersion(s.repos, user, 'pinned-read', { 'SKILL.md': skillMd('pinned-read', 'second', 'body two\n'), 'ref.md': 'reference two\n' });
    await s.repos.library.moveLabels(user, { capId: v1.capId, version: 2, labels: ['production'] });

    expect(okText(await tool(deps, 'load_capability_resource', user, { version_id: first.version_id, path: 'ref.md' }))).toBe(v1Files['ref.md']);
    expect(okText(await tool(deps, 'load_capability_resource', user, { version_id: first.version_id, path: 'SKILL.md' }))).toBe(v1Files['SKILL.md']);

    const second = okJson(await tool(deps, 'get_capability', user, { name: 'pinned-read' }));
    expect([second.version_id, second.version]).toEqual([v2.id, 2]);
    expect(okJson(await tool(deps, 'get_capability', user, { name: 'pinned-read', version: 1 })).version_id).toBe(first.version_id);
  });
});
