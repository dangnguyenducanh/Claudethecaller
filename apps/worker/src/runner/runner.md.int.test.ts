import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harness, restoreLimits, runSample, scratch, useFastLimits, type Harness, type Scratch } from './harness.ts';

let s: Scratch;
let h: Harness;
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

describe('runner.md', () => {
  it('runs the 3 sample workflows end to end within the metric thresholds', async () => {
    const ir = await runSample(h, s, 'implement-review.yaml', { topic: 'widgets' });
    const fm = await runSample(h, s, 'fanout-merge.yaml');
    const lg = await runSample(h, s, 'loop-gate.yaml');
    for (const m of [ir, fm, lg]) {
      expect(m.status).toBe('done');
      expect(m.attempts).toBe(0);
      expect(m.wall_ms).toBeLessThan(60_000);
    }
    expect(ir.prompt_outcome).toBe('delivered');
    expect(ir.reviewPrompt).toContain('impl-summary-xyz');
    expect(fm.children).toBe(3);
    expect(fm.worktrees).toBe(3);
    for (const f of ['part-1.txt', 'part-2.txt', 'part-3.txt']) expect(fm.files).toContain(f);
    expect(lg.visits['count']).toBe(3);
  }, 180_000);
});
