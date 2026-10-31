import { describe, expect, it } from 'vitest';
import {
  NON_FINAL, STAGES, STEP_STATUSES, TRANSITIONS, RunnerError, advanceStage, canEnterStage, canTransition, cancelRun, failStep, isCurrentAttempt,
  isExhausted, reportStep, retryStep, runnerJobId, runnerLimits, transitionStep, type RunnerPort,
} from './index.ts';

type Step = NonNullable<Awaited<ReturnType<RunnerPort['getStep']>>>;
type Run = NonNullable<Awaited<ReturnType<RunnerPort['getRun']>>>;
const ctx = { userId: 'u' };

class Conflict extends Error {
  readonly code = 'conflict';
}

/** In-memory port: `transition` and `setRunStatus` check `from` like the repositories do and log every call. */
function memPort(o: { run?: Partial<Run>; steps?: Partial<Step>[] } = {}) {
  const run = { id: 1, status: 'running', endedAt: null, ...o.run } as Run;
  const steps = (o.steps ?? []).map((s, i) => ({ id: i + 1, runId: 1, nodeId: 'n', visit: 1, attempt: 1, retryOfStepId: null, failureCount: 0, parentStepId: null, status: 'running', stage: null, error: null, output: null, endedAt: null, ...s }) as Step);
  const calls: string[] = [];
  const port: RunnerPort = {
    getRun: async () => run,
    setRunStatus: async (_c, _id, a) => {
      calls.push(`run ${a.from}->${a.to}`);
      if (run.status !== a.from) throw new Conflict('run');
      Object.assign(run, a.patch, { status: a.to });
      return run;
    },
    getStep: async (_c, id) => steps.find((s) => s.id === id) ?? null,
    listSteps: async () => steps,
    insertStep: async (_c, s) => {
      calls.push(`insert ${s.attempt}`);
      const existing = steps.find((x) => x.nodeId === s.nodeId && x.attempt === s.attempt);
      if (existing) return { step: existing, created: false };
      const row = { ...s, id: steps.length + 1 } as unknown as Step;
      steps.push(row);
      return { step: row, created: true };
    },
    transition: async (_c, a) => {
      calls.push(`step ${a.stepId} ${a.from}->${a.to}`);
      const s = steps.find((x) => x.id === a.stepId);
      if (!s) throw new Error('missing');
      if (s.status !== a.from) throw new Conflict('step');
      Object.assign(s, a.patch, { status: a.to });
      return s;
    },
    setStepFields: async (_c, id, patch) => {
      calls.push(`fields ${id}`);
      const s = steps.find((x) => x.id === id);
      return s ? Object.assign(s, patch) : null;
    },
  };
  return { port, run, steps, calls };
}

describe('transition table (D10, D11)', () => {
  it('allows exactly the 19 legal pairs of the 121', () => {
    let legal = 0;
    for (const f of STEP_STATUSES) for (const t of STEP_STATUSES) if (canTransition(f, t)) legal++;
    expect(legal).toBe(19);
    expect(canTransition('failed', 'circuit_broken')).toBe(true);
    expect(canTransition('failed', 'cancelled')).toBe(false);
    expect(canTransition('running', 'running')).toBe(false);
    expect(canTransition('constructor', 'running')).toBe(false);
    expect(canTransition('nope', 'running')).toBe(false);
  });
  it('NON_FINAL leaves failed and timeout out; the table is deep-frozen', () => {
    expect([...NON_FINAL].sort()).toEqual(['queued', 'quota', 'running', 'start_unknown', 'waiting']);
    expect(Object.isFrozen(TRANSITIONS) && Object.values(TRANSITIONS).every((v) => Object.isFrozen(v))).toBe(true);
  });
  it('transitionStep rejects an illegal pair before any port call and passes a legal one through', async () => {
    const m = memPort({ steps: [{ status: 'queued' }] });
    await expect(transitionStep(m.port, ctx, { stepId: 1, from: 'done', to: 'running' })).rejects.toMatchObject({ name: 'RunnerError', code: 'conflict' });
    expect(m.calls).toEqual([]);
    expect((await transitionStep(m.port, ctx, { stepId: 1, from: 'queued', to: 'running', patch: { stage: 'worktree' } })).status).toBe('running');
    expect(m.calls).toEqual(['step 1 queued->running']);
  });
});

