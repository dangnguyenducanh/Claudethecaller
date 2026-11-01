/**
 * File-system walk of one library root: finds capabilities (D11) and reads their files under the limits (D1, D2, D6d).
 * Called from: scanLibrary (scan.ts). Why: the pure builder in @ctc/core/library gets bytes, this module is the only reader of the roots.
 * Deliberately NOT done: writing, renaming or deleting anything under a root (D6a), following symlinked directories, versioning.
 * Untrusted: every name, size, symlink and byte under the root.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { libraryLimits, type FileInput, type Kind, type Limits, type Skip } from '@ctc/core/library';

/** One capability found on disk, files already read. `skip` set means no file was usable (nothing is versioned). */
export type Found = {
  kind: Kind;
  defaultName: string;
  rootPath: string;
  mainPath: string;
  files: FileInput[];
  warnings: Skip[];
  skip: Skip | null;
};

/** judgment: directories visited per skill, so a tree of empty directories cannot keep the walk busy for ever. */
const MAX_DIRS_PER_CAPABILITY = 1000;
const IGNORED_DIRS = new Set(['node_modules', '__pycache__']);
const ignored = (name: string): boolean => name.startsWith('.') || IGNORED_DIRS.has(name);
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** False only when the path is absent (ENOENT/ENOTDIR); any other error is rethrown so it cannot read as "not here" (D8). */
const absentOr = (e: unknown): false => {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return false;
  throw e;
};

const isDir = async (p: string): Promise<boolean> => {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch (e) {
    return absentOr(e);
  }
};

const unreadable = (file: string, message: string): Skip => ({ path: file, code: 'unreadable', message });

/** Entries of `dir` sorted by name; `[]` only when it does not exist (ENOENT). Any other error is rethrown: it must not read as "nothing here" (D8). */
async function listDir(dir: string): Promise<{ name: string; isDirectory: boolean; isFile: boolean; isSymlink: boolean }[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile(), isSymlink: e.isSymbolicLink() }))
      .sort((a, b) => byName(a.name, b.name));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

const errCode = (e: unknown): string => (e as NodeJS.ErrnoException).code ?? 'error';

type Collected = { files: { rel: string; abs: string; size: number }[]; warnings: Skip[]; skip: Skip | null };

/** Lists the non-ignored regular files under a skill directory (stat only, no content read). */
async function collectSkillFiles(rootPath: string, mainFile: string, limits: Limits): Promise<Collected> {
  const out: Collected = { files: [], warnings: [], skip: null };
  let realRoot: string;
  try {
    realRoot = await fs.realpath(rootPath);
  } catch (e) {
    out.skip = unreadable(mainFile, `cannot resolve skill directory (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
    return out;
  }
  let dirs = 0;
  const visit = async (abs: string, rel: string): Promise<boolean> => {
    if (++dirs > MAX_DIRS_PER_CAPABILITY) return false;
    let entries: Awaited<ReturnType<typeof listDir>>;
    try {
      entries = await listDir(abs);
    } catch (err) {
      out.skip = unreadable(mainFile, `cannot list a directory inside the skill (${errCode(err)})`);
      return false;
    }
    for (const e of entries) {
      if (ignored(e.name)) continue;
      const entryAbs = path.join(abs, e.name);
      const entryRel = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory) {
        if (!(await visit(entryAbs, entryRel))) return false;
        continue;
      }
      let size: number;
      if (e.isSymlink) {
        let real: string;
        try {
          real = await fs.realpath(entryAbs);
          if (!(await fs.stat(real)).isFile()) continue; // symlinked directories are not followed; other targets are not files
        } catch {
          out.warnings.push({ path: entryAbs, code: 'symlink_outside', message: 'symlink cannot be resolved; left out' });
          continue;
        }
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
          out.warnings.push({ path: entryAbs, code: 'symlink_outside', message: 'symlink points outside the capability; left out' });
          continue;
        }
        size = (await fs.stat(real)).size;
      } else if (e.isFile) {
        try {
          size = (await fs.lstat(entryAbs)).size;
        } catch (err) {
          out.skip = unreadable(mainFile, `cannot stat a file (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
          return false;
        }
      } else continue;
      out.files.push({ rel: entryRel, abs: entryAbs, size });
      if (out.files.length > limits.maxFiles) return false; // maxFiles + 1 entries are enough to know it is too many
    }
    return true;
  };
  if (!(await visit(rootPath, ''))) {
    out.skip ??= { path: mainFile, code: 'too_many_files', message: `more than ${limits.maxFiles} files` };
  }
  return out;
}

async function readFiles(files: { rel: string; abs: string }[]): Promise<FileInput[] | string> {
  const out: FileInput[] = [];
  for (const f of files) {
    try {
      out.push({ path: f.rel, bytes: new Uint8Array(await fs.readFile(f.abs)) });
    } catch (e) {
      return `cannot read a file (${(e as NodeJS.ErrnoException).code ?? 'error'})`;
    }
  }
  return out;
}

