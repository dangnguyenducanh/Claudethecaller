import { describe, expect, it } from 'vitest';
import { REJECT_OPTION, RunnerError, approveStep, continueRun, type RunnerPort } from './index.ts';

type Row = Record<string, unknown> & { id: number; runId: number; status: string };
/** An in-memory port: only what the gates call. */
function port(steps: Row[], run: Record<string, unknown> & { status: string }): RunnerPort {
  const conflict = Object.assign(new Error('conflict'), { code: 'conflict' });
  return {
    getRun: async () => ({ id: 1, ...run }),
    setRunStatus: async (_c: unknown, _i: number, o: { to: string }) => ((run.status = o.to), { id: 1, ...run }),
    getStep: async (_c: unknown, id: number) => steps.find((s) => s.id === id) ?? null,
    listSteps: async () => steps,
    insertStep: async () => { throw new Error('unused'); },
    transition: async (_c: unknown, o: { stepId: number; from: string; to: string; patch?: object }) => {
      const s = steps.find((x) => x.id === o.stepId);
      if (s === undefined) throw new Error('not found');
      if (s.status !== o.from) throw conflict;
      Object.assign(s, o.patch, { status: o.to });
      return s;
    },
    setStepFields: async () => null,
  } as unknown as RunnerPort;
}
const gate = (o: Partial<Row> = {}): Row => ({
  id: 1, runId: 1, nodeId: 'g', visit: 1, attempt: 1, status: 'waiting', parentStepId: null, resolution: null, output: { question: 'q' },
  options: [{ id: 'approve', label: 'A' }, { id: REJECT_OPTION, label: 'R' }], ...o,
});
const ctx = { userId: 'u' };

describe('approveStep (D16b)', () => {
  it('moves a waiting step to done with the resolution and keeps the question', async () => {
    const steps = [gate()];
    const r = await approveStep(port(steps, { status: 'waiting' }), ctx, { stepId: 1, optionId: 'approve' });
    expect(r.applied).toBe(true);
    expect(steps[0]).toMatchObject({ status: 'done', resolution: 'approve', output: { question: 'q', outcome: 'done', choice: 'approve', summary: 'approve' } });
  });

  it('the same answer again is a no-op, another answer or an unknown option is a conflict', async () => {
    const p = port([gate({ status: 'done', resolution: 'approve' })], { status: 'running' });
    expect((await approveStep(p, ctx, { stepId: 1, optionId: 'approve' })).applied).toBe(false);
    await expect(approveStep(p, ctx, { stepId: 1, optionId: REJECT_OPTION })).rejects.toMatchObject({ code: 'conflict' });
    await expect(approveStep(p, ctx, { stepId: 1, optionId: 'nope' })).rejects.toMatchObject({ code: 'conflict', message: 'unknown option' });
  });

  it('an unknown step is not_found and an old attempt is stale_attempt', async () => {
    await expect(approveStep(port([], { status: 'waiting' }), ctx, { stepId: 9, optionId: 'approve' })).rejects.toMatchObject({ code: 'not_found' });
    const p = port([gate(), gate({ id: 2, attempt: 2, status: 'queued' })], { status: 'waiting' });
    await expect(approveStep(p, ctx, { stepId: 1, optionId: 'approve' })).rejects.toBeInstanceOf(RunnerError);
    await expect(approveStep(p, ctx, { stepId: 1, optionId: 'approve' })).rejects.toMatchObject({ code: 'stale_attempt' });
  });
});

describe('continueRun (D20)', () => {
  it('a finished run is a conflict, a running run a no-op', async () => {
    await expect(continueRun(port([], { status: 'done' }), ctx, { runId: 1 })).rejects.toMatchObject({ code: 'conflict', message: 'run is finished' });
    expect((await continueRun(port([], { status: 'running' }), ctx, { runId: 1 })).resumed).toEqual([]);
  });

  it('a quota run goes to running and its quota steps back to queued with the stages cleared', async () => {
    const steps = [{ id: 1, runId: 1, nodeId: 'a', visit: 1, attempt: 1, status: 'quota', parentStepId: null, stage: 'stream', pid: 5, error: 'usage limit' }];
    const r = await continueRun(port(steps, { status: 'quota' }), ctx, { runId: 1 });
    expect(r.run.status).toBe('running');
    expect(r.resumed).toHaveLength(1);
    expect(steps[0]).toMatchObject({ status: 'queued', error: null, stage: null, pid: null });
  });

  it('a waiting run with an open gate or a start_unknown step is a conflict, a fan-out row does not count as a gate', async () => {
    await expect(continueRun(port([gate()], { status: 'waiting' }), ctx, { runId: 1 })).rejects.toMatchObject({ message: 'run has an open gate' });
    const unknown = { ...gate({ id: 2, status: 'start_unknown', nodeId: 'u' }) };
    await expect(continueRun(port([unknown], { status: 'waiting' }), ctx, { runId: 1 })).rejects.toMatchObject({ message: 'run has a start_unknown step' });
    const fan = gate({ id: 3, nodeId: 'f', options: null, output: { items: ['1'], total: 1 } });
    expect((await continueRun(port([fan], { status: 'waiting' }), ctx, { runId: 1 })).run.status).toBe('running');
  });
});
