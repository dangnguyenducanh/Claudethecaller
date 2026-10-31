/**
 * Pure recall ranking of F3: reciprocal rank fusion of the full-text and vector legs, then recency, reinforcement and pin factors.
 * Called from: apps/web/src/memory (session start block, `mem_search`) and the `memory.recall` eval gate. Why: spec:489, one place decides
 * the order in which learned facts come back. Deliberately NOT done: SQL, embedding, caching, changing the legs (the repository returns them).
 * Untrusted: rows read from the database (a bad date or a missing field gives score 0, never a throw). Inputs are never edited.
 */

/**
 * Read at call time, so a test may assign to a field and restore it. `hookStartBudgetMs` and `indexChars` are FROM-SPEC (spec:526, spec:534);
 * `distillMax` equals `memoryApiLimits.distillMax` of @ctc/shared/schemas/memory. The others were chosen by judgment: a 64 KiB memory file or
 * transcript head is far above one sentence, 3 s matches the library watcher debounce, 1 h leaves live sessions to their Stop hook.
 */
export const recallLimits = {
  hookStartBudgetMs: 1200,
  indexChars: 80,
  maxImportBytes: 65536,
  importDebounceMs: 3000,
  distillMinAgeMs: 3_600_000,
  distillDefault: 20,
  distillMax: 500,
  distillHeadBytes: 65536,
};

export type RecallRow = { id: string; updatedAt: Date | string; reinforcementDates: readonly string[]; pinned: boolean };

const DAY_MS = 86_400_000;

/** `1 / (k + rank)` summed over the legs; ties: smaller best rank, then the earlier leg that rank was reached in, then id ascending. */
export function rrf(legs: ReadonlyArray<ReadonlyArray<{ id: string }>>, k: number): { id: string; score: number }[] {
  const acc = new Map<string, { id: string; score: number; best: number; leg: number }>();
  legs.forEach((leg, li) => {
    const seen = new Set<string>();
    let rank = 0;
    for (const { id } of leg) {
      if (seen.has(id)) continue;
      seen.add(id);
      rank++;
      const e = acc.get(id) ?? { id, score: 0, best: rank, leg: li };
      e.score += 1 / (k + rank);
      if (rank < e.best) {
        e.best = rank;
        e.leg = li;
      }
      acc.set(id, e);
    }
  });
  return [...acc.values()]
    .sort((a, b) => b.score - a.score || a.best - b.best || a.leg - b.leg || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(({ id, score }) => ({ id, score }));
}

/** `s × 0.5^(ageDays / halfLife) × (1 + ln(1 + distinct reinforcement days)) × (2 if pinned)`; age counts from `updatedAt`, never below 0; non-finite is 0. */
export function recallScore(s: number, m: Omit<RecallRow, 'id'>, o: { now: number; halfLifeDays: number }): number {
  if (!(o.halfLifeDays > 0)) return 0;
  const updated = typeof m.updatedAt === 'string' ? Date.parse(m.updatedAt) : m.updatedAt.getTime();
  const ageDays = Math.max(0, (o.now - updated) / DAY_MS);
  const days = new Set(m.reinforcementDates).size;
  const score = s * 0.5 ** (ageDays / o.halfLifeDays) * (1 + Math.log(1 + days)) * (m.pinned ? 2 : 1);
  return Number.isFinite(score) ? score : 0;
}

/** Fuses the legs, scores each row (the object of the first leg that has it) and sorts by score; ties keep the `rrf` order. Returns copies. */
export function rankRecall<M extends RecallRow>(
  legs: { fts: readonly M[]; vec: readonly M[] },
  o: { k: number; halfLifeDays: number; now: number },
): (M & { score: number })[] {
  const rows = new Map<string, M>();
  for (const m of [...legs.fts, ...legs.vec]) if (!rows.has(m.id)) rows.set(m.id, m);
  return rrf([legs.fts, legs.vec], o.k)
    .map(({ id, score }) => ({ ...(rows.get(id) as M), score: recallScore(score, rows.get(id) as M, o) }))
    .sort((a, b) => b.score - a.score);
}
