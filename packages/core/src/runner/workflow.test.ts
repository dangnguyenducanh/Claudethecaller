import { afterEach, describe, expect, it } from 'vitest';
import { NODE_TYPES, childId, evalCondition, outText, parseChildId, parseWorkflow, planFanout, renderTemplate, scopeOf, workflowLimits } from './index.ts';

const DEFAULTS = { ...workflowLimits };
afterEach(() => Object.assign(workflowLimits, DEFAULTS));

const T = { id: 't', type: 'trigger' };
const sh = (id: string, run = 'true', o: object = {}) => ({ id, type: 'shell', run, ...o });
const ag = (id: string, prompt = 'p', o: object = {}) => ({ id, type: 'agent', agent: 'claude', prompt, ...o });
const chain = (...ids: string[]) => ids.slice(1).map((to, i) => ({ from: ids[i], to }));
const doc = (nodes: object[], edges: object[] = [], extra: object = {}) => ({ name: 'x', nodes: [T, ...nodes], edges, ...extra });
const errors = (src: unknown): string[] => {
  const r = parseWorkflow(src);
  expect(r.ok).toBe(false);
  return r.ok ? [] : r.errors;
};

describe('limits and names (D2, D9)', () => {
  it('pins the default limits and the node types', () => {
    expect(DEFAULTS).toEqual({
      maxNodes: 200, maxEdges: 1000, idMax: 64, textMax: 20000, fanoutItemsMax: 20, fanoutParallelMax: 3, itemMax: 2000, defaultMaxVisits: 3, shellTimeoutS: 600, outTailChars: 4000,
    });
    expect([...NODE_TYPES]).toEqual(['trigger', 'agent', 'shell', 'if', 'approval', 'merge', 'fanout', 'join']);
  });

  it('maxNodes is inclusive and read at call time', () => {
    workflowLimits.maxNodes = 3;
    expect(parseWorkflow(doc([sh('a'), sh('b')], chain('t', 'a', 'b'))).ok).toBe(true);
    expect(errors(doc([sh('a'), sh('b'), sh('c')]))).toContain('workflow has too many nodes');
  });

  it('a fan-out may create fanoutItemsMax items, one more is an error and nothing is cut', () => {
    const node = { id: 'f', over: '{{l}}' };
    const list = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => `i${i}`));
    expect(planFanout(node, { l: list(20) }).ok).toBe(true);
    expect(planFanout(node, { l: list(21) })).toEqual({ ok: false, error: 'fanout: 21 items exceeds 20' });
    workflowLimits.fanoutItemsMax = 2;
    expect(planFanout(node, { l: list(2) }).ok).toBe(true);
    expect(planFanout(node, { l: list(3) }).ok).toBe(false);
    expect(planFanout({ id: 'f', over: '{{l}}' }, { l: JSON.stringify(['x'.repeat(2001)]) })).toEqual({ ok: false, error: 'fanout: bad items' });
  });
});

