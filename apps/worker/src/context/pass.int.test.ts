import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { graphLimits } from '../graph/index.ts';
import { contextPass, contextWorkerLimits } from './index.ts';
import { CLAUDE_TEXT, SP, SPEC_PATH, SPEC_TEXT, SRC, fid, kit, scratchRepos, sid, snapshot, vec, type Kit, type ScratchRepos } from './testing.ts';

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
const keepWorker = { ...contextWorkerLimits };
const keepGraph = { ...graphLimits };
afterEach(() => {
  Object.assign(contextWorkerLimits, keepWorker);
  Object.assign(graphLimits, keepGraph);
});

const noTime = <T extends { updatedAt: Date }>(n: T) => ({ ...n, updatedAt: null });
const rnd = (): string => Math.random().toString(16).slice(2, 8);
const pass = (pr: { root: string; ctx: { userId: string; projectId: string } }, o: Record<string, unknown> = {}) => contextPass({ repos: s.repos, ctx: pr.ctx, root: pr.root, ...o });
const parserNodes = async (ctx: { userId: string; projectId: string }, file?: string) => (await s.repos.graph.loadGraph(ctx)).nodes.filter((n) => n.origin === 'parser' && (file === undefined || n.sourceFile === file));
const edgesOf = async (ctx: { userId: string; projectId: string }, origin: string) => (await s.repos.graph.loadGraph(ctx)).edges.filter((e) => e.origin === origin);
const files = { ...SRC, [SPEC_PATH]: SPEC_TEXT, 'CLAUDE.md': CLAUDE_TEXT, 'README.md': '# Readme\n- [ ] T1.1 not a context path\n' };

