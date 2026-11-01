import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENTS, PERMISSIONS, agentArgv, buildPreamble, emptyStream, exitOutcome, parseRepoSetup, readStreamLine, runnerExecLimits, sweepAction, worktreeRecipe,
} from './index.ts';

const DEFAULTS = { ...runnerExecLimits };
afterEach(() => Object.assign(runnerExecLimits, DEFAULTS));

const line = (o: unknown): string => JSON.stringify(o);
const rs = (agent: string, o: unknown, state = emptyStream()) => readStreamLine(agent, state, typeof o === 'string' ? o : line(o));

describe('limits and names (D2, D9)', () => {
  it('pins the default limits and the public name lists', () => {
    expect(DEFAULTS).toEqual({
      killGraceMs: 5000, tailPollMs: 250, statusPollMs: 2000, reportExitGraceMs: 30000, quotaExitGraceMs: 10000, exitRecordGraceMs: 500,
      pidStartToleranceMs: 1000, summaryMax: 20000, errorMax: 2000, gitTimeoutMs: 30000, defaultTimeoutS: 1800,
    });
    expect([...AGENTS]).toEqual(['claude', 'codex']);
    expect([...PERMISSIONS]).toEqual(['acceptEdits', 'dontAsk', 'plan']);
  });

  it('cuts a summary at summaryMax and keeps a shorter one (equal is valid)', () => {
    expect(rs('claude', { type: 'result', result: 'x'.repeat(20000) }).lastMessage?.length).toBe(20000);
    expect(rs('claude', { type: 'result', result: 'x'.repeat(20001) }).lastMessage?.length).toBe(20000);
    runnerExecLimits.summaryMax = 5;
    expect(rs('claude', { type: 'result', result: 'abcdefgh' }).lastMessage).toBe('abcde');
  });
});

describe('agentArgv (D10)', () => {
  const base = Object.freeze(['claude', '-p']) as readonly string[];
  it('builds claude and codex argv without editing base', () => {
    expect(agentArgv('claude', base, { permission: 'plan', model: 'sonnet' })).toEqual(['claude', '-p', '--verbose', '--permission-mode', 'plan', '--model', 'sonnet']);
    expect(agentArgv('claude', ['claude', '--verbose'], { permission: 'dontAsk' })).toEqual(['claude', '--verbose', '--permission-mode', 'dontAsk']);
    expect(agentArgv('codex', ['codex', 'exec'], { permission: 'plan' })).toEqual(['codex', 'exec', '--sandbox', 'read-only']);
    expect(agentArgv('codex', ['codex'], { permission: 'acceptEdits', model: 'm1' })).toEqual(['codex', '--sandbox', 'workspace-write', '--model', 'm1']);
  });

  it('refuses unknown agents, bad permissions, bad models and banned flags with the exact reason', () => {
    const reason = (f: () => unknown): string => {
      try { f(); } catch (e) { expect(e).toBeInstanceOf(TypeError); return (e as Error).message; }
      return 'no error';
    };
    expect(reason(() => agentArgv('nope', base, { permission: 'plan' }))).toBe('unknown agent nope');
    expect(reason(() => agentArgv('claude', undefined, { permission: 'plan' }))).toBe('unknown agent claude');
    expect(reason(() => agentArgv('claude', base, { permission: 'bypassPermissions' }))).toBe('permission bypassPermissions not allowed');
    for (const m of ['-x', '', 'a b', 'a'.repeat(101)]) expect(reason(() => agentArgv('claude', base, { permission: 'plan', model: m }))).toBe('model not allowed');
    expect(reason(() => agentArgv('claude', base, { permission: 'plan', model: 'a'.repeat(100) }))).toBe('no error');
    expect(reason(() => agentArgv('codex', ['codex', '--dangerously-bypass-approvals-and-sandbox'], { permission: 'plan' }))).toBe('banned flag --dangerously-bypass-approvals-and-sandbox');
  });
});

