import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { graphHandlers } from '../graph/index.ts';
import { contextPass, contextWorkerLimits, extractHandler } from './index.ts';
import * as api from './index.ts';
import { SP, SPEC_PATH, SPEC_TEXT, SRC, fid, handlerCtx, kit, scratchRepos, cfg, type Kit, type ScratchRepos, type TestProject } from './testing.ts';

let s: ScratchRepos;
let k: Kit;
let pr: TestProject;
beforeAll(async () => {
  s = await scratchRepos('ctc_t23_');
  k = await kit(s.repos);
  pr = await k.project({ ...SRC, 'src/other.ts': 'export function other() {}\n', [SPEC_PATH]: SPEC_TEXT, 'specs/empty.md': '# Nothing here\n' });
  await k.rebuild(pr);
  await contextPass({ repos: s.repos, ctx: pr.ctx, root: pr.root });
}, 60_000);
afterAll(async () => {
  k?.cleanup();
  await s?.drop();
});
const keep = { ...contextWorkerLimits };
afterEach(() => void Object.assign(contextWorkerLimits, keep));

const dropped = (code: string) => (e: unknown) => (e as Error)?.name === 'UnrecoverableError' && (e as Error).message === `dropped:${code}`;
let reply = '';
const prompts: string[] = [];
const handler = (o: Partial<Parameters<typeof extractHandler>[0]> = {}) =>
  extractHandler({ repos: s.repos, config: { mode: 'local' }, runClaude: async ({ prompt }) => (prompts.push(prompt), reply), ...o })['graph.extract'];
const payload = (files: string[]) => ({ userId: 'local', projectId: pr.ctx.projectId, files }) as never;
const claudeEdges = async () => (await s.repos.graph.loadGraph(pr.ctx)).edges.filter((e) => e.origin === 'claude');

describe('extractHandler', () => {
  it('stores INFERRED claude edges, keeps parser edges, replaces and clears per file (D15)', async () => {
    reply = JSON.stringify({ edges: [{ from: 'T1.1', relation: 'implements', to: 'src/parse.ts' }, { from: 'T1.2', relation: 'implements', to: 'src/other.ts' }, { from: 'D1', relation: 'decides', to: 'src/nowhere.ts' }] });
    const res = (await handler()(payload([SPEC_PATH, 'specs/empty.md', 'README.md', 'src/parse.ts']), handlerCtx())) as { counts: unknown; files: { extracted: unknown; skipped: { file: string; reason: string }[] } };
    expect(res.counts).toEqual({ requested: 4, extracted: 1, edges: 1, skipped: 3, failed: 0 });
    expect(res.files.extracted).toEqual([{ file: SPEC_PATH, edges: 1 }]);
    expect(res.files.skipped.map((x) => [x.file, x.reason])).toEqual([['README.md', 'not_context'], ['specs/empty.md', 'no_context_nodes'], ['src/parse.ts', 'not_context']]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('T1.2 | task | second cell label');
    expect((await claudeEdges()).map((e) => [e.src, e.dst, e.relation, e.confidence, e.score])).toEqual([[SP('T1.2'), fid('src/other.ts'), 'implements', 'INFERRED', 0.6]]);
    const parser = (await s.repos.graph.loadGraph(pr.ctx)).edges.find((e) => e.origin === 'parser' && e.src === SP('T1.1') && e.dst === fid('src/parse.ts'));
    expect([parser?.confidence, parser?.score]).toEqual(['EXTRACTED', 1]);
    reply = '{"edges":[]}';
    await handler()(payload([SPEC_PATH]), handlerCtx());
    expect(await claudeEdges()).toHaveLength(0);
  });

  it('fails a file on a bad reply or runner error but keeps earlier edges and parser rows; ENOENT drops the job (D15, D20)', async () => {
    reply = JSON.stringify({ edges: [{ from: 'T1.2', relation: 'implements', to: 'src/other.ts' }] });
    await handler()(payload([SPEC_PATH]), handlerCtx());
    const parserRows = (await s.repos.graph.loadGraph(pr.ctx)).nodes.filter((n) => n.origin === 'parser').length;
    reply = 'garbage';
    await expect(handler()(payload([SPEC_PATH]), handlerCtx())).rejects.toSatisfy((e: Error) => /^extract_failed: /.test(e.message) && e.message.includes(`${SPEC_PATH} (bad_reply)`) && e.name !== 'UnrecoverableError');
    expect(await claudeEdges()).toHaveLength(1);
    await expect(handler({ runClaude: async () => { throw new Error('exit 2'); } })(payload([SPEC_PATH]), handlerCtx())).rejects.toThrow(/^extract_failed: /);
    await expect(handler({ runClaude: async () => { throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }); } })(payload([SPEC_PATH]), handlerCtx())).rejects.toSatisfy(dropped('claude_not_found'));
    expect((await s.repos.graph.loadGraph(pr.ctx)).nodes.filter((n) => n.origin === 'parser')).toHaveLength(parserRows);
  });

  it('guards: not local, unknown project, missing root, file limit (D1, D15)', async () => {
    reply = '{"edges":[]}';
    await expect(handler({ config: { mode: 'shared' } })(payload([SPEC_PATH]), handlerCtx())).rejects.toSatisfy(dropped('extract_not_local'));
    await expect(handler()({ userId: 'user-b', projectId: pr.ctx.projectId, files: [SPEC_PATH] } as never, handlerCtx())).rejects.toSatisfy(dropped('extract_not_local'));
    await expect(handler()({ userId: 'local', projectId: 'nope', files: [SPEC_PATH] } as never, handlerCtx())).rejects.toSatisfy(dropped('project_not_found'));
    const gone = await s.repos.projects.upsert({ userId: 'local' }, { root: '/tmp/ctc-t23-gone-root' });
    await expect(handler()({ userId: 'local', projectId: gone.id, files: [SPEC_PATH] } as never, handlerCtx())).rejects.toSatisfy(dropped('root_missing'));
    contextWorkerLimits.maxExtractFiles = 1;
    const r = (await handler()(payload([SPEC_PATH, 'specs/empty.md']), handlerCtx())) as { files: { skipped: { file: string; reason: string }[] } };
    expect(r.files.skipped.filter((x) => x.reason === 'over_limit').map((x) => x.file)).toEqual(['specs/empty.md']);
  });

  it('keeps the handler maps and exports pinned (D16, D19)', () => {
    expect(Object.keys(graphHandlers({ repos: s.repos, config: cfg(), grammars: k.grammars }))).toEqual(['graph.rebuild']);
    expect(Object.keys(handler.call(null) && extractHandler({ repos: s.repos, config: { mode: 'local' }, runClaude: async () => '' }))).toEqual(['graph.extract']);
    expect(Object.keys(api).sort()).toEqual(['contextPass', 'contextWorkerLimits', 'extractHandler', 'linkCapability', 'spawnClaude', 'syncCapabilities', 'withCapabilityLinks', 'withContextPass']);
    expect({ ...contextWorkerLimits }).toEqual({ maxPayloadFiles: 1000, maxProjects: 50, maxSyncCaps: 500, maxExtractFiles: 10, maxExtractSubmit: 20, extractTimeoutMs: 120_000, extractMaxReplyChars: 200_000, resultListMax: 100 });
  });
});
