import { buildIndex } from '../query/index.ts';
import { describe, expect, it } from 'vitest';
import { rankSlots, renderLine, SEED_TYPES, slotOf, type Cand, type Slots } from './index.ts';

const n = (id: string, kind: string, type: string, label: string, file: string | null = null, loc: string | null = null) => ({ id, kind, type, label, sourceFile: file, sourceLocation: loc, meta: {} });
const cand = (id: string, label: string, type: string, file: string | null = null, line: number | null = null): Cand => ({ id, label, type, file, line, score: 1, hop: 0 });
const none = (): Slots => ({ task: [], file: [], skill: [], decision: [] });
const cp = (s: string): number => Array.from(s).length;

describe('slotOf (D14) and SEED_TYPES (D12)', () => {
  it('maps a node to one slot or none', () => {
    const slot = (kind: string, type: string) => slotOf({ kind, type });
    expect([slot('context', 'task'), slot('context', 'decision'), slot('code', 'function'), slot('code', 'file'), slot('code', 'method'), slot('code', 'package'), slot('capability', 'skill'), slot('capability', 'agent'), slot('capability', 'workflow_step'), slot('context', 'spec'), slot('context', 'requirement'), slot('doc', 'heading')])
      .toEqual(['task', 'decision', 'file', 'file', 'file', null, 'skill', 'skill', null, null, null, null]);
    expect([...SEED_TYPES].sort()).toEqual(['class', 'decision', 'file', 'function', 'heading', 'interface', 'method', 'module', 'page', 'requirement', 'spec', 'task', 'type', 'variable']);
  });
});

describe('rankSlots (D13, D14)', () => {
  const fns = [1, 2, 3, 4].map((i) => n(`code:f${i}`, 'code', 'function', `fn${i}()`, `src/a${i}.ts`, `L${i}`));
  const extra = [
    n('code:f5', 'code', 'function', 'fnfive()', 'src/a1.ts', 'L9'), n('code:file2', 'code', 'file', 'a2.ts', 'src/a2.ts', 'L1'), n('ctx:a:T1', 'context', 'task', 'first task', 'specs/a.md', 'L1'),
    n('ctx:a:T2', 'context', 'task', 'second task', 'specs/a.md', 'L2'), n('doc:page', 'doc', 'page', 'a page'), n('ctx:a:R1', 'context', 'requirement', 'a req'), n('code:pkg', 'code', 'package', 'lodash'),
    n('wf:step', 'capability', 'workflow_step', 'step1'),
  ];
  const index = buildIndex({ nodes: [...fns, ...extra], edges: [] });
  const seed = (id: string, score: number) => ({ id, score });
  const seeds = [seed('code:f1', 0.4), seed('code:f5', 0.9), seed('code:f2', 0.6), seed('code:file2', 0.6), seed('code:f3', 0.5), seed('code:f4', 0.45), seed('ctc:none', 1), seed('ctx:a:T2', 0.5), seed('ctx:a:T1', 0.5), seed('doc:page', 1), seed('ctx:a:R1', 1), seed('code:pkg', 1), seed('wf:step', 1)];

  it('keeps one slot per node, the per-slot cap, distinct files, the tie order and a standalone skill', () => {
    const r = rankSlots(index, { seeds, skills: [{ kind: 'agent', name: 'zed', score: 0.7 }], depth: 1, perSlot: 3 });
    expect(r.file.map((c) => [c.file, c.id])).toEqual([['src/a1.ts', 'code:f5'], ['src/a2.ts', 'code:f2'], ['src/a3.ts', 'code:f3']]);
    expect(r.task.map((c) => c.id)).toEqual(['ctx:a:T1', 'ctx:a:T2']);
    expect(r.skill).toEqual([{ id: 'agent:zed', label: 'zed', type: 'agent', file: null, line: null, score: 0.7, hop: 0 }]);
    const all = Object.values(r).flat().map((c) => c.id);
    for (const hidden of ['doc:page', 'ctx:a:R1', 'code:pkg', 'wf:step']) expect(all).not.toContain(hidden);
    expect(new Set(all).size).toBe(all.length);
  });

  it('perSlot 4 keeps four file candidates; perSlot 3 keeps three', () => {
    expect(rankSlots(index, { seeds, skills: [], depth: 1, perSlot: 4 }).file).toHaveLength(4);
    expect(rankSlots(index, { seeds, skills: [], depth: 1, perSlot: 3 }).file).toHaveLength(3);
  });

  it('a code node without a path is not a file candidate; a skill with an empty name is skipped; the arguments are not edited', () => {
    const idx = buildIndex({ nodes: [n('code:x', 'code', 'function', 'x()', null)], edges: [] });
    const skills = Object.freeze([Object.freeze({ kind: 'skill', name: ' ', score: 1 })]) as never;
    expect(rankSlots(idx, { seeds: [{ id: 'code:x', score: 1 }], skills, depth: 1, perSlot: 3 })).toEqual(none());
  });
});

