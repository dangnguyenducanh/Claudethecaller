/**
 * One-time import of today's Python database (schema from src/ctc/storage/schema.sql) into the TypeScript schema.
 *
 * Called from: `ctc migrate --from-python` (apps/cli); T7.1 runs it against Supabase after the owner approves.
 * Why: capabilities, vectors, memories, the context graph and workflow runs are live data that must survive the rewrite
 * (spec.md:134, 773 "row counts match on a copy").
 * Deliberately NOT done: writing to the Python database (its connection is one read-only transaction), dropping or truncating anything in
 * the target, re-embedding vectors, archiving decisions/events (T0.3), importing jobs/decisions/events/graph_sources, partial imports.
 */
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path/posix';
import type pg from 'pg';
import { memoryHash } from '../../memory-hash/index.ts';
import { assertSchemaName, connect, firstLine, loadMigrations, MigrationError, maxVersion, readStamps, redact, type ErrorCode } from './migrate.ts';

export type TableReport = {
  table: string;
  from: string;
  source_rows: number;
  imported: number;
  skipped: number;
  skipped_by_reason: Record<string, number>;
  target_rows: number;
};

export type ImportReport = {
  source: { database: string; schema: string };
  target: { database: string; schema: string };
  dryRun: boolean;
  tables: TableReport[];
  warnings: string[];
};

type Row = Record<string, unknown>;
type Col = readonly [name: string, type: string];

/** FROM-SPEC spec.md:131 / chosen by judgment: rows per INSERT, far below Postgres' 65,535 parameter limit for the widest table. */
const BATCH = 200;
const REQUIRED_SOURCE_TABLES = ['projects', 'memories', 'capabilities'];
const OPTIONAL_SOURCE_TABLES = [
  'sessions', 'cap_vectors', 'overrides', 'dedup_review', 'graph_nodes', 'graph_edges', 'graph_sources', 'history_files', 'api_keys',
  'wf_runs', 'wf_steps', 'wf_schedules', 'decisions', 'events', 'jobs',
];
const IDENTITY_TABLES = ['wf_runs', 'wf_steps', 'api_keys', 'dedup_review'];

