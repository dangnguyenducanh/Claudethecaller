import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from './admin/index.ts';
import { exec, scratchUrl } from './scratch.ts';

/** What the repository code needs from the T1.2 migrations (D10). Checked on a schema built by the real migrations, with nothing added. */
const COLUMNS: Record<string, string[]> = {
  projects: ['user_id', 'id', 'root', 'profile_hash', 'name', 'created_at', 'last_active', 'graph_epoch', 'mem_epoch'],
  sessions: ['id', 'user_id', 'project_id', 'started_at', 'ended_at', 'model', 'tokens', 'transcript_path'],
  history_files: ['user_id', 'path', 'size', 'mtime', 'status'],
  jobs: ['id', 'user_id', 'queue', 'kind', 'status', 'progress', 'payload', 'result', 'error', 'attempts', 'created_at', 'updated_at'],
  idempotency_keys: ['user_id', 'key', 'route', 'payload_hash', 'response', 'created_at'],
  api_keys: ['id', 'user_id', 'key_hash', 'name', 'created_at', 'revoked_at'],
  dedup_review: ['id', 'user_id', 'a', 'b', 'similarity', 'status', 'at'],
  graph_nodes: ['user_id', 'project_id', 'id', 'kind', 'type', 'label', 'source_file', 'source_location', 'origin', 'content_hash', 'embedding', 'meta', 'text', 'updated_at'],
  graph_edges: ['user_id', 'project_id', 'src', 'dst', 'relation', 'confidence', 'score', 'origin', 'source_location'],
  graph_sources: ['user_id', 'project_id', 'file', 'content_hash', 'extractor_version', 'built_at_commit'],
  capabilities: ['id', 'user_id', 'namespace', 'kind', 'name', 'root_path', 'served_version', 'removed_at', 'enrichment'],
  capability_versions: ['id', 'cap_id', 'version', 'body_hash', 'description', 'frontmatter', 'labels', 'commit_message', 'created_at'],
  cap_files: ['version_id', 'path', 'blob_hash'],
  cap_blobs: ['user_id', 'hash', 'content', 'size'],
  cap_vectors: ['cap_id', 'text_hash', 'embedding', 'model'],
  overrides: ['user_id', 'project_id', 'cap_id', 'action', 'label', 'version'],
  memories: ['id', 'user_id', 'scope', 'project_id', 'kind', 'text', 'hash', 'source', 'superseded_by', 'confidence', 'pinned', 'reinforcement_dates', 'created_at', 'updated_at', 'last_used_at', 'use_count', 'deleted_at', 'embedding', 'tsv'],
  session_summaries: ['session_id', 'user_id', 'project_id', 'request', 'investigated', 'learned', 'completed', 'next_steps', 'notes', 'content_hash', 'created_at'],
  wf_runs: ['id', 'user_id', 'owner', 'workflow_cap_id', 'workflow_version', 'status', 'state', 'trigger', 'inputs', 'repo', 'base_branch', 'created_at', 'started_at', 'ended_at'],
  wf_steps: ['id', 'run_id', 'node_id', 'visit', 'attempt', 'retry_of_step_id', 'failure_count', 'parent_step_id', 'status', 'stage', 'liveness', 'pid', 'pid_started_at', 'token_hash', 'worktree', 'branch', 'options', 'resolution', 'prompt_outcome', 'output', 'usage', 'cost_usd', 'error', 'log_path', 'started_at', 'ended_at'],
  wf_schedules: ['user_id', 'owner', 'workflow', 'cron', 'input', 'enabled', 'last_fired_at'],
};

