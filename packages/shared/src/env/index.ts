/**
 * Config loader: `config/{models,retrieval,server}.yaml` plus optional `ctc.yaml`, merged, overridden by env, validated.
 *
 * Called from: apps/web, apps/worker, apps/cli at start via `loadConfigOrExit()` (spec.md:84, 208, 217-219).
 * Why: an operator typo or wrong type must stop the start with the YAML path of the bad key. The Python service keeps
 * reading the same files, so Python-era top-level keys stay valid and are returned under `config.legacy`.
 * Deliberately NOT done: reading `.env` or the current directory, network, caching between calls, camelCase mapping,
 * coercing quoted YAML numbers (only env strings are converted), writing any file or `process.env`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { ConfigSchema, LEGACY_KEYS, type Config } from './schema.ts';

export { ConfigSchema, type Config };

export type ConfigIssue = { file: string; path: string; message: string };

export type LoadOptions = {
  dir?: string;
  env?: Record<string, string | undefined>;
  home?: string;
};

/** Thrown by `loadConfig` for every problem found; `message` is one line per issue, sorted by file then path. */
export class ConfigError extends Error {
  issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    super(issues.map(formatIssue).join('\n'));
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** Exit code 78 = EX_CONFIG, so a systemd unit can use `RestartPreventExitStatus=78`. */
const EXIT_CONFIG = 78;

const REQUIRED_FILES = ['models', 'retrieval', 'server'] as const;
const OPTIONAL_FILES = ['ctc'] as const;

const ENV_TO_KEY = {
  CTC_DATABASE_URL: 'database_url',
  CTC_REDIS_URL: 'redis_url',
  CTC_TEI_EMBED_URL: 'embed_url',
  CTC_TEI_RERANK_URL: 'rerank_url',
  CTC_LLM: 'llm',
  CTC_MODE: 'mode',
  CTC_PORT: 'port',
  CTC_SOCKET: 'socket',
  CTC_CLAUDE_HOME: 'claude_home',
} as const;

type EnvKey = (typeof ENV_TO_KEY)[keyof typeof ENV_TO_KEY];
type Raw = Record<string, unknown>;

const isMapping = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function formatIssue(issue: ConfigIssue): string {
  return issue.file === 'env' ? `env ${issue.path}: ${issue.message}` : `${issue.file}: ${issue.path}: ${issue.message}`;
}

function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>(
    (out, part) => (typeof part === 'number' ? `${out}[${part}]` : out === '' ? String(part) : `${out}.${String(part)}`),
    '',
  );
}

/** Paths of every own `__proto__` key below `value` (zod's loose objects and records drop it silently). */
function protoPaths(value: unknown, path: readonly string[], out: string[][]): void {
  const children = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : isMapping(value) ? Object.entries(value) : [];
  for (const [key, child] of children) {
    if (key === '__proto__') out.push([...path, key]);
    protoPaths(child, [...path, key], out);
  }
}

/** Nearest parent of this module that holds `pnpm-workspace.yaml`, plus `/config`. */
function defaultConfigDir(): string | undefined {
  for (let dir = import.meta.dirname; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return join(dir, 'config');
    if (dirname(dir) === dir) return undefined;
  }
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  return path.startsWith('~/') ? join(home, path.slice(2)) : path;
}

const MAX_YAML_CHARS = 262144;
const QUOTED_OR_COMMENT = /"(?:[^"\\\n]|\\.)*"|'[^'\n]*'|(?<=^|\s)#.*/gm;

/** Reads and parses one YAML file. Returns the mapping, or pushes one issue and returns undefined. */
function readYaml(dir: string, name: string, required: boolean, issues: ConfigIssue[]): Raw | undefined {
  const file = `config/${name}.yaml`;
  const fail = (message: string): undefined => {
    issues.push({ file, path: '(file)', message });
    return undefined;
  };
  let text: string;
  try {
    text = readFileSync(join(dir, `${name}.yaml`), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return required ? fail('not found') : undefined;
    return fail(`cannot read: ${code ?? 'unknown error'}`);
  }
  // judgment: the parser's own memory use is unbounded on pathological input (5 MB of `[` aborts V8), so a config file is capped well above any real one.
  if (text.length > MAX_YAML_CHARS) return fail(`yaml: file is larger than ${MAX_YAML_CHARS} characters`);
  // judgment: a tab right after `:` or `-`, or as indentation, is refused (editors mix tabs and spaces; the Python reader sees a different file); quoted scalars and comments are not checked.
  if (/^[ ]*\t|[:-]\t/m.test(text.replace(QUOTED_OR_COMMENT, ''))) return fail('yaml: tab characters are not allowed as indentation or after ":" / "-"');
  const doc = parseDocument(text, { schema: 'core', version: '1.2', logLevel: 'error' });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) return fail(`yaml: ${(problem.message.split('\n')[0] ?? '').replace(/:$/, '')}`);
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: 0 });
  } catch (error) {
    return fail(`yaml: ${(String((error as Error).message).split('\n')[0] ?? '').replace(/:$/, '')}`);
  }
  if (value === null || value === undefined) return {};
  return isMapping(value) ? value : fail('top level must be a mapping');
}