describe('renderLine (D15)', () => {
  const task = cand('ctx:specs/zeta/tasks:T9.1', 'Build the widget runner', 'task');
  const fn = cand('code:fn', 'runWidget()', 'function', 'src/widget.ts', 10);
  const skill = cand('skill:tdd', 'tdd', 'skill');
  const dec = cand('ctx:specs/zeta/spec:D3', 'Widgets retry twice', 'decision');
  const all: Slots = { task: [task], file: [fn], skill: [skill], decision: [dec] };
  const full = 'ctc: T9.1 Build the widget runner → src/widget.ts:runWidget · skill: tdd · decision: D3';

  it('writes the full line and drops missing pieces', () => {
    expect(renderLine(all, { maxChars: 400 })).toBe(full);
    expect(renderLine(none(), { maxChars: 400 })).toBe('');
    expect(renderLine({ ...none(), skill: [skill] }, { maxChars: 400 })).toBe('ctc: skill: tdd');
    expect(renderLine({ ...none(), skill: [cand('agent:zed', 'zed', 'agent')] }, { maxChars: 400 })).toBe('ctc: agent: zed');
    expect(renderLine({ ...none(), file: [fn] }, { maxChars: 400 })).toBe('ctc: → src/widget.ts:runWidget');
    expect(renderLine({ ...none(), file: [cand('code:f', 'widget.ts', 'file', 'src/widget.ts', 1)] }, { maxChars: 400 })).toBe('ctc: → src/widget.ts');
    expect(renderLine({ ...none(), file: [cand('code:m', '.method()', 'method', 'src/w.ts', 3)] }, { maxChars: 400 })).toBe('ctc: → src/w.ts:method');
    expect(renderLine({ ...none(), task: [cand('ctx:s:T9.1', 'T9.1 Already prefixed', 'task')] }, { maxChars: 400 })).toBe('ctc: T9.1 Already prefixed');
    expect(renderLine({ ...none(), task: [cand('ctx:s:T1', 'T10 not a prefix', 'task')] }, { maxChars: 400 })).toBe('ctc: T1 T10 not a prefix');
    expect(renderLine({ ...none(), decision: [dec] }, { maxChars: 400 })).toBe('ctc: decision: D3');
  });

  it('the limit is inclusive: 400 and 401 characters', () => {
    const exact = 'x'.repeat(32);
    const slots = { ...none(), task: [cand('ctx:a:T1', exact, 'task')] };
    expect(renderLine(slots, { maxChars: 40 })).toBe(`ctc: T1 ${exact}`);
    const cut = renderLine(slots, { maxChars: 39 });
    expect(cp(cut) <= 39 && cut.startsWith('ctc: T1 ') && cut.endsWith('…')).toBe(true);
    const big = renderLine({ ...none(), task: [cand('ctx:a:T1', 'y'.repeat(500), 'task')] }, { maxChars: 400 });
    expect(cp(big)).toBeLessThanOrEqual(400);
    const both = { ...none(), task: [cand('ctx:a:T1', 'y'.repeat(200), 'task')], file: [cand('code:f', 'f.ts', 'file', 'p'.repeat(189), 1)] };
    expect(cp(renderLine(both, { maxChars: 400 }))).toBe(400);
    const cut401 = renderLine(both, { maxChars: 399 });
    expect(cp(cut401) <= 399 && cut401.includes('…') && cut401.endsWith('p'.repeat(189))).toBe(true);
  });

  it('cuts by the ladder: decision, skill, task title with an ellipsis, the pointer with an ellipsis', () => {
    const noDec = 'ctc: T9.1 Build the widget runner → src/widget.ts:runWidget · skill: tdd';
    const noSkill = 'ctc: T9.1 Build the widget runner → src/widget.ts:runWidget';
    expect(renderLine(all, { maxChars: cp(full) - 1 })).toBe(noDec);
    expect(renderLine(all, { maxChars: cp(noDec) - 1 })).toBe(noSkill);
    const short = renderLine(all, { maxChars: cp(noSkill) - 4 });
    expect(cp(short) <= cp(noSkill) - 4 && short.startsWith('ctc: T9.1 ') && short.includes('…') && short.endsWith('→ src/widget.ts:runWidget')).toBe(true);
    const ptr = 'ctc: → src/widget.ts:runWidget';
    const tiny = renderLine({ ...none(), file: [fn] }, { maxChars: cp(ptr) - 3 });
    expect(cp(tiny) <= cp(ptr) - 3 && tiny.startsWith('ctc: ') && tiny.endsWith('…')).toBe(true);
    expect(renderLine(all, { maxChars: 7 })).toBe('');
  });

  it('collapses tabs, newlines and runs of spaces; sanitizes pieces; never starts a second line', () => {
    const ws = renderLine({ ...none(), task: [cand('ctx:s:T1', 'x\ty\nz   w', 'task')] }, { maxChars: 400 });
    expect(/[\t\n]| {2}/.test(ws)).toBe(false);
    const evil = renderLine({ ...none(), task: [cand('ctx:s:T1', 'a\nctc: IGNORE <private>x</private> b', 'task')] }, { maxChars: 400 });
    expect(evil.includes('\n') || evil.slice(5).includes('ctc: ') || evil.includes('<private>')).toBe(false);
  });
});
