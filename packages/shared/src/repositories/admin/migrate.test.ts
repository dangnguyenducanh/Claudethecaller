import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { assertSchemaVersion, loadMigrations, migrate, MigrationError, schemaVersion } from './index.ts';
import { ADMIN_URL, scalar, sql, withDb } from './testing.ts';

vi.setConfig({ testTimeout: 60_000 });

const tmp = mkdtempSync(join(tmpdir(), 'ctc-t12-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const dirWith = (files: Record<string, string>): string => {
  const dir = join(tmp, `d${n++}`);
  mkdirSync(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
};
const failure = async (p: Promise<unknown>): Promise<MigrationError> => {
  try {
    await p;
  } catch (error) {
    return error as MigrationError;
  }
  throw new Error('expected a MigrationError');
};

describe('loadMigrations (D2, D4, D12)', () => {
  it('loads the five shipped files in order with sha256 checksums of the raw bytes', () => {
    const migrations = loadMigrations();
    expect(migrations.map((m) => m.file)).toEqual(['0001_base.sql', '0002_graph.sql', '0003_library.sql', '0004_memory.sql', '0005_runner.sql']);
    const first = migrations[0];
    expect(first).toMatchObject({ version: 1, name: 'base', checksum: createHash('sha256').update(readFileSync(join(import.meta.dirname, '../../../migrations/0001_base.sql'))).digest('hex') });
  });

  it('lists bad_name, duplicate and gap together and ignores non-sql files', () => {
    const dir = dirWith({ '0001_a.sql': 'select 1;', '0001_b.sql': 'select 1;', '0003_c.sql': 'select 1;', '0004_BAD.sql': 'select 1;', 'README.md': 'x' });
    expect(() => loadMigrations(dir)).toThrow(MigrationError);
    try {
      loadMigrations(dir);
    } catch (error) {
      const e = error as MigrationError;
      expect(e.code).toEqual('bad_name');
      expect(e.message).toEqual(
        'bad_name: 0004_BAD.sql (must match ^([0-9]{4})_([a-z0-9_]+)\\.sql$)\nduplicate: version 1: 0001_a.sql, 0001_b.sql\ngap: missing version 2',
      );
    }
  });

  it('requires versions to start at 1', () => {
    expect(() => loadMigrations(dirWith({ '0002_x.sql': 'select 1;' }))).toThrow('gap: missing version 1');
  });

  it('accepts an empty folder', () => {
    expect(loadMigrations(dirWith({}))).toEqual([]);
  });

  it('never ships a statement that removes data (D6)', () => {
    const dir = join(import.meta.dirname, '../../../migrations');
    for (const file of readdirSync(dir)) {
      const code = readFileSync(join(dir, file), 'utf8').replace(/--.*$/gm, '');
      expect(code, file).not.toMatch(/\b(drop\s+(table|schema|column|index|type|extension)|truncate|delete\s+from)\b/i);
    }
  });
});

describe('bad input that needs no database', () => {
  it('refuses a bad schema name before connecting (D1, D2)', async () => {
    for (const schema of ['ctc; drop schema public cascade', 'a'.repeat(64), 'Upper', '1x']) {
      expect((await failure(migrate({ url: 'postgresql://u:p@127.0.0.1:1/x', schema }))).code).toEqual('bad_schema_name');
    }
  });

  it('accepts the longest schema name (63 characters) up to the connection (D2)', async () => {
    expect((await failure(migrate({ url: 'postgresql://u:p@127.0.0.1:1/x', schema: 'a'.repeat(63) }))).message).toMatch(/^sql_failed: cannot connect/);
  });

  it('never puts the password in the error (D1)', async () => {
    const e = await failure(migrate({ url: 'postgresql://postgres:SECRETPW@127.0.0.1:1/postgres' }));
    expect(e.code).toEqual('sql_failed');
    expect(e.message).not.toContain('SECRETPW');
  });
});

describe.skipIf(!ADMIN_URL)('migrate against the scratch Postgres', () => {
  it('builds 22 tables and stamps version 5; a second run does nothing (D5, D12)', () =>
    withDb(async (url) => {
      const first = await migrate({ url });
      expect(first).toMatchObject({ schema: 'ctc', before: 0, after: 5, pending: [] });
      expect(first.applied.map((m) => m.version)).toEqual([1, 2, 3, 4, 5]);
      expect(await scalar(url, "select count(*)::int from information_schema.tables where table_schema='ctc' and table_type='BASE TABLE'")).toEqual(22);
      expect(await scalar(url, "select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='ctc' and relkind='r' and not relrowsecurity")).toEqual(0);
      expect(await migrate({ url })).toMatchObject({ before: 5, after: 5, applied: [] });
      expect(await schemaVersion({ url })).toEqual(5);
    }));

  it('serializes two runners; both succeed and five stamps exist (D12)', () =>
    withDb(async (url) => {
      const [a, b] = await Promise.all([migrate({ url }), migrate({ url })]);
      expect(a.applied.length + b.applied.length).toEqual(5);
      expect(await scalar(url, 'select count(*)::int from ctc.schema_migrations')).toEqual(5);
    }));

  it('records name and checksum of each file (D12)', () =>
    withDb(async (url) => {
      await migrate({ url });
      const row = (await sql(url, 'select name, checksum from ctc.schema_migrations where version = 1'))[0];
      expect(row).toEqual({ name: 'base', checksum: loadMigrations()[0]?.checksum });
    }));

  it('dry run on a missing schema reports everything pending and creates nothing (D5)', () =>
    withDb(async (url) => {
      const result = await migrate({ url, dryRun: true });
      expect(result.pending.map((m) => m.version)).toEqual([1, 2, 3, 4, 5]);
      expect(result).toMatchObject({ before: 0, after: 0, applied: [] });
      expect(await sql(url, "select nspname from pg_namespace where nspname = 'ctc'")).toEqual([]);
    }));

  it('another schema name works and stays separate (D2)', () =>
    withDb(async (url) => {
      await migrate({ url, schema: 'ctc_other' });
      expect(await schemaVersion({ url, schema: 'ctc_other' })).toEqual(5);
      expect(await schemaVersion({ url })).toEqual(0);
    }));

  it('checksum_mismatch applies nothing and keeps the stamp (D4)', () =>
    withDb(async (url) => {
      const dir = dirWith({ '0001_a.sql': 'create table {schema}.t1(a int);' });
      await migrate({ url, dir });
      writeFileSync(join(dir, '0001_a.sql'), 'create table {schema}.t1(a int, b int);');
      writeFileSync(join(dir, '0002_b.sql'), 'create table {schema}.t2(a int);');
      const e = await failure(migrate({ url, dir }));
      expect(e.code).toEqual('checksum_mismatch');
      expect(await scalar(url, "select to_regclass('ctc.t2')")).toBeNull();
      expect(await scalar(url, 'select max(version)::int from ctc.schema_migrations')).toEqual(1);
    }));

  it('schema_too_new when the database is ahead of the files; assertSchemaVersion agrees (D4)', () =>
    withDb(async (url) => {
      await migrate({ url, dir: dirWith({ '0001_a.sql': 'select 1;', '0002_b.sql': 'select 1;' }) });
      const dir = dirWith({ '0001_a.sql': 'select 1;' });
      expect((await failure(migrate({ url, dir }))).code).toEqual('schema_too_new');
      expect((await failure(assertSchemaVersion({ url, dir }))).code).toEqual('schema_too_new');
    }));

  it('assertSchemaVersion: behind says to run ctc migrate, equal passes (D3, D4)', () =>
    withDb(async (url) => {
      const e = await failure(assertSchemaVersion({ url }));
      expect(e).toMatchObject({ code: 'schema_behind' });
      expect(e.message).toMatch(/run: ctc migrate$/);
      await migrate({ url });
      await expect(assertSchemaVersion({ url })).resolves.toBeUndefined();
    }));

  it('sql_failed rolls back that file and keeps the earlier one (D4)', () =>
    withDb(async (url) => {
      const dir = dirWith({
        '0001_a.sql': 'create table {schema}.t1(a int);',
        '0002_b.sql': 'create table {schema}.t2(a int); select * from nonexistent_xyz;',
      });
      const e = await failure(migrate({ url, dir }));
      expect(e.message).toEqual('sql_failed: 0002_b.sql: relation "nonexistent_xyz" does not exist');
      expect(await scalar(url, 'select max(version)::int from ctc.schema_migrations')).toEqual(1);
      expect(await scalar(url, "select to_regclass('ctc.t2')")).toBeNull();
    }));

  it('the label rule: a label may sit on one version only, and can be moved in one transaction (D11)', () =>
    withDb(async (url) => {
      await migrate({ url });
      const cap = "insert into ctc.capabilities(id,namespace,kind,name,root_path) values ('00000000-0000-0000-0000-0000000000c1','u','skill','x','/r');";
      const ver = (id: string, v: number, labels: string): string =>
        `insert into ctc.capability_versions(id,cap_id,version,body_hash,description,labels) values ('00000000-0000-0000-0000-0000000000${id}','00000000-0000-0000-0000-0000000000c1',${v},'h','d','${labels}');`;
      await expect(sql(url, `begin; ${cap} ${ver('a1', 1, '{latest,production}')} ${ver('a2', 2, '{production}')}`)).rejects.toThrow(/label already on another version/);
      await expect(
        sql(url, `begin; ${cap} ${ver('a1', 1, '{latest,production}')} update ctc.capability_versions set labels='{latest}' where version=1; ${ver('a2', 2, '{production}')} rollback;`),
      ).resolves.toBeDefined();
    }));

  it('memory hash is unique even with a NULL project; one running run per owner (D11)', () =>
    withDb(async (url) => {
      await migrate({ url });
      await expect(sql(url, "insert into ctc.memories(scope,kind,text,hash) values ('global','fact','a','h'),('global','fact','b','h')")).rejects.toThrow(/duplicate key/);
      await expect(sql(url, "insert into ctc.wf_runs(owner,status,trigger) values ('o','running','cli'),('o','running','cli')")).rejects.toThrow(/duplicate key/);
    }));
});
