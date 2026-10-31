import { describe, expect, it } from 'vitest';
import { runMigrate } from './migrate.ts';

async function run(argv: string[], env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMigrate(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('ctc migrate (D3c)', () => {
  it('exits 2 on an unknown flag', async () => {
    expect((await run(['--nope'], { CTC_DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/x' })).code).toEqual(2);
  });

  it('exits 2 on --from-python without a source URL, and on --status with --from-python', async () => {
    expect((await run(['--from-python'], { CTC_DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/x' })).code).toEqual(2);
    expect((await run(['--status', '--from-python', '--source-url', 'postgresql://u:p@127.0.0.1:1/x'])).code).toEqual(2);
  });

  it('exits 1 when CTC_DATABASE_URL is not set', async () => {
    expect(await run([], {})).toEqual({ code: 1, out: '', err: 'ctc migrate: CTC_DATABASE_URL is not set' });
  });

  it('exits 1 with `ctc migrate: <code>: <detail>` and never prints the password', async () => {
    const r = await run([], { CTC_DATABASE_URL: 'postgresql://postgres:SECRETPW@127.0.0.1:1/postgres' });
    expect(r.code).toEqual(1);
    expect(r.err).toMatch(/^ctc migrate: sql_failed: cannot connect/);
    expect(r.err).not.toContain('SECRETPW');
  });

  it('refuses a bad schema name (D1)', async () => {
    const r = await run(['--schema', 'ctc; drop schema public cascade'], { CTC_DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/x' });
    expect(r.err).toMatch(/^ctc migrate: bad_schema_name/);
  });
});
