import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { libraryTools } from './index.ts';
import { errOf, mkDeps, mkVersion, newUser, okJson, okText, scratch, skillMd, tool, type Scratch } from './testing.ts';

let s: Scratch;
beforeAll(async () => {
  s = await scratch();
}, 60_000);
afterAll(async () => {
  await s?.drop();
});
const deps = () => mkDeps(s.repos);

describe('tool set (D0, D9)', () => {
  it('has exactly get_capability and load_capability_resource, each with a Zod input schema and a description', () => {
    const tools = libraryTools(deps());
    expect(tools.map((t) => t.name).sort()).toEqual(['get_capability', 'load_capability_resource']);
    for (const t of tools) expect([typeof t.inputSchema.safeParse, t.description.length > 0]).toEqual(['function', true]);
  });
});

describe('get_capability (D11, D13)', () => {
  it('replies with exactly the documented keys: body without frontmatter, files sorted with sizes', async () => {
    const u = newUser();
    const main = skillMd('g13', 'G desc', 'Body one\n');
    const v1 = await mkVersion(s.repos, u, 'g13', { 'ref.md': 'reference one', 'SKILL.md': main }, { frontmatter: { name: 'g13', description: 'G desc' } });
    const r = okJson(await tool(deps(), 'get_capability', u, { name: 'g13' }));
    expect(r).toEqual({
      version_id: v1.id, version: 1, labels: ['latest', 'production'], frontmatter: { name: 'g13', description: 'G desc' }, body: 'Body one\n',
      files: [{ path: 'SKILL.md', size: Buffer.byteLength(main) }, { path: 'ref.md', size: 13 }],
    });
  });
  it('picks by label, by version, and the served version; a block override hides it unless the read is explicit', async () => {
    const u = newUser();
    const v1 = await mkVersion(s.repos, u, 'g13-pick', { 'SKILL.md': skillMd('g13-pick', 'd', 'one\n') });
    const v2 = await mkVersion(s.repos, u, 'g13-pick', { 'SKILL.md': skillMd('g13-pick', 'd', 'two\n') });
    await s.repos.library.moveLabels(u, { capId: v1.capId, version: 2, labels: ['beta'] });
    expect(okJson(await tool(deps(), 'get_capability', u, { name: 'g13-pick' })).version).toBe(1);
    expect(okJson(await tool(deps(), 'get_capability', u, { name: 'g13-pick', version: 2 })).version_id).toBe(v2.id);
    expect(okJson(await tool(deps(), 'get_capability', u, { name: 'g13-pick', label: 'beta' })).body).toBe('two\n');
    expect(okJson(await tool(deps(), 'get_capability', u, { name: 'g13-pick', label: 'latest' })).version).toBe(2);
    expect(errOf(await tool(deps(), 'get_capability', u, { name: 'g13-pick', label: 'nolabel' })).code).toBe('not_found');
    expect(errOf(await tool(deps(), 'get_capability', u, { name: 'g13-pick', version: 9 })).code).toBe('not_found');
    const p = { ...u, projectId: (await s.repos.projects.upsert(u, { root: `/t32/${Math.random()}` })).id };
    await s.repos.library.upsertOverride(p, { capId: v1.capId, action: 'block' });
    const blocked = errOf(await tool(deps(), 'get_capability', p, { name: 'g13-pick' }));
    expect([blocked.code, blocked.message]).toEqual(['not_found', 'not served for this project']);
    expect(okJson(await tool(deps(), 'get_capability', p, { name: 'g13-pick', version: 1 })).version).toBe(1);
  });
  it('body of a workflow YAML is the whole file; an agent body drops its frontmatter', async () => {
    const u = newUser();
    const wf = 'name: g13-wf\nsteps: []\n';
    await mkVersion(s.repos, u, 'g13-wf', { 'g13-wf.yaml': wf }, { kind: 'workflow' });
    await mkVersion(s.repos, u, 'g13-agent', { 'g13-agent.md': skillMd('g13-agent', 'a', 'Agent body\n') }, { kind: 'agent' });
    expect(okJson(await tool(deps(), 'get_capability', u, { name: 'g13-wf' })).body).toBe(wf);
    expect(okJson(await tool(deps(), 'get_capability', u, { name: 'g13-agent' })).body).toBe('Agent body\n');
  });
  it('resolves names: user namespace first, ns:name, a single other namespace, ambiguous across two, kind order', async () => {
    const u = newUser();
    const get = async (name: string) => okJson(await tool(deps(), 'get_capability', u, { name })).version_id;
    const mine = await mkVersion(s.repos, u, 'n11-a', { 'SKILL.md': 'user' });
    const plug = await mkVersion(s.repos, u, 'n11-a', { 'SKILL.md': 'plug' }, { namespace: 'plug' });
    expect([await get('n11-a'), await get('plug:n11-a'), await get('user:n11-a')]).toEqual([mine.id, plug.id, mine.id]);
    const solo = await mkVersion(s.repos, u, 'n11-c', { 'SKILL.md': 'c' }, { namespace: 'solo' });
    expect(await get('n11-c')).toBe(solo.id);
    await mkVersion(s.repos, u, 'n11-b', { 'SKILL.md': 'b1' }, { namespace: 'pb' });
    await mkVersion(s.repos, u, 'n11-b', { 'SKILL.md': 'b2' }, { namespace: 'pa' });
    const amb = errOf(await tool(deps(), 'get_capability', u, { name: 'n11-b' }));
    expect([amb.code, amb.candidates]).toEqual(['ambiguous', [{ name: 'pa:n11-b', kind: 'skill' }, { name: 'pb:n11-b', kind: 'skill' }]]);
    await mkVersion(s.repos, u, 'n11-k', { 'k.md': 'cmd' }, { kind: 'command' });
    const skill = await mkVersion(s.repos, u, 'n11-k', { 'SKILL.md': 'skill' });
    const agent = await mkVersion(s.repos, u, 'n11-j', { 'j.md': 'agent' }, { kind: 'agent' });
    await mkVersion(s.repos, u, 'n11-j', { 'j.md': 'cmd' }, { kind: 'command' });
    expect([await get('n11-k'), await get('n11-j')]).toEqual([skill.id, agent.id]);
  });
  it('caps the ambiguous candidates at 10', async () => {
    const u = newUser();
    for (let i = 0; i < 12; i++) await mkVersion(s.repos, u, 'n11-many', { 'SKILL.md': `m${i}` }, { namespace: `p${String(i).padStart(2, '0')}` });
    const amb = errOf(await tool(deps(), 'get_capability', u, { name: 'n11-many' }));
    expect([amb.candidates.length, amb.candidates[0]]).toEqual([10, { name: 'p00:n11-many', kind: 'skill' }]);
  });
  it('removed capabilities, bad names, unknown namespaces and other users are not_found', async () => {
    const u = newUser();
    const gone = await mkVersion(s.repos, u, 'n11-gone', { 'SKILL.md': 'g' });
    await s.repos.library.markRemoved(u, gone.capId);
    for (const [ctx, name] of [[u, 'n11-gone'], [u, 'Bad_Name'], [u, 'nope:n11-gone'], [newUser(), 'n11-gone']] as const) {
      expect(errOf(await tool(deps(), 'get_capability', ctx, { name })).code).toBe('not_found');
    }
  });
  it('bad arguments are invalid: both label and version, non-objects, 200 chars ok and 201 not', async () => {
    const u = newUser();
    await mkVersion(s.repos, u, 'a4', { 'SKILL.md': 'x' });
    const both = errOf(await tool(deps(), 'get_capability', u, { name: 'a4', label: 'production', version: 1 }));
    expect([both.code, both.message]).toEqual(['invalid', 'give label or version, not both']);
    for (const junk of [undefined, null, 'x', 42, [], { name: {} }]) expect(errOf(await tool(deps(), 'get_capability', u, junk)).code).toBe('invalid');
    expect(errOf(await tool(deps(), 'get_capability', u, { name: 'n'.repeat(200) })).code).toBe('not_found');
    expect(errOf(await tool(deps(), 'get_capability', u, { name: 'n'.repeat(201) })).code).toBe('invalid');
  });
  it('accepts a digit-string version, a padded name and extra keys; deep-frozen args are fine', async () => {
    const u = newUser();
    const v = await mkVersion(s.repos, u, 'a5', { 'SKILL.md': skillMd('a5', 'd', 'b\n') });
    expect(okJson(await tool(deps(), 'get_capability', u, Object.freeze({ name: '  a5  ', version: '1', extra: 'ignored' }))).version_id).toBe(v.id);
  });
});

