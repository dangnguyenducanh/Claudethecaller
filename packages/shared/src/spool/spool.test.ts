import { describe, expect, it } from 'vitest';
import { EDIT_TOOLS, SpoolFileSchema, spoolFieldLimits } from './index.ts';

const file = (event: string, payload: unknown, extra: Record<string, unknown> = {}) => ({ v: 1, event, received_at: '2026-10-31T09:15:02Z', payload, ...extra });
const firstIssue = (x: unknown) => {
  const r = SpoolFileSchema.safeParse(x);
  return r.success ? undefined : r.error.issues[0]?.path.join('.');
};
const ok = (x: unknown) => SpoolFileSchema.safeParse(x).success;

describe('D9 spool schema', () => {
  it('pins the exported constants', () => {
    expect([...EDIT_TOOLS]).toEqual(['Edit', 'Write', 'MultiEdit']);
    expect({ ...spoolFieldLimits }).toEqual({ event: 32, sessionId: 256, toolName: 128, path: 4096 });
  });
  it('D4 session_id of 256 chars is kept, 257 counts as absent', () => {
    const sid = (n: number) => SpoolFileSchema.parse(file('Stop', { session_id: 's'.repeat(n) })).payload.session_id;
    expect([sid(256)?.length, sid(257), sid(0)]).toEqual([256, undefined, undefined]);
  });
  it('D4 file_path and cwd of 4096 chars are kept, 4097 count as absent', () => {
    const p = (n: number) => SpoolFileSchema.parse(file('PostToolUse', { cwd: 'c'.repeat(n), tool_input: { file_path: 'f'.repeat(n) } })).payload;
    expect([p(4096).cwd?.length, p(4096).tool_input?.file_path?.length]).toEqual([4096, 4096]);
    expect([p(4097).cwd, p(4097).tool_input?.file_path]).toEqual([undefined, undefined]);
  });
  it('D4 accepts a Stop with a session id, ignores unknown keys at both levels', () => {
    expect(ok(file('Stop', { session_id: 's', anything: [1] }, { extra: true }))).toBe(true);
  });
  it('D4 rejects a wrong envelope: v, event, received_at, payload', () => {
    expect([firstIssue(file('Stop', {}, { v: 2 })), firstIssue(file('Stop', {}, { v: '1' }))]).toEqual(['v', 'v']);
    expect(firstIssue(file('', {}))).toBe('event');
    expect(firstIssue(file('Stop', { session_id: 's' }, { received_at: 'yesterday' }))).toBe('received_at');
    expect(ok(file('Stop', {}))).toBe(true);
    expect([firstIssue(file('Stop', [1])), firstIssue(file('Stop', null)), firstIssue(file('Stop', 'x'))]).toEqual(['payload', 'payload', 'payload']);
  });
  it('D2 event length: 32 valid, 33 invalid', () => {
    expect(ok(file('E'.repeat(32), {}))).toBe(true);
    expect(ok(file('E'.repeat(33), {}))).toBe(false);
  });
  it('D4 payload fields of the wrong type or length count as absent (the drain decides what is required)', () => {
    const r = SpoolFileSchema.safeParse(file('Stop', { session_id: 's', cwd: 5, transcript_path: ['x'], tool_name: 'T'.repeat(129) }));
    expect(r.success && r.data.payload).toEqual(expect.objectContaining({ session_id: 's' }));
    expect(r.success && [r.data.payload.cwd, r.data.payload.transcript_path, r.data.payload.tool_name]).toEqual([undefined, undefined, undefined]);
  });
  it('D4 a string holding U+0000 or a lone surrogate counts as the wrong type', () => {
    const r = SpoolFileSchema.parse(file('Stop', { session_id: 'a\u0000b', cwd: '\ud800', transcript_path: 't', tool_input: { file_path: 'x\u0000' } }));
    expect([r.payload.session_id, r.payload.cwd, r.payload.transcript_path, r.payload.tool_input?.file_path]).toEqual([undefined, undefined, 't', undefined]);
    expect(ok(file('Stop\u0000', {}))).toBe(false);
  });
});
