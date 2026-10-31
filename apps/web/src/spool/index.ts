/**
 * The spool drain: turns the files written by `hooks/spool` into jobs (`graph.rebuild`, `llm.extract`, `llm.summarize`) and a
 * `sessions` upsert, and deletes each file once its job row exists and the BullMQ add returned true.
 * Called from: the ctc-web bootstrap (built later): `start()` at boot, `nudgeRoute(drain)` at `POST /v1/spool/nudge`, `close()` at shutdown.
 * Why: the web process may be down during a session; nothing is lost, the spool is processed when it returns (spec:108, spec:502-517).
 * Deliberately NOT done: the Fastify app and boot order, the 3 s `graph.rebuild` debounce (T2.2), job handlers (T2.2, T4.2),
 * reading transcripts, `sanitize`, filtering runner sessions, pruning `corrupt/`, shared mode, Windows.
 * Trust: every byte of every file and every file name is untrusted. A bad file is classified once (corrupt/, dropped, kept), never retried.
 */
import { constants, watch } from 'node:fs';
import { link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { submitJob, type Queues } from '@ctc/shared/queues';
import { RepoError } from '@ctc/shared/repositories';
import { EDIT_TOOLS, SpoolFileSchema, type SpoolFile } from '@ctc/shared/spool';

/** Read at call time: a test may assign to it and restore it. 1 MB, 30 s and 250 ms: spec:213, spec:506, spec:505. */
export const spoolLimits = { maxFileBytes: 1_048_576, sweepEveryMs: 30_000, nudgeTimeoutMs: 250 };

export type DrainReport = { queued: number; dropped: number; corrupt: number; kept: number; expired: number };

type Log = (message: string, fields?: Record<string, unknown>) => void;
type Ctx = { userId: string };

export type SpoolDeps = {
  dir: string;
  keepDays: number;
  userId?: string;
  queues: Queues;
  repos: {
    projects: { upsert(ctx: Ctx, input: { root: string }): Promise<{ id: string }> };
    sessions: { upsert(ctx: Ctx, input: { id: string; projectId: string; endedAt?: string; transcriptPath?: string }): Promise<unknown> };
    jobs: { create(ctx: Ctx, input: { id: string; queue: string; kind: string; payload: unknown }): Promise<{ job: { id: string }; created: boolean }> };
  };
  log?: Log;
  now?: () => number;
};

export type SpoolDrain = { start(): Promise<void>; drainOnce(): Promise<DrainReport>; nudge(): void; close(): Promise<void> };

const DAY_MS = 86_400_000;
const zero = (): DrainReport => ({ queued: 0, dropped: 0, corrupt: 0, kept: 0, expired: 0 });

type JobSpec = { queue: string; kind: string; payload: Record<string, unknown> };
type Routed = { drop: string } | { job: JobSpec };

/** A longer root cannot be a `projects.name` (btree entry limit 2704 bytes, D12). */
const MAX_ROOT_BYTES = 2048;

/** Root of the project of an absolute `cwd`: trailing slashes removed, `/` stays `/`. `undefined` for a relative, missing or over-long `cwd`. */
function projectRoot(cwd: string | undefined): string | undefined {
  if (cwd === undefined || !path.posix.isAbsolute(cwd)) return undefined;
  const root = cwd.replace(/\/+$/, '') || '/';
  return Buffer.byteLength(root, 'utf8') > MAX_ROOT_BYTES ? undefined : root;
}

/** Path of `filePath` relative to `root`, or `undefined` when it is the root itself or lies outside it. Lexical: no `realpath`. */
function relativeInside(root: string, filePath: string): string | undefined {
  const rel = path.posix.relative(root, path.posix.resolve(root, filePath));
  // judgment: `..name` is a legal file name inside the project, so only `..` and `../…` count as outside
  if (rel === '' || path.posix.isAbsolute(rel) || rel === '..' || rel.startsWith('../')) return undefined;
  return rel;
}

/** Path of the first required payload field of the event that is missing or has the wrong type (D4), or `undefined`. */
function missingField(file: SpoolFile): string | undefined {
  const p = file.payload;
  if (file.event === 'Stop' || file.event === 'SessionEnd') return p.session_id === undefined ? 'payload.session_id' : undefined;
  if (file.event !== 'PostToolUse' || !EDIT_TOOLS.some((t) => t === p.tool_name)) return undefined;
  if (p.cwd === undefined) return 'payload.cwd';
  if (p.tool_input === undefined) return 'payload.tool_input';
  return p.tool_input.file_path === undefined ? 'payload.tool_input.file_path' : undefined;
}

/**
 * Creates a drain on `deps.dir`. Never touches `deps.queues` or the database lifecycle: the caller owns them.
 * @throws TypeError synchronously when `deps` is wrong (a programming error, not input).
 */
export function createSpoolDrain(deps: SpoolDeps): SpoolDrain {
  if (typeof deps?.dir !== 'string' || deps.dir === '') throw new TypeError('deps.dir must be a non-empty string');
  if (!Number.isInteger(deps.keepDays) || deps.keepDays <= 0) throw new TypeError('deps.keepDays must be a positive integer');
  if (!deps.queues || !deps.repos) throw new TypeError('deps.queues and deps.repos are required');
  const { dir, keepDays, queues, repos, log } = deps;
  const ctx: Ctx = { userId: deps.userId ?? 'local' };
  const now = deps.now ?? Date.now;
  const corruptDir = path.join(dir, 'corrupt');
  const expiredAt = (mtimeMs: number) => now() - mtimeMs > keepDays * DAY_MS;

  /** Moves a file to `corrupt/` without overwriting: an existing name gets the suffix `.<Date.now()>`. Returns false when it could not move. */
  async function toCorrupt(name: string, reason: string, fields: Record<string, unknown> = {}): Promise<boolean> {
    log?.('spool file corrupt', { file: name, reason, ...fields });
    const from = path.join(dir, name);
    try {
      await mkdir(corruptDir, { recursive: true, mode: 0o700 });
      for (let attempt = 0; attempt < 5; attempt++) {
        const to = path.join(corruptDir, attempt === 0 ? name : `${name}.${Date.now()}${attempt > 1 ? `-${attempt}` : ''}`);
        try {
          await link(from, to); // fails with EEXIST instead of overwriting
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
          throw e;
        }
        await unlink(from);
        return true;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true; // someone else removed it
      log?.('spool file move failed', { file: name, code: (e as NodeJS.ErrnoException).code });
    }
    return false;
  }

  async function remove(name: string): Promise<void> {
    try {
      await unlink(path.join(dir, name));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log?.('spool file delete failed', { file: name, code: (e as NodeJS.ErrnoException).code });
    }
  }

  /** Project of an absolute `cwd` (created on first use), or `undefined` when the root is unusable (D12). Other store errors propagate. */
  async function projectOf(cwd: string | undefined): Promise<string | undefined> {
    const root = projectRoot(cwd);
    if (root === undefined) return undefined;
    try {
      return (await repos.projects.upsert(ctx, { root })).id;
    } catch (e) {
      if (!(e instanceof RepoError)) throw e;
      log?.('project upsert refused', { code: e.code });
      return undefined;
    }
  }

  /** D12. Throws when the store fails (the caller keeps the file). */
  async function route(file: SpoolFile): Promise<Routed> {
    const p = file.payload;
    if (file.event === 'PostToolUse') {
      if (!EDIT_TOOLS.some((t) => t === p.tool_name)) return { drop: 'tool' };
      const root = projectRoot(p.cwd);
      const rel = root === undefined || p.tool_input?.file_path === undefined ? undefined : relativeInside(root, p.tool_input.file_path);
      if (rel === undefined) return { drop: 'outside' };
      const projectId = await projectOf(root);
      if (projectId === undefined) return { drop: 'outside' };
      return { job: { queue: 'graph', kind: 'rebuild', payload: { userId: ctx.userId, projectId, files: [rel] } } };
    }
    if (file.event !== 'Stop' && file.event !== 'SessionEnd') return { drop: 'event' };
    const sessionId = p.session_id;
    if (sessionId === undefined) return { drop: 'session' };
    const projectId = await projectOf(p.cwd);
    const base = { userId: ctx.userId, ...(projectId === undefined ? {} : { projectId }), sessionId };
    if (file.event === 'Stop') {
      return { job: { queue: 'llm', kind: 'extract', payload: { ...base, ...(p.transcript_path === undefined ? {} : { transcriptPath: p.transcript_path }) } } };
    }
    if (projectId !== undefined) {
      try {
        await repos.sessions.upsert(ctx, {
          id: sessionId,
          projectId,
          endedAt: file.received_at,
          ...(p.transcript_path === undefined ? {} : { transcriptPath: p.transcript_path }),
        });
      } catch (e) {
        if (!(e instanceof RepoError)) throw e;
        log?.('session upsert refused', { event: file.event, code: e.code });
      }
    }
    return { job: { queue: 'llm', kind: 'summarize', payload: base } };
  }

  /** Reads a regular file of at most `maxFileBytes` without following symlinks or blocking on a FIFO. */
  async function read(name: string): Promise<{ skip: true } | { kept: true } | { tooBig: true } | { text: string | null }> {
    let fh;
    try {
      fh = await open(path.join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENXIO') return { skip: true };
      log?.('spool file unreadable', { file: name, code });
      return { kept: true };
    }
    try {
      const st = await fh.stat();
      if (!st.isFile()) return { skip: true };
      if (st.size > spoolLimits.maxFileBytes) return { tooBig: true };
      const buf = Buffer.alloc(st.size);
      let got = 0;
      while (got < buf.length) {
        const { bytesRead } = await fh.read(buf, got, buf.length - got, got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      try {
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, got)) };
      } catch {
        return { text: null };
      }
    } finally {
      await fh.close();
    }
  }

  /** One pass over the directory. Never rejects. */
  async function pass(): Promise<DrainReport> {
    const report = zero();
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log?.('spool dir unreadable', { code: (e as NodeJS.ErrnoException).code });
      return report;
    }
    const files: { name: string; mtimeMs: number }[] = [];
    for (const name of names) {
      const isJson = name.endsWith('.json') && name.length > '.json'.length;
      if (!isJson && !name.endsWith('.tmp')) continue;
      try {
        const st = await lstat(path.join(dir, name));
        if (!st.isFile()) continue;
        if (isJson) files.push({ name, mtimeMs: st.mtimeMs });
        else if (expiredAt(st.mtimeMs)) {
          await remove(name);
          report.expired++;
        }
      } catch {
        // gone since readdir: someone else deleted it
      }
    }
    files.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    let stopped = false; // after the first delivery failure the rest of the pass only checks expiry
    const undelivered = async (f: { name: string; mtimeMs: number }) => {
      if (expiredAt(f.mtimeMs)) {
        await remove(f.name);
        report.expired++;
      } else report.kept++;
    };
    const corrupt = async (name: string, reason: string, fields?: Record<string, unknown>) => {
      if (await toCorrupt(name, reason, fields)) report.corrupt++;
      else report.kept++;
    };
    for (const f of files) {
      try {
        if (stopped) {
          await undelivered(f);
          continue;
        }
        const got = await read(f.name);
        if ('skip' in got) continue;
        if ('kept' in got) {
          report.kept++;
          continue;
        }
        if ('tooBig' in got || got.text === null) {
          await corrupt(f.name, 'tooBig' in got ? 'too_big' : 'not_json');
          continue;
        }
        let json: unknown;
        try {
          json = JSON.parse(got.text);
        } catch {
          await corrupt(f.name, 'not_json');
          continue;
        }
        const parsed = SpoolFileSchema.safeParse(json);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          await corrupt(f.name, 'schema', { path: issue?.path.join('.') ?? '' });
          continue;
        }
        const missing = missingField(parsed.data);
        if (missing !== undefined) {
          await corrupt(f.name, 'schema', { path: missing });
          continue;
        }
        const routed = await route(parsed.data);
        if ('drop' in routed) {
          log?.('spool file dropped', { file: f.name, reason: routed.drop, event: parsed.data.event });
          await remove(f.name);
          report.dropped++;
          continue;
        }
        const sent = await submitJob(
          {
            queues,
            create: async (row) => {
              const r = await repos.jobs.create(ctx, row);
              return { id: r.job.id, created: r.created };
            },
            ...(log ? { log } : {}),
          },
          { ...routed.job, id: `spool:${f.name.slice(0, -'.json'.length)}` },
        );
        if (sent.enqueued) {
          await remove(f.name);
          report.queued++;
        } else {
          stopped = true;
          await undelivered(f);
        }
      } catch (e) {
        // store down, conflict, anything unexpected: keep the file, stop delivering in this pass
        log?.('spool delivery failed', { file: f.name, error: e instanceof Error ? e.constructor.name : typeof e });
        stopped = true;
        await undelivered(f);
      }
    }
    return report;
  }

  // At most one pass at a time; triggers during a pass share exactly one follow-up pass (D14).
  let active: Promise<DrainReport> | undefined;
  let waiting: Promise<DrainReport> | undefined;
  let started = false;
  let closed: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let watcher: { close(): void } | undefined;

  const begin = (): Promise<DrainReport> => {
    const p: Promise<DrainReport> = pass().finally(() => {
      active = undefined;
    });
    active = p;
    return p;
  };
  const trigger = (): Promise<DrainReport> => {
    if (waiting) return waiting;
    if (!active) return begin();
    waiting = active.then(() => {
      waiting = undefined;
      return closed ? zero() : begin();
    });
    return waiting;
  };

  return {
    async start() {
      if (started || closed) return;
      started = true;
      try {
        await mkdir(corruptDir, { recursive: true, mode: 0o700 }); // also creates `dir`
      } catch (e) {
        log?.('spool dir not created', { code: (e as NodeJS.ErrnoException).code });
      }
      await trigger();
      if (closed) return;
      try {
        const w = watch(dir, { persistent: false }, () => void trigger());
        w.on('error', (e) => {
          log?.('spool watch failed', { code: (e as NodeJS.ErrnoException).code });
          w.close();
        });
        watcher = w;
      } catch (e) {
        log?.('spool watch not started', { code: (e as NodeJS.ErrnoException).code });
      }
      timer = setInterval(() => void trigger(), spoolLimits.sweepEveryMs);
      timer.unref();
    },
    drainOnce: trigger,
    nudge() {
      if (started && !closed) void trigger();
    },
    close() {
      closed ??= (async () => {
        clearInterval(timer);
        watcher?.close();
        await active;
        await waiting;
      })();
      return closed;
    },
  };
}

/** Fastify-shaped route object. Replies `204` with an empty body first, then triggers a pass; the request body is ignored. */
export function nudgeRoute(drain: SpoolDrain): {
  method: 'POST';
  url: '/v1/spool/nudge';
  handler(req: unknown, reply: { code(n: number): { send(): unknown } }): unknown;
} {
  return {
    method: 'POST',
    url: '/v1/spool/nudge',
    handler(_req, reply) {
      const sent = reply.code(204).send();
      drain.nudge();
      return sent;
    },
  };
}
