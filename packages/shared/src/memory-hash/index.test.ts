import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { memoryHash } from './index.ts';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

describe('memoryHash (D15)', () => {
  it('trims, collapses whitespace and lowercases', () => {
    expect(memoryHash('  Use\tPNPM ')).toEqual(sha('use pnpm'));
    expect(memoryHash('use  pnpm now')).toEqual(sha('use pnpm now'));
  });
  it('normalizes NFKC (full-width letters)', () => {
    expect(memoryHash('ｕｓｅ pnpm')).toEqual(sha('use pnpm'));
  });
  it('hashes the empty string', () => {
    expect(memoryHash('')).toEqual(sha(''));
  });
});
