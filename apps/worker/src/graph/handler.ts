/**
 * The `graph` queue handler: `graph.rebuild`.
 *
 * Called from: apps/worker main, bound into `startWorkers({ handlers })` (apps/worker/src/jobs/index.ts). Why it exists: spec:290
 * (rebuild after edits, debounced 3 s) and spec:295 (a refused shrinking write ends the job with an error naming the file).
 * Deliberately NOT done: submitting jobs, the embedding client (injected), `graph.extract` (T2.3), coalescing jobs per project.
 * Untrusted: the payload (re-validated by runAttempt; `files` entries are checked again by the walk), the project's `cwd`.
 */
import { GrammarError, loadGrammars } from '@ctc/core/graph';
import type { Grammars } from '@ctc/core/graph';
import { JobDropped } from '@ctc/shared/queues';
import type { Repositories } from '@ctc/shared/repositories';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Handler } from '../jobs/index.ts';
import { rebuildProject, type Embed, type GraphConfig, type Log, type RebuildCache, type RebuildResult } from './rebuild.ts';

export type GraphDeps = { repos: Repositories; config: GraphConfig; cache?: RebuildCache; embed?: Embed; log?: Log; grammars?: Grammars };
type Payload = { userId: string; projectId: string; force?: boolean; files?: string[] };
type HandlerCtx = { jobId: string; signal: AbortSignal };

const MAX_NAMES = 10;
const MAX_TEXT = 1000;

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    const done = (): void => { clearTimeout(t); signal.removeEventListener('abort', onAbort); };
    const onAbort = (): void => { done(); reject(signal.reason ?? new DOMException('aborted', 'AbortError')); };
    const t = setTimeout(() => { done(); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

/** `<prefix>: a, b, … (+N more)`, at most 10 names and 1000 characters. */
function listText(prefix: string, names: string[], total: number): string {
  const shown = names.slice(0, MAX_NAMES);
  const more = total - shown.length;
  return `${prefix}: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`.slice(0, MAX_TEXT);
}

export function graphHandlers(deps: GraphDeps): { 'graph.rebuild': Handler } {
  const rebuild = async (payload: Payload, hctx: HandlerCtx): Promise<RebuildResult> => {
    const { repos, config } = deps; // read at call time
    if (config.mode !== 'local' || payload.userId !== 'local') throw new JobDropped('rebuild_not_local');
    const user = { userId: payload.userId };
    const project = await repos.projects.get(user, payload.projectId);
    if (!project) throw new JobDropped('project_not_found');
    const isDir = path.isAbsolute(project.root) && (await fs.stat(project.root).then((s) => s.isDirectory(), () => false));
    if (!isDir) throw new JobDropped('root_missing');

    if (payload.files !== undefined && payload.force !== true) {
      const job = await repos.jobs.get(user, hctx.jobId);
      const window = config.graph.debounce_s * 1000;
      const wait = job ? Math.min(job.createdAt.getTime() + window - Date.now(), window) : 0;
      if (wait > 0) await sleep(wait, hctx.signal);
    }

    let grammars = deps.grammars;
    if (!grammars) {
      try {
        grammars = await loadGrammars();
      } catch (e) {
        if (e instanceof GrammarError) throw new JobDropped('grammar_missing');
        throw e;
      }
    }
    const result = await rebuildProject({
      repos, ctx: { userId: payload.userId, projectId: payload.projectId }, root: project.root, config, grammars, signal: hctx.signal,
      ...(payload.files ? { files: payload.files } : {}), ...(payload.force !== undefined ? { force: payload.force } : {}),
      ...(deps.cache ? { cache: deps.cache } : {}), ...(deps.embed ? { embed: deps.embed } : {}), ...(deps.log ? { log: deps.log } : {}),
    });
    if (result.counts.refused > 0) throw new JobDropped(listText('shrink_guard', result.files.refused, result.counts.refused));
    if (result.counts.failed > 0) {
      throw new Error(listText('extract_failed', result.files.failed.map((f) => `${f.file} (${f.code})`), result.counts.failed));
    }
    return result;
  };
  return { 'graph.rebuild': rebuild };
}