describe('contextPass', () => {
  it('writes parser rows with the parsed shapes and resolves code references; ast rows and graph_sources stay (D7, D9)', async () => {
    const pr = await k.project(files, `u-${rnd()}`);
    await k.rebuild(pr);
    const sources = await s.repos.graph.listSources(pr.ctx);
    const astBefore = (await s.repos.graph.loadGraph(pr.ctx)).nodes.filter((n) => n.origin === 'ast').map(noTime);
    const r = await pass(pr);
    expect([r.mode, r.counts.candidates, r.counts.written, r.files.written]).toEqual(['full', 2, 2, ['CLAUDE.md', SPEC_PATH]]);
    expect(await s.repos.graph.listSources(pr.ctx)).toEqual(sources);
    expect((await s.repos.graph.loadGraph(pr.ctx)).nodes.filter((n) => n.origin === 'ast').map(noTime)).toEqual(astBefore);
    const t11 = (await parserNodes(pr.ctx, SPEC_PATH)).find((n) => n.id === SP('T1.1'));
    expect([t11?.kind, t11?.type, t11?.label, t11?.sourceLocation]).toEqual(['context', 'task', 'parse files in `src/parse.ts` and `./lib/a.ts::go`', 'L11']);
    const code = (await edgesOf(pr.ctx, 'parser')).filter((e) => e.relation === 'implements').map((e) => [e.src, e.dst, e.confidence, e.score]).sort();
    expect(code).toEqual([[SP('T1.1'), sid('lib/a.ts', 'go'), 'EXTRACTED', 1], [SP('T1.1'), fid('src/parse.ts'), 'EXTRACTED', 1]].sort());
    expect((await edgesOf(pr.ctx, 'parser')).filter((e) => e.relation === 'part_of')).toHaveLength(7);
  });

  it('skips unchanged files, rewrites one edited file, honours force and files mode (D10)', async () => {
    const pr = await k.project(files, `u-${rnd()}`);
    await k.rebuild(pr);
    const calls: string[] = [];
    const cache = { epoch: { rotate: async () => (calls.push('rotate'), 'e1') }, publishInval: async () => void calls.push('inval') };
    const r1 = await pass(pr, { cache });
    expect([r1.counts.written, r1.epoch, calls]).toEqual([2, 'e1', ['rotate', 'inval']]);
    calls.length = 0;
    const rows = await parserNodes(pr.ctx);
    const r2 = await pass(pr, { cache });
    expect([r2.counts.written, r2.counts.unchanged, calls]).toEqual([0, 2, []]);
    expect(await parserNodes(pr.ctx)).toEqual(rows);
    pr.put(SPEC_PATH, SPEC_TEXT.replace('second cell label', 'changed label'));
    const r3 = await pass(pr);
    expect([r3.files.written, r3.counts.unchanged]).toEqual([[SPEC_PATH], 1]);
    expect((await parserNodes(pr.ctx, SPEC_PATH)).find((n) => n.id === SP('T1.2'))?.label).toBe('changed label');
    expect((await pass(pr, { force: true })).counts).toMatchObject({ written: 2, unchanged: 0 });
    const m = await pass(pr, { files: ['README.md', SPEC_PATH, 'src/parse.ts'] });
    expect([m.mode, m.counts.ignored, m.counts.candidates, m.counts.unchanged]).toEqual(['files', 2, 1, 1]);
    await expect(pass(pr, { signal: AbortSignal.abort(new Error('stopnow')) })).rejects.toThrow('stopnow');
  });

  it('submits one extract job per written file with tasks or decisions, bounded and fail-soft (D10f)', async () => {
    const pr = await k.project(files, `u-${rnd()}`);
    const subs: { id?: string; payload: unknown }[] = [];
    const r = await pass(pr, { submit: async (i: { id?: string; payload: unknown }) => void subs.push(i) });
    expect([r.counts.submitted, subs.length]).toEqual([2, 2]);
    const s0 = subs.find((x) => (x.payload as { files: string[] }).files[0] === SPEC_PATH);
    expect(s0?.id).toMatch(new RegExp(`^graph\\.extract:${pr.ctx.projectId}:[0-9a-f]{16}$`));
    contextWorkerLimits.maxExtractSubmit = 1;
    subs.length = 0;
    await pass(pr, { force: true, submit: async (i: { id?: string; payload: unknown }) => void subs.push(i) });
    expect(subs).toHaveLength(1);
    expect((await pass(pr, { files: ['CLAUDE.md'], force: true, submit: async () => { throw new Error('boom'); } })).counts.written).toBe(1);
  });

  it('deletes claude rows before parser rows, only after a complete walk or for listed files (D10d)', async () => {
    const pr = await k.project(files, `u-${rnd()}`);
    await k.rebuild(pr);
    await pass(pr);
    await s.repos.graph.replaceSource(pr.ctx, { origin: 'claude', sourceFile: SPEC_PATH, nodes: [], edges: [{ src: SP('T1.2'), dst: fid('src/parse.ts'), relation: 'implements', confidence: 'INFERRED', score: 0.6 }] });
    pr.remove(SPEC_PATH);
    graphLimits.maxFiles = 1;
    const t = await pass(pr);
    expect([t.truncated, t.counts.deleted]).toEqual([true, 0]);
    expect((await parserNodes(pr.ctx, SPEC_PATH)).length).toBeGreaterThan(0);
    Object.assign(graphLimits, keepGraph);
    const r = await pass(pr);
    expect([r.files.deleted, (await parserNodes(pr.ctx, SPEC_PATH)).length, (await edgesOf(pr.ctx, 'claude')).length]).toEqual([[SPEC_PATH], 0, 0]);
  });

  it('embeds nodes without a vector on every pass, using meta.embedText when present; embed failures are tolerated (D11, D20)', async () => {
    const pr = await k.project({ [SPEC_PATH]: SPEC_TEXT, ...SRC }, `u-${rnd()}`);
    await k.rebuild(pr);
    const texts: string[] = [];
    const embed = async (t: string[]) => (texts.push(...t), t.map(vec));
    const r = await pass(pr, { embed });
    expect(r.counts.embedded).toBeGreaterThan(0);
    expect(texts).toContain(`second cell label\n${SPEC_TEXT.split('\n')[11]}`);
    const have = new Set((await s.repos.graph.loadVectors(pr.ctx)).map((v) => v.id));
    for (const n of await parserNodes(pr.ctx)) expect(have.has(n.id)).toBe(true);
    expect((await pass(pr, { embed })).counts.embedded).toBe(0);
    const rows = await parserNodes(pr.ctx);
    expect((await pass(pr)).counts.written).toBe(0);
    expect(await parserNodes(pr.ctx)).toEqual(rows);
    const logs: string[] = [];
    pr.put(SPEC_PATH, SPEC_TEXT.replace('heading task', 'changed heading'));
    const down = await pass(pr, { embed: async () => { throw new Error('tei down'); }, log: (m: string) => logs.push(m) });
    expect(down.counts.embedded).toBe(0);
    expect(logs).toContain('graph embed failed');
  });

  it('keeps old rows for an unreadable file and logs a redis outage without failing (D20)', async () => {
    const pr = await k.project({ [SPEC_PATH]: SPEC_TEXT, 'CLAUDE.md': CLAUDE_TEXT }, `u-${rnd()}`);
    const logs: string[] = [];
    const bad = { epoch: { rotate: async () => { throw new Error('redis down'); } }, publishInval: async () => { throw new Error('redis down'); } };
    const r = await pass(pr, { cache: bad, log: (m: string) => logs.push(m) });
    expect([r.counts.written, r.epoch, logs.includes('graph epoch rotate failed')]).toEqual([2, null, true]);
    if (process.getuid?.() !== 0) {
      const f = path.join(pr.root, SPEC_PATH);
      fs.writeFileSync(f, SPEC_TEXT.replace('heading task', 'edited'));
      fs.chmodSync(f, 0o000);
      try {
        const before = await parserNodes(pr.ctx, SPEC_PATH);
        const x = await pass(pr);
        expect([x.files.failed, await parserNodes(pr.ctx, SPEC_PATH)]).toEqual([[{ file: SPEC_PATH, code: 'read_failed' }], before]);
      } finally {
        fs.chmodSync(f, 0o644);
      }
    }
  });

  it('never writes under the root, never follows a symlink out, never touches review rows or other projects (D1, D18)', async () => {
    const a = await k.project(files, `u-${rnd()}`);
    const b = await k.project(files, `u-${rnd()}`);
    await k.rebuild(a);
    await k.rebuild(b);
    await pass(a);
    const bBefore = (await s.repos.graph.loadGraph(b.ctx)).nodes.map(noTime);
    await s.repos.graph.reviewEdge(a.ctx, { src: SP('T1.1'), dst: fid('src/parse.ts'), relation: 'implements', confidence: 'CONFIRMED' });
    const outside = path.join(os.tmpdir(), `ctc-t23-outside-${rnd()}.md`);
    fs.writeFileSync(outside, '- [ ] T7.7 stolenword\n');
    fs.symlinkSync(outside, path.join(a.root, 'specs/leak.md'));
    const snap = snapshot(a.root);
    try {
      const r = await pass(a, { force: true, files: ['specs/leak.md', SPEC_PATH] });
      expect(r.files.written).toEqual([SPEC_PATH]);
    } finally {
      fs.rmSync(outside, { force: true });
    }
    expect(snapshot(a.root)).toEqual(snap);
    expect((await parserNodes(a.ctx)).some((n) => /stolenword/.test(n.label))).toBe(false);
    const reviewed = (await s.repos.graph.loadGraph(a.ctx)).edges.find((e) => e.src === SP('T1.1') && e.dst === fid('src/parse.ts'));
    expect([reviewed?.origin, reviewed?.confidence]).toEqual(['review', 'CONFIRMED']);
    expect((await s.repos.graph.loadGraph(b.ctx)).nodes.map(noTime)).toEqual(bBefore);
  });
});
