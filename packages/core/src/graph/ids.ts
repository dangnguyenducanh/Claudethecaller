/**
 * Id functions shared by every graph producer (graphify 0.9.93 compatible, D9) plus label cleaning (D1, D17).
 *
 * Called from: the language extractors here, the context parsers (T2.3) and the query tools (T2.4).
 * Deliberately NOT done: the `code:`/`doc:` prefixes (added by `extract.ts`), `ctx:`/`skill:` ids (T2.3).
 */
import { limits } from './types.ts';
import type { Lang } from './types.ts';

const CHEROKEE_UPPER_START = 0x13a0;
const CHEROKEE_UPPER_END = 0x13f5;
const CHEROKEE_LOWER_START = 0xab70;
const CHEROKEE_LOWER_END = 0xabbf;
const CHEROKEE_LOWER2_START = 0x13f8;
const CHEROKEE_LOWER2_END = 0x13fd;

/**
 * Unicode full case folding per code point. `toUpperCase().toLowerCase()` of one code point equals Python's
 * `str.casefold` except for the cases below (checked against Python for every code point).
 */
function casefold(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80) {
      out += ch.toLowerCase();
    } else if (cp >= CHEROKEE_UPPER_START && cp <= CHEROKEE_UPPER_END) {
      out += ch;
    } else if (cp >= CHEROKEE_LOWER_START && cp <= CHEROKEE_LOWER_END) {
      out += String.fromCodePoint(cp - CHEROKEE_LOWER_START + CHEROKEE_UPPER_START);
    } else if (cp >= CHEROKEE_LOWER2_START && cp <= CHEROKEE_LOWER2_END) {
      out += String.fromCodePoint(cp - 8);
    } else if (cp === 0x131) {
      out += ch;
    } else if (cp === 0x1e9e) {
      out += 'ss';
    } else {
      out += ch.toUpperCase().toLowerCase();
    }
  }
  return out;
}

const MAX_NORMALIZE_ROUNDS = 6;

/** graphify's `make_id` normalisation: fold + NFKC to a fixed point, non-word runs to `_`, trim `_`. Never throws. */
export function normalizeId(s: string): string {
  let cur = s;
  for (let i = 0; i < MAX_NORMALIZE_ROUNDS; i++) {
    const next = casefold(cur).normalize('NFKC');
    if (next === cur) break;
    cur = next;
  }
  return cur
    .replace(/[^\p{L}\p{N}_]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function stripEdges(part: string): string {
  let start = 0;
  let end = part.length;
  while (start < end && (part[start] === '_' || part[start] === '.')) start++;
  while (end > start && (part[end - 1] === '_' || part[end - 1] === '.')) end--;
  return part.slice(start, end);
}

/** Joins parts (empty ones dropped, `_`/`.` stripped from the edges of each) and normalises. */
export function makeId(...parts: string[]): string {
  return normalizeId(
    parts
      .filter((p) => p !== '')
      .map(stripEdges)
      .join('_'),
  );
}

/** Index of the last extension dot of the base name, or -1 (`.claude` and `Makefile` have none). */
function extensionDot(relPath: string): number {
  const base = relPath.lastIndexOf('/') + 1;
  const dot = relPath.lastIndexOf('.');
  return dot > base ? dot : -1;
}

/** The path with its last extension removed (`a/b.test.ts` -> `a/b.test`). */
export function fileStem(relPath: string): string {
  const dot = extensionDot(relPath);
  return dot < 0 ? relPath : relPath.slice(0, dot);
}

const EXT_LANG: Record<string, Lang> = {
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  tsx: 'tsx',
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'js',
  py: 'python',
  pyi: 'python',
  sh: 'bash',
  bash: 'bash',
  sql: 'sql',
  json: 'json',
  md: 'markdown',
  mdx: 'markdown',
};

/** Language by last extension, case-insensitive; `null` when unknown. */
export function langOf(relPath: string): Lang | null {
  const dot = extensionDot(relPath);
  if (dot < 0) return null;
  const ext = relPath.slice(dot + 1).toLowerCase();
  return Object.hasOwn(EXT_LANG, ext) ? (EXT_LANG[ext] ?? null) : null;
}

/** Control characters (C0, DEL, C1, U+2028/2029) become a space, then the label is cut to `limits.maxLabelChars` code points. */
export function cleanLabel(s: string): string {
  const spaced = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
  if (spaced.length <= limits.maxLabelChars) return spaced;
  const chars = Array.from(spaced);
  return chars.length <= limits.maxLabelChars ? spaced : chars.slice(0, limits.maxLabelChars).join('');
}
