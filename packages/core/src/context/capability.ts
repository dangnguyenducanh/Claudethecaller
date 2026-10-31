/**
 * Capability parser: one F2 library capability (skill, agent, command, workflow) into `skill:` / `agent:` / `command:` / `workflow:` nodes with
 * `uses` / `invokes` / `contains` edges.
 *
 * Called from: the worker capability link (context/capability.ts) (`linkCapability`). Why it exists: spec:244, spec:262-264, spec:286, DECISIONS D12.
 * Deliberately NOT done: I/O, reading the library, `serves` edges, bare-name or `/name` references, a `uses` edge from a workflow body.
 * Untrusted: the frontmatter (YAML or JSON from a file), the body and the description; the function never throws and never edits `input`.
 */
import { createHash } from 'node:crypto';
import { NAME_RE } from '../library/index.ts';
import { CONTEXT_VERSION, contextLimits } from './limits.ts';
import type { CapabilityInput, CapabilityParse, CtxEdge, CtxNode } from './types.ts';

const KINDS = new Set(['skill', 'agent', 'command', 'workflow']);
const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAX_NAME = 64;
const MAX_DEPTH = 50;
const FRONTMATTER_LISTS = [['skills', 'skill'], ['agents', 'agent'], ['commands', 'command']] as const;
const STEP_TEXT_FIELDS = ['prompt', 'run', 'question'];

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const cutPoints = (s: string, max: number): string => (s.length <= max ? s : Array.from(s.slice(0, max * 2)).slice(0, max).join(''));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const validName = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_NAME && NAME_RE.test(v);

function sortKeys(v: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Error('too deep');
  if (Array.isArray(v)) return v.map((x) => sortKeys(x, depth + 1));
  if (isObject(v)) return Object.fromEntries(Object.keys(v).sort(byCode).map((k) => [k, sortKeys(v[k], depth + 1)]));
  return v;
}

/** JSON with object keys sorted recursively; anything that is not JSON becomes `null`. */
function stableJson(v: unknown): string {
  try {
    return JSON.stringify(sortKeys(v, 0)) ?? 'null';
  } catch {
    return 'null';
  }
}

/** Explicit `skill:<name>` / `agent:<name>` / `command:<name>` references of a text, in appearance order. */
function refsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![\w:./-])(skill|agent|command):([a-z0-9]+(?:-[a-z0-9]+)*)(?![\w-])/g)) if ((m[2] as string).length <= MAX_NAME) out.push(`${m[1]}:${m[2]}`);
  return out;
}

/** Distinct ids in order, without `self`, at most `maxCapabilityRefs`. */
function distinct(ids: string[], self: string): string[] {
  const out: string[] = [];
  for (const id of ids) if (id !== self && !out.includes(id) && out.length < contextLimits.maxCapabilityRefs) out.push(id);
  return out;
}

const edge = (src: string, dst: string, relation: CtxEdge['relation']): CtxEdge => ({ src, dst, relation, confidence: 'EXTRACTED', score: 1, sourceLocation: null });

function listItems(v: unknown): string[] {
  const items = typeof v === 'string' ? v.split(/[\s,]+/) : Array.isArray(v) ? v : [];
  return items.filter(validName);
}

/**
 * Parses one capability. An invalid `name` gives `{ nodes: [], edges: [], hash: '' }`. `hash` also covers the frontmatter, so a node is rewritten
 * exactly when something the graph shows changed. Deterministic; never throws.
 */
export function parseCapability(input: CapabilityInput): CapabilityParse {
  const none: CapabilityParse = { nodes: [], edges: [], hash: '' };
  try {
    if (!isObject(input) || !KINDS.has(input.kind) || !validName(input.name)) return none;
    const { kind, name } = input;
    const description = typeof input.description === 'string' ? input.description : '';
    const body = typeof input.body === 'string' ? input.body : '';
    const bodyHash = typeof input.bodyHash === 'string' ? input.bodyHash : '';
    const served = typeof input.servedVersion === 'number' ? input.servedVersion : null;
    const fm = input.frontmatter;
    const hash = sha(`${CONTEXT_VERSION}\0${kind}\0${name}\0${served ?? ''}\0${description}\0${bodyHash}\0${stableJson(fm)}`);
    const id = `${kind}:${name}`;
    const nodes: CtxNode[] = [
      {
        id, kind: 'capability', type: kind, label: name, sourceLocation: null, contentHash: hash,
        meta: { description: cutPoints(description, contextLimits.maxDescription), servedVersion: served, embedText: cutPoints(`${name}\n${description}`, contextLimits.maxEmbedText) },
      },
    ];
    const edges: CtxEdge[] = [];
    if (kind !== 'workflow') {
      const declared: string[] = [];
      if (isObject(fm)) for (const [key, target] of FRONTMATTER_LISTS) if (Object.hasOwn(fm, key)) declared.push(...listItems(fm[key]).map((n) => `${target}:${n}`));
      for (const dst of distinct([...declared, ...refsIn(body)], id)) edges.push(edge(id, dst, 'uses'));
    } else if (isObject(fm) && Object.hasOwn(fm, 'nodes') && Array.isArray(fm['nodes'])) {
      const seen = new Set<string>();
      for (const item of fm['nodes'] as unknown[]) {
        if (seen.size >= contextLimits.maxWorkflowNodes) break;
        if (!isObject(item) || typeof item['id'] !== 'string' || !STEP_ID.test(item['id']) || seen.has(item['id'])) continue;
        const sid = item['id'];
        seen.add(sid);
        const stepId = `workflow:${name}:${sid}`;
        const nodeType = typeof item['type'] === 'string' ? item['type'] : 'unknown';
        nodes.push({ id: stepId, kind: 'capability', type: 'workflow_step', label: sid, sourceLocation: null, contentHash: sha(`${hash}\0${sid}`), meta: { nodeType, embedText: `${name} ${sid}` } });
        edges.push(edge(id, stepId, 'contains'));
        const texts = STEP_TEXT_FIELDS.flatMap((f) => (typeof item[f] === 'string' ? [item[f] as string] : []));
        for (const dst of distinct(texts.flatMap(refsIn), stepId)) edges.push(edge(stepId, dst, 'invokes'));
      }
    }
    edges.sort((a, b) => byCode(a.src, b.src) || byCode(a.dst, b.dst) || byCode(a.relation, b.relation));
    return { nodes, edges, hash };
  } catch {
    // judgment: a capability the parser cannot read produces no rows rather than an error, the next library change retries it
    return none;
  }
}
