/**
 * Workflow file format of the F4 runner (D10): node types, limits, and `parseWorkflow`, the one function that turns YAML or JSON text (or an
 * already parsed object) into a `Workflow`. Called from: `apps/worker/src/runner` (the engine loads the pinned version) and `apps/web/src/runs`
 * (start a run, show a workflow). Why: every rule about what a workflow may say (no `bypassPermissions`, no unguarded `git push`, fan-out depth 1)
 * is decided here once, before anything runs. Deliberately NOT done: any I/O (no `node:*` import), template rendering (./template.ts), walking.
 * Untrusted: the whole source. `parseWorkflow` never throws, never edits its argument and collects at most 50 one-line errors.
 */
import { parse as parseYaml } from 'yaml';

export const NODE_TYPES = ['trigger', 'agent', 'shell', 'if', 'approval', 'merge', 'fanout', 'join'] as const;

/**
 * Read at call time so a test can change and restore it (D2). `fanoutParallelMax`, `defaultMaxVisits`, `shellTimeoutS` and `fanoutItemsMax`'s
 * neighbours 3/3/600 are from the spec (spec:596, 601, 605); every other number is chosen by judgment.
 */
export const workflowLimits = {
  maxNodes: 200, maxEdges: 1000, idMax: 64, textMax: 20000, fanoutItemsMax: 20, fanoutParallelMax: 3, itemMax: 2000, defaultMaxVisits: 3,
  shellTimeoutS: 600, outTailChars: 4000,
};

export type FanoutChild = {
  agent: string; prompt: string; worktree: 'new'; permission: string; model: string | null; timeoutS: number; base: string | null;
};
/** Flat node: the fields that do not belong to its `type` are absent. `right` and `options` have defaults, see D10. */
export type WorkflowNode = {
  id: string;
  type: string;
  agent?: string; prompt?: string; worktree?: 'new' | 'parent' | 'none'; permission?: string; model?: string | null; timeoutS?: number; base?: string | null;
  run?: string; cwd?: 'worktree' | 'repo';
  op?: string; left?: string; right?: string;
  question?: string; options?: { id: string; label: string }[];
  over?: string | number; child?: FanoutChild; maxParallel?: number;
  strategy?: 'merge' | 'collect';
};
export type WorkflowEdge = { from: string; to: string; handle: string | null };
export type Workflow = {
  name: string; description: string | null; inputs: unknown; nodes: WorkflowNode[]; edges: WorkflowEdge[]; maxVisits: number;
};
export type ParseResult = { ok: true; workflow: Workflow } | { ok: false; errors: string[] };

/** A plain ref name: no leading `-`, no `..`, not ending in `.lock` (D1d). */
export const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/@-]{0,199}$/;
export const isRef = (v: unknown): v is string => typeof v === 'string' && REF_RE.test(v) && !v.includes('..') && !v.endsWith('.lock');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const OPTION_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const RESERVED = ['input', 'resolution', 'item', 'index', 'run'];
const AGENT_NAMES = ['claude', 'codex'];
const PERMISSION_NAMES = ['acceptEdits', 'dontAsk', 'plan'];
const OPS = ['eq', 'ne', 'contains', 'truthy'];
const ERROR_CAP = 50;
// global options may sit between `git` and `push` (`git -C . push`) and `gh api` can merge a PR; a false match only asks for an approval node
const PUSH = /\bgit\b[^;&|\n]*\bpush\b|\bgh\b[^;&|\n]*(\bpr\s+(create|merge)\b|\bapi\b[^;&|\n]*\b(merge|pulls?)\b)/;
const DEFAULT_OPTIONS = [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null);

