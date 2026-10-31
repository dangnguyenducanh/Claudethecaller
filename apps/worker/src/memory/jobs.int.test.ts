import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { recallLimits } from '@ctc/core/memory';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { memoryJobHandlers, type MemoryJobDeps } from './index.ts';
import { BANDS, fakeChat, fakeEmbed, jobCtx, scratch, tempHome, toJsonl, type Scratch } from './testing.ts';

let s: Scratch;
const homes: { remove(): void }[] = [];
beforeAll(async () => {
  s = await scratch();
}, 60_000);
afterAll(async () => {
  homes.forEach((h) => h.remove());
  await s?.drop();
});
const saved = { ...recallLimits };
afterEach(() => Object.assign(recallLimits, saved));

const FIX = path.join(import.meta.dirname, 'fixtures/claude-home/projects/-x-proj/memory');
const uid = (): string => `u_t43_${Math.random().toString(16).slice(2, 10)}`;
const submits: { queue: string; kind: string; payload: unknown; id?: string }[] = [];
const rotates: string[][] = [];

function setup(over: Partial<MemoryJobDeps> = {}) {
  const home = tempHome();
  homes.push(home);
  const handlers = (userId: string) => ({
    deps: {
      repos: s.repos, config: { claude_home: home.home, memory: { bands: { ...BANDS } } }, embed: fakeEmbed(), chat: fakeChat().chat,
      submit: async (i) => (submits.push(i), { id: 'job' }), cache: { epoch: { rotate: async (...a: string[]) => (rotates.push(a), 'e') } }, ...over,
    } as MemoryJobDeps,
    userId,
  });
  return { home, handlers };
}
const run = (deps: MemoryJobDeps, kind: 'memory.import' | 'memory.distill', payload: object) =>
  (memoryJobHandlers(deps)[kind] as unknown as (p: object, c: ReturnType<typeof jobCtx>) => Promise<unknown>)(payload, jobCtx());
const copyFixture = (home: string, dir = '-x-proj'): string => {
  const to = path.join(home, 'projects', dir, 'memory');
  fs.cpSync(FIX, to, { recursive: true });
  return to;
};

