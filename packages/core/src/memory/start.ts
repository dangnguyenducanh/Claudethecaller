/**
 * The SessionStart block: one-line text cleaning, index rows for search results, and the render-measure-drop loop that keeps the block under
 * `context_chars`. Called from: apps/web/src/memory (`/v1/hook/start`, `mem_search`, `mem_timeline`). Why: spec:526-529, the block must never
 * exceed its budget and every line must carry the `ctc: ` prefix that `sanitize` strips again if Claude Code stores the block in a user turn.
 * Deliberately NOT done: reading the store, ranking, choosing the summaries. Untrusted: every string (written by a model or a user).
 */
import { CTC_LINE_PREFIX, cut, sanitize } from '../sanitize/index.ts';
import { recallLimits } from './recall.ts';

type SummaryFields = { request: string; investigated: string; learned: string; completed: string; nextSteps: string; notes: string };
export type StartInput = { project: string; summaries: (SummaryFields & { createdAt: Date | string })[]; memories: { kind: string; text: string }[] };

/** `sanitize`, then every whitespace run becomes one space, then trim: a stored value can never break the line-prefix rule. */
export function cleanLine(text: string): string {
  return sanitize(typeof text === 'string' ? text : '').replace(/\s+/g, ' ').trim();
}

/** `YYYY-MM-DD` (UTC) of a date or an ISO string; `unknown` for anything that is not a date. */
export function dayOf(d: Date | string): string {
  const t = typeof d === 'string' ? Date.parse(d) : d instanceof Date ? d.getTime() : Number.NaN;
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : 'unknown';
}

/** `<id> · <day> · <kind> · <first indexChars code units of the cleaned text>`; the cut never splits a surrogate pair. */
export function indexRow(m: { id: string; createdAt: Date | string; kind: string; text: string }): string {
  return `${m.id} · ${dayOf(m.createdAt)} · ${m.kind} · ${cut(cleanLine(m.text), recallLimits.indexChars)}`;
}

const FIELDS = [['request', 'request'], ['investigated', 'investigated'], ['learned', 'learned'], ['completed', 'completed'], ['nextSteps', 'next steps'], ['notes', 'notes']] as const;

const fieldLines = (s: SummaryFields): string[] =>
  FIELDS.flatMap(([key, label]) => {
    const v = cleanLine(s[key]);
    return v === '' ? [] : [`${CTC_LINE_PREFIX}${label}: ${v}`];
  });

/** The block as `ctc: ` lines joined by `\n`; `''` when there is no summary line and no memory (the header is never sent alone). */
export function renderStartBlock(input: StartInput): string {
  const shown = input.summaries.map((s) => ({ day: dayOf(s.createdAt), lines: fieldLines(s) })).filter((s) => s.lines.length > 0);
  const memories = input.memories.flatMap((m) => {
    const text = cleanLine(m.text);
    return text === '' ? [] : [`${CTC_LINE_PREFIX}- [${cleanLine(m.kind)}] ${text}`];
  });
  if (shown.length === 0 && memories.length === 0) return '';
  const lines = [`${CTC_LINE_PREFIX}# Memory · ${cleanLine(input.project)}`];
  const [last, ...older] = shown;
  if (last) lines.push(`${CTC_LINE_PREFIX}## Last session · ${last.day}`, ...last.lines);
  if (older.length > 0) lines.push(`${CTC_LINE_PREFIX}## Earlier sessions`, ...older.flatMap((s) => [`${CTC_LINE_PREFIX}### ${s.day}`, ...s.lines]));
  if (memories.length > 0) lines.push(`${CTC_LINE_PREFIX}## Memories`, ...memories);
  return lines.join('\n');
}

/**
 * Renders, then applies in fixed order notes, investigated, older summaries, halve the memories (repeated), last summary while the text is over
 * `maxChars` (`text.length`). Each applied step is recorded; a step that changes nothing is still recorded when reached. Returns copies.
 */
export function fitStartBlock(input: StartInput, maxChars: number): { text: string; steps: string[] } {
  let text = renderStartBlock(input);
  if (!(maxChars >= 1) || text === '') return { text: '', steps: [] };
  const live = (list: StartInput['summaries']): StartInput['summaries'] => list.filter((s) => fieldLines(s).length > 0);
  let summaries = live(input.summaries);
  let memories = input.memories.filter((m) => cleanLine(m.text) !== '');
  const steps: string[] = [];
  const apply = (name: string, next: () => void): boolean => {
    if (text.length <= maxChars) return false;
    steps.push(name);
    next();
    text = renderStartBlock({ project: input.project, summaries, memories });
    return true;
  };
  apply('notes', () => (summaries = live(summaries.map((s) => ({ ...s, notes: '' })))));
  apply('investigated', () => (summaries = live(summaries.map((s) => ({ ...s, investigated: '' })))));
  apply('older', () => (summaries = summaries.slice(0, 1)));
  while (memories.length > 0 && text.length > maxChars) {
    const n = Math.floor(memories.length / 2);
    apply(`halve:${n}`, () => (memories = memories.slice(0, n)));
  }
  apply('last', () => (summaries = []));
  return { text, steps };
}
