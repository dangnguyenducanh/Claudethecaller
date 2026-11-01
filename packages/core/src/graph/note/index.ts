/**
 * Pre-tool note core: the file note (tasks that implement a file, decisions that decide it, its top callers) and the search hint (graph nodes
 * that match the words of a grep/rg/find/Grep/Glob call), plus the parsers that turn a tool input into a project-relative path or search terms.
 * Called from: apps/web/src/pre (`POST /v1/hook/pre`). Why: spec:317-318 give the model the graph's answer before it opens a file or searches.
 * Deliberately NOT done: any I/O (pure; no file read, no shell, no network), embedding, walking the graph (only the direct edges of D13 are read),
 * session caps and the hook budget (apps/web/src/pre), the `settings.json` matcher (T7.1). Untrusted: every tool input, command, path, and every
 * label, id and path read from the index. Every piece of text that enters a result passes `clean`; the finished text is never passed through
 * `sanitize` (it starts with `ctc: ` and would erase itself). No function here throws or edits its arguments.
 */
import path from 'node:path';
import { slotOf } from '../push/index.ts';
import { lexicalSeeds, type GNode, type GraphIndex } from '../query/index.ts';
import { byCode, clean, keyOf, weightOf } from '../query/model.ts';

/**
 * Read at call time, so a test may assign to it and restore it. All chosen by judgment: `itemChars` keeps one item from eating the 400 characters,
 * `tokenMin`/`tokenMax` drop noise words and blobs, `tokensMax` bounds the lexical scans (one per token), `commandChars` bounds the shell parse.
 */
export const noteLimits = { itemChars: 80, tokenMin: 3, tokenMax: 64, tokensMax: 4, commandChars: 4096 };

/** Node types a hint may name; `slotOf` of push gives `file` for each of them with kind `code`. */
export const HINT_TYPES: readonly string[] = ['file', 'module', 'class', 'function', 'method', 'interface', 'type', 'variable'];

const cps = (s: string): number => Array.from(s).length;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const localId = (id: string): string => id.slice(id.lastIndexOf(':') + 1);

/** One item cut to `itemChars` code points, the last kept one replaced by `…`. */
function cutItem(s: string): string {
  const max = noteLimits.itemChars;
  if (cps(s) <= max) return s;
  return `${Array.from(s).slice(0, max - 1).join('')}…`;
}

/**
 * The project-relative path of `p` (absolute, or relative to `root`), or `null` when it is the root itself, outside it, empty, has a NUL or is not
 * a string. Lexical only: symlinks are not resolved. Never throws.
 */
export function relInside(root: string, p: string): string | null {
  if (typeof root !== 'string' || typeof p !== 'string' || p === '' || p.includes('\0') || !path.posix.isAbsolute(root)) return null;
  const rel = relativeTo(root, p);
  return rel === '' || rel === '..' || rel.startsWith('../') ? null : rel;
}

function relativeTo(root: string, p: string): string {
  const abs = path.posix.isAbsolute(p) ? path.posix.normalize(p) : path.posix.normalize(path.posix.join(root, p));
  return path.posix.relative(root, abs);
}

/** A location that cannot be shown to be inside the root: `~...`, `$...` (no expansion here), a NUL, or a path that resolves outside. */
function isOutside(root: string, loc: string): boolean {
  // judgment: `$VAR/...` cannot be resolved without expansion, so it counts as outside (silence over a guess)
  if (loc.startsWith('~') || loc.startsWith('$') || loc.includes('\0')) return true;
  const rel = relativeTo(root, loc);
  return rel === '..' || rel.startsWith('../');
}

type Segment = string[];

