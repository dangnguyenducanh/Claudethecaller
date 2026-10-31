"""Archive the Python daemon's `decisions` and `events` tables to private jsonl.gz files.

Run by hand: python scripts/archive_telemetry.py [--url DSN] [--schema ctc] [--out DIR] [--dry-run] [--allow-supabase]
Nobody imports it.

Why it exists: spec 007 removes the adoption telemetry, so the TypeScript schema has no `decisions` or `events` tables. This script copies
both tables (one consistent snapshot) into `decisions-<date>.jsonl.gz`, `events-<date>.jsonl.gz` and `manifest-<date>.json` (row counts and
sha256) so nothing is lost when a later task drops them. The rows hold the owner's prompts, so files are 0600 and the directory 0700.

Deliberately NOT done: it never drops, truncates or deletes anything (T1.2 `ctc migrate --from-python` and T7.2 decide that after the archive
is verified), never writes to the database, never overwrites an archive, never reads other tables, and never touches Supabase without
`--allow-supabase`.

Exit codes: 0 ok; 2 usage or refusal; 3 cannot connect / query failed / table missing; 4 verification or file write failed; 5 target exists.
"""

from __future__ import annotations

import argparse
import datetime as dt
import decimal
import gzip
import hashlib
import json
import math
import os
import re
import sys
import uuid
import zlib

from psycopg.conninfo import conninfo_to_dict

BATCH = 1000  # rows per fetch of the server-side cursor; chosen by judgment, bounds memory
TABLES = ("decisions", "events")  # the two tables spec 007 drops (src/ctc/storage/schema.sql:88,97)
SCHEMA = "ctc"  # default schema name of schema.sql
OUT = "~/.claudethecaller/archive"  # spec 007 line 134
FILE_MODE = 0o600  # prompts are private
DIR_MODE = 0o700  # prompts are private
CONNECT_TIMEOUT_S = 10  # chosen by judgment
STATEMENT_TIMEOUT_MS = 300000  # chosen by judgment

_IDENT = re.compile(r"^[a-z_][a-z0-9_]*$")
_URL_PASSWORD = re.compile(r"([A-Za-z][A-Za-z0-9+.-]*://[^:/@\s]*):\S*@")
_KW_PASSWORD = re.compile(r"(password\s*=\s*)\S+", re.IGNORECASE)


def resolve_dsn(arg: str | None, env: dict | None = None) -> str | None:
    """--url, else CTC_ARCHIVE_DATABASE_URL, else CTC_DATABASE_URL, else None. Pure."""
    env = os.environ if env is None else env
    return arg or env.get("CTC_ARCHIVE_DATABASE_URL") or env.get("CTC_DATABASE_URL") or None


def mask_dsn(text: str) -> str:
    """Replace the password of every scheme://user:password@ substring (and password=... pairs) by ***. Pure; any text is accepted."""
    return _KW_PASSWORD.sub(r"\1***", _URL_PASSWORD.sub(r"\1:***@", text))


def source_label(dsn: str) -> str:
    """host:port/dbname without user, password or query; the port is omitted when the DSN has none. Pure."""
    d = conninfo_to_dict(dsn)
    return f"{d.get('host', '')}{f':{d['port']}' if d.get('port') else ''}/{d.get('dbname', '')}"


def to_jsonable(value: object) -> object:
    """Convert one database value to a JSON-safe one (D12). Returns a new object; never modifies `value`."""
    if isinstance(value, dt.datetime):
        value = value.replace(tzinfo=dt.UTC) if value.tzinfo is None else value.astimezone(dt.UTC)  # naive = UTC
        return value.isoformat().replace("+00:00", "Z")
    if isinstance(value, dt.date):
        return value.isoformat()
    if isinstance(value, float):
        return value if math.isfinite(value) else None  # JSON has no NaN or infinity
    if isinstance(value, (decimal.Decimal, uuid.UUID)):
        return str(value)
    if isinstance(value, (bytes, memoryview)):
        return "\\x" + bytes(value).hex()
    if isinstance(value, dict):
        return {k: to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_jsonable(v) for v in value]
    if value is None or isinstance(value, (int, str)):
        return value
    return str(value)  # judgment: an unknown type is kept as text rather than losing the row


def encode_row(columns: list[str], values: tuple | list) -> str:
    """One jsonl line (with the trailing newline): sorted keys, compact, non-ASCII kept, NaN already mapped to null."""
    obj = {c: to_jsonable(v) for c, v in zip(columns, values)}
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n"


def verify_archive(path: str | os.PathLike, rows: int) -> str:
    """Return the sha256 of the file bytes; ValueError when the gzip is unreadable, a line is not a JSON object, or the count differs."""
    n = 0
    try:
        with gzip.open(path, "rb") as f:
            for line in f:
                if not line.endswith(b"\n") or not isinstance(json.loads(line.decode("utf-8")), dict):
                    raise ValueError(f"line {n + 1} is not a JSON object line")
                n += 1
        with open(path, "rb") as f:
            digest = hashlib.sha256(f.read()).hexdigest()
    except (OSError, EOFError, zlib.error) as e:
        raise ValueError(f"unreadable archive: {e}") from e
    if n != rows:
        raise ValueError(f"{n} lines, expected {rows}")
    return digest


