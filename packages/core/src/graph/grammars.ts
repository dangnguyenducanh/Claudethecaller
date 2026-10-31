/**
 * Loads the six pinned tree-sitter WASM grammars (D10).
 *
 * Called from: `apps/worker` once per process (T2.2); tests. Why it exists: `extractFile` is synchronous and needs
 * parsers that are already bound to a language. Deliberately NOT done: grammar lookup by file content, any file read
 * other than the pinned `.wasm` files and web-tree-sitter's own runtime, any network access.
 */
import { createRequire } from 'node:module';
import { Language, Parser } from 'web-tree-sitter';

/** Languages that parse through tree-sitter (sql and markdown use line scanners). */
export type GrammarLang = 'ts' | 'tsx' | 'js' | 'python' | 'bash' | 'json';

/** Opaque to callers: one parser per language, each already bound to its grammar. */
export type Grammars = Partial<Record<GrammarLang, Parser>>;

export class GrammarError extends Error {
  readonly code = 'grammar_missing' as const;

  constructor(message: string) {
    super(message);
    this.name = 'GrammarError';
  }
}

const GRAMMAR_FILES: Record<GrammarLang, { pkg: string; file: string }> = {
  ts: { pkg: 'tree-sitter-typescript', file: 'tree-sitter-typescript.wasm' },
  tsx: { pkg: 'tree-sitter-typescript', file: 'tree-sitter-tsx.wasm' },
  js: { pkg: 'tree-sitter-javascript', file: 'tree-sitter-javascript.wasm' },
  python: { pkg: 'tree-sitter-python', file: 'tree-sitter-python.wasm' },
  bash: { pkg: 'tree-sitter-bash', file: 'tree-sitter-bash.wasm' },
  json: { pkg: 'tree-sitter-json', file: 'tree-sitter-json.wasm' },
};

const require = createRequire(import.meta.url);
let loading: Promise<Grammars> | null = null;

async function loadAll(): Promise<Grammars> {
  try {
    await Parser.init({ locateFile: () => require.resolve('web-tree-sitter/tree-sitter.wasm') });
  } catch {
    throw new GrammarError('web-tree-sitter: tree-sitter.wasm failed to initialise');
  }
  const out: Grammars = {};
  for (const [lang, { pkg, file }] of Object.entries(GRAMMAR_FILES) as [GrammarLang, { pkg: string; file: string }][]) {
    let wasm: string;
    try {
      wasm = require.resolve(`${pkg}/${file}`);
    } catch {
      throw new GrammarError(`${pkg}: ${file} not found`);
    }
    try {
      const parser = new Parser();
      parser.setLanguage(await Language.load(wasm));
      out[lang] = parser;
    } catch {
      throw new GrammarError(`${pkg}: ${file} failed to load`);
    }
  }
  return out;
}

/** Loads (once per process) and returns the parsers; rejects with `GrammarError` when a pinned WASM file is missing or invalid. */
export function loadGrammars(): Promise<Grammars> {
  loading ??= loadAll().catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}
