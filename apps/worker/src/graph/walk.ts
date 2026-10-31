/**
 * Project walk: lists the files a graph rebuild may read, with the reason for every file it leaves out.
 *
 * Called from: rebuild.ts (full rebuilds and `payload.files` entries). Why it exists: spec:282 (skip secret files, files over 1 MB,
 * honour ignore files) and D9/D1 (symlinks never lead outside the root). Deliberately NOT done: reading file contents (rebuild.ts does,
 * once, for hashing), `.git/info/exclude`, the global git excludes file, any git subprocess, writing anything under the root.
 * Untrusted: every name, size and symlink under the root, every entry of `payload.files`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { graphLimits, PACKAGES_SOURCE } from './limits.ts';

export type Skip = { file: string; reason: string };
type Chain = { dirRel: string; ig: Ignore }[];

const NEVER_ENTER = new Set(['.git', 'node_modules', '.ctc']);
const SECRET = [/^\.env/, /\.pem$/, /^id_/, /^credentials/];
const IGNORE_FILES = ['.gitignore', '.ctcignore'];
const MAX_IGNORE_BYTES = 1_048_576;

const secretName = (base: string): boolean => SECRET.some((re) => re.test(base.toLowerCase()));
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A relative POSIX path with no `.`/`..`/empty segment, NUL, backslash or leading `/` (D1c). */
export function safeRel(p: unknown): p is string {
  return typeof p === 'string' && p !== '' && !p.includes('\0') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The ignore rules of one directory (`.gitignore` then `.ctcignore`, regular files only), or `null`. */
async function ignoreFor(abs: string): Promise<Ignore | null> {
  let ig: Ignore | null = null;
  for (const name of IGNORE_FILES) {
    try {
      const f = path.join(abs, name);
      const st = await fs.lstat(f);
      if (!st.isFile() || st.size > MAX_IGNORE_BYTES) continue;
      (ig ??= ignore()).add(await fs.readFile(f, 'utf8'));
    } catch {
      // judgment: an unreadable ignore file is treated as absent (reading more is safer than failing the walk)
    }
  }
  return ig;
}

/** Deeper ignore files win over shallower ones; a negation re-includes unless a parent directory is ignored (never entered). */
function ignored(chain: Chain, rel: string, isDir: boolean): boolean {
  let result = false;
  for (const { dirRel, ig } of chain) {
    const sub = dirRel === '' ? rel : rel.slice(dirRel.length + 1);
    try {
      const t = ig.test(isDir ? `${sub}/` : sub);
      if (t.ignored) result = true;
      else if (t.unignored) result = false;
    } catch {
      // judgment: a path `ignore` rejects is not ignored
    }
  }
  return result;
}

/** `missing` for ENOENT, `not_file` for ENOTDIR/ELOOP, otherwise `unreadable` (judgment, D8: the file may exist, so its rows are kept). */
function statSkip(e: unknown): string {
  const code = (e as { code?: string }).code;
  if (code === 'ENOENT') return 'missing';
  return code === 'ENOTDIR' || code === 'ELOOP' ? 'not_file' : 'unreadable';
}

/** Why a regular-looking entry of the root is not a graph file, or `null` when it is included (D9 order: secret, reserved, links, type, size). */
async function fileSkip(abs: string, rel: string, rootReal: string): Promise<string | null> {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  if (secretName(base)) return 'secret';
  if (rel === PACKAGES_SOURCE) return 'reserved';
  let st;
  try {
    st = await fs.lstat(abs);
    if (st.isSymbolicLink()) {
      const real = await fs.realpath(abs);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return 'symlink_outside';
      st = await fs.stat(abs);
    }
  } catch (e) {
    return statSkip(e);
  }
  if (!st.isFile()) return 'not_file';
  return st.size > graphLimits.maxFileBytes ? 'too_large' : null;
}

/** Every included regular file under `root` (any extension), sorted by UTF-16 code unit order, and why the others were left out. */
export async function walkProject(root: string, o: { signal?: AbortSignal } = {}): Promise<{ files: string[]; skipped: Skip[]; truncated: boolean }> {
  const rootReal = await fs.realpath(root);
  const files: string[] = [];
  const skipped: Skip[] = [];
  let truncated = false;
  let unreadable = false;

  const visit = async (abs: string, rel: string, chain: Chain): Promise<void> => {
    o.signal?.throwIfAborted();
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      // judgment (D8): an unreadable directory hides its files, so the walk is reported truncated and a full rebuild deletes nothing
      unreadable = true;
      return;
    }
    const own = await ignoreFor(abs);
    const here: Chain = own ? [...chain, { dirRel: rel, ig: own }] : chain;
    entries.sort((a, b) => byCode(a.name, b.name));
    for (const e of entries) {
      if (truncated) return;
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      const childAbs = path.join(abs, e.name);
      if (e.name === '.git') continue;
      if (e.isDirectory()) {
        if (NEVER_ENTER.has(e.name) || ignored(here, childRel, true)) continue;
        await visit(childAbs, childRel, here);
        continue;
      }
      if (e.isSymbolicLink()) {
        let st;
        try {
          st = await fs.stat(childAbs);
        } catch {
          st = null;
        }
        if (st?.isDirectory()) continue;
      }
      if (ignored(here, childRel, false)) {
        skipped.push({ file: childRel, reason: 'ignored' });
        continue;
      }
      const reason = await fileSkip(childAbs, childRel, rootReal);
      if (reason) {
        skipped.push({ file: childRel, reason });
        continue;
      }
      if (files.length >= graphLimits.maxFiles) {
        truncated = true;
        return;
      }
      files.push(childRel);
    }
  };
  await visit(rootReal, '', []);
  files.sort(byCode);
  skipped.sort((a, b) => byCode(a.file, b.file));
  return { files, skipped, truncated: truncated || unreadable };
}

