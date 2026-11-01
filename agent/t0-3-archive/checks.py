"""Checks for T0.3 (scripts/archive_telemetry.py): one runnable example per decision id D0..D14.
Prints `PASS D3 ...` or `FAIL D3 <expected> <got>`; exit 1 if any FAIL. Needs the project python (psycopg) and, for the database checks,
CTC_DATABASE_URL pointing at the scratch Postgres (never Supabase). Each database check builds its own throwaway schema t03_<hex> and drops it.
Own fixture values."""
from __future__ import annotations

import contextlib
import copy
import datetime as dt
import decimal
import gzip
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import stat
import sys
import tempfile
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
REPO = pathlib.Path(os.environ.get("CHECKS_REPO", ROOT))  # where the module is looked up (default: this repo)
MODULE = REPO / "scripts" / "archive_telemetry.py"
IDS = [f"D{i}" for i in range(15)]
CHECKS: dict = {}


class Fail(Exception):
    def __init__(self, expected, got):
        super().__init__(expected, got)
        self.expected, self.got = expected, got


def eq(expected, got):
    if expected != got:
        raise Fail(expected, got)


def check(did):
    def deco(fn):
        CHECKS[did] = fn
        return fn
    return deco


DDL = """
create schema {s};
create table {s}.decisions (id bigserial primary key, user_id text not null default 'local', session_id text not null, prompt text not null,
  abstained boolean not null, confidence real not null default 0, bundle jsonb not null, at timestamptz not null, graph_line text);
create table {s}.events (id bigserial primary key, session_id text not null, type text not null, payload jsonb not null default '{{}}', at timestamptz not null);
"""
LONG = "long " + "é" * 5000


class Db:
    """A throwaway schema on the scratch Postgres: 5 decisions, `events` rows of events. .dsn, .ro_dsn (default_transaction_read_only=on), .schema."""

    def __init__(self, events=3):
        import psycopg

        self.url = os.environ.get("CTC_DATABASE_URL", "")
        if not self.url or "supabase" in self.url:
            raise Fail("CTC_DATABASE_URL = scratch Postgres (not Supabase)", self.url and "supabase url" or "unset")
        self.schema, self.events = f"t03_{uuid.uuid4().hex[:8]}", events
        self.conn = psycopg.connect(self.url, autocommit=True)
        self.conn.execute(DDL.format(s=self.schema))
        d = self.conn
        s = self.schema
        for i, (prompt, at) in enumerate([("héllo wörld\nline2", "2026-10-21 03:04:05.123456+00"), ("second", "2026-10-22 10:00:00+07"), (LONG, "2026-10-23 00:00:00+00"),
                                          ("four", "2026-10-24 00:00:00+00"), ("five", "2026-10-25 00:00:00+00")], 1):
            d.execute(f"insert into {s}.decisions (session_id, prompt, abstained, confidence, bundle, at, graph_line) values (%s, %s, %s, %s, %s::jsonb, %s, %s)",
                      (f"s{i}", prompt, i % 2 == 0, 0.5, json.dumps({"steps": [{"cap_id": "a", "n": [1, 2]}], "ü": "x"}), at, None if i == 1 else f"line {i}"))
        for i in range(events):
            d.execute(f"insert into {s}.events (session_id, type, payload, at) values (%s, %s, %s::jsonb, %s)", (f"s{i}", "tool", json.dumps({"tool": "Edit", "i": i}), "2026-10-21 00:00:00+00"))
        sep = "&" if "?" in self.url else "?"
        self.dsn = self.url
        self.ro_dsn = f"{self.url}{sep}options=-c%20default_transaction_read_only%3Don"

    def counts(self):
        return tuple(self.conn.execute(f"select count(*) from {self.schema}.{t}").fetchone()[0] for t in ("decisions", "events"))

    def close(self):
        self.conn.execute(f"drop schema if exists {self.schema} cascade")
        self.conn.close()


@contextlib.contextmanager
def db(events=3):
    d = Db(events)
    try:
        yield d
    finally:
        d.close()


def run(mod, d, out, *extra, dsn=None):
    return mod.main(["--url", dsn or d.dsn, "--schema", d.schema, "--out", str(out), *extra])


def lines(path):
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return [json.loads(x) for x in f.read().splitlines()]


def one(out, pat):
    got = sorted(pathlib.Path(out).glob(pat))
    eq(1, len(got))
    return got[0]


@contextlib.contextmanager
def no_env():
    saved = {k: os.environ.pop(k, None) for k in ("CTC_ARCHIVE_DATABASE_URL", "CTC_DATABASE_URL")}
    try:
        yield
    finally:
        for k, v in saved.items():
            if v is not None:
                os.environ[k] = v


