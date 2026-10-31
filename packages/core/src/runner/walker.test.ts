import { describe, expect, it } from 'vitest';
import { deriveRunStatus, isReadonlyNode, parseWorkflow, walkerComplete, walkerNext, walkerStart, walkerStatus, type Workflow, type WalkerState } from './index.ts';

const T = { id: 't', type: 'trigger' };
const sh = (id: string) => ({ id, type: 'shell', run: 'true' });
const ag = (id: string, o: object = {}) => ({ id, type: 'agent', agent: 'claude', prompt: 'p', ...o });
const chain = (...ids: string[]) => ids.slice(1).map((to, i) => ({ from: ids[i], to }));
const P = (nodes: object[], edges: object[]): Workflow => {
  const r = parseWorkflow({ name: 'w', nodes: [T, ...nodes], edges });
  if (!r.ok) throw new Error(r.errors.join(';'));
  return Object.freeze(r.workflow) as Workflow;
};
const clone = (s: WalkerState): WalkerState => JSON.parse(JSON.stringify(s)) as WalkerState;
const done = (w: Workflow, s: WalkerState, id: string, r: { ok: boolean; handle?: string } = { ok: true }) => walkerComplete(w, clone(s), id, r);

describe('walker (D12)', () => {
  it('runs a chain one node at a time and is done after the last', () => {
    const w = P([sh('a'), sh('b')], chain('t', 'a', 'b'));
    const s = walkerStart(w);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    expect(walkerStatus(w, s)).toBe('running');
    let n = walkerNext(w, s);
    expect(n.start).toEqual([{ nodeId: 'a', visit: 1 }]);
    expect(walkerNext(w, n.state).start).toEqual([]);
    n = walkerNext(w, done(w, n.state, 'a').state);
    expect(n.start).toEqual([{ nodeId: 'b', visit: 1 }]);
    expect(walkerStatus(w, done(w, n.state, 'b').state)).toBe('done');
  });

  it('an if skips the dead branch and a merge waits for every incoming edge', () => {
    const w = P([{ id: 'i', type: 'if', op: 'truthy', left: 'x' }, sh('x'), sh('y'), { id: 'm', type: 'merge' }, sh('z')],
      [{ from: 't', to: 'i' }, { from: 'i', to: 'x', handle: 'true' }, { from: 'i', to: 'y', handle: 'false' }, { from: 'x', to: 'm' }, { from: 'y', to: 'm' }, { from: 'm', to: 'z' }]);
    let n = walkerNext(w, walkerStart(w));
    n = walkerNext(w, done(w, n.state, 'i', { ok: true, handle: 'false' }).state);
    expect(n.skip).toEqual([{ nodeId: 'x', visit: 1 }]);
    expect(n.start).toEqual([{ nodeId: 'y', visit: 1 }]);
    n = walkerNext(w, done(w, n.state, 'y').state);
    expect(n.start).toEqual([{ nodeId: 'm', visit: 1 }]);
    expect(walkerNext(w, done(w, n.state, 'm').state).start).toEqual([{ nodeId: 'z', visit: 1 }]);
  });

  it('starts ready readonly nodes together, then one writer at a time', () => {
    const w = P([ag('r1', { permission: 'plan' }), ag('r2', { permission: 'plan' }), sh('w1'), sh('w2')], [{ from: 't', to: 'w1' }, { from: 't', to: 'r1' }, { from: 't', to: 'w2' }, { from: 't', to: 'r2' }]);
    let n = walkerNext(w, walkerStart(w));
    expect(n.start.map((x) => x.nodeId)).toEqual(['r1', 'r2']);
    n = walkerNext(w, done(w, done(w, n.state, 'r1').state, 'r2').state);
    expect(n.start.map((x) => x.nodeId)).toEqual(['w1']);
    expect(walkerNext(w, n.state).start).toEqual([]);
    expect(walkerNext(w, done(w, n.state, 'w1').state).start.map((x) => x.nodeId)).toEqual(['w2']);
    expect([isReadonlyNode({ type: 'if' }), isReadonlyNode({ type: 'join', strategy: 'collect' }), isReadonlyNode({ type: 'join', strategy: 'merge' }), isReadonlyNode(null)]).toEqual([true, true, false, false]);
  });

  it('a back-edge re-enters its target until max_visits, then the walker fails with the loop error', () => {
    const w = P([sh('n'), { id: 'i', type: 'if', op: 'truthy', left: '0' }, sh('f')], [{ from: 't', to: 'n' }, { from: 'n', to: 'i' }, { from: 'i', to: 'f', handle: 'true' }, { from: 'i', to: 'n', handle: 'false' }]);
    const lap = (st: WalkerState, handle: string) => {
      let r = walkerNext(w, st);
      const visit = r.start[0]?.visit;
      r = walkerNext(w, done(w, r.state, 'n').state);
      return { visit, out: done(w, r.state, 'i', { ok: true, handle }) };
    };
    const l1 = lap(walkerStart(w), 'false');
    const l2 = lap(l1.out.state, 'false');
    const l3 = lap(l2.out.state, 'false');
    expect([l1.visit, l2.visit, l3.visit]).toEqual([1, 2, 3]);
    expect(l3.out.error).toBe('loop n exceeded max_visits 3');
    expect(walkerStatus(w, l3.out.state)).toBe('failed');
    const exit = lap(lap(walkerStart(w), 'false').out.state, 'true');
    expect(walkerNext(w, exit.out.state).start).toEqual([{ nodeId: 'f', visit: 1 }]);
  });

  it('a failed node stops the walk; odd input never throws and leaves the state alone', () => {
    const w = P([sh('a'), sh('b')], chain('t', 'a', 'b'));
    const failed = done(w, walkerNext(w, walkerStart(w)).state, 'a', { ok: false });
    expect(walkerStatus(w, failed.state)).toBe('failed');
    expect(walkerNext(w, failed.state).start).toEqual([]);
    expect(typeof walkerComplete(w, walkerStart(w), 'ghost', { ok: true }).error).toBe('string');
    expect(() => walkerComplete(w, {}, 'a', null)).not.toThrow();
    expect(() => walkerNext(w, null as never)).not.toThrow();
  });
});

describe('deriveRunStatus (D13d)', () => {
  const cs = (...st: string[]) => st.map((status, i) => ({ nodeId: `n${i}`, status, bookkeeping: false }));
  const d = (walker: string, current: ReturnType<typeof cs>) => deriveRunStatus({ walker, current });
  it('follows the steps', () => {
    expect(d('running', cs('running'))).toBe('running');
    expect(d('running', cs('queued'))).toBe('running');
    for (const s of ['waiting', 'start_unknown', 'failed', 'timeout']) expect(d('running', cs(s))).toBe('waiting');
    expect(d('running', cs('quota'))).toBe('quota');
    expect(d('running', cs('quota', 'running'))).toBe('running');
    expect(d('running', [{ nodeId: 'f', status: 'waiting', bookkeeping: true }, ...cs('running')])).toBe('running');
    expect(d('done', [])).toBe('done');
    expect(d('failed', cs('circuit_broken'))).toBe('failed');
    expect(d('running', [])).toBe('running');
  });
});
