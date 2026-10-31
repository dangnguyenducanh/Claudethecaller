import fs from 'node:fs';
import { parseWorkflow } from '@ctc/core/runner';
import { workflowRoutes, type WorkflowApiDeps } from '../../../web/src/runs/index.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { git, harness, restoreLimits, rnd, scratch, useFastLimits, type Harness, type Scratch } from './harness.ts';

let s: Scratch;
const open: Harness[] = [];
beforeAll(async () => {
  useFastLimits();
  s = await scratch();
}, 60_000);
afterAll(async () => {
  restoreLimits();
  for (const h of open) await h.close();
  await s?.drop();
});
const mk = (cfg: Record<string, unknown> = {}): Harness => {
  const h = harness(s, cfg);
  open.push(h);
  return h;
};

const F = (over: string | number, prompt: string, extra = '') =>
  `name: fan\nnodes:\n  - {id: t, type: trigger}\n  - {id: F, type: fanout, over: ${JSON.stringify(over)}, child: {type: agent, agent: claude, prompt: ${JSON.stringify(prompt)}}}\n  - {id: J, type: join, strategy: merge}\n${extra}edges:\n  - {from: t, to: F}\n  - {from: F, to: J}\n`;

describe('runner.fanout', () => {
  it('runs 3 children in 3 worktrees and the join merges their branches', async () => {
    const h = mk();
    const { run, repo } = await h.mkRun(F(3, 'FAKE_WRITE=f{{item}}.txt:c{{item}} FAKE_SAY=child-{{item}}'));
    expect((await h.drive(run.id)).status).toBe('done');
    const steps = await h.stepsOf(run.id);
    const kids = steps.filter((x) => x.parentStepId !== null);
    expect(kids.map((k) => k.nodeId).sort()).toEqual(['F[0]', 'F[1]', 'F[2]']);
    expect(new Set(kids.map((k) => k.worktree)).size).toBe(3);
    expect(new Set(kids.map((k) => k.branch)).size).toBe(3);
    const join = steps.find((x) => x.nodeId === 'J');
    expect(join?.status).toBe('done');
    const tree = fs.readdirSync(join?.worktree as string);
    for (const f of ['f1.txt', 'f2.txt', 'f3.txt']) expect(tree).toContain(f);
    expect(git(join?.worktree as string, 'log', '--merges', '--format=%s').split('\n').filter(Boolean)).toHaveLength(3);
    for (const k of kids) expect(h.branches(repo)).toContain(k.branch);
  }, 60_000);

  it('refuses a fanout inside a fanout child', async () => {
    const nested = { name: 'n', nodes: [{ id: 't', type: 'trigger' }, { id: 'F', type: 'fanout', over: '2', child: { type: 'fanout', over: '2', child: { type: 'agent', agent: 'claude', prompt: 'p' } } }], edges: [{ from: 't', to: 'F' }] };
    const parsed = parseWorkflow(nested);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.errors).toContain('node F: fanout depth exceeded (max_depth 1)');
    const h = mk();
    const text = JSON.stringify(nested);
    const hash = `${rnd()}${rnd()}`;
    await s.repos.library.createVersion(h.ctx, {
      namespace: 'user', kind: 'workflow', name: 'nested', rootPath: '/nonexistent-t63/nested', description: 'd', frontmatter: { name: 'nested' }, bodyHash: hash,
      commitMessage: 'x', blobs: [{ hash, content: text, size: Buffer.byteLength(text) }], files: [{ path: 'nested.yaml', blobHash: hash }],
    });
    const cap = (await s.repos.library.listCapabilities(h.ctx, { kind: 'workflow' })).rows.find((c) => c.name === 'nested');
    const deps = {
      repos: s.repos, ctxOf: () => h.ctx, runsDir: h.runs,
      library: { repos: s.repos, config: { mode: 'local', claude_home: h.tmp, library: { roots: [], default_label: 'production' } }, submit: async () => ({ id: 'x' }) },
    } as unknown as WorkflowApiDeps;
    const route = workflowRoutes(deps).find((r) => r.url === '/api/workflows/:id/runs');
    let status = 0;
    let body: { error?: { errors?: string[] } } = {};
    await route?.handler({ params: { id: cap?.id }, body: { repo: h.mkRepo() } }, { code: (n: number) => ({ send: (b?: unknown) => ((status = n), (body = b as typeof body), undefined) }) });
    expect(status).toBe(422);
    expect(body.error?.errors).toContain('node F: fanout depth exceeded (max_depth 1)');
  });

  it('fails the join with the conflicting files and keeps the branches', async () => {
    const h = mk();
    const { run, repo } = await h.mkRun(F(3, 'FAKE_WRITE=same.txt:c{{item}}'));
    await h.drive(run.id, { stop: (_r, steps) => steps.some((x) => x.nodeId === 'J' && x.status === 'failed') && h.active.size === 0 });
    const steps = await h.stepsOf(run.id);
    const join = steps.find((x) => x.nodeId === 'J');
    expect(join?.error).toMatch(/^merge conflict: same\.txt \(branch ctc\//);
    for (const k of steps.filter((x) => x.parentStepId !== null)) expect(h.branches(repo)).toContain(k.branch);
    expect(git(join?.worktree as string, 'status', '--porcelain').trim()).toBe('');
  }, 60_000);

  it('never runs more children at once than max_parallel', async () => {
    const h = mk({ fanout: { max_depth: 1, max_parallel: 2 } });
    const { run } = await h.mkRun(F(4, 'FAKE_WRITE=g{{item}}.txt:c{{item}} FAKE_SLEEP=600'));
    expect((await h.drive(run.id)).status).toBe('done');
    const kids = (await h.stepsOf(run.id)).filter((x) => x.parentStepId !== null);
    const spans = h.snapshots().filter((x) => kids.some((k) => k.id === x.stepId)).map((x) => [x.start, x.end ?? x.start] as const);
    expect(spans).toHaveLength(4);
    const peak = Math.max(...spans.map(([a]) => spans.filter(([b, e]) => b <= a && e > a).length));
    expect(peak).toBe(2);
  }, 60_000);
});
