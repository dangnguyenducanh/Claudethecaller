import { describe, expect, it } from 'vitest';
import { EmptyBody, FailBody, ReportBody } from './index.ts';

describe('runs body schemas (D1b, D5)', () => {
  it('retry and cancel bodies accept {} and reject any key', () => {
    expect(EmptyBody.safeParse({}).success).toBe(true);
    expect(EmptyBody.safeParse({ userId: 'x' }).success).toBe(false);
  });
  it('the fail body takes an optional string reason and rejects unknown keys', () => {
    expect(FailBody.safeParse({}).success).toBe(true);
    expect(FailBody.safeParse({ reason: 'r'.repeat(5000) }).success).toBe(true);
    expect(FailBody.safeParse({ reason: 1 }).success).toBe(false);
    expect(FailBody.safeParse({ extra: 1 }).success).toBe(false);
  });
  it('the report body needs outcome done or failed and strips unknown keys', () => {
    expect(ReportBody.parse({ outcome: 'done', foo: 1 })).toEqual({ outcome: 'done' });
    expect(ReportBody.parse({ outcome: 'failed', summary: null })).toEqual({ outcome: 'failed', summary: null });
    expect(ReportBody.safeParse({ outcome: 'maybe' }).success).toBe(false);
    expect(ReportBody.safeParse({}).success).toBe(false);
  });
});
