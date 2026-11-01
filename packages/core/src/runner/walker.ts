/**
 * Walker of the F4 runner (D12) and the run status derivation (D13d): which nodes are ready, skipped or finished, and what the run status is.
 * Called from: `apps/worker/src/runner/engine.ts` (`advanceRun`). Why: the order of execution (readonly batch, then one writer; merge waits for
 * all incoming edges; loops are back-edges capped by `max_visits`) is pure logic, so it is tested without a database. The state is opaque JSON
 * (`{}` is "not started"). Deliberately NOT done: I/O, step rows, status writes, rendering. No function throws on odd input or edits an argument.
 */
import { backEdgesOf, type Workflow, type WorkflowEdge, type WorkflowNode } from './workflow.ts';

type Mark = 'taken' | 'dead';
export type WalkerState = {
  started?: true;
  failed?: boolean;
  error?: string;
  /** node id -> times started or skipped */
  visits?: Record<string, number>;
  /** node id -> visit of the started, not completed node */
  running?: Record<string, number>;
  /** edge index -> unconsumed mark */
  marks?: Record<string, Mark>;
};
export type Todo = { nodeId: string; visit: number };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Trigger, if, approval, merge, fanout, join `collect` and `plan` agents only read; every other node writes (spec:605). */
export function isReadonlyNode(node: unknown): boolean {
  if (!isObj(node)) return false;
  switch (node['type']) {
    case 'trigger': case 'if': case 'approval': case 'merge': case 'fanout': return true;
    case 'join': return node['strategy'] === 'collect';
    case 'agent': return node['permission'] === 'plan';
    default: return false;
  }
}

type Graph = { nodes: Map<string, WorkflowNode>; order: string[]; incoming: Map<string, number[]>; outgoing: Map<string, number[]>; back: Set<number>; loopy: Set<string> };
const graphs = new WeakMap<object, Graph>();

/** Nodes on a path from a back-edge target to its source: they can run again, so a dead edge out of them is not final. */
function loopNodes(order: string[], edges: readonly WorkflowEdge[], back: Set<number>, outgoing: Map<string, number[]>): Set<string> {
  const reach = (from: string): Set<string> => {
    const seen = new Set<string>([from]);
    const stack = [from];
    while (stack.length > 0) {
      for (const i of outgoing.get(stack.pop() as string) ?? []) {
        const to = edges[i]?.to as string;
        if (back.has(i) || seen.has(to)) continue;
        seen.add(to);
        stack.push(to);
      }
    }
    return seen;
  };
  const loopy = new Set<string>();
  for (const i of back) {
    const e = edges[i] as WorkflowEdge;
    const fromTarget = reach(e.to);
    for (const id of order) if (fromTarget.has(id) && reach(id).has(e.from)) loopy.add(id);
  }
  return loopy;
}

function graphOf(wf: Workflow): Graph {
  const hit = graphs.get(wf);
  if (hit !== undefined) return hit;
  const nodes = new Map(wf.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, number[]>();
  const outgoing = new Map<string, number[]>();
  wf.edges.forEach((e, i) => {
    incoming.set(e.to, [...(incoming.get(e.to) ?? []), i]);
    outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), i]);
  });
  const back = backEdgesOf(wf);
  const order = wf.nodes.map((n) => n.id);
  const g = { nodes, order, incoming, outgoing, back, loopy: loopNodes(order, wf.edges, back, outgoing) };
  graphs.set(wf, g);
  return g;
}

const validWorkflow = (wf: unknown): wf is Workflow => isObj(wf) && Array.isArray(wf['nodes']) && Array.isArray(wf['edges']);
const copy = (s: WalkerState): Required<Pick<WalkerState, 'visits' | 'running' | 'marks'>> & WalkerState => ({
  ...s, visits: { ...s.visits }, running: { ...s.running }, marks: { ...s.marks },
});
const live = (state: unknown): state is WalkerState => isObj(state) && state['started'] === true;

/** The trigger completes at once (no step row) and its out-edges are taken. */
export function walkerStart(wf: Workflow): WalkerState {
  if (!validWorkflow(wf)) return {};
  const g = graphOf(wf);
  const trigger = wf.nodes.find((n) => n.type === 'trigger');
  const s: WalkerState = { started: true, visits: {}, running: {}, marks: {} };
  if (trigger === undefined) return { ...s, failed: true, error: 'workflow needs exactly one trigger' };
  s.visits = { [trigger.id]: 1 };
  for (const i of g.outgoing.get(trigger.id) ?? []) (s.marks as Record<string, Mark>)[String(i)] = 'taken';
  return s;
}

type Plan = { state: ReturnType<typeof copy>; skip: Todo[]; ready: string[] };