describe('readStreamLine (D11)', () => {
  it('maps claude assistant, result and rate-limit events', () => {
    const a = rs('claude', { type: 'assistant', message: { content: [{ type: 'tool_use' }, { type: 'text', text: 'hi' }] } });
    expect([a.events, a.lastMessage]).toEqual([1, 'hi']);
    const r = rs('claude', { type: 'result', result: 'final', usage: { input_tokens: 1 }, total_cost_usd: 0.5 }, a);
    expect([r.events, r.lastMessage, r.usage, r.costUsd]).toEqual([2, 'final', { input_tokens: 1 }, 0.5]);
    expect(rs('claude', { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1893456000 } }).quota).toEqual({ resetsAt: '2030-01-01T00:00:00.000Z' });
    expect(rs('claude', { type: 'result', is_error: true, result: "You've hit your session limit" }).quota).toEqual({ resetsAt: null });
    expect(rs('claude', { type: 'result', is_error: false, result: 'we discussed the usage limit' }).quota).toBeNull();
  });

  it('maps codex messages, usage and errors and leaves cost null', () => {
    let c = rs('codex', { type: 'item.completed', item: { type: 'agent_message', text: 'first' } });
    c = rs('codex', { type: 'turn.completed', usage: { input_tokens: 9 } }, c);
    expect([c.lastMessage, c.usage, c.costUsd]).toEqual(['first', { input_tokens: 9 }, null]);
    expect(rs('codex', { type: 'turn.failed', error: { message: 'broke' } }).error).toBe('broke');
    expect(rs('codex', { type: 'error', message: 'You have hit your usage limit' }).quota).toEqual({ resetsAt: null });
  });

  it('ignores lines that are not JSON objects, never throws and never edits the state', () => {
    const frozen = Object.freeze(emptyStream());
    for (const l of ['', 'plain', '[1]', '"s"', '7', 'null', '{broken']) expect(rs('claude', l, frozen)).toEqual(frozen);
    expect(rs('claude', { type: 'mystery' }, frozen).events).toBe(1);
    expect(frozen.events).toBe(0);
  });
});

describe('worktreeRecipe (D12a)', () => {
  const o = { repo: '/r', dir: '.ctc/wt', workflow: 'wf', runId: 7, nodeId: 'impl', stepId: 42, visit: 1, attempt: 1, base: 'main' };
  it('is exact and adds visit and attempt suffixes', () => {
    expect(worktreeRecipe(o)).toEqual({
      branch: 'ctc/wf-7-impl-s42', path: '/r/.ctc/wt/7/42', add: ['worktree', 'add', '--no-track', '-b', 'ctc/wf-7-impl-s42', '/r/.ctc/wt/7/42', 'main'],
      config: ['config', 'branch.ctc/wf-7-impl-s42.base', 'main'],
    });
    expect(worktreeRecipe({ ...o, visit: 2, attempt: 3, child: 'a b' }).branch).toBe('ctc/wf-7-impl-a-b-v2-a3-s42');
    expect(worktreeRecipe({ ...o, nodeId: '' }).branch).toBe('ctc/wf-7-x-s42');
    expect(worktreeRecipe({ ...o, nodeId: 'a'.repeat(61) }).branch).toBe(`ctc/wf-7-${'a'.repeat(60)}-s42`);
    expect(worktreeRecipe({ ...o, repo: '/r/', dir: '.ctc//wt/' }).path).toBe('/r/.ctc/wt/7/42');
  });

  it('never gives two steps the same branch', () => {
    const b = (x: object) => worktreeRecipe({ ...o, ...x }).branch;
    expect(b({ nodeId: 'fan', child: 0 })).not.toBe(b({ nodeId: 'fan-0', stepId: 43 }));
    expect(b({ nodeId: 'build', attempt: 2 })).not.toBe(b({ nodeId: 'build-a2', stepId: 43 }));
    expect(b({ nodeId: `${'a'.repeat(60)}x` })).not.toBe(b({ nodeId: `${'a'.repeat(60)}y`, stepId: 43 }));
  });

  it('refuses a relative repo, an absolute or escaping dir and a bad base', () => {
    for (const bad of [{ repo: 'rel' }, { dir: '/abs' }, { dir: 'a/../../x' }, { base: '' }, { base: '-x' }]) expect(() => worktreeRecipe({ ...o, ...bad })).toThrow(TypeError);
  });
});

