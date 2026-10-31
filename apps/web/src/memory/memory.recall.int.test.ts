import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { rrf } from '@ctc/core/memory';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scratch, type Scratch } from './testing.ts';

const EVAL = path.resolve(import.meta.dirname, '../../../../.claude/metric/eval/memory');
const read = <T>(file: string): T[] =>
  fs.readFileSync(path.join(EVAL, file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
const toVec = (b64: string): number[] => {
  const b = Buffer.from(b64, 'base64');
  return Array.from(new Float32Array(b.buffer, b.byteOffset, b.length / 4));
};

let s: Scratch;
beforeAll(async () => {
  s = await scratch();
}, 60_000);
afterAll(async () => {
  await s?.drop();
});

describe('memory.recall', () => {
  it('RRF Recall@5 is at least vector-only Recall@5 on the hand-labelled eval set', async () => {
    const corpus = read<{ id: string; kind: string; scope: 'global' | 'project'; text: string }>('corpus.jsonl');
    const queries = read<{ id: string; query: string; relevant: string[] }>('queries.jsonl');
    const vectors = new Map(read<{ id: string; sha1: string; v: string }>('vectors.jsonl').map((x) => [x.id, x]));
    const user = { userId: 'eval' };
    const project = await s.repos.projects.upsert(user, { root: '/eval/claudethecaller' });
    const ctx = { ...user, projectId: project.id };
    const idOf = new Map<string, string>();
    for (const m of corpus) {
      const v = vectors.get(m.id);
      if (!v || v.sha1 !== createHash('sha1').update(m.text, 'utf8').digest('hex')) throw new Error('stale vectors: re-run embed.mjs');
      idOf.set((await s.repos.memory.add(ctx, { scope: m.scope, kind: m.kind, text: m.text, embedding: toVec(v.v) })).id, m.id);
    }
    expect(corpus.length).toBe(120);
    expect(queries.length).toBe(50);

    let fused = 0;
    let vector = 0;
    for (const q of queries) {
      const qv = vectors.get(q.id);
      if (!qv) throw new Error('stale vectors: re-run embed.mjs');
      const legs = await s.repos.memory.recallLegs(ctx, { queryText: q.query, queryVector: toVec(qv.v), perLeg: 100 });
      const at5 = (ids: string[]): number => q.relevant.filter((id) => ids.slice(0, 5).includes(id)).length / q.relevant.length;
      fused += at5(rrf([legs.fts, legs.vec], 60).map((x) => idOf.get(x.id) as string));
      vector += at5(legs.vec.map((m) => idOf.get(m.id) as string));
    }
    const [r, v] = [fused / queries.length, vector / queries.length];
    process.stdout.write(`memory.recall rrf@5=${r.toFixed(3)} vec@5=${v.toFixed(3)}\n`);
    expect(r).toBeGreaterThanOrEqual(v);
  }, 120_000);
});
