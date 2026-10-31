import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { libraryLimits } from '@ctc/core/library';
import { libraryHandlers, scanLibrary, type ScanResult } from './index.ts';
import { handlerCtx, libConfig, scratchRepos, skillMd, tempTree, unitVec, type ScratchRepos } from './testing.ts';

let s: ScratchRepos;
const tree = tempTree();
beforeAll(async () => {
  s = await scratchRepos('ctc_t31_');
}, 60_000);
afterAll(async () => {
  tree.remove();
  await s?.drop();
});

let seq = 0;
const newUser = () => ({ userId: `u-${++seq}-${Math.random().toString(16).slice(2, 8)}` });
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const scan = (ctx: { userId: string }, home: string, extra: Partial<Parameters<typeof scanLibrary>[0]> = {}): Promise<ScanResult> =>
  scanLibrary({ repos: s.repos, ctx, roots: [{ path: home, namespace: 'user' }], ...extra });
const idOf = (r: ScanResult, name: string) => r.created.find((c) => c.name === name)?.capId as string;
const versions = async (ctx: { userId: string }, capId: string) => [...(await s.repos.library.listVersions(ctx, capId))].sort((a, b) => a.version - b.version);
const manifestPaths = async (ctx: { userId: string }, capId: string) => {
  const latest = (await versions(ctx, capId)).find((v) => v.labels.includes('latest'));
  return (await s.repos.library.manifest(ctx, latest?.id as string)).map((m) => m.path).sort();
};

describe('scanLibrary results (D3, D4, D5)', () => {
  it('returns JSON-safe shapes and puts a bad capability in skipped while the others are versioned', async () => {
    const h = tree.home();
    tree.put(path.join(h, 'skills/ok/SKILL.md'), skillMd('ok', 'fine'));
    tree.put(path.join(h, 'skills/bad/SKILL.md'), '---\nname: bad\ndescription: x: y: z\n---\n');
    tree.put(path.join(h, 'agents/ag.md'), skillMd('ag', 'agent'));
    const ctx = newUser();
    const r = await scan(ctx, h);
    expect(Object.keys(r).sort()).toEqual(['created', 'removed', 'roots', 'skipped', 'unchanged', 'warnings']);
    expect(r.roots).toEqual([{ path: h, namespace: 'user', walked: true }]);
    expect(r.created.map((c) => `${c.namespace}/${c.kind}/${c.name}@${c.version}`).sort()).toEqual(['user/agent/ag@1', 'user/skill/ok@1']);
    expect(r.skipped).toEqual([{ code: 'bad_yaml', path: path.join(h, 'skills/bad/SKILL.md'), message: expect.any(String) }]);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    expect(await s.repos.library.byName(ctx, { namespace: 'user', kind: 'skill', name: 'bad' })).toBeNull();
  });
  it('reports the first failing code per capability', async () => {
    const h = tree.home();
    const sk = (dir: string, text: string, extra: Record<string, string> = {}) => {
      tree.put(path.join(h, 'skills', dir, 'SKILL.md'), text);
      for (const [p, t] of Object.entries(extra)) tree.put(path.join(h, 'skills', dir, p), t);
    };
    sk('d4-ok', skillMd('d4-ok', 'fine'));
    sk('d4-many', '---\nname: [unclosed\n---\n', { 'a.md': 'a', 'b.md': 'b' });
    sk('d4-unclosed', '---\nname: d4-unclosed\ndescription: d\n');
    sk('d4-alias', '---\nname: d4-alias\ndescription: &d text\nother: *d\n---\n');
    sk('D4Upper', '---\ndescription: upper\n---\n');
    sk('d4-desc', skillMd('d4-desc', 'eleven char'));
    sk('d4-zdup', skillMd('d4-ok', 'dup'));
    const r = await scan(newUser(), h, { limits: { ...libraryLimits, maxFiles: 2, maxDescription: 10 } });
    expect(r.created.map((c) => c.name)).toEqual(['d4-ok']);
    expect(Object.fromEntries(r.skipped.map((x) => [path.basename(path.dirname(x.path)), x.code]))).toEqual({
      'd4-many': 'too_many_files', 'd4-unclosed': 'bad_yaml', 'd4-alias': 'bad_yaml', D4Upper: 'bad_name', 'd4-desc': 'description_too_long', 'd4-zdup': 'duplicate_name',
    });
  });
  it('accepts no frontmatter, CRLF, BOM, empty header and non-string name or description; empty and missing roots give empty results', async () => {
    const h = tree.home();
    tree.put(path.join(h, 'agents/plain.md'), 'Just text\n');
    tree.put(path.join(h, 'skills/crlf/SKILL.md'), '---\r\nname: crlf\r\ndescription: crlf desc\r\n---\r\nBody\r\n');
    tree.put(path.join(h, 'skills/bom/SKILL.md'), '﻿---\nname: bom\ndescription: bom\n---\nB');
    tree.put(path.join(h, 'skills/empty/SKILL.md'), '---\n---\nbody');
    tree.put(path.join(h, 'commands/num.md'), '---\nname: 7\ndescription: [a, b]\n---\nx');
    const ctx = newUser();
    const r = await scan(ctx, h);
    expect(r.created.map((c) => c.name).sort()).toEqual(['bom', 'crlf', 'empty', 'num', 'plain']);
    expect(r.skipped).toEqual([]);
    const v = async (name: string) => (await versions(ctx, idOf(r, name)))[0];
    expect([(await v('plain'))?.description, (await v('plain'))?.frontmatter]).toEqual(['', {}]);
    expect((await v('crlf'))?.description).toBe('crlf desc');
    expect((await v('num'))?.description).toBe('');
    const again = await scan(ctx, h);
    expect([again.created, again.unchanged, again.removed]).toEqual([[], 5, []]);
    expect(await scan(ctx, path.join(h, 'nope'))).toEqual({ roots: [{ path: path.join(h, 'nope'), namespace: 'user', walked: false }], created: [], unchanged: 0, removed: [], skipped: [], warnings: [] });
    expect(await scanLibrary({ repos: s.repos, ctx, roots: [] })).toEqual({ roots: [], created: [], unchanged: 0, removed: [], skipped: [], warnings: [] });
  });
  it('stores the manifest of a multi-file skill without ignored or outside files (D1, D11)', async () => {
    const h = tree.home();
    const dir = path.join(h, 'skills/multi');
    tree.put(path.join(dir, 'SKILL.md'), skillMd('multi', 'm'));
    tree.put(path.join(dir, 'refs/a.md'), 'a');
    tree.put(path.join(dir, '.env'), 'TOKEN=x');
    fs.symlinkSync(tree.put(path.join(tree.dir, 'out.txt'), 'secret'), path.join(dir, 'leak.md'));
    const ctx = newUser();
    const r = await scan(ctx, h);
    expect(await manifestPaths(ctx, idOf(r, 'multi'))).toEqual(['SKILL.md', 'refs/a.md']);
    expect(r.warnings.map((w) => [w.code, w.path])).toEqual([['symlink_outside', path.join(dir, 'leak.md')]]);
  });
});

