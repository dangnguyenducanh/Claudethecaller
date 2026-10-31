import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyBands, bandOf, decide, EXTRACT_SCHEMA, extractInput, extractMessages, isRunnerSession, KINDS, memoryLimits, parseExtractReply,
  parseRelationReply, parseSummaryReply, RELATION_SCHEMA, relationMessages, SCOPES, sessionText, SUMMARY_SCHEMA, summaryHash, summaryMessages,
  userTurns, type BandPorts, type Fact,
} from './index.ts';
import bands from './fixtures/bands.json' with { type: 'json' };

const say = (type: string, content: unknown, extra: object = {}) => ({ type, message: { role: type, content }, ...extra });
const jsonl = (rows: unknown[], tail = '') => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n' + tail;
const B = { noop: 0.95, update: 0.85 };
const saved = { ...memoryLimits };
afterEach(() => Object.assign(memoryLimits, saved));
const reply = (...texts: string[]) => JSON.stringify({ memories: texts.map((text) => ({ kind: 'fact', scope: 'global', text, confidence: 0.8 })) });

describe('limits and names (D2, D9)', () => {
  it('pins the defaults and the enums', () => {
    expect({ ...memoryLimits }).toEqual({ maxFacts: 20, maxMemoryChars: 300, maxUserChars: 12000, maxTurnChars: 2000, sessionHeadChars: 6000, sessionTailChars: 18000, maxSummaryFieldChars: 2000, maxTranscriptBytes: 33554432 });
    expect([...KINDS]).toEqual(['preference', 'convention', 'fact', 'skill_outcome']);
    expect([...SCOPES]).toEqual(['global', 'project']);
  });
  it('keeps maxFacts and cuts the 21st; 300 chars is kept and 301 is skipped', () => {
    const r = parseExtractReply(reply(...Array.from({ length: 21 }, (_, i) => `fact ${i}`)), { hasProject: false });
    expect(r).toMatchObject({ ok: true, total: 21, skipped: 1 });
    expect(r.ok && r.facts.length).toBe(20);
    memoryLimits.maxFacts = 2;
    expect(parseExtractReply(reply('a', 'b', 'c'), { hasProject: false })).toMatchObject({ facts: [{ text: 'a' }, { text: 'b' }], skipped: 1 });
    const long = parseExtractReply(reply('x'.repeat(300), 'y'.repeat(301)), { hasProject: false });
    expect(long.ok && long.facts.map((f) => f.text.length)).toEqual([300]);
  });
  it('declares the schemas with the limits', () => {
    expect(EXTRACT_SCHEMA.required).toEqual(['memories']);
    expect(EXTRACT_SCHEMA.properties.memories.maxItems).toBe(20);
    expect([...SUMMARY_SCHEMA.required].sort()).toEqual(['completed', 'investigated', 'learned', 'next_steps', 'notes', 'request']);
    expect(RELATION_SCHEMA.required).toEqual(['relation']);
  });
  it('makes a different request for a retry and never contains the bad reply', () => {
    expect(extractMessages('User: hi', { retry: 'not JSON' })).not.toEqual(extractMessages('User: hi'));
    expect(summaryMessages('t', { retry: 'x' })).not.toEqual(summaryMessages('t'));
    expect(relationMessages('a', 'b')[1]?.content).toContain('a');
  });
});

