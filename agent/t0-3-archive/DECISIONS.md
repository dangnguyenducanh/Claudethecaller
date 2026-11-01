# Decisions for scripts/archive_telemetry.py (T0.3)

Tags: FROM-OWNER (O#) = owner decision in the task brief; FROM-SPEC (spec.md line) = specs/007-ctc/spec.md; FROM-CALLERS (file:line) =
read in the Python producer or caller; YOUR-CHOICE = planner default, the owner reviews it. Spec line numbers are for specs/007-ctc/spec.md.

D0  Purpose and callers. A one-off export of the Python daemon's `decisions` and `events` tables before the TypeScript migration drops them:
    `python scripts/archive_telemetry.py [--url DSN] [--schema ctc] [--out DIR] [--dry-run] [--allow-supabase]`. Nobody imports it. The
    export is read later only by a person (the telemetry is out of scope in spec 007: no `/api/kpis`, no adoption KPI). Header must say:
    run by hand, why it exists, deliberately NOT done (D7: it never drops anything).
    FROM-SPEC (772: "T0.3 archive decisions + events | jsonl.gz written"; 134: "exported to ~/.claudethecaller/archive/*.jsonl.gz and dropped"; 35)
D1  Trust and privacy. `decisions.prompt` and `decisions.bundle` hold the owner's prompts, so the archive is private: every file is created with
    mode `0o600`, the directory with `0o700`, and `--out` is refused (exit 2) when it or any parent holds a `.git` entry (never inside a repo).
    The module prints counts and paths only, never row content, and masks passwords in every DSN it prints or raises (`mask_dsn`).
    Source DSN: `--url`, else env `CTC_ARCHIVE_DATABASE_URL`, else env `CTC_DATABASE_URL` (`resolve_dsn`); none -> exit 2. A DSN containing
    `supabase` is refused (exit 2, before any connection) unless `--allow-supabase` is given: the real export is a read of Supabase, which
    the owner approves explicitly (OPEN); all tests use the scratch Postgres. The schema name must match `^[a-z_][a-z0-9_]*$` (it is placed
    in SQL as an identifier), else exit 2. Table names come from the constant `TABLES`, never from input.
    FROM-OWNER (O7: Supabase untouched before T7.1); FROM-CALLERS (src/ctc/storage/schema.sql:97-114 prompt and bundle columns; scripts/check.sh:15 supabase rule); the 0600/0700 and .git rules YOUR-CHOICE
D2  Limits (module constants, read at call time): `BATCH = 1000` rows per fetch of the server-side cursor, `TABLES = ("decisions", "events")`,
    `SCHEMA = "ctc"`, `OUT = "~/.claudethecaller/archive"` (expanded with `~`), `FILE_MODE = 0o600`, `DIR_MODE = 0o700`, `CONNECT_TIMEOUT_S = 10`,
    `STATEMENT_TIMEOUT_MS = 300000`. `BATCH` bounds memory: the module never calls `fetchall` on a table.
    FROM-SPEC (134 the directory); the numbers YOUR-CHOICE
D3  Output, per run, in the output directory (UTC date `YYYYMMDD` taken when the run starts):
      decisions-<date>.jsonl.gz   events-<date>.jsonl.gz   manifest-<date>.json
    A `.jsonl.gz` file is gzip (`mtime=0`, so the same rows give the same bytes) of lines, one per row, ordered by `id` ascending, each line
    `json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)` + `\n`. `obj` has every column of the table
    (names from the cursor, nothing hard-coded, so a new column is carried) with values from `to_jsonable` (D12). manifest = JSON with
    `sort_keys=True, indent=1`: {"created_at" (UTC ISO), "source": `source_label(dsn)`, "schema", "script_version": 1, "tables": {"<table>":
    {"file", "rows", "sha256" (of the .gz bytes), "columns": [...], "min_id", "max_id"}}}; `min_id` and `max_id` are null for an empty table.
    FROM-SPEC (134: jsonl.gz); FROM-CALLERS (src/ctc/storage/schema.sql:88-94 events, :97-114 decisions, :185 `source`, :292 `graph_line`); layout YOUR-CHOICE
D4  Bad input and failure. `main(argv) -> int`, no `sys.exit` in helpers. 0 ok; 2 usage or refusal (D1); 3 cannot connect, a query fails, or a
    table does not exist (message masked, one line, no traceback; nothing is written); 4 verification failed (D9; nothing is renamed into place);
    5 a target file for today already exists in `--out` (the module never overwrites an archive: it may be the only copy; there is no `--force`).
    Files are written as `<name>.part` (mode 0o600 from the start) and renamed only after both tables verified; the manifest is renamed last; a
    failed run deletes its `.part` files. `verify_archive(path, rows) -> str` raises `ValueError` when the gzip is unreadable, a line is not a JSON
    object, or the line count differs from `rows`; it returns the sha256 of the file bytes.
    YOUR-CHOICE (codes follow T0.1 D4)
D5  Odd but harmless input stays valid: an empty table (a gzip with no lines, `rows` 0, `min_id`/`max_id` null: `events` is empty on the scratch database);
    NULL values (-> null); prompts with non-ASCII text, newlines or thousands of characters; jsonb with nested arrays and unicode; `real` NaN or
    infinity (-> null, because JSON has no NaN: `judgment:` comment); a naive `datetime` (treated as UTC, `judgment:`); a table with one row.
    YOUR-CHOICE
D6  Must never: write to the database (no INSERT, UPDATE, DELETE, DDL, temp table, `VACUUM`; the check runs the module against a DSN with
    `default_transaction_read_only=on` and expects exit 0); drop, truncate or delete anything; read tables other than `TABLES`; load a whole
    table into memory; write outside `--out`; overwrite an existing archive file; leave a `.part` file; hang (connect and statement timeouts);
    print row content or a password; follow `--out` into a git work tree.
    FROM-OWNER (O7, O9); YOUR-CHOICE (read-only DSN test)
D7  Non-goals: no dropping of `decisions` or `events` (T1.2 `ctc migrate --from-python` and T7.2 decide that after the archive is verified); no import
    into Postgres or the TypeScript app; no export of other tables (`sessions`, `memories`, `jobs`...); no filter by user, project or date; no upload,
    sync or retention policy; no encryption beyond file modes; no scheduling; no write to Supabase; no compaction of `bundle`/`stages`.
    FROM-SPEC (134, 772); YOUR-CHOICE (nothing but the export)
D8  Silence rule. Where this list says nothing, choose the more tolerant, less destructive behavior (refuse, keep the file, write less) and put a
    `judgment:` comment on that line.
    YOUR-CHOICE (template wording)
D9  Consistent snapshot and verification. Open one connection, `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, read `count(*)` of every table,
    then stream each table with a named cursor ordered by `id` in the same transaction (one snapshot for both tables, so a row inserted while the
    export runs is in neither file nor count). After writing a table, call `verify_archive(part_path, count)`; the count from the snapshot is the
    truth. `ORDER BY id` relies on both tables having an `id` primary key.
    FROM-CALLERS (src/ctc/storage/schema.sql:88, :97 `id bigserial primary key`); the isolation level YOUR-CHOICE
D10 The manifest is written last and only after both archives verified; its `sha256` values are the ones `verify_archive` returned. A later reader
    can recompute `sha256` of each `.gz` and compare. The manifest does not contain row content.
    YOUR-CHOICE
D11 DSN helpers. `resolve_dsn(arg, env) -> str | None` (D1 order). `mask_dsn(text) -> str`: replaces the password in every `scheme://user:password@`
    substring by `***` (user kept). `source_label(dsn) -> str` = `host:port/dbname` with no user, no password, no query string (port omitted
    when the DSN has none).
    YOUR-CHOICE
D12 JSON values, `to_jsonable(value)`: datetime with tz -> converted to UTC, `isoformat()` with `+00:00` replaced by `Z`; naive datetime -> as UTC;
    date -> `isoformat()`; Decimal -> `str`; UUID -> `str`; bytes and memoryview -> `"\\x"` + hex; float NaN or infinity -> None; dict and list
    -> recursed (dict keys unchanged); int, float, str, bool, None unchanged. `encode_row(columns, values) -> str` zips and dumps one line as D3.
    jsonb arrives already parsed from psycopg, so it is not parsed again.
    YOUR-CHOICE
D13 `--dry-run`: connect, take the snapshot counts, print exactly one line per table `<table>: <n> rows` and one line `would write <dir>`, create no
    directory and no file, exit 0. The refusals of D1 apply first.
    YOUR-CHOICE
D14 Output directory: `--out` default `OUT` expanded; created with `os.makedirs(mode=DIR_MODE, exist_ok=True)` only after the snapshot succeeded
    (a failed run leaves no directory); an existing directory keeps its mode. Files are opened with `os.open(..., O_CREAT | O_EXCL | O_WRONLY, FILE_MODE)`.
    YOUR-CHOICE
