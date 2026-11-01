import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { harness, restoreLimits, scratch, useFastLimits, type Harness, type Scratch } from '../../../worker/src/runner/harness.ts';
import { advanceRun } from '../../../worker/src/runner/index.ts';
import type { Ctx } from '@ctc/shared/repositories';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Route } from '../library/http.ts';
import { handoffLimits, startLimits, startRun, stepTimeoutS, workflowRoutes, workflowTools, type WorkflowApiDeps } from './index.ts';

let s: Scratch;
let h: Harness;
const rnd = (): string => randomBytes(4).toString('hex');
const T = { id: 't', type: 'trigger' };
const sh = (id: string, run: string) => ({ id, type: 'shell', run, cwd: 'repo' });
const wf = (nodes: object[]) => ({ name: 'wf', nodes: [T, ...nodes], edges: nodes.slice(0, 1).map((n) => ({ from: 't', to: (n as { id: string }).id })) });

beforeAll(async () => {
  useFastLimits();
  s = await scratch();
  h = harness(s);
}, 60_000);
afterAll(async () => {
  restoreLimits();
  await h?.close();
  await s?.drop();
});

async function mkCap(ctx: Ctx, name: string, doc: unknown, kind = 'workflow') {
  const text = typeof doc === 'string' ? doc : JSON.stringify(doc);
  const hash = `${rnd()}${rnd()}${name}`;
  await s.repos.library.createVersion(ctx, {
    namespace: 'user', kind, name, rootPath: `/nonexistent-t63/${name}`, description: `d ${name}`, frontmatter: { name }, bodyHash: hash, commitMessage: 'x',
    blobs: [{ hash, content: text, size: Buffer.byteLength(text) }], files: [{ path: `${name}.yaml`, blobHash: hash }],
  });
  return (await s.repos.library.listCapabilities(ctx, { kind })).rows.find((c) => c.name === name)!;
}
const depsOf = (over: Partial<WorkflowApiDeps> = {}): WorkflowApiDeps => ({
  repos: s.repos, ctxOf: (req) => (req as { who?: Ctx }).who ?? h.ctx, runsDir: h.runs, ownerOf: () => `o-${rnd()}`, enqueueResume: async () => undefined,
  library: { repos: s.repos, config: { mode: 'local', claude_home: h.tmp, library: { roots: [], default_label: 'production' } }, submit: async () => ({ id: 'x' }) },
  advance: async (ctx, id) => void (await advanceRun(h.deps, ctx, id)), ...over,
});
async function call(routes: Route[], method: string, url: string, o: { params?: object; body?: unknown; headers?: Record<string, string>; query?: object; who?: Ctx } = {}) {
  const route = routes.find((r) => r.method === method && r.url === url);
  if (route === undefined) throw new Error(`no route ${method} ${url}`);
  let status = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  await route.handler({ params: o.params, body: o.body, headers: o.headers ?? {}, query: o.query, who: o.who } as never, { code: (n: number) => ((status = n), { send: (b?: unknown) => ((body = b), undefined) }) });
  return { status, body };
}

