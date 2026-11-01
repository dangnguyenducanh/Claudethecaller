import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSystemCtx } from './ctx.ts';
import { limits } from './index.ts';
import { memoryHash } from '../memory-hash/index.ts';
import { exec, scratch, type Scratch } from './scratch.ts';
import type { MemoryInput } from './memory.ts';

let s: Scratch;
const A = { userId: 'user-a' };
const B = { userId: 'user-b' };
let AP: { userId: string; projectId: string };
const sctx = createSystemCtx('memory-runner int test');
const unit = (i: number): number[] => Array.from({ length: 1024 }, (_, j) => (j === i ? 1 : 0));
const caught = async (p: Promise<unknown>): Promise<{ name: string; code?: string; message: string }> => {
  try {
    await p;
  } catch (error) {
    const e = error as { name: string; code?: string; message: string };
    return { name: e.name, ...(e.code ? { code: e.code } : {}), message: e.message };
  }
  throw new Error('did not reject');
};
const keep = { ...limits };
const mem = (text: string, i = 0, more: Partial<MemoryInput> = {}): MemoryInput => ({ scope: 'global', kind: 'fact', text, embedding: unit(i), ...more });
const today = (): Promise<string> => exec(s.url, 'select current_date::text as d').then((r) => (r.rows[0] as { d: string }).d);

beforeAll(async () => {
  s = await scratch();
  AP = { userId: 'user-a', projectId: (await s.repos.projects.upsert(A, { root: '/mr/a' })).id };
}, 60_000);
afterAll(async () => {
  await s?.drop();
});
afterEach(() => Object.assign(limits, keep));

