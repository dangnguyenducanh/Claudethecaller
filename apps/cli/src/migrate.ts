/**
 * `ctc migrate`: applies the SQL migrations, reports the schema stamp, or imports the Python database once (`--from-python`).
 *
 * Called from: apps/cli/src/main.ts. Why: the operator builds and stamps the Postgres schema from the command line (spec.md:112).
 * Deliberately NOT done: any SQL here (the admin repository does it), printing a URL or password, a CLI framework.
 */
import { parseArgs } from 'node:util';
import { loadConfig } from '@ctc/shared/env';
import {
  importFromPython,
  loadMigrations,
  migrate,
  schemaVersion,
  type ImportReport,
} from '@ctc/shared/repositories/admin';

const USAGE =
  'usage: ctc migrate [--schema S] [--dir DIR] [--dry-run] | --status | --from-python --source-url U [--source-schema S] [--dry-run] [--json] [--archive-dir D]';

type Io = { out: (line: string) => void; err: (line: string) => void; env: Record<string, string | undefined> };

const OPTIONS = {
  schema: { type: 'string' },
  dir: { type: 'string' },
  'dry-run': { type: 'boolean' },
  status: { type: 'boolean' },
  'from-python': { type: 'boolean' },
  'source-url': { type: 'string' },
  'source-schema': { type: 'string' },
  json: { type: 'boolean' },
  'archive-dir': { type: 'string' },
} as const;

function formatReport(report: ImportReport): string[] {
  const rows = report.tables.map((t) => [t.table, t.from, t.source_rows, t.imported, t.skipped, t.target_rows].map(String));
  const header = ['table', 'from', 'source', 'imported', 'skipped', 'target'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] as string).length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i] as number)).join('  ').trimEnd();
  const skipped = report.tables.flatMap((t) => Object.entries(t.skipped_by_reason).map(([reason, n]) => `  ${t.table}: ${n} skipped (${reason})`));
  return [
    `${report.dryRun ? 'dry run: ' : ''}import ${report.source.database}.${report.source.schema} -> ${report.target.database}.${report.target.schema}`,
    line(header),
    ...rows.map(line),
    ...skipped,
    ...report.warnings.map((w) => `warning: ${w}`),
  ];
}

/** Runs the command; returns the exit code (0 ok, 1 failure, 2 usage). `argv` excludes `node` and the script. */
export async function runMigrate(argv: string[], io: Partial<Io> = {}): Promise<number> {
  const out = io.out ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const err = io.err ?? ((l: string) => void process.stderr.write(`${l}\n`));
  const env = io.env ?? process.env;
  const usage = (why: string): number => {
    err(`ctc migrate: ${why}\n${USAGE}`);
    return 2;
  };

  let args;
  try {
    args = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false, strict: true }).values;
  } catch (error) {
    return usage((error as Error).message);
  }
  const sourceUrl = args['source-url'] ?? (env['CTC_PYTHON_DATABASE_URL'] || undefined);
  if (args['from-python'] && args.status) return usage('--status cannot be combined with --from-python');
  if (args['from-python'] && !sourceUrl) return usage('--from-python needs --source-url or CTC_PYTHON_DATABASE_URL');

  try {
    const url = loadConfig({ env }).database_url;
    if (!url) {
      err('ctc migrate: CTC_DATABASE_URL is not set');
      return 1;
    }
    const schema = args.schema ?? 'ctc';
    const dir = args.dir;

    if (args['from-python']) {
      const report = await importFromPython({
        targetUrl: url,
        targetSchema: schema,
        sourceUrl: sourceUrl as string,
        ...(args['source-schema'] ? { sourceSchema: args['source-schema'] } : {}),
        ...(args['dry-run'] ? { dryRun: true } : {}),
        ...(args['archive-dir'] ? { archiveDir: args['archive-dir'] } : {}),
      });
      for (const l of args.json ? [JSON.stringify(report, null, 2)] : formatReport(report)) out(l);
      return 0;
    }

    if (args.status) {
      const latest = loadMigrations(dir).at(-1)?.version ?? 0;
      const have = await schemaVersion({ url, schema });
      const state = have === latest ? 'up to date' : have < latest ? 'behind' : 'ahead';
      out(`schema ${schema}: version ${have} of ${latest} (${state})`);
      return have === latest ? 0 : 1;
    }

    const result = await migrate({ url, schema, ...(dir ? { dir } : {}), ...(args['dry-run'] ? { dryRun: true } : {}) });
    const file = (m: { version: number; name: string }): string => `${String(m.version).padStart(4, '0')}_${m.name}.sql`;
    if (args['dry-run']) {
      for (const m of result.pending) out(`would apply ${file(m)}`);
      out(`schema ${schema}: version ${result.before}${result.pending.length ? ` (dry run, ${result.pending.length} pending)` : ' (up to date)'}`);
    } else {
      for (const m of result.applied) out(`applied ${file(m)}`);
      out(`schema ${schema}: version ${result.after}${result.applied.length ? '' : ' (up to date)'}`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    err(`ctc migrate: ${message}`);
    return 1;
  }
}