def _create(part: str, parts: list[str]) -> int:
    """Create `part` exclusively (0600) and only then record it in `parts`, so a file this run did not create is never removed."""
    fd = os.open(part, os.O_CREAT | os.O_EXCL | os.O_WRONLY, FILE_MODE)
    parts.append(part)
    os.fchmod(fd, FILE_MODE)
    return fd


def _dump(conn, schema: str, table: str, part: str, parts: list[str]) -> tuple[list[str], int | None, int | None]:
    """Stream one table in id order into the gzip file `part` (created exclusively, 0600). Returns (columns, min_id, max_id)."""
    fd = _create(part, parts)
    lo = hi = None
    with os.fdopen(fd, "wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as gz, conn.cursor(name=f"archive_{table}") as cur:
        cur.execute(f'select * from "{schema}"."{table}" order by id')
        cols = [c.name for c in cur.description]
        idx = cols.index("id")
        while rows := cur.fetchmany(BATCH):
            gz.write("".join(encode_row(cols, r) for r in rows).encode("utf-8"))
            lo = rows[0][idx] if lo is None else lo
            hi = rows[-1][idx]
    return cols, lo, hi


def _publish(part: str, final: str) -> None:
    os.link(part, final)  # fails if `final` exists, so an archive is never overwritten
    os.unlink(part)


def _fail(msg: str, code: int) -> int:
    print(" ".join(mask_dsn(msg).split()), file=sys.stderr)
    return code


def main(argv: list[str] | None = None) -> int:
    import psycopg
    from psycopg import IsolationLevel

    p = argparse.ArgumentParser(prog="archive_telemetry.py", description=__doc__.splitlines()[0])
    p.add_argument("--url")
    p.add_argument("--schema")
    p.add_argument("--out")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--allow-supabase", action="store_true")
    try:
        a = p.parse_args(argv)
    except SystemExit as e:
        return int(e.code or 0)

    dsn = resolve_dsn(a.url)
    if not dsn:
        return _fail("no database url: pass --url or set CTC_ARCHIVE_DATABASE_URL / CTC_DATABASE_URL", 2)
    if "supabase" in dsn.lower() and not a.allow_supabase:
        return _fail("refusing a Supabase url without --allow-supabase", 2)
    schema = a.schema or SCHEMA
    if not _IDENT.match(schema):
        return _fail(f"invalid schema name {schema!r}", 2)
    out = os.path.realpath(os.path.expanduser(a.out or OUT))
    d = out
    while True:
        if os.path.lexists(os.path.join(d, ".git")):
            return _fail(f"refusing --out inside a git repo ({d})", 2)
        if os.path.dirname(d) == d:
            break
        d = os.path.dirname(d)

    date = dt.datetime.now(dt.UTC).strftime("%Y%m%d")
    names = {t: f"{t}-{date}.jsonl.gz" for t in TABLES}
    manifest_name = f"manifest-{date}.json"
    parts: list[str] = []
    try:
        with psycopg.connect(dsn, connect_timeout=CONNECT_TIMEOUT_S) as conn:
            conn.isolation_level = IsolationLevel.REPEATABLE_READ
            conn.read_only = True
            conn.execute(f"set local statement_timeout = {int(STATEMENT_TIMEOUT_MS)}")
            counts = {t: conn.execute(f'select count(*) from "{schema}"."{t}"').fetchone()[0] for t in TABLES}
            if a.dry_run:
                for t in TABLES:
                    print(f"{t}: {counts[t]} rows")
                print(f"would write {out}")
                return 0
            if any(os.path.lexists(os.path.join(out, n)) for n in (*names.values(), manifest_name)):
                return _fail(f"an archive for {date} already exists in {out}; it is never overwritten", 5)
            os.makedirs(out, mode=DIR_MODE, exist_ok=True)
            info = {}
            for t in TABLES:
                part = os.path.join(out, names[t] + ".part")
                cols, lo, hi = _dump(conn, schema, t, part, parts)
                info[t] = {"file": names[t], "rows": counts[t], "sha256": verify_archive(part, counts[t]), "columns": cols, "min_id": lo, "max_id": hi}
        manifest = {"created_at": dt.datetime.now(dt.UTC).isoformat().replace("+00:00", "Z"), "source": source_label(dsn), "schema": schema,
                    "script_version": 1, "tables": info}
        mpart = os.path.join(out, manifest_name + ".part")
        fd = _create(mpart, parts)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(manifest, f, sort_keys=True, indent=1)
            f.write("\n")
        for t in TABLES:
            _publish(os.path.join(out, names[t] + ".part"), os.path.join(out, names[t]))
        _publish(mpart, os.path.join(out, manifest_name))  # manifest last
    except psycopg.Error as e:
        return _fail(f"database error: {e}", 3)
    except ValueError as e:
        return _fail(f"verification failed: {e}", 4)
    except OSError as e:  # judgment: a file error is reported like a failed verification, never as a traceback
        return _fail(f"file error: {e}", 4)
    finally:
        for part in parts:
            if os.path.lexists(part):
                os.unlink(part)

    for t in TABLES:
        print(f"{t}: {counts[t]} rows -> {os.path.join(out, names[t])}")
    print(f"manifest -> {os.path.join(out, manifest_name)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