describe('D14 memory', () => {
  it('add computes the normalised hash; the same text again reinforces once per day instead of inserting', async () => {
    const first = await s.repos.memory.add(A, mem('Prefer   TABS over spaces'));
    expect([first.hash, first.reinforcementDates]).toEqual([memoryHash('prefer tabs over spaces'), []]);
    const again = await s.repos.memory.add(A, mem('prefer tabs over spaces'));
    expect(again.id).toBe(first.id);
    expect(again.reinforcementDates).toEqual([await today()]);
    expect((await s.repos.memory.add(A, mem('PREFER tabs over spaces'))).reinforcementDates).toEqual([await today()]);
    expect(JSON.stringify(first)).not.toContain('embedding');
  });
  it('the same text in another scope or for another user is a different memory', async () => {
    const g = await s.repos.memory.add(A, mem('shared words'));
    const p = await s.repos.memory.add(AP, mem('shared words', 0, { scope: 'project' }));
    const other = await s.repos.memory.add(B, mem('shared words'));
    expect(new Set([g.id, p.id, other.id]).size).toBe(3);
    expect([g.projectId, p.projectId, other.userId]).toEqual([null, AP.projectId, 'user-b']);
  });
  it('D4 scope project needs ctx.projectId that is the user\'s; bad scope, kind and text are invalid', async () => {
    expect(await caught(s.repos.memory.add(A, mem('x', 0, { scope: 'project' })))).toEqual({ name: 'TypeError', message: 'ctx.projectId required' });
    expect(await caught(s.repos.memory.add({ userId: 'user-a', projectId: 'not-mine' }, mem('x', 0, { scope: 'project' })))).toEqual({ name: 'RepoError', code: 'not_found', message: 'project not found' });
    expect((await caught(s.repos.memory.add(A, mem('x', 0, { scope: 'both' as never })))).code).toBe('invalid');
    expect((await caught(s.repos.memory.add(A, mem('x', 0, { kind: 'rumour' })))).code).toBe('invalid');
    expect((await caught(s.repos.memory.add(A, mem('   ')))).code).toBe('invalid');
    expect((await caught(s.repos.memory.add(A, { ...mem('x'), embedding: [1, 2] }))).code).toBe('invalid');
  });
  it('reinforce appends a date only once and counts changed rows', async () => {
    const m = await s.repos.memory.add(A, mem('reinforce me', 5));
    expect(await s.repos.memory.reinforce(A, m.id, '2026-03-04')).toBe(1);
    expect(await s.repos.memory.reinforce(A, m.id, '2026-03-04')).toBe(0);
    expect((await s.repos.memory.get(A, m.id))?.reinforcementDates).toEqual(['2026-03-04']);
    expect(await s.repos.memory.reinforce(A, 'not-a-uuid', '2026-03-04')).toBe(0);
  });
  it('nearest returns live rows of the scope by cosine similarity, best first; project scope uses ctx.projectId', async () => {
    const near = await s.repos.memory.add(A, mem('near fact', 40));
    await s.repos.memory.add(A, mem('far fact', 41));
    const gone = await s.repos.memory.add(A, mem('deleted fact', 40));
    await s.repos.memory.softDelete(A, gone.id);
    const got = await s.repos.memory.nearest(A, { scope: 'global', embedding: unit(40), limit: 5 });
    expect(got[0]?.memory.id).toBe(near.id);
    expect(got[0]?.similarity).toBeCloseTo(1, 5);
    expect(got.map((g) => g.memory.id)).not.toContain(gone.id);
    expect(got.every((g, i) => i === 0 || (got[i - 1] as { similarity: number }).similarity >= g.similarity)).toBe(true);
    expect(await s.repos.memory.nearest(A, { scope: 'global', embedding: unit(40), limit: 1 })).toHaveLength(1);
    expect(await caught(s.repos.memory.nearest(A, { scope: 'project', embedding: unit(40), limit: 5 }))).toEqual({ name: 'TypeError', message: 'ctx.projectId required' });
    const proj = await s.repos.memory.add(AP, mem('project only fact', 40, { scope: 'project' }));
    const inProject = await s.repos.memory.nearest(AP, { scope: 'project', embedding: unit(40), limit: 5 });
    expect(inProject[0]?.memory.id).toBe(proj.id);
    expect(inProject.every((g) => g.memory.scope === 'project' && g.memory.projectId === AP.projectId)).toBe(true);
  });
  it('rewrite keeps the id and replaces text, hash and embedding; a taken hash is a ConflictError', async () => {
    const m = await s.repos.memory.add(A, mem('old words', 7));
    const taken = await s.repos.memory.add(A, mem('taken words', 8));
    const re = await s.repos.memory.rewrite(A, m.id, { text: 'new words', embedding: unit(9), hash: 'h-new' });
    expect([re?.id, re?.text, re?.hash]).toEqual([m.id, 'new words', 'h-new']);
    expect((await s.repos.memory.nearest(A, { scope: 'global', embedding: unit(9), limit: 1 }))[0]?.memory.id).toBe(m.id);
    expect(await caught(s.repos.memory.rewrite(A, m.id, { text: 't', embedding: unit(9), hash: taken.hash }))).toEqual({ name: 'ConflictError', code: 'conflict', message: 'memory already exists' });
    expect(await s.repos.memory.rewrite(A, 'nope', { text: 't', embedding: unit(9), hash: 'x' })).toBeNull();
  });
  it('supersede inserts the new row and links the old one in one transaction; the old row is no longer live', async () => {
    const old = await s.repos.memory.add(A, mem('version one', 10));
    const next = await s.repos.memory.supersede(A, old.id, mem('version two', 10));
    expect(next?.text).toBe('version two');
    expect((await s.repos.memory.get(A, old.id))?.supersededBy).toBe(next?.id);
    const live = (await s.repos.memory.nearest(A, { scope: 'global', embedding: unit(10), limit: 50 })).map((g) => g.memory.id);
    expect([live[0], live.includes(old.id)]).toEqual([next?.id, false]);
    expect(await s.repos.memory.supersede(A, old.id, mem('version three', 10))).toBeNull();
    expect((await s.repos.memory.list(A, { q: 'version three' })).rows).toEqual([]);
  });
  it('supersede with an invalid new memory leaves the old row live (rollback)', async () => {
    const old = await s.repos.memory.add(A, mem('stays live', 11));
    await expect(s.repos.memory.supersede(A, old.id, mem('   ', 11))).rejects.toBeTruthy();
    expect((await s.repos.memory.get(A, old.id))?.supersededBy).toBeNull();
  });
  it('getMany: equal to the limit is valid, one more is invalid; non-uuids and unknown ids are skipped; the limit is read at call time', async () => {
    const m = await s.repos.memory.add(A, mem('many one', 12));
    expect(limits.manyIds).toBe(20);
    const ids = Array.from({ length: 20 }, () => '00000000-0000-4000-8000-000000000000');
    expect(await s.repos.memory.getMany(A, ids)).toEqual([]);
    expect(await caught(s.repos.memory.getMany(A, [...ids, ids[0] as string]))).toEqual({ name: 'RepoError', code: 'invalid', message: 'at most 20 ids' });
    limits.manyIds = 2;
    expect((await s.repos.memory.getMany(A, [m.id, 'junk'])).map((r) => r.id)).toEqual([m.id]);
    expect(await caught(s.repos.memory.getMany(A, [m.id, m.id, m.id]))).toEqual({ name: 'RepoError', code: 'invalid', message: 'at most 2 ids' });
    expect(await s.repos.memory.getMany(A, [])).toEqual([]);
  });
  it('list hides deleted and superseded rows, filters by kind and text, and pages', async () => {
    const user = { userId: 'user-list' };
    for (const [i, kind] of (['preference', 'fact', 'fact'] as const).entries()) await s.repos.memory.add(user, mem(`list item ${i}`, 20 + i, { kind }));
    expect((await s.repos.memory.list(user, { kind: 'fact' })).rows).toHaveLength(2);
    expect((await s.repos.memory.list(user, { q: 'ITEM 1' })).rows.map((r) => r.text)).toEqual(['list item 1']);
    const page = await s.repos.memory.list(user, { limit: 2 });
    expect([page.rows.length, typeof page.next]).toEqual([2, 'string']);
    const rest = await s.repos.memory.list(user, { limit: 2, cursor: page.next as string });
    expect(rest.rows).toHaveLength(1);
    expect(rest.next).toBeNull();
  });
  it('patch: empty patch returns the row, pinned/kind change in place, new text recomputes the hash and replaces the embedding only when one is given', async () => {
    const m = await s.repos.memory.add(A, mem('patch me', 30));
    expect((await s.repos.memory.patch(A, m.id, {}))?.id).toBe(m.id);
    expect((await s.repos.memory.patch(A, m.id, { pinned: true, kind: 'convention' }))).toMatchObject({ pinned: true, kind: 'convention' });
    const t = await s.repos.memory.patch(A, m.id, { text: 'patched text', userId: 'user-b' } as never);
    expect([t?.text, t?.hash, t?.userId]).toEqual(['patched text', memoryHash('patched text'), 'user-a']);
    expect((await s.repos.memory.nearest(A, { scope: 'global', embedding: unit(30), limit: 3 })).map((g) => g.memory.id)).toContain(m.id);
    await s.repos.memory.patch(A, m.id, { text: 'patched again', embedding: unit(33) });
    expect((await s.repos.memory.nearest(A, { scope: 'global', embedding: unit(33), limit: 1 })).map((g) => g.memory.id)).toEqual([m.id]);
    expect((await caught(s.repos.memory.patch(A, m.id, { kind: 'rumour' }))).code).toBe('invalid');
    expect(await s.repos.memory.patch(A, 'nope', { pinned: true })).toBeNull();
  });
  it('softDelete sets deleted_at once, never deletes the row', async () => {
    const m = await s.repos.memory.add(A, mem('delete me', 31));
    expect(await s.repos.memory.softDelete(A, m.id)).toBe(1);
    expect(await s.repos.memory.softDelete(A, m.id)).toBe(0);
    expect((await s.repos.memory.get(A, m.id))?.deletedAt).toBeInstanceOf(Date);
    expect((await s.repos.memory.list(A, { q: 'delete me' })).rows).toEqual([]);
    expect(await s.repos.memory.patch(A, m.id, { pinned: true })).toBeNull();
  });
  it('recallLegs returns a full-text leg and a vector leg of live rows, perLeg clamped to 1..100', async () => {
    const user = { userId: 'user-recall' };
    const hit = await s.repos.memory.add(user, mem('deploys use blue green rollout', 50));
    await s.repos.memory.add(user, mem('unrelated cooking note', 51));
    const gone = await s.repos.memory.add(user, mem('deploys are deleted rollout', 50));
    await s.repos.memory.softDelete(user, gone.id);
    const legs = await s.repos.memory.recallLegs(user, { queryText: 'blue green', queryVector: unit(50), perLeg: 10 });
    expect(legs.fts.map((m) => m.id)).toEqual([hit.id]);
    expect(legs.vec[0]?.id).toBe(hit.id);
    expect(legs.vec.map((m) => m.id)).not.toContain(gone.id);
    expect((await s.repos.memory.recallLegs(user, { queryText: 'blue', queryVector: unit(50), perLeg: 0 })).vec).toHaveLength(1);
    expect((await s.repos.memory.recallLegs(user, { queryText: '', queryVector: unit(50), perLeg: 1000 })).fts).toEqual([]);
    expect((await s.repos.memory.recallLegs(user, { queryText: "x'); drop table memories;--", queryVector: unit(50), perLeg: 5 })).fts).toEqual([]);
  });
  it('D8 timeline: the anchor with up to 10 neighbours each way; clamps the counts; unknown anchor is empty', async () => {
    const user = { userId: 'user-tl' };
    const made: string[] = [];
    for (let i = 0; i < 25; i++) made.push((await s.repos.memory.add(user, mem(`tl item ${i}`, 60 + (i % 5)))).id);
    await exec(s.url, `update "${s.schema}".memories set created_at = '2026-01-01'::timestamptz + (substring(text from 9)::int || ' minutes')::interval where user_id = 'user-tl'`);
    const mid = made[12] as string;
    const t = await s.repos.memory.timeline(user, { anchorId: mid, before: 2, after: 1 });
    expect(t.memories.map((m) => m.text)).toEqual(['tl item 10', 'tl item 11', 'tl item 12', 'tl item 13']);
    const wide = await s.repos.memory.timeline(user, { anchorId: mid, before: 99, after: 99 });
    expect(wide.memories).toHaveLength(21);
    expect((await s.repos.memory.timeline(user, { anchorId: mid, before: -5, after: Number.NaN })).memories.map((m) => m.text)).toEqual(['tl item 12']);
    expect(await s.repos.memory.timeline(user, { anchorId: '00000000-0000-4000-8000-000000000000', before: 5, after: 5 })).toEqual({ memories: [], summaries: [] });
    expect(await s.repos.memory.timeline(user, { anchorId: 'junk', before: 5, after: 5 })).toEqual({ memories: [], summaries: [] });
  });
  it('touch updates last_used_at and use_count for own ids only', async () => {
    const m = await s.repos.memory.add(A, mem('touch me', 32));
    expect(await s.repos.memory.touch(A, [m.id, 'junk'])).toBe(1);
    await s.repos.memory.touch(A, [m.id]);
    const got = await s.repos.memory.get(A, m.id);
    expect([got?.useCount, got?.lastUsedAt instanceof Date]).toEqual([2, true]);
    expect(await s.repos.memory.touch(B, [m.id])).toBe(0);
    expect(await s.repos.memory.touch(A, [])).toBe(0);
  });
  it('a session that ended again with more content gets a second summary; the newest is the one shown', async () => {
    await s.repos.sessions.upsert(AP, { id: 'sum-again', projectId: AP.projectId });
    expect(await s.repos.memory.insertSummary(AP, { sessionId: 'sum-again', contentHash: 'again-1', nextSteps: 'old steps' })).toBe(true);
    expect(await s.repos.memory.insertSummary(AP, { sessionId: 'sum-again', contentHash: 'again-2', nextSteps: 'new steps' })).toBe(true);
    expect((await s.repos.memory.getSummary(AP, 'sum-again'))?.nextSteps).toBe('new steps');
    expect((await s.repos.memory.lastSummaries(AP, 50)).filter((x) => x.sessionId === 'sum-again').map((x) => x.nextSteps)).toEqual(['new steps']);
  });
  it('the extract cursor of a session is stored and read back', async () => {
    await s.repos.sessions.upsert(AP, { id: 'cursor-s', projectId: AP.projectId });
    expect((await s.repos.sessions.get(AP, 'cursor-s'))?.extractedTurns).toBe(0);
    await s.repos.sessions.setExtractedTurns(AP, 'cursor-s', 7);
    expect((await s.repos.sessions.get(AP, 'cursor-s'))?.extractedTurns).toBe(7);
  });
  it('supersede back to an older text revives it instead of leaving no live memory', async () => {
    const user = { userId: 'user-cycle' };
    const npm = await s.repos.memory.add(user, mem('use npm', 70));
    const pnpm = await s.repos.memory.supersede(user, npm.id, mem('use pnpm', 71));
    const back = await s.repos.memory.supersede(user, pnpm?.id as string, mem('use npm', 70));
    expect(back?.id).toBe(npm.id);
    expect((await s.repos.memory.list(user)).rows.map((m) => m.text)).toEqual(['use npm']);
    expect((await s.repos.memory.get(user, pnpm?.id as string))?.supersededBy).toBe(npm.id);
  });
  it('adding a text that was deleted brings it back as a live memory', async () => {
    const user = { userId: 'user-readd' };
    const first = await s.repos.memory.add(user, mem('spool drain retries', 72));
    await s.repos.memory.softDelete(user, first.id);
    const again = await s.repos.memory.add(user, mem('spool drain retries', 72));
    expect([again.id, again.deletedAt]).toEqual([first.id, null]);
    expect((await s.repos.memory.list(user)).rows.map((m) => m.id)).toEqual([first.id]);
  });
  it('recallLegs: with anyWord a sentence finds a memory by any of its words (without it all words must match), and globalOnly leaves project rows out', async () => {
    const user = { userId: 'user-fts' };
    const proj = { ...user, projectId: (await s.repos.projects.upsert(user, { root: '/fts/p' })).id };
    const g = await s.repos.memory.add(user, mem('spool drain retries failed deliveries every 30 seconds', 73));
    const p = await s.repos.memory.add(proj, mem('spool project note', 74, { scope: 'project' }));
    const ids = async (q: string, globalOnly = false) => (await s.repos.memory.recallLegs(proj, { queryText: q, queryVector: null, perLeg: 10, anyWord: true, ...(globalOnly ? { globalOnly } : {}) })).fts.map((m) => m.id);
    expect(await ids('myproj finish the spool retry work and update the docs then deploy')).toEqual(expect.arrayContaining([g.id, p.id]));
    expect(await ids('spool retry')).toEqual(expect.arrayContaining([g.id]));
    expect(await ids('spool', true)).toEqual([g.id]);
    expect((await s.repos.memory.recallLegs(proj, { queryText: 'spool retry work', queryVector: null, perLeg: 10 })).fts).toEqual([]);
  });
  it('timeline gives as many following memories as asked even when they are created within a millisecond', async () => {
    const user = { userId: 'user-tl-us' };
    const made: string[] = [];
    for (let i = 0; i < 4; i++) made.push((await s.repos.memory.add(user, mem(`us item ${i}`, 80 + i))).id);
    await exec(s.url, `update "${s.schema}".memories set created_at = '2026-02-01 00:00:00.000100+00'::timestamptz + (substring(text from 9)::int * 100 || ' microseconds')::interval where user_id = 'user-tl-us'`);
    const t = await s.repos.memory.timeline(user, { anchorId: made[0] as string, before: 0, after: 2 });
    expect(t.memories.map((m) => m.text)).toEqual(['us item 0', 'us item 1', 'us item 2']);
  });
  it('summaries: insert once per content, only for own sessions; newest first for the ctx project', async () => {
    await s.repos.sessions.upsert(AP, { id: 'sum-s1', projectId: AP.projectId });
    await s.repos.sessions.upsert(AP, { id: 'sum-s2', projectId: AP.projectId });
    expect(await s.repos.memory.insertSummary(AP, { sessionId: 'sum-s1', contentHash: 'c1', request: 'first' })).toBe(true);
    expect(await s.repos.memory.insertSummary(AP, { sessionId: 'sum-s1', contentHash: 'c1' })).toBe(false);
    expect(await s.repos.memory.insertSummary(AP, { sessionId: 'sum-s2', contentHash: 'c1' })).toBe(false);
    expect(await s.repos.memory.insertSummary(AP, { sessionId: 'sum-s2', contentHash: 'c2', request: 'second' })).toBe(true);
    expect(await s.repos.memory.insertSummary(B, { sessionId: 'sum-s1', contentHash: 'c9' })).toBe(false);
    expect((await s.repos.memory.lastSummaries(AP, 5)).filter((x) => x.sessionId.startsWith('sum-s')).map((x) => x.request)).toEqual(['second', 'first']);
    expect((await s.repos.memory.lastSummaries(AP, 1))).toHaveLength(1);
    expect((await s.repos.memory.getSummary(AP, 'sum-s1'))?.request).toBe('first');
    expect(await s.repos.memory.getSummary(B, 'sum-s1')).toBeNull();
    expect(await caught(s.repos.memory.lastSummaries(A, 5))).toEqual({ name: 'TypeError', message: 'ctx.projectId required' });
  });
});

