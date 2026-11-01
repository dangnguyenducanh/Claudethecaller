import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryLimits } from '@ctc/core/memory';
import { ModelError } from '@ctc/shared/models';
import { JobDropped } from '@ctc/shared/queues';
import { FIXTURE, fakeChat, handlersFor, jobCtx, reply, say, scratch, seedSession, tempHome, toJsonl, txt, type Scratch } from './testing.ts';

let s: Scratch;
const t = tempHome();
beforeAll(async () => void (s = await scratch()), 60_000);
afterAll(async () => {
  t.remove();
  await s?.drop();
});

const fixtureRows = () => fs.readFileSync(path.join(FIXTURE, 'session-a.jsonl'), 'utf8').split('\n').filter((l) => l !== '' && !l.endsWith('half'));
const seed = (tag: string, rows: unknown[] = fixtureRows(), tail = '{"type":"user","message":{"content":"half') => seedSession(s.repos, t.projDir, tag, rows, tail);
const live = async (ctx: { userId: string; projectId?: string }) => (await s.repos.memory.list(ctx)).rows;
const dropCode = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(JobDropped); expect((e as JobDropped).message).toBe(`dropped:${(e as JobDropped).code}`); return (e as JobDropped).code; }
  return 'resolved';
};
/** Forgets what the extract has read, so the next call reads the whole transcript again. */
const rewind = (x: { userId: string; sessionId: string }) => s.repos.sessions.setExtractedTurns({ userId: x.userId }, x.sessionId, 0);
const payload = (x: Awaited<ReturnType<typeof seed>>) => ({ userId: x.userId, projectId: x.projectId, sessionId: x.sessionId, transcriptPath: x.transcriptPath });