describe('parseWorkflow (D3, D4, D5, D10)', () => {
  it('applies the defaults and reads YAML, JSON and CRLF text alike', () => {
    const r = parseWorkflow(doc([ag('a'), sh('s'), { id: 'g', type: 'approval', question: 'q' }, { id: 'i', type: 'if', op: 'truthy', left: '1' }], chain('t', 'a', 's')));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const n = (id: string) => r.workflow.nodes.find((x) => x.id === id);
    expect([n('a')?.worktree, n('a')?.permission, n('a')?.timeoutS]).toEqual(['new', 'acceptEdits', 1800]);
    expect([n('s')?.cwd, n('s')?.timeoutS]).toEqual(['worktree', 600]);
    expect(n('g')?.options).toEqual([{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }]);
    expect(n('i')?.right).toBe('');
    expect(r.workflow.maxVisits).toBe(3);
    expect(Object.keys(r.workflow).sort()).toEqual(['description', 'edges', 'inputs', 'maxVisits', 'name', 'nodes']);
    const text = 'name: crlf\r\nnodes:\r\n  - {id: t, type: trigger}\r\n  - {id: a, type: shell, run: "echo hi"}\r\nedges:\r\n  - {from: t, to: a}\r\n';
    expect(parseWorkflow(text).ok).toBe(true);
    expect(parseWorkflow(JSON.stringify(doc([sh('a')], chain('t', 'a'))))).toEqual(parseWorkflow(doc([sh('a')], chain('t', 'a'))));
  });

  it('max_visits comes from the file, then the option, then 3', () => {
    expect(parseWorkflow(doc([], [], { max_visits: 5 }), { maxVisits: 7 })).toMatchObject({ ok: true, workflow: { maxVisits: 5 } });
    expect(parseWorkflow(doc([]), { maxVisits: 7 })).toMatchObject({ ok: true, workflow: { maxVisits: 7 } });
  });

  it('never throws on junk and edits nothing', () => {
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    for (const junk of [null, undefined, 5, true, [], '', 'x: [', '{', { nodes: 'no' }, { nodes: [null, 5, 'x'] }, { nodes: [T], edges: 5 }, cycle]) {
      const r = parseWorkflow(junk);
      expect(r.ok).toBe(false);
      expect(r.ok ? [] : r.errors.length).toBeGreaterThan(0);
    }
    const frozen = Object.freeze(doc([sh('a')], chain('t', 'a')));
    expect(parseWorkflow(frozen).ok).toBe(true);
  });

  it('refuses bypassPermissions and any other permission, unknown agents and node types', () => {
    expect(errors(doc([ag('a', 'p', { permission: 'bypassPermissions' })]))).toContain('node a: permission "bypassPermissions" is not allowed');
    expect(errors(doc([ag('a', 'p', { agent: 'gemini' })]))).toContain('node a: unknown agent "gemini"');
    expect(errors(doc([{ id: 'a', type: 'wizard' }]))).toContain('node a: unknown type "wizard"');
    expect(errors(doc([sh('a'), sh('a')]))).toContain('node a: duplicate id');
    expect(errors(doc([sh('input')]))).toContain('node input: invalid id');
    expect(errors({ name: 'x', nodes: [T, { ...T, id: 't2' }] })).toContain('workflow needs exactly one trigger');
  });

  it('refuses a fan-out inside a fan-out, a child that keeps a worktree, max_parallel over 3 and a join not fed by a fan-out', () => {
    const child = { type: 'agent', agent: 'claude', prompt: 'p' };
    expect(errors(doc([{ id: 'f', type: 'fanout', over: '2', child: { type: 'fanout', over: '2', child } }]))).toContain('node f: fanout depth exceeded (max_depth 1)');
    expect(errors(doc([{ id: 'f', type: 'fanout', over: '2', child: { ...child, worktree: 'parent' } }]))).toContain('node f: fanout child must use worktree new');
    expect(errors(doc([{ id: 'f', type: 'fanout', over: '2', max_parallel: 4, child }]))).toContain('node f: max_parallel must be 1 to 3');
    expect(errors(doc([{ id: 'j', type: 'join' }], [{ from: 't', to: 'j' }]))).toContain('join j: needs exactly one incoming edge, from a fanout node');
  });

  it.each(['echo "{{input.m}}"', "echo '{{input.m}}'", 'echo \\{{input.m}}', 'echo "a $(echo {{input.m}})"'])('a shell line with %s is refused', (run) => {
    expect(errors(doc([sh('p', run)], chain('t', 'p'))).join('\n')).toContain('node p: a {{placeholder}} in run must not sit inside quotes');
  });
  it('a bare placeholder, and one after a closed quote, is fine in a shell line', () => {
    expect(parseWorkflow(doc([sh('p', 'echo "a" {{input.m}} \'b\' {{p.out}}')], chain('t', 'p'))).ok).toBe(true);
  });
  it.each(['git -C . push origin main', 'git -c core.x=1 push', 'git --no-pager push', 'gh api -X PUT repos/o/r/pulls/1/merge', 'gh -R o/r pr merge 1'])('%s needs an approval node', (run) => {
    expect(errors(doc([sh('p', run)], chain('t', 'p')))).toContain('node p: git push or gh pr needs an approval node on every path before it');
  });
  it('a git push or gh pr needs an approval on every path before it', () => {
    const msg = (id: string) => `node ${id}: git push or gh pr needs an approval node on every path before it`;
    expect(errors(doc([sh('p', 'git push origin main')], chain('t', 'p')))).toContain(msg('p'));
    expect(errors(doc([ag('p', 'then run gh pr create now')], chain('t', 'p')))).toContain(msg('p'));
    const gate = { id: 'g', type: 'approval', question: 'q' };
    expect(parseWorkflow(doc([gate, sh('p', 'git push')], chain('t', 'g', 'p'))).ok).toBe(true);
    const avoid = doc([gate, sh('x'), sh('p', 'git push')], [{ from: 't', to: 'g' }, { from: 't', to: 'x' }, { from: 'g', to: 'p' }, { from: 'x', to: 'p' }]);
    expect(errors(avoid)).toContain(msg('p'));
  });

  it('edge handles true and "true" are the same handle; a bad handle names the edge', () => {
    const r = parseWorkflow(doc([{ id: 'i', type: 'if', op: 'eq', left: 'a' }, sh('a'), sh('b')], [{ from: 'i', to: 'a', handle: true }, { from: 'i', to: 'b', handle: 'false' }]));
    expect(r.ok && r.workflow.edges.map((e) => e.handle)).toEqual(['true', 'false']);
    expect(errors(doc([sh('a')], [{ from: 't', to: 'a', handle: 'maybe' }]))).toContain('edge 0: invalid handle "maybe"');
    expect(errors(doc([sh('a')], [{ from: 't', to: 'zz' }]))).toContain('edge 0: unknown node "zz"');
  });
});