/** DFS from the trigger over forward edges in node order; an edge to a node on the DFS stack is a back-edge (the loops). Indexes into `edges`. */
export function backEdgesOf(wf: Pick<Workflow, 'nodes' | 'edges'>): Set<number> {
  const order = new Map(wf.nodes.map((n, i) => [n.id, i]));
  const out = new Map<string, number[]>();
  wf.edges.forEach((e, i) => out.set(e.from, [...(out.get(e.from) ?? []), i]));
  const back = new Set<number>();
  const state = new Map<string, 1 | 2>();
  const trigger = wf.nodes.find((n) => n.type === 'trigger');
  if (trigger === undefined) return back;
  // iterative so a 200-node chain cannot overflow the stack
  const stack: { id: string; edges: number[]; i: number }[] = [];
  const enter = (id: string): void => {
    state.set(id, 1);
    const edges = [...(out.get(id) ?? [])].sort((a, b) => (order.get(wf.edges[a]?.to ?? '') ?? 0) - (order.get(wf.edges[b]?.to ?? '') ?? 0) || a - b);
    stack.push({ id, edges, i: 0 });
  };
  enter(trigger.id);
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top === undefined) break;
    const ei = top.edges[top.i++];
    if (ei === undefined) {
      state.set(top.id, 2);
      stack.pop();
      continue;
    }
    const to = wf.edges[ei]?.to ?? '';
    const s = state.get(to);
    if (s === 1) back.add(ei);
    else if (s === undefined) enter(to);
  }
  return back;
}

type Ctx = { errors: string[] };
const err = (c: Ctx, m: string): void => {
  if (c.errors.length < ERROR_CAP) c.errors.push(m);
};

/** True when a `{{...}}` of a shell line is inside a quoted span or right after a backslash: the value's own single quotes would then be live shell syntax. */
export function placeholderInQuotes(run: string): boolean {
  let quote = '';
  for (let i = 0; i < run.length; i++) {
    const ch = run[i];
    if (run.startsWith('{{', i) && quote !== '') return true;
    if (ch === '\\' && quote !== "'") {
      if (run.startsWith('{{', i + 1)) return true;
      i++;
    } else if (quote === '' && (ch === '"' || ch === "'")) quote = ch;
    else if (ch === quote) quote = '';
  }
  return false;
}

function agentBody(c: Ctx, id: string, src: Record<string, unknown>, child: boolean): Omit<FanoutChild, 'worktree'> & { worktree: string } {
  const agent = src['agent'];
  if (typeof agent !== 'string' || agent === '') err(c, `node ${id}: agent is required`);
  else if (!AGENT_NAMES.includes(agent)) err(c, `node ${id}: unknown agent "${agent}"`);
  const prompt = src['prompt'];
  if (typeof prompt !== 'string' || prompt === '') err(c, `node ${id}: prompt is required`);
  else if (prompt.length > workflowLimits.textMax) err(c, `node ${id}: prompt is too long`);
  const permission = src['permission'] ?? 'acceptEdits';
  if (typeof permission !== 'string' || !PERMISSION_NAMES.includes(permission)) err(c, `node ${id}: permission "${String(permission)}" is not allowed`);
  const worktree = src['worktree'] ?? 'new';
  if (child ? worktree !== 'new' : worktree !== 'new' && worktree !== 'parent' && worktree !== 'none') {
    err(c, child ? `node ${id}: fanout child must use worktree new` : `node ${id}: invalid worktree "${String(worktree)}"`);
  }
  const model = src['model'] ?? null;
  if (model !== null && typeof model !== 'string') err(c, `node ${id}: invalid model`);
  const timeoutS = src['timeout_s'] ?? 1800;
  if (typeof timeoutS !== 'number' || !Number.isInteger(timeoutS) || timeoutS < 1) err(c, `node ${id}: timeout_s must be a positive integer`);
  const base = src['base'] ?? null;
  if (base !== null && !isRef(base)) err(c, `node ${id}: invalid base`);
  return {
    agent: String(agent), prompt: String(prompt ?? ''), worktree: String(worktree), permission: String(permission), model: typeof model === 'string' ? model : null,
    timeoutS: typeof timeoutS === 'number' ? timeoutS : 1800, base: typeof base === 'string' ? base : null,
  };
}