describe('memory.import (D15)', () => {
  it('imports the fixture files with their kinds and scopes, counts the rest as skipped, and is idempotent without reinforcement', async () => {
    const { home, handlers } = setup();
    const { deps, userId } = handlers(uid());
    const project = await s.repos.projects.upsert({ userId }, { root: '/x/proj' });
    const dir = copyFixture(home.home);
    const first = await run(deps, 'memory.import', { userId });
    expect(first).toEqual({ files: 5, noop: 0, update: 0, supersede: 0, add: 4, skipped: 1 });
    const rows = (await s.repos.memory.list({ userId, projectId: project.id }, { limit: 50 })).rows;
    const by = (t: string) => rows.find((m) => m.text === t);
    expect([by('Always propose before editing')?.kind, by('Always propose before editing')?.scope]).toEqual(['convention', 'project']);
    expect([by('The user prefers short answers.')?.kind, by('The user prefers short answers.')?.scope]).toEqual(['preference', 'global']);
    expect([by('The spool lives under the data directory')?.kind, by('Docs are in the docs folder')?.kind]).toEqual(['fact', 'fact']);
    expect(by('Always propose before editing')?.source).toEqual({ type: 'file', path: fs.realpathSync(path.join(dir, 'feedback.md')) });
    expect(rows.every((m) => m.confidence === 1)).toBe(true);
    expect(rotates.at(-1)).toEqual(['mem', userId, project.id]);
    const before = fs.readFileSync(path.join(dir, 'feedback.md'), 'utf8');
    const again = await run(deps, 'memory.import', { userId });
    expect(again).toEqual({ files: 5, noop: 4, update: 0, supersede: 0, add: 0, skipped: 1 });
    expect((await s.repos.memory.list({ userId, projectId: project.id }, { limit: 50 })).rows.every((m) => m.reinforcementDates.length === 0)).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'feedback.md'), 'utf8')).toBe(before);
  });

  it('skips project files whose directory matches no project, or two, and zero counts for a missing projects dir', async () => {
    const { home, handlers } = setup();
    const { deps, userId } = handlers(uid());
    copyFixture(home.home, '-nowhere');
    expect(await run(deps, 'memory.import', { userId })).toEqual({ files: 5, noop: 0, update: 0, supersede: 0, add: 1, skipped: 4 });
    const none = setup();
    expect(await run(none.handlers(userId).deps, 'memory.import', { userId })).toEqual({ files: 0, noop: 0, update: 0, supersede: 0, add: 0, skipped: 0 });
    fs.rmSync(path.join(home.home, 'projects'), { recursive: true });
    expect(await run(deps, 'memory.import', { userId })).toEqual({ files: 0, noop: 0, update: 0, supersede: 0, add: 0, skipped: 0 });
  });

  it('with paths: dedupes, and skips a path outside the memory dirs, a symlink out of claude_home, an oversize file and a non-UTF-8 file', async () => {
    const { home, handlers } = setup();
    const { deps, userId } = handlers(uid());
    await s.repos.projects.upsert({ userId }, { root: '/x/proj' });
    const dir = copyFixture(home.home);
    const outside = path.join(home.otherDir, 'out.md');
    fs.writeFileSync(outside, '---\ntype: user\ndescription: outside note\n---\n');
    fs.symlinkSync(outside, path.join(dir, 'link.md'));
    fs.writeFileSync(path.join(dir, 'big.md'), `---\ntype: user\ndescription: big\n---\n${'x'.repeat(recallLimits.maxImportBytes)}`);
    fs.writeFileSync(path.join(dir, 'bin.md'), Buffer.concat([Buffer.from('---\ntype: user\ndescription: '), Buffer.from([0xff, 0xfe]), Buffer.from('\n---\n')]));
    fs.writeFileSync(path.join(dir, 'long.md'), `---\ntype: user\ndescription: ${'y'.repeat(301)}\n---\n`);
    const f = path.join(dir, 'user.md');
    const paths = [f, f, path.join(dir, 'link.md'), outside, path.join(dir, 'big.md'), path.join(dir, 'bin.md'), path.join(dir, 'long.md'), path.join(dir, 'MEMORY.md'), 'relative.md', '/etc/passwd'];
    expect(await run(deps, 'memory.import', { userId, paths })).toEqual({ files: 9, noop: 0, update: 0, supersede: 0, add: 1, skipped: 8 });
    const texts = (await s.repos.memory.list({ userId }, { limit: 50 })).rows.map((m) => m.text);
    expect(texts).toEqual(['The user prefers short answers.']);
  });

  it('default scan skips a memory dir symlinked out of claude_home and a file symlinked out of it', async () => {
    const { home, handlers } = setup();
    const { deps, userId } = handlers(uid());
    const note = '---\nname: s\ndescription: OUTSIDE SECRET\ntype: user\n---\nbody';
    fs.writeFileSync(path.join(home.otherDir, 'secret.md'), note);
    fs.mkdirSync(path.join(home.home, 'projects/-x-proj'), { recursive: true });
    fs.symlinkSync(home.otherDir, path.join(home.home, 'projects/-x-proj/memory'));
    fs.mkdirSync(path.join(home.home, 'projects/-y-proj/memory'), { recursive: true });
    fs.symlinkSync(path.join(home.otherDir, 'secret.md'), path.join(home.home, 'projects/-y-proj/memory/link.md'));
    const counts = await run(deps, 'memory.import', { userId });
    expect(counts).toMatchObject({ add: 0, skipped: 2 });
    expect((await s.repos.memory.list({ userId }, { limit: 50 })).rows).toEqual([]);
  });

  it('propagates an embedder failure so the queue retries, and leaves the files untouched', async () => {
    const { home, handlers } = setup();
    const { deps, userId } = handlers(uid());
    copyFixture(home.home);
    const failing = { ...deps, embed: (async () => {
      throw new Error('embedder down');
    }) as never };
    await expect(run(failing, 'memory.import', { userId })).rejects.toThrow('embedder down');
  });
});

