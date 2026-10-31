/**
 * One tenancy case per repository function (D12). `tenancy.test.ts` runs each case with user B's ctx (and with B's ctx plus A's `projectId`)
 * against A's ids and requires A's rows to stay byte-for-byte unchanged. A function with no case, or a case for a function that does not
 * exist, fails the test, so a later task cannot add a function without a tenancy case.
 *
 * Expectations: `zero` = null / 0 / false / empty; `no-a` = a result that contains nothing of A; `as-caller` = a creator that ignored a hostile
 * `userId` key and stored user B (the case returns `true`); `throws:<code>` = a `RepoError` with that code.
 */
import { randomUUID } from 'node:crypto';
import type { Ctx } from './ctx.ts';
import type { Repositories } from './index.ts';

export type Expect = 'zero' | 'no-a' | 'as-caller' | 'throws:not_found' | 'throws:conflict' | 'throws:invalid';
export type Seed = {
  userId: string; ctx: Ctx; projectId: string; root: string; sessionId: string; path: string; jobId: string; key: string; route: string;
  keyId: number; keyHash: string; pair: [string, string]; nodeId: string; otherNodeId: string; label: string; sourceFile: string;
  capId: string; capName: string; versionId: string; filePath: string; blobText: string; memoryId: string; memoryText: string;
  projectMemoryId: string; runId: number; stepId: number; owner: string; workflow: string; embedding: number[]; marks: string[];
};
export type Env = { r: Repositories; ctx: Ctx; a: Seed; b: Seed };
export type Case = { expect: Expect; project?: boolean; run: (env: Env) => Promise<unknown> };
export type Cases = Record<string, Record<string, Case | Case[]>>;

export const unit = (i: number): number[] => Array.from({ length: 1024 }, (_, j) => (j === i ? 1 : 0));
const pendingKey = (userId: string): string => `pending-${userId}`;
const hostile = { userId: 'user-a', user_id: 'user-a', ownerId: 'user-a' };

/** Writes at least one row into every table for `userId`, using this module's own write functions. */
export async function seed(r: Repositories, userId: string, vector: number): Promise<Seed> {
  const embedding = unit(vector);
  const root = `/seed/${userId}`;
  const project = await r.projects.upsert({ userId }, { root });
  const ctx: Ctx = { userId, projectId: project.id };
  const sessionId = `sess-${userId}`;
  await r.sessions.upsert(ctx, { id: sessionId, projectId: project.id, model: 'm', tokens: 5 });
  const path = `/h/${userId}.jsonl`;
  await r.history.upsert(ctx, { path, size: 1, mtime: 1, status: 'imported' });
  const { job } = await r.jobs.create(ctx, { queue: 'llm', kind: 'enrich', payload: { secret: `secret-${userId}` } });
  const key = `key-${userId}`;
  const route = 'POST /x';
  await r.idempotency.store(ctx, { key, route, payloadHash: 'h', response: { ok: userId } });
  await r.idempotency.store(ctx, { key: pendingKey(userId), route, payloadHash: 'h', response: { status: 0 } });
  const keyHash = `hash-${userId}`;
  const apiKey = await r.apiKeys.create(ctx, { name: `k-${userId}`, keyHash });
  const pair: [string, string] = [`x-${userId}`, `y-${userId}`];
  await r.dedup.upsertPair(ctx, { pair, similarity: 0.9 });
  const tag = userId.replace(/\W/g, '');
  const nodeId = `n1-${userId}`;
  const otherNodeId = `n2-${userId}`;
  const label = `needle${tag}`;
  const sourceFile = `f-${userId}.ts`;
  await r.graph.replaceSource(ctx, {
    origin: 'ast', sourceFile,
    nodes: [{ id: nodeId, kind: 'code', type: 'function', label }, { id: otherNodeId, kind: 'code', type: 'function', label: `other${tag}` }],
    edges: [{ src: nodeId, dst: otherNodeId, relation: 'calls', confidence: 'EXTRACTED' }],
    source: { contentHash: 'c', extractorVersion: '1' },
  });
  await r.graph.setEmbedding(ctx, nodeId, embedding, 'c');
  const capName = `skill-${userId}`;
  const filePath = 'SKILL.md';
  const blobText = `body-${userId}`;
  const { version } = await r.library.createVersion(ctx, {
    namespace: 'user', kind: 'skill', name: capName, rootPath: `/x/${capName}`, description: `desc-${userId}`, frontmatter: {}, bodyHash: `bh-${userId}`,
    commitMessage: 'm', blobs: [{ hash: `blob-${userId}`, content: blobText, size: blobText.length }], files: [{ path: filePath, blobHash: `blob-${userId}` }],
  });
  const capId = version.capId;
  await r.library.setServed(ctx, capId, 1);
  await r.library.upsertOverride(ctx, { capId, action: 'pin', version: 1 });
  await r.library.upsertVector(ctx, { capId, textHash: 't', embedding });
  const memoryText = `fact of ${userId}`;
  const memory = await r.memory.add(ctx, { scope: 'global', kind: 'fact', text: memoryText, embedding });
  const projectMemory = await r.memory.add(ctx, { scope: 'project', kind: 'fact', text: `project fact of ${userId}`, embedding });
  await r.memory.insertSummary(ctx, { sessionId, contentHash: `sum-${userId}`, request: `req-${userId}` });
  const owner = `owner-${userId}`;
  const run = await r.runner.createRun(ctx, { owner, trigger: 'api', workflowCapId: capId });
  const { step } = await r.runner.insertStep(ctx, { runId: run.id, nodeId: 'n', visit: 1, status: 'queued' });
  const workflow = `wf-${userId}`;
  await r.runner.upsertSchedule(ctx, { owner, workflow, cron: '* * * * *' });
  const seeded = {
    userId, ctx, projectId: project.id, root, sessionId, path, jobId: job.id, key, route, keyId: apiKey.id, keyHash, pair, nodeId, otherNodeId, label,
    sourceFile, capId, capName, versionId: version.id, filePath, blobText, memoryId: memory.id, memoryText, projectMemoryId: projectMemory.id,
    runId: run.id, stepId: step.id, owner, workflow, embedding,
  };
  const marks = [userId, project.id, root, sessionId, path, job.id, key, keyHash, ...pair, nodeId, otherNodeId, label, sourceFile, capId, capName, version.id, blobText, memory.id, memoryText, projectMemory.id, owner, workflow];
  return { ...seeded, marks };
}

