/**
 * Text renderers of the five results: the one-line-per-fact shapes agents read (D3). Called from: apps/web/src/graph (the MCP tools return
 * this text; the routes return the JSON results). Why: a model reads these lines, so their shape is fixed and every label in them is already
 * cleaned by the query functions. Deliberately NOT done: cutting explain, path, affected or neighbors by a token budget (only search is
 * bounded by `budgetTokens`; the other results are bounded by their own limits), colour, markdown. Untrusted: nothing; inputs are query results.
 */
import { queryLimits, textOf } from './model.ts';
import type { SearchResult } from './search.ts';
import type { AffectedResult, ExplainResult, NeighborsResult, PathResult } from './walk.ts';

type RenderOptions = { budgetTokens?: number };

/** One line per hit until `budgetTokens x charsPerToken` characters (newlines counted) would be exceeded; at least one hit line is always shown. */
export function renderSearch(r: SearchResult, o: RenderOptions = {}): string {
  if (r.hits.length === 0) return 'no matches';
  const budget = (o.budgetTokens ?? queryLimits.budgetTokens) * queryLimits.charsPerToken;
  const lines: string[] = [];
  let used = 0;
  for (const h of r.hits) {
    const line = `${h.hop === 0 ? 'seed' : `hop${h.hop}`} ${h.score.toFixed(2)} ${textOf(h)}`;
    // judgment: an answer is never empty only because its first line is longer than the budget
    if (lines.length > 0 && used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (r.total > lines.length) lines.push(`[truncated: ${r.total - lines.length} more]`);
  return lines.join('\n');
}

export function renderExplain(r: ExplainResult): string {
  const lines = [textOf(r.node)];
  if (r.excerpt !== null) for (const l of r.excerpt.split('\n')) lines.push(`  ${l}`);
  for (const g of r.groups) {
    lines.push(g.direction === 'out' ? `-${g.relation}->` : `<-${g.relation}-`);
    for (const e of g.edges) lines.push(`  ${e.confidence} ${textOf(e.node)}`);
    if (g.total > g.edges.length) lines.push(`  … ${g.total - g.edges.length} more`);
  }
  return lines.join('\n');
}

export function renderPath(r: PathResult): string {
  if (!r.found) return `no path within ${r.maxHops} hops`;
  const lines = [textOf(r.from)];
  r.hops.forEach((h, i) => {
    const next = textOf(r.nodes[i + 1] ?? r.to);
    lines.push(h.forward ? `  -${h.relation}-> ${next}` : `  <-${h.relation}- ${next}`);
  });
  return lines.join('\n');
}

export function renderAffected(r: AffectedResult): string {
  const lines = [`a change to ${textOf(r.node)} affects ${r.total} nodes:`];
  for (const g of r.groups) {
    lines.push(`${g.type} (${g.nodes.length})`);
    for (const n of g.nodes) lines.push(`  ${n.depth} ${n.relation} ${textOf(n)}`);
  }
  // judgment: a cut list says so, in the shape of the search footer
  if (r.truncated > 0) lines.push(`[truncated: ${r.truncated} more]`);
  return lines.join('\n');
}

export function renderNeighbors(r: NeighborsResult): string {
  if (r.neighbors.length === 0) return 'no neighbors';
  return [textOf(r.node), ...r.neighbors.map((n) => `  ${n.direction} ${n.relation} ${n.confidence} ${textOf(n.node)}`)].join('\n');
}
