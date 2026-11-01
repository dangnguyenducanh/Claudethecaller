/**
 * The `llm.extract` and `llm.summarize` handlers: the user's own words of a session become facts written through the bands
 * (NOOP / UPDATE / SUPERSEDE / ADD) into `memories`; the whole session becomes 6 summary fields in `session_summaries`.
 * Called from: apps/worker main, bound into `startWorkers({ handlers })` (apps/worker/src/jobs/index.ts). Jobs come from the spool drain
 * (apps/web/src/spool, T4.1) and later from `memory.distill` (T4.3). Why: spec:513-523, so the next session starts with what the user said.
 * Deliberately NOT done: the worker main and config wiring, recall, embedding backfill (`memory.import`, `memory.distill` and the file watch live in jobs.ts and watch.ts, re-exported at the end).
 * Untrusted: the job payload (shape checked by runAttempt, meaning checked here), the transcript path and every byte of the file, every model reply.
 * Never: writes the transcript, logs user or model text, builds a fact from assistant text, hard-deletes a memory.
 */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyBands, bandPorts, extractInput, extractMessages, isRunnerSession, memoryLimits, parseExtractReply, parseSummaryReply,
  EXTRACT_SCHEMA, SUMMARY_SCHEMA, sessionText, summaryHash, summaryMessages, userTurns,
  type Action, type ChatMessage,
} from '@ctc/core/memory';
import { GLOBAL_MEM_EPOCH } from '@ctc/shared/cache';
import type { Chat, Embed } from '@ctc/shared/models';
import { JobDropped } from '@ctc/shared/queues';
import type { Ctx, Repositories } from '@ctc/shared/repositories';
import type { Handler } from '../jobs/index.ts';

export type MemoryDeps = {
  repos: Repositories;
  config: { claude_home: string; memory: { bands: { noop: number; update: number } } };
  embed: Embed;
  chat: Chat;
  cache?: { epoch: { rotate(kind: 'mem', userId: string, projectId: string): Promise<string | null> } };
  log?: (message: string, fields?: Record<string, unknown>) => void;
  today?: () => string;
};

type JobCtx = { jobId: string; signal: AbortSignal };
type ExtractPayload = { userId: string; projectId?: string; sessionId: string; transcriptPath?: string };
type SummarizePayload = { userId: string; projectId?: string; sessionId: string };
type Parsed<T> = ({ ok: true } & T) | { ok: false; reason: string };

const errClass = (e: unknown): string => (e instanceof Error ? e.constructor.name : typeof e);

