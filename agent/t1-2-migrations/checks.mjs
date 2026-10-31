#!/usr/bin/env node
// One runnable example per decision id of agent/t1-2-migrations/DECISIONS.md. Plain Node + the `psql` client, no npm dependencies.
// Talks to the scratch Postgres (ctc-dev-pg) only, in databases/roles it creates itself, all named ctc_t12_*; they are dropped at exit.
// Drives the module through its public CLI (`node apps/cli/src/main.ts migrate ...`). Prints `PASS D3 <label>` / `FAIL D3 <label> expected=.. got=..`.
// Usage: node agent/t1-2-migrations/checks.mjs [D#]   env: CTC_ROOT, CTC_TEST_ADMIN_URL, CTC_CHECKS_FAST=1 (skips the 450-row batch import and the vitest run)
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.CTC_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ADMIN = process.env.CTC_TEST_ADMIN_URL ?? 'postgresql://postgres:ctcdev@127.0.0.1:18304/postgres';
const BASE = ADMIN.replace(/\/[^/]*$/, '/');
const FAST = process.env.CTC_CHECKS_FAST === '1';
const only = process.argv[2];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ctc-t12-checks-'));
const dbs = [], roles = [];
let failed = 0;
const rnd = () => crypto.randomBytes(4).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---- helpers
function psql(url, sql) {
  const r = spawnSync('psql', [url, '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { input: sql, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 << 20 });
  return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}
const q = (url, sql) => { const r = psql(url, sql); if (r.code) throw new Error(`psql: ${r.err.split('\n')[0]}`); return r.out; };
const rows = (url, sql) => q(url, sql).split('\n').filter(Boolean);
function mkdb(label = 'db') {
  const name = `ctc_t12_${label}_${rnd()}`;
  q(ADMIN, `create database ${name}`); dbs.push(name);
  return { name, url: BASE + name };
}
function mkrole() {
  const name = `ctc_t12_ro_${rnd()}`;
  q(ADMIN, `create role ${name} login password 'pw_${name}'`); roles.push(name);
  return { name, pw: `pw_${name}` };
}
process.on('exit', () => {
  for (const d of dbs) psql(ADMIN, `drop database if exists ${d} with (force)`);
  for (const r of roles) psql(ADMIN, `drop role if exists ${r}`);
  fs.rmSync(TMP, { recursive: true, force: true });
});
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
function cli(args, env = {}, o = {}) {
  const r = spawnSync('node', [path.join(ROOT, 'apps/cli/src/main.ts'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: o.timeout ?? 120_000, input: '', env: { ...process.env, CTC_DATABASE_URL: '', CTC_PYTHON_DATABASE_URL: '', ...env } });
  return { code: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const migrate = (db, args = []) => cli(['migrate', ...args], { CTC_DATABASE_URL: db.url });
function migrated() { const d = mkdb('m'); const r = migrate(d); if (r.code) throw new Error(`ctc migrate failed: ${r.out.split('\n')[0]}`); return d; }
const dirWith = (files) => { const d = path.join(TMP, `d${rnd()}`); fs.mkdirSync(d); for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(d, n), c); return d; };

async function check(id, label, fn) {
  if (only && only !== id) return;
  let exp, got;
  try { [exp, got] = await fn(); } catch (e) { exp = 'no exception'; got = `threw: ${String(e?.message ?? e).split('\n')[0]}`; }
  if (got === 'SKIP') { console.log(`SKIP ${id} ${label}`); return; }
  if (JSON.stringify(exp) === JSON.stringify(got)) console.log(`PASS ${id} ${label}`);
  else { failed++; console.log(`FAIL ${id} ${label} expected=${JSON.stringify(exp)} got=${JSON.stringify(got)}`); }
}
const has = (re, s) => re.test(s);

// ---- the Python source: today's schema.sql applied as schema `ctc`, plus our own rows
const VEC = "array_fill(0.5::real, ARRAY[1024])::extensions.vector";
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
 ('00000000-0000-0000-0000-000000000001','local','global',null,'fact','Use pnpm','x1',null,'2026-01-01',null,${VEC}),
 ('00000000-0000-0000-0000-000000000002','local','global',null,'fact','use  PNPM ','x2',null,'2026-02-01',null,${VEC}),
 ('00000000-0000-0000-0000-000000000003','local','project','p1','convention','Prefer vitest','x3',null,'2026-01-01',null,${VEC}),
 ('00000000-0000-0000-0000-000000000004','local','project','p1','convention','Prefer jest','x4','00000000-0000-0000-0000-000000000003','2026-01-02',null,${VEC}),
 ('00000000-0000-0000-0000-000000000005','local','global',null,'preference','Old thing','x5',null,'2026-01-01','2026-03-01',${VEC});
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
function pySource(extra = '', seed = true) {
  const d = mkdb('py');
  const ddl = read('src/ctc/storage/schema.sql').replaceAll('{schema}', 'ctc');
  q(d.url, ddl);
  if (seed) q(d.url, SEED);
  if (extra) q(d.url, extra);
  return d;
}
function imp(src, tgt, args = []) {
  const r = cli(['migrate', '--from-python', '--source-url', src.url, '--json', ...args], { CTC_DATABASE_URL: tgt.url });
  let json = null; try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { ...r, json };
}
const entry = (j, table) => j?.tables?.find((t) => t.table === table);
const count = (db, t, schema = 'ctc') => Number(q(db.url, `select count(*) from ${schema}.${t}`));
const ORDER = ['projects', 'sessions', 'capabilities', 'capability_versions', 'cap_files', 'cap_blobs', 'cap_vectors', 'overrides', 'dedup_review', 'memories',
  'graph_nodes', 'graph_edges', 'graph_sources', 'history_files', 'api_keys', 'wf_runs', 'wf_steps', 'wf_schedules', 'decisions', 'events', 'jobs'];

// expected schema: required (spec) columns + the extras DECISIONS D10 names
const COLS = {
  schema_migrations: 'version name checksum applied_at',
  projects: 'id user_id root profile_hash name embedding created_at last_active',
  sessions: 'id user_id project_id started_at ended_at model tokens transcript_path title source status git_branch processed_at',
  history_files: 'user_id path size mtime status session_id rows error imported_at',
  jobs: 'id user_id queue kind status progress result error created_at payload attempts updated_at',
  idempotency_keys: 'user_id key route payload_hash response created_at',
  api_keys: 'id key_hash user_id name created_at revoked_at',
  dedup_review: 'id user_id a b similarity status at',
  graph_nodes: 'id user_id project_id kind type label source_file source_location origin content_hash embedding meta text updated_at',
  graph_edges: 'user_id project_id src dst relation confidence score origin source_location',
  graph_sources: 'user_id project_id file content_hash extractor_version built_at_commit',
  capabilities: 'id user_id namespace kind name root_path served_version removed_at enrichment',
  capability_versions: 'id cap_id version body_hash description frontmatter labels commit_message created_at',
  cap_files: 'version_id path blob_hash',
  cap_blobs: 'user_id hash content size',
  cap_vectors: 'cap_id text_hash embedding model',
  overrides: 'user_id project_id cap_id action label version',
  memories: 'id user_id scope project_id kind text hash source superseded_by confidence pinned reinforcement_dates created_at updated_at last_used_at use_count deleted_at embedding tsv',
  session_summaries: 'session_id user_id project_id request investigated learned completed next_steps notes content_hash created_at',
  wf_runs: 'id user_id owner workflow_cap_id workflow_version status state trigger inputs repo base_branch created_at started_at ended_at legacy',
  wf_steps: 'id run_id node_id visit attempt retry_of_step_id failure_count parent_step_id status stage liveness pid pid_started_at token_hash worktree branch options resolution prompt_outcome output usage cost_usd error log_path started_at ended_at legacy',
  wf_schedules: 'user_id owner workflow cron input enabled last_fired_at',
};
const TENANT = 'projects sessions history_files jobs idempotency_keys api_keys dedup_review graph_nodes graph_edges graph_sources capabilities cap_blobs overrides memories session_summaries wf_runs wf_schedules'.split(' ');
const CHILD = 'capability_versions cap_files cap_vectors wf_steps'.split(' ');

// shared inserts for constraint checks (each runs in a rolled-back transaction)
const U = '00000000-0000-0000-0000-0000000000';
const CAP = `insert into ctc.capabilities(id,namespace,kind,name,root_path) values ('${U}c1','user','skill','x','/r');`;
const VER = (n, id, labels) => `insert into ctc.capability_versions(id,cap_id,version,body_hash,description,labels) values ('${U}${id}','${U}c1',${n},'h','d','${labels}');`;
const PROJ = "insert into ctc.projects(id,name,root) values ('p1','a','/a');";
const RUNROW = (st = 'queued') => `insert into ctc.wf_runs(owner,status,trigger) values ('o','${st}','cli');`;
const tx = (db, sql) => psql(db.url, `begin;\n${sql}\nrollback;`);
const fails = (db, sql, re = /./) => { const r = tx(db, sql); return r.code !== 0 && re.test(r.err); };
const works = (db, sql) => tx(db, sql).code === 0;

// ================= D0 purpose
await check('D0', 'fresh database: ctc migrate builds the 22 tables and stamps version 5', () => {
  const d = migrated();
  const tables = rows(d.url, "select table_name from information_schema.tables where table_schema='ctc' and table_type='BASE TABLE' order by 1");
  const st = migrate(d, ['--status']);
  return [[22, 'schema ctc: version 5 of 5 (up to date)', 0], [tables.length, st.stdout.trim(), st.code]];
});
await check('D0', 'the extensions live in schema `extensions`', () => {
  const d = migrated();
  return [['unaccent', 'vector'], rows(d.url, "select e.extname from pg_extension e join pg_namespace n on n.oid=e.extnamespace where n.nspname='extensions' and e.extname in ('vector','unaccent') order by 1")];
});

// ================= D1 trust
await check('D1', 'a wrong password never appears in output', () => {
  const r = cli(['migrate'], { CTC_DATABASE_URL: 'postgresql://postgres:SECRETPW@127.0.0.1:18304/postgres' });
  return [[1, true, false], [r.code, has(/^ctc migrate: /m, r.stderr), r.out.includes('SECRETPW')]];
});
await check('D1', 'import works with a SELECT-only role on the source, which stays unchanged', () => {
  const src = pySource(); const ro = mkrole();
  q(src.url, `grant usage on schema ctc to ${ro.name}; grant select on all tables in schema ctc to ${ro.name}; grant usage on schema extensions to ${ro.name}`);
  const before = rows(src.url, "select md5(string_agg(m::text,'' order by id::text)) from ctc.memories m; select count(*) from ctc.graph_nodes");
  const tgt = migrated();
  const url = src.url.replace('postgres:ctcdev', `${ro.name}:${ro.pw}`);
  const r = imp({ url }, tgt);
  const after = rows(src.url, "select md5(string_agg(m::text,'' order by id::text)) from ctc.memories m; select count(*) from ctc.graph_nodes");
  return [[0, true, before], [r.code, r.json != null, after]];
});
await check('D1', 'bad schema name is refused before any SQL', () => {
  const d = mkdb('s');
  const r = migrate(d, ['--schema', 'ctc; drop schema public cascade']);
  const ns = rows(d.url, "select nspname from pg_namespace where nspname in ('ctc','public') order by 1");
  return [[1, true, ['public']], [r.code, has(/bad_schema_name/, r.out), ns]];
});

// ================= D2 limits
await check('D2', 'file names: bad name, 64-char schema', () => {
  const d = mkdb('n');
  const bad = migrate(d, ['--dir', dirWith({ '0001_Bad Name.sql': 'select 1;' })]);
  const long = migrate(d, ['--schema', 'a'.repeat(64)]);
  return [[1, true, 1, true], [bad.code, has(/bad_name/, bad.out), long.code, has(/bad_schema_name/, long.out)]];
});
await check('D2', 'advisory lock 7426001 is taken: a held lock delays the run', () => {
  const d = mkdb('lock');
  const holder = spawn('psql', [d.url, '-X', '-q', '-c', 'select pg_advisory_lock(7426001), pg_sleep(4)'], { stdio: 'ignore' });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
  const t0 = Date.now(); const r = migrate(d); const dt = Date.now() - t0;
  holder.kill();
  return [[0, true], [r.code, dt >= 2000]];
});
await check('D2', 'batches: 450 graph nodes import (more than one batch of 200)', () => {
  if (process.env.CTC_CHECKS_FAST === '1') return [0, 'SKIP'];
  const src = pySource(`insert into ctc.graph_nodes (user_id,project_id,id,kind,type,label,content_hash,origin) select 'local','p1','code:g'||g,'coding','function','f'||g,'h'||g,'graphify' from generate_series(1,450) g;`);
  const tgt = migrated(); const r = imp(src, tgt);
  return [[0, 453, 453], [r.code, entry(r.json, 'graph_nodes')?.imported, count(tgt, 'graph_nodes')]];
});

// ================= D3 output
await check('D3', 'default migrations folder has the five files', () => [['0001_base.sql', '0002_graph.sql', '0003_library.sql', '0004_memory.sql', '0005_runner.sql'], fs.readdirSync(path.join(ROOT, 'packages/shared/migrations')).filter((f) => f.endsWith('.sql')).sort()]);
await check('D3', 'apply output lines; second run says up to date', () => {
  const d = mkdb('o');
  const a = migrate(d).stdout.trim().split('\n'); const b = migrate(d).stdout.trim();
  return [['applied 0001_base.sql', 'schema ctc: version 5', 'schema ctc: version 5 (up to date)'], [a[0], a.at(-1), b]];
});
await check('D3', 'exit codes: usage 2, status on a missing schema 1', () => {
  const d = mkdb('e');
  const unk = cli(['migrate', '--nope'], { CTC_DATABASE_URL: d.url });
  const nosrc = cli(['migrate', '--from-python'], { CTC_DATABASE_URL: d.url });
  const st = migrate(d, ['--status']);
  const nourl = cli(['migrate']);
  return [[2, 2, 1, 'schema ctc: version 0 of 5 (behind)', 1], [unk.code, nosrc.code, st.code, st.stdout.trim(), nourl.code]];
});
await check('D3', 'error line shape: `ctc migrate: <code>: <detail>`', () => {
  const d = mkdb('f'); const r = migrate(d, ['--dir', dirWith({ '0002_x.sql': 'select 1;' })]);
  return [true, has(/^ctc migrate: gap: /m, r.stderr)];
});
await check('D3', 'ImportReport shape, entries in D13 order, dry-run flag', () => {
  const src = pySource(); const tgt = migrated(); const r = imp(src, tgt, ['--dry-run']);
  const j = r.json ?? {};
  return [[ORDER, ['database', 'schema'], ['table', 'from', 'source_rows', 'imported', 'skipped', 'skipped_by_reason', 'target_rows'].sort(), true],
    [(j.tables ?? []).map((t) => t.table), Object.keys(j.source ?? {}).sort(), Object.keys(j.tables?.[0] ?? {}).sort(), j.dryRun]];
});

// ================= D4 bad input
await check('D4', 'gap, duplicate and bad_name are all listed together', () => {
  const d = mkdb('g');
  const r = migrate(d, ['--dir', dirWith({ '0001_a.sql': 'select 1;', '0001_b.sql': 'select 1;', '0003_c.sql': 'select 1;', '0004_BAD.sql': 'select 1;', 'README.md': 'x' })]);
  return [[1, true, true, true], [r.code, has(/gap/, r.out), has(/duplicate/, r.out), has(/bad_name/, r.out)]];
});
await check('D4', 'checksum_mismatch applies nothing and leaves the stamp alone', () => {
  const d = mkdb('c'); const dir = dirWith({ '0001_a.sql': 'create table {schema}.t1(a int);' });
  migrate(d, ['--dir', dir]);
  const stamp = q(d.url, 'select checksum from ctc.schema_migrations where version=1');
  fs.writeFileSync(path.join(dir, '0001_a.sql'), 'create table {schema}.t1(a int, b int);');
  fs.writeFileSync(path.join(dir, '0002_b.sql'), 'create table {schema}.t2(a int);');
  const r = migrate(d, ['--dir', dir]);
  return [[1, true, stamp, null], [r.code, has(/checksum_mismatch/, r.out), q(d.url, 'select checksum from ctc.schema_migrations where version=1'), q(d.url, "select to_regclass('ctc.t2')") || null]];
});
await check('D4', 'database ahead of the files: schema_too_new', () => {
  const d = mkdb('t'); const dir = dirWith({ '0001_a.sql': 'select 1;', '0002_b.sql': 'select 1;' });
  migrate(d, ['--dir', dir]);
  const r = migrate(d, ['--dir', dirWith({ '0001_a.sql': 'select 1;' })]);
  return [[1, true], [r.code, has(/schema_too_new/, r.out)]];
});
await check('D4', 'failing statement: sql_failed, that file rolled back, earlier file kept', () => {
  const d = mkdb('x');
  const r = migrate(d, ['--dir', dirWith({ '0001_a.sql': 'create table {schema}.t1(a int);', '0002_b.sql': 'create table {schema}.t2(a int); select * from nonexistent_xyz;' })]);
  return [[1, true, '1', null], [r.code, has(/sql_failed: 0002_b\.sql/, r.out), q(d.url, 'select max(version) from ctc.schema_migrations'), q(d.url, "select to_regclass('ctc.t2')") || null]];
});
await check('D4', 'import pre-flight: not migrated target, same schema, bad source, unmapped value', () => {
  const src = pySource(); const bare = mkdb('bare');
  const behind = imp(src, bare);
  const same = cli(['migrate', '--from-python', '--source-url', src.url, '--source-schema', 'ctc'], { CTC_DATABASE_URL: src.url });
  const tgt = migrated();
  const nopy = imp(mkdb('empty'), tgt);
  const weird = pySource("update ctc.graph_nodes set origin='weird' where id='code:a_b'");
  const t2 = migrated(); const un = imp(weird, t2);
  return [[true, true, true, true, 0], [has(/schema_behind/, behind.out), has(/same_schema/, same.out), has(/bad_source/, nopy.out), has(/unmapped_value.*graph_nodes.*origin.*weird/s, un.out), count(t2, 'projects')]];
});

// ================= D5 odd but harmless
await check('D5', 'dry-run on a missing schema creates nothing', () => {
  const d = mkdb('dry'); const r = migrate(d, ['--dry-run']);
  return [[0, true, ''], [r.code, has(/0001_base\.sql/, r.out), q(d.url, "select nspname from pg_namespace where nspname='ctc'")]];
});
await check('D5', 'empty Python database imports as zeros; empty capability body is a valid file', () => {
  const tgt = migrated(); const r = imp(pySource('', false), tgt);
  const t2 = migrated(); const r2 = imp(pySource(), t2);
  return [[0, true, 0, 2, '0'], [r.code, (r.json?.tables ?? []).every((t) => t.imported === 0 && t.source_rows === 0), count(tgt, 'memories'), count(t2, 'cap_files'),
    q(t2.url, "select size from ctc.cap_blobs where hash='" + sha('') + "'")]];
});

// ================= D6 must never
await check('D6', 'import is all or nothing', () => {
  const src = pySource(); const tgt = migrated();
  q(tgt.url, 'drop table ctc.graph_edges');
  const r = imp(src, tgt);
  return [[1, true, 0, 0], [r.code, has(/import_failed/, r.out), count(tgt, 'projects'), count(tgt, 'memories')]];
});
await check('D6', 'migrations only create: no drop/truncate/delete/alter-drop', () => {
  const sql = fs.readdirSync(path.join(ROOT, 'packages/shared/migrations')).filter((f) => f.endsWith('.sql')).map((f) => read(`packages/shared/migrations/${f}`)).join('\n');
  return [[], sql.split('\n').filter((l) => /\b(drop\s+(table|schema|column|index|type|extension)|truncate|delete\s+from)\b/i.test(l.replace(/--.*$/, '')))];
});
await check('D6', 'a dead server fails fast', () => {
  const t0 = Date.now(); const r = cli(['migrate'], { CTC_DATABASE_URL: 'postgresql://postgres:x@127.0.0.1:1/postgres' }, { timeout: 30_000 });
  return [[1, true, true], [r.code, has(/^ctc migrate: /m, r.stderr), Date.now() - t0 < 12_000]];
});

// ================= D7 non-goals
await check('D7', 'import writes no archive files and no decisions/events/jobs tables exist', () => {
  const arch = path.join(TMP, 'arch'); fs.mkdirSync(arch);
  const src = pySource(); const tgt = migrated(); imp(src, tgt, ['--archive-dir', arch]);
  return [[0, []], [fs.readdirSync(arch).length, rows(tgt.url, "select table_name from information_schema.tables where table_schema='ctc' and table_name in ('decisions','events','graph_sources_old')")]];
});
await check('D7', 'no down migrations; config/ untouched', () => {
  const files = fs.readdirSync(path.join(ROOT, 'packages/shared/migrations'));
  const dirty = spawnSync('git', ['diff', '--stat', 'HEAD', '--', 'config'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  return [[[], ''], [files.filter((f) => /down|rollback/i.test(f)), dirty]];
});

// ================= D8 silence
await check('D8', 'an unknown extra source column is ignored', () => {
  const src = pySource('alter table ctc.memories add column zzz text'); const tgt = migrated(); const r = imp(src, tgt);
  return [[0, 4], [r.code, count(tgt, 'memories')]];
});

// ================= D9 scope: pg only under repositories; package wiring
await check('D9', 'pg imported only under packages/shared/src/repositories; deps and bin present', () => {
  const g = spawnSync('grep', ['-rlE', "from ['\"](pg|pgvector|kysely)['\"]|require\\(['\"]pg['\"]\\)", 'apps', 'packages', '--include=*.ts', '--exclude-dir=node_modules'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  const outside = g.filter((f) => !f.startsWith('packages/shared/src/repositories/'));
  const sp = JSON.parse(read('packages/shared/package.json')); const cp = JSON.parse(read('apps/cli/package.json'));
  return [[[], true, true, true], [outside, 'pg' in (sp.dependencies ?? {}), '@types/pg' in { ...sp.dependencies, ...sp.devDependencies }, Boolean(cp.bin?.ctc)]];
});

// ================= D10 schema inventory
await check('D10', 'columns per table = spec columns + the named extras, nothing else', () => {
  const d = migrated(); const bad = [];
  const got = {};
  for (const l of rows(d.url, "select table_name||' '||column_name from information_schema.columns where table_schema='ctc'")) { const [t, c] = l.split(' '); (got[t] ??= []).push(c); }
  for (const [t, cols] of Object.entries(COLS)) {
    const want = cols.split(' ').sort(), have = (got[t] ?? []).sort();
    if (JSON.stringify(want) !== JSON.stringify(have)) bad.push(`${t}: missing=${want.filter((c) => !have.includes(c))} extra=${have.filter((c) => !want.includes(c))}`);
  }
  bad.push(...Object.keys(got).filter((t) => !(t in COLS)).map((t) => `unexpected table ${t}`));
  return [[], bad];
});
await check('D10', 'tenant tables carry user_id not null default local; child tables do not; RLS on; vectors are 1024-d', () => {
  const d = migrated();
  const uid = Object.fromEntries(rows(d.url, "select table_name||' '||is_nullable||' '||coalesce(column_default,'') from information_schema.columns where table_schema='ctc' and column_name='user_id'").map((l) => [l.split(' ')[0], l.slice(l.indexOf(' ') + 1)]));
  const badTenant = TENANT.filter((t) => !(uid[t] ?? '').startsWith("NO 'local'::text"));
  const rls = rows(d.url, "select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='ctc' and relkind='r' and not relrowsecurity");
  const dims = rows(d.url, "select a.attrelid::regclass||'.'||a.attname||'='||a.atttypmod from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='ctc' and a.attname='embedding' and not a.attisdropped order by 1");
  return [[[], [], [], ['ctc.cap_vectors.embedding=1024', 'ctc.graph_nodes.embedding=1024', 'ctc.memories.embedding=1024', 'ctc.projects.embedding=1024']],
    [badTenant, CHILD.filter((t) => t in uid), rls, dims]];
});

// ================= D11 constraints and indexes
await check('D11', 'enum checks reject bad values, accept good ones', () => {
  const d = migrated();
  const cases = [
    [`${RUNROW('nope')}`, false], [`${RUNROW('running')}`, true],
    [`insert into ctc.jobs(queue,kind,status) values ('graph','k','dead');`, true], [`insert into ctc.jobs(queue,kind,status) values ('nope','k','done');`, false],
    [`${PROJ} insert into ctc.graph_nodes(id,project_id,kind,type,label,origin,content_hash) values ('n','p1','code','function','l','graphify','h');`, false],
    [`${PROJ} insert into ctc.graph_nodes(id,project_id,kind,type,label,origin,content_hash) values ('n','p1','code','function','l','ast','h');`, true],
    [`insert into ctc.graph_edges(project_id,src,dst,relation,confidence,origin) values ('p','a','b','calls','MAYBE','ast');`, false],
    [`insert into ctc.graph_edges(project_id,src,dst,relation,confidence,origin) values ('p','a','b','calls','AMBIGUOUS','review');`, true],
    [`${CAP.replace("'skill'", "'tool'")}`, false],
    [`${RUNROW()} insert into ctc.wf_steps(run_id,node_id,visit,status) select id,'n',1,'circuit_broken' from ctc.wf_runs;`, true],
    [`${RUNROW()} insert into ctc.wf_steps(run_id,node_id,visit,status) select id,'n',1,'cancelling' from ctc.wf_runs;`, false],
    [`${RUNROW()} insert into ctc.wf_steps(run_id,node_id,visit,status,stage) select id,'n',1,'queued','deploy' from ctc.wf_runs;`, false],
    [`${PROJ} insert into ctc.memories(scope,project_id,kind,text,hash) values ('global','p1','fact','t','h');`, false],
    [`${PROJ} insert into ctc.memories(scope,kind,text,hash) values ('project','fact','t','h');`, false],
  ];
  return [cases.map((c) => c[1]), cases.map((c) => works(d, c[0]))];
});
await check('D11', 'uniques: memory hash with NULL project, one running run per owner, step attempt, idempotency key per user', () => {
  const d = migrated();
  return [[true, true, true, true, true], [
    fails(d, "insert into ctc.memories(scope,kind,text,hash) values ('global','fact','a','h'),('global','fact','b','h');", /duplicate key/),
    fails(d, `${RUNROW('running')} ${RUNROW('running')}`, /duplicate key/),
    fails(d, `${RUNROW()} insert into ctc.wf_steps(run_id,node_id,visit,attempt,status) select id,'n',1,1,'queued' from ctc.wf_runs; insert into ctc.wf_steps(run_id,node_id,visit,attempt,status) select id,'n',1,1,'queued' from ctc.wf_runs;`, /duplicate key/),
    works(d, "insert into ctc.idempotency_keys(user_id,key,route,payload_hash,response) values ('a','k','r','h','{}'),('b','k','r','h','{}');"),
    fails(d, "insert into ctc.idempotency_keys(user_id,key,route,payload_hash,response) values ('a','k','r','h','{}'),('a','k','r','h','{}');", /duplicate key/),
  ]];
});
await check('D11', 'label rule: one version per label; moving a label in one transaction is allowed', () => {
  const d = migrated();
  return [[true, true], [fails(d, `${CAP} ${VER(1, 'v1', '{latest,production}')} ${VER(2, 'v2', '{production}')}`),
    works(d, `${CAP} ${VER(1, 'v1', '{latest,production}')} update ctc.capability_versions set labels='{latest}' where id='${U}v1'; ${VER(2, 'v2', '{production}')}`)]];
});
await check('D11', 'index definitions', () => {
  const d = migrated();
  const defs = rows(d.url, "select indexdef from pg_indexes where schemaname='ctc'").join('\n');
  const want = [
    /ON ctc\.capabilities .*UNIQUE|UNIQUE INDEX .* ON ctc\.capabilities .*\(user_id, namespace, kind, name\)/s,
    /ON ctc\.graph_nodes USING hnsw \(embedding extensions\.vector_cosine_ops\)/, /ON ctc\.graph_nodes USING gin \(to_tsvector\('simple'::regconfig, label\)\)/,
    /ON ctc\.graph_nodes USING btree \(user_id, project_id, type\)/,
    /ON ctc\.graph_edges USING btree \(.*src, relation\)/, /ON ctc\.graph_edges USING btree \(.*dst, relation\)/,
    /ON ctc\.capability_versions USING gin \(labels\)/, /ON ctc\.cap_vectors USING hnsw/,
    /UNIQUE INDEX .* ON ctc\.memories USING btree \(user_id, scope, project_id, hash\) NULLS NOT DISTINCT/, /ON ctc\.memories USING gin \(tsv\)/, /ON ctc\.memories USING hnsw/,
    /ON ctc\.memories USING btree \(user_id, scope, project_id\) WHERE \(deleted_at IS NULL\)/,
    /UNIQUE INDEX .* ON ctc\.wf_runs USING btree \(owner\) WHERE \(status = 'running'::text\)/,
    /UNIQUE INDEX .* ON ctc\.wf_steps USING btree \(run_id, node_id, visit, attempt\)/,
  ];
  return [[], want.filter((re) => !re.test(defs)).map(String)];
});

// ================= D12 runner semantics
await check('D12', 'two runners at once: both exit 0, five stamp rows, names and checksums recorded', async () => {
  const d = mkdb('par');
  const run = () => new Promise((res) => { const p = spawn('node', [path.join(ROOT, 'apps/cli/src/main.ts'), 'migrate'], { cwd: ROOT, env: { ...process.env, CTC_DATABASE_URL: d.url }, stdio: 'ignore' }); p.on('exit', (c) => res(c)); p.on('error', () => res(-1)); });
  const codes = await Promise.all([run(), run()]);
  const r = rows(d.url, "select version||':'||name from ctc.schema_migrations order by version");
  const file = fs.readdirSync(path.join(ROOT, 'packages/shared/migrations')).sort()[0];
  const sum = q(d.url, 'select checksum from ctc.schema_migrations where version=1');
  return [[[0, 0], 5, '1:' + file.replace(/^\d+_|\.sql$/g, ''), sha(fs.readFileSync(path.join(ROOT, 'packages/shared/migrations', file)))], [codes, r.length, r[0], sum]];
});
await check('D12', 'schema stamp: assertSchemaVersion refuses an older binary (CLI --status shows ahead)', () => {
  const d = mkdb('ahead'); migrate(d);
  q(d.url, "insert into ctc.schema_migrations(version,name,checksum) values (6,'future','x')");
  const st = migrate(d, ['--status']); const ap = migrate(d);
  return [[1, 'schema ctc: version 6 of 5 (ahead)', 1, true], [st.code, st.stdout.trim(), ap.code, has(/schema_too_new/, ap.out)]];
});

// ================= D13 mapping, D14 semantics (one import, many reads)
let IMP;
function importOnce() {
  if (IMP) return IMP;
  const src = pySource(); const tgt = migrated(); const arch = path.join(TMP, 'a13'); fs.mkdirSync(arch);
  IMP = { src, tgt, arch, r: imp(src, tgt, ['--archive-dir', arch]) };
  return IMP;
}
const sc = (v) => `'${v}'`;
await check('D13', 'projects, sessions', () => {
  const { tgt } = importOnce();
  return [['alpha|/w/alpha', 's1|t|main|hook|processed', 2], [q(tgt.url, "select name||'|'||root from ctc.projects where id='p1'"), q(tgt.url, "select id||'|'||title||'|'||git_branch||'|'||source||'|'||status from ctc.sessions where id='s1'"), count(tgt, 'sessions')]];
});
await check('D13', 'capabilities: deterministic id, version 1 with labels, file, blob, enrichment, root_path', () => {
  const { tgt } = importOnce();
  const body = 'Write tests first';
  return [[true, '1|{latest,production}|h1|{"name": "tdd", "description": "Test first"}', 'SKILL.md|' + sha(body), '/home/u/.claude/skills/tdd', 'S|["a", "b"]', body + '|17'], [
    q(tgt.url, "select id = md5('local|user|skill|tdd')::uuid from ctc.capabilities where name='tdd'"),
    q(tgt.url, "select v.version||'|'||v.labels||'|'||v.body_hash||'|'||v.frontmatter::text from ctc.capability_versions v join ctc.capabilities c on c.id=v.cap_id where c.name='tdd'"),
    q(tgt.url, "select f.path||'|'||f.blob_hash from ctc.cap_files f join ctc.capability_versions v on v.id=f.version_id join ctc.capabilities c on c.id=v.cap_id where c.name='tdd'"),
    q(tgt.url, "select root_path from ctc.capabilities where name='tdd'"),
    q(tgt.url, "select enrichment->>'summary'||'|'||(enrichment->'triggers')::text from ctc.capabilities where name='tdd'"),
    q(tgt.url, `select content||'|'||size from ctc.cap_blobs where hash='${sha(body)}'`)]];
});
await check('D13', 'cap_vectors, overrides, dedup_review', () => {
  const { tgt } = importOnce();
  return [[3, ['*:block', 'p1:pin'], 1], [count(tgt, 'cap_vectors'), rows(tgt.url, "select coalesce(project_id,'*')||':'||action from ctc.overrides order by 1"), count(tgt, 'dedup_review')]];
});
await check('D13', 'memories: recomputed hash, newest duplicate kept, superseded_by inverted', () => {
  const { tgt } = importOnce();
  const id = (n) => `00000000-0000-0000-0000-00000000000${n}`;
  return [[4, sha('use pnpm'), id(4), '0'], [count(tgt, 'memories'), q(tgt.url, `select hash from ctc.memories where id='${id(2)}'`),
    q(tgt.url, `select superseded_by from ctc.memories where id='${id(3)}'`), q(tgt.url, `select count(*) from ctc.memories where id='${id(1)}'`)]];
});
await check('D13', 'graph: kind, origin, source_location, ids verbatim; edge relations verbatim', () => {
  const { tgt } = importOnce();
  return [['code:a_b|code|ast|12', 'ctx:mem:1|context|session|', 'ast,commit,parser', 'calls,implemented_in,serves'], [
    q(tgt.url, "select id||'|'||kind||'|'||origin||'|'||coalesce(source_location,'') from ctc.graph_nodes where id='code:a_b'"),
    q(tgt.url, "select id||'|'||kind||'|'||origin||'|'||coalesce(source_location,'') from ctc.graph_nodes where id='ctx:mem:1'"),
    rows(tgt.url, 'select distinct origin from ctc.graph_edges order by 1').join(','), rows(tgt.url, 'select relation from ctc.graph_edges order by 1').join(',')]];
});
await check('D13', 'workflow runs and steps', () => {
  const { tgt } = importOnce();
  return [[true, '{"input": "go"}', 'user:tdd', '1|report|/wt|{"a": 1}'], [
    q(tgt.url, "select workflow_cap_id = md5('local|user|skill|tdd')::uuid from ctc.wf_runs where id=1"), q(tgt.url, 'select inputs::text from ctc.wf_runs where id=1'), q(tgt.url, "select legacy->>'workflow' from ctc.wf_runs where id=1"),
    q(tgt.url, "select attempt||'|'||stage||'|'||worktree||'|'||output::text from ctc.wf_steps where node_id='n1'")]];
});
await check('D13', 'not imported: graph_sources, decisions, events, jobs are by_design; archive warning when no archive', () => {
  const { r } = importOnce(); const j = r.json ?? {};
  const t = ['graph_sources', 'decisions', 'events', 'jobs'];
  return [[[0, 0, 0, 0], [2, 1, 1, 2], true], [t.map((x) => entry(j, x)?.imported ?? -1), t.map((x) => entry(j, x)?.skipped_by_reason?.by_design ?? -1), (j.warnings ?? []).some((w) => /archive_missing/.test(w))]];
});
await check('D14', 'numbers add up and match SQL counts', () => {
  const { tgt, src, r } = importOnce(); const bad = [];
  for (const t of r.json?.tables ?? []) {
    if (t.imported + t.skipped !== t.source_rows) bad.push(`${t.table}: ${t.imported}+${t.skipped}!=${t.source_rows}`);
    if (t.from === t.table && t.target_rows !== count(tgt, t.table)) bad.push(`${t.table}: target_rows ${t.target_rows}`);
    if (t.from === t.table && t.source_rows !== count(src, t.from)) bad.push(`${t.table}: source_rows ${t.source_rows}`);
  }
  const e = (t) => entry(r.json, t);
  return [[[], 5, 1, 2, 1], [bad, e('memories')?.source_rows, e('memories')?.skipped_by_reason?.duplicate_hash, e('overrides')?.imported, e('overrides')?.skipped_by_reason?.orphan]];
});
await check('D14', 'idempotent re-run imports nothing new; dry-run on a fresh target changes nothing', () => {
  const { src, tgt } = importOnce(); const snap = () => ORDER.slice(0, 11).map((t) => count(tgt, t));
  const before = snap(); const again = imp(src, tgt);
  const fresh = migrated(); const dry = imp(src, fresh, ['--dry-run']);
  return [[true, before, 0, 0, 2], [again.code === 0 && (again.json?.tables ?? []).every((t) => t.imported === 0), snap(), count(fresh, 'projects'), count(fresh, 'graph_nodes'),
    (dry.json?.tables ?? []).find((t) => t.table === 'projects')?.imported]];
});
await check('D14', 'identity sequences continue after the import', () => {
  const { tgt } = importOnce();
  return [[true, true], [works(tgt, "insert into ctc.wf_runs(owner,status,trigger) values ('o2','queued','cli');"), works(tgt, "insert into ctc.api_keys(key_hash,user_id) values ('k2','local');")]];
});
await check('D14', 'no archive_missing warning when the archive files are there', () => {
  const arch = path.join(TMP, 'a14'); fs.mkdirSync(arch);
  fs.writeFileSync(path.join(arch, 'decisions-2026.jsonl.gz'), ''); fs.writeFileSync(path.join(arch, 'events-2026.jsonl.gz'), '');
  const r = imp(importOnce().src, migrated(), ['--archive-dir', arch]);
  return [false, (r.json?.warnings ?? []).some((w) => /archive_missing/.test(w))];
});

// ================= D15 memoryHash
await check('D15', 'memoryHash normalizes NFKC, trim, whitespace, case', () => {
  const mod = path.join(ROOT, 'packages/shared/src/memory-hash/index.ts');
  const r = spawnSync('node', ['--input-type=module', '-e', `import {memoryHash as h} from ${JSON.stringify(mod)}; console.log([h('  Use\\tPNPM '), h('ｕｓｅ pnpm'), h('use pnpm'), h('use  pnpm now')].join(','))`], { encoding: 'utf8' });
  const a = sha('use pnpm'), b = sha('use pnpm now');
  return [`${a},${a},${a},${b}`, r.stdout.trim() || r.stderr.split('\n')[0]];
});

// ================= D16 tests and scratch rules
await check('D16', 'vitest DB tests run (none skipped) and leave no ctc_t12_ database behind', () => {
  if (FAST) return [0, 'SKIP'];
  const before = rows(ADMIN, "select datname from pg_database where datname like 'ctc_t12_%'").length;
  const r = spawnSync('pnpm', ['-C', 'packages/shared', 'test'], { cwd: ROOT, encoding: 'utf8', timeout: 600_000, env: { ...process.env, CTC_TEST_ADMIN_URL: ADMIN } });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const after = rows(ADMIN, "select datname from pg_database where datname like 'ctc_t12_%'").length;
  return [[0, false, after - before > 0 ? -1 : 0], [r.status, /skipped/i.test(out) && /\b[1-9]\d* skipped\b/.test(out), after - before > 0 ? -1 : 0]];
});

console.log(failed ? `checks: ${failed} FAIL` : 'checks: all PASS');
process.exit(failed ? 1 : 0);