const same = (x: { userId: string }, y: { userId: string }): boolean => x.userId === y.userId;

export const cases: Cases = {
  projects: {
    upsert: { expect: 'as-caller', run: async ({ r, ctx }) => (await r.projects.upsert(ctx, { root: '/new/b-root', ...hostile })).userId === ctx.userId },
    get: { expect: 'zero', run: ({ r, ctx, a }) => r.projects.get(ctx, a.projectId) },
    byRoot: { expect: 'zero', run: ({ r, ctx, a }) => r.projects.byRoot(ctx, a.root) },
    list: { expect: 'no-a', run: ({ r, ctx }) => r.projects.list(ctx, { limit: 500 }) },
    epochs: { expect: 'zero', run: ({ r, ctx, a }) => r.projects.epochs(ctx, a.projectId) },
    bumpEpoch: { expect: 'zero', run: ({ r, ctx, a }) => r.projects.bumpEpoch(ctx, a.projectId, 'graph') },
  },
  sessions: {
    upsert: [
      { expect: 'throws:not_found', run: ({ r, ctx, a }) => r.sessions.upsert(ctx, { id: a.sessionId, projectId: a.projectId, tokens: 99 }) },
      { expect: 'throws:conflict', run: ({ r, ctx, a, b }) => r.sessions.upsert({ userId: ctx.userId }, { id: a.sessionId, projectId: b.projectId, tokens: 99 }) },
      { expect: 'as-caller', run: async ({ r, ctx, b }) => (await r.sessions.upsert({ userId: ctx.userId }, { id: 'sess-new-b', projectId: b.projectId, ...hostile })).userId === ctx.userId },
    ],
    get: { expect: 'zero', run: ({ r, ctx, a }) => r.sessions.get(ctx, a.sessionId) },
    list: [
      { expect: 'no-a', run: ({ r, ctx }) => r.sessions.list(ctx, {}) },
      { expect: 'zero', run: ({ r, ctx, a }) => r.sessions.list(ctx, { projectId: a.projectId }) },
    ],
  },
  history: {
    upsert: { expect: 'as-caller', run: async ({ r, ctx }) => (await r.history.upsert(ctx, { path: '/new/b.jsonl', size: 1, mtime: 1, status: 'imported', ...hostile })).userId === ctx.userId },
    listByStatus: { expect: 'no-a', run: ({ r, ctx }) => r.history.listByStatus(ctx, { status: 'imported' }) },
    byPaths: { expect: 'no-a', run: ({ r, ctx, a }) => r.history.byPaths(ctx, [a.path]) },
    setStatus: { expect: 'zero', run: ({ r, ctx, a }) => r.history.setStatus(ctx, a.path, 'failed') },
  },
  jobs: {
    create: [
      { expect: 'throws:conflict', run: ({ r, ctx, a }) => r.jobs.create(ctx, { id: a.jobId, queue: 'llm', kind: 'enrich', payload: {} }) },
      { expect: 'as-caller', run: async ({ r, ctx }) => (await r.jobs.create(ctx, { id: 'job-new-b', queue: 'llm', kind: 'enrich', payload: {}, ...hostile })).job.userId === ctx.userId },
    ],
    get: { expect: 'zero', run: ({ r, ctx, a }) => r.jobs.get(ctx, a.jobId) },
    list: { expect: 'no-a', run: ({ r, ctx }) => r.jobs.list(ctx, {}) },
    oldestQueuedAgeS: { expect: 'zero', run: ({ r, ctx }) => r.jobs.oldestQueuedAgeS(ctx) },
    cancel: { expect: 'zero', run: ({ r, ctx, a }) => r.jobs.cancel(ctx, a.jobId) },
  },
  idempotency: {
    lookup: { expect: 'zero', run: ({ r, ctx, a }) => r.idempotency.lookup(ctx, { key: a.key, route: a.route }) },
    store: { expect: 'as-caller', run: async ({ r, ctx, a }) => {
      await r.idempotency.store(ctx, { key: 'key-new-b', route: 'POST /x', payloadHash: 'h', response: {}, ...hostile });
      return (await r.idempotency.lookup(ctx, { key: 'key-new-b', route: 'POST /x' })) !== null && (await r.idempotency.lookup(a.ctx, { key: 'key-new-b', route: 'POST /x' })) === null;
    } },
    settle: { expect: 'zero', run: ({ r, ctx, a }) => r.idempotency.settle(ctx, { key: pendingKey(a.ctx.userId), route: a.route, response: { status: 200, body: 'b' } }) },
    release: { expect: 'zero', run: ({ r, ctx, a }) => r.idempotency.release(ctx, { key: pendingKey(a.ctx.userId), route: a.route }) },
  },
  apiKeys: {
    create: { expect: 'as-caller', run: async ({ r, ctx }) => {
      const k = await r.apiKeys.create(ctx, { name: 'new', keyHash: `hash-new-b-${randomUUID()}`, ...hostile });
      return (await r.apiKeys.list(ctx)).some((x) => x.id === k.id);
    } },
    list: { expect: 'no-a', run: ({ r, ctx }) => r.apiKeys.list(ctx) },
    revoke: { expect: 'zero', run: ({ r, ctx, a }) => r.apiKeys.revoke(ctx, a.keyId) },
  },
  dedup: {
    upsertPair: { expect: 'as-caller', run: async ({ r, ctx }) => (await r.dedup.upsertPair(ctx, { pair: ['nb-1', 'nb-2'], similarity: 0.5, ...hostile })).userId === ctx.userId },
    listOpen: { expect: 'no-a', run: ({ r, ctx }) => r.dedup.listOpen(ctx, {}) },
    setStatus: { expect: 'zero', run: ({ r, ctx, a }) => r.dedup.setStatus(ctx, a.pair, 'merged') },
  },
  graph: {
    replaceSource: { expect: 'as-caller', project: true, run: async ({ r, ctx, a }) => {
      await r.graph.replaceSource(ctx, {
        origin: 'ast', sourceFile: 'f-new-b.ts', nodes: [{ id: 'nb-1', kind: 'code', type: 'function', label: 'nb' }], edges: [],
        source: { contentHash: 'c', extractorVersion: '1' }, ...hostile,
      });
      return (await r.graph.getNode(ctx, 'nb-1')) !== null && (await r.graph.getNode(a.ctx, 'nb-1')) === null;
    } },
    deleteSource: { expect: 'zero', project: true, run: ({ r, ctx, a }) => r.graph.deleteSource(ctx, { origin: 'ast', sourceFile: a.sourceFile }) },
    pendingEmbeddings: { expect: 'zero', project: true, run: ({ r, ctx }) => r.graph.pendingEmbeddings(ctx, {}) },
    sourceNodeCount: { expect: 'zero', project: true, run: ({ r, ctx, a }) => r.graph.sourceNodeCount(ctx, a.sourceFile) },
    listSources: { expect: 'zero', project: true, run: ({ r, ctx }) => r.graph.listSources(ctx) },
    loadGraph: { expect: 'zero', project: true, run: ({ r, ctx }) => r.graph.loadGraph(ctx) },
    loadVectors: { expect: 'zero', project: true, run: ({ r, ctx }) => r.graph.loadVectors(ctx) },
    getNode: { expect: 'zero', project: true, run: ({ r, ctx, a }) => r.graph.getNode(ctx, a.nodeId) },
    edgesOf: { expect: 'zero', project: true, run: ({ r, ctx, a }) => r.graph.edgesOf(ctx, a.nodeId) },
    searchLabels: { expect: 'zero', project: true, run: ({ r, ctx, a }) => r.graph.searchLabels(ctx, { query: a.label }) },
    setEmbedding: { expect: 'zero', project: true, run: ({ r, ctx, a }) => r.graph.setEmbedding(ctx, a.nodeId, a.embedding, 'x') },
    reviewEdge: { expect: 'zero', project: true, run: ({ r, ctx, a }) => r.graph.reviewEdge(ctx, { src: a.nodeId, dst: a.otherNodeId, relation: 'calls', confidence: 'DROPPED' }) },
    stats: { expect: 'zero', project: true, run: ({ r, ctx }) => r.graph.stats(ctx) },
  },
  library: {
    listCapabilities: { expect: 'no-a', run: ({ r, ctx }) => r.library.listCapabilities(ctx, { limit: 500 }) },
    get: { expect: 'zero', run: ({ r, ctx, a }) => r.library.get(ctx, a.capId) },
    byName: { expect: 'zero', run: ({ r, ctx, a }) => r.library.byName(ctx, { namespace: 'user', kind: 'skill', name: a.capName }) },
    listByName: { expect: 'zero', run: ({ r, ctx, a }) => r.library.listByName(ctx, a.capName) },
    createVersion: { expect: 'as-caller', run: async ({ r, ctx, a }) => {
      const { version } = await r.library.createVersion(ctx, {
        namespace: 'user', kind: 'skill', name: 'skill-new-b', rootPath: '/x', description: 'd', bodyHash: 'h', commitMessage: 'm', ...hostile,
        blobs: [{ hash: 'blob-new-b', content: 'x', size: 1 }], files: [{ path: 'SKILL.md', blobHash: 'blob-new-b' }],
      });
      return (await r.library.getVersionById(ctx, version.id)) !== null && (await r.library.getVersionById(a.ctx, version.id)) === null;
    } },
    listVersions: { expect: 'zero', run: ({ r, ctx, a }) => r.library.listVersions(ctx, a.capId) },
    getVersion: { expect: 'zero', run: ({ r, ctx, a }) => r.library.getVersion(ctx, a.capId, 1) },
    getVersionById: { expect: 'zero', run: ({ r, ctx, a }) => r.library.getVersionById(ctx, a.versionId) },
    manifest: { expect: 'zero', run: ({ r, ctx, a }) => r.library.manifest(ctx, a.versionId) },
    getBlob: { expect: 'zero', run: ({ r, ctx, a }) => r.library.getBlob(ctx, a.versionId, a.filePath) },
    moveLabels: { expect: 'zero', run: ({ r, ctx, a }) => r.library.moveLabels(ctx, { capId: a.capId, version: 1, labels: ['staging'] }) },
    setServed: { expect: 'zero', run: ({ r, ctx, a }) => r.library.setServed(ctx, a.capId, 1) },
    markRemoved: { expect: 'zero', run: ({ r, ctx, a }) => r.library.markRemoved(ctx, a.capId) },
    upsertOverride: { expect: 'throws:not_found', run: ({ r, ctx, a }) => r.library.upsertOverride(ctx, { capId: a.capId, action: 'block' }) },
    clearOverride: { expect: 'zero', run: ({ r, ctx, a }) => r.library.clearOverride(ctx, a.capId) },
    listOverrides: { expect: 'no-a', run: ({ r, ctx }) => r.library.listOverrides(ctx) },
    upsertVector: { expect: 'zero', run: ({ r, ctx, a }) => r.library.upsertVector(ctx, { capId: a.capId, textHash: 'z', embedding: a.embedding }) },
    pruneVectors: { expect: 'zero', run: ({ r, ctx, a }) => r.library.pruneVectors(ctx, a.capId, 'keep-nothing-of-a') },
    loadVectors: { expect: 'no-a', run: ({ r, ctx }) => r.library.loadVectors(ctx) },
    loadSkillIndex: { expect: 'no-a', run: ({ r, ctx }) => r.library.loadSkillIndex(ctx) },
  },
  memory: {
    nearest: { expect: 'no-a', run: ({ r, ctx, a }) => r.memory.nearest(ctx, { scope: 'global', embedding: a.embedding, limit: 50 }) },
    add: { expect: 'as-caller', run: async ({ r, ctx, b }) => (await r.memory.add(ctx, { scope: 'global', kind: 'fact', text: 'new fact of b', embedding: b.embedding, ...hostile })).userId === ctx.userId },
    reinforce: { expect: 'zero', run: ({ r, ctx, a }) => r.memory.reinforce(ctx, a.memoryId, '2026-02-02') },
    rewrite: { expect: 'zero', run: ({ r, ctx, a }) => r.memory.rewrite(ctx, a.memoryId, { text: 'hijack', embedding: a.embedding, hash: 'hijack' }) },
    supersede: { expect: 'zero', run: ({ r, ctx, a }) => r.memory.supersede(ctx, a.memoryId, { scope: 'global', kind: 'fact', text: 'hijack', embedding: a.embedding }) },
    get: { expect: 'zero', run: ({ r, ctx, a }) => r.memory.get(ctx, a.memoryId) },
    getMany: { expect: 'zero', run: ({ r, ctx, a }) => r.memory.getMany(ctx, [a.memoryId, a.projectMemoryId]) },
    list: { expect: 'no-a', run: ({ r, ctx }) => r.memory.list(ctx, { limit: 500 }) },
    patch: { expect: 'zero', run: ({ r, ctx, a }) => r.memory.patch(ctx, a.memoryId, { pinned: true, text: 'hijack' }) },
    softDelete: { expect: 'zero', run: ({ r, ctx, a }) => r.memory.softDelete(ctx, a.memoryId) },
    recallLegs: { expect: 'no-a', run: ({ r, ctx, a }) => r.memory.recallLegs(ctx, { queryText: a.memoryText, queryVector: a.embedding, perLeg: 100 }) },
    timeline: { expect: 'zero', run: ({ r, ctx, a }) => r.memory.timeline(ctx, { anchorId: a.memoryId, before: 10, after: 10 }) },
    touch: { expect: 'zero', run: ({ r, ctx, a }) => r.memory.touch(ctx, [a.memoryId]) },
    insertSummary: { expect: 'zero', run: ({ r, ctx, a }) => r.memory.insertSummary(ctx, { sessionId: a.sessionId, contentHash: 'hijack' }) },
    lastSummaries: { expect: 'zero', project: true, run: ({ r, ctx }) => r.memory.lastSummaries(ctx, 10) },
    getSummary: { expect: 'zero', run: ({ r, ctx, a }) => r.memory.getSummary(ctx, a.sessionId) },
  },
  runner: {
    createRun: [
      { expect: 'throws:not_found', run: ({ r, ctx, a }) => r.runner.createRun(ctx, { owner: 'o-new-b', trigger: 'api', workflowCapId: a.capId }) },
      { expect: 'as-caller', run: async ({ r, ctx }) => (await r.runner.createRun(ctx, { owner: 'o-new-b', trigger: 'api', ...hostile })).userId === ctx.userId },
    ],
    getRun: { expect: 'zero', run: ({ r, ctx, a }) => r.runner.getRun(ctx, a.runId) },
    listRuns: { expect: 'no-a', run: ({ r, ctx }) => r.runner.listRuns(ctx, { limit: 500 }) },
    setRunStatus: { expect: 'throws:not_found', run: ({ r, ctx, a }) => r.runner.setRunStatus(ctx, a.runId, { from: 'queued', to: 'running' }) },
    insertStep: { expect: 'throws:not_found', run: ({ r, ctx, a }) => r.runner.insertStep(ctx, { runId: a.runId, nodeId: 'x', visit: 1, status: 'queued' }) },
    getStep: { expect: 'zero', run: ({ r, ctx, a }) => r.runner.getStep(ctx, a.stepId) },
    listSteps: { expect: 'zero', run: ({ r, ctx, a }) => r.runner.listSteps(ctx, a.runId) },
    transition: { expect: 'throws:not_found', run: ({ r, ctx, a }) => r.runner.transition(ctx, { stepId: a.stepId, from: 'queued', to: 'running' }) },
    setStepFields: { expect: 'zero', run: ({ r, ctx, a }) => r.runner.setStepFields(ctx, a.stepId, { branch: 'hijack', status: 'done' }) },
    listSchedules: { expect: 'no-a', run: ({ r, ctx }) => r.runner.listSchedules(ctx) },
    upsertSchedule: { expect: 'as-caller', run: async ({ r, ctx }) => same(await r.runner.upsertSchedule(ctx, { owner: 'o-new-b', workflow: 'wf-new-b', cron: '* * * * *', ...hostile }), ctx) },
    deleteSchedule: { expect: 'zero', run: ({ r, ctx, a }) => r.runner.deleteSchedule(ctx, { owner: a.owner, workflow: a.workflow }) },
  },
};

export default cases;
