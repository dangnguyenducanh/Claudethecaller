/**
 * Pure rules of the capability library: frontmatter, limits, hashing, the version builder, manifest compare, served-version choice,
 * the SKILLRET text and cosine. Called from: apps/worker/src/library (scanner and `library` handlers), later T3.2 routes and T3.3/T5.1
 * (`resolveServed` for project overrides). Why: one place decides what a valid capability is, with no I/O so it is testable
 * without disk or Postgres. Deliberately NOT done: reading files, SQL, queues, embedding calls (the worker injects those).
 * Untrusted input: every byte of every file and the YAML in it; nothing here edits its arguments (inputs may be deep-frozen).
 */
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';

export type Kind = 'skill' | 'agent' | 'command' | 'workflow';
export type SkipCode =
  | 'unreadable' | 'too_many_files' | 'too_large' | 'bad_yaml' | 'bad_name' | 'description_too_long' | 'duplicate_name'
  | 'binary_file' | 'symlink_outside';
export type Skip = { path: string; code: SkipCode; message: string };
export type FileInput = { path: string; bytes: Uint8Array };
export type BuildInput = { kind: Kind; namespace: string; defaultName: string; rootPath: string; mainPath: string; files: FileInput[] };
/** Same shape as `CreateVersionInput` of packages/shared/src/repositories/library.ts (not importable: the package exports no such path). */
export type VersionInput = {
  namespace: string; kind: string; name: string; rootPath: string; description: string; frontmatter?: unknown; bodyHash: string; commitMessage?: string;
  blobs: { hash: string; content: string; size: number }[]; files: { path: string; blobHash: string }[];
};
export type BuildResult = { ok: true; input: VersionInput; warnings: Skip[] } | { ok: false; skip: Skip };
export type Limits = { maxFiles: number; maxBytes: number; maxNameLen: number; maxDescription: number; bodyChars: number };

/** Read at call time, so a test may assign to it. Values: FROM-SPEC spec:404 and spec:416. */
export const libraryLimits: Limits = { maxFiles: 200, maxBytes: 1048576, maxNameLen: 64, maxDescription: 1024, bodyChars: 8000 };

export const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const LABEL_RE = /^[a-z0-9_\-.]{1,36}$/;
export const isName = (s: unknown): s is string => typeof s === 'string' && NAME_RE.test(s);
export const isLabel = (s: unknown): s is string => typeof s === 'string' && LABEL_RE.test(s);

export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

type Mapping = Record<string, unknown>;
export type FrontmatterResult = { ok: true; frontmatter: Mapping; body: string } | { ok: false; code: 'bad_yaml'; message: string };

const isMapping = (v: unknown): v is Mapping => typeof v === 'object' && v !== null && !Array.isArray(v);
const BOM = '﻿';

/** Parses one YAML document with no alias expansion and no duplicate keys. The message never contains file content. */
function parseMapping(text: string, lineOffset: number): { ok: true; value: Mapping } | { ok: false; code: 'bad_yaml'; message: string } {
  try {
    const value: unknown = parseYaml(text, { maxAliasCount: 0, uniqueKeys: true, logLevel: 'error' });
    if (value === null || value === undefined) return { ok: true, value: {} };
    if (!isMapping(value)) return { ok: false, code: 'bad_yaml', message: 'YAML is not a mapping' };
    return { ok: true, value };
  } catch (e) {
    const err = e as { code?: unknown; linePos?: { line?: number }[]; name?: unknown };
    const line = err.linePos?.[0]?.line;
    const code = typeof err.code === 'string' ? err.code : typeof err.name === 'string' ? err.name : 'ERROR';
    return { ok: false, code: 'bad_yaml', message: `invalid YAML (${code})${typeof line === 'number' ? ` at line ${line + lineOffset}` : ''}` };
  }
}

/**
 * Splits `---` frontmatter from the body (D12). No header: `{}` and the whole text. Header never closed, YAML error, alias,
 * duplicate key or a non-mapping header: `bad_yaml`. Never throws.
 */
