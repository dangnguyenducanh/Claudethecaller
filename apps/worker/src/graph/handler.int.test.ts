import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { limits } from '@ctc/core/graph';
import { scratchRepos, type ScratchRepos } from '../library/testing.ts';
import { graphHandlers } from './index.ts';
import { cfg, fns, handlerCtx, kit, type Kit } from './testing.ts';

let s: ScratchRepos;
let k: Kit;
const keepCore = { ...limits };
beforeAll(async () => {
  s = await scratchRepos('ctc_t22_');
  k = await kit(s.repos);
}, 60_000);
afterAll(async () => {
  k?.cleanup();
  await s?.drop();
});
afterEach(() => void Object.assign(limits, keepCore));

const handler = (o: Partial<Parameters<typeof graphHandlers>[0]> = {}) => graphHandlers({ repos: s.repos, config: cfg(), grammars: k.grammars, ...o })['graph.rebuild'];
const dropped = (code: string) => (e: unknown) => (e as Error)?.name === 'UnrecoverableError' && (e as Error).message === `dropped:${code}`;
const rnd = (): string => Math.random().toString(16).slice(2, 8);
const sources = async (ctx: { userId: string; projectId: string }) => (await s.repos.graph.listSources(ctx)).map((x) => x.file);

describe('graphHandlers', () => {
  it('handles only graph.rebuild (D7)', () => {
    expect(Object.keys(graphHandlers({ repos: s.repos, config: cfg(), grammars: k.grammars }))).toEqual(['graph.rebuild']);
  });

  it('drops the job before reading any file unless mode is local and the user is local (D1a)', async () => {
    const pr = await k.project({ 'ok.ts': 'export function ok() {}\n' });
    const shared = graphHandlers({ repos: s.repos, config: { ...cfg(), mode: 'shared' }, grammars: k.grammars })['graph.rebuild'];
    await expect(shared({ userId: 'local', projectId: pr.ctx.projectId } as never, handlerCtx())).rejects.toSatisfy(dropped('rebuild_not_local'));
    await expect(handler()({ userId: 'user-b', projectId: pr.ctx.projectId } as never, handlerCtx())).rejects.toSatisfy(dropped('rebuild_not_local'));
    expect(await sources(pr.ctx)).toEqual([]);
  });

  it('checks the project, then the root; a missing root deletes nothing (D4)', async () => {
    await expect(handler()({ userId: 'local', projectId: `nope${rnd()}` } as never, handlerCtx())).rejects.toSatisfy(dropped('project_not_found'));
    const p = await s.repos.projects.upsert({ userId: 'local' }, { root: `/tmp/ctc-t22-gone-${rnd()}` });
    const ctx = { userId: 'local', projectId: p.id };
    await s.repos.graph.replaceSource(ctx, { origin: 'ast', sourceFile: 'k.ts', nodes: [{ id: 'code:k', kind: 'code', type: 'file', label: 'k.ts' }], edges: [], source: { contentHash: 'h', extractorVersion: 'v' } });
    await expect(handler()({ userId: 'local', projectId: p.id } as never, handlerCtx())).rejects.toSatisfy(dropped('root_missing'));
    expect(await sources(ctx)).toEqual(['k.ts']);
  });

  it('ends with dropped:shrink_guard naming the file; force writes it (D16)', async () => {
    const pr = await k.project({ 'big.ts': fns(14) });
    await k.rebuild(pr);
    pr.put('big.ts', fns(8));
    const payload = { userId: 'local', projectId: pr.ctx.projectId, files: ['big.ts'] };
    await expect(handler()(payload as never, handlerCtx())).rejects.toSatisfy(dropped('shrink_guard: big.ts'));
    const forced = (await handler()({ ...payload, force: true } as never, handlerCtx())) as { files: { written: string[] } };
    expect(forced.files.written).toEqual(['big.ts']);
  });

  it('throws a retryable extract_failed error after the other files were written (D3)', async () => {
    const pr = await k.project({ 'ok.ts': 'function o(){}\nfunction k(){}\n', 'big.ts': 'export function big() { return 1234567890; }\n' });
    limits.maxFileBytes = 30;
    await expect(handler()({ userId: 'local', projectId: pr.ctx.projectId } as never, handlerCtx())).rejects.toSatisfy(
      (e: Error) => e.name !== 'UnrecoverableError' && e.message === 'extract_failed: big.ts (too_large)',
    );
    expect(await sources(pr.ctx)).toEqual(['ok.ts']);
  });

  it('delays a files job until the job row is debounce_s old; force skips the wait; abort ends it (D21)', async () => {
    const pr = await k.project({ 'x.ts': 'export function x() {}\n' });
    const payload = { userId: 'local', projectId: pr.ctx.projectId, files: ['x.ts'] };
    const { job } = await s.repos.jobs.create({ userId: 'local' }, { queue: 'graph', kind: 'rebuild', payload });
    const h = handler({ config: cfg({ debounce_s: 1 }) });
    let t = Date.now();
    await h(payload as never, handlerCtx({ jobId: job.id }));
    expect(Date.now() - t).toBeGreaterThanOrEqual(700);
    const { job: j2 } = await s.repos.jobs.create({ userId: 'local' }, { queue: 'graph', kind: 'rebuild', payload });
    t = Date.now();
    await h({ ...payload, force: true } as never, handlerCtx({ jobId: j2.id }));
    expect(Date.now() - t).toBeLessThan(700);
    const { job: j3 } = await s.repos.jobs.create({ userId: 'local' }, { queue: 'graph', kind: 'rebuild', payload });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    t = Date.now();
    await expect(handler({ config: cfg({ debounce_s: 30 }) })(payload as never, handlerCtx({ jobId: j3.id, signal: ac.signal }))).rejects.toThrow();
    expect(Date.now() - t).toBeLessThan(3000);
  });
});