@check("D0")
def d0(mod):
    doc = (mod.__doc__ or "").lower()
    eq(True, callable(mod.main) and "archive" in doc and "drop" in doc and "not" in doc)


@check("D1")
def d1(mod):
    with tempfile.TemporaryDirectory() as t:
        t = pathlib.Path(t)
        eq(2, mod.main(["--url", "postgresql://u:p@x.supabase.co:5432/postgres", "--out", str(t / "o")]))  # refused before any connection
        eq(False, (t / "o").exists())
        eq(2, mod.main(["--url", "postgresql://u:p@127.0.0.1:9/x", "--schema", "ctc; drop table x", "--out", str(t / "o")]))
        (t / "repo" / ".git").mkdir(parents=True)
        eq(2, mod.main(["--url", "postgresql://u:p@127.0.0.1:9/x", "--out", str(t / "repo" / "sub" / "arch")]))
        eq("postgresql://u:***@h:5/d and postgresql://v:***@h2/d2", mod.mask_dsn("postgresql://u:secret@h:5/d and postgresql://v:pw2@h2/d2"))
    with db() as d, tempfile.TemporaryDirectory() as t:
        out = pathlib.Path(t) / "arch"
        eq(0, run(mod, d, out))
        eq(0o700, stat.S_IMODE(out.stat().st_mode))
        eq({0o600}, {stat.S_IMODE(p.stat().st_mode) for p in out.iterdir()})


@check("D2")
def d2(mod):
    eq((1000, ("decisions", "events"), "ctc", "~/.claudethecaller/archive", 0o600, 0o700, 10, 300000),
       (mod.BATCH, tuple(mod.TABLES), mod.SCHEMA, mod.OUT, mod.FILE_MODE, mod.DIR_MODE, mod.CONNECT_TIMEOUT_S, mod.STATEMENT_TIMEOUT_MS))
    with db() as d, tempfile.TemporaryDirectory() as t:
        mod.BATCH = 2  # read at call time: 5 rows come in 3 batches and stay in id order
        eq(0, run(mod, d, t + "/o"))
        eq([1, 2, 3, 4, 5], [r["id"] for r in lines(one(t + "/o", "decisions-*.jsonl.gz"))])


@check("D3")
def d3(mod):
    with db() as d, tempfile.TemporaryDirectory() as t:
        eq(0, run(mod, d, t + "/a"))
        eq(0, run(mod, d, t + "/b"))
        gz = one(t + "/a", "decisions-*.jsonl.gz")
        rows = lines(gz)
        eq({"id", "user_id", "session_id", "prompt", "abstained", "confidence", "bundle", "at", "graph_line"}, set(rows[0]))
        eq(("héllo wörld\nline2", "2026-10-21T03:04:05.123456Z", None, {"steps": [{"cap_id": "a", "n": [1, 2]}], "ü": "x"}),
           (rows[0]["prompt"], rows[0]["at"], rows[0]["graph_line"], rows[0]["bundle"]))
        eq("2026-10-22T03:00:00Z", rows[1]["at"])  # +07:00 converted to UTC
        eq(LONG, rows[2]["prompt"])
        raw = gzip.open(gz, "rt", encoding="utf-8").read().splitlines()[0]
        eq(True, raw.startswith('{"abstained":false,') and ", " not in raw.split('"prompt"')[0] and "ü" in raw)  # sorted keys, compact, ensure_ascii False
        eq(gz.read_bytes(), one(t + "/b", "decisions-*.jsonl.gz").read_bytes())  # mtime 0: same rows, same bytes
        m = json.loads(one(t + "/a", "manifest-*.json").read_text())
        eq({"created_at", "source", "schema", "script_version", "tables"}, set(m))
        eq({"file", "rows", "sha256", "columns", "min_id", "max_id"}, set(m["tables"]["decisions"]))
        eq((5, 1, 5, 3), (m["tables"]["decisions"]["rows"], m["tables"]["decisions"]["min_id"], m["tables"]["decisions"]["max_id"], m["tables"]["events"]["rows"]))
        eq(["decisions", "events"], sorted(m["tables"]))