export function parseFrontmatter(input: string): FrontmatterResult {
  const text = input.startsWith(BOM) ? input.slice(1) : input;
  const marker = (line: string): boolean => line.replace(/[ \t\r]+$/, '') === '---';
  const firstEnd = text.indexOf('\n');
  if (!marker(firstEnd === -1 ? text : text.slice(0, firstEnd))) return { ok: true, frontmatter: {}, body: text };
  if (firstEnd === -1) return { ok: false, code: 'bad_yaml', message: 'frontmatter is not closed' };
  let start = firstEnd + 1;
  while (start <= text.length) {
    const end = text.indexOf('\n', start);
    const line = end === -1 ? text.slice(start) : text.slice(start, end);
    if (marker(line)) {
      const parsed = parseMapping(text.slice(firstEnd + 1, start), 1);
      return parsed.ok ? { ok: true, frontmatter: parsed.value, body: end === -1 ? '' : text.slice(end + 1) } : parsed;
    }
    if (end === -1) break;
    start = end + 1;
  }
  return { ok: false, code: 'bad_yaml', message: 'frontmatter is not closed' };
}

const isWholeFileYaml = (mainPath: string): boolean => /\.(ya?ml|json)$/i.test(mainPath);

/** Decodes UTF-8 keeping a BOM; `null` for invalid UTF-8 or a NUL character. */
function decode(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return text.includes('\u0000') ? null : text;
  } catch {
    return null;
  }
}

type Parsed = { ok: true; frontmatter: Mapping; body: string } | { ok: false; code: 'bad_yaml'; message: string };
function parseMain(kind: Kind, mainPath: string, text: string): Parsed {
  if (kind === 'workflow' && isWholeFileYaml(mainPath)) {
    const parsed = parseMapping(text.startsWith(BOM) ? text.slice(1) : text, 0);
    return parsed.ok ? { ok: true, frontmatter: parsed.value, body: text } : parsed;
  }
  return parseFrontmatter(text);
}

const trimmedString = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The `name` the file declares (trimmed, non-empty string), or `null` when it is missing, not a string or the file does not parse. */
export function peekName(kind: Kind, mainPath: string, bytes: Uint8Array): string | null {
  const text = decode(bytes);
  if (text === null) return null;
  const parsed = parseMain(kind, mainPath, text);
  return parsed.ok ? trimmedString(parsed.frontmatter['name']) || null : null;
}

/**
 * Turns the files of one capability into the input of `repos.library.createVersion` (D13), or the first failing check of D4:
 * `unreadable` (main file missing or not text) → `too_many_files` → `too_large` → `bad_yaml` → `bad_name` → `description_too_long`.
 * Binary files (invalid UTF-8 or NUL) are left out with a `binary_file` warning. `limits` defaults to `libraryLimits`.
 */
