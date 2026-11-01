/**
 * Shared vocabulary of the graph query module: limits, the error type, node and edge types, the cleaning rule (D20), the node reference and
 * the text shape of one node. Called from: build.ts, resolve.ts, search.ts, walk.ts and render.ts of this directory, and (through index.ts)
 * apps/web/src/graph. Why: every other file agrees on what a node looks like on the wire and what is safe to print.
 * Deliberately NOT done: reading the database, files or the network (pure), writing anything. Untrusted: every label, id, path and relation
 * of a node or edge (rows may come from `ctc migrate --from-python`); nothing here edits its arguments.
 */
import { sanitize } from '../../sanitize/index.ts';

/**
 * Read at call time, so a test may assign to it and restore it. FROM-SPEC: `seeds`, `depth`, `depthMax`, `hubMin`, `budgetTokens`, `searchDefault`,
 * `searchMax`, `denseSeeds`, `floor`, `maxHops`, `excerptLines`, `candidatesMax`, `nearestMax` (spec:305-308, 325-331, 342, 346). All others chosen by judgment.
 */
export const queryLimits = {
  seeds: 3,
  depth: 2,
  depthMax: 3,
  hubMin: 50,
  budgetTokens: 2000,
  charsPerToken: 4,
  searchDefault: 10,
  searchMax: 50,
  denseSeeds: 10,
  floor: 0.3,
  maxHops: 8,
  groupMax: 20,
  excerptLines: 40,
  excerptLineChars: 240,
  candidatesMax: 10,
  nearestMax: 5,
  neighborsDefault: 50,
  neighborsMax: 200,
  affectedMax: 2000,
  nameMax: 256,
  queryMax: 500,
  visitMax: 200000,
  tokenMin: 2,
};

export type ErrorCode = 'invalid' | 'not_found' | 'ambiguous';
export type Candidate = { id: string; label: string; hint: string };

/** The only error core throws for bad input. `message` is already the final text (D4). */
export class QueryError extends Error {
  readonly code: ErrorCode;
  readonly candidates: Candidate[] | undefined;
  readonly nearest: string[] | undefined;
  constructor(code: ErrorCode, message: string, extra: { candidates?: Candidate[]; nearest?: string[] } = {}) {
    super(message);
    this.name = 'QueryError';
    this.code = code;
    this.candidates = extra.candidates;
    this.nearest = extra.nearest;
  }
}

export type GNode = { id: string; kind: string; type: string; label: string; sourceFile: string | null; sourceLocation: string | null; meta?: unknown };
export type GEdge = { src: string; dst: string; relation: string; confidence: string; score?: number };

export type GraphIndex = {
  readonly nodes: ReadonlyMap<string, GNode>;
  readonly hubCut: number;
  degree(id: string): number;
  out(id: string): readonly GEdge[];
  in(id: string): readonly GEdge[];
};

export type NodeRef = { id: string; label: string; type: string; kind: string; file: string | null; line: number | null };

/** FROM-SPEC (spec:266 DROPPED weight 0); the other weights are D3. */
const WEIGHTS: Record<string, number> = { CONFIRMED: 1, EXTRACTED: 1, INFERRED: 0.6, AMBIGUOUS: 0.3, DROPPED: 0 };
/** A confidence string the table does not know counts as `AMBIGUOUS` (D10). */
export const normConfidence = (c: string): string => (Object.hasOwn(WEIGHTS, c) ? c : 'AMBIGUOUS');
export const weightOf = (confidence: string): number => WEIGHTS[normConfidence(confidence)] as number;

export const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const CLEAN_MAX = 256;
/** D20: `sanitize`, whitespace runs to one space, trimmed, cut to 256 code points. Never throws. */
export function clean(s: unknown): string {
  if (typeof s !== 'string') return '';
  const t = sanitize(s).replace(/\s+/g, ' ').trim();
  return t.length <= CLEAN_MAX ? t : Array.from(t).slice(0, CLEAN_MAX).join('');
}

/** `N` of a location `L<N>`, else `null`. */
export function lineOf(location: string | null): number | null {
  const m = typeof location === 'string' ? /^L(\d+)$/.exec(location) : null;
  return m ? Number(m[1]) : null;
}

/** D3: the cleaned, plain-JSON view of a node. `file` is the project-relative `sourceFile`. */
export function nodeRef(node: GNode): NodeRef {
  const file = typeof node.sourceFile === 'string' ? clean(node.sourceFile) : '';
  return { id: clean(node.id), label: clean(node.label), type: clean(node.type), kind: clean(node.kind), file: file === '' ? null : file, line: lineOf(node.sourceLocation) };
}

/** D3: `where(n)` is `file:line`, `file` or `-`. */
export const whereOf = (r: NodeRef): string => (r.file === null ? '-' : r.line === null ? r.file : `${r.file}:${r.line}`);
/** D3: `T(n)` is `<label> [<type>] <where> (<id>)`. */
export const textOf = (r: NodeRef): string => `${r.label} [${r.type}] ${whereOf(r)} (${r.id})`;

/** `label` without one trailing `()` and one leading `.` (D11). */
export function keyOf(label: string): string {
  const t = label.endsWith('()') ? label.slice(0, -2) : label;
  return t.startsWith('.') ? t.slice(1) : t;
}

/** `v` when it is an integer in `lo..hi`, `dflt` when absent, else an `invalid` error that names `what`. */
export function intOption(v: number | undefined, dflt: number, lo: number, hi: number, what: string): number {
  if (v === undefined) return dflt;
  if (!Number.isInteger(v) || v < lo || v > hi) throw new QueryError('invalid', `${what} must be an integer from ${lo} to ${hi}`);
  return v;
}