/** Splits a shell command into segments of words at unquoted `||`, `&&`, `|`, `;`, `&` and newlines. Quotes group; an unmatched quote runs to the end; no expansion; a backslash only protects a following space or operator. */
function segmentsOf(command: string): Segment[] {
  const out: Segment[] = [];
  let words: string[] = [];
  let cur = '';
  let has = false;
  let quote = '';
  const endWord = (): void => {
    if (has) words.push(cur);
    cur = '';
    has = false;
  };
  const endSegment = (): void => {
    endWord();
    if (words.length > 0) out.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    if (quote !== '') {
      if (ch === quote) quote = '';
      else cur += ch;
      continue;
    }
    const next = command[i + 1];
    if (ch === '\\' && next !== undefined && /[\s;|&]/.test(next)) {
      // a backslash before a space or an operator keeps it in the word (`grep spool\ drain`, `grep a\|b`); other escapes stay for tokensOf
      cur += /\s/.test(next) ? ' ' : `\\${next}`;
      has = true;
      i++;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') endSegment();
    else if (/\s/.test(ch)) endWord();
    else {
      cur += ch;
      has = true;
    }
  }
  endSegment();
  return out;
}

const WRAPPERS = new Set(['sudo', 'command', 'time', 'nohup', 'env', 'exec', 'xargs', 'nice']);
const GREPS = new Set(['grep', 'egrep', 'fgrep', 'rg']);
const VALUE_OPTIONS = new Set([
  '-e', '--regexp', '-f', '--file', '-m', '--max-count', '-A', '-B', '-C', '--after-context', '--before-context', '--context', '-g', '--glob', '--iglob', '-t', '-T', '--type',
  '--type-not', '--include', '--exclude', '--exclude-dir', '-d', '-D', '--max-depth', '-j', '--threads', '-M', '--max-columns',
]);
const FIND_PATTERN_OPTIONS = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-regex', '-iregex']);

type Found = { words: string[]; locations: string[] };

/** The search words and locations of one segment, or `null` when its command is not grep/egrep/fgrep/rg/find. */
function searchOf(seg: Segment): Found | null {
  let i = 0;
  while (i < seg.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[i] as string) || WRAPPERS.has(path.posix.basename(seg[i] as string)))) i++;
  const command = path.posix.basename(seg[i] ?? '');
  const rest = seg.slice(i + 1);
  if (command === 'find') {
    const cut = rest.findIndex((w) => w.startsWith('-'));
    const locations = cut < 0 ? rest : rest.slice(0, cut);
    const words: string[] = [];
    for (let k = 0; k < rest.length - 1; k++) if (FIND_PATTERN_OPTIONS.has(rest[k] as string)) words.push(rest[k + 1] as string);
    return { words, locations };
  }
  if (!GREPS.has(command)) return null;
  const words: string[] = [];
  const plain: string[] = [];
  let seenE = false;
  let dashes = false;
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k] as string;
    if (!dashes && w === '--') dashes = true;
    else if (!dashes && (w.startsWith('--regexp=') || /^-[A-Za-z]*e./.test(w))) {
      // `--regexp=PAT` and `-ePAT` carry their pattern in the same word
      seenE = true;
      words.push(w.startsWith('--regexp=') ? w.slice('--regexp='.length) : w.slice(w.indexOf('e', 1) + 1));
    } else if (!dashes && w.startsWith('-')) {
      if (VALUE_OPTIONS.has(w) || (/^-[A-Za-z]+e$/.test(w) && !w.startsWith('--'))) {
        const value = rest[++k];
        if ((w === '--regexp' || /^-[A-Za-z]*e$/.test(w)) && value !== undefined) {
          seenE = true;
          words.push(value);
        }
      }
    } else plain.push(w);
  }
  if (!seenE && plain.length > 0) words.push(plain.shift() as string);
  return { words, locations: plain };
}

/** Lowercase letter/digit runs of the words (after dropping `\<letter>` escapes), within the length limits, distinct, first-seen order, at most `tokensMax`. */
function tokensOf(words: string[]): string[] {
  const out: string[] = [];
  for (const w of words) {
    for (const m of w.replace(/\\\p{L}/gu, ' ').toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
      const len = cps(m[0]);
      if (len >= noteLimits.tokenMin && len <= noteLimits.tokenMax && !out.includes(m[0])) out.push(m[0]);
    }
  }
  return out.slice(0, noteLimits.tokensMax);
}

/**
 * The search terms of a Grep, Glob or Bash grep/rg/find call (D15) and whether any location it names is outside `root`. `{ terms: [], outside: false }`
 * for any tool, input or root it does not understand. A parser, not a shell: nothing is expanded, executed or opened.
 */
export function searchTerms(tool: string, input: unknown, o: { root: string }): { terms: string[]; outside: boolean } {
  const none = { terms: [] as string[], outside: false };
  try {
    if (!isObj(input) || !isObj(o) || typeof o.root !== 'string' || !path.posix.isAbsolute(o.root)) return none;
    const max = noteLimits.commandChars;
    let words: string[] = [];
    let locations: string[] = [];
    if (tool === 'Grep' || tool === 'Glob') {
      const pattern = input['pattern'];
      const where = input['path'];
      if (typeof pattern === 'string') words = [pattern.slice(0, max)];
      if (typeof where === 'string' && where !== '') locations = [where];
    } else if (tool === 'Bash') {
      const command = input['command'];
      if (typeof command !== 'string') return none;
      for (const seg of segmentsOf(command.slice(0, max))) {
        // `cd /tmp && grep ...` searches outside the root: the target of a `cd` counts as a location
        if (seg[0] === 'cd' && seg[1] !== undefined) locations.push(seg[1]);
        const found = searchOf(seg);
        if (found) {
          words.push(...found.words);
          locations.push(...found.locations);
        }
      }
    } else return none;
    return { terms: tokensOf(words), outside: locations.some((l) => isOutside(o.root, l)) };
  } catch {
    return none;
  }
}

/** `<sourceFile>` for a file node, else `<sourceFile>:<symbol>` (label without `()` and a leading `.`, else the local id); `''` without a path. Cleaned. */
function pointerOf(n: GNode): string {
  const file = clean(n.sourceFile);
  if (file === '') return '';
  if (n.type === 'file') return file;
  const symbol = clean(keyOf(clean(n.label))) || clean(localId(n.id));
  return symbol === '' ? file : `${file}:${symbol}`;
}

