/**
 * Line scanner for markdown: page and heading nodes plus raw mentions (D16, D20). No markdown library, because
 * CommonMark would add setext and indented headings that graphify 0.9.93 does not have.
 *
 * Called from: `extract.ts`. Why it exists: graphify-compatible `doc:` ids. Deliberately NOT done: setext headings,
 * `~~~` fences, wikilinks, multi-line code spans, resolving mentions (T2.2/T2.3).
 */
import type { Out } from './build.ts';
import { limits } from './types.ts';

const MAX_SPAN_CHARS = 512;
const PATH_SYMBOL = /^[A-Za-z0-9_./-]+\.[A-Za-z0-9]+::[A-Za-z_]\w*(::[A-Za-z_]\w*)*(\(\))?$/;
const SYMBOL = /^([A-Za-z_]\w*\.)*[A-Za-z_]\w*(\(\))?$/;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const MAX_HEADING_LEVEL = 6;

interface Open {
  level: number;
  id: string;
  startLine: number;
  startCol: number;
  title: string;
  parent: string;
}

/** ATX heading `^(#{1,6})\s+(.+)` (dot matches every character); returns level and trimmed title or null. */
function parseHeading(line: string): { level: number; title: string } | null {
  let level = 0;
  while (level < line.length && line.charCodeAt(level) === 35) level++;
  if (level < 1 || level > MAX_HEADING_LEVEL) return null;
  const rest = line.slice(level);
  if (rest.length < 2 || !/^\s/.test(rest)) return null;
  return { level, title: rest.trim() };
}

function cleanTarget(raw: string): string | null {
  let t = raw.trim();
  if (t.startsWith('<')) {
    const close = t.indexOf('>');
    t = close < 0 ? t.slice(1) : t.slice(1, close);
  } else {
    const ws = t.search(/\s/);
    if (ws >= 0) t = t.slice(0, ws);
  }
  const cut = t.search(/[#?]/);
  if (cut >= 0) t = t.slice(0, cut);
  if (t === '' || URL_SCHEME.test(t) || t.startsWith('//')) return null;
  return t;
}

interface Found {
  pos: number;
  kind: 'symbol' | 'path_symbol' | 'link';
  target: string;
}

/** Code spans (equal-length backtick runs) and links of one line, in order of position. */
function scanLine(line: string): Found[] {
  const found: Found[] = [];
  if (line.includes('`')) {
    const runs: { start: number; len: number }[] = [];
    for (let i = 0; i < line.length; ) {
      if (line.charCodeAt(i) !== 96) {
        i++;
        continue;
      }
      let j = i;
      while (j < line.length && line.charCodeAt(j) === 96) j++;
      runs.push({ start: i, len: j - i });
      i = j;
    }
    for (let a = 0; a < runs.length; a++) {
      const open = runs[a] as { start: number; len: number };
      let b = a + 1;
      while (b < runs.length && (runs[b] as { len: number }).len !== open.len) b++;
      if (b >= runs.length) continue;
      const close = runs[b] as { start: number; len: number };
      const content = line.slice(open.start + open.len, close.start).trim();
      a = b;
      if (content.length > MAX_SPAN_CHARS) continue;
      if (PATH_SYMBOL.test(content)) found.push({ pos: open.start, kind: 'path_symbol', target: content.replace(/\(\)$/, '') });
      else if (SYMBOL.test(content)) found.push({ pos: open.start, kind: 'symbol', target: content.replace(/\(\)$/, '') });
    }
  }
  if (line.includes('](')) {
    let nextClose = -2;
    let nextParen = -2;
    for (let i = line.indexOf('['); i >= 0 && i < line.length; i = line.indexOf('[', i + 1)) {
      if (nextClose !== -1 && nextClose < i) nextClose = line.indexOf(']', i + 1);
      if (nextClose < 0) break;
      if (line.charCodeAt(nextClose + 1) !== 40) continue;
      const inner = line.indexOf('[', i + 1);
      if (inner >= 0 && inner < nextClose) continue;
      if (nextParen !== -1 && nextParen < nextClose + 2) nextParen = line.indexOf(')', nextClose + 2);
      if (nextParen < 0) continue;
      if (i > 0 && line.charCodeAt(i - 1) === 33) continue;
      const target = cleanTarget(line.slice(nextClose + 2, nextParen));
      if (target !== null) found.push({ pos: i, kind: 'link', target });
    }
  }
  const def = /^\[[^\]]*\]:[ \t]*(\S+)/.exec(line);
  if (def?.[1]) {
    const target = cleanTarget(def[1]);
    if (target !== null) found.push({ pos: 0, kind: 'link', target });
  }
  return found.sort((x, y) => x.pos - y.pos);
}

export function extractMarkdown(text: string, out: Out): void {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const trimEnd = (l: string): string => (l.endsWith('\r') ? l.slice(0, -1) : l);

  let first = 0;
  if ((lines[0] ?? '').trim() === '---') {
    const lastAllowed = Math.min(lines.length, 1 + limits.frontmatterMaxLines);
    for (let i = 1; i < lastAllowed; i++) {
      const t = (lines[i] as string).trim();
      if (t === '---' || t === '...') {
        first = i + 1;
        break;
      }
    }
  }

  const stack: Open[] = [];
  let currentId = out.fileId;
  const finish = (h: Open, endLine: number): void => {
    out.addWithId(h.id, { type: 'heading', label: h.title, startLine: h.startLine, startCol: h.startCol, endLine, parent: h.parent });
  };
  let inFence = false;
  for (let idx = first; idx < lines.length; idx++) {
    const line = trimEnd(lines[idx] as string);
    const lineNo = idx + 1;
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = parseHeading(line);
    if (h) {
      while (stack.length > 0 && (stack[stack.length - 1] as Open).level >= h.level) finish(stack.pop() as Open, lineNo - 1);
      const stemId = (n: string[]): string => out.idOf(...n);
      let id = stemId([h.title]);
      for (let k = 1; out.has(id) || stack.some((s) => s.id === id); k++) {
        // judgment: a repeated title takes the line number (graphify); a collision with that too takes a counter
        id = k === 1 ? stemId([h.title, String(lineNo)]) : stemId([h.title, String(lineNo), String(k)]);
      }
      const parent = stack.length > 0 ? (stack[stack.length - 1] as Open).id : out.fileId;
      const open: Open = { level: h.level, id, startLine: lineNo, startCol: 0, title: h.title, parent };
      stack.push(open);
      currentId = id;
    }
    for (const f of scanLine(line)) out.addMention({ from: currentId, kind: f.kind, target: f.target, line: lineNo });
  }
  while (stack.length > 0) finish(stack.pop() as Open, out.totalLines);
}
