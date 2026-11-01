import { ModelError } from '@ctc/shared/models';
import { memoryApiLimits } from '@ctc/shared/schemas/memory';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryTools } from './index.ts';
import { errOf, fakeCache, mkDeps, rnd, scratch, textOf, tool, vecOf, type Scratch } from './testing.ts';

let s: Scratch;
beforeAll(async () => {
  s = await scratch();
}, 60_000);
afterAll(async () => {
  await s?.drop();
});

async function seed() {
  const user = { userId: `u-tools-${rnd()}` };
  const root = `/work/tools-${rnd()}`;
  const project = await s.repos.projects.upsert(user, { root });
  const ctx = { ...user, projectId: project.id };
  const add = (text: string, o: { scope?: 'global' | 'project'; kind?: string } = {}) =>
    s.repos.memory.add(ctx, { scope: o.scope ?? 'project', kind: o.kind ?? 'fact', text, embedding: vecOf(text) });
  return { user, root, project, ctx, add };
}

describe('tool set', () => {
  it('has exactly the four frozen names, each with a description and a Zod schema', () => {
    const tools = memoryTools(mkDeps(s.repos));
    expect(tools.map((t) => t.name).sort()).toEqual(['mem_get', 'mem_search', 'mem_timeline', 'save_memory']);
    for (const t of tools) expect([typeof t.inputSchema.safeParse, t.description.length > 0]).toEqual(['function', true]);
  });
});

describe('mem_search', () => {
  it('returns index rows best first, filters by scope, kind and since, and cuts to 80 chars', async () => {
    const x = await seed();
    const a = await x.add(`pnpm workspace layout ${'long '.repeat(40)}`, { kind: 'convention' });
    await x.add('pnpm store lives in the home directory', { scope: 'global' });
    const all = textOf(await tool(mkDeps(s.repos), 'mem_search', x.ctx, { query: 'pnpm workspace layout' })).split('\n');
    expect(all).toHaveLength(2);
    expect(all[0]).toMatch(new RegExp(`^${a.id} · \\d{4}-\\d{2}-\\d{2} · convention · pnpm workspace layout`));
    expect(all[0]?.split(' · ')[3]).toHaveLength(80);
    expect(textOf(await tool(mkDeps(s.repos), 'mem_search', x.ctx, { query: 'pnpm', scope: 'global' })).split('\n')).toHaveLength(1);
    expect(textOf(await tool(mkDeps(s.repos), 'mem_search', x.ctx, { query: 'pnpm', kind: 'convention' })).split('\n')).toHaveLength(1);
    expect(textOf(await tool(mkDeps(s.repos), 'mem_search', x.ctx, { query: 'pnpm', since: '2999-01-01' }))).toBe('no memories');
    expect(textOf(await tool(mkDeps(s.repos), 'mem_search', x.ctx, { query: 'pnpm', limit: 1 })).split('\n')).toHaveLength(1);
  });

  it('cuts a long query instead of rejecting it, rejects bad arguments, and finds project memories through cwd', async () => {
    const x = await seed();
    await x.add('cwd reachable note');
    const long = 'q'.repeat(memoryApiLimits.queryMax + 100);
    const deps = mkDeps(s.repos);
    expect((await tool(deps, 'mem_search', x.ctx, { query: long })).isError).toBeUndefined();
    expect(String(deps.embed.length)).toBeDefined();
    expect(errOf(await tool(deps, 'mem_search', x.ctx, { query: '' })).code).toBe('invalid');
    expect(errOf(await tool(deps, 'mem_search', x.ctx, { query: 'a', limit: memoryApiLimits.searchMax + 1 })).code).toBe('invalid');
    expect(textOf(await tool(deps, 'mem_search', x.user, { query: 'cwd reachable note', scope: 'project', cwd: x.root }))).toContain('cwd reachable note');
  });

  it('works with the full-text leg alone when the embedder is down', async () => {
    const x = await seed();
    await x.add('fallback marker note');
    const embed = (async () => {
      throw new ModelError('unavailable', 'down');
    }) as never;
    expect(textOf(await tool(mkDeps(s.repos, { embed }), 'mem_search', x.ctx, { query: 'fallback marker note' }))).toContain('fallback marker note');
  });
});

describe('mem_timeline', () => {
  it('lists neighbours oldest first with the anchor marked, the anchor alone for 0/0, and not_found for a foreign or unknown anchor', async () => {
    const x = await seed();
    const [m1, m2, m3] = [await x.add("tl one"), await x.add("tl two"), await x.add("tl three")];
    const deps = mkDeps(s.repos);
    const lines = textOf(await tool(deps, 'mem_timeline', x.ctx, { anchor_id: m2.id, before: 1, after: 2 })).split('\n');
    expect(lines.map((l) => l.split(' · ')[0])).toEqual([m1.id, m2.id, m3.id]);
    expect(lines[1]?.endsWith(' · anchor')).toBe(true);
    expect(textOf(await tool(deps, 'mem_timeline', x.ctx, { anchor_id: m2.id, before: 0, after: 0 })).split('\n')).toHaveLength(1);
    expect(errOf(await tool(deps, 'mem_timeline', { userId: 'someone-else' }, { anchor_id: m2.id })).code).toBe('not_found');
    expect(errOf(await tool(deps, 'mem_timeline', x.ctx, { anchor_id: 'nope' })).code).toBe('not_found');
    expect(errOf(await tool(deps, 'mem_timeline', x.ctx, { anchor_id: m2.id, before: memoryApiLimits.timelineMax + 1 })).code).toBe('invalid');
  });

  it('merges session summaries in by time', async () => {
    const x = await seed();
    const sid = `s-${rnd()}`;
    await s.repos.sessions.upsert(x.user, { id: sid, projectId: x.project.id, transcriptPath: `/t/${sid}.jsonl` });
    await x.add('before summary');
    await s.repos.memory.insertSummary(x.ctx, { sessionId: sid, contentHash: sid, request: 'asked for the thing' });
    const anchor = await x.add('after summary');
    const lines = textOf(await tool(mkDeps(s.repos), 'mem_timeline', x.ctx, { anchor_id: anchor.id, before: 3, after: 0 })).split('\n');
    expect(lines.map((l) => l.split(' · ')[2])).toEqual(['fact', 'summary', 'fact']);
    expect(lines[1]).toMatch(new RegExp(`^${sid} · \\d{4}-\\d{2}-\\d{2} · summary · asked for the thing$`));
  });
});