async function foundSkill(rootPath: string, dir: string, limits: Limits): Promise<Found> {
  const mainFile = path.join(rootPath, 'SKILL.md');
  const base = { kind: 'skill' as const, defaultName: dir, rootPath, mainPath: 'SKILL.md', files: [] as FileInput[], warnings: [] as Skip[] };
  const c = await collectSkillFiles(rootPath, mainFile, limits);
  if (c.skip) return { ...base, warnings: c.warnings, skip: c.skip };
  if (!c.files.some((f) => f.rel === 'SKILL.md')) return { ...base, warnings: c.warnings, skip: unreadable(mainFile, 'SKILL.md is not a readable file inside the skill') };
  if (c.files.reduce((n, f) => n + f.size, 0) > limits.maxBytes) {
    return { ...base, warnings: c.warnings, skip: { path: mainFile, code: 'too_large', message: `more than ${limits.maxBytes} bytes` } };
  }
  const read = await readFiles(c.files);
  if (typeof read === 'string') return { ...base, warnings: c.warnings, skip: unreadable(mainFile, read) };
  return { ...base, files: read, warnings: c.warnings, skip: null };
}

async function foundSingle(kind: Kind, dir: string, file: string, defaultName: string, limits: Limits): Promise<Found> {
  const abs = path.join(dir, file);
  const base = { kind, defaultName, rootPath: dir, mainPath: file, files: [] as FileInput[], warnings: [] as Skip[] };
  try {
    // a link may be followed only inside its capability directory (the directory itself may be a link): a plugin must not publish `agents/x.md -> ~/.ssh/id_rsa`
    const realRoot = await fs.realpath(dir);
    const real = await fs.realpath(abs);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      return { ...base, skip: { path: abs, code: 'symlink_outside', message: 'symlink points outside the root' } };
    }
    const st = await fs.stat(abs);
    if (!st.isFile()) return { ...base, skip: unreadable(abs, 'not a regular file') };
    if (st.size > limits.maxBytes) return { ...base, skip: { path: abs, code: 'too_large', message: `more than ${limits.maxBytes} bytes` } };
    return { ...base, files: [{ path: file, bytes: new Uint8Array(await fs.readFile(abs)) }], skip: null };
  } catch (e) {
    return { ...base, skip: unreadable(abs, `cannot read the file (${(e as NodeJS.ErrnoException).code ?? 'error'})`) };
  }
}

/** True when `abs` is a regular file or a symlink (the entry itself may be a symlink and is followed). */
async function isFileOrLink(abs: string): Promise<boolean> {
  try {
    const st = await fs.lstat(abs);
    return st.isFile() || st.isSymbolicLink();
  } catch (e) {
    return absentOr(e);
  }
}

/**
 * Capabilities under one root in D11 order: skills, agents, commands, `ctc-workflows`, `workflows`; each sorted by name.
 * `incomplete` receives one skip per top-level directory that exists but cannot be listed; the caller must not treat the root as fully walked.
 * Files are read after the stat-based count and byte checks. Never throws: a problem becomes `skip` on that capability.
 */
export async function* walkRoot(root: string, limits: Limits = libraryLimits, signal?: AbortSignal, incomplete: Skip[] = []): AsyncGenerator<Found> {
  const list = async (dir: string): Promise<Awaited<ReturnType<typeof listDir>>> => {
    try {
      return await listDir(dir);
    } catch (e) {
      incomplete.push(unreadable(dir, `cannot list the directory (${errCode(e)})`));
      return [];
    }
  };
  for (const e of await list(path.join(root, 'skills'))) {
    if (ignored(e.name) || !(e.isDirectory || e.isSymlink)) continue;
    const dir = path.join(root, 'skills', e.name);
    try {
      if (!(await isDir(dir)) || !(await isFileOrLink(path.join(dir, 'SKILL.md')))) continue;
    } catch (err) {
      signal?.throwIfAborted();
      const mainFile = path.join(dir, 'SKILL.md');
      yield { kind: 'skill', defaultName: e.name, rootPath: dir, mainPath: 'SKILL.md', files: [], warnings: [], skip: unreadable(mainFile, `cannot inspect the skill directory (${errCode(err)})`) };
      continue;
    }
    signal?.throwIfAborted();
    yield await foundSkill(dir, e.name, limits);
  }
  const groups: { kind: Kind; sub: string; exts: string[] }[] = [
    { kind: 'agent', sub: 'agents', exts: ['.md'] },
    { kind: 'command', sub: 'commands', exts: ['.md'] },
    { kind: 'workflow', sub: 'ctc-workflows', exts: ['.yaml', '.yml', '.json'] },
    { kind: 'workflow', sub: 'workflows', exts: ['.yaml', '.yml', '.json', '.md'] },
  ];
  for (const g of groups) {
    const dir = path.join(root, g.sub);
    for (const e of await list(dir)) {
      const ext = g.exts.find((x) => e.name.endsWith(x) && e.name.length > x.length);
      if (ext === undefined || ignored(e.name) || !(e.isFile || e.isSymlink)) continue;
      signal?.throwIfAborted();
      yield await foundSingle(g.kind, dir, e.name, e.name.slice(0, -ext.length), limits);
    }
  }
}