/** `<local id> <label>`; the label alone when it starts with the id; the id alone for an empty label. `''` when both are empty. */
function taskItem(n: GNode): string {
  const id = clean(localId(n.id));
  const label = clean(n.label);
  if (id === '') return label;
  if (label === '') return id;
  return label.startsWith(id) && !/[A-Za-z0-9]/.test(label.charAt(id.length)) ? label : `${id} ${label}`;
}

type Source = { node: GNode; weight: number };

/** The distinct source nodes of one section (best edge weight kept), ordered by weight desc then id. */
function ranked(found: Map<string, Source>): GNode[] {
  return [...found.values()].sort((a, b) => b.weight - a.weight || byCode(a.node.id, b.node.id)).map((s) => s.node);
}

/**
 * `ctc: <path> · tasks: …; … · decisions: … · callers: …` for the file `rel` (D13, D14), at most `maxChars` code points, at most `max` items per
 * section. `''` when the index has no code node of that file, no section fits, or `maxChars` is below 8. Greedy fill: the first item that does
 * not fit ends its section, an empty section is dropped, an item is never cut except by `itemChars`.
 */
export function fileNote(index: GraphIndex, rel: string, o: { max: number; maxChars: number }): string {
  try {
    if (!index || typeof index.nodes?.values !== 'function' || typeof rel !== 'string' || rel === '' || !isObj(o) || !(o.max >= 1) || !(o.maxChars >= 8)) return '';
    const header = clean(rel);
    if (header === '') return '';
    const tasks = new Map<string, Source>();
    const decisions = new Map<string, Source>();
    const callers = new Map<string, Source>();
    let any = false;
    for (const target of index.nodes.values()) {
      if (target.kind !== 'code' || target.sourceFile !== rel) continue;
      any = true;
      for (const e of index.in(target.id)) {
        const src = index.nodes.get(e.src);
        if (!src) continue;
        let into: Map<string, Source> | null = null;
        if (e.relation === 'implements' && src.type === 'task') into = tasks;
        else if (e.relation === 'decides' && src.type === 'decision') into = decisions;
        else if (e.relation === 'calls' && slotOf(src) === 'file' && typeof src.sourceFile === 'string' && src.sourceFile !== '' && src.sourceFile !== rel) into = callers;
        if (!into) continue;
        const weight = weightOf(e.confidence);
        if ((into.get(src.id)?.weight ?? -1) < weight) into.set(src.id, { node: src, weight });
      }
    }
    if (!any) return '';
    const sections: [string, string[]][] = [
      ['tasks', ranked(tasks).map(taskItem)],
      ['decisions', ranked(decisions).map(taskItem)],
      ['callers', ranked(callers).map(pointerOf)],
    ];
    const max = Math.floor(o.maxChars);
    let text = `ctc: ${header}`;
    let placed = 0;
    for (const [name, all] of sections) {
      const items = all.filter((s) => s !== '').slice(0, Math.floor(o.max)).map(cutItem);
      let cur = `${text} · ${name}: `;
      let n = 0;
      for (const item of items) {
        const next = n === 0 ? `${cur}${item}` : `${cur}; ${item}`;
        if (cps(next) > max) break;
        cur = next;
        n++;
      }
      if (n > 0) {
        text = cur;
        placed++;
      }
    }
    return placed > 0 ? text : '';
  } catch {
    return '';
  }
}

const labelTokens = (label: string): string[] => [...clean(label).toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].map((m) => m[0]);

/**
 * `ctc: graph nodes matching this search: <path:symbol>; …` for the code nodes whose label has a token equal to or starting with one of `terms`
 * (D16), best first, distinct pointers, at most `maxNodes`, at most `maxChars` code points. `''` for no terms, no match, or `maxChars` below 8.
 */
export function hintLine(index: GraphIndex, terms: string[], o: { maxNodes: number; maxChars: number }): string {
  try {
    if (!index || typeof index.nodes?.values !== 'function' || !Array.isArray(terms) || terms.length === 0 || !isObj(o) || !(o.maxNodes >= 1) || !(o.maxChars >= 8)) return '';
    const wanted = terms.filter((t): t is string => typeof t === 'string' && t !== '');
    if (wanted.length === 0) return '';
    const maxNodes = Math.floor(o.maxNodes);
    const pointers: string[] = [];
    for (const seed of lexicalSeeds(index, wanted.join(' '), { types: [...HINT_TYPES], max: 4 * maxNodes })) {
      const node = index.nodes.get(seed.id);
      if (!node || slotOf(node) !== 'file') continue;
      if (!labelTokens(node.label).some((tok) => wanted.some((t) => tok.startsWith(t)))) continue;
      const ptr = cutItem(pointerOf(node));
      if (ptr !== '' && !pointers.includes(ptr)) pointers.push(ptr);
      if (pointers.length >= maxNodes) break;
    }
    const max = Math.floor(o.maxChars);
    const prefix = 'ctc: graph nodes matching this search: ';
    let text = prefix;
    let n = 0;
    for (const p of pointers) {
      const next = n === 0 ? `${text}${p}` : `${text}; ${p}`;
      if (cps(next) > max) break;
      text = next;
      n++;
    }
    return n > 0 ? text : '';
  } catch {
    return '';
  }
}
