import { describe, expect, it } from 'vitest';
import { SuggestBody, suggestApiLimits } from './index.ts';

describe('SuggestBody (D4, D9)', () => {
  it('accepts extra keys and a blank prompt; rejects a non-string prompt and an empty or over-long cwd', () => {
    expect(suggestApiLimits.cwdMax).toBe(4096);
    expect(SuggestBody.safeParse({ prompt: 'a', cwd: '/x', session_id: 's' }).success).toBe(true);
    expect(SuggestBody.safeParse({ prompt: '', cwd: '/x' }).success).toBe(true);
    expect(SuggestBody.safeParse({ prompt: 5, cwd: '/x' }).success).toBe(false);
    expect(SuggestBody.safeParse({ prompt: 'a', cwd: '' }).success).toBe(false);
    expect(SuggestBody.safeParse({ prompt: 'a', cwd: `/${'a'.repeat(4095)}` }).success).toBe(true);
    expect(SuggestBody.safeParse({ prompt: 'a', cwd: `/${'a'.repeat(4096)}` }).success).toBe(false);
  });
});