describe('workflow routes (D3, D4, D19, D23)', () => {
  it('starts a run on the pinned version, replays a repeated key, and allows one running run per owner', async () => {
    const owner = `o-${rnd()}`;
    const routes = workflowRoutes(depsOf({ ownerOf: () => owner }));
    const name = `wf-${rnd()}`;
    const v1 = await mkCap(h.ctx, name, wf([sh('a', 'echo v1')]));
    const repo = h.mkRepo();
    const url = '/api/workflows/:id/runs';
    const headers = { 'idempotency-key': `k-${rnd()}` };
    const first = await call(routes, 'POST', url, { params: { id: v1.id }, body: { inputs: { topic: 'x' }, repo, base: 'main' }, headers });
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ status: 'running' });
    const row = await s.repos.runner.getRun(h.ctx, first.body.run_id);
    expect(row).toMatchObject({ workflowCapId: v1.id, repo, baseBranch: 'main', trigger: 'api', owner });
    expect(await call(routes, 'POST', url, { params: { id: v1.id }, body: { inputs: { topic: 'x' }, repo, base: 'main' }, headers })).toEqual(first);
    expect((await call(routes, 'POST', url, { params: { id: v1.id }, body: { repo } })).status).toBe(409);
    await mkCap(h.ctx, name, wf([sh('a', 'echo v2')]));
    const fin = await h.drive(row!.id);
    expect(fin.status).toBe('done');
    expect(JSON.stringify((await h.stepsOf(row!.id))[0]?.output)).toContain('v1');
  });

  it('a queued-again step gets the timeout_s of its node, not a fixed default', async () => {
    const cap = await mkCap(h.ctx, `to-${rnd()}`, wf([{ id: 'a', type: 'agent', agent: 'claude', prompt: 'x', timeout_s: 7200 }, ...[]]));
    const { run } = await startRun(depsOf(), h.ctx, { cap, repo: h.mkRepo(), trigger: 'api' });
    expect(await stepTimeoutS(depsOf(), h.ctx, { runId: run.id, nodeId: 'a' })).toBe(7200);
    expect(await stepTimeoutS(depsOf(), h.ctx, { runId: run.id, nodeId: 'missing' })).toBe(1800);
  });
  it('refuses a run without a repo when an agent node needs a worktree, and accepts it for shell-only workflows', async () => {
    const routes = workflowRoutes(depsOf());
    const post = (id: string) => call(routes, 'POST', '/api/workflows/:id/runs', { params: { id }, body: {} });
    const agent = await mkCap(h.ctx, `ag-${rnd()}`, wf([{ id: 'a', type: 'agent', agent: 'claude', prompt: 'x', worktree: 'new' }]));
    const r = await post(agent.id);
    expect([r.status, r.body.error.code]).toEqual([422, 'invalid']);
    expect((await post((await mkCap(h.ctx, `sh-${rnd()}`, wf([sh('a', 'true')]))).id)).status).toBe(202);
  });
  it('answers 422 for bad arguments, 404 for a foreign or wrong-kind capability and lists runs with a page size', async () => {
    const routes = workflowRoutes(depsOf());
    const cap = await mkCap(h.ctx, `wf-${rnd()}`, wf([sh('a', 'true')]));
    const repo = h.mkRepo();
    const post = (id: string, body: unknown, who?: Ctx) => call(routes, 'POST', '/api/workflows/:id/runs', { params: { id }, body, ...(who === undefined ? {} : { who }) });
    for (const body of [{ repo: '../x' }, { repo: 'relative/dir' }, { repo: `/a/${'b'.repeat(startLimits.repoMax + 1)}` }, { repo: '/a\u0000b' }, { repo, base: '-x' }, { repo, base: 'a..b' }, { repo, inputs: 'no' }, { repo, extra: 1 }]) {
      const r = await post(cap.id, body);
      expect([r.status, r.body.error.code]).toEqual([422, 'invalid']);
    }
    expect((await post('not-a-uuid', { repo })).status).toBe(404);
    expect((await post(cap.id, { repo }, { userId: 'someone-else' })).status).toBe(404);
    expect((await post((await mkCap(h.ctx, `sk-${rnd()}`, 'text', 'skill')).id, { repo })).status).toBe(404);
    const broken = await mkCap(h.ctx, `br-${rnd()}`, { name: 'br', nodes: 'nope', edges: [] });
    const r = await post(broken.id, { repo });
    expect(r.status).toBe(422);
    expect(r.body.error.errors.length).toBeGreaterThan(0);
    const list = await call(routes, 'GET', '/api/runs', { query: { limit: '1' } });
    expect([list.status, list.body.runs.length]).toEqual([200, 1]);
    expect((await call(routes, 'GET', '/api/runs', { query: { limit: '9999' } })).status).toBe(422);
    const one = await call(routes, 'GET', '/api/workflows/:id', { params: { id: broken.id } });
    expect([one.status, one.body.workflow]).toEqual([200, null]);
  });

  it('approves a gate with the options of the step and replays the stored reply for the same key', async () => {
    const routes = workflowRoutes(depsOf());
    const { run } = await h.mkRun(wf([{ id: 'gate', type: 'approval', question: 'ok?' }]));
    await h.drive(run.id, { stop: (r) => r.status === 'waiting' });
    const gate = (await h.stepsOf(run.id)).find((x) => x.nodeId === 'gate')!;
    const params = { rid: String(run.id) };
    const url = '/api/runs/:rid/approve';
    const bogus = await call(routes, 'POST', url, { params, body: { step_id: gate.id, option_id: 'nope' } });
    expect([bogus.status, bogus.body.error.path]).toEqual([422, ['body', 'option_id']]);
    expect((await call(routes, 'POST', url, { params, body: { step_id: gate.id, option_id: 'approve' }, who: { userId: 'someone-else' } })).status).toBe(404);
    const headers = { 'idempotency-key': `k-${rnd()}` };
    const a1 = await call(routes, 'POST', url, { params, body: { step_id: gate.id, option_id: 'approve' }, headers });
    expect(a1.status).toBe(200);
    expect(a1.body).toMatchObject({ applied: true, step: { resolution: 'approve', status: 'done' } });
    expect(a1.body.step).not.toHaveProperty('tokenHash');
    expect(await call(routes, 'POST', url, { params, body: { step_id: gate.id, option_id: 'approve' }, headers })).toEqual(a1);
    expect((await call(routes, 'POST', url, { params, body: { step_id: gate.id, option_id: 'approve' } })).body.applied).toBe(false);
    expect((await call(routes, 'POST', url, { params, body: { step_id: gate.id, option_id: 'reject' } })).status).toBe(409);
  });

  it('streams the plain log, then the gunzipped one, and refuses a path outside runsDir', async () => {
    const routes = workflowRoutes(depsOf());
    const { run } = await h.mkRun(wf([sh('a', 'echo log-line-1')]));
    await h.drive(run.id);
    const step = (await h.stepsOf(run.id))[0]!;
    const url = '/api/runs/:rid/steps/:sid/log';
    const params = { rid: String(run.id), sid: String(step.id) };
    const read = async (stream: AsyncIterable<Buffer>) => {
      const parts: Buffer[] = [];
      for await (const c of stream) parts.push(Buffer.from(c));
      return Buffer.concat(parts).toString();
    };
    expect(await read((await call(routes, 'GET', url, { params })).body)).toContain('log-line-1');
    fs.writeFileSync(`${step.logPath}.gz`, zlib.gzipSync(fs.readFileSync(step.logPath!)));
    fs.rmSync(step.logPath!);
    expect(await read((await call(routes, 'GET', url, { params })).body)).toContain('log-line-1');
    await s.repos.runner.setStepFields(h.ctx, step.id, { logPath: '/etc/hostname' });
    expect((await call(routes, 'GET', url, { params })).status).toBe(404);
  });
});

