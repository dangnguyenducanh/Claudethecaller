import { describe, expect, it } from 'vitest';
import { name as shared } from '@ctc/shared';
import { name } from './index.ts';

describe('@ctc/core', () => {
  it('links to @ctc/shared', () => {
    expect([name, shared]).toEqual(['@ctc/core', '@ctc/shared']);
  });
});