describe('parsers (D4)', () => {
  it('treats a wrong top-level shape as invalid', () => {
    for (const raw of ['not json', '[]', '{"memories":3}', '', 'null', '{"facts":[]}']) expect(parseExtractReply(raw, { hasProject: true }).ok).toBe(false);
  });
  it('skips bad items and clamps or defaults confidence', () => {
    const r = parseExtractReply(JSON.stringify({ memories: [
      { kind: 'fact', scope: 'global', text: 'a', confidence: 1.7 },
      { kind: 'fact', scope: 'global', text: 'b' },
      { kind: 'fact', scope: 'global', text: 'c', confidence: -2 },
      { kind: 'fact', scope: 'project', text: 'needs a project', confidence: 0.9 },
      { kind: 'fact', scope: 'global', text: '   ' },
      { kind: 'fact', scope: 'global', text: '<private>only secret</private>' },
      { kind: 'fact', scope: 'elsewhere', text: 'bad scope' },
      'not an object',
    ], extra: 1 }), { hasProject: false });
    expect(r.ok && r.facts.map((f) => [f.text, f.confidence])).toEqual([['a', 1], ['b', 0.5], ['c', 0]]);
    expect(r).toMatchObject({ skipped: 5, total: 8 });
  });
  it('keeps a project fact when the job has a project and accepts wrapped whitespace', () => {
    const raw = `  ${JSON.stringify({ memories: [{ kind: 'convention', scope: 'project', text: ' use vitest ', confidence: 1 }] })}\n`;
    expect(parseExtractReply(raw, { hasProject: true })).toMatchObject({ ok: true, facts: [{ scope: 'project', text: 'use vitest' }] });
  });
  it('parses the summary: empty is invalid, fields are trimmed, cut and mapped', () => {
    expect(parseSummaryReply('{"request":"","notes":" "}').ok).toBe(false);
    expect(parseSummaryReply('nope').ok).toBe(false);
    const s = parseSummaryReply(JSON.stringify({ request: ' r ', investigated: 5, learned: 'l'.repeat(2500), next_steps: 'n', other: 'x' }));
    expect(s.ok && { ...s.summary, learned: s.summary.learned.length }).toEqual({ request: 'r', investigated: '', learned: 2000, completed: '', nextSteps: 'n', notes: '' });
  });
  it('parses the relation', () => {
    expect(parseRelationReply('{"relation":"maybe"}')).toBeNull();
    expect(parseRelationReply('x')).toBeNull();
    expect(parseRelationReply('{"relation":"same"}')).toBe('same');
    expect(parseRelationReply('{"relation":"contradicts"}')).toBe('contradicts');
  });
});

describe('transcript rules (D11)', () => {
  it('keeps only the user turns that the user typed', () => {
    const rows = [
      say('user', [{ type: 'text', text: '<system-reminder>N</system-reminder>' }, { type: 'text', text: 'keep logs' }]),
      say('user', 'meta', { isMeta: true }), say('user', 'side', { isSidechain: true }),
      say('user', [{ type: 'tool_result', content: 'out' }]), say('assistant', [{ type: 'text', text: 'hi' }]),
      say('user', '<command-name>/r</command-name><command-args>the auth module</command-args>'),
      say('user', '[Request interrupted by user]'), say('user', 'a <private>S</private> b'), 'not json', say('user', 'ctc: x\nlast'),
    ];
    expect(userTurns(jsonl(rows, '{"type":"user","message":{"content":"half'))).toEqual(['keep logs', 'the auth module', 'a  b', 'last']);
  });
  it('cuts one turn to maxTurnChars', () => {
    memoryLimits.maxTurnChars = 4;
    expect(userTurns(jsonl([say('user', 'abcdefgh')]))).toEqual(['abcd']);
  });
  it('builds the extract window from the newest turns', () => {
    expect(extractInput([])).toBe('');
    expect(extractInput(['a', 'b'])).toBe('User: a\n\nUser: b');
    memoryLimits.maxUserChars = 30;
    expect(extractInput(['aaaa', 'bbbbbbbbbb', 'cccccccccc'])).toBe('User: cccccccccc');
    memoryLimits.maxUserChars = 10;
    expect(extractInput(['aaaa', 'cccccccccc'])).toBe('cccccccccc');
  });
  it('builds the session text with tool lines but without tool results, and cuts head and tail', () => {
    const rows = [
      say('user', 'go'),
      say('assistant', [{ type: 'text', text: 'ok' }, { type: 'tool_use', name: 'Read', input: { file_path: '/a/b' } }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }, { type: 'tool_use', name: 'Odd', input: {} }]),
      say('user', [{ type: 'tool_result', content: 'SECRET OUTPUT' }]),
    ];
    expect(sessionText(jsonl(rows))).toBe('User: go\nAssistant: ok\nTool: Read /a/b\nTool: Bash ls\nTool: Odd');
    memoryLimits.sessionHeadChars = 5;
    memoryLimits.sessionTailChars = 5;
    expect(sessionText(jsonl([say('user', '0123456789ABCDEF')]))).toBe('User:\n[…]\nBCDEF');
    expect(sessionText('')).toBe('');
  });
  it('detects a runner session by cwd', () => {
    expect(isRunnerSession(jsonl([say('user', 'x', { cwd: '/p/.ctc/wt/r1/s1' })]))).toBe(true);
    expect(isRunnerSession(jsonl([say('user', 'the path /.ctc/wt/ in text', { cwd: '/p' })]))).toBe(false);
  });
});