describe('llm.extract and llm.summarize (D0, D3, D13, D14)', () => {
  it('binds both handlers; extract writes a memory with its source, summarize a summary with the input hash', async () => {
    const x = await seed('d0');
    const h = handlersFor(s.repos, t.home, { chat: fakeChat({ extract: [reply(['convention', 'project', 'always use pnpm in this repo'])] }).chat });
    expect(Object.keys(h).sort()).toEqual(['llm.extract', 'llm.summarize']);
    expect(await h['llm.extract'](payload(x) as never, jobCtx())).toEqual({ facts: 1, noop: 0, update: 0, supersede: 0, add: 1, skipped: 0 });
    const rows = await live(x.ctx);
    expect(rows.map((r) => r.text)).toEqual(['always use pnpm in this repo']);
    expect(rows[0]?.source).toEqual({ type: 'session', sessionId: x.sessionId, transcriptPath: x.transcriptPath });
    expect(await h['llm.summarize']({ userId: x.userId, sessionId: x.sessionId } as never, jobCtx())).toEqual({ inserted: true });
    const sum = await s.repos.memory.getSummary(x.ctx, x.sessionId);
    expect(sum).toMatchObject({ request: 'add retry', nextSteps: 'wire main', projectId: x.projectId });
  });
  it('counts a duplicate fact as noop and a bad kind as skipped', async () => {
    const x = await seed('d3');
    const h = handlersFor(s.repos, t.home, { chat: fakeChat({ extract: [reply(['fact', 'global', 'the build uses vitest four'], ['fact', 'global', 'the build uses vitest four'], ['nope', 'global', 'bad kind'])] }).chat });
    expect(await h['llm.extract'](payload(x) as never, jobCtx())).toEqual({ facts: 3, noop: 1, update: 0, supersede: 0, add: 1, skipped: 1 });
    expect(await live(x.ctx)).toHaveLength(1);
  });
  it('resolves no_words without a model call when there are no user words', async () => {
    const x = await seed('nw', [say('assistant', [txt('only me')]), say('user', '<system-reminder>only harness</system-reminder>')], '');
    const { chat, calls } = fakeChat();
    expect(await handlersFor(s.repos, t.home, { chat })['llm.extract'](payload(x) as never, jobCtx())).toEqual({ skipped: 'no_words' });
    expect(calls).toHaveLength(0);
  });
  it('takes the path from the sessions row and accepts memories: []', async () => {
    const x = await seed('d5');
    const h = handlersFor(s.repos, t.home, { chat: fakeChat({ extract: [reply()] }).chat });
    expect(await h['llm.extract']({ userId: x.userId, sessionId: x.sessionId } as never, jobCtx())).toEqual({ facts: 0, noop: 0, update: 0, supersede: 0, add: 0, skipped: 0 });
  });
  it('meets the same fact differing in case and spacing as one row', async () => {
    const x = await seed('d5b');
    const h = handlersFor(s.repos, t.home, { chat: fakeChat({ extract: [reply(['fact', 'global', 'Tabs Not Spaces'], ['fact', 'global', 'tabs   not spaces'])] }).chat });
    expect(await h['llm.extract'](payload(x) as never, jobCtx())).toMatchObject({ add: 1, noop: 1 });
    expect(await live(x.ctx)).toHaveLength(1);
  });
  it('retries an invalid reply once with a fresh prompt at temperature 0.2, without echoing the bad reply', async () => {
    const x = await seed('d13');
    const a = fakeChat({ extract: ['{"oops"', reply(['fact', 'project', 'the api runs on fastify five'])] });
    const rot: unknown[][] = [];
    const cache = { epoch: { rotate: async (...args: unknown[]) => (rot.push(args), 'tok') } };
    expect(await handlersFor(s.repos, t.home, { chat: a.chat, cache: cache as never })['llm.extract'](payload(x) as never, jobCtx())).toMatchObject({ add: 1 });
    expect(a.calls.map((c) => c.req.temperature)).toEqual([0, 0.2]);
    expect(a.calls[1]?.req.messages).not.toEqual(a.calls[0]?.req.messages);
    expect(JSON.stringify(a.calls[1]?.req.messages)).not.toContain('{"oops"');
    expect(rot).toEqual([['mem', x.userId, x.projectId]]);
  });
  it('drops with bad_reply after exactly one retry', async () => {
    const x = await seed('d13b');
    const b = fakeChat({ extract: ['nope', 'still nope', reply(['fact', 'global', 'never reached'])] });
    expect(await dropCode(handlersFor(s.repos, t.home, { chat: b.chat })['llm.extract'](payload(x) as never, jobCtx()))).toBe('bad_reply');
    expect(b.calls).toHaveLength(2);
    expect(await live(x.ctx)).toHaveLength(0);
  });
  it('rotates only after a write and ignores a rotate failure', async () => {
    const x = await seed('d13c');
    const rot: unknown[][] = [];
    const cache = { epoch: { rotate: async (...args: unknown[]) => (rot.push(args), 'tok') } };
    await handlersFor(s.repos, t.home, { chat: fakeChat({ extract: [reply()] }).chat, cache: cache as never })['llm.extract'](payload(x) as never, jobCtx());
    expect(rot).toHaveLength(0);
    await rewind(x);
    const thrower = { epoch: { rotate: async () => { throw new Error('redis down'); } } };
    const logs: string[] = [];
    const r = await handlersFor(s.repos, t.home, {
      chat: fakeChat({ extract: [reply(['fact', 'global', 'rotate may fail'])] }).chat, cache: thrower as never, log: (m, f) => logs.push(JSON.stringify([m, f])),
    })['llm.extract'](payload(x) as never, jobCtx());
    expect(r).toMatchObject({ add: 1 });
    expect(logs.join()).toContain('Error');
  });
  it('sends the model only the user turns after the last extract', async () => {
    const x = await seed('cursor', [say('user', 'OLDWORDS first turn')], '');
    const { chat, calls } = fakeChat({ extract: [reply()] });
    const h = handlersFor(s.repos, t.home, { chat });
    await h['llm.extract'](payload(x) as never, jobCtx());
    expect(await h['llm.extract'](payload(x) as never, jobCtx())).toEqual({ skipped: 'no_new_turns' });
    fs.appendFileSync(x.transcriptPath, `${JSON.stringify(say('user', 'NEWWORDS second turn'))}\n`);
    await h['llm.extract'](payload(x) as never, jobCtx());
    const sent = calls.map((c) => JSON.stringify(c.req.messages));
    expect(sent).toHaveLength(2);
    expect([sent[1]?.includes('NEWWORDS'), sent[1]?.includes('OLDWORDS')]).toEqual([true, false]);
  });
  it('drops with no_transcript for a missing session row or file', async () => {
    const x = await seed('nt');
    const h = handlersFor(s.repos, t.home);
    expect(await dropCode(h['llm.extract']({ userId: x.userId, sessionId: 'nosuch' } as never, jobCtx()))).toBe('no_transcript');
    expect(await dropCode(h['llm.extract']({ ...payload(x), transcriptPath: path.join(t.projDir, 'none.jsonl') } as never, jobCtx()))).toBe('no_transcript');
  });
  it('lets a ModelError out of the handler and does not drop', async () => {
    const x = await seed('d4');
    const boom = async () => { throw new ModelError('unavailable', 'down'); };
    await expect(handlersFor(s.repos, t.home, { chat: boom })['llm.extract'](payload(x) as never, jobCtx())).rejects.toBeInstanceOf(ModelError);
  });
  it('stops before the next write when the job is aborted', async () => {
    const x = await seed('abort');
    const ac = new AbortController();
    const chat = fakeChat({ extract: [reply(['fact', 'global', 'one'], ['fact', 'global', 'two'])] }).chat;
    const embed = async (texts: string[]) => { ac.abort(); return texts.map(() => Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0))); };
    await expect(handlersFor(s.repos, t.home, { chat, embed })['llm.extract'](payload(x) as never, { ...jobCtx(), signal: ac.signal })).rejects.toThrow();
    expect(await live(x.ctx)).toHaveLength(1);
  });
});

