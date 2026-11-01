import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decide } from '@ctc/core/memory';
import { memoryHash } from '@ctc/shared/memory-hash';
import { ModelError } from '@ctc/shared/models';
import { BANDS, fakeChat, handlersFor, jobCtx, reply, say, scratch, seedSession, tempHome, type Scratch } from './testing.ts';

type Pair = { name: string; existing: string; candidate: string; similarity: number; relation: 'same' | 'contradicts' | null; expect: 'NOOP' | 'UPDATE' | 'SUPERSEDE' | 'ADD' };
const pairs = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../../../packages/core/src/memory/fixtures/bands.json'), 'utf8')) as Pair[];

let s: Scratch;
const t = tempHome();
beforeAll(async () => void (s = await scratch()), 60_000);
afterAll(async () => {
  t.remove();
  await s?.drop();
});

const unit = (i: number): number[] => Array.from({ length: 1024 }, (_, k) => (k === i ? 1 : 0));
const today = new Date().toISOString().slice(0, 10);

/** Seeds `existing` at e1, then extracts `candidate` at cosine exactly `similarity` to e1 through the real handler ports. */
async function play(p: Pair, over: { judgeFails?: boolean } = {}) {
  const x = await seedSession(s.repos, t.projDir, 'bands', [say('user', p.candidate)]);
  const e1 = unit(0);
  const cand = e1.map((v, k) => (k === 0 ? p.similarity : k === 1 ? Math.sqrt(1 - p.similarity ** 2) : v));
  const old = await s.repos.memory.add(x.ctx, { scope: 'global', kind: 'fact', text: p.existing, embedding: e1 });
  const base = fakeChat({ extract: [reply(['fact', 'global', p.candidate])], relation: p.relation === null ? '{"relation":"unsure"}' : JSON.stringify({ relation: p.relation }) });
  const chat: typeof base.chat = over.judgeFails
    ? async (req, signal) => ((req.schema as { properties: object }).properties as object).hasOwnProperty('relation') ? Promise.reject(new ModelError('unavailable', 'down')) : base.chat(req, signal)
    : base.chat;
  const embed = async (texts: string[]) => texts.map((text) => (memoryHash(text) === memoryHash(p.candidate) ? cand : e1));
  const h = handlersFor(s.repos, t.home, { chat, embed });
  const result = await h['llm.extract']({ userId: x.userId, projectId: x.projectId, sessionId: x.sessionId } as never, jobCtx());
  const liveRows = (await s.repos.memory.list(x.ctx)).rows;
  return { x, old, result, liveRows, oldNow: await s.repos.memory.get(x.ctx, old.id) };
}

describe('memory.bands', () => {
  for (const p of pairs) {
    it(`${p.name} lands in ${p.expect}`, async () => {
      expect(decide(p.similarity, p.relation, BANDS)).toBe(p.expect);
      const { old, result, liveRows, oldNow } = await play(p);
      expect(result).toMatchObject({ facts: 1, noop: +(p.expect === 'NOOP'), update: +(p.expect === 'UPDATE'), supersede: +(p.expect === 'SUPERSEDE'), add: +(p.expect === 'ADD') });
      if (p.expect === 'NOOP') {
        expect(liveRows.map((r) => r.id)).toEqual([old.id]);
        expect(liveRows[0]?.text).toBe(p.existing);
        expect(liveRows[0]?.reinforcementDates).toContain(today);
      } else if (p.expect === 'UPDATE') {
        expect(liveRows).toHaveLength(1);
        expect(liveRows[0]).toMatchObject({ id: old.id, text: p.candidate, hash: memoryHash(p.candidate) });
      } else if (p.expect === 'SUPERSEDE') {
        expect(liveRows).toHaveLength(1);
        expect(liveRows[0]?.text).toBe(p.candidate);
        expect(oldNow?.supersededBy).toBe(liveRows[0]?.id);
        expect(oldNow?.deletedAt).toBeNull();
      } else {
        expect(liveRows.map((r) => r.text).sort()).toEqual([p.candidate, p.existing].sort());
        expect(oldNow?.supersededBy).toBeNull();
      }
    });
  }
  it('keeps both rows when the judge is down in the mid band', async () => {
    const p = pairs.find((q) => q.expect === 'UPDATE') as Pair;
    const { liveRows } = await play(p, { judgeFails: true });
    expect(liveRows).toHaveLength(2);
  });
  it('decides the pure boundaries', () => {
    expect([decide(0.95, null, BANDS), decide(0.85, 'same', BANDS), decide(0.8499, 'same', BANDS), decide(0.9, null, BANDS)]).toEqual(['NOOP', 'UPDATE', 'ADD', 'ADD']);
  });
  it('has at least two pairs per band', () => {
    for (const band of ['NOOP', 'UPDATE', 'SUPERSEDE', 'ADD']) expect(pairs.filter((p) => p.expect === band).length).toBeGreaterThanOrEqual(2);
  });
});
