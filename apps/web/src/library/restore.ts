/**
 * Restore of one version's files onto disk (D18). Called from: routes.ts (`POST /api/capabilities/:id/restore`).
 * Why: spec:383 user story 4, "put back what the skill looked like at version n", with each file replaced atomically (temp file + rename).
 * Deliberately NOT done: deleting files that are not in the version, moving any label other than `latest`, writing for a non-local user.
 * Untrusted: `rootPath` and every manifest path read from the database (rows may come from `ctc migrate --from-python`); a symlink under the root.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Ctx } from '@ctc/shared/repositories';
import { conflict, notFound, type LibraryApiDeps } from './http.ts';

const IMPORTED = 'imported from python';
const inFlight = new Set<string>();

const within = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
const real = (p: string): Promise<string | null> => fs.realpath(p).catch(() => null);

/** True for a manifest path the scanner could never have stored: absolute, empty or dot segment, hidden segment, NUL. */
export function unsafeManifestPath(p: string): boolean {
  // judgment: a backslash is refused too (a Windows separator in a row that came from elsewhere); refuse a write over guessing (D8).
  if (p.includes('\0') || p.startsWith('/') || p.includes('\\')) return true;
  return p.split('/').some((seg) => seg === '' || seg.startsWith('.'));
}

/** Real path of the nearest existing ancestor of `target` and the missing segments below it. */
async function splitExisting(target: string): Promise<{ base: string; rest: string[] } | null> {
  const rest: string[] = [];
  let cur = target;
  for (;;) {
    const r = await real(cur);
    if (r !== null) return { base: r, rest: rest.reverse() };
    const up = path.dirname(cur);
    if (up === cur) return null;
    rest.push(path.basename(cur));
    cur = up;
  }
}

/** Walks `segments` below `base` one at a time, creating missing directories; a symlink must resolve inside `limit`. Returns the real directory. */
async function ensureDir(base: string, segments: string[], limit: string): Promise<string> {
  let cur = base;
  for (const seg of segments) {
    const next = path.join(cur, seg);
    const st = await fs.lstat(next).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
    if (st === null) {
      await fs.mkdir(next);
      cur = next;
    } else if (st.isSymbolicLink()) {
      const target = await real(next);
      if (target === null || !within(target, limit)) throw conflict('a symlink leaves the capability folder');
      cur = target;
    } else {
      cur = next;
    }
  }
  return cur;
}

async function removeAll(files: string[]): Promise<void> {
  await Promise.all(files.map((f) => fs.rm(f, { force: true }).catch(() => undefined)));
}

/** Writes the files of `versionNumber`, then records them as a new `restore v<n>` version unless they equal the latest one. */
export async function restore(deps: LibraryApiDeps, ctx: Ctx, capId: string, versionNumber: number) {
  const { repos, config } = deps;
  if (config.mode !== 'local' || ctx.userId !== 'local') throw conflict('restore needs local mode');
  const cap = await repos.library.get(ctx, capId);
  const version = cap ? await repos.library.getVersion(ctx, capId, versionNumber) : null;
  if (!cap || !version) throw notFound('capability or version not found');
  if (version.commitMessage === IMPORTED) throw conflict('a version imported from python cannot be restored');

  const manifest = await repos.library.manifest(ctx, version.id);
  if (manifest.some((m) => unsafeManifestPath(m.path))) throw conflict('the version has an unsafe file path');
  if (!path.isAbsolute(cap.rootPath) || cap.rootPath.includes('\0')) throw conflict('the capability folder is not an absolute path');
  const rootPath = path.resolve(cap.rootPath);
  const roots = (await Promise.all([config.claude_home, ...config.library.roots].map((r) => real(r)))).filter((r): r is string => r !== null);
  const anchor = await splitExisting(rootPath);
  if (!anchor || !roots.some((r) => within(anchor.base, r))) throw conflict('the capability folder is outside the allowed roots');
  if (inFlight.has(capId)) throw conflict('a restore of this capability is running');
  inFlight.add(capId);

  const temps: string[] = [];
  try {
    const contents: string[] = [];
    for (const m of manifest) {
      const c = await repos.library.getBlob(ctx, version.id, m.path);
      if (c === null) throw new Error('blob missing');
      contents.push(c);
    }
    const root = await ensureDir(anchor.base, anchor.rest, anchor.base);
    const plan: { target: string; temp: string }[] = [];
    for (const [i, m] of manifest.entries()) {
      const segments = m.path.split('/');
      const name = segments.pop() as string;
      const dir = await ensureDir(root, segments, root);
      const target = path.join(dir, name);
      const existing = await fs.stat(target).catch(() => null);
      if (existing?.isDirectory()) throw new Error('a directory is in the way');
      const temp = path.join(dir, `.${name}.ctc-restore-${randomBytes(6).toString('hex')}`);
      temps.push(temp);
      await fs.writeFile(temp, contents[i] as string, { flag: 'wx', ...(existing ? { mode: existing.mode & 0o777 } : {}) });
      if (existing) await fs.chmod(temp, existing.mode & 0o777);
      plan.push({ target, temp });
    }
    for (const p of plan) {
      await fs.rename(p.temp, p.target);
      temps.splice(temps.indexOf(p.temp), 1);
    }
  } catch (e) {
    await removeAll(temps);
    throw e;
  } finally {
    inFlight.delete(capId);
  }

  const { version: latest, created } = await repos.library.createVersion(ctx, {
    namespace: cap.namespace, kind: cap.kind, name: cap.name, rootPath: cap.rootPath, description: version.description,
    frontmatter: version.frontmatter ?? {}, bodyHash: version.bodyHash, commitMessage: `restore v${version.version}`,
    blobs: [], files: manifest.map((m) => ({ path: m.path, blobHash: m.blobHash })),
  });
  if (created) {
    try {
      await deps.submit({ queue: 'library', kind: 'changed', payload: { userId: ctx.userId, capId, version: latest.version } });
    } catch (e) {
      deps.log?.('library.changed submit failed', { error: e instanceof Error ? e.constructor.name : typeof e });
    }
  }
  return { version: latest.version, created, written: manifest.map((m) => m.path).sort() };
}