const ORIGIN: Record<string, string> = {
  graphify: 'ast', parser: 'parser', claude: 'claude', commit: 'commit', embed: 'parser', 'claude-mem': 'session', review: 'review', session: 'session',
};
const same = (values: string[]): Record<string, string> => Object.fromEntries(values.map((v) => [v, v]));
/** table.column -> accepted source value -> target value. */
const VALUE_MAPS: Record<string, Record<string, string>> = {
  'sessions.source': same(['hook', 'history']),
  'sessions.status': same(['pending', 'processed', 'failed']),
  'capabilities.kind': same(['skill', 'agent', 'command', 'workflow']),
  'overrides.action': { pin: 'pin', block: 'block', disable: 'block' },
  'dedup_review.status': same(['open', 'merged', 'kept_apart']),
  'memories.scope': same(['global', 'project']),
  'memories.kind': same(['preference', 'convention', 'fact', 'skill_outcome']),
  'graph_nodes.kind': { coding: 'code', context: 'context' },
  'graph_nodes.origin': ORIGIN,
  'graph_edges.confidence': same(['CONFIRMED', 'EXTRACTED', 'INFERRED', 'AMBIGUOUS', 'DROPPED']),
  'graph_edges.origin': ORIGIN,
  'history_files.status': same(['imported', 'skipped', 'failed']),
  'wf_runs.status': same(['queued', 'running', 'waiting', 'done', 'failed', 'cancelled', 'quota']),
  'wf_runs.trigger': same(['button', 'cli', 'api', 'schedule', 'mcp']),
  'wf_steps.status': same(['running', 'waiting', 'done', 'failed', 'timeout', 'cancelled', 'quota', 'skipped']),
};

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const uid = (r: Row): string => text(r['user_id']) ?? 'local';
const jsonText = (v: unknown): string | null => (v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v));
const jsonValue = (v: unknown): unknown => (typeof v === 'string' ? (JSON.parse(v) as unknown) : (v ?? null));
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
/** md5 hex is a valid uuid literal; the same expression in SQL (`md5(...)::uuid`) gives the same id. */
const uuidOf = (s: string): string => {
  const h = createHash('md5').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const q = (schema: string, table: string): string => `"${schema}"."${table}"`;
const mapped = (key: string, v: unknown): string => (VALUE_MAPS[key] as Record<string, string>)[String(v)] as string;

class Writer {
  entries: TableReport[] = [];
  db: pg.Client;
  schema: string;

  constructor(db: pg.Client, schema: string) {
    this.db = db;
    this.schema = schema;
  }

  /** Inserts `rows` in batches with `on conflict do nothing`; returns the ids (first column of `returning`) that were really inserted. */
  async insert(table: string, cols: Col[], rows: unknown[][], o: { system?: boolean; returning?: string } = {}): Promise<{ count: number; ids: string[] }> {
    let count = 0;
    const ids: string[] = [];
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const values = batch.map((_, r) => `(${cols.map(([, type], c) => `$${r * cols.length + c + 1}::${type}`).join(', ')})`).join(', ');
      const sql = `insert into ${q(this.schema, table)} (${cols.map(([n]) => n).join(', ')})${o.system ? ' overriding system value' : ''} values ${values} on conflict do nothing${o.returning ? ` returning ${o.returning}` : ''}`;
      const res = await this.db.query(sql, batch.flat().map((v) => (v === undefined ? null : v)));
      count += res.rowCount ?? 0;
      if (o.returning) ids.push(...res.rows.map((r: Row) => String(r[o.returning as string])));
    }
    return { count, ids };
  }

  record(table: string, from: string, sourceRows: number, imported: number, reasons: Record<string, number> = {}): void {
    const skipped = sourceRows - imported;
    const named = Object.values(reasons).reduce((a, b) => a + b, 0);
    const all = { ...reasons, ...(skipped - named > 0 ? { exists: skipped - named } : {}) };
    this.entries.push({
      table, from, source_rows: sourceRows, imported, skipped,
      skipped_by_reason: Object.fromEntries(Object.entries(all).filter(([, n]) => n > 0)), target_rows: 0,
    });
  }
}

async function databaseIdentity(db: pg.Client): Promise<{ name: string; id: string }> {
  const r = await db.query('select current_database() as name, inet_server_addr()::text as addr, inet_server_port() as port');
  const row = r.rows[0] as { name: string; addr: string | null; port: number | null };
  return { name: row.name, id: `${row.name}|${row.addr ?? ''}|${row.port ?? ''}` };
}

async function readAll(src: pg.Client, schema: string, table: string): Promise<Row[]> {
  const extra = table === 'memories' ? ', extract(epoch from updated_at)::text as _epoch' : '';
  return (await src.query(`select *${extra} from ${q(schema, table)}`)).rows as Row[];
}

function archiveWarnings(counts: Record<string, number>, archiveDir: string): string[] {
  let files: string[] = [];
  try {
    files = readdirSync(archiveDir);
  } catch {
    files = [];
  }
  return ['decisions', 'events']
    .filter((t) => (counts[t] ?? 0) > 0 && !files.some((f) => f.startsWith(t) && f.endsWith('.jsonl.gz')))
    .map((t) => `archive_missing: ${counts[t]} ${t} rows have no ${t}*.jsonl.gz in ${archiveDir}`);
}

