import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { importFromPython, migrate, MigrationError, type ImportReport } from './index.ts';
import { ADMIN_URL, scalar, sql, withDb } from './testing.ts';

vi.setConfig({ testTimeout: 60_000 });

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const tmp = mkdtempSync(join(tmpdir(), 'ctc-t12-imp-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const emptyArchive = (): string => {
  const dir = join(tmp, `a${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir);
  return dir;
};

const PYTHON_SCHEMA = readFileSync(join(import.meta.dirname, '../../../../../src/ctc/storage/schema.sql'), 'utf8').replaceAll('{schema}', 'ctc');
const VEC = 'array_fill(0.5::real, ARRAY[1024])::extensions.vector';
const ID = (n: number): string => `00000000-0000-0000-0000-00000000000${n}`;
const SEED = `
insert into ctc.projects (user_id,id,name,path) values ('local','p1','alpha','/w/alpha'),('local','p2','beta','/w/beta');
insert into ctc.sessions (id,user_id,project_id,title,model,tokens,source,status,git_branch,transcript_path,summary,turns) values
 ('s1','local','p1','t','m',100,'hook','processed','main','/t/s1.jsonl','sum1',3),('s2','local','p1','','',0,'history','pending',null,null,null,0);
insert into ctc.capabilities (id,kind,name,namespace,invoke,description,body,path,hash,summary,triggers,enricher_version,cluster_id) values
 ('user:tdd','skill','tdd','user','tdd','Test first','Write tests first','/home/u/.claude/skills/tdd/SKILL.md','h1','S','{a,b}','e1','c1'),
 ('user:review','agent','review','user','review','Reviews','','/home/u/.claude/agents/review.md','h2',null,'{}',null,null);
insert into ctc.cap_vectors (cap_id,text_hash,model,text,embedding) values ('user:tdd','th1','m1','x',${VEC}),('user:tdd','th2','m1','y',${VEC}),('user:review','th3','m1','z',${VEC});
insert into ctc.overrides (user_id,project,cap_id,action) values ('local','p1','user:tdd','pin'),('local','*','user:review','disable'),('local','p1','user:gone','block');
insert into ctc.dedup_review (a,b,similarity,status) values ('user:tdd','user:review',0.93,'open');
insert into ctc.memories (id,user_id,scope,project_id,kind,text,hash,supersedes,updated_at,deleted_at,embedding) values
 ('${ID(1)}','local','global',null,'fact','Use pnpm','x1',null,'2026-01-01',null,${VEC}),
 ('${ID(2)}','local','global',null,'fact','use  PNPM ','x2',null,'2026-02-01',null,${VEC}),
 ('${ID(3)}','local','project','p1','convention','Prefer vitest','x3',null,'2026-01-01',null,${VEC}),
 ('${ID(4)}','local','project','p1','convention','Prefer jest','x4','${ID(3)}','2026-01-02',null,${VEC}),
 ('${ID(5)}','local','global',null,'preference','Old thing','x5',null,'2026-01-01','2026-03-01',${VEC});
insert into ctc.graph_nodes (user_id,project_id,id,kind,type,label,text,source_file,source_line,content_hash,embedding,origin,meta) values
 ('local','p1','code:a_b','coding','function','b','tx','a.py',12,'c1',${VEC},'graphify','{"k":1}'),
 ('local','p1','ctx:specs/x:T1','context','task','T1','',null,null,'c2',null,'parser','{}'),
 ('local','p1','ctx:mem:1','context','observation','m1','',null,null,'c3',null,'claude-mem','{}');
insert into ctc.graph_edges (user_id,project_id,src,dst,relation,confidence,score,origin) values
 ('local','p1','code:a_b','ctx:mem:1','calls','EXTRACTED',1,'graphify'),
 ('local','p1','ctx:specs/x:T1','code:a_b','serves','INFERRED',0.7,'embed'),
 ('local','p1','ctx:specs/x:T1','code:a_b','implemented_in','EXTRACTED',1,'commit');
insert into ctc.graph_sources (user_id,project_id,source,version) values ('local','p1','graphify','1'),('local','p1','parse:x','1');
insert into ctc.history_files (user_id,path,session_id,size,mtime) values ('local','/t/s1.jsonl','s1',10,20);
insert into ctc.api_keys (key_hash,user_id,name) values ('k1','local','n');
insert into ctc.jobs (kind) values ('a'),('b');
insert into ctc.decisions (user_id,session_id,project_id,ref,prompt,abstained,bundle) values ('local','s1','p1','r1','p',false,'{}');
insert into ctc.events (session_id,type) values ('s1','x');
insert into ctc.wf_runs (owner,workflow,project_id,file_sha,graph,trigger,status,input,worktree,branch) values ('o@x','user:tdd','p1','f','{}','cli','done','go','/wt','b');
insert into ctc.wf_steps (run_id,node_id,visit,kind,status,output) values (1,'n1',1,'agent','done','{"a":1}'),(1,'n2',1,'shell','failed',null);
insert into ctc.wf_schedules (owner,workflow,cron) values ('o@x','user:tdd','0 * * * *');
`;

async function python(url: string, seed = true): Promise<void> {
  await sql(url, 'create schema if not exists extensions; create extension if not exists vector with schema extensions');
  await sql(url, PYTHON_SCHEMA);
  if (seed) await sql(url, SEED);
}
const entry = (r: ImportReport, table: string) => r.tables.find((t) => t.table === table);
const count = async (url: string, table: string): Promise<number> => Number(await scalar(url, `select count(*) from ctc.${table}`));
const failure = async (p: Promise<unknown>): Promise<MigrationError> => {
  try {
    await p;
  } catch (error) {
    return error as MigrationError;
  }
  throw new Error('expected a MigrationError');
};

describe.skipIf(!ADMIN_URL)('importFromPython against the scratch Postgres', () => {
  it('maps every table as D13 says and the report adds up (D3, D13, D14)', () =>
    withDb((src) =>
      withDb(async (tgt) => {
        await python(src);
        await migrate({ url: tgt });
        const report = await importFromPython({ targetUrl: tgt, sourceUrl: src, archiveDir: emptyArchive() });

        expect(report.tables.map((t) => t.table)).toEqual([
          'projects', 'sessions', 'capabilities', 'capability_versions', 'cap_files', 'cap_blobs', 'cap_vectors', 'overrides', 'dedup_review', 'memories', 'graph_nodes',
          'graph_edges', 'graph_sources', 'history_files', 'api_keys', 'wf_runs', 'wf_steps', 'wf_schedules', 'decisions', 'events', 'jobs',
        ]);
        for (const t of report.tables) expect(t.imported + t.skipped, t.table).toEqual(t.source_rows);
        expect(report.warnings).toEqual(expect.arrayContaining(['sessions.summary dropped for 1 rows']));
        expect(report.warnings.some((w) => w.startsWith('archive_missing'))).toBe(true);

        expect([await count(tgt, 'projects'), await count(tgt, 'sessions'), await count(tgt, 'capabilities'), await count(tgt, 'cap_files'), await count(tgt, 'cap_blobs')]).toEqual([2, 2, 2, 2, 2]);
        expect(await scalar(tgt, "select name||'|'||root from ctc.projects where id='p1'")).toEqual('alpha|/w/alpha');
        expect(await scalar(tgt, "select id = md5('local|user|skill|tdd')::uuid from ctc.capabilities where name='tdd'")).toBe(true);
        expect(await scalar(tgt, "select v.labels::text||'|'||v.body_hash from ctc.capability_versions v join ctc.capabilities c on c.id=v.cap_id where c.name='tdd'")).toEqual('{latest,production}|h1');
        expect(await scalar(tgt, `select content||'|'||size from ctc.cap_blobs where hash='${sha('Write tests first')}'`)).toEqual('Write tests first|17');
        expect(await scalar(tgt, "select size from ctc.cap_blobs where hash='" + sha('') + "'")).toEqual(0);
        expect(await scalar(tgt, "select root_path from ctc.capabilities where name='tdd'")).toEqual('/home/u/.claude/skills/tdd');
        expect(await scalar(tgt, "select enrichment::text from ctc.capabilities where name='tdd'")).toEqual('{"summary": "S", "triggers": ["a", "b"], "cluster_id": "c1", "enricher_version": "e1"}');
        expect(await count(tgt, 'cap_vectors')).toEqual(3);
        expect((await sql(tgt, "select coalesce(project_id,'*')||':'||action as v from ctc.overrides order by 1")).map((r) => r['v'])).toEqual(['*:block', 'p1:pin']);
        expect(entry(report, 'overrides')).toMatchObject({ imported: 2, skipped: 1, skipped_by_reason: { orphan: 1 } });

        expect(entry(report, 'memories')).toMatchObject({ source_rows: 5, imported: 4, skipped_by_reason: { duplicate_hash: 1 } });
        expect(await scalar(tgt, `select hash from ctc.memories where id='${ID(2)}'`)).toEqual(sha('use pnpm'));
        expect(await scalar(tgt, `select count(*)::int from ctc.memories where id='${ID(1)}'`)).toEqual(0);
        expect(await scalar(tgt, `select superseded_by from ctc.memories where id='${ID(3)}'`)).toEqual(ID(4));

        expect(await scalar(tgt, "select kind||'|'||origin||'|'||source_location from ctc.graph_nodes where id='code:a_b'")).toEqual('code|ast|12');
        expect(await scalar(tgt, "select origin from ctc.graph_nodes where id='ctx:mem:1'")).toEqual('session');
        expect((await sql(tgt, 'select distinct origin from ctc.graph_edges order by 1')).map((r) => r['origin'])).toEqual(['ast', 'commit', 'parser']);
        expect((await sql(tgt, 'select relation from ctc.graph_edges order by 1')).map((r) => r['relation'])).toEqual(['calls', 'implemented_in', 'serves']);
        expect(await count(tgt, 'graph_sources')).toEqual(0);
        expect(entry(report, 'graph_sources')).toMatchObject({ source_rows: 2, imported: 0, skipped_by_reason: { by_design: 2 } });
        expect(entry(report, 'jobs')).toMatchObject({ source_rows: 2, imported: 0, skipped_by_reason: { by_design: 2 } });
        expect(await count(tgt, 'jobs')).toEqual(0);

        expect(await scalar(tgt, "select workflow_cap_id = md5('local|user|skill|tdd')::uuid from ctc.wf_runs where id=1")).toBe(true);
        expect(await scalar(tgt, 'select inputs::text from ctc.wf_runs where id=1')).toEqual('{"input": "go"}');
        expect(await scalar(tgt, "select legacy->>'workflow' from ctc.wf_runs where id=1")).toEqual('user:tdd');
        expect(await scalar(tgt, "select attempt||'|'||stage||'|'||worktree||'|'||output::text from ctc.wf_steps where node_id='n1'")).toEqual('1|report|/wt|{"a": 1}');
        expect(await count(tgt, 'wf_schedules')).toEqual(1);
        for (const t of report.tables.filter((x) => x.from === x.table)) expect(t.target_rows, t.table).toEqual(await count(tgt, t.table));
        await sql(tgt, "insert into ctc.wf_runs(owner,status,trigger) values ('o2','queued','cli')");
        await sql(tgt, "insert into ctc.api_keys(key_hash,user_id) values ('k2','local')");
      }),
    ));

  it('a second run imports nothing and a dry run on a fresh target changes nothing, sequences included (D14)', () =>
    withDb((src) =>
      withDb(async (tgt) =>
        withDb(async (fresh) => {
          await python(src);
          await migrate({ url: tgt });
          await importFromPython({ targetUrl: tgt, sourceUrl: src });
          const again = await importFromPython({ targetUrl: tgt, sourceUrl: src });
          expect(again.tables.every((t) => t.imported === 0)).toBe(true);
          expect(entry(again, 'projects')).toMatchObject({ skipped: 2, skipped_by_reason: { exists: 2 } });

          await migrate({ url: fresh });
          const dry = await importFromPython({ targetUrl: fresh, sourceUrl: src, dryRun: true });
          expect(dry.dryRun).toBe(true);
          expect(entry(dry, 'projects')).toMatchObject({ imported: 2, target_rows: 2 });
          expect([await count(fresh, 'projects'), await count(fresh, 'graph_nodes'), await count(fresh, 'wf_runs')]).toEqual([0, 0, 0]);
          expect(await scalar(fresh, "select is_called from ctc.wf_runs_id_seq")).toBe(false);
        }),
      ),
    ));

  it('imports more than one batch of 200 rows (D2)', () =>
    withDb((src) =>
      withDb(async (tgt) => {
        await python(src, false);
        await sql(src, `insert into ctc.projects (id,name,path) values ('p1','a','/a');
          insert into ctc.graph_nodes (project_id,id,kind,type,label,content_hash,origin) select 'p1','code:g'||g,'coding','function','f'||g,'h'||g,'graphify' from generate_series(1,450) g`);
        await migrate({ url: tgt });
        const report = await importFromPython({ targetUrl: tgt, sourceUrl: src });
        expect([entry(report, 'graph_nodes')?.imported, await count(tgt, 'graph_nodes')]).toEqual([450, 450]);
      }),
    ));

  it('an empty Python database imports as zeros (D5)', () =>
    withDb((src) =>
      withDb(async (tgt) => {
        await python(src, false);
        await migrate({ url: tgt });
        const report = await importFromPython({ targetUrl: tgt, sourceUrl: src });
        expect(report.tables.every((t) => t.source_rows === 0 && t.imported === 0)).toBe(true);
      }),
    ));

  it('ignores unknown extra source columns (D8)', () =>
    withDb((src) =>
      withDb(async (tgt) => {
        await python(src);
        await sql(src, 'alter table ctc.memories add column zzz text');
        await migrate({ url: tgt });
        await importFromPython({ targetUrl: tgt, sourceUrl: src });
        expect(await count(tgt, 'memories')).toEqual(4);
      }),
    ));

  it('skips a memory whose scope and project_id disagree instead of failing the import (D8, D13)', () =>
    withDb((src) =>
      withDb(async (tgt) => {
        await python(src);
        await sql(src, `insert into ctc.memories (id,user_id,scope,project_id,kind,text,hash,updated_at,embedding) values
          ('${ID(6)}','local','global','p1','fact','bad global','x6','2026-01-01',${VEC}),('${ID(7)}','local','project',null,'fact','bad project','x7','2026-01-01',${VEC})`);
        await migrate({ url: tgt });
        const report = await importFromPython({ targetUrl: tgt, sourceUrl: src });
        expect(entry(report, 'memories')).toMatchObject({ source_rows: 7, imported: 4, skipped_by_reason: { orphan: 2, duplicate_hash: 1 } });
        expect(await count(tgt, 'memories')).toEqual(4);
      }),
    ));

  it('merging duplicates never makes a superseded_by cycle (D13)', () =>
    withDb((src) =>
      withDb(async (tgt) => {
        await python(src, false);
        await sql(src, `insert into ctc.memories (id,scope,kind,text,hash,supersedes,updated_at,embedding) values
          ('${ID(1)}','global','fact','cyc a','h',null,'2026-01-01',${VEC}),('${ID(2)}','global','fact','cyc b','h','${ID(1)}','2026-01-02',${VEC}),
          ('${ID(3)}','global','fact','CYC B','h',null,'2026-01-03',${VEC}),('${ID(4)}','global','fact','CYC A','h','${ID(3)}','2026-01-04',${VEC})`);
        await migrate({ url: tgt });
        await importFromPython({ targetUrl: tgt, sourceUrl: src });
        expect(await scalar(tgt, 'select count(*)::int from ctc.memories where superseded_by is not null')).toEqual(1);
        expect(await scalar(tgt, 'select count(*)::int from ctc.memories a join ctc.memories b on a.superseded_by = b.id and b.superseded_by = a.id')).toEqual(0);
      }),
    ));

  it('pre-flight lists every problem and writes nothing (D4, D6)', () =>
    withDb((src) =>
      withDb(async (tgt) => {
        await python(src);
        await sql(src, "update ctc.graph_nodes set origin='weird' where id='code:a_b'");
        const bare = await failure(importFromPython({ targetUrl: tgt, sourceUrl: src }));
        expect(bare.code).toEqual('schema_behind');
        await migrate({ url: tgt });
        const unmapped = await failure(importFromPython({ targetUrl: tgt, sourceUrl: src }));
        expect(unmapped).toMatchObject({ code: 'unmapped_value', message: 'unmapped_value: graph_nodes.origin = "weird" (1 rows)' });
        expect(await count(tgt, 'projects')).toEqual(0);
        const same = await failure(importFromPython({ targetUrl: src, sourceUrl: src }));
        expect(same.message).toMatch(/^same_schema: .*\nschema_behind: /);
        const noPython = await failure(importFromPython({ targetUrl: tgt, sourceUrl: tgt, sourceSchema: 'nothing_here' }));
        expect(noPython.message).toMatch(/^bad_source: source schema nothing_here lacks table\(s\) projects, memories, capabilities/);
      }),
    ));

  it('is all or nothing: a failing table leaves the target empty (D6)', () =>
    withDb((src) =>
      withDb(async (tgt) => {
        await python(src);
        await migrate({ url: tgt });
        await sql(tgt, 'drop table ctc.graph_edges');
        const e = await failure(importFromPython({ targetUrl: tgt, sourceUrl: src }));
        expect(e.code).toEqual('import_failed');
        expect(e.message).toMatch(/^import_failed: graph_edges: /);
        expect([await count(tgt, 'projects'), await count(tgt, 'memories')]).toEqual([0, 0]);
      }),
    ));

  it('leaves the source unchanged and never prints the password (D1)', () =>
    withDb((src) =>
      withDb(async (tgt) => {
        await python(src);
        await migrate({ url: tgt });
        const fingerprint = (): Promise<unknown> => scalar(src, "select md5(string_agg(m::text,'' order by id::text)) from ctc.memories m");
        const before = await fingerprint();
        await importFromPython({ targetUrl: tgt, sourceUrl: src });
        expect(await fingerprint()).toEqual(before);
        const e = await failure(importFromPython({ targetUrl: tgt, sourceUrl: 'postgresql://postgres:SECRETPW@127.0.0.1:1/x' }));
        expect(e.code).toEqual('bad_source');
        expect(e.message).not.toContain('SECRETPW');
      }),
    ));

  it('writes no archive files and warns only when decisions/events lack an archive (D7, D14)', () =>
    withDb((src) =>
      withDb(async (tgt) => {
        await python(src);
        await migrate({ url: tgt });
        const archive = emptyArchive();
        writeFileSync(join(archive, 'decisions-2026.jsonl.gz'), '');
        writeFileSync(join(archive, 'events-2026.jsonl.gz'), '');
        const report = await importFromPython({ targetUrl: tgt, sourceUrl: src, archiveDir: archive });
        expect(report.warnings.some((w) => w.startsWith('archive_missing'))).toBe(false);
        expect(await sql(tgt, "select 1 from information_schema.tables where table_schema='ctc' and table_name in ('decisions','events')")).toEqual([]);
      }),
    ));
});
