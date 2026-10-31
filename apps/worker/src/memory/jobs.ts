/**
 * The `memory.import` and `memory.distill` handlers (spec:524-525). `memory.import` turns Claude Code's own memory files
 * (`<claude_home>/projects/<dir>/memory/*.md`) into memories through the same bands as extract; `memory.distill` submits one `llm.extract`
 * job per old transcript that was never extracted, oldest first.
 * Called from: apps/worker main, bound into `startWorkers({ handlers })`; `memory.import` is also submitted by watch.ts's `onChange` and by `POST /api/memories/import`.
 * Why: what the user already told Claude Code, and what old sessions held, must reach ctc memories without the user repeating it.
 * Deliberately NOT done: the worker main and config wiring, writing any file under `claude_home`, creating projects, deleting memories whose file is gone.
 * Untrusted: the payload, every path and byte under `claude_home`, every model reply. A file that cannot be used is skipped and counted, never an error;
 * a store or embedder error propagates so the queue retries. Never logs file text.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyBands, bandPorts, memoryLimits, parseMemoryFile, projectDirName, recallLimits, type Action } from '@ctc/core/memory';
import type { Chat, Embed } from '@ctc/shared/models';
import type { Ctx, Repositories } from '@ctc/shared/repositories';
import type { Handler } from '../jobs/index.ts';

export type MemoryJobDeps = {
  repos: Repositories;
  config: { claude_home: string; memory: { bands: { noop: number; update: number } } };
  embed: Embed;
  chat: Chat;
  submit(input: { queue: string; kind: string; payload: unknown; id?: string }): Promise<{ id: string }>;
  cache?: { epoch: { rotate(kind: 'mem', userId: string, projectId: string): Promise<string | null> } };
  log?: (message: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
  today?: () => string;
};

type JobCtx = { jobId: string; signal: AbortSignal };
const errClass = (e: unknown): string => (e instanceof Error ? e.constructor.name : typeof e);
const isDir = (e: { isDirectory(): boolean }): boolean => e.isDirectory();

/** `realpath(<claude_home>/projects)`, a leading `~` expanded; `null` when it is missing. */
async function projectsHome(claudeHome: string): Promise<string | null> {
  try {
    return await fs.realpath(path.join(claudeHome.replace(/^~(?=$|\/)/, os.homedir()), 'projects'));
  } catch {
    return null;
  }
}

const subdirs = async (dir: string): Promise<string[]> =>
  (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).filter(isDir).map((e) => e.name);