describe('untrusted input (D1, D6)', () => {
  it('refuses a path outside claude_home/projects, a symlink out, a non-jsonl and a relative path, with no model call', async () => {
    const x = await seed('d1');
    const { chat, calls } = fakeChat({ extract: [reply()] });
    const h = handlersFor(s.repos, t.home, { chat });
    const outside = path.join(t.otherDir, 's.jsonl');
    fs.writeFileSync(outside, toJsonl(fixtureRows()));
    const link = path.join(t.projDir, 'link.jsonl');
    fs.symlinkSync(outside, link);
    const txtFile = path.join(t.projDir, 'x.txt');
    fs.writeFileSync(txtFile, toJsonl(fixtureRows()));
    for (const p of ['/etc/passwd', outside, link, txtFile, 'projects/-x-proj/a.jsonl']) {
      expect(await dropCode(h['llm.extract']({ ...payload(x), transcriptPath: p } as never, jobCtx()))).toBe('transcript_outside');
    }
    expect(calls).toHaveLength(0);
  });
  it('sends only the user\'s own words to the model', async () => {
    const x = await seed('d1b');
    const { chat, calls } = fakeChat({ extract: [reply()] });
    await handlersFor(s.repos, t.home, { chat })['llm.extract'](payload(x) as never, jobCtx());
    const sent = JSON.stringify(calls.map((c) => c.req.messages));
    for (const bad of ['README', 'curl x', 'HUNTER2', 'tool output', 'subagent', 'harness noise', 'local command output']) expect(sent).not.toContain(bad);
    expect(sent).toContain('prefer small diffs');
  });
  it('reads only the tail of a transcript bigger than maxTranscriptBytes', async () => {
    const x = await seed('d2', [say('user', `EARLYFACT ${'p'.repeat(300)}`), say('user', 'LATEFACT')], '');
    const size = fs.statSync(x.transcriptPath).size;
    const saved = memoryLimits.maxTranscriptBytes;
    try {
      for (const [max, early] of [[150, false], [size, true]] as const) {
        memoryLimits.maxTranscriptBytes = max;
        await rewind(x);
        const { chat, calls } = fakeChat({ extract: [reply()] });
        await handlersFor(s.repos, t.home, { chat })['llm.extract'](payload(x) as never, jobCtx());
        const sent = JSON.stringify(calls.map((c) => c.req.messages));
        expect(sent.includes('EARLYFACT')).toBe(early);
        expect(sent).toContain('LATEFACT');
      }
    } finally { memoryLimits.maxTranscriptBytes = saved; }
  });
  it('leaves the transcript unchanged, the payload unedited, no text in logs, and today once in reinforcement_dates', async () => {
    const x = await seed('d6');
    const before = fs.readFileSync(x.transcriptPath);
    const logs: string[] = [];
    const h = handlersFor(s.repos, t.home, { chat: fakeChat({ extract: [reply(['preference', 'global', 'SECRETFACT keep commits small'])] }).chat, log: (m, f) => logs.push(JSON.stringify([m, f ?? null])) });
    const p = Object.freeze(payload(x));
    await h['llm.extract'](p as never, jobCtx());
    await rewind(x);
    await h['llm.extract'](p as never, jobCtx());
    await h['llm.summarize'](Object.freeze({ userId: x.userId, sessionId: x.sessionId }) as never, jobCtx());
    expect(fs.readFileSync(x.transcriptPath).equals(before)).toBe(true);
    for (const l of logs) for (const bad of ['SECRETFACT', 'always use pnpm', 'add retry', 'wire main']) expect(l).not.toContain(bad);
    const rows = await live(x.ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reinforcementDates).toHaveLength(1);
  });
  it('drops runner sessions in both handlers before any model call', async () => {
    const x = await seed('d11', fs.readFileSync(path.join(FIXTURE, 'session-runner.jsonl'), 'utf8').split('\n').filter(Boolean), '');
    const { chat, calls } = fakeChat();
    const h = handlersFor(s.repos, t.home, { chat });
    expect(await dropCode(h['llm.extract'](payload(x) as never, jobCtx()))).toBe('runner_session');
    expect(await dropCode(h['llm.summarize']({ userId: x.userId, sessionId: x.sessionId } as never, jobCtx()))).toBe('runner_session');
    expect(calls).toHaveLength(0);
  });
});