@check("D4")
def d4(mod):
    with no_env(), tempfile.TemporaryDirectory() as t:
        eq(2, mod.main(["--out", t + "/o"]))  # no DSN anywhere
        eq(3, mod.main(["--url", "postgresql://u:p@127.0.0.1:9/x", "--out", t + "/o"]))  # nothing listens on port 9
        eq(False, pathlib.Path(t, "o").exists())
    with db() as d, tempfile.TemporaryDirectory() as t:
        eq(3, mod.main(["--url", d.dsn, "--schema", "t03_missing", "--out", t + "/n"]))  # table does not exist
        eq(False, pathlib.Path(t, "n").exists())
        eq(0, run(mod, d, t + "/o"))
        before = {p.name: p.read_bytes() for p in pathlib.Path(t, "o").iterdir()}
        eq(5, run(mod, d, t + "/o"))  # never overwrites
        eq(before, {p.name: p.read_bytes() for p in pathlib.Path(t, "o").iterdir()})
        eq([], sorted(p.name for p in pathlib.Path(t, "o").glob("*.part")))
    with tempfile.TemporaryDirectory() as t:
        p = pathlib.Path(t) / "x.jsonl.gz"
        p.write_bytes(gzip.compress(b'{"a":1}\n{"a":2}\n'))
        eq(hashlib.sha256(p.read_bytes()).hexdigest(), mod.verify_archive(p, 2))
        for bad_rows in (3, 1):
            try:
                mod.verify_archive(p, bad_rows)
                raise Fail("ValueError", "no error")
            except ValueError:
                pass
        p.write_bytes(gzip.compress(b'{"a":1}\nnot json\n'))
        for rows in (2,):
            try:
                mod.verify_archive(p, rows)
                raise Fail("ValueError", "no error")
            except ValueError:
                pass
        p.write_bytes(b"not gzip at all")
        try:
            mod.verify_archive(p, 0)
            raise Fail("ValueError", "no error")
        except ValueError:
            pass


@check("D5")
def d5(mod):
    with db(events=0) as d, tempfile.TemporaryDirectory() as t:
        eq(0, run(mod, d, t + "/o"))
        ev = one(t + "/o", "events-*.jsonl.gz")
        eq([], lines(ev))
        m = json.loads(one(t + "/o", "manifest-*.json").read_text())["tables"]["events"]
        eq((0, None, None), (m["rows"], m["min_id"], m["max_id"]))
    eq(None, mod.to_jsonable(float("nan")))
    eq(None, mod.to_jsonable(float("inf")))
    eq("2026-01-02T03:04:05Z", mod.to_jsonable(dt.datetime(2026, 1, 2, 3, 4, 5)))  # naive = UTC
    eq('{"a":null,"b":"ü\\n"}\n', mod.encode_row(["b", "a"], ("ü\n", float("nan"))))


@check("D6")
def d6(mod):
    with db() as d, tempfile.TemporaryDirectory() as t:
        before = d.counts()
        eq(0, run(mod, d, t + "/o", dsn=d.ro_dsn))  # the server rejects every write on this DSN: the module wrote nothing
        eq(before, d.counts())
        eq([], sorted(p.name for p in pathlib.Path(t, "o").glob("*.part")))


@check("D7")
def d7(mod):
    with db() as d, tempfile.TemporaryDirectory() as t:
        eq(0, run(mod, d, t + "/o"))
        eq((5, 3), d.counts())  # nothing dropped or deleted
        names = sorted(p.name.split("-")[0] for p in pathlib.Path(t, "o").iterdir())
        eq(["decisions", "events", "manifest"], names)  # only the two tables and the manifest
        exists = d.conn.execute("select count(*) from information_schema.tables where table_schema = %s", (d.schema,)).fetchone()[0]
        eq(2, exists)


@check("D8")
def d8(mod):
    eq("1.50", mod.to_jsonable(decimal.Decimal("1.50")))
    u = uuid.UUID("12345678-1234-5678-1234-567812345678")
    eq("12345678-1234-5678-1234-567812345678", mod.to_jsonable(u))
    eq("\\x01ff", mod.to_jsonable(memoryview(b"\x01\xff")))
    eq("\\x01ff", mod.to_jsonable(b"\x01\xff"))


@check("D9")
def d9(mod):
    with db() as d, tempfile.TemporaryDirectory() as t:
        eq(0, run(mod, d, t + "/o"))
        m = json.loads(one(t + "/o", "manifest-*.json").read_text())["tables"]
        for tab, n in (("decisions", 5), ("events", 3)):
            gz = one(t + "/o", f"{tab}-*.jsonl.gz")
            eq(n, len(lines(gz)))
            eq((n, mod.verify_archive(gz, n)), (m[tab]["rows"], m[tab]["sha256"]))


@check("D10")
def d10(mod):
    with db() as d, tempfile.TemporaryDirectory() as t:
        eq(0, run(mod, d, t + "/o"))
        m = json.loads(one(t + "/o", "manifest-*.json").read_text())["tables"]
        eq({hashlib.sha256(one(t + "/o", f"{tab}-*.jsonl.gz").read_bytes()).hexdigest() for tab in m}, {v["sha256"] for v in m.values()})
        eq(True, "héllo" not in one(t + "/o", "manifest-*.json").read_text())  # no row content in the manifest
        eq(True, m["decisions"]["file"].startswith("decisions-") and m["decisions"]["file"].endswith(".jsonl.gz"))