describe('scanLibrary changes and removal (D6, D7, D14)', () => {
  it('writes nothing for an unchanged tree, versions an edit, submits changed with a fixed id, survives a failing submit', async () => {
    const h = tree.home();
    tree.put(path.join(h, 'skills/s/SKILL.md'), skillMd('s', 'fourteen'));
    const ref = tree.put(path.join(h, 'skills/s/ref.md'), 'v1');
    const ctx = newUser();
    const calls: { queue: string; kind: string; payload: unknown; id?: string }[] = [];
    const submit = async (x: (typeof calls)[number]) => { calls.push(x); return { id: x.id }; };
    const r1 = await scan(ctx, h, { submit });
    const id = idOf(r1, 's');
    expect(calls).toEqual([{ queue: 'library', kind: 'changed', payload: { userId: ctx.userId, capId: id, version: 1 }, id: `library.changed:${id}:1` }]);
    const r2 = await scan(ctx, h, { submit });
    expect([r2.created, r2.unchanged, calls.length]).toEqual([[], 1, 1]);
    fs.writeFileSync(ref, 'v2');
    const r3 = await scan(ctx, h, { submit });
    expect(r3.created.map((c) => c.version)).toEqual([2]);
    expect((await versions(ctx, id)).map((v) => [v.version, [...v.labels].sort(), v.commitMessage])).toEqual([[1, ['production'], 'scan'], [2, ['latest'], 'scan']]);
    expect(calls.at(-1)?.id).toBe(`library.changed:${id}:2`);
    fs.writeFileSync(ref, 'v3');
    const r4 = await scan(ctx, h, { submit: async () => { throw new Error('redis down'); }, log: () => undefined });
    expect(r4.created.map((c) => c.version)).toEqual([3]);
  });
  it('soft-removes a vanished capability once, publishes inval, and un-removes it when it returns without a new version', async () => {
    const h = tree.home();
    tree.put(path.join(h, 'agents/a.md'), skillMd('a', 'agent'));
    const ctx = newUser();
    const pubs: unknown[] = [];
    const calls: string[] = [];
    const deps = { cache: { publishInval: async (m: unknown) => void pubs.push(m) }, submit: async (x: { id?: string }) => void calls.push(x.id ?? '') };
    const id = idOf(await scan(ctx, h, deps), 'a');
    const text = fs.readFileSync(path.join(h, 'agents/a.md'), 'utf8');
    fs.rmSync(path.join(h, 'agents/a.md'));
    const gone = await scan(ctx, h, deps);
    expect(gone.removed).toEqual([{ capId: id, namespace: 'user', kind: 'agent', name: 'a' }]);
    expect(pubs).toEqual([{ v: 1, event: 'library.changed', userId: ctx.userId }]);
    tree.put(path.join(h, 'agents/a.md'), text);
    const back = await scan(ctx, h, deps);
    expect([back.created, (await s.repos.library.get(ctx, id))?.removedAt, (await versions(ctx, id)).length, calls.length]).toEqual([[], null, 1, 2]);
  });
  it('never removes a capability of an unwalked root or one that was found but skipped; versions are kept', async () => {
    const h = tree.home();
    tree.put(path.join(h, 'agents/keep.md'), skillMd('keep', 'agent'));
    tree.put(path.join(h, 'skills/renamed/SKILL.md'), skillMd('old-name', 'x'));
    const ctx = newUser();
    const r = await scan(ctx, h);
    const [keep, old] = [idOf(r, 'keep'), idOf(r, 'old-name')];
    fs.renameSync(h, `${h}-moved`);
    const unwalked = await scan(ctx, h);
    expect([unwalked.roots[0]?.walked, unwalked.removed]).toEqual([false, []]);
    fs.renameSync(`${h}-moved`, h);
    tree.put(path.join(h, 'agents/keep.md'), '---\nname: keep\ndescription: broken: yaml: here\n---\n');
    tree.put(path.join(h, 'skills/renamed/SKILL.md'), '---\nname: [broken\n---\n');
    const skipped = await scan(ctx, h);
    expect([skipped.skipped.map((x) => x.code), skipped.removed]).toEqual([['bad_yaml', 'bad_yaml'], []]);
    expect([(await s.repos.library.get(ctx, keep))?.removedAt, (await s.repos.library.get(ctx, old))?.removedAt]).toEqual([null, null]);
    fs.rmSync(path.join(h, 'agents/keep.md'));
    const gone = await scan(ctx, h);
    expect(gone.removed.map((x) => x.capId)).toEqual([keep]);
    expect((await versions(ctx, keep)).length).toBe(1);
  });
  it('an unlistable capability directory leaves the root unwalked and removes nothing (D8)', async () => {
    const h = tree.home();
    tree.put(path.join(h, 'skills/s1/SKILL.md'), skillMd('s1', 's'));
    const ctx = newUser();
    const r = await scan(ctx, h);
    fs.chmodSync(path.join(h, 'skills'), 0);
    try {
      const again = await scan(ctx, h);
      expect([again.roots[0]?.walked, again.removed, again.skipped.map((x) => x.code)]).toEqual([false, [], ['unreadable']]);
      expect((await s.repos.library.get(ctx, idOf(r, 's1')))?.removedAt).toBeNull();
    } finally {
      fs.chmodSync(path.join(h, 'skills'), 0o755);
    }
  });
  it('a skill directory that cannot be entered is skipped as unreadable and not removed (D8)', async () => {
    const h = tree.home();
    tree.put(path.join(h, 'skills/s1/SKILL.md'), skillMd('s1', 's'));
    const ctx = newUser();
    const r = await scan(ctx, h);
    fs.chmodSync(path.join(h, 'skills/s1'), 0);
    try {
      const again = await scan(ctx, h);
      expect([again.removed, again.skipped.map((x) => x.code)]).toEqual([[], ['unreadable']]);
      expect((await s.repos.library.get(ctx, idOf(r, 's1')))?.removedAt).toBeNull();
    } finally {
      fs.chmodSync(path.join(h, 'skills/s1'), 0o755);
    }
  });
  it('does not touch another user, does not write under the root and submits no other queue (D6h, D6a, D7)', async () => {
    const h = tree.home();
    tree.put(path.join(h, 'skills/shared/SKILL.md'), skillMd('shared', 'x'));
    const [a, b] = [newUser(), newUser()];
    const before = fs.readdirSync(h, { recursive: true }).sort();
    const queues: string[] = [];
    await scan(a, h, { submit: async (x) => void queues.push(`${x.queue}.${x.kind}`) });
    await scan(b, h);
    fs.rmSync(path.join(h, 'skills/shared'), { recursive: true });
    await scan(a, h);
    expect((await s.repos.library.byName(a, { namespace: 'user', kind: 'skill', name: 'shared' }))?.removedAt).not.toBeNull();
    expect((await s.repos.library.byName(b, { namespace: 'user', kind: 'skill', name: 'shared' }))?.removedAt).toBeNull();
    expect(queues).toEqual(['library.changed']);
    expect(before).toEqual(['skills', 'skills/shared', 'skills/shared/SKILL.md']);
    expect((await s.repos.jobs.list(a, {})).rows).toEqual([]);
  });
  it('rejects with the abort reason before writing when the signal is aborted', async () => {
    const h = tree.home();
    tree.put(path.join(h, 'agents/x.md'), skillMd('x', 'x'));
    const ctx = newUser();
    const ac = new AbortController();
    ac.abort(new Error('stop'));
    await expect(scan(ctx, h, { signal: ac.signal })).rejects.toThrow('stop');
    expect(await s.repos.library.byName(ctx, { namespace: 'user', kind: 'agent', name: 'x' })).toBeNull();
  });
});

