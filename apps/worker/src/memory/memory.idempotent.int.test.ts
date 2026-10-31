import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeChat, handlersFor, jobCtx, reply, say, scratch, seedSession, tempHome, type Scratch } from './testing.ts';

let s: Scratch;
const t = tempHome();
beforeAll(async () => void (s = await scratch()), 60_000);
afterAll(async () => {
  t.remove();
  await s?.drop();
});

const today = new Date().toISOString().slice(0, 10);

describe('memory.idempotent', () => {
  it('extracting a session twice adds no rows and reinforces today once; summarizing twice keeps one summary', async () => {
    const x = await seedSession(s.repos, t.projDir, 'idem', [
      say('user', 'always use pnpm in this repo'), say('user', 'keep logs in English'), say('user', 'prefer small diffs'),
    ]);
    const { chat, calls } = fakeChat({
      extract: [reply(['convention', 'project', 'always use pnpm in this repo'], ['preference', 'global', 'keep logs in English'], ['preference', 'global', 'prefer small diffs'])],
    });
    const h = handlersFor(s.repos, t.home, { chat });
    const run = () => h['llm.extract']({ userId: x.userId, projectId: x.projectId, sessionId: x.sessionId } as never, jobCtx());
    const list = async () => (await s.repos.memory.list(x.ctx)).rows;

    expect(await run()).toEqual({ facts: 3, noop: 0, update: 0, supersede: 0, add: 3, skipped: 0 });
    const first = await list();
    expect(first).toHaveLength(3);
    expect(first.every((r) => r.reinforcementDates.length === 0)).toBe(true);

    expect(await run()).toEqual({ facts: 3, noop: 3, update: 0, supersede: 0, add: 0, skipped: 0 });
    const second = await list();
    expect(second.map((r) => r.id).sort()).toEqual(first.map((r) => r.id).sort());
    for (const r of second) expect(r.reinforcementDates).toEqual([today]);
    const dates = second.map((r) => [r.id, r.reinforcementDates.join()]).sort();

    await run();
    expect((await list()).map((r) => [r.id, r.reinforcementDates.join()]).sort()).toEqual(dates);

    const sum = () => h['llm.summarize']({ userId: x.userId, sessionId: x.sessionId } as never, jobCtx());
    expect(await sum()).toEqual({ inserted: true });
    const n = calls.length;
    expect(await sum()).toEqual({ skipped: 'exists' });
    expect(calls).toHaveLength(n);
    expect(await s.repos.memory.lastSummaries(x.ctx, 10)).toHaveLength(1);
  });
});
