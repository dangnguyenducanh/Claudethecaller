import { describe, expect, it } from 'vitest';
import {
  HistoryImportBody, HistoryListQuery, HookStartBody, MemGetArgs, MemSearchArgs, MemTimelineArgs, MemoryListQuery, MemoryPatchBody, SaveMemoryArgs, memoryApiLimits,
} from './index.ts';

const ok = (r: { success: boolean }): boolean => r.success;

describe('memoryApiLimits', () => {
  it('pins the defaults', () => {
    expect(memoryApiLimits).toEqual({
      listDefault: 50, listMax: 500, qMax: 200, cursorMax: 512, textMax: 300, queryMax: 500, searchDefault: 20, searchMax: 50,
      timelineDefault: 3, timelineMax: 10, getMax: 20, cwdMax: 4096, distillMax: 500,
    });
  });
});

describe('schemas', () => {
  it('HookStartBody keeps unknown keys and needs a cwd of 1..cwdMax', () => {
    expect(HookStartBody.parse({ cwd: '/a', session_id: 's' })).toEqual({ cwd: '/a', session_id: 's' });
    expect([{}, { cwd: '' }, { cwd: 3 }, { cwd: 'a'.repeat(memoryApiLimits.cwdMax + 1) }, null].map((b) => ok(HookStartBody.safeParse(b)))).toEqual([false, false, false, false, false]);
    expect(ok(HookStartBody.safeParse({ cwd: 'a'.repeat(memoryApiLimits.cwdMax) }))).toBe(true);
  });
  it('MemSearchArgs defaults the limit and bounds it 1..searchMax', () => {
    expect(MemSearchArgs.parse({ query: 'q' }).limit).toBe(memoryApiLimits.searchDefault);
    expect([0, 1, memoryApiLimits.searchMax, memoryApiLimits.searchMax + 1].map((limit) => ok(MemSearchArgs.safeParse({ query: 'q', limit })))).toEqual([false, true, true, false]);
    expect([{ query: '' }, { query: 'q', since: '2026-13-45' }, { query: 'q', since: 'yesterday' }, { query: 'q', kind: 'x' }].map((a) => ok(MemSearchArgs.safeParse(a)))).toEqual([false, false, false, false]);
  });
  it('MemTimelineArgs defaults before/after to 3 and bounds them 0..10', () => {
    expect(MemTimelineArgs.parse({ anchor_id: 'a' })).toMatchObject({ before: 3, after: 3 });
    expect([-1, 0, 10, 11].map((before) => ok(MemTimelineArgs.safeParse({ anchor_id: 'a', before })))).toEqual([false, true, true, false]);
  });
  it('MemGetArgs takes 1..getMax ids', () => {
    expect([0, 1, memoryApiLimits.getMax, memoryApiLimits.getMax + 1].map((n) => ok(MemGetArgs.safeParse({ ids: Array.from({ length: n }, () => 'x') })))).toEqual([false, true, true, false]);
  });
  it('SaveMemoryArgs takes text up to textMax, a known kind and a known scope', () => {
    const a = { text: 't', kind: 'fact', scope: 'global' };
    expect([a, { ...a, text: 'x'.repeat(memoryApiLimits.textMax) }, { ...a, text: 'x'.repeat(memoryApiLimits.textMax + 1) }, { ...a, text: '' }, { ...a, kind: 'x' }, { ...a, scope: 'x' }].map((v) => ok(SaveMemoryArgs.safeParse(v)))).toEqual([true, true, false, false, false, false]);
  });
  it('MemoryListQuery reads digit strings for limit and bounds them', () => {
    expect(MemoryListQuery.parse({ limit: '25' }).limit).toBe(25);
    expect(['0', '501', '1.5', 'abc'].map((limit) => ok(MemoryListQuery.safeParse({ limit })))).toEqual([false, false, false, false]);
    expect(ok(MemoryListQuery.safeParse({ cursor: 'c'.repeat(memoryApiLimits.cursorMax + 1) }))).toBe(false);
  });
  it('MemoryPatchBody needs one known key', () => {
    expect([{}, { text: '' }, { pinned: 'yes' }, { other: 1 }, { pinned: true }, { text: 't', kind: 'skill_outcome' }].map((b) => ok(MemoryPatchBody.safeParse(b)))).toEqual([false, false, false, false, true, true]);
  });
  it('HistoryListQuery defaults the status to imported; HistoryImportBody bounds the limit', () => {
    expect(HistoryListQuery.parse({}).status).toBe('imported');
    expect(ok(HistoryListQuery.safeParse({ status: 'x' }))).toBe(false);
    expect([{}, { limit: 1 }, { limit: 500 }, { limit: 501 }, { limit: 0 }, { extra: 1 }].map((b) => ok(HistoryImportBody.safeParse(b)))).toEqual([true, true, true, false, false, false]);
  });
});
