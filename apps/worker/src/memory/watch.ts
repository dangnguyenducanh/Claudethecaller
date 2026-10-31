/**
 * File watch on Claude Code's memory files: one debounced `onChange` per burst of events with the sorted absolute paths that changed (spec:524).
 * Called from: apps/worker main, which binds `onChange` to submitting `memory.import` with those `paths`.
 * Deliberately NOT done: importing itself, a polling fallback, watching a `claude_home` that does not exist yet (logged, no-op watcher).
 * Untrusted: file names in events (only `<dir>/memory/<name>.md`, not `MEMORY.md`, is kept).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recallLimits } from '@ctc/core/memory';

const errName = (e: unknown): string => (e instanceof Error ? e.constructor.name : typeof e);

export function watchMemoryFiles(opts: {
  claudeHome: string;
  onChange(paths: string[]): void | Promise<void>;
  debounceMs?: number;
  log?: (m: string, f?: Record<string, unknown>) => void;
}): { close(): void } {
  const projects = path.join(opts.claudeHome.replace(/^~(?=$|\/)/, os.homedir()), 'projects');
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  const fire = (): void => {
    timer = undefined;
    const paths = [...pending].sort();
    pending.clear();
    if (closed || paths.length === 0) return;
    try {
      Promise.resolve(opts.onChange(paths)).catch((e: unknown) => opts.log?.('memory watch onChange failed', { error: errName(e) }));
    } catch (e) {
      opts.log?.('memory watch onChange failed', { error: errName(e) });
    }
  };
  const onEvent = (_event: string, name: string | Buffer | null): void => {
    if (closed || name === null) return;
    const parts = String(name).split(/[\\/]/);
    const [dir, mid, file] = parts;
    if (parts.length !== 3 || dir === '' || dir === '..' || mid !== 'memory' || file === undefined || !file.endsWith('.md') || file === 'MEMORY.md') return;
    pending.add(path.join(projects, ...parts));
    clearTimeout(timer);
    timer = setTimeout(fire, opts.debounceMs ?? recallLimits.importDebounceMs);
  };

  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(projects, { recursive: true }, onEvent);
    watcher.on('error', (e) => opts.log?.('memory watch error', { error: errName(e) }));
  } catch (e) {
    opts.log?.('memory watch not started', { error: errName(e) });
  }

  return {
    close(): void {
      closed = true;
      clearTimeout(timer);
      timer = undefined;
      pending.clear();
      watcher?.close();
    },
  };
}