function nodeOf(c: Ctx, src: Record<string, unknown>, id: string, type: string): WorkflowNode {
  const n: WorkflowNode = { id, type };
  const long = (field: string, v: string): string => {
    if (v.length > workflowLimits.textMax) err(c, `node ${id}: ${field} is too long`);
    return v;
  };
  if (type === 'agent') {
    const a = agentBody(c, id, src, false);
    Object.assign(n, { ...a, worktree: a.worktree as 'new' | 'parent' | 'none' });
  } else if (type === 'shell') {
    if (typeof src['run'] !== 'string' || src['run'] === '') err(c, `node ${id}: run is required`);
    else {
      n.run = long('run', src['run']);
      if (placeholderInQuotes(n.run)) err(c, `node ${id}: a {{placeholder}} in run must not sit inside quotes or follow a backslash (values are quoted for you)`);
    }
    const cwd = src['cwd'] ?? 'worktree';
    if (cwd !== 'worktree' && cwd !== 'repo') err(c, `node ${id}: invalid cwd "${String(cwd)}"`);
    n.cwd = cwd === 'repo' ? 'repo' : 'worktree';
    const t = src['timeout_s'] ?? workflowLimits.shellTimeoutS;
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 1) err(c, `node ${id}: timeout_s must be a positive integer`);
    n.timeoutS = typeof t === 'number' ? t : workflowLimits.shellTimeoutS;
  } else if (type === 'if') {
    const op = src['op'];
    if (typeof op !== 'string' || !OPS.includes(op)) err(c, `node ${id}: op is required`);
    n.op = typeof op === 'string' ? op : '';
    const left = text(src['left']);
    if (left === null) err(c, `node ${id}: left is required`);
    n.left = long('left', left ?? '');
    n.right = long('right', text(src['right']) ?? '');
  } else if (type === 'approval') {
    const q = src['question'];
    if (typeof q !== 'string' || q === '') err(c, `node ${id}: question is required`);
    n.question = long('question', typeof q === 'string' ? q : '');
    const o = src['options'];
    if (o === undefined || o === null) n.options = DEFAULT_OPTIONS.map((x) => ({ ...x }));
    else {
      const list = Array.isArray(o) ? o : [];
      const parsed = list.map((x) => (isObj(x) && typeof x['id'] === 'string' && OPTION_ID_RE.test(x['id']) ? { id: x['id'], label: typeof x['label'] === 'string' ? x['label'] : x['id'] } : null));
      const ids = new Set(parsed.map((x) => x?.id));
      if (!Array.isArray(o) || list.length < 1 || list.length > 8 || parsed.includes(null) || ids.size !== parsed.length) {
        err(c, `node ${id}: options must be 1 to 8 entries with unique ids`);
        n.options = [];
      } else n.options = parsed as { id: string; label: string }[];
    }
  } else if (type === 'fanout') {
    const over = src['over'];
    if (typeof over !== 'string' && typeof over !== 'number') err(c, `node ${id}: over is required`);
    else if (typeof over === 'string' && over.length > workflowLimits.textMax) err(c, `node ${id}: over is too long`);
    n.over = typeof over === 'string' || typeof over === 'number' ? over : '';
    const mp = src['max_parallel'] ?? workflowLimits.fanoutParallelMax;
    if (typeof mp !== 'number' || !Number.isInteger(mp) || mp < 1 || mp > workflowLimits.fanoutParallelMax) err(c, `node ${id}: max_parallel must be 1 to ${workflowLimits.fanoutParallelMax}`);
    n.maxParallel = typeof mp === 'number' ? mp : workflowLimits.fanoutParallelMax;
    const child = src['child'];
    if (!isObj(child)) err(c, `node ${id}: child is required`);
    else if (child['type'] === 'fanout' || child['child'] !== undefined) err(c, `node ${id}: fanout depth exceeded (max_depth 1)`);
    else {
      if (child['type'] !== undefined && child['type'] !== 'agent') err(c, `node ${id}: child must be an agent`);
      n.child = { ...agentBody(c, id, child, true), worktree: 'new' };
    }
  } else if (type === 'join') {
    const s = src['strategy'] ?? 'merge';
    if (s !== 'merge' && s !== 'collect') err(c, `node ${id}: strategy must be merge or collect`);
    n.strategy = s === 'collect' ? 'collect' : 'merge';
  }
  return n;
}

function normalizeHandle(h: unknown): string | null | undefined {
  if (h === undefined || h === null) return null;
  if (h === true || h === 'true') return 'true';
  if (h === false || h === 'false') return 'false';
  return undefined;
}

/** True when a shell/agent/fanout-child text would push or open a PR. */
const pushes = (n: WorkflowNode): boolean => PUSH.test(n.run ?? '') || PUSH.test(n.type === 'fanout' ? (n.child?.prompt ?? '') : (n.prompt ?? ''));

/**
 * `source` is YAML or JSON text, or a parsed object. Returns `{ ok: true, workflow }` or `{ ok: false, errors }` (D10 lists every error text).
 * `opts.maxVisits` is the default for `max_visits` (the file wins, then the option, then 3). Never throws, edits nothing.
 */