describe('bands (D12)', () => {
  it('puts the edges in the higher band', () => {
    expect([null, 0.5, 0.8499, 0.85, 0.9, 0.9499, 0.95, 1, Number.NaN].map((x) => bandOf(x, B))).toEqual(['add', 'add', 'add', 'mid', 'mid', 'mid', 'noop', 'noop', 'add']);
    expect([decide(0.95, null, B), decide(0.85, 'same', B), decide(0.9, 'contradicts', B), decide(0.9, null, B), decide(0.8499, 'same', B)]).toEqual(['NOOP', 'UPDATE', 'SUPERSEDE', 'ADD', 'ADD']);
  });
  it('labels every fixture pair as decide() does', () => {
    for (const p of bands) expect(decide(p.similarity, p.relation as 'same' | 'contradicts' | null, B)).toBe(p.expect);
  });
  const fact: Fact = { kind: 'fact', scope: 'global', text: 'new text', confidence: 0.5 };
  const run = async (similarity: number | null, relation: 'same' | 'contradicts' | null, over: Partial<BandPorts> = {}) => {
    const calls: string[] = [];
    const rec = <T>(n: string, v: T) => async (): Promise<T> => (calls.push(n), v);
    const ports: BandPorts = {
      embed: rec('embed', [1, 0]),
      nearest: rec('nearest', similarity === null ? null : { id: 'old', text: 'old text', similarity }),
      judge: rec('judge', relation), reinforce: rec('reinforce', undefined), rewrite: rec('rewrite', { id: 'old' }),
      supersede: rec('supersede', { id: 'sup' }), add: rec('add', { id: 'added' }), ...over,
    };
    return { r: await applyBands(ports, fact, B), calls };
  };
  it('calls one port per band and the judge only in the mid band', async () => {
    let x = await run(0.97, 'same');
    expect(x.r).toEqual({ action: 'NOOP', id: 'old' });
    expect(x.calls).toContain('reinforce');
    expect(x.calls).not.toContain('judge');
    x = await run(0.9, 'same');
    expect(x.r).toEqual({ action: 'UPDATE', id: 'old' });
    expect(x.calls.filter((c) => c === 'judge')).toHaveLength(1);
    expect((await run(0.9, 'contradicts')).r).toEqual({ action: 'SUPERSEDE', id: 'sup' });
    expect((await run(0.9, null)).r).toEqual({ action: 'ADD', id: 'added' });
    x = await run(0.5, 'same');
    expect(x.r).toEqual({ action: 'ADD', id: 'added' });
    expect(x.calls).not.toContain('judge');
    expect((await run(null, 'same')).r).toEqual({ action: 'ADD', id: 'added' });
  });
  it('falls back to add when rewrite finds no row or a conflict, and when supersede finds no live row', async () => {
    expect((await run(0.9, 'same', { rewrite: async () => null })).r).toEqual({ action: 'UPDATE', id: 'added' });
    const conflict = Object.assign(new Error('exists'), { code: 'conflict' });
    expect((await run(0.9, 'same', { rewrite: async () => { throw conflict; } })).r).toEqual({ action: 'UPDATE', id: 'added' });
    expect((await run(0.9, 'contradicts', { supersede: async () => null })).r).toEqual({ action: 'SUPERSEDE', id: 'added' });
    await expect(run(0.9, 'same', { rewrite: async () => { throw new Error('db down'); } })).rejects.toThrow('db down');
  });
});

describe('summaryHash (D3)', () => {
  it('hashes the version, the session and the input text', () => {
    expect(summaryHash('s1', 'text')).toBe(createHash('sha256').update('summary-v1\ns1\ntext').digest('hex'));
    expect(summaryHash('s2', 'text')).not.toBe(summaryHash('s1', 'text'));
  });
});

describe('userTurns on hostile input', () => {
  it('handles many unclosed <command-args> in linear time', () => {
    const t = Date.now();
    userTurns(JSON.stringify(say('user', '<command-args>'.repeat(100000))));
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
