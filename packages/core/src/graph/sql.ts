/**
 * Statement scanner for `.sql` files (D15): no tree-sitter grammar, one pass over the text.
 *
 * Called from: `extract.ts`. Why it exists: no WASM build of a SQL grammar is published. Deliberately NOT done:
 * indexes, triggers, policies, ALTER and DML, raw refs, a real SQL parse.
 */
import type { Out } from './build.ts';
import type { NodeType } from './types.ts';

const WORD_START = /[A-Za-z_{]/;
const WORD_CHAR = /[A-Za-z0-9_${}]/;
const DOLLAR_TAG = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;
const MAX_TAG_CHARS = 130;

const OBJECT_TYPES: Record<string, NodeType> = { table: 'table', view: 'table', function: 'function', procedure: 'function', type: 'type' };
const MODIFIERS = new Set(['or', 'replace', 'temp', 'temporary', 'unlogged']);

interface Token {
  /** Lower-cased word; `.` and `;` for those characters. */
  word: string;
  /** Source text of the word, quotes removed. */
  raw: string;
  start: number;
  line: number;
}

/** Word tokens, `.` and `;`; comments, string literals and dollar-quoted bodies are skipped. */
function tokenize(text: string): Token[] {
  const toks: Token[] = [];
  const n = text.length;
  let i = 0;
  let line = 1;
  while (i < n) {
    const c = text.charAt(i);
    if (c === '\n') {
      line++;
      i++;
    } else if (c === '-' && text[i + 1] === '-') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === '/' && text[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (text[i] === '*' && text[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          if (text[i] === '\n') line++;
          i++;
        }
      }
    } else if (c === "'") {
      i++;
      while (i < n) {
        if (text[i] === "'") {
          if (text[i + 1] !== "'") break;
          i += 2;
        } else {
          if (text[i] === '\n') line++;
          i++;
        }
      }
      i++;
    } else if (c === '"') {
      const start = i;
      const startLine = line;
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\n') line++;
        i++;
      }
      const raw = text.slice(start + 1, i);
      i++;
      toks.push({ word: raw.toLowerCase(), raw, start, line: startLine });
    } else if (c === '$') {
      const m = DOLLAR_TAG.exec(text.slice(i, i + MAX_TAG_CHARS));
      if (m) {
        const tag = m[0];
        const close = text.indexOf(tag, i + tag.length);
        const bodyEnd = close < 0 ? n : close + tag.length;
        for (let k = i; k < bodyEnd; k++) if (text[k] === '\n') line++;
        i = bodyEnd;
      } else {
        i++;
      }
    } else if (c === ';' || c === '.') {
      toks.push({ word: c, raw: c, start: i, line });
      i++;
    } else if (WORD_START.test(c)) {
      const start = i;
      i++;
      while (i < n && WORD_CHAR.test(text.charAt(i))) i++;
      const raw = text.slice(start, i);
      toks.push({ word: raw.toLowerCase(), raw, start, line });
    } else {
      i++;
    }
  }
  return toks;
}

export function extractSql(text: string, out: Out): void {
  const toks = tokenize(text);
  let lineStart = 0;
  let lineStartAt = 1;
  const colOf = (t: Token): number => {
    // tokens arrive in order, so line starts are found by scanning forward from the previous one
    while (lineStartAt < t.line) {
      lineStart = text.indexOf('\n', lineStart) + 1;
      lineStartAt++;
    }
    return t.start - lineStart;
  };
  const found: { token: Token; name: string; type: NodeType; nameIndex: number }[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] as Token;
    if (t.word !== 'create') continue;
    let j = i + 1;
    while (MODIFIERS.has(toks[j]?.word ?? '')) j++;
    let kindWord = toks[j]?.word ?? '';
    if (kindWord === 'materialized' && toks[j + 1]?.word === 'view') {
      kindWord = 'view';
      j++;
    }
    const type = Object.hasOwn(OBJECT_TYPES, kindWord) ? OBJECT_TYPES[kindWord] : undefined;
    if (!type) continue;
    j++;
    if (toks[j]?.word === 'if' && toks[j + 1]?.word === 'not' && toks[j + 2]?.word === 'exists') j += 3;
    let name = '';
    while (toks[j] && toks[j]?.word !== ';' && toks[j]?.word !== '.') {
      name = (toks[j] as Token).raw;
      j++;
      if (toks[j]?.word !== '.') break;
      j++;
    }
    if (name !== '') found.push({ token: t, name, type, nameIndex: j - 1 });
  }
  let ti = 0;
  for (const f of found) {
    while (ti < toks.length && (ti <= f.nameIndex || (toks[ti] as Token).word !== ';')) ti++;
    const semi = toks[ti];
    out.add({
      names: [f.name],
      type: f.type,
      label: f.name,
      startLine: f.token.line,
      startCol: colOf(f.token),
      endLine: semi ? semi.line : out.totalLines,
      parent: out.fileId,
    });
  }
}
