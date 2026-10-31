# Task: Write the numbered SQL migrations that create the TypeScript service's Postgres schema, the runner behind `ctc migrate`, and the one-time importer `ctc migrate --from-python`.

The TypeScript rewrite of ctc keeps all state in Postgres 17 + pgvector, schema `ctc`, built from numbered SQL files and stamped so an older binary refuses to start on a newer database. Today's Python service has its own schema and live data (capabilities and vectors, memories, the context graph, workflow runs); `ctc migrate --from-python` copies that data into the new tables once, without ever writing to or breaking the Python database. Connection URLs and the data being imported are untrusted for output (passwords never printed) and for SQL (values only through parameters). Work only against the scratch Postgres `ctc-dev-pg`; Supabase and the real `~/.claude` are off limits.

Public names (`@ctc/shared/repositories/admin`; full signatures in DECISIONS D3):

    loadMigrations(dir?) → Migration[]          migrate({url, schema?, dir?, dryRun?}) → {schema, before, after, applied, pending}
    schemaVersion({url, schema?}) → number      assertSchemaVersion({url, schema?, dir?}) → void   (throws MigrationError)
    importFromPython({targetUrl, targetSchema?, sourceUrl, sourceSchema?, dryRun?, archiveDir?}) → ImportReport
    class MigrationError { code }               memoryHash(text) → string   (@ctc/shared/memory-hash)
    CLI: node apps/cli/src/main.ts migrate [--schema S] [--dir DIR] [--dry-run] [--status] [--from-python --source-url U ...]

## How to work
1. `agent/t1-2-migrations/DECISIONS.md` is the behaviour contract. Implement exactly that.
2. `agent/t1-2-migrations/PROCESS.md` is the order of work.
3. Change only the files listed in D9 and new test files.

T1.1 (the pnpm workspace, `@ctc/shared/env`, Vitest, the ESLint ban on `pg` outside `packages/shared/src/repositories`) must already be in place. Python is read only; do not change it. Use the registry only to install `pg` and `@types/pg`.

## Done
`python3 agent/t1-2-migrations/selfcheck.py` prints `SELFCHECK: DONE`.
