/**
 * Prompt push core: which graph node goes into which slot of the one-line suggestion, and how the line is written.
 * Called from: apps/web/src/suggest (the prompt hook and `/v1/suggest`); T5.2 later adds the file note beside this code.
 * Why: the hot path ranks a walk over the RAM graph into "one task, one file:symbol, one skill, one decision" and renders `ctc: ...` within `max_chars`.
 * Deliberately NOT done: I/O, embedding, the walk itself (`walkFrom` of ../query), the skill search, caching, the hook budget (all in apps/web).
 * Untrusted: every label, id, path and relation of the index and every skill name; all of it passes `clean` (sanitize, one space, 256 code points).
 * Nothing here edits its arguments.
 */
import { walkFrom } from '../query/index.ts';
import type { GraphIndex, Seed } from '../query/index.ts';
import { byCode, clean, keyOf } from '../query/model.ts';

/** Node types a prompt may seed from: context and code nodes, not `package`, not capability nodes, not `workflow_step` (D12; chosen by judgment). */
export const SEED_TYPES: readonly string[] = [
  'spec', 'requirement', 'task', 'decision', 'page', 'heading', 'file', 'module', 'class', 'function', 'method', 'interface', 'type', 'variable',
];

export type SkillSeed = { kind: string; name: string; score: number };
export type Cand = { id: string; label: string; type: string; file: string | null; line: number | null; score: number; hop: number };
export type Slots = { task: Cand[]; file: Cand[]; skill: Cand[]; decision: Cand[] };
type Slot = keyof Slots;

const FILE_TYPES = new Set(['file', 'module', 'class', 'function', 'method', 'interface', 'type', 'variable']);
const SKILL_TYPES = new Set(['skill', 'agent', 'command', 'workflow']);
const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;
const localId = (id: string): string => id.slice(id.lastIndexOf(':') + 1);

/** The one slot of a node, or `null` for nodes that are walked through but never shown (spec, requirement, page, heading, package, workflow_step). Pure. */
export function slotOf(node: { kind: string; type: string }): Slot | null {
  if (node.type === 'task') return 'task';
  if (node.type === 'decision') return 'decision';
  if (node.kind === 'code' && FILE_TYPES.has(node.type)) return 'file';
  if (node.kind === 'capability' && SKILL_TYPES.has(node.type)) return 'skill';
  return null;
}

const bySlot = (a: Cand, b: Cand): number =>
  b.score - a.score || a.hop - b.hop || Number(a.type === 'file') - Number(b.type === 'file') || byCode(a.id, b.id);

/**
 * Walks `seeds` (plus the skills that are nodes of the index) `depth` hops and returns, per slot, at most `perSlot` candidates ordered by
 * score desc, hop asc, symbol before file, id asc. `file` candidates are distinct by path. A skill that is not a node stays a standalone candidate.
 * Throws only what `walkFrom` throws for a `depth` outside 0..3; the caller clamps it.
 */
export function rankSlots(index: GraphIndex, o: { seeds: Seed[]; skills: SkillSeed[]; depth: number; perSlot: number }): Slots {
  const skills = o.skills
    .map((s) => ({ kind: clean(s.kind), name: clean(s.name), score: s.score }))
    .filter((s) => s.kind !== '' && s.name !== '');
  const inIndex = skills.filter((s) => index.nodes.has(`${s.kind}:${s.name}`));
  const walked = walkFrom(index, [...o.seeds, ...inIndex.map((s) => ({ id: `${s.kind}:${s.name}`, score: s.score }))], { depth: o.depth });

  const all: Record<Slot, Cand[]> = { task: [], file: [], skill: [], decision: [] };
  for (const h of walked) {
    const slot = slotOf(h);
    if (slot === null || h.id === '') continue;
    // judgment: a code node without a source path cannot be pointed at, so it is not a file candidate
    if (slot === 'file' && h.file === null) continue;
    all[slot].push({ id: h.id, label: h.label || localId(h.id) || h.file || '', type: h.type, file: h.file, line: h.line, score: h.score, hop: h.hop });
  }
  for (const s of skills) {
    const id = `${s.kind}:${s.name}`;
    if (!index.nodes.has(id)) all.skill.push({ id, label: s.name, type: s.kind, file: null, line: null, score: s.score, hop: 0 });
  }

  const out: Slots = { task: [], file: [], skill: [], decision: [] };
  for (const slot of ['task', 'file', 'skill', 'decision'] as const) {
    const seenPath = new Set<string>();
    for (const c of all[slot].sort(bySlot)) {
      if (out[slot].length >= o.perSlot) break;
      if (slot === 'file') {
        if (seenPath.has(c.file as string)) continue;
        seenPath.add(c.file as string);
      }
      out[slot].push({ ...c, score: round4(c.score) });
    }
  }
  return out;
}

