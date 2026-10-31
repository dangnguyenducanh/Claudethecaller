/**
 * Context document parser: turns one repo document (spec, tasks, `.scratch` issue, `CLAUDE.md`) into `ctx:` nodes, `part_of` edges and raw code references.
 *
 * Called from: the worker context layer (pass.ts, extract.ts) and the parser fixture tests. Why it exists: spec:243-246, spec:284, DECISIONS D3-D6, D9.
 * Deliberately NOT done: any I/O, resolving references to stored nodes (refs.ts), `.claude/skills|agents|commands|workflows` (F2 capabilities), cross-file links
 * other than issue -> feature spec, story/ticket/plan-step node types.
 * Untrusted: every byte of `content`; labels go through `cleanLabel`; the function never throws and never edits its argument.
 */
import { createHash } from 'node:crypto';
import { cleanLabel, fileStem } from '../graph/ids.ts';
import { CONTEXT_VERSION, contextLimits } from './limits.ts';
import type { ContextParse, CtxEdge, CtxNode, CtxRef } from './types.ts';

const ID_SEP = String.raw`[\s:.—–-]*`;
const TASK_ID = String.raw`T\d+(?:\.\d+)*`;
const REQ_ID = String.raw`(?:FR|SC|NFR)-\d+`;
const W = '[*`]*';

/** One code reference without the look-behind: a repo-relative path with a `/` and an extension, optionally `::symbol` (D9). Exported for the reply validator. */
export const REF_BODY = String.raw`((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]*[A-Za-z0-9_-]\.[A-Za-z0-9]{1,8})(?:::([A-Za-z_]\w*))?`;
const REF_SOURCE = String.raw`(?<![\w./@:-])(?:\.\/)?` + REF_BODY;