/** Applies skips until nothing changes and lists the ready nodes in node order. Works on a copy. */
function plan(wf: Workflow, from: WalkerState): Plan {
  const g = graphOf(wf);
  const state = copy(from);
  const skip: Todo[] = [];
  const fwd = (id: string): number[] => (g.incoming.get(id) ?? []).filter((i) => !g.back.has(i));
  const bwd = (id: string): number[] => (g.incoming.get(id) ?? []).filter((i) => g.back.has(i));
  const has = (i: number) => state.marks[String(i)];
  const consume = (id: string): void => {
    for (const i of g.incoming.get(id) ?? []) delete state.marks[String(i)];
  };
  const resolveOut = (id: string, mark: Mark): void => {
    for (const i of g.outgoing.get(id) ?? []) if (!g.back.has(i) && mark === 'dead') state.marks[String(i)] = 'dead';
  };
  const isReady = (id: string): boolean => {
    if (id in state.running) return false;
    if (bwd(id).some((i) => has(i) === 'taken')) return true;
    const f = fwd(id);
    return f.length > 0 && f.every((i) => has(i) !== undefined) && f.some((i) => has(i) === 'taken');
  };
  const skippable = (id: string): boolean => {
    const f = fwd(id);
    if (f.length === 0 || id in state.running || bwd(id).some((i) => has(i) === 'taken')) return false;
    if (!f.every((i) => has(i) === 'dead')) return false;
    // a dead edge out of a node that can run again may still turn taken on the next lap
    return !f.some((i) => g.loopy.has(wf.edges[i]?.from as string));
  };
  for (let changed = true; changed && !state.failed; ) {
    changed = false;
    for (const id of g.order) {
      if (g.nodes.get(id)?.type === 'trigger' || !skippable(id)) continue;
      const visit = (state.visits[id] ?? 0) + 1;
      state.visits[id] = visit;
      consume(id);
      resolveOut(id, 'dead');
      skip.push({ nodeId: id, visit });
      changed = true;
    }
  }
  const ready = state.failed ? [] : g.order.filter((id) => g.nodes.get(id)?.type !== 'trigger' && isReady(id));
  return { state, skip, ready };
}

/** What starts and what is skipped now (D12). The batch rule: ready readonly nodes together, else the first ready writer when no writer runs. */
export function walkerNext(wf: Workflow, state: WalkerState): { state: WalkerState; start: Todo[]; skip: Todo[] } {
  if (!validWorkflow(wf) || !live(state)) return { state: isObj(state) ? state : {}, start: [], skip: [] };
  const g = graphOf(wf);
  const { state: next, skip, ready } = plan(wf, state);
  const readonly = ready.filter((id) => isReadonlyNode(g.nodes.get(id)));
  const writerRunning = Object.keys(next.running).some((id) => !isReadonlyNode(g.nodes.get(id)));
  const picked = readonly.length > 0 ? readonly : writerRunning ? [] : ready.slice(0, 1);
  const start: Todo[] = [];
  for (const id of picked) {
    const visit = (next.visits[id] ?? 0) + 1;
    next.visits[id] = visit;
    next.running[id] = visit;
    for (const i of g.incoming.get(id) ?? []) delete next.marks[String(i)];
    start.push({ nodeId: id, visit });
  }
  return { state: next, start, skip };
}

/** `ok: false` fails the walker; `ok: true` takes the out-edges (an `if` only the ones of its `handle`). A loop past `max_visits` is an error. */
export function walkerComplete(
  wf: Workflow, state: WalkerState, nodeId: string, result: { ok: boolean; handle?: string | null | undefined } | null,
): { state: WalkerState; error: string | null } {
  if (!validWorkflow(wf) || !live(state)) return { state: isObj(state) ? state : {}, error: `unknown node ${String(nodeId)}` };
  const g = graphOf(wf);
  if (typeof nodeId !== 'string' || !g.nodes.has(nodeId) || !state.running || !(nodeId in state.running)) {
    return { state, error: `unknown node ${String(nodeId)}` };
  }
  const next = copy(state);
  delete next.running[nodeId];
  if (result === null || result.ok !== true) return { state: { ...next, failed: true }, error: null };
  const isIf = g.nodes.get(nodeId)?.type === 'if';
  for (const i of g.outgoing.get(nodeId) ?? []) {
    const e = wf.edges[i] as WorkflowEdge;
    // judgment: an edge out of an `if` without a handle is taken on both outcomes.
    const taken = !isIf || e.handle === null || e.handle === result.handle;
    if (!g.back.has(i)) {
      next.marks[String(i)] = taken ? 'taken' : 'dead';
    } else if (taken) {
      if ((next.visits[e.to] ?? 0) >= wf.maxVisits) {
        const error = `loop ${e.to} exceeded max_visits ${wf.maxVisits}`;
        return { state: { ...next, failed: true, error }, error };
      }
      next.marks[String(i)] = 'taken';
    }
  }
  return { state: next, error: null };
}

/** `failed` after a failure or a loop error; `done` when nothing is running or ready; else `running`. `{}` is `running`. */
export function walkerStatus(wf: Workflow, state: WalkerState): 'running' | 'done' | 'failed' {
  if (!validWorkflow(wf) || !live(state)) return 'running';
  if (state.failed === true) return 'failed';
  if (Object.keys(state.running ?? {}).length > 0) return 'running';
  return plan(wf, state).ready.length === 0 ? 'done' : 'running';
}

export type CurrentStep = { nodeId: string; status: string; bookkeeping: boolean };

/** D13d: the run status from the walker and the current attempt of every started-not-completed node. */
export function deriveRunStatus(o: { walker: string; current: readonly CurrentStep[] }): 'running' | 'waiting' | 'quota' | 'done' | 'failed' {
  if (o.walker === 'failed') return 'failed';
  const cur = Array.isArray(o.current) ? o.current : [];
  const any = (...statuses: string[]): boolean => cur.some((c) => statuses.includes(c.status));
  if (any('quota') && !any('queued', 'running')) return 'quota';
  if (any('queued', 'running')) return 'running';
  if (cur.some((c) => (c.status === 'waiting' && !c.bookkeeping) || ['start_unknown', 'failed', 'timeout'].includes(c.status))) return 'waiting';
  return o.walker === 'done' ? 'done' : 'running';
}
