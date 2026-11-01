/** Test helpers (not exported from index.ts): a throw-away Postgres schema on the scratch server, temp Claude homes, fake embedder and chat. */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { memoryHash } from '@ctc/shared/memory-hash';
import type { Chat, ChatMessage, Embed } from '@ctc/shared/models';
import { createDb, createRepositories, type Repositories } from '@ctc/shared/repositories';
import { migrate } from '@ctc/shared/repositories/admin';
import { memoryHandlers, type MemoryDeps } from './index.ts';

export type Scratch = { repos: Repositories; schema: string; drop(): Promise<void> };

/** Migrates a fresh schema `ctc_t42_<random>`; refuses any URL that is not the scratch Postgres 127.0.0.1:18304. */
export async function scratch(): Promise<Scratch> {
  const url = process.env['CTC_SCRATCH_PG_URL'] ?? '';
  const u = new URL(url);
  if (u.hostname !== '127.0.0.1' || u.port !== '18304') throw new Error(`refusing ${u.hostname}:${u.port}, only the scratch Postgres 127.0.0.1:18304`);
  const schema = `ctc_t42_${randomBytes(4).toString('hex')}`;
  await migrate({ url, schema });
  const db = createDb({ url, schema });
  return {
    repos: createRepositories(db),
    schema,
    async drop() {
      try {
        await db.kysely.schema.dropSchema(schema).ifExists().cascade().execute();
      } finally {
        await db.close();
      }
    },
  };
}

/** A temp `claude_home` with `projects/-x-proj` inside; never the real `~/.claude`. */
export function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t42-'));
  const projDir = path.join(home, 'projects', '-x-proj');
  const otherDir = path.join(home, 'other');
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(otherDir, { recursive: true });
  return { home, projDir, otherDir, remove: () => fs.rmSync(home, { recursive: true, force: true }) };
}

export const say = (type: string, content: unknown, extra: object = {}) => ({ type, message: { role: type, content }, ...extra });
export const txt = (text: string) => ({ type: 'text', text });
export const toJsonl = (rows: unknown[], tail = ''): string => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n' + tail;

/** Deterministic unit vector per memory text: same text gives cosine 1, different texts give cosine near 0. */
export function vecOf(text: string): number[] {
  let seed = parseInt(memoryHash(text).slice(0, 8), 16) >>> 0;
  const v = Array.from({ length: 1024 }, () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 2 ** 32 - 0.5;
  });
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return v.map((x) => x / n);
}

export const fakeEmbed = (map: (text: string) => number[] = vecOf): Embed => async (texts) => texts.map(map);

export type Replies = { extract?: string[] | ((req: ChatReq) => string); relation?: string; summary?: string[] };
export type ChatReq = { messages: ChatMessage[]; schema: object; temperature?: number };
export type Call = { kind: 'extract' | 'relation' | 'summary'; req: ChatReq };

const kindOf = (schema: object): Call['kind'] => {
  const props = (schema as { properties?: object }).properties ?? {};
  return 'memories' in props ? 'extract' : 'relation' in props ? 'relation' : 'summary';
};

export const SUMMARY_REPLY = JSON.stringify({ request: 'add retry', investigated: 'drain', learned: 'ids', completed: 'tests', next_steps: 'wire main', notes: '' });

/** A chat fake: each list is shifted per call (the last entry repeats); every call is recorded. */
export function fakeChat(replies: Replies = {}): { chat: Chat; calls: Call[] } {
  const calls: Call[] = [];
  const chat: Chat = async (req) => {
    const kind = kindOf(req.schema);
    calls.push({ kind, req: JSON.parse(JSON.stringify(req)) as ChatReq });
    if (kind === 'relation') return replies.relation ?? '{"relation":"same"}';
    const r = kind === 'extract' ? replies.extract : replies.summary;
    if (typeof r === 'function') return r(req);
    if (r && r.length > 0) return (r.length > 1 ? r.shift() : r[0]) as string;
    return kind === 'summary' ? SUMMARY_REPLY : '{"memories":[]}';
  };
  return { chat, calls };
}

export const reply = (...facts: [string, string, string, number?][]): string =>
  JSON.stringify({ memories: facts.map(([kind, scope, text, confidence = 0.8]) => ({ kind, scope, text, confidence })) });

export const BANDS = { noop: 0.95, update: 0.85 };
export const jobCtx = () => ({ jobId: `j_${randomBytes(3).toString('hex')}`, attempt: 1, signal: new AbortController().signal, setProgress: async (): Promise<void> => undefined });

/** `memoryHandlers` on the scratch repos with fakes unless overridden. */
export function handlersFor(repos: Repositories, home: string, over: Partial<MemoryDeps> = {}) {
  return memoryHandlers({ repos, config: { claude_home: home, memory: { bands: { ...BANDS } } }, embed: fakeEmbed(), chat: fakeChat().chat, ...over });
}

/** A user with a project, a session and a transcript file under `dir`. */
export async function seedSession(repos: Repositories, dir: string, tag: string, rows: unknown[], tail = '') {
  const rnd = randomBytes(4).toString('hex');
  const userId = `u_${tag}_${rnd}`;
  const project = await repos.projects.upsert({ userId }, { root: `/x/proj-${tag}-${rnd}` });
  const sessionId = `s_${tag}_${rnd}`;
  const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, toJsonl(rows, tail));
  await repos.sessions.upsert({ userId }, { id: sessionId, projectId: project.id, transcriptPath });
  return { userId, projectId: project.id, sessionId, transcriptPath, ctx: { userId, projectId: project.id } };
}

export const FIXTURE = path.join(import.meta.dirname, 'fixtures');