@check("D11")
def d11(mod):
    env = {"CTC_DATABASE_URL": "postgresql://a@h/db1", "CTC_ARCHIVE_DATABASE_URL": "postgresql://b@h/db2"}
    eq("postgresql://x@h/db0", mod.resolve_dsn("postgresql://x@h/db0", env))
    eq("postgresql://b@h/db2", mod.resolve_dsn(None, env))
    eq("postgresql://a@h/db1", mod.resolve_dsn(None, {"CTC_DATABASE_URL": "postgresql://a@h/db1"}))
    eq(None, mod.resolve_dsn(None, {}))
    eq("db.example:5433/mydb", mod.source_label("postgresql://u:p@db.example:5433/mydb?sslmode=require"))
    eq("db.example/mydb", mod.source_label("postgresql://u:p@db.example/mydb"))


@check("D12")
def d12(mod):
    eq("2026-10-22T03:00:00Z", mod.to_jsonable(dt.datetime(2026, 10, 22, 10, 0, tzinfo=dt.timezone(dt.timedelta(hours=7)))))
    eq("2026-10-21T03:04:05.123456Z", mod.to_jsonable(dt.datetime(2026, 10, 21, 3, 4, 5, 123456, tzinfo=dt.timezone.utc)))
    eq("2026-10-21", mod.to_jsonable(dt.date(2026, 10, 21)))
    v = {"a": [dt.date(2026, 1, 1), {"b": decimal.Decimal("2")}], "n": 1, "f": 1.5, "s": "x", "t": True, "z": None}
    before = copy.deepcopy(v)
    eq({"a": ["2026-01-01", {"b": "2"}], "n": 1, "f": 1.5, "s": "x", "t": True, "z": None}, mod.to_jsonable(v))
    eq(before, v)
    eq('{"a":1,"b":"x"}\n', mod.encode_row(["b", "a"], ("x", 1)))


@check("D13")
def d13(mod):
    with db() as d, tempfile.TemporaryDirectory() as t:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = run(mod, d, t + "/o", "--dry-run")
        eq(0, code)
        out = buf.getvalue().splitlines()
        eq(True, "decisions: 5 rows" in out and "events: 3 rows" in out and any(x.startswith("would write ") for x in out))
        eq(False, pathlib.Path(t, "o").exists())
        eq(False, any("héllo" in x for x in out))


@check("D14")
def d14(mod):
    with db() as d, tempfile.TemporaryDirectory() as t:
        out = pathlib.Path(t) / "a" / "b" / "arch"
        eq(0, run(mod, d, out))
        eq(0o700, stat.S_IMODE(out.stat().st_mode))
        existing = pathlib.Path(t) / "keep"
        existing.mkdir(mode=0o755)
        existing.chmod(0o755)
        eq(0, run(mod, d, existing))
        eq(0o755, stat.S_IMODE(existing.stat().st_mode))  # an existing directory keeps its mode


def main() -> int:
    try:
        spec = importlib.util.spec_from_file_location("archive_telemetry", MODULE)
        if spec is None or spec.loader is None or not MODULE.exists():
            raise ImportError(f"{MODULE} not found")
        mod = importlib.util.module_from_spec(spec)
        sys.modules["archive_telemetry"] = mod
        spec.loader.exec_module(mod)
        err = None
    except BaseException as e:  # noqa: BLE001 - module not built yet is the expected state before the coder runs
        mod, err = None, f"{type(e).__name__}: {e}"
    bad = 0
    snap = {k: copy.copy(v) for k, v in vars(mod).items() if k.isupper()} if mod else {}  # constants a check changes are restored after it
    for did in IDS:
        if mod is None:
            print(f"FAIL {did} scripts/archive_telemetry.py importable | {err}")
            bad += 1
            continue
        try:
            CHECKS[did](mod)
            print(f"PASS {did}")
        except Fail as f:
            print(f"FAIL {did} expected={f.expected!r:.300} got={f.got!r:.300}")
            bad += 1
        except BaseException as e:  # noqa: BLE001 - a crash is a FAIL, not a crash of the checker
            print(f"FAIL {did} no exception | {type(e).__name__}: {str(e)[:300]}")
            bad += 1
        finally:
            vars(mod).update(snap)
    print(f"checks: {len(IDS) - bad}/{len(IDS)} pass")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