const CHECKLIST = new RegExp(String.raw`^\s*[-*+]\s+\[([ xX])\]\s+(${TASK_ID})\b${ID_SEP}(.*)$`);
const MARKERS = /^(?:`?\[(?:P|US\d+)\]`?\s*)+/;
const CELL_DECISION = new RegExp(`^${W}(D\\d+)${W}$`);
const CELL_REQ = new RegExp(`^${W}(${REQ_ID})${W}$`);
const CELL_TASK = new RegExp(`^${W}(${TASK_ID})${W}(?:[ \\t:]+(.+))?$`);
const HEADING = /^(#{2,6})\s+(.+)$/;
const H_TASK = new RegExp(String.raw`^(${TASK_ID})\b${ID_SEP}(.*)$`);
const H_DECISION = new RegExp(String.raw`^(D\d+)\b${ID_SEP}(.*)$`);
const H_REQ = new RegExp(String.raw`^(${REQ_ID})\b${ID_SEP}(.*)$`);
const H_STORY = /^User Story (\d+)\s*[-–—:]\s*(.+?)(?:\s*\(Priority:\s*(P\d)\))?\s*$/;
const BULLET_REQ = new RegExp(String.raw`^\s*[-*+]\s+\*\*(${REQ_ID})\*\*[:.]?\s*(.*)$`);
const BULLET_DECISION = /^\s*[-*+]\s+\**(D\d+)\**[:.]?\s+(.+)$/;
const FENCE = /^ {0,3}(```|~~~)/;
const ISSUE_PATH = /^\.scratch\/(.+)\/issues\/(\d{1,4})-[^/]*\.md$/;
const CONTEXT_PATH = /^(?:specs|\.scratch|\.claude\/prds|\.claude\/plans)\/(?:.+\/)?[^/]+\.md$/;
const CLAUDE_DECISION = /^- (\d{4}-\d{2}-\d{2}) [—–-] (.+)$/;
const MAX_CONTINUATION = 40;

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const empty = (file: string): ContextParse => ({ file, nodes: [], edges: [], refs: [], truncated: false, error: null });
const fail = (file: string, code: 'bad_path' | 'too_large' | 'internal', message: string): ContextParse => ({ ...empty(file), error: { code, message } });

/** Same rule as `safeRel` of the worker walk (D1a): relative, `/`-separated, no empty, `.` or `..` segment, no backslash or NUL. */
function validPath(p: unknown): p is string {
  return typeof p === 'string' && p !== '' && !p.includes('\0') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** True exactly for `CLAUDE.md` at the root, `specs/**`, `.scratch/**`, `.claude/prds/**` and `.claude/plans/**` markdown files (D4). Never throws. */
export function isContextPath(path: string): boolean {
  return typeof path === 'string' && (path === 'CLAUDE.md' || CONTEXT_PATH.test(path));
}

type Draft = { local: string; type: 'task' | 'requirement' | 'decision'; label: string; line: number; endLine: number; source: string; meta: Record<string, unknown> };

const fileLines = (content: string): string[] => {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

/** Line numbers (1-based) that are outside a fenced code block and are not fence lines themselves. */
function unfenced(lines: string[]): boolean[] {
  const out: boolean[] = [];
  let inside = false;
  for (const l of lines) {
    if (FENCE.test(l)) {
      inside = !inside;
      out.push(false);
    } else out.push(!inside);
  }
  return out;
}

const label = (raw: string, id: string): string => cleanLabel(raw.trim()).trim() || id;

/** Splits a table row into trimmed cells; the pipes at the outer edges are removed, `\|` stays inside its cell. */
function cellsOf(trimmed: string): string[] {
  let body = trimmed.slice(1);
  body = body.replace(/(?<!\\)\|\s*$/, '');
  return body.split(/(?<!\\)\|/).map((c) => c.trim());
}

/** Code references of one text, in appearance order, without `..`/`.` segments. Never throws. */
function refTokens(text: string): { kind: 'path' | 'path_symbol'; target: string }[] {
  const out: { kind: 'path' | 'path_symbol'; target: string }[] = [];
  for (const m of text.matchAll(new RegExp(REF_SOURCE, 'g'))) {
    const p = m[1] as string;
    if (p.split('/').some((s) => s === '.' || s === '..')) continue;
    out.push(m[2] === undefined ? { kind: 'path', target: p } : { kind: 'path_symbol', target: `${p}::${m[2]}` });
  }
  return out;
}

/** Adds the references of `lines` (with their line numbers) to `refs`, deduplicated per `(from, kind, target)` and cut to `maxRefsPerNode`. */
function collectRefs(refs: CtxRef[], from: string, relation: 'implements' | 'decides', lines: { text: string; line: number }[]): void {
  const seen = new Set<string>();
  let n = 0;
  for (const { text, line } of lines) {
    for (const t of refTokens(text)) {
      const key = `${t.kind}\0${t.target}`;
      if (seen.has(key)) continue;
      if (n >= contextLimits.maxRefsPerNode) return;
      seen.add(key);
      n++;
      refs.push({ from, relation, kind: t.kind, target: t.target, line });
    }
  }
}

/** The rule table of D5, one node at most per line. */
function draftOf(line: string, n: number): Draft | null {
  const mk = (local: string, type: Draft['type'], raw: string, meta: Record<string, unknown> = {}): Draft => ({ local, type, label: label(raw, local), line: n, endLine: n, source: line, meta });
  let m = CHECKLIST.exec(line);
  if (m) {
    const rest = (m[3] as string).trim();
    const stripped = rest.replace(MARKERS, '');
    const parallel = /\[P\]/.test(rest.slice(0, rest.length - stripped.length));
    return mk(m[2] as string, 'task', stripped, { done: m[1] !== ' ', ...(parallel ? { parallel: true } : {}) });
  }
  const trimmed = line.trim();
  if (trimmed.startsWith('|')) {
    const cells = cellsOf(trimmed);
    const first = cells[0] ?? '';
    const d = CELL_DECISION.exec(first);
    if (d) return mk(d[1] as string, 'decision', cells[1] ?? '', cells[2] ? { value: cells[2] } : {});
    const r = CELL_REQ.exec(first);
    if (r) return mk(r[1] as string, 'requirement', cells[1] ?? '');
    for (const i of [0, 1]) {
      const t = CELL_TASK.exec(cells[i] ?? '');
      if (t) return mk(t[1] as string, 'task', t[2] ?? cells[i + 1] ?? '');
    }
    return null;
  }
  m = HEADING.exec(line);
  if (m) {
    const text = (m[2] as string).trim();
    const t = H_TASK.exec(text);
    if (t) return mk(t[1] as string, 'task', t[2] as string);
    const d = H_DECISION.exec(text);
    if (d) return mk(d[1] as string, 'decision', d[2] as string);
    const q = H_REQ.exec(text);
    if (q) return mk(q[1] as string, 'requirement', q[2] as string);
    const s = H_STORY.exec(text);
    if (s) return mk(`US${s[1]}`, 'requirement', s[2] as string, s[3] ? { priority: s[3] } : {});
    return null;
  }
  m = BULLET_REQ.exec(line);
  if (m) return mk(m[1] as string, 'requirement', m[2] as string);
  m = BULLET_DECISION.exec(line);
  if (m) return mk(m[1] as string, 'decision', m[2] as string);
  return null;
}

/** First `# ` heading outside fences: its 1-based line and text. */
function titleOf(lines: string[], open: boolean[]): { line: number; text: string } | null {
  for (let i = 0; i < lines.length; i++) if (open[i] && (lines[i] as string).startsWith('# ')) return { line: i + 1, text: (lines[i] as string).slice(2) };
  return null;
}

class Builder {
  readonly nodes: CtxNode[] = [];
  readonly stem: string;
  constructor(stem: string) {
    this.stem = stem;
  }
  id(local: string): string {
    return `ctx:${this.stem}:${local}`;
  }
  add(local: string, type: CtxNode['type'], lbl: string, line: number, source: string, meta: Record<string, unknown>): CtxNode {
    const id = this.id(local);
    const node: CtxNode = { id, kind: 'context', type, label: lbl, sourceLocation: `L${line}`, contentHash: sha(`${CONTEXT_VERSION}\0${id}\0${type}\0${lbl}\0${source}`), meta };
    this.nodes.push(node);
    return node;
  }
}

function parseDocument(path: string, lines: string[]): ContextParse {
  const open = unfenced(lines);
  const stem = fileStem(path);
  const b = new Builder(stem);
  const seen = new Set<string>();
  const drafts: Draft[] = [];
  let truncated = false;
  for (let i = 0; i < lines.length; i++) {
    if (!open[i]) continue;
    const d = draftOf(lines[i] as string, i + 1);
    // judgment: the first occurrence of an id wins; a later one is ignored (no node, no ref) rather than overwriting
    if (!d || seen.has(d.local)) continue;
    seen.add(d.local);
    if (drafts.length >= contextLimits.maxNodesPerFile) {
      truncated = true;
      break;
    }
    drafts.push(d);
  }
  const members = new Set(drafts.filter((d) => d.type === 'task' || d.type === 'requirement'));
  const edges: CtxEdge[] = [];
  const nodes: CtxNode[] = [];
  const specId = b.id('spec');
  if (members.size > 0) {
    const t = titleOf(lines, open);
    const base = path.slice(path.lastIndexOf('/') + 1);
    const title = label((t?.text ?? '').replace(/^(?:Feature Specification|Implementation Plan|Tasks|Spec):\s*/, ''), fileStem(base));
    nodes.push(b.add('spec', 'spec', title, t?.line ?? 1, t?.text === undefined ? '' : (lines[t.line - 1] as string), { lines: [1, lines.length], title }));
  }
  const refs: CtxRef[] = [];
  for (const d of drafts) {
    const node = b.add(d.local, d.type, d.label, d.line, d.source, { lines: [d.line, d.endLine], ...d.meta });
    nodes.push(node);
    if (d.type === 'task' || d.type === 'decision') collectRefs(refs, node.id, d.type === 'task' ? 'implements' : 'decides', [{ text: d.source, line: d.line }]);
    if (members.has(d)) edges.push({ src: node.id, dst: specId, relation: 'part_of', confidence: 'EXTRACTED', score: 1, sourceLocation: node.sourceLocation });
  }
  edges.sort((x, y) => byCode(x.src, y.src) || byCode(x.dst, y.dst) || byCode(x.relation, y.relation));
  return { file: path, nodes, edges, refs, truncated, error: null };
}

function parseIssue(path: string, lines: string[], feature: string, nn: string): ContextParse {
  const open = unfenced(lines);
  const b = new Builder(fileStem(path));
  const local = `issue-${nn}`;
  const t = titleOf(lines, open);
  const base = path.slice(path.lastIndexOf('/') + 1);
  const lbl = label((t?.text ?? '').replace(/^\d+\s*[—–-]\s*/, ''), fileStem(base));
  const meta: Record<string, unknown> = { lines: [1, lines.length] };
  const field = (name: string): string | undefined => {
    const re = new RegExp(`^${name}:(.*)$`);
    for (let i = 0; i < lines.length; i++) {
      const m = open[i] ? re.exec(lines[i] as string) : null;
      if (m) return (m[1] as string).trim();
    }
    return undefined;
  };
  const status = field('Status');
  const blocked = field('Blocked by');
  if (status) meta['status'] = status;
  if (blocked) meta['blockedBy'] = blocked;
  const node = b.add(local, 'task', lbl, t?.line ?? 1, t === null ? '' : (lines[t.line - 1] as string), meta);
  const refs: CtxRef[] = [{ from: node.id, relation: 'part_of', kind: 'node', target: `ctx:.scratch/${feature}/spec:spec`, line: 1 }];
  collectRefs(refs, node.id, 'implements', lines.flatMap((text, i) => (open[i] ? [{ text, line: i + 1 }] : [])));
  return { file: path, nodes: [node], edges: [], refs, truncated: false, error: null };
}

function parseClaude(path: string, lines: string[]): ContextParse {
  const open = unfenced(lines);
  const b = new Builder(fileStem(path));
  const perDate = new Map<string, number>();
  const refs: CtxRef[] = [];
  let truncated = false;
  for (let i = 0; i < lines.length; i++) {
    const m = open[i] ? CLAUDE_DECISION.exec(lines[i] as string) : null;
    if (!m) continue;
    if (b.nodes.length >= contextLimits.maxNodesPerFile) {
      truncated = true;
      break;
    }
    const date = m[1] as string;
    const count = (perDate.get(date) ?? 0) + 1;
    perDate.set(date, count);
    const local = count === 1 ? `D${date}` : `D${date}-${count}`;
    const text = m[2] as string;
    const cutAt = text.indexOf('. ');
    const lbl = label((cutAt === -1 ? text : text.slice(0, cutAt)).replace(/\.$/, ''), local);
    let end = i;
    while (end + 1 < lines.length && end - i < MAX_CONTINUATION) {
      const next = lines[end + 1] as string;
      if (next.trim() === '' || next.startsWith('- ') || next.startsWith('#') || FENCE.test(next)) break;
      end++;
    }
    const span = lines.slice(i, end + 1);
    const node = b.add(local, 'decision', lbl, i + 1, span.join('\n'), { lines: [i + 1, end + 1], date });
    collectRefs(refs, node.id, 'decides', span.map((text2, k) => ({ text: text2, line: i + 1 + k })));
  }
  return { file: path, nodes: b.nodes, edges: [], refs, truncated, error: null };
}

/**
 * Parses one document. `path` must be a valid relative path (else `error.code = 'bad_path'`); a valid path that is not a context path gives an empty parse;
 * content over `contextLimits.maxFileChars` gives `too_large`. Deterministic; never throws (a bug becomes `error.code = 'internal'`).
 */
export function parseContext(input: { path: string; content: string }): ContextParse {
  const path = input?.path;
  try {
    if (!validPath(path)) return fail(typeof path === 'string' ? path : '', 'bad_path', 'path is not a safe relative path');
    // judgment: a valid path that is not a context path is not an error, the caller may hand over any file
    if (!isContextPath(path)) return empty(path);
    const content = input.content;
    if (typeof content !== 'string') return fail(path, 'internal', 'content is not a string');
    if (content.length > contextLimits.maxFileChars) return fail(path, 'too_large', `content is longer than ${contextLimits.maxFileChars} characters`);
    const lines = fileLines(content);
    if (path === 'CLAUDE.md') return parseClaude(path, lines);
    const issue = ISSUE_PATH.exec(path);
    if (issue) return parseIssue(path, lines, issue[1] as string, issue[2] as string);
    return parseDocument(path, lines);
  } catch {
    return fail(typeof path === 'string' ? path : '', 'internal', 'the parser failed on this document');
  }
}
