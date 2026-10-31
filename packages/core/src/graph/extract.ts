/**
 * `extractFile`: one source file in, graphify-compatible graph nodes, `contains` edges and raw references out.
 *
 * Called from: `apps/worker` graph jobs (T2.2), once per file after `loadGrammars()`. Why it exists: the pure,
 * synchronous half of graph building (D0). Deliberately NOT done: reading files, resolving references, hashing,
 * caching, writing to a store. Never throws: every problem becomes `error` on the result with empty arrays (D3, D4).
 */
import type { Parser } from 'web-tree-sitter';
import { extractBash } from './bash.ts';
import { createOut } from './build.ts';
import { extractJson } from './json.ts';
import { extractMarkdown } from './markdown.ts';
import { extractPython } from './python.ts';
import { extractSql } from './sql.ts';
import { extractTsJs } from './tsjs.ts';
import type { GrammarLang, Grammars } from './grammars.ts';
import { fileStem, langOf, makeId } from './ids.ts';
import { limits } from './types.ts';
import type { ExtractErrorCode, ExtractInput, ExtractResult, Lang } from './types.ts';

const MAX_MESSAGE_CHARS = 200;

function failure(file: string, lang: Lang | null, code: ExtractErrorCode, message: string): ExtractResult {
  const oneLine = message.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').slice(0, MAX_MESSAGE_CHARS);
  return { file, lang, nodes: [], edges: [], imports: [], refs: [], mentions: [], error: { code, message: oneLine } };
}

function badPath(path: unknown): boolean {
  if (typeof path !== 'string' || path === '') return true;
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)) return true;
  if (path.includes('\0') || path.includes('\\') || path.endsWith('/')) return true;
  return path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

function countLines(text: string): number {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
  return text.endsWith('\n') && text.length > 0 ? n - 1 : n;
}

function parserFor(grammars: Grammars, lang: GrammarLang): Parser | null {
  const parser: unknown = (grammars as Record<string, unknown> | null | undefined)?.[lang];
  return parser && typeof (parser as Parser).parse === 'function' ? (parser as Parser) : null;
}

const GRAMMAR_OF: Partial<Record<Lang, GrammarLang>> = { ts: 'ts', tsx: 'tsx', js: 'js', python: 'python', bash: 'bash', json: 'json' };

function run(input: ExtractInput, grammars: Grammars): ExtractResult {
  const path: unknown = input.path;
  const file = String(path);
  if (badPath(path)) return failure(file, null, 'bad_path', 'path must be a relative path of non-empty segments using "/"');
  const relPath = path as string;
  const lang = langOf(relPath);
  if (!lang) return failure(file, null, 'unsupported', 'no extractor for this file extension');
  let stem = fileStem(relPath);
  // judgment: a stem that normalises to nothing (`_.ts`, `🙂.md`) falls back to the path with its extension (D5)
  if (makeId(stem) === '') stem = relPath;
  if (makeId(stem) === '') return failure(file, null, 'bad_path', 'path has no usable name');
  const content: unknown = input.content;
  if (typeof content !== 'string') return failure(file, lang, 'internal', 'content must be a string');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > limits.maxFileBytes) return failure(file, lang, 'too_large', `file is ${bytes} bytes, the limit is ${limits.maxFileBytes}`);
  const grammarLang = GRAMMAR_OF[lang];
  const parser = grammarLang ? parserFor(grammars, grammarLang) : null;
  if (grammarLang && !parser) return failure(file, lang, 'grammar_missing', `grammar for ${lang} is not loaded`);

  let text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  if (text.includes('\r\n')) text = text.replaceAll('\r\n', '\n');
  const out = createOut(relPath, stem, lang === 'markdown' ? 'doc' : 'code', text, countLines(text));

  if (lang === 'markdown') extractMarkdown(text, out);
  else if (lang === 'sql') extractSql(text, out);
  else if (parser) {
    const started = performance.now();
    let tree;
    try {
      tree = parser.parse(text, null, { progressCallback: () => performance.now() - started > limits.parseTimeoutMs });
    } finally {
      parser.reset();
    }
    if (!tree) return failure(file, lang, 'parse_timeout', `parsing took longer than ${limits.parseTimeoutMs} ms`);
    try {
      if (lang === 'python') extractPython(tree, out);
      else if (lang === 'bash') extractBash(tree, out, relPath);
      else if (lang === 'json') extractJson(tree, out, relPath);
      else extractTsJs(tree, out);
    } finally {
      tree.delete();
    }
  }
  return { file, lang, ...out.finish(), error: null };
}

/** Never throws; see the file header. `grammars` comes from `loadGrammars()` and is not modified. */
export function extractFile(input: ExtractInput, grammars: Grammars): ExtractResult {
  let file = '';
  let lang: Lang | null = null;
  try {
    file = String((input as { path?: unknown } | null)?.path);
    lang = typeof input.path === 'string' ? langOf(input.path) : null;
    return run(input, grammars);
  } catch (e) {
    const name = e instanceof Error ? e.constructor.name : typeof e;
    return failure(file, lang, 'internal', `internal: ${name}`);
  }
}