describe('workflow tools (D21)', () => {
  it('run_workflow returns null for a workflow without an agent step; workflow_status lists the steps; failures are isError', async () => {
    const tools = Object.fromEntries(workflowTools(depsOf()).map((t) => [t.name, t]));
    const keep = { ...handoffLimits };
    handoffLimits.waitMs = 700;
    try {
      const cap = await mkCap(h.ctx, `ho-${rnd()}`, wf([sh('a', 'echo hi')]));
      const res = await tools['run_workflow']!.call(h.ctx, { name: cap.name, repo: h.mkRepo() });
      const body = JSON.parse(res.content[0].text);
      expect(Object.keys(body).sort()).toEqual(['prompt_outcome', 'run_id', 'status']);
      expect(body.prompt_outcome).toBeNull();
      const st = JSON.parse((await tools['workflow_status']!.call(h.ctx, { run_id: body.run_id })).content[0].text);
      expect(st.run_id).toBe(body.run_id);
      expect(Object.keys(st.steps[0]).sort()).toEqual(['attempt', 'id', 'node_id', 'prompt_outcome', 'resolution', 'stage', 'status', 'visit']);
      expect((await tools['workflow_status']!.call({ userId: 'someone-else' }, { run_id: body.run_id })).isError).toBe(true);
      expect((await tools['workflow_status']!.call(h.ctx, { run_id: 'x' })).isError).toBe(true);
      const miss = await tools['run_workflow']!.call(h.ctx, { name: 'no-such-workflow-xyz' });
      expect([miss.isError, JSON.parse(miss.content[0].text).error.code]).toEqual([true, 'not_found']);
      expect((await tools['run_workflow']!.call(h.ctx, { name: cap.name, extra: 1 })).isError).toBe(true);
    } finally {
      Object.assign(handoffLimits, keep);
    }
  }, 30_000);
});
