/**
 * Library roots: which directories the scanner walks and the namespace of each.
 * Called from: the `library.scan` handler (apps/worker/src/library/handlers.ts) and the worker main for the file watch.
 * Why: the roots always come from trusted config plus Claude Code's `installed_plugins.json`, never from a job payload (D1b).
 * Deliberately NOT done: walking, project-level `.claude` roots, `plugin.json`-declared paths (D7).
 * Untrusted: `installed_plugins.json` (missing, malformed or hostile is tolerated).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256Hex } from '@ctc/core/library';

export type Root = { path: string; namespace: string };

/** judgment: a plugin index larger than this is not read (it is a few KB in practice). */
const MAX_PLUGIN_INDEX_BYTES = 1_048_576;

const realOrResolved = async (p: string): Promise<string> => {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
};

async function pluginRoots(claudeHome: string): Promise<Root[]> {
  let parsed: unknown;
  try {
    const file = path.join(claudeHome, 'plugins', 'installed_plugins.json');
    if ((await fs.stat(file)).size > MAX_PLUGIN_INDEX_BYTES) return [];
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return [];
  }
  const plugins = (parsed as { plugins?: unknown } | null)?.plugins;
  if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) return [];
  const out: Root[] = [];
  for (const key of Object.keys(plugins).sort()) {
    const namespace = key.split('@')[0] ?? '';
    if (namespace === '') continue;
    const value = (plugins as Record<string, unknown>)[key];
    const installPaths = (Array.isArray(value) ? value : [value])
      .map((e) => (e as { installPath?: unknown } | null)?.installPath)
      // judgment: a relative installPath would depend on the process cwd, so it is ignored
      .filter((p): p is string => typeof p === 'string' && path.isAbsolute(p))
      .sort();
    for (const p of installPaths) out.push({ path: path.resolve(p), namespace });
  }
  return out;
}

/**
 * Configured roots in order (namespace `user` for `claudeHome` itself, else `root@<sha8>`), then plugin roots sorted by plugin key;
 * duplicates by real path are dropped, first wins. Roots that do not exist are still returned. Never throws for bad input files.
 */
export async function discoverRoots(opts: { claudeHome: string; roots: readonly string[] }): Promise<Root[]> {
  const home = await realOrResolved(opts.claudeHome);
  const all: Root[] = [];
  for (const root of opts.roots) {
    const resolved = path.resolve(root);
    all.push({ path: resolved, namespace: (await realOrResolved(resolved)) === home ? 'user' : `root@${sha256Hex(resolved).slice(0, 8)}` });
  }
  all.push(...(await pluginRoots(path.resolve(opts.claudeHome))));
  const seen = new Set<string>();
  const out: Root[] = [];
  for (const r of all) {
    const real = await realOrResolved(r.path);
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(r);
  }
  return out;
}
