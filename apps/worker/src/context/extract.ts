/**
 * The `graph.extract` job: asks `claude -p --model haiku` for the `implements` / `decides` edges the parsers cannot see and stores them INFERRED with origin `claude`.
 *
 * Called from: apps/worker main (bound into `startWorkers({ handlers })`); jobs are submitted by `contextPass`. Why it exists: spec:284, spec:355, DECISIONS D15.
 * Deliberately NOT done: SQL (repos only), writing under the root, replacing a parser edge, reading env vars (the binary comes through `spawnClaude({ bin })`), a timer on the queue (spec:196).
 * Untrusted: document text (sanitized before it is sent), the model reply (validated by `parseExtractReply`), the stored rows.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { buildExtractPrompt, isContextPath, parseContext, parseExtractReply, resolveRefs } from '@ctc/core/context';
import { JobDropped } from '@ctc/shared/queues';
import type { Repositories } from '@ctc/shared/repositories';
import type { Handler } from '../jobs/index.ts';
import type { Log, RebuildCache } from '../graph/rebuild.ts';
import { readText } from '../graph/rebuild.ts';
import { safeRel } from '../graph/walk.ts';
import { announceWrite } from './epoch.ts';
import { contextWorkerLimits } from './limits.ts';

export type RunClaude = (o: { prompt: string; signal: AbortSignal }) => Promise<string>;
export type ExtractDeps = { repos: Repositories; config: { mode: string }; runClaude: RunClaude; cache?: RebuildCache; log?: Log };
type Payload = { userId: string; projectId: string; files: string[] };
type HandlerCtx = Parameters<Handler>[1];
export type ExtractResult = {
  counts: { requested: number; extracted: number; edges: number; skipped: number; failed: number };
  files: { extracted: { file: string; edges: number }[]; skipped: { file: string; reason: string }[]; failed: { file: string; code: string }[] };
};

const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const noop = (): void => undefined;
const MAX_NAMES = 10;
const cut = <T>(l: T[]): T[] => l.slice(0, contextWorkerLimits.resultListMax);

/**
 * Runs `<bin> -p --model <model>` with the prompt on stdin in a fresh empty temp directory (removed afterwards) and returns stdout as UTF-8.
 * A non-zero exit, a timeout, an abort or a reply over `maxChars` kills the process and rejects; a missing binary rejects with `code: 'ENOENT'`. stderr is never read.
 */