describe('library.scan handler (D1, D18)', () => {
  it('drops a scan for another user or in shared mode, ignores payload.roots, reads limits at call time', async () => {
    const h = tree.home();
    const other = tree.home();
    tree.put(path.join(h, 'skills/home-skill/SKILL.md'), skillMd('home-skill', 'h'));
    tree.put(path.join(h, 'skills/home-skill/a.md'), 'a');
    tree.put(path.join(h, 'skills/home-skill/b.md'), 'b');
    tree.put(path.join(other, 'skills/evil/SKILL.md'), skillMd('evil', 'e'));
    const cfg = libConfig(h);
    const H = libraryHandlers({ repos: s.repos, config: cfg });
    const scanH = H['library.scan'] as unknown as (p: unknown, c: ReturnType<typeof handlerCtx>) => Promise<ScanResult>;
    await expect(scanH({ userId: 'user-b' }, handlerCtx())).rejects.toMatchObject({ name: 'UnrecoverableError', message: 'dropped:scan_not_local' });
    await expect(libraryHandlers({ repos: s.repos, config: { ...cfg, mode: 'shared' } })['library.scan']({ userId: 'local' } as never, handlerCtx())).rejects.toMatchObject({ message: 'dropped:scan_not_local' });
    cfg.library.max_files = 2;
    const r1 = await scanH({ userId: 'local', roots: [other] }, handlerCtx());
    expect([r1.roots, r1.skipped.map((x) => x.code), r1.created]).toEqual([[{ path: h, namespace: 'user', walked: true }], ['too_many_files'], []]);
    cfg.library.max_files = 200;
    const r2 = await scanH({ userId: 'local' }, handlerCtx());
    expect(r2.created.map((c) => c.name)).toEqual(['home-skill']);
    const ac = new AbortController();
    ac.abort(new Error('stop'));
    await expect(scanH({ userId: 'local' }, handlerCtx(ac.signal))).rejects.toThrow('stop');
  });
});

