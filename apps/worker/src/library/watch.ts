/**
 * File watch on the library roots: one debounced `onChange` per burst of events (spec:410 trigger).
 * Called from: apps/worker main, which binds `onChange` to submitting `library.scan` for `local`.
 * Deliberately NOT done: scanning itself, polling fallback, watching roots that do not exist yet.
 * Untrusted: file names in events (only used to ignore dot, node_modules and __pycache__ paths).
 */
import fs from 'node:fs';
import type { Log } from './scan.ts';

const IGNORED = new Set(['node_modules', '__pycache__']);
const errName = (e: unknown): string => (e instanceof Error ? e.constructor.name : typeof e);

export function watchLibrary(opts: { roots: readonly string[]; onChange: () => void | Promise<void>; debounceMs?: number; log?: Log }): { close(): void } {
  // judgment: 3 s trailing debounce, the same as the graph file watch (config graph.debounce_s default)
  const debounceMs = opts.debounceMs ?? 3000;
  const watchers: fs.FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  const fire = (): void => {
    timer = undefined;
    if (closed) return;
    try {
      Promise.resolve(opts.onChange()).catch((e: unknown) => opts.log?.('library watch onChange failed', { error: errName(e) }));
    } catch (e) {
      opts.log?.('library watch onChange failed', { error: errName(e) });
    }
  };
  const onEvent = (_event: string, name: string | Buffer | null): void => {
    if (closed) return;
    if (name !== null && String(name).split(/[\\/]/).some((seg) => seg.startsWith('.') || IGNORED.has(seg))) return;
    clearTimeout(timer);
    timer = setTimeout(fire, debounceMs);
  };

  for (const root of opts.roots) {
    try {
      const w = fs.watch(root, { recursive: true }, onEvent);
      w.on('error', (e) => opts.log?.('library watch error', { error: errName(e) }));
      watchers.push(w);
    } catch (e) {
      opts.log?.('library watch not started', { error: errName(e) });
    }
  }

  return {
    close(): void {
      closed = true;
      clearTimeout(timer);
      timer = undefined;
      for (const w of watchers.splice(0)) w.close();
    },
  };
}