/** Pre-flight on already-read rows: counts source values that D13 has no mapping for. */
function unmappedValues(data: Record<string, Row[]>): string[] {
  const counts = new Map<string, number>();
  for (const key of Object.keys(VALUE_MAPS)) {
    const [table, column] = key.split('.') as [string, string];
    for (const row of data[table] ?? []) {
      const value = row[column];
      if (value === undefined) continue;
      if (!Object.hasOwn(VALUE_MAPS[key] as object, String(value))) {
        const label = `${key} = ${JSON.stringify(String(value).slice(0, 60))}`;
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
  }
  return [...counts].map(([label, n]) => `${label} (${n} rows)`);
}

/**
 * Copies the Python database into the TypeScript schema in one transaction; with `dryRun` it runs the same code and rolls back.
 *
 * Trust: connection URLs are never put in an error or report; source rows reach SQL only as parameters.
 * Returns the per-table report; modifies only the target (insert, `on conflict do nothing`, sequence resets), never the source.
 * Bad input: pre-flight problems (bad_source, schema_behind, same_schema, unmapped_value) are all listed in one error before any write.
 */
export async function importFromPython(o: {
  targetUrl: string;
  targetSchema?: string;
  sourceUrl: string;
  sourceSchema?: string;
  dryRun?: boolean;
  archiveDir?: string;
}): Promise<ImportReport> {
  const targetSchema = o.targetSchema ?? 'ctc';
  const sourceSchema = o.sourceSchema ?? 'ctc';
  const dryRun = o.dryRun ?? false;
  assertSchemaName(targetSchema);
  assertSchemaName(sourceSchema);
  const archiveDir = o.archiveDir ?? join(homedir(), '.claudethecaller', 'archive');
  const src = await connect(o.sourceUrl, true);
  let tgt: pg.Client | undefined;
  let inTransaction = false;
  try {
    tgt = await connect(o.targetUrl);
    const [from, to] = [await databaseIdentity(src), await databaseIdentity(tgt)];
    const problems: { code: ErrorCode; detail: string }[] = [];
    if (from.id === to.id && sourceSchema === targetSchema) problems.push({ code: 'same_schema', detail: `source and target are both schema ${sourceSchema} in database ${from.name}` });

    const present = new Set(
      (await src.query('select table_name from information_schema.tables where table_schema = $1', [sourceSchema])).rows.map((r: { table_name: string }) => r.table_name),
    );
    const lacking = REQUIRED_SOURCE_TABLES.filter((t) => !present.has(t));
    if (lacking.length > 0) problems.push({ code: 'bad_source', detail: `source schema ${sourceSchema} lacks table(s) ${lacking.join(', ')}` });

    const latest = loadMigrations().at(-1)?.version ?? 0;
    const have = maxVersion(await readStamps(tgt, targetSchema));
    if (have < latest) problems.push({ code: 'schema_behind', detail: `target schema ${targetSchema} is at version ${have}, needs ${latest}; run: ctc migrate` });
    if (have > latest) problems.push({ code: 'schema_too_new', detail: `target schema ${targetSchema} is at version ${have}, this binary knows ${latest}` });

    const data: Record<string, Row[]> = {};
    if (lacking.length === 0) {
      for (const t of ['projects', 'memories', 'capabilities', ...OPTIONAL_SOURCE_TABLES.filter((t) => !['graph_sources', 'decisions', 'events', 'jobs'].includes(t))]) {
        data[t] = present.has(t) ? await readAll(src, sourceSchema, t) : [];
      }
      for (const detail of unmappedValues(data)) problems.push({ code: 'unmapped_value', detail });
    }
    const [firstProblem] = problems;
    if (firstProblem) {
      throw Object.assign(new MigrationError(firstProblem.code, firstProblem.detail), { message: problems.map((p) => `${p.code}: ${p.detail}`).join('\n') });
    }
    const counts: Record<string, number> = {};
    for (const t of ['graph_sources', 'decisions', 'events', 'jobs']) {
      counts[t] = present.has(t) ? Number((await src.query(`select count(*) as n from ${q(sourceSchema, t)}`)).rows[0].n) : 0;
    }

    await tgt.query('begin');
    inTransaction = true;
    const w = new Writer(tgt, targetSchema);
    const warnings: string[] = [];
    let current = '';
    try {
      current = 'import';
      await writeAll(w, tgt, data, counts, warnings, targetSchema, sourceSchema, dryRun, (t) => {
        current = t;
      });
    } catch (error) {
      if (error instanceof MigrationError) throw error;
      throw new MigrationError('import_failed', `${current}: ${redact(firstLine(error), o.sourceUrl, o.targetUrl)}`);
    }
    warnings.push(...archiveWarnings(counts, archiveDir));
    for (const e of w.entries) {
      if (e.table === 'decisions' || e.table === 'events') continue;
      e.target_rows = Number((await tgt.query(`select count(*) as n from ${q(targetSchema, e.table)}`)).rows[0].n);
    }
    await tgt.query(dryRun ? 'rollback' : 'commit');
    inTransaction = false;
    return { source: { database: from.name, schema: sourceSchema }, target: { database: to.name, schema: targetSchema }, dryRun, tables: w.entries, warnings };
  } catch (error) {
    if (inTransaction) await tgt?.query('rollback').catch(() => undefined);
    if (error instanceof MigrationError) throw error;
    throw new MigrationError('import_failed', redact(firstLine(error), o.sourceUrl, o.targetUrl));
  } finally {
    await src.end().catch(() => undefined);
    await tgt?.end().catch(() => undefined);
  }
}

/** The D13 mappings, in D13 order. Every write goes through `Writer.insert`; source values are only parameters. */
async function writeAll(
  w: Writer, db: pg.Client, data: Record<string, Row[]>, counts: Record<string, number>, warnings: string[],
  schema: string, sourceSchema: string, dryRun: boolean, at: (table: string) => void,
): Promise<void> {
  const rowsOf = (t: string): Row[] => data[t] ?? [];

  at('projects');
  const projects = rowsOf('projects');
  const p = await w.insert('projects',
    [['user_id', 'text'], ['id', 'text'], ['root', 'text'], ['profile_hash', 'text'], ['name', 'text'], ['embedding', 'extensions.vector'], ['created_at', 'timestamptz'], ['last_active', 'timestamptz']],
    projects.map((r) => [uid(r), r['id'], r['path'], r['profile_hash'], r['name'], r['embedding'], r['created_at'], r['last_active']]));
  w.record('projects', 'projects', projects.length, p.count);

  at('sessions');
  const sessions = rowsOf('sessions');
  const s = await w.insert('sessions',
    [['id', 'text'], ['user_id', 'text'], ['project_id', 'text'], ['title', 'text'], ['model', 'text'], ['started_at', 'timestamptz'], ['ended_at', 'timestamptz'], ['tokens', 'bigint'],
      ['source', 'text'], ['status', 'text'], ['git_branch', 'text'], ['transcript_path', 'text'], ['processed_at', 'timestamptz']],
    sessions.map((r) => [r['id'], uid(r), r['project_id'], r['title'], r['model'], r['started_at'], r['ended_at'], r['tokens'], r['source'], r['status'], r['git_branch'], r['transcript_path'], r['processed_at']]));
  w.record('sessions', 'sessions', sessions.length, s.count);
  const droppedSummaries = sessions.filter((r) => text(r['summary']) !== null && text(r['summary']) !== '').length;
  if (droppedSummaries > 0) warnings.push(`sessions.summary dropped for ${droppedSummaries} rows`);

  at('capabilities');
  const caps = rowsOf('capabilities');
  const capUuid = new Map<string, string>();
  for (const r of caps) capUuid.set(String(r['id']), uuidOf(`${uid(r)}|${r['namespace']}|${r['kind']}|${r['name']}`));
  const capIdOf = (r: Row): string => capUuid.get(String(r['id'])) as string;
  const c = await w.insert('capabilities',
    [['id', 'uuid'], ['user_id', 'text'], ['namespace', 'text'], ['kind', 'text'], ['name', 'text'], ['root_path', 'text'], ['served_version', 'int'], ['enrichment', 'jsonb']],
    caps.map((r) => [capIdOf(r), uid(r), r['namespace'], r['kind'], r['name'], dirname(String(r['path'])), 1,
      JSON.stringify({ summary: r['summary'] ?? null, triggers: r['triggers'] ?? [], enricher_version: r['enricher_version'] ?? null, cluster_id: r['cluster_id'] ?? null })]),
    { returning: 'id' });
  w.record('capabilities', 'capabilities', caps.length, c.count);

  // Versions and files only for capabilities created by this run: an existing capability keeps its own history.
  at('capability_versions');
  const created = new Set(c.ids);
  const fresh = caps.filter((r) => created.has(capIdOf(r)));
  const versionId = (r: Row): string => uuidOf(`${capIdOf(r)}|v1`);
  const v = await w.insert('capability_versions',
    [['id', 'uuid'], ['cap_id', 'uuid'], ['version', 'int'], ['body_hash', 'text'], ['description', 'text'], ['frontmatter', 'jsonb'], ['labels', 'text[]'], ['commit_message', 'text']],
    fresh.map((r) => [versionId(r), capIdOf(r), 1, r['hash'], r['description'], JSON.stringify({ name: r['name'], description: r['description'] }), ['latest', 'production'], 'imported from python']));
  w.record('capability_versions', 'capabilities', caps.length, v.count);

  at('cap_files');
  const bodyOf = (r: Row): string => text(r['body']) ?? '';
  const f = await w.insert('cap_files', [['version_id', 'uuid'], ['path', 'text'], ['blob_hash', 'text']],
    fresh.map((r) => [versionId(r), basename(String(r['path'])), sha256(bodyOf(r))]));
  w.record('cap_files', 'capabilities', caps.length, f.count);

  at('cap_blobs');
  const blobs = new Map<string, unknown[]>();
  for (const r of caps) blobs.set(`${uid(r)}|${sha256(bodyOf(r))}`, [uid(r), sha256(bodyOf(r)), bodyOf(r), Buffer.byteLength(bodyOf(r))]);
  const b = await w.insert('cap_blobs', [['user_id', 'text'], ['hash', 'text'], ['content', 'text'], ['size', 'int']], [...blobs.values()]);
  w.record('cap_blobs', 'capabilities', caps.length, b.count, { duplicate_hash: caps.length - blobs.size });

  at('cap_vectors');
  const vectors = rowsOf('cap_vectors');
  const vecOk = vectors.filter((r) => capUuid.has(String(r['cap_id'])));
  const cv = await w.insert('cap_vectors', [['cap_id', 'uuid'], ['text_hash', 'text'], ['embedding', 'extensions.vector'], ['model', 'text']],
    vecOk.map((r) => [capUuid.get(String(r['cap_id'])), r['text_hash'], r['embedding'], r['model']]));
  w.record('cap_vectors', 'cap_vectors', vectors.length, cv.count, { orphan: vectors.length - vecOk.length });

  at('overrides');
  const overrides = rowsOf('overrides');
  const ovOk = overrides.filter((r) => capUuid.has(String(r['cap_id'])));
  const ov = await w.insert('overrides',
    [['user_id', 'text'], ['project_id', 'text'], ['cap_id', 'uuid'], ['action', 'text']],
    ovOk.map((r) => [uid(r), r['project'] === '*' ? null : r['project'], capUuid.get(String(r['cap_id'])), mapped('overrides.action', r['action'])]));
  w.record('overrides', 'overrides', overrides.length, ov.count, { orphan: overrides.length - ovOk.length });

  at('dedup_review');
  const dedup = rowsOf('dedup_review');
  const d = await w.insert('dedup_review',
    [['id', 'bigint'], ['user_id', 'text'], ['a', 'text'], ['b', 'text'], ['similarity', 'real'], ['status', 'text'], ['at', 'timestamptz']],
    dedup.map((r) => [r['id'], uid(r), r['a'], r['b'], r['similarity'], r['status'], r['at']]));
  w.record('dedup_review', 'dedup_review', dedup.length, d.count);

  at('memories');
  await writeMemories(w, db, schema, rowsOf('memories'));

  at('graph_nodes');
  const nodes = rowsOf('graph_nodes');
  const n = await w.insert('graph_nodes',
    [['user_id', 'text'], ['project_id', 'text'], ['id', 'text'], ['kind', 'text'], ['type', 'text'], ['label', 'text'], ['text', 'text'], ['source_file', 'text'], ['source_location', 'text'],
      ['content_hash', 'text'], ['embedding', 'extensions.vector'], ['origin', 'text'], ['meta', 'jsonb'], ['updated_at', 'timestamptz']],
    nodes.map((r) => [uid(r), r['project_id'], r['id'], mapped('graph_nodes.kind', r['kind']), r['type'], r['label'], r['text'], r['source_file'], text(r['source_line']),
      r['content_hash'], r['embedding'], mapped('graph_nodes.origin', r['origin']), jsonText(r['meta']) ?? '{}', r['updated_at']]));
  w.record('graph_nodes', 'graph_nodes', nodes.length, n.count);
  const oddIds = nodes.filter((r) => r['kind'] === 'coding' && !String(r['id']).startsWith('code:')).length;
  if (oddIds > 0) warnings.push(`${oddIds} code ids not graphify-style, kept`);

  at('graph_edges');
  const edges = rowsOf('graph_edges');
  const e = await w.insert('graph_edges',
    [['user_id', 'text'], ['project_id', 'text'], ['src', 'text'], ['dst', 'text'], ['relation', 'text'], ['confidence', 'text'], ['score', 'real'], ['origin', 'text']],
    edges.map((r) => [uid(r), r['project_id'], r['src'], r['dst'], r['relation'], r['confidence'], r['score'], mapped('graph_edges.origin', r['origin'])]));
  w.record('graph_edges', 'graph_edges', edges.length, e.count);

  w.record('graph_sources', 'graph_sources', counts['graph_sources'] ?? 0, 0, { by_design: counts['graph_sources'] ?? 0 });

  at('history_files');
  const history = rowsOf('history_files');
  const h = await w.insert('history_files',
    [['user_id', 'text'], ['path', 'text'], ['session_id', 'text'], ['size', 'bigint'], ['mtime', 'bigint'], ['rows', 'int'], ['status', 'text'], ['error', 'text'], ['imported_at', 'timestamptz']],
    history.map((r) => [uid(r), r['path'], r['session_id'], r['size'], r['mtime'], r['rows'], r['status'], r['error'], r['imported_at']]));
  w.record('history_files', 'history_files', history.length, h.count);

  at('api_keys');
  const keys = rowsOf('api_keys');
  const k = await w.insert('api_keys',
    [['id', 'bigint'], ['key_hash', 'text'], ['user_id', 'text'], ['name', 'text'], ['created_at', 'timestamptz'], ['revoked_at', 'timestamptz']],
    keys.map((r) => [r['id'], r['key_hash'], r['user_id'], r['name'], r['created_at'], r['revoked_at']]));
  w.record('api_keys', 'api_keys', keys.length, k.count);

  at('wf_runs');
  const runs = rowsOf('wf_runs');
  const runById = new Map(runs.map((r) => [String(r['id']), r]));
  const wr = await w.insert('wf_runs',
    [['id', 'bigint'], ['user_id', 'text'], ['owner', 'text'], ['workflow_cap_id', 'uuid'], ['workflow_version', 'int'], ['status', 'text'], ['state', 'jsonb'], ['trigger', 'text'],
      ['inputs', 'jsonb'], ['repo', 'text'], ['base_branch', 'text'], ['created_at', 'timestamptz'], ['started_at', 'timestamptz'], ['ended_at', 'timestamptz'], ['legacy', 'jsonb']],
    runs.map((r) => [r['id'], uid(r), r['owner'], capUuid.get(String(r['workflow'])) ?? null, 1, r['status'], jsonText(r['state']) ?? '{}', r['trigger'],
      JSON.stringify(text(r['input']) ? { input: r['input'] } : {}), r['repo'], null, r['created_at'], r['started_at'], r['ended_at'],
      JSON.stringify({
        workflow: r['workflow'] ?? null, file_sha: r['file_sha'] ?? null, graph: jsonValue(r['graph']), base_sha: r['base_sha'] ?? null, pr_url: r['pr_url'] ?? null,
        auth: jsonValue(r['auth']), error: r['error'] ?? null, quota_resets_at: r['quota_resets_at'] ?? null, auto_resume: r['auto_resume'] ?? null,
        tokens: num(r['tokens']), worktree: r['worktree'] ?? null, branch: r['branch'] ?? null,
      })]),
    { system: true });
  w.record('wf_runs', 'wf_runs', runs.length, wr.count);

  at('wf_steps');
  const steps = rowsOf('wf_steps');
  const stepOk = steps.filter((r) => runById.has(String(r['run_id'])));
  const ws = await w.insert('wf_steps',
    [['id', 'bigint'], ['run_id', 'bigint'], ['node_id', 'text'], ['visit', 'int'], ['attempt', 'int'], ['failure_count', 'int'], ['status', 'text'], ['stage', 'text'], ['worktree', 'text'],
      ['branch', 'text'], ['output', 'jsonb'], ['usage', 'jsonb'], ['cost_usd', 'real'], ['error', 'text'], ['log_path', 'text'], ['started_at', 'timestamptz'], ['ended_at', 'timestamptz'], ['legacy', 'jsonb']],
    stepOk.map((r) => {
      const run = runById.get(String(r['run_id'])) as Row;
      return [r['id'], r['run_id'], r['node_id'], r['visit'], 1, 0, r['status'], 'report', run['worktree'] ?? null, run['branch'] ?? null, jsonText(r['output']), jsonText(r['usage']), r['cost_usd'],
        r['error'], r['log_path'], r['started_at'], r['ended_at'],
        JSON.stringify({
          kind: r['kind'] ?? null, input: r['input'] ?? null, session_id: r['session_id'] ?? null, num_turns: r['num_turns'] ?? null, permission_denials: jsonValue(r['permission_denials']),
          overage: r['overage'] ?? null, pre_sha: r['pre_sha'] ?? null, post_sha: r['post_sha'] ?? null, files: jsonValue(r['files']), diff: r['diff'] ?? null,
        })];
    }),
    { system: true });
  w.record('wf_steps', 'wf_steps', steps.length, ws.count, { orphan: steps.length - stepOk.length });

  at('wf_schedules');
  const schedules = rowsOf('wf_schedules');
  const sc = await w.insert('wf_schedules',
    [['user_id', 'text'], ['owner', 'text'], ['workflow', 'text'], ['cron', 'text'], ['input', 'text'], ['enabled', 'boolean'], ['last_fired_at', 'timestamptz']],
    schedules.map((r) => [uid(r), r['owner'], r['workflow'], r['cron'], r['input'], r['enabled'], r['last_fired_at']]));
  w.record('wf_schedules', 'wf_schedules', schedules.length, sc.count);

  // decisions and events have no target table, so `from` is schema-qualified to tell them apart from a 1:1 table copy.
  w.record('decisions', `${sourceSchema}.decisions`, counts['decisions'] ?? 0, 0, { by_design: counts['decisions'] ?? 0 });
  w.record('events', `${sourceSchema}.events`, counts['events'] ?? 0, 0, { by_design: counts['events'] ?? 0 });
  w.record('jobs', 'jobs', counts['jobs'] ?? 0, 0, { by_design: counts['jobs'] ?? 0 });

  if (!dryRun) {
    for (const t of IDENTITY_TABLES) {
      await db.query(`select setval(pg_get_serial_sequence($1, 'id'), max(id)) from ${q(schema, t)} having max(id) is not null`, [q(schema, t)]);
    }
  }
}

async function writeMemories(w: Writer, db: pg.Client, schema: string, allMemories: Row[]): Promise<void> {
  const memories = allMemories.filter((r) => (r['scope'] === 'global') === (r['project_id'] === null || r['project_id'] === undefined));
  const groups = new Map<string, Row[]>();
  const hashOf = new Map<string, string>();
  for (const r of memories) {
    const hash = memoryHash(String(r['text']));
    hashOf.set(String(r['id']), hash);
    const key = JSON.stringify([uid(r), r['scope'], r['project_id'] ?? null, hash]);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const live = (r: Row): number => (r['deleted_at'] === null || r['deleted_at'] === undefined ? 1 : 0);
  const winner = (rows: Row[]): Row =>
    [...rows].sort((a, b) => live(b) - live(a) || Number(b['_epoch']) - Number(a['_epoch']) || String(b['id']).localeCompare(String(a['id'])))[0] as Row;
  const keptOf = new Map<string, string>();
  const kept: Row[] = [];
  for (const rows of groups.values()) {
    const win = winner(rows);
    kept.push(win);
    for (const r of rows) keptOf.set(String(r['id']), String(win['id']));
  }
  const m = await w.insert('memories',
    [['id', 'uuid'], ['user_id', 'text'], ['scope', 'text'], ['project_id', 'text'], ['kind', 'text'], ['text', 'text'], ['hash', 'text'], ['source', 'jsonb'], ['confidence', 'real'],
      ['pinned', 'boolean'], ['created_at', 'timestamptz'], ['updated_at', 'timestamptz'], ['last_used_at', 'timestamptz'], ['use_count', 'int'], ['deleted_at', 'timestamptz'], ['embedding', 'extensions.vector']],
    kept.map((r) => [r['id'], uid(r), r['scope'], r['project_id'], r['kind'], r['text'], hashOf.get(String(r['id'])), jsonText(r['source']) ?? '{}', r['confidence'], r['pinned'],
      r['created_at'], r['updated_at'], r['last_used_at'], r['use_count'], r['deleted_at'], r['embedding']]),
    { returning: 'id' });
  w.record('memories', 'memories', allMemories.length, m.count, { orphan: allMemories.length - memories.length, duplicate_hash: memories.length - kept.length });

  // Python's `supersedes` (new -> old) becomes `superseded_by` (old -> new), pointing at kept rows only.
  const pointer = new Map<string, string>();
  for (const r of [...memories].sort((a, b) => Number(a['_epoch']) - Number(b['_epoch']))) {
    const old = r['supersedes'] === null || r['supersedes'] === undefined ? undefined : keptOf.get(String(r['supersedes']));
    const next = keptOf.get(String(r['id']));
    if (!old || !next || old === next) continue;
    let tail: string | undefined = next;
    while (tail && tail !== old) tail = pointer.get(tail);
    if (!tail) pointer.set(old, next);
  }
  const inserted = new Set(m.ids);
  const pairs = [...pointer].filter(([old]) => inserted.has(old));
  if (pairs.length > 0) {
    await db.query(
      `update ${q(schema, 'memories')} m set superseded_by = v.b from unnest($1::uuid[], $2::uuid[]) as v(a, b)
       where m.id = v.a and exists (select 1 from ${q(schema, 'memories')} p where p.id = v.b)`,
      [pairs.map(([a]) => a), pairs.map(([, bb]) => bb)],
    );
  }
}