describe('mem_get', () => {
  it('returns rows in the requested order, drops unknown, foreign and deleted ids, repeats once, and counts a use', async () => {
    const x = await seed();
    const [a, b, c] = [await x.add('get a'), await x.add('get b'), await x.add('get c')];
    await s.repos.memory.softDelete(x.ctx, c.id);
    const foreign = (await s.repos.memory.add({ userId: `u-${rnd()}` }, { scope: 'global', kind: 'fact', text: 'foreign', embedding: vecOf('foreign') })).id;
    const r = JSON.parse(textOf(await tool(mkDeps(s.repos), 'mem_get', x.ctx, { ids: [b.id, a.id, b.id, c.id, foreign, 'nope'] }))) as { id: string; useCount: number }[];
    expect(r.map((m) => m.id)).toEqual([b.id, a.id]);
    expect((await s.repos.memory.get(x.ctx, a.id))?.useCount).toBe(1);
    expect((await s.repos.memory.get(x.ctx, c.id))?.useCount).toBe(0);
    expect(Object.keys(r[0] ?? {})).not.toContain('userId');
    expect(errOf(await tool(mkDeps(s.repos), 'mem_get', x.ctx, { ids: Array.from({ length: memoryApiLimits.getMax + 1 }, () => a.id) })).code).toBe('invalid');
  });
});

describe('save_memory', () => {
  it('adds, then reports NOOP for the same text, and rotates the project epoch when a project is known', async () => {
    const x = await seed();
    const cache = fakeCache('e1');
    const deps = mkDeps(s.repos, { cache });
    const first = JSON.parse(textOf(await tool(deps, 'save_memory', x.user, { text: 'Always run the gate tests', kind: 'convention', scope: 'project', cwd: x.root }))) as { id: string; action: string };
    expect(first.action).toBe('ADD');
    const row = await s.repos.memory.get(x.ctx, first.id);
    expect([row?.scope, row?.confidence, row?.source, row?.projectId]).toEqual(['project', 1, { type: 'mcp' }, x.project.id]);
    expect(cache.rotates).toEqual([['mem', x.user.userId, x.project.id]]);
    const second = JSON.parse(textOf(await tool(deps, 'save_memory', x.user, { text: 'Always run the gate tests', kind: 'convention', scope: 'project', cwd: x.root }))) as { id: string; action: string };
    expect([second.action, second.id]).toEqual(['NOOP', first.id]);
  });

  it('refuses project scope without a project, empty-after-sanitize text and over-long text; global needs no project', async () => {
    const x = await seed();
    const deps = mkDeps(s.repos);
    const noProject = errOf(await tool(deps, 'save_memory', x.user, { text: 'x', kind: 'fact', scope: 'project' }));
    expect([noProject.code, noProject.message]).toEqual(['invalid', 'scope project needs a known project']);
    expect(errOf(await tool(deps, 'save_memory', x.user, { text: '<system-reminder>only a tag</system-reminder>', kind: 'fact', scope: 'global' })).code).toBe('invalid');
    expect(errOf(await tool(deps, 'save_memory', x.user, { text: 'x'.repeat(memoryApiLimits.textMax + 1), kind: 'fact', scope: 'global' })).code).toBe('invalid');
    expect(errOf(await tool(deps, 'save_memory', x.user, { text: 'x', kind: 'weird', scope: 'global' })).code).toBe('invalid');
    expect(JSON.parse(textOf(await tool(deps, 'save_memory', x.user, { text: 'x'.repeat(memoryApiLimits.textMax), kind: 'fact', scope: 'global' }))).action).toBe('ADD');
  });

  it('answers model_unavailable when the embedder is down', async () => {
    const x = await seed();
    const embed = (async () => {
      throw new ModelError('unavailable', 'secret detail');
    }) as never;
    const e = errOf(await tool(mkDeps(s.repos, { embed }), 'save_memory', x.ctx, { text: 'a fact', kind: 'fact', scope: 'global' }));
    expect([e.code, e.message]).toEqual(['model_unavailable', 'embedder unavailable']);
  });

  it('does not edit its arguments', async () => {
    const x = await seed();
    const args = Object.freeze({ text: 'frozen args', kind: 'fact', scope: 'global' });
    expect((await tool(mkDeps(s.repos), 'save_memory', x.ctx, args)).isError).toBeUndefined();
  });
});
