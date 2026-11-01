/**
 * Templates, conditions and fan-out plans of the F4 runner (D11, D17a): `renderTemplate`, `scopeOf`, `outText`, `evalCondition`, `planFanout`,
 * `childId`, `parseChildId`. Called from: `apps/worker/src/runner` (the engine renders every prompt, shell line, question and condition when a
 * node starts). Why: one place decides how a value from a run input or from an earlier node's output enters a prompt or a shell line, so the
 * quoting rule cannot be forgotten at a call site. Deliberately NOT done: any I/O, expression evaluation, escaping for anything but `sh`.
 * Untrusted: every argument. No function throws on odd input and none edits an argument.
 */
import { workflowLimits, type Workflow, type WorkflowNode } from './workflow.ts';

const VAR = /\{\{\s*([\w.-]+)\s*\}\}/g;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Replaces `{{ name }}` by `String(scope[name])` for an own key of `scope`, else by `''` (and lists `name` in `missing`, first-seen order). A
 * substituted value is never scanned again. With `opts.shell` every substituted value, empty ones too, is wrapped in single quotes.
 */
export function renderTemplate(
  template: unknown, scope: unknown, opts: { shell?: boolean } = {},
): { text: string; missing: string[] } {
  if (typeof template !== 'string') return { text: '', missing: [] };
  const vars = isObj(scope) ? scope : {};
  const missing: string[] = [];
  const out = template.replace(VAR, (_m, name: string) => {
    const has = Object.hasOwn(vars, name);
    if (!has && !missing.includes(name)) missing.push(name);
    const value = has ? String(vars[name]) : '';
    return opts.shell === true ? `'${value.replaceAll("'", "'\\''")}'` : value;
  });
  return { text: out, missing };
}

/** Every value of the result is a string (D11). `resolution`, `item` and `index` are present only when given. */
export function scopeOf(o: {
  inputs?: unknown; outputs?: Record<string, { out: string; exit?: number }>; resolution?: string | null; item?: string | null; index?: number | null;
}): Record<string, string> {
  const scope: Record<string, string> = {};
  if (isObj(o.inputs)) {
    for (const [k, v] of Object.entries(o.inputs)) scope[`input.${k}`] = typeof v === 'string' ? v : (JSON.stringify(v) ?? '');
  }
  for (const [id, v] of Object.entries(o.outputs ?? {})) {
    scope[`${id}.out`] = v.out;
    if (v.exit !== undefined) scope[`${id}.exit`] = String(v.exit);
  }
  if (typeof o.resolution === 'string') scope['resolution'] = o.resolution;
  if (typeof o.item === 'string') scope['item'] = o.item;
  if (typeof o.index === 'number') scope['index'] = String(o.index);
  return scope;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strings = (v: unknown, key: string): string[] =>
  Array.isArray(v) ? v.map((c) => (isObj(c) && typeof c[key] === 'string' ? c[key] : '')) : [];

/** The `out` of a finished step (`{{node.out}}`), by node type. Junk gives `''`. */
export function outText(node: Pick<WorkflowNode, 'type' | 'strategy'> | null | undefined, output: unknown): string {
  const o = isObj(output) ? output : {};
  switch (node?.type) {
    case 'agent': return str(o['summary']);
    case 'shell': return str(o['stdoutTail']);
    case 'approval': return str(o['choice']);
    case 'if': return str(o['handle']);
    case 'fanout': return JSON.stringify(strings(o['children'], 'summary'));
    case 'join': return node.strategy === 'collect' ? JSON.stringify(Array.isArray(o['results']) ? o['results'] : []) : str(o['summary']);
    default: return '';
  }
}

const FALSY = ['', '0', 'false', 'no', 'null', 'undefined'];

/** Both sides are trimmed. An unknown `op` is `false`. */
export function evalCondition(op: unknown, left: unknown, right: unknown): boolean {
  const l = typeof left === 'string' || typeof left === 'number' ? String(left).trim() : '';
  const r = typeof right === 'string' || typeof right === 'number' ? String(right).trim() : '';
  switch (op) {
    case 'eq': return l === r;
    case 'ne': return l !== r;
    case 'contains': return l.includes(r);
    case 'truthy': return !FALSY.includes(l.toLowerCase());
    default: return false;
  }
}

export type FanoutPlan = { ok: true; items: string[] } | { ok: false; error: string };

/**
 * Items of a fan-out (D17a): `over` a number or digit text N gives `'1'..'N'`; else the rendered text is a JSON array (its elements) or one item
 * per non-blank line. More than `fanoutItemsMax` items, or an item longer than `itemMax`, is an error (never a silent cut).
 */
export function planFanout(node: unknown, scope: unknown): FanoutPlan {
  const over = isObj(node) ? node['over'] : undefined;
  if (typeof over !== 'string' && typeof over !== 'number') return { ok: false, error: 'fanout: bad items' };
  const { fanoutItemsMax, itemMax } = workflowLimits;
  const rendered = (typeof over === 'number' ? String(over) : renderTemplate(over, scope).text).trim();
  const tooMany = (n: number) => ({ ok: false, error: `fanout: ${n} items exceeds ${fanoutItemsMax}` }) as const;
  let items: string[];
  if (/^\d+$/.test(rendered)) {
    const n = Number(rendered);
    if (n > fanoutItemsMax) return tooMany(n);
    items = Array.from({ length: n }, (_, i) => String(i + 1));
  } else {
    let parsed: unknown;
    try {
      parsed = rendered.startsWith('[') ? JSON.parse(rendered) : undefined;
    } catch {
      parsed = undefined;
    }
    items = Array.isArray(parsed)
      ? parsed.map((v) => (typeof v === 'string' ? v : (JSON.stringify(v) ?? '')))
      : rendered.split('\n').map((l) => l.trim()).filter((l) => l !== '');
    if (items.length > fanoutItemsMax) return tooMany(items.length);
  }
  if (items.some((i) => i.length > itemMax)) return { ok: false, error: 'fanout: bad items' };
  return { ok: true, items };
}

/** `<fanoutId>[<i>]`, i from 0. */
export const childId = (fanoutId: string, index: number): string => `${fanoutId}[${index}]`;

/** Inverse of `childId`; `null` for any other string. */
export function parseChildId(id: unknown): { fanoutId: string; index: number } | null {
  const m = typeof id === 'string' ? /^([A-Za-z0-9][A-Za-z0-9_-]*)\[(\d{1,6})\]$/.exec(id) : null;
  return m === null ? null : { fanoutId: m[1] as string, index: Number(m[2]) };
}

/** Job timeout in seconds of a step's node: an agent or shell node's own, a fan-out child's from its fan-out node, else the agent default. */
export function timeoutOf(wf: Pick<Workflow, 'nodes'>, nodeId: string): number {
  const cid = parseChildId(nodeId);
  const node = wf.nodes.find((n) => n.id === (cid === null ? nodeId : cid.fanoutId));
  return (cid === null ? node?.timeoutS : node?.child?.timeoutS) ?? (node?.type === 'shell' ? workflowLimits.shellTimeoutS : 1800);
}