export function spawnClaude(o: { bin?: string; model?: string; timeoutMs?: number; maxChars?: number } = {}): RunClaude {
  return async ({ prompt, signal }) => {
    const bin = o.bin ?? 'claude';
    const model = o.model ?? 'haiku';
    const timeoutMs = o.timeoutMs ?? contextWorkerLimits.extractTimeoutMs;
    const maxChars = o.maxChars ?? contextWorkerLimits.extractMaxReplyChars;
    signal.throwIfAborted();
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'ctc-extract-'));
    try {
      return await new Promise<string>((resolve, reject) => {
        const child = spawn(bin, ['-p', '--model', model], { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
        const decoder = new StringDecoder('utf8');
        let out = '';
        let done = false;
        const finish = (err: Error | null, value = ''): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          if (err) {
            child.kill('SIGKILL');
            reject(err);
          } else resolve(value);
        };
        const onAbort = (): void => finish(signal.reason instanceof Error ? signal.reason : new Error('claude run aborted'));
        const timer = setTimeout(() => finish(new Error(`claude timed out after ${timeoutMs} ms`)), timeoutMs);
        signal.addEventListener('abort', onAbort, { once: true });
        child.on('error', (e) => finish(e));
        child.stdin.on('error', () => undefined);
        child.stdout.on('data', (b: Buffer) => {
          out += decoder.write(b);
          if (out.length > maxChars) finish(new Error(`claude reply is longer than ${maxChars} characters`));
        });
        child.on('close', (code) => finish(code === 0 ? null : new Error(`claude exited with code ${code}`), out + decoder.end()));
        child.stdin.end(prompt);
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  };
}

const failText = (failed: { file: string; code: string }[]): string => {
  const shown = failed.slice(0, MAX_NAMES).map((f) => `${f.file} (${f.code})`);
  const more = failed.length - shown.length;
  return `extract_failed: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`.slice(0, 1000);
};

export function extractHandler(deps: ExtractDeps): { 'graph.extract': Handler } {
  const extract = async (payload: Payload, hctx: HandlerCtx): Promise<ExtractResult> => {
    const { repos, config, runClaude } = deps; // read at call time
    const log = deps.log ?? noop;
    if (config.mode !== 'local' || payload.userId !== 'local') throw new JobDropped('extract_not_local');
    const project = await repos.projects.get({ userId: payload.userId }, payload.projectId);
    if (!project) throw new JobDropped('project_not_found');
    const isDir = path.isAbsolute(project.root) && (await fs.stat(project.root).then((s) => s.isDirectory(), () => false));
    if (!isDir) throw new JobDropped('root_missing');
    const rootReal = await fs.realpath(project.root);
    const ctx = { userId: payload.userId, projectId: payload.projectId };

    const requested = [...new Set(payload.files)].sort(byCode);
    const files = requested.slice(0, contextWorkerLimits.maxExtractFiles);
    const skipped: { file: string; reason: string }[] = requested.slice(files.length).map((file) => ({ file, reason: 'over_limit' }));
    const extracted: { file: string; edges: number }[] = [];
    const failed: { file: string; code: string }[] = [];
    let dropped: JobDropped | null = null;
    let wrote = false;
    let failure: unknown;
    const graph = await repos.graph.loadGraph(ctx);
    const nodeFile = new Map(graph.nodes.map((n) => [n.id, n.sourceFile]));
    const refNodes = graph.nodes.map((n) => ({ id: n.id, type: n.type, label: n.label, sourceFile: n.sourceFile }));
    try {
      for (const file of files) {
        hctx.signal.throwIfAborted();
        if (!safeRel(file) || !isContextPath(file)) {
          skipped.push({ file, reason: 'not_context' });
          continue;
        }
        const read = await readText(rootReal, file);
        if (!read.ok) {
          skipped.push({ file, reason: read.reason });
          continue;
        }
        const parse = parseContext({ path: file, content: read.text });
        if (parse.error || !parse.nodes.some((n) => n.type === 'task' || n.type === 'decision')) {
          skipped.push({ file, reason: 'no_context_nodes' });
          continue;
        }
        let reply: string;
        try {
          reply = await runClaude({ prompt: buildExtractPrompt({ file, text: read.text, nodes: parse.nodes }), signal: hctx.signal });
        } catch (e) {
          if (hctx.signal.aborted) throw hctx.signal.reason ?? e;
          if ((e as { code?: unknown } | null)?.code === 'ENOENT') {
            dropped = new JobDropped('claude_not_found');
            break;
          }
          failed.push({ file, code: 'runner_error' });
          continue;
        }
        const parsed = parseExtractReply(reply, { file, nodes: parse.nodes });
        if (!parsed.ok) {
          failed.push({ file, code: parsed.code });
          continue;
        }
        const resolved = resolveRefs(
          parsed.edges.map((e) => ({ from: e.src, relation: e.relation, kind: e.kind, target: e.target, line: 0 })),
          refNodes,
          { inferred: true },
        );
        // a parser edge (or a reviewed one) is never downgraded: only an edge that is new or already a `claude` edge is stored
        const parserHas = new Set(graph.edges.filter((e) => e.origin !== 'claude').map((e) => `${e.src}\0${e.dst}\0${e.relation}`));
        const edges = resolved.filter((e) => !parserHas.has(`${e.src}\0${e.dst}\0${e.relation}`));
        const previous = graph.edges.some((e) => e.origin === 'claude' && nodeFile.get(e.src) === file);
        if (edges.length > 0 || previous) {
          await repos.graph.replaceSource(ctx, {
            origin: 'claude', sourceFile: file, nodes: [],
            edges: edges.map((e) => ({ src: e.src, dst: e.dst, relation: e.relation, confidence: e.confidence, score: e.score, sourceLocation: e.sourceLocation })),
          });
          wrote = true;
        }
        extracted.push({ file, edges: edges.length });
      }
    } catch (e) {
      failure = e;
    }
    if (wrote) await announceWrite({ repos, ctx, cache: deps.cache, log });
    if (failure !== undefined) throw failure;
    if (dropped) throw dropped;
    if (failed.length > 0) throw new Error(failText(failed));
    const sortedSkipped = skipped.sort((a, b) => byCode(a.file, b.file));
    return {
      counts: { requested: requested.length, extracted: extracted.length, edges: extracted.reduce((n, x) => n + x.edges, 0), skipped: sortedSkipped.length, failed: 0 },
      files: { extracted: cut(extracted), skipped: cut(sortedSkipped), failed: [] },
    };
  };
  return { 'graph.extract': extract as unknown as Handler };
}
