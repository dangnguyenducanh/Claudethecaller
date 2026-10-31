/**
 * The `llm.extract` and `llm.summarize` handlers: the user's own words of a session become facts written through the bands
 * (NOOP / UPDATE / SUPERSEDE / ADD) into `memories`; the whole session becomes 6 summary fields in `session_summaries`.
 * Called from: apps/worker main, bound into `startWorkers({ handlers })` (apps/worker/src/jobs/index.ts). Jobs come from the spool drain
 * (apps/web/src/spool, T4.1) and later from `memory.distill` (T4.3). Why: spec:513-523, so the next session starts with what the user said.
 * Deliberately NOT done: the worker main and config wiring, recall, `memory.import`, `memory.distill`, a "since last extract" cursor, embedding backfill.
 * Untrusted: the job payload (shape checked by runAttempt, meaning checked here), the transcript path and every byte of the file, every model reply.
 * Never: writes the transcript, logs user or model text, builds a fact from assistant text, hard-deletes a memory.
 */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyBands, extractInput, extractMessages, isRunnerSession, memoryLimits, parseExtractReply, parseRelationReply, parseSummaryReply,
  relationMessages, RELATION_SCHEMA, EXTRACT_SCHEMA, SUMMARY_SCHEMA, sessionText, summaryHash, summaryMessages, userTurns,
  type Action, type BandPorts, type ChatMessage, type Fact,
} from '@ctc/core/memory';
import { memoryHash } from '@ctc/shared/memory-hash';
import { ModelError, type Chat, type Embed } from '@ctc/shared/models';
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

  function portsFor(ctx: Ctx, source: unknown, signal: AbortSignal): BandPorts {
    const { repos: r } = deps;
    const input = (fact: Fact, embedding: number[]) => ({ scope: fact.scope, kind: fact.kind, text: fact.text, embedding, confidence: fact.confidence, source });
    return {
      embed: async (text) => {
        const [v] = await embed([text], signal);
        if (!v) throw new ModelError('bad_response', 'no vector');
        return v;
      },
      nearest: async (scope, embedding) => {
        const [n] = await r.memory.nearest(ctx, { scope, embedding, limit: 1 });
        return n ? { id: n.memory.id, text: n.memory.text, similarity: n.similarity } : null;
      },
      judge: async (oldText, newText) => {
        try {
          return parseRelationReply(await chat({ messages: relationMessages(oldText, newText), schema: RELATION_SCHEMA, temperature: 0 }, signal));
        } catch (e) {
          if (signal.aborted || !(e instanceof ModelError)) throw e;
          return null; // judgment: no verdict keeps both rows
        }
      },
      reinforce: async (id) => void (await r.memory.reinforce(ctx, id, today())),
      rewrite: async (id, text, embedding) => r.memory.rewrite(ctx, id, { text, embedding, hash: memoryHash(text) }),
      supersede: async (oldId, fact, embedding) => r.memory.supersede(ctx, oldId, input(fact, embedding)),
      add: async (fact, embedding) => r.memory.add(ctx, input(fact, embedding)),
    };
  }

  const extract = async (payload: ExtractPayload, job: JobCtx): Promise<unknown> => {
    const { userId, sessionId, projectId } = payload;
    const ctx: Ctx = projectId ? { userId, projectId } : { userId };
    const transcriptPath = payload.transcriptPath ?? (await repos.sessions.get({ userId }, sessionId))?.transcriptPath;
    const jsonl = await readTranscript(transcriptPath);
    if (isRunnerSession(jsonl)) throw new JobDropped('runner_session');
    const input = extractInput(userTurns(jsonl));
    if (input === '') return { skipped: 'no_words' };

    const reply = await askTwice(
      (retry) => extractMessages(input, retry === undefined ? undefined : { retry }),
      EXTRACT_SCHEMA,
      (raw) => parseExtractReply(raw, { hasProject: Boolean(projectId) }),
      job.signal,
    );
    const ports = portsFor(ctx, { type: 'session', sessionId, transcriptPath }, job.signal);
    const counts: Record<Action, number> = { NOOP: 0, UPDATE: 0, SUPERSEDE: 0, ADD: 0 };
    for (const fact of reply.facts) {
      job.signal.throwIfAborted();
      counts[(await applyBands(ports, fact, deps.config.memory.bands)).action]++;
    }
    if (reply.facts.length > 0) await rotate(userId, projectId, job.jobId);
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
    if (await repos.memory.getSummary(ctx, sessionId)) return { skipped: 'exists' };
    const jsonl = await readTranscript(session.transcriptPath);
    if (isRunnerSession(jsonl)) throw new JobDropped('runner_session');
    const text = sessionText(jsonl);
    if (text === '') return { skipped: 'empty' };

    const reply = await askTwice(
      (retry) => summaryMessages(text, retry === undefined ? undefined : { retry }),
      SUMMARY_SCHEMA,
      parseSummaryReply,
      job.signal,
    );
    job.signal.throwIfAborted();
    const inserted = await repos.memory.insertSummary(ctx, { sessionId, contentHash: summaryHash(sessionId, text), ...reply.summary });
    if (inserted) await rotate(userId, projectId, job.jobId);
    log?.('summarize done', { jobId: job.jobId, inserted });
    return { inserted };
  };

  return { 'llm.extract': extract, 'llm.summarize': summarize };
}
