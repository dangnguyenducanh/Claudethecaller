import { describe, expect, it } from 'vitest';
import { name as core } from '@ctc/core';
import { name as shared } from '@ctc/shared';
import { name } from './index.ts';

describe('@ctc/worker', () => {
  it('links to @ctc/shared and @ctc/core', () => {
    expect([name, shared, core]).toEqual(['@ctc/worker', '@ctc/shared', '@ctc/core']);
  });
});