export function memoryHandlers(deps: MemoryDeps): { 'llm.extract': Handler; 'llm.summarize': Handler } {
  const { repos, embed, chat, cache, log } = deps;
  const today = deps.today ?? ((): string => new Date().toISOString().slice(0, 10));

  /** D13 step 1: the path must resolve to a regular `.jsonl` file under `<claude_home>/projects`. Read-only, tail-limited, never follows a swap. */
  async function readTranscript(p: unknown): Promise<string> {
    if (typeof p !== 'string' || p === '') throw new JobDropped('no_transcript');
    if (!path.isAbsolute(p) || !p.endsWith('.jsonl')) throw new JobDropped('transcript_outside');
    const home = deps.config.claude_home.replace(/^~(?=$|\/)/, os.homedir());
    let real: string;
    try {
      real = await fs.realpath(p);
    } catch (e) {
      throw new JobDropped((e as { code?: string } | null)?.code === 'ENOENT' ? 'no_transcript' : 'transcript_outside');
    }
    let handle: fs.FileHandle | undefined;
    try {
      const root = await fs.realpath(path.join(home, 'projects'));
      if (!real.startsWith(root + path.sep) || !(await fs.lstat(real)).isFile()) throw new JobDropped('transcript_outside');
      handle = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
      const st = await handle.stat();
      if (!st.isFile()) throw new JobDropped('transcript_outside');
      const max = memoryLimits.maxTranscriptBytes;
      const start = Math.max(0, st.size - max);
      const buf = Buffer.alloc(Math.min(st.size, max));
      const { bytesRead } = await handle.read(buf, 0, buf.length, start);
      let text = buf.subarray(0, bytesRead).toString('utf8');
      if (start > 0) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : ''; // the first line is partial
      return text;
    } catch (e) {
      if (e instanceof JobDropped) throw e;
      throw new JobDropped('transcript_outside'); // judgment: any other failure on a path that exists is refused, not retried
    } finally {
      await handle?.close();
    }
  }

  /** One chat call, parsed; an invalid reply gets one fresh request that states why (temperature 0.2), then the job is dropped. */
  async function askTwice<T extends object>(
    make: (retry?: string) => ChatMessage[],
    schema: object,
    parse: (raw: string) => Parsed<T>,
    signal: AbortSignal,
  ): Promise<{ ok: true } & T> {
    const first = parse(await chat({ messages: make(), schema, temperature: 0 }, signal));
    if (first.ok) return first;
    const second = parse(await chat({ messages: make(first.reason), schema, temperature: 0.2 }, signal));
    if (second.ok) return second;
    throw new JobDropped('bad_reply');
  }

  async function rotate(userId: string, projectId: string | undefined, jobId: string): Promise<void> {
    if (!cache || !projectId) return;
    try {
      if ((await cache.epoch.rotate('mem', userId, projectId)) === null) log?.('mem epoch not rotated', { jobId });
    } catch (e) {
      log?.('mem epoch rotate failed', { jobId, error: errClass(e) }); // judgment: a cache failure never fails a stored job
    }
  }

  const extract = async (payload: ExtractPayload, job: JobCtx): Promise<unknown> => {
    const { userId, sessionId, projectId } = payload;
    const ctx: Ctx = projectId ? { userId, projectId } : { userId };
    const session = await repos.sessions.get({ userId }, sessionId);
    const transcriptPath = payload.transcriptPath ?? session?.transcriptPath;
    const jsonl = await readTranscript(transcriptPath);
    if (isRunnerSession(jsonl)) throw new JobDropped('runner_session');
    const turns = userTurns(jsonl);
    // every Stop enqueues an extract: only the user turns after the last one read are sent to the model (a shorter transcript was rewritten, so it starts over)
    const seen = session !== null && session.extractedTurns <= turns.length ? session.extractedTurns : 0;
    const input = extractInput(turns.slice(seen));
    if (input === '') return { skipped: seen > 0 && seen === turns.length ? 'no_new_turns' : 'no_words' };

    const reply = await askTwice(
      (retry) => extractMessages(input, retry === undefined ? undefined : { retry }),
      EXTRACT_SCHEMA,
      (raw) => parseExtractReply(raw, { hasProject: Boolean(projectId) }),
      job.signal,
    );
    const ports = bandPorts({ memory: repos.memory, embed, chat, today }, ctx, { source: { type: 'session', sessionId, transcriptPath }, signal: job.signal });
    const counts: Record<Action, number> = { NOOP: 0, UPDATE: 0, SUPERSEDE: 0, ADD: 0 };
    let globalChanged = false;
    for (const fact of reply.facts) {
      job.signal.throwIfAborted();
      const { action } = await applyBands(ports, fact, deps.config.memory.bands);
      counts[action]++;
      if (fact.scope === 'global' && action !== 'NOOP') globalChanged = true;
    }
    if (session !== null) await repos.sessions.setExtractedTurns({ userId }, sessionId, turns.length);
    if (reply.facts.length > 0) await rotate(userId, projectId, job.jobId);
    if (globalChanged) await rotate(userId, GLOBAL_MEM_EPOCH, job.jobId);
    const result = { facts: reply.total, noop: counts.NOOP, update: counts.UPDATE, supersede: counts.SUPERSEDE, add: counts.ADD, skipped: reply.skipped };
    log?.('extract done', { jobId: job.jobId, ...result });
    return result;
  };

  const summarize = async (payload: SummarizePayload, job: JobCtx): Promise<unknown> => {
    const { userId, sessionId } = payload;
    const session = await repos.sessions.get({ userId }, sessionId);
    if (!session) throw new JobDropped('no_session');
    if (!session.projectId) throw new JobDropped('no_project');
    const projectId = session.projectId; // the row is the truth; the payload came from a spool file
    if (payload.projectId !== undefined && payload.projectId !== projectId) log?.('summarize payload project ignored', { jobId: job.jobId });
    const ctx: Ctx = { userId, projectId };
    const jsonl = await readTranscript(session.transcriptPath);
    if (isRunnerSession(jsonl)) throw new JobDropped('runner_session');
    const text = sessionText(jsonl);
    if (text === '') return { skipped: 'empty' };
    // a session that ended again with more content gets a new summary; the same content is a no-op without a model call
    const contentHash = summaryHash(sessionId, text);
    if ((await repos.memory.getSummary(ctx, sessionId))?.contentHash === contentHash) return { skipped: 'exists' };

    const reply = await askTwice(
      (retry) => summaryMessages(text, retry === undefined ? undefined : { retry }),
      SUMMARY_SCHEMA,
      parseSummaryReply,
      job.signal,
    );
    job.signal.throwIfAborted();
    const inserted = await repos.memory.insertSummary(ctx, { sessionId, contentHash, ...reply.summary });
    if (inserted) await rotate(userId, projectId, job.jobId);
    log?.('summarize done', { jobId: job.jobId, inserted });
    return { inserted };
  };

  return { 'llm.extract': extract, 'llm.summarize': summarize };
}

export { memoryJobHandlers, type MemoryJobDeps } from './jobs.ts';
export { watchMemoryFiles } from './watch.ts';
