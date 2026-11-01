import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Job = { services?: Record<string, { ports?: string[] }>; env?: Record<string, string> };

describe('ci.yml ts job', () => {
  const ts = (parse(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')) as { jobs: { ts: Job } }).jobs.ts;

  it('runs the integration tests against the scratch Postgres and Redis ports the helpers accept', () => {
    expect(ts.services?.['postgres']?.ports).toContain('18304:5432');
    expect(ts.services?.['redis']?.ports).toContain('18395:6379');
    for (const k of ['CTC_SCRATCH_PG_URL', 'CTC_TEST_DATABASE_URL', 'CTC_TEST_ADMIN_URL', 'CTC_SCRATCH_REDIS_URL']) expect(ts.env?.[k], k).toBeTruthy();
  });
});
