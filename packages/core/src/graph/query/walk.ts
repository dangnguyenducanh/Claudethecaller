/**
 * The four name-based queries on the RAM graph: `explainNode` (edges grouped by relation), `findPath` (shortest path), `affectedBy` (reverse
 * impact walk) and `neighborsOf` (adjacent nodes). Called from: apps/web/src/graph (`graph_explain`, `graph_path`, `graph_affected`,
 * `graph_neighbors` and their `/api/graph` routes). Why: spec:326-329 give an agent these answers instead of grep. Deliberately NOT done: reading
 * the source file for the excerpt (the caller passes it), writing, expanding hubs specially (these are exact walks), recursion.
 * Untrusted: names, options, and every label and path of the index. A bad option or name is a `QueryError`, never another error.
 */
import { sanitize, cut } from '../../sanitize/index.ts';
import { resolveName } from './resolve.ts';
import { byCode, clean, intOption, nodeRef, queryLimits, QueryError, weightOf, type GEdge, type GNode, type GraphIndex, type NodeRef } from './model.ts';

export type ExplainResult = {
  node: NodeRef;
  excerpt: string | null;
  groups: { relation: string; direction: 'in' | 'out'; total: number; edges: { node: NodeRef; confidence: string; score: number }[] }[];
};
export type PathHop = { from: string; to: string; relation: string; confidence: string; forward: boolean };
export type PathResult = { found: boolean; from: NodeRef; to: NodeRef; maxHops: number; hops: PathHop[]; nodes: NodeRef[] };
export type AffectedNode = NodeRef & { depth: number; relation: string; via: string };
export type AffectedResult = { node: NodeRef; depth: number; total: number; truncated: number; groups: { type: string; nodes: AffectedNode[] }[] };
export type Neighbor = { direction: 'in' | 'out'; relation: string; confidence: string; score: number; node: NodeRef };
export type NeighborsResult = { node: NodeRef; total: number; neighbors: Neighbor[] };

const node = (index: GraphIndex, id: string): GNode => index.nodes.get(id) as GNode;
const score = (e: GEdge): number => e.score ?? 1;

/** D13 / D20: sanitized, split into lines, each cut to `excerptLineChars`, at most `excerptLines` lines; nothing left gives `null`. */
function cleanExcerpt(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const lines = sanitize(text)
    .split('\n')
    .slice(0, queryLimits.excerptLines)
    .map((l) => cut(l.replace(/\r$/, ''), queryLimits.excerptLineChars));
  const joined = lines.join('\n');
  return joined.trim() === '' ? null : joined;
}

