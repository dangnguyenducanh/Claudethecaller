/**
 * Git access of the runner cold path: one command at a time per real repo path, output read back from a file, the `info/exclude` line.
 * Called from: ./index.ts (worktree stage, ctc.yaml read) and ./follow.ts (diff stat). Why: concurrent `git worktree add` into one repo fight
 * over the repo's lock files, so every git command of one repo goes through one queue (D12c).
 * Deliberately NOT done: any git write other than `worktree add`, `config branch.<b>.base` and the exclude line (D6d); git is never forced,
 * never asked to delete or reset anything, and a branch or worktree that exists is left as it is.
 * Untrusted: repo path, branch, base (they reach git only as separate argv entries, after `worktreeRecipe` refused a leading `-`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { runGroup, scrubbedEnv } from './proc.ts';

export type GitResult = { code: number | null; timedOut: boolean; aborted: boolean; overflow: boolean; text: string };

const queues = new Map<string, Promise<unknown>>();

/** Key of the queue: the real path of the repo (two spellings of one repo share a queue), the given path when it cannot be resolved. */
export async function repoKey(repo: string): Promise<string> {
  try {
    return await fs.promises.realpath(repo);
  } catch {
    return repo;
  }
}

/** Runs `fn` after every earlier job of the same key; different keys run in parallel. A failing `fn` does not block the next one. */
export function withRepo<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

const MAX_GIT_OUTPUT = 1024 * 1024;

/**
 * `git -C <repo> <args>` as its own process group with stdout and stderr merged into `outFile` (truncated first). Returns the text read back.
 * Rejects only when git cannot be started.
 */
export async function runGit(o: { repo: string; args: string[]; outFile: string; timeoutMs: number; signal?: AbortSignal }): Promise<GitResult> {
  await fs.promises.rm(o.outFile, { force: true });
  const res = await runGroup({
    cmd: ['git', '-C', o.repo, ...o.args], cwd: '/', env: scrubbedEnv({ GIT_TERMINAL_PROMPT: '0' }), timeoutMs: o.timeoutMs,
    maxOutputBytes: MAX_GIT_OUTPUT, outFile: o.outFile, ...(o.signal === undefined ? {} : { signal: o.signal }),
  });
  const text = await fs.promises.readFile(o.outFile, 'utf8').catch(() => '');
  return { ...res, text };
}

/** First useful line of a failed git command: the `fatal:` / `error:` line, else the first non-empty line, else the exit code. */
export function gitErrorLine(r: GitResult): string {
  const lines = r.text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  return lines.find((l) => /^(fatal|error):/.test(l)) ?? lines[0] ?? `exit ${r.code}`;
}

/**
 * Appends `/<first segment of dir>/` to `<git common dir>/info/exclude` unless a line equals it, so the main checkout does not list the
 * worktrees as untracked (D12d). Best effort: a failure here never fails the attempt.
 */
export async function ensureExcluded(o: { repo: string; dir: string; outFile: string; timeoutMs: number }): Promise<void> {
  const first = o.dir.split('/').find((s) => s !== '' && s !== '.');
  if (first === undefined) return;
  const r = await runGit({ repo: o.repo, args: ['rev-parse', '--git-common-dir'], outFile: o.outFile, timeoutMs: o.timeoutMs });
  const common = r.text.trim();
  if (r.code !== 0 || common === '') return;
  const file = path.join(path.resolve(o.repo, common), 'info', 'exclude');
  const line = `/${first}/`;
  try {
    const old = await fs.promises.readFile(file, 'utf8').catch(() => '');
    if (old.split('\n').includes(line)) return;
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.appendFile(file, `${old === '' || old.endsWith('\n') ? '' : '\n'}${line}\n`);
  } catch {
    // judgment: the exclude line is a convenience; the worktree works without it
  }
}
