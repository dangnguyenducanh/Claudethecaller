import { fitStartBlock } from '@ctc/core/memory';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hook, mkDeps, rnd, scratch, type Scratch } from './testing.ts';

let s: Scratch;
beforeAll(async () => {
  s = await scratch();
}, 60_000);
afterAll(async () => {
  await s?.drop();
});

const sentence = (i: number): string => `Memory ${i} about the ${'spool drain and the retry queue '.repeat(8)}`.slice(0, 150 + (i % 150));

describe('memory.context', () => {
  it('500 memories and 3 big summaries give a block of at most 10000 chars, every line prefixed, notes and investigated dropped', async () => {
    const user = { userId: `ctx-${rnd()}` };
    const root = `/work/ctx-${rnd()}`;
    const project = await s.repos.projects.upsert(user, { root });
    const ctx = { ...user, projectId: project.id };
    const { embed } = mkDeps(s.repos);
    for (let i = 0; i < 500; i++) {
      const text = sentence(i) + ` #${i}`;
      await s.repos.memory.add(ctx, { scope: i % 5 === 0 ? 'global' : 'project', kind: 'fact', text, embedding: (await embed([text]))[0] as number[] });
    }
    for (let n = 1; n <= 3; n++) {
      const sid = `s-${n}-${rnd()}`;
      await s.repos.sessions.upsert(user, { id: sid, projectId: project.id, transcriptPath: `/t/${sid}.jsonl` });
      const f = (label: string): string => `${label}${n} `.padEnd(1900, 'x');
      await s.repos.memory.insertSummary(ctx, {
        sessionId: sid, contentHash: sid, request: f('request'), investigated: f('investigated'), learned: f('learned'), completed: f('completed'), nextSteps: f('next'), notes: f('notes'),
      });
    }
    const r = await hook(mkDeps(s.repos), { body: { cwd: root, session_id: 'x' }, ctx: user });
    const body = r.body as string;
    expect(r.status).toBe(200);
    expect(body.length).toBeLessThanOrEqual(10000);
    const lines = body.split('\n');
    expect(lines.every((l) => l.startsWith('ctc: '))).toBe(true);
    expect(lines.some((l) => l.startsWith('ctc: request: '))).toBe(true);
    expect(lines.some((l) => l.startsWith('ctc: learned: '))).toBe(true);
    expect(lines.some((l) => l.startsWith('ctc: completed: '))).toBe(true);
    expect(lines.some((l) => l.startsWith('ctc: next steps: '))).toBe(true);
    expect(lines.some((l) => l.startsWith('ctc: notes: ') || l.startsWith('ctc: investigated: '))).toBe(false);
  }, 120_000);

  const summary = (n: number, pad: number) => ({
    request: `r${n}`.padEnd(pad, 'a'), investigated: `i${n}`.padEnd(pad, 'b'), learned: `l${n}`.padEnd(pad, 'c'),
    completed: `c${n}`.padEnd(pad, 'd'), nextSteps: `n${n}`.padEnd(pad, 'e'), notes: `o${n}`.padEnd(pad, 'f'), createdAt: `2026-10-0${n}T00:00:00Z`,
  });

  it('drops nothing when the block fits', () => {
    expect(fitStartBlock({ project: 'p', summaries: [summary(1, 5)], memories: [{ kind: 'fact', text: 'm' }] }, 10000).steps).toEqual([]);
  });

  it('stops after notes when that is enough', () => {
    const input = { project: 'p', summaries: [summary(1, 100)], memories: [] };
    const full = fitStartBlock(input, 100000).text.length;
    const r = fitStartBlock(input, full - 50);
    expect(r.steps).toEqual(['notes']);
    expect(r.text).not.toContain('notes:');
  });

  it('applies every step in the fixed order down to an empty block', () => {
    const memories = Array.from({ length: 30 }, (_, i) => ({ kind: 'fact', text: `m${i} `.padEnd(100, 'z') }));
    const r = fitStartBlock({ project: 'p', summaries: [summary(1, 100), summary(2, 100)], memories }, 3);
    expect(r.steps).toEqual(['notes', 'investigated', 'older', 'halve:15', 'halve:7', 'halve:3', 'halve:1', 'halve:0', 'last']);
    expect(r.text).toBe('');
  });
});