describe('llm.summarize flow (D14, D7)', () => {
  it('drops with no_session for an unknown session', async () => {
    expect(await dropCode(handlersFor(s.repos, t.home)['llm.summarize']({ userId: 'u_x', sessionId: 'nosuch' } as never, jobCtx()))).toBe('no_session');
  });
  it('retries once with temperature 0.2 then drops with bad_reply', async () => {
    const x = await seed('d14');
    const b = fakeChat({ summary: ['{', '[]', '{"request":"x"}'] });
    expect(await dropCode(handlersFor(s.repos, t.home, { chat: b.chat })['llm.summarize']({ userId: x.userId, sessionId: x.sessionId } as never, jobCtx()))).toBe('bad_reply');
    expect(b.calls.map((c) => c.req.temperature)).toEqual([0, 0.2]);
  });
  it('takes the project from the sessions row, rotates after the insert and keeps its first summary', async () => {
    const x = await seed('d14b');
    const rot: unknown[][] = [];
    const cache = { epoch: { rotate: async (...args: unknown[]) => (rot.push(args), 'tok') } };
    const a = fakeChat({ summary: ['{', JSON.stringify({ request: 'r1', investigated: 'i1', learned: 'l1', completed: 'c1', next_steps: 'n1', notes: 'o1' })] });
    const h = handlersFor(s.repos, t.home, { chat: a.chat, cache: cache as never });
    expect(await h['llm.summarize']({ userId: x.userId, projectId: 'ignored-other', sessionId: x.sessionId } as never, jobCtx())).toEqual({ inserted: true });
    const row = await s.repos.memory.getSummary(x.ctx, x.sessionId);
    expect([row?.projectId, row?.request, row?.investigated, row?.learned, row?.completed, row?.nextSteps, row?.notes]).toEqual([x.projectId, 'r1', 'i1', 'l1', 'c1', 'n1', 'o1']);
    expect(rot).toEqual([['mem', x.userId, x.projectId]]);
    const n = a.calls.length;
    expect(await h['llm.summarize']({ userId: x.userId, sessionId: x.sessionId } as never, jobCtx())).toEqual({ skipped: 'exists' });
    expect(a.calls).toHaveLength(n);
  });
  it('resolves empty for a session without text', async () => {
    const x = await seed('d14e', [say('system', 'x')], '');
    expect(await handlersFor(s.repos, t.home)['llm.summarize']({ userId: x.userId, sessionId: x.sessionId } as never, jobCtx())).toEqual({ skipped: 'empty' });
  });
});