describe('memory.distill (D16)', () => {
  const row = (cwd: string) => JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hello' } }) + '\n';
  const mk = (dir: string, name: string, body: string, ageMs: number): string => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, body);
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(p, t, t);
    return fs.realpathSync(p);
  };
  const D = 86_400_000;

  it('queues oldest first within the limit, skips runner and bad names, leaves young ones, and never submits a path twice', async () => {
    const { home, handlers } = setup();
    const { deps, userId } = handlers(uid());
    const project = await s.repos.projects.upsert({ userId }, { root: '/x/proj' });
    const dir = path.join(home.home, 'projects', '-x-proj');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    const bad = mk(dir, 'bad name.jsonl', row('/x/proj'), 5 * D);
    const runner = mk(dir, 'r1.jsonl', row('/repo/.ctc/wt/run/step'), 4 * D);
    const s2 = mk(dir, 's2.jsonl', JSON.stringify({ type: 'summary' }) + '\n' + row('/x/proj/'), 3 * D);
    const s1 = mk(dir, 's1.jsonl', toJsonl([{ type: 'user', message: { role: 'user', content: 'no cwd' } }]), 2 * D);
    mk(dir, 'young.jsonl', row('/x/proj'), 0);
    fs.writeFileSync(path.join(dir, 'sub', 'deep.jsonl'), row('/x/proj'));
    fs.symlinkSync(s2, path.join(dir, 'link.jsonl'));
    submits.length = 0;

    expect(await run(deps, 'memory.distill', { userId, limit: 1 })).toEqual({ found: 5, queued: 1, skipped: 2, known: 0, young: 1, left: 1 });
    expect(submits).toEqual([
      { queue: 'llm', kind: 'extract', id: 'distill:' + createHash('sha1').update(s2).digest('hex'), payload: { userId, sessionId: 's2', transcriptPath: s2, projectId: project.id } },
    ]);
    expect(await run(deps, 'memory.distill', { userId })).toEqual({ found: 5, queued: 1, skipped: 0, known: 3, young: 1, left: 0 });
    expect(submits.at(-1)?.payload).toEqual({ userId, sessionId: 's1', transcriptPath: s1 });
    expect(await run(deps, 'memory.distill', { userId })).toEqual({ found: 5, queued: 0, skipped: 0, known: 4, young: 1, left: 0 });
    expect(new Set(submits.map((x) => x.id)).size).toBe(submits.length);
    const hist = await s.repos.history.byPaths({ userId }, [bad, runner, s2, s1]);
    expect(hist.map((h) => [path.basename(h.path), h.status]).sort()).toEqual([['bad name.jsonl', 'skipped'], ['r1.jsonl', 'skipped'], ['s1.jsonl', 'imported'], ['s2.jsonl', 'imported']]);
    expect(fs.readFileSync(s2, 'utf8')).toContain('"summary"');
  });

  it('clamps the limit to 1..500, uses the default limit, and returns zeros for a missing projects dir', async () => {
    const { home, handlers } = setup();
    const { deps, userId } = handlers(uid());
    const dir = path.join(home.home, 'projects', '-x-p2');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 3; i++) mk(dir, `f${i}.jsonl`, row('/nowhere'), (10 - i) * D);
    submits.length = 0;
    recallLimits.distillDefault = 2;
    expect(await run(deps, 'memory.distill', { userId })).toMatchObject({ queued: 2, left: 1 });
    expect(await run(deps, 'memory.distill', { userId, limit: 0 })).toMatchObject({ queued: 1, left: 0 });
    expect(submits.every((x) => !('projectId' in (x.payload as object)))).toBe(true);
    fs.rmSync(path.join(home.home, 'projects'), { recursive: true });
    expect(await run(deps, 'memory.distill', { userId })).toEqual({ found: 0, queued: 0, skipped: 0, known: 0, young: 0, left: 0 });
  });

  it('propagates a submit error without recording the transcript as imported', async () => {
    const { home, handlers } = setup();
    const { deps, userId } = handlers(uid());
    const dir = path.join(home.home, 'projects', '-x-p3');
    fs.mkdirSync(dir, { recursive: true });
    const f = mk(dir, 'a.jsonl', row('/nowhere'), 3 * D);
    const failing = { ...deps, submit: async () => Promise.reject(new Error('queue down')) };
    await expect(run(failing, 'memory.distill', { userId })).rejects.toThrow('queue down');
    expect(await s.repos.history.byPaths({ userId }, [f])).toEqual([]);
  });
});