describe('stages (D12)', () => {
  it('goes forward only, skips and rewrites of the same stage are allowed', () => {
    expect([...STAGES]).toEqual(['worktree', 'setup', 'spawn', 'stream', 'report']);
    expect([canEnterStage(null, 'spawn'), canEnterStage('setup', 'setup'), canEnterStage('worktree', 'stream')]).toEqual([true, true, true]);
    expect([canEnterStage('setup', 'worktree'), canEnterStage(null, 'bogus')]).toEqual([false, false]);
  });
  it('advanceStage writes only while running and only forward', async () => {
    const m = memPort({ steps: [{ status: 'running', stage: 'setup' }, { status: 'queued' }] });
    await expect(advanceStage(m.port, ctx, m.steps[0] as Step, 'worktree')).rejects.toBeInstanceOf(RunnerError);
    await expect(advanceStage(m.port, ctx, m.steps[1] as Step, 'worktree')).rejects.toBeInstanceOf(RunnerError);
    expect(m.calls).toEqual([]);
    expect((await advanceStage(m.port, ctx, m.steps[0] as Step, 'stream')).stage).toBe('stream');
  });
});

describe('attempts (D13)', () => {
  it('the limit is 3 and the third failure is final', () => {
    expect({ ...runnerLimits }).toEqual({ maxFailures: 3 });
    expect([0, 1, 2].map((failureCount) => isExhausted({ failureCount }))).toEqual([false, false, true]);
    expect(isExhausted({ failureCount: 0 }, 1)).toBe(true);
  });
  it('the current attempt has the highest attempt of its run, node and visit', () => {
    const a = { runId: 1, nodeId: 'a', visit: 1, attempt: 1 };
    expect(isCurrentAttempt(a, [a, { ...a, attempt: 2 }])).toBe(false);
    expect(isCurrentAttempt(a, [a, { ...a, nodeId: 'b', attempt: 9 }, { ...a, visit: 2, attempt: 9 }])).toBe(true);
  });
  it('retryStep inserts attempt n+1 as queued and keeps the parent', async () => {
    const m = memPort({ steps: [{ status: 'failed', parentStepId: 7 }] });
    const r = await retryStep(m.port, ctx, { stepId: 1 });
    expect([r.created, r.step.attempt, r.step.failureCount, r.step.retryOfStepId, r.step.status, r.step.parentStepId]).toEqual([true, 2, 1, 1, 'queued', 7]);
  });
  it('retryStep refuses an old attempt, a running step and a finished run, and writes nothing', async () => {
    const old = memPort({ steps: [{ status: 'failed' }, { attempt: 2, status: 'queued' }] });
    await expect(retryStep(old.port, ctx, { stepId: 1 })).rejects.toMatchObject({ code: 'stale_attempt' });
    const running = memPort({ steps: [{ status: 'running' }] });
    await expect(retryStep(running.port, ctx, { stepId: 1 })).rejects.toMatchObject({ code: 'conflict' });
    const done = memPort({ run: { status: 'cancelled' }, steps: [{ status: 'failed' }] });
    await expect(retryStep(done.port, ctx, { stepId: 1 })).rejects.toMatchObject({ code: 'conflict' });
    await expect(retryStep(done.port, ctx, { stepId: 99 })).rejects.toMatchObject({ code: 'not_found' });
    expect([old.calls, running.calls, done.calls]).toEqual([[], [], []]);
  });
  it('an exhausted retry breaks the circuit, fails the run and is a conflict', async () => {
    const m = memPort({ steps: [{ status: 'failed', attempt: 3, failureCount: 2 }] });
    await expect(retryStep(m.port, ctx, { stepId: 1 })).rejects.toMatchObject({ code: 'conflict' });
    expect([m.steps[0]?.status, m.run.status]).toEqual(['circuit_broken', 'failed']);
    expect(m.calls).not.toContain('insert 4');
  });
  it('retrying a start_unknown step first marks it failed as superseded', async () => {
    const m = memPort({ steps: [{ status: 'start_unknown' }] });
    await retryStep(m.port, ctx, { stepId: 1 });
    expect([m.steps[0]?.status, m.steps[0]?.error]).toEqual(['failed', 'superseded by retry']);
  });
});

