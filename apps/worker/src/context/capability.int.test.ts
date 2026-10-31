import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildVersion } from '@ctc/core/library';
import { libraryHandlers } from '../library/index.ts';
import { libConfig } from '../library/testing.ts';
import { contextWorkerLimits, linkCapability, syncCapabilities, withCapabilityLinks, withContextPass } from './index.ts';
import { SPEC_PATH, SPEC_TEXT, SRC, capability, cfg, handlerCtx, kit, scratchRepos, skillText, type Kit, type ScratchRepos } from './testing.ts';

let s: ScratchRepos;
let k: Kit;
beforeAll(async () => {
  s = await scratchRepos('ctc_t23_');
  k = await kit(s.repos);
}, 60_000);
afterAll(async () => {
  k?.cleanup();
  await s?.drop();
});
const keep = { ...contextWorkerLimits };
afterEach(() => void Object.assign(contextWorkerLimits, keep));
const rnd = (): string => Math.random().toString(16).slice(2, 8);
const edges = async (ctx: { userId: string; projectId: string }) => (await s.repos.graph.loadGraph(ctx)).edges.filter((e) => e.origin === 'parser').map((e) => [e.src, e.dst, e.relation]).sort();

describe('linkCapability', () => {
  it('links, is idempotent, relinks a new served version and removes (D13)', async () => {
    const u = `u-${rnd()}`;
    const p1 = await k.project({}, u);
    const p2 = await k.project({}, u);
    const other = await k.project({}, `u-${rnd()}`);
    const cap = await capability(s.repos, u, { name: 'tdd', text: skillText('Use agent:reviewer.') });
    const link = (pr: { ctx: { projectId: string } }, c = cap) => linkCapability({ repos: s.repos, userId: u, projectId: pr.ctx.projectId, capId: c.id });
    expect((await link(p1)).status).toBe('linked');
    const node = await s.repos.graph.getNode(p1.ctx, 'skill:tdd');
    expect([node?.type, node?.kind, node?.origin, node?.sourceFile]).toEqual(['skill', 'capability', 'parser', '<cap:skill:tdd>']);
    expect(await edges(p1.ctx)).toEqual([['skill:tdd', 'agent:reviewer', 'uses'], ['skill:tdd', 'skill:plan', 'uses']]);
    expect((await link(p1)).status).toBe('unchanged');
    expect(await s.repos.graph.listSources(p1.ctx)).toEqual([]);
    expect([await s.repos.graph.getNode(p2.ctx, 'skill:tdd'), await s.repos.graph.getNode(other.ctx, 'skill:tdd')]).toEqual([null, null]);
    const b2 = buildVersion({ kind: 'skill', namespace: 'user', defaultName: 'tdd', rootPath: '/virtual/skills/tdd', mainPath: 'SKILL.md', files: [{ path: 'SKILL.md', bytes: Buffer.from(skillText('Use agent:other.')) }] });
    if (!b2.ok) throw new Error('fixture');
    await s.repos.library.createVersion({ userId: u }, b2.input);
    await s.repos.library.setServed({ userId: u }, cap.id, 2);
    const fresh = await s.repos.library.get({ userId: u }, cap.id);
    if (!fresh) throw new Error('missing');
    expect((await link(p1, fresh)).status).toBe('linked');
    expect((await edges(p1.ctx)).map((e) => e[1])).toContain('agent:other');
    expect((await edges(p1.ctx)).map((e) => e[1])).not.toContain('agent:reviewer');
    await s.repos.library.markRemoved({ userId: u }, cap.id);
    expect((await link(p1, fresh)).status).toBe('removed');
    expect(await s.repos.graph.getNode(p1.ctx, 'skill:tdd')).toBeNull();
  });

  it('skips with a reason: not found, no served version, duplicate name, unreadable (D13)', async () => {
    const u = `u-${rnd()}`;
    const p = await k.project({}, u);
    const link = (capId: string) => linkCapability({ repos: s.repos, userId: u, projectId: p.ctx.projectId, capId });
    const main = await capability(s.repos, u, { name: 'tdd', text: skillText('x') });
    expect(await link('00000000-0000-0000-0000-000000000000')).toMatchObject({ status: 'skipped', reason: 'not_found' });
    const unserved = await capability(s.repos, u, { name: 'later', text: skillText('x', 'later'), serve: false });
    expect(await link(unserved.id)).toMatchObject({ status: 'skipped', reason: 'no_served_version' });
    const dup = await capability(s.repos, u, { name: 'tdd', namespace: 'zzz', text: skillText('Use agent:dup.') });
    expect(await link(dup.id)).toMatchObject({ status: 'skipped', reason: 'duplicate_name' });
    expect((await link(main.id)).status).toBe('linked');
    expect(await linkCapability({ repos: s.repos, userId: `u-${rnd()}`, projectId: p.ctx.projectId, capId: main.id })).toMatchObject({ status: 'skipped', reason: 'not_found' });
  });

  it('syncCapabilities links every live capability; withCapabilityLinks links all projects, counts failures and runs the inner handler first (D13)', async () => {
    const u = `u-${rnd()}`;
    const p1 = await k.project({}, u);
    const p2 = await k.project({}, u);
    const cap = await capability(s.repos, u, { name: 'tdd', text: skillText('Use agent:reviewer.') });
    await capability(s.repos, u, { name: 'later', text: skillText('x', 'later'), serve: false });
    const bad = { ...s.repos, graph: { ...s.repos.graph, replaceSource: async (ctx: { userId: string; projectId: string }, ...a: Parameters<typeof s.repos.graph.replaceSource> extends [unknown, ...infer R] ? R : never) => { if (ctx.projectId === p2.ctx.projectId) throw new Error('boom'); return s.repos.graph.replaceSource(ctx, ...a); } } };
    const wrapped = withCapabilityLinks(async () => ({ ok: 1 }), { repos: bad as typeof s.repos });
    const res = (await wrapped({ userId: u, capId: cap.id } as never, handlerCtx())) as { ok: number; graph: Record<string, number> };
    expect([res.ok, res.graph['projects'], res.graph['failed'], res.graph['linked']]).toEqual([1, 2, 1, 1]);
    await expect(withCapabilityLinks(async () => { throw new Error('inner'); }, { repos: s.repos })({ userId: u, capId: cap.id } as never, handlerCtx())).rejects.toThrow('inner');
    expect(await s.repos.graph.getNode(p2.ctx, 'skill:tdd')).toBeNull();
    expect(((await withCapabilityLinks(async () => 5, { repos: s.repos })({ userId: u, capId: cap.id } as never, handlerCtx())) as { result: number }).result).toBe(5);
    contextWorkerLimits.maxProjects = 1;
    expect(((await withCapabilityLinks(async () => ({}), { repos: s.repos })({ userId: u, capId: cap.id } as never, handlerCtx())) as { graph: { projects: number } }).graph.projects).toBe(1);
    contextWorkerLimits.maxProjects = keep.maxProjects;
    const p3 = await k.project({}, u);
    expect(await syncCapabilities({ repos: s.repos, ctx: p3.ctx })).toEqual({ linked: 1, unchanged: 0, skipped: 1 });
    expect(await syncCapabilities({ repos: s.repos, ctx: p3.ctx })).toEqual({ linked: 0, unchanged: 1, skipped: 1 });
    expect(await s.repos.graph.getNode(p1.ctx, 'skill:tdd')).not.toBeNull();
  });

  it('composes with the real library handler and the context pass: capability layer is bootstrapped once (D16)', async () => {
    const pr = await k.project({ ...SRC, [SPEC_PATH]: SPEC_TEXT });
    await capability(s.repos, 'local', { name: 'boot', text: skillText('Use agent:reviewer.', 'boot') });
    const inner = async () => ({ a: 1 });
    const wrapped = withContextPass(inner as never, { repos: s.repos, config: cfg() });
    const payload = { userId: 'local', projectId: pr.ctx.projectId, files: [SPEC_PATH] };
    const res = (await wrapped(payload as never, handlerCtx())) as { a: number; context: { mode: string; counts: { written: number } }; capabilities?: { linked: number } };
    expect([res.a, res.context.mode, res.context.counts.written, (res.capabilities?.linked ?? 0) >= 1]).toEqual([1, 'files', 1, true]);
    expect(await s.repos.graph.getNode(pr.ctx, 'skill:boot')).not.toBeNull();
    expect('capabilities' in ((await wrapped(payload as never, handlerCtx())) as object)).toBe(false);
    await expect(withContextPass((async () => { throw new Error('inner'); }) as never, { repos: s.repos, config: cfg() })(payload as never, handlerCtx())).rejects.toThrow('inner');
    expect(await withContextPass(inner as never, { repos: s.repos, config: { ...cfg(), mode: 'shared' } })(payload as never, handlerCtx())).toEqual({ a: 1 });
    expect(await withContextPass(inner as never, { repos: s.repos, config: cfg() })({ ...payload, userId: 'user-b' } as never, handlerCtx())).toEqual({ a: 1 });
    expect(await withContextPass(inner as never, { repos: s.repos, config: cfg() })({ ...payload, projectId: 'nope' } as never, handlerCtx())).toEqual({ a: 1 });
    expect(((await withContextPass((async () => 5) as never, { repos: s.repos, config: cfg() })(payload as never, handlerCtx())) as { result: number }).result).toBe(5);
    expect(Object.keys(libraryHandlers({ repos: s.repos, config: libConfig('/nonexistent') })).sort()).toEqual(['library.changed', 'library.scan']);
  });
});