/**
 * Loads, merges, validates and returns the config.
 *
 * Trust: files and env are operator-written; YAML is still parsed without aliases or custom tags.
 * Returns a fresh object every call (no cache); never modifies `opts.env`, `process.env` or any file.
 * Bad input: collects every issue, then throws one `ConfigError`. A `database_url` / `redis_url` value is never echoed.
 */
export function loadConfig(opts: LoadOptions = {}): Config {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const issues: ConfigIssue[] = [];

  const dir = opts.dir ?? (env['CTC_CONFIG_DIR'] || defaultConfigDir());
  if (dir === undefined) throw new ConfigError([{ file: 'config', path: '(dir)', message: 'not found' }]);

  const merged: Raw = Object.create(null) as Raw;
  const origin = new Map<string, string>();
  const names = [...REQUIRED_FILES.map((n) => [n, true] as const), ...OPTIONAL_FILES.map((n) => [n, false] as const)];
  for (const [name, required] of names) {
    const file = `config/${name}.yaml`;
    const data = readYaml(resolve(dir), name, required, issues);
    for (const [key, value] of Object.entries(data ?? {})) {
      if (key === 'legacy') issues.push({ file, path: key, message: 'Unrecognized key' });
      else if (origin.has(key)) issues.push({ file, path: key, message: `Duplicate key (also in ${origin.get(key)})` });
      else {
        origin.set(key, file);
        merged[key] = value;
      }
    }
  }

  const legacy: Raw = {};
  for (const key of LEGACY_KEYS) {
    if (Object.hasOwn(merged, key)) {
      legacy[key] = merged[key];
      delete merged[key];
    }
  }

  const seen = new Set<string>();
  const add = (file: string, path: string): void => {
    if (!seen.has(`${file}\0${path}`)) issues.push({ file, path, message: 'Unrecognized key' });
    seen.add(`${file}\0${path}`);
  };
  for (const [key, value] of Object.entries(merged)) {
    const found: string[][] = [];
    protoPaths(value, [key], found);
    for (const path of found) add(origin.get(key) ?? 'config', formatPath(path));
  }

  const input: Raw = { ...merged, legacy };
  for (const [variable, key] of Object.entries(ENV_TO_KEY) as [string, EnvKey][]) {
    const raw = env[variable];
    if (!raw) continue;
    const candidate = key === 'port' && /^-?\d+$/.test(raw) ? Number(raw) : raw;
    const check = ConfigSchema.shape[key].safeParse(candidate);
    if (check.success) input[key] = candidate;
    else issues.push({ file: 'env', path: variable, message: check.error.issues[0]?.message ?? 'invalid' });
  }

  const result = ConfigSchema.safeParse(input);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const paths =
        issue.code === 'unrecognized_keys'
          ? issue.keys.map((key) => [...issue.path, key])
          : [issue.path];
      for (const path of paths) {
        const file = origin.get(String(path[0])) ?? 'config';
        if (issue.code === 'unrecognized_keys') add(file, formatPath(path));
        else issues.push({ file, path: formatPath(path), message: issue.message });
      }
    }
  }

  if (issues.length > 0) {
    issues.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    throw new ConfigError(issues);
  }

  const config = result.data as Config;
  config.socket = expandHome(config.socket, home);
  config.claude_home = expandHome(config.claude_home, home);
  config.trash_dir = expandHome(config.trash_dir, home);
  config.library.roots = config.library.roots.map((root) => expandHome(root, home));
  config.spool.dir = expandHome(config.spool.dir, home);
  return config;
}

/** Same as `loadConfig`, but on a `ConfigError` prints one line per issue to stderr and exits with code 78. */
export function loadConfigOrExit(opts: LoadOptions = {}): Config {
  try {
    return loadConfig(opts);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return process.exit(EXIT_CONFIG);
  }
}