describe('failStep (D14)', () => {
  it('fails with error and endedAt and leaves the run alone while retries remain', async () => {
    const m = memPort({ steps: [{ status: 'running' }] });
    const s = await failStep(m.port, ctx, { step: m.steps[0] as Step, to: 'failed', error: 'e'.repeat(2001), patch: { stage: 'report' } });
    expect([s.status, s.error?.length, s.stage, s.endedAt instanceof Date, m.run.status]).toEqual(['failed', 2000, 'report', true, 'running']);
  });
  it('the third failure breaks the circuit and fails an open run only', async () => {
    const open = memPort({ steps: [{ status: 'running', attempt: 3, failureCount: 2 }] });
    expect((await failStep(open.port, ctx, { step: open.steps[0] as Step, to: 'timeout' })).status).toBe('circuit_broken');
    expect(open.run.status).toBe('failed');
    const cancelled = memPort({ run: { status: 'cancelled' }, steps: [{ status: 'running', failureCount: 2 }] });
    await failStep(cancelled.port, ctx, { step: cancelled.steps[0] as Step, to: 'failed' });
    expect(cancelled.run.status).toBe('cancelled');
  });
  it('a done step cannot be failed', async () => {
    const m = memPort({ steps: [{ status: 'done' }] });
    await expect(failStep(m.port, ctx, { step: m.steps[0] as Step, to: 'failed' })).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('reportStep (D15)', () => {
  it('done applies once and the repeat is a no-op without a write', async () => {
    const m = memPort({ steps: [{ status: 'running' }] });
    const first = await reportStep(m.port, ctx, { stepId: 1, outcome: 'done', summary: 's' });
    expect([first.applied, first.step.status, first.step.stage, first.step.output]).toEqual([true, 'done', 'report', { outcome: 'done', summary: 's' }]);
    const before = m.calls.length;
    expect((await reportStep(m.port, ctx, { stepId: 1, outcome: 'failed' })).applied).toBe(false);
    expect(m.calls.length).toBe(before);
  });
  it('a report from an old attempt is stale and writes nothing', async () => {
    const m = memPort({ steps: [{ status: 'running' }, { attempt: 2, status: 'running' }] });
    await expect(reportStep(m.port, ctx, { stepId: 1, outcome: 'done' })).rejects.toMatchObject({ code: 'stale_attempt' });
    expect(m.calls).toEqual([]);
  });
  it('losing the race to another writer is applied false with the stored row', async () => {
    const m = memPort({ steps: [{ status: 'running' }] });
    const real = m.port.transition;
    m.port.transition = async (c, a) => {
      Object.assign(m.steps[0] as Step, { status: 'done' });
      return real(c, a);
    };
    const r = await reportStep(m.port, ctx, { stepId: 1, outcome: 'done' });
    expect([r.applied, r.step.status]).toEqual([false, 'done']);
  });
  it('failed uses the summary as error, or "reported failed"', async () => {
    const m = memPort({ steps: [{ status: 'running' }, { nodeId: 'm', status: 'running' }] });
    expect((await reportStep(m.port, ctx, { stepId: 1, outcome: 'failed', summary: 'bad' })).step.error).toBe('bad');
    expect((await reportStep(m.port, ctx, { stepId: 2, outcome: 'failed' })).step.error).toBe('reported failed');
  });
});

describe('cancelRun (D17)', () => {
  it('cancels the five non-final statuses and the run, and leaves the others', async () => {
    const all = ['queued', 'running', 'waiting', 'quota', 'start_unknown', 'done', 'failed', 'timeout', 'circuit_broken', 'skipped'];
    const m = memPort({ steps: all.map((status, i) => ({ status, nodeId: `n${i}` })) });
    const r = await cancelRun(m.port, ctx, 1);
    expect([r.cancelled, r.run.status]).toEqual([5, 'cancelled']);
    expect(m.steps.map((s) => s.status)).toEqual(['cancelled', 'cancelled', 'cancelled', 'cancelled', 'cancelled', 'done', 'failed', 'timeout', 'circuit_broken', 'skipped']);
  });
  it('a finished run is returned with cancelled 0 and no write', async () => {
    const m = memPort({ run: { status: 'done' }, steps: [{ status: 'running' }] });
    expect((await cancelRun(m.port, ctx, 1)).cancelled).toBe(0);
    expect(m.calls).toEqual([]);
  });
  it('a step that finished meanwhile is skipped, one that moved to another non-final status is tried again', async () => {
    const m = memPort({ steps: [{ status: 'running' }, { nodeId: 'm', status: 'queued' }] });
    const real = m.port.transition;
    let first = true;
    m.port.transition = async (c, a) => {
      if (first) {
        first = false;
        Object.assign(m.steps[0] as Step, { status: 'done' });
        Object.assign(m.steps[1] as Step, { status: 'running' });
      }
      return real(c, a);
    };
    const r = await cancelRun(m.port, ctx, 1);
    expect([r.cancelled, m.steps.map((s) => s.status)]).toEqual([1, ['done', 'cancelled']]);
  });
});

describe('runnerJobId (D19)', () => {
  it('is the spec string with % and : escaped in the node id', () => {
    expect(runnerJobId({ runId: 7, nodeId: 'n1', visit: 2, attempt: 3 })).toBe('run:7:node:n1:visit:2:attempt:3');
    expect(runnerJobId({ runId: 1, nodeId: 'a:b%c', visit: 1, attempt: 1 })).toBe('run:1:node:a%3Ab%25c:visit:1:attempt:1');
  });
});

describe('inputs and purity (D6)', () => {
  it('does not edit a deep-frozen step or patch', async () => {
    const m = memPort({ steps: [{ status: 'running' }] });
    const step = Object.freeze({ ...(m.steps[0] as Step) });
    const patch = Object.freeze({ stage: 'report' });
    await expect(failStep(m.port, ctx, { step, to: 'failed', patch })).resolves.toMatchObject({ status: 'failed' });
  });
});