/**
 * Applies the walk's rules to explicit `payload.files` entries: an entry is included iff a full walk would include it.
 * Bad paths, ignored or never-entered ancestors, symlinked ancestors, secrets, oversize and non-files are skipped with a reason.
 */
export async function checkPaths(root: string, rels: string[], o: { signal?: AbortSignal } = {}): Promise<{ files: string[]; skipped: Skip[] }> {
  const rootReal = await fs.realpath(root);
  const files: string[] = [];
  const skipped: Skip[] = [];
  const cache = new Map<string, Ignore | null>();
  const ignoreAt = async (dirRel: string): Promise<Ignore | null> => {
    if (!cache.has(dirRel)) cache.set(dirRel, await ignoreFor(path.join(rootReal, dirRel)));
    return cache.get(dirRel) ?? null;
  };
  for (const rel of rels) {
    o.signal?.throwIfAborted();
    if (!safeRel(rel)) {
      skipped.push({ file: rel, reason: 'bad_path' });
      continue;
    }
    const segs = rel.split('/');
    const chain: Chain = [];
    let reason: string | null = null;
    let dirRel = '';
    for (let i = 0; i <= segs.length - 1 && reason === null; i++) {
      const own = await ignoreAt(dirRel);
      if (own) chain.push({ dirRel, ig: own });
      const here = dirRel === '' ? (segs[i] as string) : `${dirRel}/${segs[i]}`;
      if (i === segs.length - 1) break;
      if (NEVER_ENTER.has(segs[i] as string) || ignored(chain, here, true)) reason = 'ignored';
      else {
        try {
          if ((await fs.lstat(path.join(rootReal, here))).isSymbolicLink()) reason = 'symlink_outside';
        } catch (e) {
          reason = statSkip(e);
        }
      }
      dirRel = here;
    }
    if (reason === null && segs[segs.length - 1] === '.git') reason = 'ignored';
    if (reason === null && ignored(chain, rel, false)) reason = 'ignored';
    reason ??= await fileSkip(path.join(rootReal, rel), rel, rootReal);
    if (reason) skipped.push({ file: rel, reason });
    else files.push(rel);
  }
  return { files, skipped };
}