const cps = (s: string): number => Array.from(s).length;
const cutTo = (s: string, n: number): string => Array.from(s).slice(0, n).join('');

type Parts = { id: string; rest: string; ptr: string; skill: string; decision: string };

function pointerOf(c: Cand | undefined): string {
  if (!c || c.file === null) return '';
  const file = clean(c.file);
  const symbol = c.type === 'file' ? '' : clean(keyOf(clean(c.label)));
  return file === '' ? '' : symbol === '' ? file : `${file}:${symbol}`;
}

function taskParts(c: Cand | undefined): { id: string; rest: string } {
  if (!c) return { id: '', rest: '' };
  const id = clean(localId(c.id));
  const label = clean(c.label);
  if (id === '') return { id: '', rest: label };
  if (label.startsWith(id) && !/[A-Za-z0-9]/.test(label.charAt(id.length))) return { id, rest: label.slice(id.length) };
  return { id, rest: label === '' ? '' : ` ${label}` };
}

function assemble(p: Parts): string {
  const task = `${p.id}${p.rest}`.trim();
  const head = [task, p.ptr === '' ? '' : `→ ${p.ptr}`].filter((x) => x !== '').join(' ');
  const pieces = [head, p.skill, p.decision].filter((x) => x !== '');
  return pieces.length === 0 ? '' : `ctc: ${pieces.join(' · ')}`;
}

/**
 * `ctc: <task id> <task title> → <file>:<symbol> · <kind>: <name> · decision: <id>` from the first candidate of each slot; a missing piece is
 * dropped. Cut to `maxChars` code points by a ladder that never splits a piece before the last rung: decision, skill, task title (with `…`),
 * task, then the pointer (with `…`). `maxChars` below 8 gives `''`. Pure; the finished line is not passed through `sanitize` (it starts with `ctc: `).
 */
export function renderLine(slots: Slots, o: { maxChars: number }): string {
  if (!(o.maxChars >= 8)) return '';
  const max = Math.floor(o.maxChars);
  const skill = slots.skill[0];
  const decision = slots.decision[0];
  const t = taskParts(slots.task[0]);
  const p: Parts = {
    id: t.id,
    rest: t.rest,
    ptr: pointerOf(slots.file[0]),
    skill: skill && clean(skill.label) !== '' ? `${clean(skill.type)}: ${clean(skill.label)}` : '',
    decision: decision && clean(localId(decision.id)) !== '' ? `decision: ${clean(localId(decision.id))}` : '',
  };
  const fits = (): boolean => cps(assemble(p)) <= max;
  if (fits()) return assemble(p);
  p.decision = '';
  if (fits()) return assemble(p);
  p.skill = '';
  if (fits()) return assemble(p);
  if (p.id !== '' && p.rest.trim() !== '') {
    const full = p.rest;
    for (let n = cps(full) - 1; n >= 2; n--) {
      p.rest = `${cutTo(full, n).trimEnd()}…`;
      if (fits()) return assemble(p);
    }
  }
  p.id = '';
  p.rest = '';
  if (fits()) return assemble(p);
  const prefix = cps('ctc: → ');
  if (p.ptr === '' || max - prefix < 1) return '';
  p.ptr = `${cutTo(p.ptr, max - prefix - 1)}…`;
  return assemble(p);
}
