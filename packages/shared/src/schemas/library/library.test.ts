import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CapabilityListQuery, DiffQuery, GetCapabilityArgs, LabelsBody, LoadResourceArgs, OverrideBody, OverrideParams, RestoreBody, VersionParams,
  libraryApiLimits, parseVersionNumber,
} from './index.ts';

const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown): boolean => s.safeParse(v).success;
const message = (s: { safeParse(v: unknown): { success: boolean; error?: { issues: { message: string }[] } } }, v: unknown): string | undefined =>
  s.safeParse(v).error?.issues[0]?.message;

describe('libraryApiLimits (D2)', () => {
  it('pins every default', () => {
    expect({ ...libraryApiLimits }).toEqual({ listDefault: 50, listMax: 500, labelsMax: 20, qMax: 200, cursorMax: 512, nameMax: 200, pathMax: 1024, candidatesMax: 10 });
  });
  it('list limit: 500 is valid, 501 is not, query strings are accepted', () => {
    expect(ok(CapabilityListQuery, { limit: '500' })).toBe(true);
    expect(ok(CapabilityListQuery, { limit: 500 })).toBe(true);
    expect(ok(CapabilityListQuery, { limit: '501' })).toBe(false);
    expect(ok(CapabilityListQuery, { limit: '0' })).toBe(false);
    expect(CapabilityListQuery.parse({ limit: '7' }).limit).toBe(7);
  });
  it('q, cursor, name, path and labels bounds: equal is valid, one more is invalid', () => {
    expect([ok(CapabilityListQuery, { q: 'q'.repeat(200) }), ok(CapabilityListQuery, { q: 'q'.repeat(201) }), ok(CapabilityListQuery, { q: '' })]).toEqual([true, false, true]);
    expect([ok(CapabilityListQuery, { cursor: 'c'.repeat(512) }), ok(CapabilityListQuery, { cursor: 'c'.repeat(513) })]).toEqual([true, false]);
    expect([ok(GetCapabilityArgs, { name: 'n'.repeat(200) }), ok(GetCapabilityArgs, { name: 'n'.repeat(201) })]).toEqual([true, false]);
    expect([ok(LoadResourceArgs, { version_id: 'v', path: 'p'.repeat(1024) }), ok(LoadResourceArgs, { version_id: 'v', path: 'p'.repeat(1025) })]).toEqual([true, false]);
    const labels = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`);
    expect([ok(LabelsBody, { labels: labels(20) }), ok(LabelsBody, { labels: labels(21) }), ok(LabelsBody, { labels: [] })]).toEqual([true, false, false]);
  });
});

describe('parseVersionNumber (D4)', () => {
  it('accepts integers and digit strings in 1..999999999', () => {
    expect([parseVersionNumber(3), parseVersionNumber('3'), parseVersionNumber(999999999), parseVersionNumber('999999999')]).toEqual([3, 3, 999999999, 999999999]);
  });
  it('rejects everything else', () => {
    for (const bad of [0, -1, 1.5, '1e3', ' 3', '', '-1', 1000000000, '1000000000', true, null, undefined, {}, []]) expect(parseVersionNumber(bad)).toBeNull();
  });
});

describe('bodies and args (D1a, D4, D5, D16, D17)', () => {
  it('route bodies are strict objects', () => {
    expect(ok(LabelsBody, { labels: ['beta'], userId: 'x' })).toBe(false);
    expect(ok(RestoreBody, { version: 1, userId: 'x' })).toBe(false);
    expect(RestoreBody.parse({ version: '2' })).toEqual({ version: 2 });
  });
  it('labels must match the label rule', () => {
    expect(ok(LabelsBody, { labels: ['Bad Label'] })).toBe(false);
    expect(ok(LabelsBody, { labels: ['a.b_c-1'] })).toBe(true);
  });
  it('override body: pin needs exactly one of label or version, block takes neither', () => {
    expect(OverrideBody.parse({ action: 'pin', version: '3' })).toEqual({ action: 'pin', version: 3 });
    expect(OverrideBody.parse({ action: 'pin', label: 'beta' })).toEqual({ action: 'pin', label: 'beta' });
    expect(OverrideBody.parse({ action: 'block' })).toEqual({ action: 'block' });
    for (const bad of [{ action: 'pin' }, { action: 'pin', label: 'a', version: 1 }, { action: 'block', label: 'a' }, { action: 'block', version: 1 }, { action: 'nope' }, {}, 'x', null]) {
      expect(ok(OverrideBody, bad)).toBe(false);
    }
  });
  it('get_capability: trims the name, accepts a digit-string version, refuses label and version together, strips extra keys', () => {
    expect(GetCapabilityArgs.parse({ name: '  a  ', version: '3', extra: 1 })).toEqual({ name: 'a', version: 3 });
    expect(message(GetCapabilityArgs, { name: 'a', label: 'production', version: 1 })).toBe('give label or version, not both');
    for (const bad of [null, undefined, 'x', 42, [], { name: {} }, { name: '   ' }]) expect(ok(GetCapabilityArgs, bad)).toBe(false);
  });
  it('load_capability_resource needs string arguments', () => {
    expect(ok(LoadResourceArgs, { version_id: 5, path: 'a' })).toBe(false);
    expect(ok(LoadResourceArgs, { version_id: 'v' })).toBe(false);
  });
  it('params and queries', () => {
    expect(VersionParams.parse({ id: 'x', v: '2' })).toEqual({ id: 'x', v: 2 });
    for (const bad of ['abc', '0', '-1', '1.5', '']) expect(ok(VersionParams, { id: 'x', v: bad })).toBe(false);
    expect(ok(DiffQuery, {})).toBe(false);
    expect(DiffQuery.parse({ against: '1' })).toEqual({ against: 1 });
    expect(ok(OverrideParams, { pid: 'p', id: 'i' })).toBe(true);
    expect(ok(CapabilityListQuery, {})).toBe(true);
    expect(ok(CapabilityListQuery, { kind: 'nope' })).toBe(false);
  });
  it('get_capability and load_capability_resource convert to JSON Schema for tools/list', () => {
    expect(() => z.toJSONSchema(GetCapabilityArgs, { io: 'input' })).not.toThrow();
    expect(() => z.toJSONSchema(LoadResourceArgs, { io: 'input' })).not.toThrow();
  });
  it('version bounds: digit string and integer accepted; 0, 1000000000, 1.5 refused', () => {
    expect(GetCapabilityArgs.parse({ name: 'a', version: '3' }).version).toBe(3);
    for (const bad of [0, '0', 1_000_000_000, '1000000000', 1.5, '1.5', '99999999999999999999']) expect(ok(GetCapabilityArgs, { name: 'a', version: bad })).toBe(false);
  });
});