/** D13. `o.excerpt` is the node's source text read by the caller; core never reads files. */
export function explainNode(index: GraphIndex, name: string, o: { excerpt?: string | null } = {}): ExplainResult {
  const n = resolveName(index, name);
  const buckets = new Map<string, { relation: string; direction: 'in' | 'out'; items: { ref: NodeRef; confidence: string; score: number; weight: number }[] }>();
  const add = (e: GEdge, direction: 'in' | 'out', other: string): void => {
    const key = `${e.relation}\u0000${direction}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { relation: e.relation, direction, items: [] }));
    b.items.push({ ref: nodeRef(node(index, other)), confidence: e.confidence, score: score(e), weight: weightOf(e.confidence) });
  };
  for (const e of index.out(n.id)) add(e, 'out', e.dst);
  for (const e of index.in(n.id)) add(e, 'in', e.src);
  const groups = [...buckets.values()]
    .sort((a, b) => byCode(a.relation, b.relation) || (a.direction === b.direction ? 0 : a.direction === 'out' ? -1 : 1))
    .map((b) => ({
      relation: clean(b.relation),
      direction: b.direction,
      total: b.items.length,
      edges: b.items
        .sort((x, y) => y.weight - x.weight || byCode(x.ref.label, y.ref.label) || byCode(x.ref.id, y.ref.id))
        .slice(0, queryLimits.groupMax)
        .map((i) => ({ node: i.ref, confidence: i.confidence, score: i.score })),
    }));
  return { node: nodeRef(n), excerpt: cleanExcerpt(o.excerpt), groups };
}

/** D14. A path that does not exist is a normal reply (`found: false`). `directed` (default true) follows `src -> dst` only. */
export function findPath(index: GraphIndex, from: string, to: string, o: { maxHops?: number; directed?: boolean } = {}): PathResult {
  const maxHops = intOption(o.maxHops, queryLimits.maxHops, 1, queryLimits.maxHops, 'max_hops');
  const a = resolveName(index, from);
  const b = resolveName(index, to);
  const directed = o.directed !== false;
  const result = (found: boolean, hops: PathHop[], ids: string[]): PathResult => ({
    found, from: nodeRef(a), to: nodeRef(b), maxHops, hops, nodes: ids.map((id) => nodeRef(node(index, id))),
  });
  if (a.id === b.id) return result(true, [], [a.id]);
  const parent = new Map<string, { prev: string; edge: GEdge; forward: boolean } | null>([[a.id, null]]);
  let frontier = [a.id];
  for (let depth = 1; depth <= maxHops && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const x of frontier) {
      const steps: [readonly GEdge[], boolean][] = directed ? [[index.out(x), true]] : [[index.out(x), true], [index.in(x), false]];
      for (const [edges, forward] of steps) {
        for (const e of edges) {
          const y = forward ? e.dst : e.src;
          if (parent.has(y)) continue;
          parent.set(y, { prev: x, edge: e, forward });
          if (y === b.id) {
            const hops: PathHop[] = [];
            const ids = [y];
            for (let at: string = y, p = parent.get(at); p; at = p.prev, p = parent.get(at)) {
              hops.unshift({ from: clean(p.prev), to: clean(at), relation: clean(p.edge.relation), confidence: p.edge.confidence, forward: p.forward });
              ids.unshift(p.prev);
            }
            return result(true, hops, ids);
          }
          next.push(y);
          // judgment: a search that visits `visitMax` nodes without finding the target ends as "no path", not as an error
          if (parent.size >= queryLimits.visitMax) return result(false, [], []);
        }
      }
    }
    frontier = next;
  }
  return result(false, [], []);
}

/** FROM-SPEC (spec:328): the relations along which a change travels from a node to the nodes that depend on it. */
const FOLLOWED = new Set(['calls', 'imports', 'imports_from', 'references', 'inherits', 'implements', 'contains', 'uses', 'invokes']);

/** D15. Reverse breadth-first walk to `depth` (default 2, 1..3) over the followed relations. The start node is never listed. */
export function affectedBy(index: GraphIndex, name: string, o: { depth?: number } = {}): AffectedResult {
  const depth = intOption(o.depth, queryLimits.depth, 1, queryLimits.depthMax, 'depth');
  const start = resolveName(index, name);
  const seen = new Set<string>([start.id]);
  const found: { id: string; depth: number; relation: string; via: string }[] = [];
  let frontier = [start.id];
  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const x of frontier) {
      for (const e of index.in(x)) {
        if (!FOLLOWED.has(e.relation) || seen.has(e.src)) continue;
        seen.add(e.src);
        found.push({ id: e.src, depth: d, relation: e.relation, via: x });
        next.push(e.src);
      }
    }
    // judgment: at `visitMax` nodes the walk stops and reports what it found (D6e)
    if (seen.size >= queryLimits.visitMax) break;
    frontier = next;
  }
  const shown = found.slice(0, queryLimits.affectedMax).map((f) => ({ ...nodeRef(node(index, f.id)), depth: f.depth, relation: clean(f.relation), via: clean(f.via) }));
  const byType = new Map<string, AffectedNode[]>();
  for (const n of shown) byType.set(n.type, [...(byType.get(n.type) ?? []), n]);
  const groups = [...byType.entries()]
    .sort((a, b) => byCode(a[0], b[0]))
    .map(([type, nodes]) => ({ type, nodes: nodes.sort((x, y) => x.depth - y.depth || byCode(x.label, y.label) || byCode(x.id, y.id)) }));
  return { node: nodeRef(start), depth, total: found.length, truncated: found.length - shown.length, groups };
}

/** D16. Every live edge touching the node; a self loop gives an `out` and an `in` entry. */
export function neighborsOf(index: GraphIndex, name: string, o: { relation?: string; direction?: 'in' | 'out' | 'both'; limit?: number } = {}): NeighborsResult {
  const limit = intOption(o.limit, queryLimits.neighborsDefault, 1, queryLimits.neighborsMax, 'limit');
  if (o.relation !== undefined && !/^[a-z_]{1,32}$/.test(o.relation)) throw new QueryError('invalid', 'relation must be 1 to 32 characters of a-z and _');
  const direction = o.direction ?? 'both';
  if (direction !== 'in' && direction !== 'out' && direction !== 'both') throw new QueryError('invalid', "direction must be 'in', 'out' or 'both'");
  const n = resolveName(index, name);
  const all: (Neighbor & { weight: number; relationRaw: string })[] = [];
  const add = (e: GEdge, d: 'in' | 'out', other: string): void => {
    if (o.relation !== undefined && e.relation !== o.relation) return;
    all.push({ direction: d, relation: clean(e.relation), relationRaw: e.relation, confidence: e.confidence, score: score(e), node: nodeRef(node(index, other)), weight: weightOf(e.confidence) });
  };
  if (direction !== 'in') for (const e of index.out(n.id)) add(e, 'out', e.dst);
  if (direction !== 'out') for (const e of index.in(n.id)) add(e, 'in', e.src);
  all.sort(
    (a, b) =>
      byCode(a.relationRaw, b.relationRaw) || (a.direction === b.direction ? 0 : a.direction === 'out' ? -1 : 1) || b.weight - a.weight || byCode(a.node.label, b.node.label) || byCode(a.node.id, b.node.id),
  );
  return {
    node: nodeRef(n),
    total: all.length,
    neighbors: all.slice(0, limit).map(({ direction: d, relation, confidence, score: s, node: nd }) => ({ direction: d, relation, confidence, score: s, node: nd })),
  };
}