/** Reads a regular file read-only without following a final symlink, at most `maxBytes` (a bigger file is `null`). */
async function readSmall(file: string, maxBytes: number): Promise<Buffer | null> {
  let handle: fs.FileHandle | undefined;
  try {
    if (!(await fs.lstat(file)).isFile()) return null;
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = await handle.stat();
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

export function memoryJobHandlers(deps: MemoryJobDeps): { 'memory.import': Handler; 'memory.distill': Handler } {
  const { repos, log } = deps;
  const now = deps.now ?? Date.now;
  const today = deps.today ?? ((): string => new Date(now()).toISOString().slice(0, 10));

  async function rotate(userId: string, projectId: string, jobId: string): Promise<void> {
    try {
      await deps.cache?.epoch.rotate('mem', userId, projectId);
    } catch (e) {
      log?.('mem epoch rotate failed', { jobId, error: errClass(e) }); // judgment: a cache failure never fails a stored job
    }
  }

  /** `<dir>/memory/<name>.md` under `home` (never `MEMORY.md`): the parts of the path, else `null`. */
  const memoryFileParts = (home: string, real: string): [string, string, string] | null => {
    const parts = path.relative(home, real).split(path.sep);
    const [dir, mid, name] = parts;
    return parts.length === 3 && dir !== '..' && mid === 'memory' && name !== undefined && name.endsWith('.md') && name !== 'MEMORY.md' && dir !== undefined
      ? [dir, mid, name]
      : null;
  };

  const importFiles = async (payload: { userId: string; paths?: string[] }, job: JobCtx): Promise<unknown> => {
    const { userId } = payload;
    const counts = { files: 0, noop: 0, update: 0, supersede: 0, add: 0, skipped: 0 };
    const home = await projectsHome(deps.config.claude_home);
    if (home === null) return counts;

    const candidates: string[] = [];
    if (payload.paths === undefined) {
      for (const dir of await subdirs(home)) {
        const names = await fs.readdir(path.join(home, dir, 'memory'), { withFileTypes: true }).catch(() => []);
        for (const e of names) if (e.name.endsWith('.md') && e.name !== 'MEMORY.md') candidates.push(path.join(home, dir, 'memory', e.name));
      }
    } else {
      candidates.push(...new Set(payload.paths));
    }
    const reals: string[] = [];
    for (const p of candidates) {
      const real = path.isAbsolute(p) ? await fs.realpath(p).catch(() => null) : null;
      if (real !== null && memoryFileParts(home, real) !== null) {
        if (!reals.includes(real)) reals.push(real);
      } else {
        counts.files++;
        counts.skipped++;
      }
    }

    const byDir = new Map<string, string[]>();
    for (let page: { rows: { id: string; root: string }[]; next: string | null } = await repos.projects.list({ userId }, { limit: 200 }); ; ) {
      for (const p of page.rows) byDir.set(projectDirName(p.root), [...(byDir.get(projectDirName(p.root)) ?? []), p.id]);
      if (page.next === null) break;
      page = await repos.projects.list({ userId }, { limit: 200, cursor: page.next });
    }

    const rotated = new Set<string>();
    for (const file of reals) {
      job.signal.throwIfAborted();
      counts.files++;
      const skip = (): void => void counts.skipped++;
      const parts = memoryFileParts(home, file);
      const buf = parts === null ? null : await readSmall(file, recallLimits.maxImportBytes);
      let raw: string | null = null;
      try {
        raw = buf === null ? null : new TextDecoder('utf-8', { fatal: true }).decode(buf);
      } catch {
        raw = null;
      }
      const parsed = raw === null ? null : parseMemoryFile(raw);
      if (parts === null || parsed === null || parsed.text.length > memoryLimits.maxMemoryChars) {
        skip();
        continue;
      }
      const owners = parsed.type === 'user' ? [] : (byDir.get(parts[0]) ?? []);
      const scope = parsed.type === 'user' ? 'global' : 'project';
      if (scope === 'project' && owners.length !== 1) {
        skip();
        continue;
      }
      const projectId = owners[0];
      const ctx: Ctx = scope === 'project' && projectId !== undefined ? { userId, projectId } : { userId };
      const ports = bandPorts({ memory: repos.memory, embed: deps.embed, chat: deps.chat, today }, ctx, {
        source: { type: 'file', path: file }, signal: job.signal, reinforce: false,
      });
      const { action } = await applyBands(ports, { kind: parsed.kind, scope, text: parsed.text, confidence: 1 }, deps.config.memory.bands);
      counts[action.toLowerCase() as Lowercase<Action>]++;
      if (action !== 'NOOP' && projectId !== undefined && scope === 'project') rotated.add(projectId);
    }
    for (const projectId of rotated) await rotate(userId, projectId, job.jobId);
    log?.('import done', { jobId: job.jobId, ...counts });
    return counts;
  };

  const distill = async (payload: { userId: string; limit?: number }, job: JobCtx): Promise<unknown> => {
    const { userId } = payload;
    const ctx: Ctx = { userId };
    const counts = { found: 0, queued: 0, skipped: 0, known: 0, young: 0, left: 0 };
    const home = await projectsHome(deps.config.claude_home);
    if (home === null) return counts;
    const limit = Math.min(Math.max(Math.trunc(payload.limit ?? recallLimits.distillDefault), 1), recallLimits.distillMax);

    const found: { path: string; size: number; mtime: number }[] = [];
    for (const dir of await subdirs(home)) {
      for (const e of await fs.readdir(path.join(home, dir), { withFileTypes: true }).catch(() => [])) {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
        const file = path.join(home, dir, e.name);
        const st = await fs.lstat(file).catch(() => null);
        if (st?.isFile()) found.push({ path: file, size: st.size, mtime: Math.trunc(st.mtimeMs) });
      }
    }
    found.sort((a, b) => a.mtime - b.mtime || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    counts.found = found.length;

    const old = found.filter((f) => f.mtime <= now() - recallLimits.distillMinAgeMs);
    counts.young = found.length - old.length;
    const known = new Set<string>();
    for (let i = 0; i < old.length; i += 500) {
      for (const h of await repos.history.byPaths(ctx, old.slice(i, i + 500).map((f) => f.path))) known.add(h.path);
    }
    const todo = old.filter((f) => !known.has(f.path));
    counts.known = old.length - todo.length;

    let i = 0;
    for (; i < todo.length && counts.queued < limit; i++) {
      job.signal.throwIfAborted();
      const f = todo[i] as (typeof todo)[number];
      const name = path.basename(f.path);
      const head = (await readHead(f.path)) ?? '';
      const cwd = cwdOf(head);
      if (!/^[A-Za-z0-9._-]{1,128}\.jsonl$/.test(name) || (cwd !== undefined && cwd.includes('/.ctc/wt/'))) {
        await repos.history.upsert(ctx, { path: f.path, size: f.size, mtime: f.mtime, status: 'skipped' });
        counts.skipped++;
        continue;
      }
      const project = cwd === undefined ? null : await repos.projects.byRoot(ctx, cwd.replace(/\/+$/, '') || '/');
      const sessionId = name.slice(0, -'.jsonl'.length);
      await deps.submit({
        queue: 'llm',
        kind: 'extract',
        id: `distill:${createHash('sha1').update(f.path).digest('hex')}`,
        payload: { userId, sessionId, transcriptPath: f.path, ...(project ? { projectId: project.id } : {}) },
      });
      await repos.history.upsert(ctx, { path: f.path, size: f.size, mtime: f.mtime, status: 'imported' });
      counts.queued++;
    }
    counts.left = todo.length - i;
    log?.('distill done', { jobId: job.jobId, ...counts });
    return counts;
  };

  return { 'memory.import': importFiles, 'memory.distill': distill };
}

/** The first `distillHeadBytes` of a transcript as text (a cut last line is dropped by the JSON parse), or `null`. */
async function readHead(file: string): Promise<string | null> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const buf = Buffer.alloc(recallLimits.distillHeadBytes);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** The `cwd` of the first JSON line that has a string `cwd`. */
function cwdOf(head: string): string | undefined {
  for (const line of head.split('\n')) {
    if (!line.includes('"cwd"')) continue;
    try {
      const v = JSON.parse(line) as { cwd?: unknown } | null;
      if (typeof v?.cwd === 'string') return v.cwd;
    } catch {
      // judgment: a line that is not JSON (or a cut one) is passed over
    }
  }
  return undefined;
}