describe('D14 runner', () => {
  it('D6 createRun: a second running run for one owner is a ConflictError; status and trigger are checked', async () => {
    const one = await s.repos.runner.createRun(A, { owner: 'o-conflict', trigger: 'api', status: 'running' });
    expect([one.status, one.userId]).toEqual(['running', 'user-a']);
    expect(await caught(s.repos.runner.createRun(A, { owner: 'o-conflict', trigger: 'cli', status: 'running' }))).toEqual({ name: 'ConflictError', code: 'conflict', message: 'owner already has a running run' });
    expect((await s.repos.runner.createRun(A, { owner: 'o-conflict', trigger: 'cli' })).status).toBe('queued');
    expect((await caught(s.repos.runner.createRun(A, { owner: 'o', trigger: 'carrier-pigeon' }))).code).toBe('invalid');
    expect((await caught(s.repos.runner.createRun(A, { owner: 'o', trigger: 'api', status: 'sleeping' }))).code).toBe('invalid');
    expect((await caught(s.repos.runner.createRun(A, { owner: '', trigger: 'api' }))).code).toBe('invalid');
    expect((await s.repos.runner.getRun(A, one.id))?.owner).toBe('o-conflict');
  });
  it('setRunStatus: moves from -> to with a whitelisted patch; wrong status is a conflict; not the user\'s is not_found; the running rule still holds', async () => {
    const run = await s.repos.runner.createRun(A, { owner: 'o-status', trigger: 'api' });
    const moved = await s.repos.runner.setRunStatus(A, run.id, { from: 'queued', to: 'running', patch: { state: { n: 1 }, startedAt: '2026-01-01T00:00:00Z', userId: 'user-b', status: 'done' } });
    expect([moved.status, moved.state, moved.startedAt?.toISOString(), moved.userId]).toEqual(['running', { n: 1 }, '2026-01-01T00:00:00.000Z', 'user-a']);
    expect(await caught(s.repos.runner.setRunStatus(A, run.id, { from: 'queued', to: 'done' }))).toEqual({ name: 'ConflictError', code: 'conflict', message: 'run is not in the expected status' });
    expect(await caught(s.repos.runner.setRunStatus(B, run.id, { from: 'running', to: 'done' }))).toEqual({ name: 'RepoError', code: 'not_found', message: 'run not found' });
    const second = await s.repos.runner.createRun(A, { owner: 'o-status', trigger: 'api' });
    expect((await caught(s.repos.runner.setRunStatus(A, second.id, { from: 'queued', to: 'running' }))).code).toBe('conflict');
    expect((await caught(s.repos.runner.setRunStatus(A, run.id, { from: 'running', to: 'bogus' }))).code).toBe('invalid');
  });
  it('listRuns pages newest first', async () => {
    const user = { userId: 'user-runs' };
    for (let i = 0; i < 3; i++) await s.repos.runner.createRun(user, { owner: `o${i}`, trigger: 'api' });
    const p1 = await s.repos.runner.listRuns(user, { limit: 2 });
    const p2 = await s.repos.runner.listRuns(user, { limit: 2, cursor: p1.next as string });
    expect([p1.rows.length, p2.rows.length, p2.next]).toEqual([2, 1, null]);
    expect(new Set([...p1.rows, ...p2.rows].map((r) => r.id)).size).toBe(3);
  });
  it('insertStep: a repeat of (run, node, visit, attempt) returns the existing row with created:false; fields are stored', async () => {
    const run = await s.repos.runner.createRun(A, { owner: 'o-steps', trigger: 'api' });
    const a = await s.repos.runner.insertStep(A, { runId: run.id, nodeId: 'build', visit: 1, status: 'queued', branch: 'feat/x', options: { k: 1 } });
    expect([a.created, a.step.attempt, a.step.branch, a.step.options]).toEqual([true, 1, 'feat/x', { k: 1 }]);
    const b = await s.repos.runner.insertStep(A, { runId: run.id, nodeId: 'build', visit: 1, status: 'running' });
    expect([b.created, b.step.id, b.step.status]).toEqual([false, a.step.id, 'queued']);
    const retry = await s.repos.runner.insertStep(A, { runId: run.id, nodeId: 'build', visit: 1, attempt: 2, status: 'queued', retryOfStepId: a.step.id });
    expect([retry.created, retry.step.retryOfStepId]).toEqual([true, a.step.id]);
    expect((await s.repos.runner.listSteps(A, run.id)).map((x) => x.attempt)).toEqual([1, 2]);
    expect((await caught(s.repos.runner.insertStep(A, { runId: 999999, nodeId: 'x', visit: 1, status: 'queued' }))).code).toBe('not_found');
    expect((await caught(s.repos.runner.insertStep(A, { runId: run.id, nodeId: 'x', visit: 1, status: 'nope' }))).code).toBe('invalid');
  });
  it('insertStep refuses a parent or retry step of another user', async () => {
    const mine = await s.repos.runner.createRun(A, { owner: 'o-par', trigger: 'api' });
    const theirs = await s.repos.runner.createRun(B, { owner: 'o-par-b', trigger: 'api' });
    const foreign = (await s.repos.runner.insertStep(B, { runId: theirs.id, nodeId: 'n', visit: 1, status: 'queued' })).step;
    expect((await caught(s.repos.runner.insertStep(A, { runId: mine.id, nodeId: 'n', visit: 1, status: 'queued', parentStepId: foreign.id }))).code).toBe('not_found');
    expect((await caught(s.repos.runner.insertStep(A, { runId: mine.id, nodeId: 'n', visit: 1, status: 'queued', retryOfStepId: foreign.id }))).code).toBe('not_found');
  });
  it('transition: from -> to with a patch; wrong status is a conflict; foreign or missing steps are not_found; setStepFields never touches status', async () => {
    const run = await s.repos.runner.createRun(A, { owner: 'o-trans', trigger: 'api' });
    const { step } = await s.repos.runner.insertStep(A, { runId: run.id, nodeId: 'n', visit: 1, status: 'queued' });
    const running = await s.repos.runner.transition(A, { stepId: step.id, from: 'queued', to: 'running', patch: { pid: 42, liveness: 'alive', costUsd: 0.5, usage: { in: 1 }, status: 'done', runId: 1 } });
    expect([running.status, running.pid, running.liveness, running.costUsd, running.usage, running.runId]).toEqual(['running', 42, 'alive', 0.5, { in: 1 }, run.id]);
    expect(await caught(s.repos.runner.transition(A, { stepId: step.id, from: 'queued', to: 'done' }))).toEqual({ name: 'ConflictError', code: 'conflict', message: 'step is not in the expected status' });
    expect(await caught(s.repos.runner.transition(B, { stepId: step.id, from: 'running', to: 'done' }))).toEqual({ name: 'RepoError', code: 'not_found', message: 'step not found' });
    expect((await caught(s.repos.runner.transition(A, { stepId: 9999999, from: 'running', to: 'done' }))).code).toBe('not_found');
    const set = await s.repos.runner.setStepFields(A, step.id, { stage: 'stream', status: 'done', error: 'oops' });
    expect([set?.status, set?.stage, set?.error]).toEqual(['running', 'stream', 'oops']);
    expect((await s.repos.runner.setStepFields(A, step.id, {}))?.id).toBe(step.id);
    expect(await s.repos.runner.setStepFields(B, step.id, { stage: 'report' })).toBeNull();
    expect((await s.repos.runner.getStep(A, step.id))?.stage).toBe('stream');
    expect(await s.repos.runner.getStep(B, step.id)).toBeNull();
    const unchanged = await s.repos.runner.setStepFields(A, step.id, { failureCount: 9, startedAt: new Date(0), endedAt: new Date(0) });
    expect([unchanged?.failureCount, unchanged?.endedAt]).toEqual([running.failureCount, running.endedAt]);
  });

  it('D5 a non-numeric id reads as missing, never a database error', async () => {
    const r = s.repos.runner;
    expect([await r.getRun(A, 'abc' as never), await r.getStep(A, 'abc' as never), await r.listSteps(A, 'abc' as never), await s.repos.apiKeys.revoke(A, 'abc' as never)]).toEqual([null, null, [], 0]);
    expect(await r.setStepFields(A, 'abc' as never, { stage: 'x' })).toBeNull();
    expect((await caught(r.transition(A, { stepId: 'abc' as never, from: 'queued', to: 'running' }))).code).toBe('not_found');
  });

  it('D8 a null options object gives the defaults', async () => {
    expect((await s.repos.projects.list(A, null as never)).rows).toBeInstanceOf(Array);
    expect((await s.repos.runner.listRuns(A, null as never)).rows).toBeInstanceOf(Array);
  });
  it('transition applied twice in parallel succeeds once (compare and set)', async () => {
    const run = await s.repos.runner.createRun(A, { owner: 'o-cas', trigger: 'api' });
    const { step } = await s.repos.runner.insertStep(A, { runId: run.id, nodeId: 'n', visit: 1, status: 'queued' });
    const results = await Promise.allSettled([1, 2, 3].map(() => s.repos.runner.transition(A, { stepId: step.id, from: 'queued', to: 'running' })).map((p) => p));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.code === 'conflict')).toBe(true);
  });
  it('schedules: upsert replaces cron/input/enabled; delete counts; per user', async () => {
    const sch = await s.repos.runner.upsertSchedule(A, { owner: 'o-sch', workflow: 'nightly', cron: '0 3 * * *' });
    expect([sch.enabled, sch.input, sch.lastFiredAt]).toEqual([true, '', null]);
    const upd = await s.repos.runner.upsertSchedule(A, { owner: 'o-sch', workflow: 'nightly', cron: '0 4 * * *', input: 'go', enabled: false });
    expect([upd.cron, upd.input, upd.enabled]).toEqual(['0 4 * * *', 'go', false]);
    expect((await s.repos.runner.listSchedules(A)).filter((x) => x.owner === 'o-sch')).toHaveLength(1);
    expect(await s.repos.runner.deleteSchedule(B, { owner: 'o-sch', workflow: 'nightly' })).toBe(0);
    expect(await s.repos.runner.deleteSchedule(A, { owner: 'o-sch', workflow: 'nightly' })).toBe(1);
    expect(await s.repos.runner.deleteSchedule(A, { owner: 'o-sch', workflow: 'nightly' })).toBe(0);
    expect((await caught(s.repos.runner.upsertSchedule(A, { owner: '', workflow: 'x', cron: 'x' }))).code).toBe('invalid');
  });
  it('D13 listRunningSteps sees the running steps of all users; listFinishedRuns only finished runs older than the cutoff', async () => {
    const run = await s.repos.runner.createRun(B, { owner: 'o-sweep', trigger: 'api' });
    const { step } = await s.repos.runner.insertStep(B, { runId: run.id, nodeId: 'n', visit: 1, status: 'running' });
    const running = await s.repos.system.runner.listRunningSteps(sctx);
    expect(running.find((r) => r.id === step.id)).toMatchObject({ status: 'running', userId: 'user-b' });
    await s.repos.runner.setRunStatus(B, run.id, { from: 'queued', to: 'done', patch: { endedAt: '2020-01-01T00:00:00Z' } });
    const old = await s.repos.system.cleanup.listFinishedRuns(sctx, 30);
    expect(old.map((r) => r.id)).toContain(run.id);
    expect((await s.repos.system.cleanup.listFinishedRuns(sctx, 100000)).map((r) => r.id)).not.toContain(run.id);
    const active = await s.repos.runner.createRun(B, { owner: 'o-active', trigger: 'api' });
    expect((await s.repos.system.cleanup.listFinishedRuns(sctx, 0)).map((r) => r.id)).not.toContain(active.id);
  });
});
