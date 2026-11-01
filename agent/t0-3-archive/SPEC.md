# Task: T0.3 archive the Python daemon's `decisions` and `events` tables to jsonl.gz before they are dropped

Spec 007 removes the adoption telemetry, so the TypeScript schema has no `decisions` or `events` tables. This script copies both tables into
private `.jsonl.gz` files (plus a manifest with row counts and sha256) so nothing is lost when a later task drops them. Callers: a person runs it
by hand. Untrusted: the output directory (never inside a git repo) and the source (never Supabase without an explicit flag, D1). The archived
rows hold the owner's prompts, so files are private (0600).

Public names (module `scripts/archive_telemetry.py`; a script, not a package: tests load it by path with importlib):

    BATCH: int; TABLES: tuple[str, ...]; SCHEMA: str; OUT: str; FILE_MODE: int; DIR_MODE: int; CONNECT_TIMEOUT_S: int; STATEMENT_TIMEOUT_MS: int
    resolve_dsn(arg: str | None, env: dict | None = None) -> str | None
    mask_dsn(text: str) -> str
    source_label(dsn: str) -> str
    to_jsonable(value: object) -> object
    encode_row(columns: list[str], values: tuple | list) -> str
    verify_archive(path: str | os.PathLike, rows: int) -> str          # returns sha256; ValueError on any mismatch
    main(argv: list[str] | None = None) -> int

## Environment facts (read from the producers; verify in PROCESS step 1)
- Tables: `src/ctc/storage/schema.sql:88-114` (`events`, `decisions`; schema name is templated as `{schema}`, default `ctc`); extra columns at :185, :292.
- Scratch Postgres: container `ctc-dev-pg` on `127.0.0.1:18304` (pgvector). Export `CTC_DATABASE_URL=<its URL>` (the orchestrator does; never a Supabase URL).
  `tests/conftest.py` has a `scratch` fixture (a throwaway `ctc_test_<hex>` schema with schema.sql applied, dropped after the session); use it, or create
  and drop your own throwaway schema. `psycopg` 3 is installed. The scratch `ctc` schema holds 12 decisions and 0 events (a stale copy).
- The real export reads Supabase and is run later, by the orchestrator, only after the owner agrees (`--allow-supabase`). You never run that.

## How to work
1. agent/t0-3-archive/DECISIONS.md is the behaviour contract. Implement exactly that.
2. agent/t0-3-archive/PROCESS.md is the order of work.
3. Change only `scripts/archive_telemetry.py` and new `tests/test_archive_telemetry*.py`. Never edit SPEC.md or anything under agent/.

## Done
`python agent/t0-3-archive/selfcheck.py` prints `SELFCHECK: DONE` (needs `CTC_DATABASE_URL` set to the scratch Postgres). The orchestrator also runs it with `--live`.