/** Keys and indexes that `on conflict (...)` clauses and the one-running-run rule rely on. */
const INDEXES: [table: string, pattern: RegExp][] = [
  ['projects', /UNIQUE INDEX projects_pkey .*\(user_id, id\)/],
  ['sessions', /UNIQUE INDEX sessions_pkey .*\(id\)/],
  ['history_files', /UNIQUE INDEX history_files_pkey .*\(user_id, path\)/],
  ['jobs', /UNIQUE INDEX jobs_pkey .*\(id\)/],
  ['idempotency_keys', /UNIQUE INDEX idempotency_keys_pkey .*\(user_id, key\)/],
  ['api_keys', /UNIQUE INDEX api_keys_key_hash_key .*\(key_hash\)/],
  ['dedup_review', /UNIQUE INDEX .*\(user_id, a, b\)/],
  ['graph_nodes', /UNIQUE INDEX graph_nodes_pkey .*\(user_id, project_id, id\)/],
  ['graph_edges', /UNIQUE INDEX graph_edges_pkey .*\(user_id, project_id, src, dst, relation\)/],
  ['graph_sources', /UNIQUE INDEX graph_sources_pkey .*\(user_id, project_id, file\)/],
  ['capabilities', /UNIQUE INDEX .*\(user_id, namespace, kind, name\)/],
  ['capability_versions', /UNIQUE INDEX .*\(cap_id, version\)/],
  ['cap_blobs', /UNIQUE INDEX cap_blobs_pkey .*\(user_id, hash\)/],
  ['cap_vectors', /UNIQUE INDEX cap_vectors_pkey .*\(cap_id, text_hash\)/],
  ['overrides', /UNIQUE INDEX .*\(user_id, project_id, cap_id\)/],
  ['memories', /UNIQUE INDEX memories_hash .*\(user_id, scope, project_id, hash\)/],
  ['session_summaries', /UNIQUE INDEX .*\(user_id, content_hash\)/],
  ['wf_runs', /UNIQUE INDEX wf_runs_one_running .*\(owner\) WHERE .*status.*running/],
  ['wf_steps', /UNIQUE INDEX .*\(run_id, node_id, visit, attempt\)/],
  ['wf_schedules', /UNIQUE INDEX wf_schedules_pkey .*\(user_id, owner, workflow\)/],
];

const url = scratchUrl();
const schema = `ctc_t13_${randomBytes(4).toString('hex')}`;
beforeAll(async () => {
  await migrate({ url, schema });
}, 60_000);
afterAll(async () => {
  await exec(url, `drop schema if exists "${schema}" cascade`);
});

describe('schema assumptions (D10)', () => {
  it('every column the repositories use exists', async () => {
    const res = await exec(url, `select table_name as t, column_name as c from information_schema.columns where table_schema = '${schema}'`);
    const have = new Set((res.rows as { t: string; c: string }[]).map((r) => `${r.t}.${r.c}`));
    const missing = Object.entries(COLUMNS).flatMap(([t, cols]) => cols.map((c) => `${t}.${c}`)).filter((k) => !have.has(k));
    expect(missing).toEqual([]);
  });

  it('every key and index that on-conflict clauses rely on exists', async () => {
    const res = await exec(url, `select tablename as t, indexdef as d from pg_indexes where schemaname = '${schema}'`);
    const defs = (res.rows as { t: string; d: string }[]).map((r) => ({ t: r.t, d: r.d.replaceAll(`"${schema}".`, '').replaceAll(`${schema}.`, '') }));
    const missing = INDEXES.filter(([t, p]) => !defs.some((x) => x.t === t && p.test(x.d))).map(([t, p]) => `${t}: ${p.source}`);
    expect(missing).toEqual([]);
  });

  it('sessions reach projects through the foreign key (user_id, project_id)', async () => {
    const res = await exec(url, `select pg_get_constraintdef(oid) as d from pg_constraint where contype = 'f' and conrelid = '"${schema}".sessions'::regclass`);
    expect((res.rows as { d: string }[]).some((r) => /FOREIGN KEY \(user_id, project_id\) REFERENCES .*projects\(user_id, id\)/.test(r.d))).toBe(true);
  });

  it('the saved fixture of information_schema.columns still matches the migrations', async () => {
    const res = await exec(url, `select table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema = '${schema}' and table_name <> 'schema_migrations' order by table_name, ordinal_position`);
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/schema-columns.json', import.meta.url), 'utf8')) as unknown;
    expect(res.rows).toEqual(fixture);
  });
});