describe('parseRepoSetup (D13a)', () => {
  it('reads a string or a list, drops blanks and treats a missing setup as empty', () => {
    expect(parseRepoSetup('setup: "npm ci"\n')).toEqual({ setup: ['npm ci'] });
    expect(parseRepoSetup('setup:\n  - a\n  - ""\n  - b\n')).toEqual({ setup: ['a', 'b'] });
    for (const t of ['', 'name: x\n', 'setup:\n', 'setup: "  "\n', 'setup: []\n']) expect(parseRepoSetup(t)).toEqual({ setup: [] });
  });

  it('throws TypeError for invalid YAML and for any other setup type', () => {
    for (const t of ['setup: 5\n', 'setup: [1]\n', 'setup: {a: b}\n', 'a: [\n']) expect(() => parseRepoSetup(t)).toThrow(TypeError);
  });
});

describe('buildPreamble (D14e)', () => {
  it('keeps the prompt verbatim, adds the resolution and the report recipe and never a token', () => {
    const p = buildPreamble({ workflow: 'wf', nodeId: 'n1', attempt: 2, prompt: 'Do $X `y`\n  verbatim', resolution: 'APPROVED' });
    for (const need of ['Do $X `y`\n  verbatim', 'APPROVED', 'curl', '$CTC_REPORT_URL', 'X-CTC-Step-Token', '$CTC_STEP_TOKEN', 'outcome', 'summary']) expect(p).toContain(need);
    expect(/[0-9a-f]{64}/.test(p)).toBe(false);
    expect(buildPreamble({ workflow: 'wf', nodeId: 'n1', attempt: 1, prompt: 'P' })).not.toContain('APPROVED');
  });
});

describe('sweepAction (D18)', () => {
  const t = new Date('2026-02-02T00:00:00Z');
  const s = (o: object = {}) => ({ stage: 'stream', pid: 10, pidStartedAt: t, ...o });
  it('fails a stage before spawn, finishes on an exit record, reattaches a matching pid and otherwise reports unknown', () => {
    expect([null, 'worktree', 'setup'].map((stage) => sweepAction(s({ stage }), { exitCode: 0, startedAt: t }))).toEqual(['fail_stage', 'fail_stage', 'fail_stage']);
    expect(sweepAction(s(), { exitCode: 7, startedAt: null })).toBe('finish');
    expect(sweepAction(s(), { exitCode: null, startedAt: t })).toBe('reattach');
    expect(sweepAction(s({ pid: null }), { exitCode: null, startedAt: t })).toBe('start_unknown');
    expect(sweepAction(s(), { exitCode: null, startedAt: null })).toBe('start_unknown');
  });

  it('tolerates a start time difference of exactly pidStartToleranceMs and no more', () => {
    const at = (ms: number) => sweepAction(s(), { exitCode: null, startedAt: new Date(t.getTime() + ms) });
    expect([at(1000), at(-1000), at(1001), at(-1001)]).toEqual(['reattach', 'reattach', 'start_unknown', 'start_unknown']);
    runnerExecLimits.pidStartToleranceMs = 5;
    expect([at(5), at(6)]).toEqual(['reattach', 'start_unknown']);
  });
});

describe('exitOutcome (D16a)', () => {
  const stream = { ...emptyStream(), events: 3, lastMessage: 'the last' };
  it('maps exit 0 to done and any other exit to failed with the last stderr line', () => {
    expect(exitOutcome({ exitCode: 0, stream })).toEqual({ to: 'done', output: { outcome: 'done', summary: 'the last' }, error: null });
    expect(exitOutcome({ exitCode: 3, stream, stderrTail: 'a\nboom\n\n  \n' })).toEqual({ to: 'failed', output: { outcome: 'failed', summary: 'the last' }, error: 'exit 3: boom' });
    expect(exitOutcome({ exitCode: 3, stream }).error).toBe('exit 3');
    expect(exitOutcome({ exitCode: 0, stream: emptyStream() }).output.summary).toBeNull();
  });

  it('cuts the error at errorMax', () => {
    expect(exitOutcome({ exitCode: 2, stream, stderrTail: 'e'.repeat(3000) }).error?.length).toBe(2000);
  });
});
