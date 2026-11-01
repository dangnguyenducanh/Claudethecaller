import { createSystemCtx } from '@ctc/shared/repositories';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rnd, scratch, type Scratch } from '../memory/testing.ts';
import { countGuardTrips } from './common.ts';

let s: Scratch;
beforeAll(async () => {
  s = await scratch();
}, 60_000);
afterAll(async () => {
  await s?.drop();
});

describe('guardTrips (spec 2.8)', () => {
  it('counts the dead graph jobs of the project that ended on the shrink guard after the last build', async () => {
    const user = { userId: `u-${rnd()}` };
    const a = await s.repos.projects.upsert(user, { root: `/work/a-${rnd()}` });
    const b = await s.repos.projects.upsert(user, { root: `/work/b-${rnd()}` });
    const dead = async (projectId: string, error: string, queue = 'graph') => {
      const { job } = await s.repos.jobs.create(user, { queue, kind: 'rebuild', payload: { userId: user.userId, projectId } });
      await s.repos.system.jobs.markDead(createSystemCtx('test'), job.id, error);
    };
    await dead(a.id, 'dropped:shrink_guard: 2 files would lose 90% of their nodes');
    await dead(a.id, 'dropped:root_missing');
    await dead(b.id, 'dropped:shrink_guard: other project');
    await dead(a.id, 'shrink_guard: other queue', 'llm');
    const ctx = { ...user, projectId: a.id };
    expect(await countGuardTrips(s.repos, ctx, null)).toBe(1);
    expect(await countGuardTrips(s.repos, ctx, new Date(Date.now() + 60_000))).toBe(0);
  });
});