describe('load_capability_resource (D14)', () => {
  it('returns the stored content raw, frontmatter included', async () => {
    const u = newUser();
    const main = skillMd('l14', 'd', 'Main\n');
    const v = await mkVersion(s.repos, u, 'l14', { 'SKILL.md': main, 'docs/ref.md': 'ref ü\n' });
    expect(okText(await tool(deps(), 'load_capability_resource', u, { version_id: v.id, path: 'SKILL.md' }))).toBe(main);
    expect(okText(await tool(deps(), 'load_capability_resource', u, { version_id: v.id, path: 'docs/ref.md' }))).toBe('ref ü\n');
  });
  it('unknown path, non-uuid, unknown and foreign versions are not_found; the removed capability still reads', async () => {
    const u = newUser();
    const v = await mkVersion(s.repos, u, 'l14-nf', { 'SKILL.md': 'x' });
    for (const args of [{ version_id: v.id, path: 'missing.md' }, { version_id: 'nope', path: 'SKILL.md' }, { version_id: randomUUID(), path: 'SKILL.md' }]) {
      expect(errOf(await tool(deps(), 'load_capability_resource', u, args)).code).toBe('not_found');
    }
    expect(errOf(await tool(deps(), 'load_capability_resource', newUser(), { version_id: v.id, path: 'SKILL.md' })).code).toBe('not_found');
    await s.repos.library.markRemoved(u, v.capId);
    expect(okText(await tool(deps(), 'load_capability_resource', u, { version_id: v.id, path: 'SKILL.md' }))).toBe('x');
  });
  it('path 1024 chars is accepted and 1025 is invalid; a missing argument is invalid', async () => {
    const u = newUser();
    const v = await mkVersion(s.repos, u, 'l14-len', { 'SKILL.md': 'x' });
    expect(errOf(await tool(deps(), 'load_capability_resource', u, { version_id: v.id, path: 'p'.repeat(1024) })).code).toBe('not_found');
    expect(errOf(await tool(deps(), 'load_capability_resource', u, { version_id: v.id, path: 'p'.repeat(1025) })).code).toBe('invalid');
    expect(errOf(await tool(deps(), 'load_capability_resource', u, { version_id: 5 })).code).toBe('invalid');
  });
});
