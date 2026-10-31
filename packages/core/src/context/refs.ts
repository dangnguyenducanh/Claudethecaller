/**
 * Reference resolution: raw code references of a document (or model-proposed ones) against the stored graph nodes.
 *
 * Called from: the worker context layer (pass.ts for parser edges, extract.ts for INFERRED model edges). Why it exists: spec:263-266, DECISIONS D9.
 * Deliberately NOT done: I/O, writing, choosing between several candidates beyond the three-candidate ambiguity rule.
 * Untrusted: the stored rows (labels and source files may be stale); arguments are never edited and the function never throws.
 */
import { SCORES } from '../graph/resolve.ts';
import type { CtxRef, RefNode, ResolvedRef } from './types.ts';

const MAX_AMBIGUOUS = 3;
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const realFile = (n: RefNode): n is RefNode & { sourceFile: string } => typeof n.sourceFile === 'string' && !n.sourceFile.startsWith('<');
const bare = (label: string): string => (label.endsWith('()') ? label.slice(0, -2) : label);

/**
 * Resolves `refs` against `nodes`. `path` -> the file or page node (EXTRACTED); `path_symbol` -> one candidate EXTRACTED, 2-3 AMBIGUOUS, none but the file node INFERRED;
 * `node` -> the node with that id. With `opts.inferred` every EXTRACTED result becomes INFERRED. Deduplicated per `(src, dst, relation)` keeping the highest score, sorted by code unit.
 */
export function resolveRefs(refs: CtxRef[], nodes: RefNode[], opts?: { inferred?: boolean }): ResolvedRef[] {
  try {
    const byFile = new Map<string, RefNode[]>();
    const byId = new Map<string, RefNode>();
    for (const n of nodes) {
      if (!byId.has(n.id)) byId.set(n.id, n);
      if (!realFile(n)) continue;
      const l = byFile.get(n.sourceFile);
      if (l) l.push(n);
      else byFile.set(n.sourceFile, [n]);
    }
    const fileNode = (path: string): RefNode | undefined => byFile.get(path)?.find((n) => n.type === 'file' || n.type === 'page');
    const best = new Map<string, ResolvedRef>();
    const put = (r: CtxRef, dst: string, confidence: ResolvedRef['confidence']): void => {
      // judgment: model-proposed edges (inferred) never rank above INFERRED, a document author's EXTRACTED edge becomes a guess there
      const inferred = opts?.inferred === true && confidence === 'EXTRACTED';
      const c = inferred ? 'INFERRED' : confidence;
      const score = c === 'EXTRACTED' ? SCORES.extracted : c === 'INFERRED' ? SCORES.nameOnly : SCORES.ambiguous;
      const key = `${r.from}\0${dst}\0${r.relation}`;
      const old = best.get(key);
      if (!old || old.score < score) best.set(key, { src: r.from, dst, relation: r.relation, confidence: c, score, sourceLocation: `L${r.line}` });
    };
    for (const r of refs) {
      if (r.kind === 'node') {
        const n = byId.get(r.target);
        if (n) put(r, n.id, 'EXTRACTED');
      } else if (r.kind === 'path') {
        const n = fileNode(r.target);
        if (n) put(r, n.id, 'EXTRACTED');
      } else {
        const at = r.target.lastIndexOf('::');
        if (at < 0) continue;
        const path = r.target.slice(0, at);
        const symbol = r.target.slice(at + 2);
        const candidates = (byFile.get(path) ?? []).filter((n) => {
          if (n.type === 'file') return false;
          const b = bare(n.label);
          return n.label === symbol || n.label === `${symbol}()` || b.slice(b.lastIndexOf('.') + 1) === symbol;
        });
        if (candidates.length === 1) put(r, (candidates[0] as RefNode).id, 'EXTRACTED');
        else if (candidates.length >= 2 && candidates.length <= MAX_AMBIGUOUS) for (const n of candidates) put(r, n.id, 'AMBIGUOUS');
        else if (candidates.length === 0) {
          const f = fileNode(path);
          if (f) put(r, f.id, 'INFERRED');
        }
      }
    }
    return [...best.values()].sort((a, b) => byCode(a.src, b.src) || byCode(a.dst, b.dst) || byCode(a.relation, b.relation));
  } catch {
    return [];
  }
}