describe('library.changed handler (D16, D17, D19)', () => {
  it('sets servedVersion, embeds the served SKILLRET text once, prunes old vectors, writes dedup pairs, publishes inval', async () => {
    const h = tree.home();
    tree.put(path.join(h, 'skills/a/SKILL.md'), skillMd('a', 'alpha', 'Body A\n'));
    tree.put(path.join(h, 'skills/b/SKILL.md'), skillMd('b', 'beta', 'Body B\n'));
    const ctx = newUser();
    const r = await scan(ctx, h);
    const [a, b] = [idOf(r, 'a'), idOf(r, 'b')];
    const texts: string[] = [];
    const pubs: unknown[] = [];
    const embed = async (t: string[]) => { texts.push(...t); return t.map(() => unitVec(17)); };
    const H = libraryHandlers({ repos: s.repos, config: libConfig(h), embed, cache: { publishInval: async (m) => void pubs.push(m) } });
    const changed = (capId: string, version = 1) => H['library.changed']({ userId: ctx.userId, capId, version } as never, handlerCtx());
    const vectorHashes = async (capId: string) => (await s.repos.library.loadVectors(ctx)).filter((v) => v.capId === capId).map((v) => v.textHash);
    expect(await changed(a)).toEqual({ capId: a, servedVersion: 1, embedded: true, dedup: 0 });
    expect(texts).toEqual(['a | alpha | Body A\n']);
    expect(await vectorHashes(a)).toEqual([sha(texts[0] as string)]);
    expect(await changed(b)).toEqual({ capId: b, servedVersion: 1, embedded: true, dedup: 1 });
    const pairs = (await s.repos.dedup.listOpen(ctx, {})).rows;
    expect([pairs.length, [pairs[0]?.a, pairs[0]?.b].sort()]).toEqual([1, [a, b].sort()]);
    expect(await changed(a)).toEqual({ capId: a, servedVersion: 1, embedded: false, dedup: 1 });
    tree.put(path.join(h, 'skills/a/SKILL.md'), skillMd('a', 'alpha', 'Body A2\n'));
    await scan(ctx, h);
    expect(await changed(a, 2)).toEqual({ capId: a, servedVersion: 1, embedded: false, dedup: 1 });
    await s.repos.library.moveLabels(ctx, { capId: a, version: 2, labels: ['production'] });
    expect(await changed(a, 2)).toEqual({ capId: a, servedVersion: 2, embedded: true, dedup: 1 });
    expect(await vectorHashes(a)).toEqual([sha('a | alpha | Body A2\n')]);
    expect(pubs).toHaveLength(5);
  });
  it('cuts the body at skillret_body_chars, keeps the old vector when the embedder throws, skips unknown and removed capabilities', async () => {
    const h = tree.home();
    tree.put(path.join(h, 'skills/c/SKILL.md'), skillMd('c', 'gamma', 'abcdef'));
    tree.put(path.join(h, 'skills/d/SKILL.md'), skillMd('d', 'delta', 'old'));
    const ctx = newUser();
    const r = await scan(ctx, h);
    const texts: string[] = [];
    const cfg = libConfig(h);
    cfg.embed.skillret_body_chars = 3;
    const embed = async (t: string[]) => { texts.push(...t); return t.map(() => unitVec(5)); };
    const run = (deps: Partial<Parameters<typeof libraryHandlers>[0]>, capId: string, version = 1) =>
      libraryHandlers({ repos: s.repos, config: cfg, ...deps })['library.changed']({ userId: ctx.userId, capId, version } as never, handlerCtx());
    await run({ embed }, idOf(r, 'c'));
    expect(texts).toEqual(['c | gamma | abc']);
    const d = idOf(r, 'd');
    await run({ embed }, d);
    tree.put(path.join(h, 'skills/d/SKILL.md'), skillMd('d', 'delta', 'new'));
    await scan(ctx, h);
    await s.repos.library.moveLabels(ctx, { capId: d, version: 2, labels: ['production'] });
    const before = (await s.repos.library.loadVectors(ctx)).filter((v) => v.capId === d);
    await expect(run({ embed: async () => { throw new Error('tei down'); } }, d, 2)).rejects.toThrow('tei down');
    expect((await s.repos.library.loadVectors(ctx)).filter((v) => v.capId === d)).toEqual(before);
    const ghost = randomUUID();
    expect(await run({}, ghost)).toEqual({ capId: ghost, skipped: 'not_found' });
    fs.rmSync(path.join(h, 'skills/d'), { recursive: true });
    await scan(ctx, h);
    expect(await run({}, d, 2)).toEqual({ capId: d, skipped: 'removed' });
  });
  it('pruneVectors keeps one text hash and is scoped to the caller (D19)', async () => {
    const [a, b] = [newUser(), newUser()];
    const { version } = await s.repos.library.createVersion(a, {
      namespace: 'user', kind: 'skill', name: 'prune', rootPath: '/x/prune', description: '', bodyHash: 'b',
      blobs: [{ hash: 'h19', content: 'c', size: 1 }], files: [{ path: 'SKILL.md', blobHash: 'h19' }],
    });
    for (const t of ['t1', 't2', 't3']) await s.repos.library.upsertVector(a, { capId: version.capId, textHash: t, embedding: unitVec(19) });
    expect(await s.repos.library.pruneVectors(b, version.capId, 't1')).toBe(0);
    expect(await s.repos.library.pruneVectors(a, version.capId, 't1')).toBe(2);
    expect((await s.repos.library.loadVectors(a)).map((v) => v.textHash)).toEqual(['t1']);
    expect(await s.repos.library.pruneVectors(a, 'not-a-uuid', 't1')).toBe(0);
  });
});