export function parseWorkflow(source: unknown, opts: { maxVisits?: number } = {}): ParseResult {
  const c: Ctx = { errors: [] };
  let doc: unknown = source;
  if (typeof source === 'string') {
    try {
      doc = parseYaml(source);
    } catch {
      return { ok: false, errors: ['workflow is not valid YAML or JSON'] };
    }
  }
  if (!isObj(doc)) return { ok: false, errors: ['workflow must be an object'] };
  const rawNodes = doc['nodes'];
  if (!Array.isArray(rawNodes)) return { ok: false, errors: ['nodes must be a list'] };
  const rawEdges = doc['edges'] ?? [];
  if (!Array.isArray(rawEdges)) return { ok: false, errors: ['edges must be a list'] };
  if (rawNodes.length > workflowLimits.maxNodes) err(c, 'workflow has too many nodes');
  if (rawEdges.length > workflowLimits.maxEdges) err(c, 'workflow has too many edges');
  if (c.errors.length > 0) return { ok: false, errors: c.errors };

  const mv = doc['max_visits'];
  if (mv !== undefined && (typeof mv !== 'number' || !Number.isInteger(mv) || mv < 1)) err(c, 'max_visits must be a positive integer');
  const nodes: WorkflowNode[] = [];
  const seen = new Set<string>();
  rawNodes.forEach((raw, i) => {
    const id = isObj(raw) ? raw['id'] : undefined;
    if (typeof id !== 'string' || id === '') {
      err(c, `node ${i}: missing id`);
      return;
    }
    if (!ID_RE.test(id) || RESERVED.includes(id)) return err(c, `node ${id}: invalid id`);
    if (seen.has(id)) return err(c, `node ${id}: duplicate id`);
    seen.add(id);
    const src = raw as Record<string, unknown>;
    const type = src['type'];
    if (typeof type !== 'string' || !(NODE_TYPES as readonly string[]).includes(type)) return err(c, `node ${id}: unknown type "${String(type)}"`);
    nodes.push(nodeOf(c, src, id, type));
  });
  if (nodes.filter((n) => n.type === 'trigger').length !== 1) err(c, 'workflow needs exactly one trigger');

  const edges: WorkflowEdge[] = [];
  rawEdges.forEach((raw, i) => {
    if (!isObj(raw)) return err(c, `edge ${i}: must be an object`);
    for (const end of ['from', 'to'] as const) {
      const v = raw[end];
      if (typeof v !== 'string' || !seen.has(v)) return err(c, `edge ${i}: unknown node "${String(v)}"`);
    }
    const handle = normalizeHandle(raw['handle']);
    if (handle === undefined) return err(c, `edge ${i}: invalid handle "${String(raw['handle'])}"`);
    edges.push({ from: raw['from'] as string, to: raw['to'] as string, handle });
  });

  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    if (n.type !== 'join') continue;
    const incoming = edges.filter((e) => e.to === n.id);
    if (incoming.length !== 1 || byId.get(incoming[0]?.from ?? '')?.type !== 'fanout') err(c, `join ${n.id}: needs exactly one incoming edge, from a fanout node`);
  }
  const trigger = nodes.find((n) => n.type === 'trigger');
  if (trigger !== undefined) {
    // judgment: a push in a node the trigger cannot reach never runs, so it is not an error; a path that merely avoids the approval is.
    const reach = new Set<string>([trigger.id]);
    const queue = [trigger.id];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      if (byId.get(id)?.type === 'approval') continue;
      for (const e of edges) {
        if (e.from !== id || reach.has(e.to)) continue;
        reach.add(e.to);
        queue.push(e.to);
      }
    }
    for (const n of nodes) if (pushes(n) && reach.has(n.id)) err(c, `node ${n.id}: git push or gh pr needs an approval node on every path before it`);
  }
  if (c.errors.length > 0) return { ok: false, errors: c.errors };
  const name = typeof doc['name'] === 'string' && doc['name'] !== '' ? doc['name'] : 'workflow';
  const maxVisits = typeof mv === 'number' ? mv : opts.maxVisits !== undefined && opts.maxVisits >= 1 ? Math.floor(opts.maxVisits) : workflowLimits.defaultMaxVisits;
  return {
    ok: true,
    workflow: { name, description: typeof doc['description'] === 'string' ? doc['description'] : null, inputs: doc['inputs'] ?? null, nodes, edges, maxVisits },
  };
}
