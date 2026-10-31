/**
 * `resolveName`: turns what an agent typed (an id, a label, `path::symbol`, a bare file path) into one node, or a `QueryError` with candidates
 * or the nearest labels. Called from: explain, path, affected and neighbors in walk.ts, and apps/web/src/graph (the excerpt needs the node).
 * Why: spec:331 asks for ambiguous / not_found answers that tell the caller how to continue. Deliberately NOT done: fuzzy matching of a hit
 * (a near miss is only offered as `nearest`), reading files. Untrusted: the name and every label and path of the index.
 */
import { internalsOf } from './build.ts';
import { clean, keyOf, queryLimits, QueryError, byCode, type Candidate, type GNode, type GraphIndex } from './model.ts';

const NAME_SHOWN = 80;

function bigrams(s: string): Set<string> {
  const g = new Set<string>();
  for (let i = 0; i + 1 < s.length; i++) g.add(s.slice(i, i + 2));
  return g;
}

/** Dice coefficient over character bigrams; 0 when either side has none. */
function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const g of a) if (b.has(g)) common++;
  return (2 * common) / (a.size + b.size);
}

function nearestLabels(index: GraphIndex, key: string): string[] {
  const want = bigrams(key.slice(0, queryLimits.nameMax).toLowerCase());
  const best = new Map<string, number>();
  for (const n of index.nodes.values()) {
    const label = clean(n.label);
    if (label === '') continue;
    const d = dice(want, bigrams(keyOf(label).toLowerCase()));
    if (d > 0 && d > (best.get(label) ?? 0)) best.set(label, d);
  }
  return [...best.entries()].sort((a, b) => b[1] - a[1] || byCode(a[0], b[0])).slice(0, queryLimits.nearestMax).map(([label]) => label);
}

const candidateOf = (n: GNode): Candidate => ({
  id: clean(n.id),
  label: clean(n.label),
  hint: clean(n.sourceFile !== null ? `${n.sourceFile}::${keyOf(n.label)}` : n.id),
});

const fileMatches = (n: GNode, p: string): boolean => n.sourceFile !== null && (n.sourceFile === p || n.sourceFile.endsWith(`/${p}`));

/** D11. Steps in order; the first that finds a node decides. Throws `QueryError` (`invalid`, `ambiguous`, `not_found`) only. */
export function resolveName(index: GraphIndex, rawName: string): GNode {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (name === '') throw new QueryError('invalid', 'name must not be empty');
  const { byKey, byKeyLower } = internalsOf(index);
  const key = keyOf(name);
  const get = (ids: string[] | undefined): GNode[] => (ids ?? []).flatMap((id) => index.nodes.get(id) ?? []);
  const steps: (() => GNode[])[] = [
    () => get(index.nodes.has(name) ? [name] : []),
    () => get(byKey.get(key)),
    () => {
      const at = name.lastIndexOf('::');
      if (at > 0) {
        const s = keyOf(name.slice(at + 2));
        return [...index.nodes.values()].filter((n) => fileMatches(n, name.slice(0, at)) && keyOf(n.label) === s);
      }
      return name.includes('/') ? [...index.nodes.values()].filter((n) => (n.type === 'file' || n.type === 'page') && fileMatches(n, name)) : [];
    },
    () => get(byKeyLower.get(key.toLowerCase())),
    () => {
      const low = key.toLowerCase();
      if (low === '') return [];
      return [...index.nodes.values()].filter((n) => keyOf(n.label).toLowerCase().startsWith(low));
    },
  ];
  for (const step of steps) {
    const found = step();
    if (found.length === 1) return found[0] as GNode;
    if (found.length > 1) {
      const candidates = found.sort((a, b) => byCode(a.id, b.id)).slice(0, queryLimits.candidatesMax).map(candidateOf);
      throw new QueryError('ambiguous', `'${Array.from(clean(name)).slice(0, NAME_SHOWN).join('')}' matches ${found.length} nodes, pass one id`, { candidates });
    }
  }
  throw new QueryError('not_found', `no node matching '${Array.from(clean(name)).slice(0, NAME_SHOWN).join('')}'`, { nearest: nearestLabels(index, key) });
}