export function buildVersion(input: BuildInput, limits: Limits = libraryLimits): BuildResult {
  const skip = (code: SkipCode, message: string): BuildResult => ({ ok: false, skip: { path: `${input.rootPath}/${input.mainPath}`, code, message } });
  const main = input.files.find((f) => f.path === input.mainPath);
  const mainText = main ? decode(main.bytes) : null;
  if (!main || mainText === null) return skip('unreadable', 'main file is missing or is not UTF-8 text');
  if (input.files.length > limits.maxFiles) return skip('too_many_files', `more than ${limits.maxFiles} files`);
  if (input.files.reduce((n, f) => n + f.bytes.length, 0) > limits.maxBytes) return skip('too_large', `more than ${limits.maxBytes} bytes`);

  const parsed = parseMain(input.kind, input.mainPath, mainText);
  if (!parsed.ok) return skip(parsed.code, parsed.message);
  const name = trimmedString(parsed.frontmatter['name']) || input.defaultName;
  if (name.length > limits.maxNameLen || !NAME_RE.test(name)) return skip('bad_name', `name must match ${NAME_RE.source} and be at most ${limits.maxNameLen} characters`);
  const description = trimmedString(parsed.frontmatter['description']);
  if (description.length > limits.maxDescription) return skip('description_too_long', `description is longer than ${limits.maxDescription} characters`);

  const blobs = new Map<string, { hash: string; content: string; size: number }>();
  const files: { path: string; blobHash: string }[] = [];
  const warnings: Skip[] = [];
  for (const f of [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const content = f === main ? mainText : decode(f.bytes);
    if (content === null) {
      warnings.push({ path: `${input.rootPath}/${f.path}`, code: 'binary_file', message: 'not UTF-8 text; left out' });
      continue;
    }
    const hash = sha256Hex(f.bytes);
    blobs.set(hash, { hash, content, size: f.bytes.length });
    files.push({ path: f.path, blobHash: hash });
  }
  return {
    ok: true,
    warnings,
    input: {
      namespace: input.namespace, kind: input.kind, name, rootPath: input.rootPath, description, frontmatter: parsed.frontmatter,
      bodyHash: sha256Hex(parsed.body), blobs: [...blobs.values()], files,
    },
  };
}

/** The file that defines a capability: `SKILL.md` when present, else the only file, else `null`. */
export function mainPathOf(paths: readonly string[]): string | null {
  if (paths.includes('SKILL.md')) return 'SKILL.md';
  return paths.length === 1 ? (paths[0] ?? null) : null;
}

/** Body of the main file: whole text for a YAML/JSON workflow, else the text after its frontmatter (whole text when the header does not parse). */
export function bodyOf(kind: string, mainPath: string, content: string): string {
  if (kind === 'workflow' && isWholeFileYaml(mainPath)) return content;
  const parsed = parseFrontmatter(content);
  return parsed.ok ? parsed.body : content;
}

type ManifestFile = { path: string; blobHash: string };
const entryKey = (f: ManifestFile): string => `${f.path}\0${f.blobHash}`;

/** True when both manifests hold the same `(path, blobHash)` pairs, in any order. */
export function sameManifest(a: readonly ManifestFile[], b: readonly ManifestFile[]): boolean {
  const left = new Set(a.map(entryKey));
  const right = new Set(b.map(entryKey));
  return left.size === right.size && a.length === b.length && [...left].every((k) => right.has(k));
}

/** Paths added, removed and changed (same path, other blob) from `old` to `next`, each sorted by code unit. */
export function diffManifests(old: readonly ManifestFile[], next: readonly ManifestFile[]): { added: string[]; removed: string[]; changed: string[] } {
  const before = new Map(old.map((f) => [f.path, f.blobHash]));
  const after = new Map(next.map((f) => [f.path, f.blobHash]));
  return {
    added: [...after.keys()].filter((p) => !before.has(p)).sort(),
    removed: [...before.keys()].filter((p) => !after.has(p)).sort(),
    changed: [...after].filter(([p, h]) => before.has(p) && before.get(p) !== h).map(([p]) => p).sort(),
  };
}

export type Override = { action: 'pin' | 'block'; label?: string | null; version?: number | null };

/**
 * Version to serve (D16), first match wins: override block → `null`; pinned version; pinned label; `defaultLabel` (default `production`);
 * `latest`; the highest version; none → `null`. A pin that points at nothing falls through.
 */
export function resolveServed(
  versions: readonly { version: number; labels: readonly string[] }[],
  opts: { override?: Override | null; defaultLabel?: string } = {},
): number | null {
  const { override, defaultLabel = 'production' } = opts;
  if (override?.action === 'block') return null;
  if (override?.action === 'pin') {
    if (typeof override.version === 'number' && versions.some((v) => v.version === override.version)) return override.version;
    const label = override.label;
    if (typeof label === 'string') {
      const hit = versions.filter((v) => v.labels.includes(label)).map((v) => v.version);
      if (hit.length > 0) return Math.max(...hit);
    }
  }
  for (const label of [defaultLabel, 'latest']) {
    const hit = versions.filter((v) => v.labels.includes(label)).map((v) => v.version);
    if (hit.length > 0) return Math.max(...hit);
  }
  return versions.length > 0 ? Math.max(...versions.map((v) => v.version)) : null;
}

/** The text that is embedded for a capability: `name | description | body` with the body cut to `bodyChars` (spec:416). */
export function skillretText(cap: { name: string; description: string; body: string }, bodyChars: number = libraryLimits.bodyChars): string {
  return `${cap.name} | ${cap.description} | ${cap.body.slice(0, bodyChars)}`;
}

/** Cosine similarity; 0 when a vector is empty, all zeros or the lengths differ (judgment: such a pair is never a duplicate). */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}