describe('templates and conditions (D11, D17)', () => {
  it('renders own keys only, lists missing names, never rescans', () => {
    expect(renderTemplate('x {{ a.b }} y {{c}}', { 'a.b': 'AB', c: 7 })).toEqual({ text: 'x AB y 7', missing: [] });
    expect(renderTemplate('{{constructor}}{{__proto__}}', {})).toEqual({ text: '', missing: ['constructor', '__proto__'] });
    expect(renderTemplate('{{a}}', { a: '{{b}}', b: 'no' }).text).toBe('{{b}}');
    expect(renderTemplate(5, {}).text).toBe('');
  });

  it('quotes every substituted value for a shell line', () => {
    expect(renderTemplate('echo {{a}} {{gone}}!', { a: "it's" }, { shell: true })).toEqual({ text: "echo 'it'\\''s' ''!", missing: ['gone'] });
    expect(renderTemplate('{{a}}', { a: '$(rm -rf /); `x`' }, { shell: true }).text).toBe("'$(rm -rf /); `x`'");
  });

  it('scopeOf and outText give strings by node type', () => {
    expect(scopeOf({ inputs: { topic: 'w', n: 3, list: ['a'] }, outputs: { plan: { out: 'P', exit: 0 } }, resolution: 'merge', item: 'it', index: 2 })).toEqual({
      'input.topic': 'w', 'input.n': '3', 'input.list': '["a"]', 'plan.out': 'P', 'plan.exit': '0', resolution: 'merge', item: 'it', index: '2',
    });
    expect(outText({ type: 'agent' }, { summary: 'S' })).toBe('S');
    expect(outText({ type: 'shell' }, { stdoutTail: 'T' })).toBe('T');
    expect(outText({ type: 'approval' }, { choice: 'merge' })).toBe('merge');
    expect(outText({ type: 'if' }, { handle: 'false' })).toBe('false');
    expect(outText({ type: 'join', strategy: 'collect' }, { results: ['a', 'b'] })).toBe('["a","b"]');
    expect(outText({ type: 'join', strategy: 'merge' }, { summary: 'merged 3 branches' })).toBe('merged 3 branches');
    expect(outText(null, 5)).toBe('');
  });

  it('evalCondition trims both sides and knows the truthy list', () => {
    expect(evalCondition('eq', ' a ', 'a')).toBe(true);
    expect(evalCondition('ne', 'a', 'b')).toBe(true);
    expect(evalCondition('contains', 'hello world', 'lo w')).toBe(true);
    for (const v of ['', ' FALSE ', '0', 'No', 'null']) expect(evalCondition('truthy', v, '')).toBe(false);
    expect(evalCondition('truthy', 'yes', '')).toBe(true);
    expect(evalCondition('zzz', 'a', 'a')).toBe(false);
  });

  it('plans a fan-out from a number, a JSON array or lines; child ids round-trip', () => {
    expect(planFanout({ over: 3 }, {})).toEqual({ ok: true, items: ['1', '2', '3'] });
    expect(planFanout({ over: '{{l}}' }, { l: 'a\n\n  b \n' })).toEqual({ ok: true, items: ['a', 'b'] });
    expect(planFanout({ over: '{{l}}' }, { l: '["a",{"k":1}]' })).toEqual({ ok: true, items: ['a', '{"k":1}'] });
    expect(planFanout(null, {}).ok).toBe(false);
    expect(childId('f', 0)).toBe('f[0]');
    expect(parseChildId('f[12]')).toEqual({ fanoutId: 'f', index: 12 });
    expect(parseChildId('f')).toBeNull();
  });
});
