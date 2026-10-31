"""scripts/archive_telemetry.py (T0.3): the jsonl.gz archive of `decisions` and `events`. DB tests use a throwaway schema on the scratch Postgres."""

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
import uuid

import psycopg
import pytest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "archive_telemetry.py"
DDL = """
create schema {s};
create table {s}.decisions (id bigserial primary key, session_id text not null, prompt text not null, confidence real not null,
  bundle jsonb not null, at timestamptz not null, graph_line text);
create table {s}.events (id bigserial primary key, session_id text not null, payload jsonb not null default '{{}}', at timestamptz not null);
"""
PROMPT = "héllo\nwörld " + "é" * 3000


@pytest.fixture
def mod():
    spec = importlib.util.spec_from_file_location("archive_telemetry_under_test", SCRIPT)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


@pytest.fixture
def pg():
    url = os.environ.get("CTC_DATABASE_URL", "")
    if not url or "supabase" in url:
        pytest.skip("needs the scratch Postgres in CTC_DATABASE_URL")
    schema = f"t03_{uuid.uuid4().hex[:8]}"
    conn = psycopg.connect(url, autocommit=True)
    conn.execute(DDL.format(s=schema))
    for i in range(1, 6):
        conn.execute(f"insert into {schema}.decisions (session_id, prompt, confidence, bundle, at, graph_line) values (%s, %s, %s, %s::jsonb, %s, %s)",
                     (f"s{i}", PROMPT if i == 3 else f"p{i}", "NaN" if i == 2 else 0.5, json.dumps({"steps": [[1, 2]], "ü": "x"}),
                      "2026-10-22 10:00:00+07" if i == 1 else "2026-10-23 00:00:00+00", None if i == 1 else "line"))
    for i in range(3):
        conn.execute(f"insert into {schema}.events (session_id, payload, at) values ('s', %s::jsonb, now())", (json.dumps({"i": i}),))
    ro = f"{url}{'&' if '?' in url else '?'}options=-c%20default_transaction_read_only%3Don"
    try:
        yield type("Pg", (), {"url": url, "ro": ro, "schema": schema, "conn": conn})
    finally:
        conn.execute(f"drop schema if exists {schema} cascade")
        conn.close()


def run(mod, pg, out, *extra, dsn=None):
    return mod.main(["--url", dsn or pg.url, "--schema", pg.schema, "--out", str(out), *extra])


def rows(path):
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return [json.loads(x) for x in f.read().splitlines()]


def one(out, pattern):
    (p,) = pathlib.Path(out).glob(pattern)
    return p


def counts(pg):
    return [pg.conn.execute(f"select count(*) from {pg.schema}.{t}").fetchone()[0] for t in ("decisions", "events")]


# --- pure helpers (D11, D12) ---


def test_defaults_pinned(mod):
    assert (mod.BATCH, mod.TABLES, mod.SCHEMA, mod.OUT, mod.FILE_MODE, mod.DIR_MODE, mod.CONNECT_TIMEOUT_S, mod.STATEMENT_TIMEOUT_MS) == (
        1000, ("decisions", "events"), "ctc", "~/.claudethecaller/archive", 0o600, 0o700, 10, 300000)


def test_resolve_dsn_order(mod):
    env = {"CTC_DATABASE_URL": "a", "CTC_ARCHIVE_DATABASE_URL": "b"}
    assert (mod.resolve_dsn("x", env), mod.resolve_dsn(None, env), mod.resolve_dsn(None, {"CTC_DATABASE_URL": "a"}), mod.resolve_dsn(None, {})) == ("x", "b", "a", None)


def test_mask_dsn(mod):
    assert mod.mask_dsn("postgresql://u:secret@h:5/d and postgresql://v:pw2@h2/d2") == "postgresql://u:***@h:5/d and postgresql://v:***@h2/d2"
    assert mod.mask_dsn("postgresql://u@h/d") == "postgresql://u@h/d"


def test_source_label_keyword_form_hides_password(mod):
    assert mod.source_label("host=h port=1 dbname=d user=u password=s3cret") == "h:1/d"
    assert mod.source_label("host=h dbname=d password=s3cret") == "h/d"


def test_source_label(mod):
    assert mod.source_label("postgresql://u:p@db.example:5433/mydb?sslmode=require") == "db.example:5433/mydb"
    assert mod.source_label("postgresql://u:p@db.example/mydb") == "db.example/mydb"


def test_to_jsonable(mod):
    utc = dt.UTC
    assert mod.to_jsonable(dt.datetime(2026, 10, 22, 10, tzinfo=dt.timezone(dt.timedelta(hours=7)))) == "2026-10-22T03:00:00Z"
    assert mod.to_jsonable(dt.datetime(2026, 1, 2, 3, 4, 5, 123456, tzinfo=utc)) == "2026-01-02T03:04:05.123456Z"
    assert mod.to_jsonable(dt.datetime(2026, 1, 2, 3, 4, 5)) == "2026-01-02T03:04:05Z"
    assert mod.to_jsonable(dt.date(2026, 1, 2)) == "2026-01-02"
    assert mod.to_jsonable(decimal.Decimal("1.50")) == "1.50"
    assert mod.to_jsonable(uuid.UUID(int=1)) == "00000000-0000-0000-0000-000000000001"
    assert mod.to_jsonable(memoryview(b"\x01\xff")) == mod.to_jsonable(b"\x01\xff") == "\\x01ff"
    assert mod.to_jsonable(float("nan")) is None and mod.to_jsonable(float("-inf")) is None
    assert mod.to_jsonable({"a": [dt.date(2026, 1, 1), {"b": decimal.Decimal(2)}], "n": 1, "t": True, "z": None}) == {"a": ["2026-01-01", {"b": "2"}], "n": 1, "t": True, "z": None}


def test_encode_row(mod):
    assert mod.encode_row(["b", "a"], ("ü\n", float("nan"))) == '{"a":null,"b":"ü\\n"}\n'


def test_verify_archive(mod, tmp_path):
    p = tmp_path / "x.jsonl.gz"
    p.write_bytes(gzip.compress(b'{"a":1}\n{"a":2}\n'))
    assert mod.verify_archive(p, 2) == hashlib.sha256(p.read_bytes()).hexdigest()
    for bad in (1, 3):
        with pytest.raises(ValueError):
            mod.verify_archive(p, bad)
    p.write_bytes(gzip.compress(b'{"a":1}\n[1]\n'))
    with pytest.raises(ValueError):
        mod.verify_archive(p, 2)
    p.write_bytes(gzip.compress(b'{"a":1}\nnot json\n'))
    with pytest.raises(ValueError):
        mod.verify_archive(p, 2)
    p.write_bytes(b"not gzip")
    with pytest.raises(ValueError):
        mod.verify_archive(p, 0)
    p.write_bytes(gzip.compress(b""))
    assert mod.verify_archive(p, 0)


# --- refusals (D1, D4) ---


def test_no_dsn_exits_2(mod, tmp_path, monkeypatch):
    for k in ("CTC_ARCHIVE_DATABASE_URL", "CTC_DATABASE_URL"):
        monkeypatch.delenv(k, raising=False)
    assert mod.main(["--out", str(tmp_path / "o")]) == 2


def test_supabase_refused_before_connecting(mod, tmp_path):
    assert mod.main(["--url", "postgresql://u:p@x.supabase.co:5432/postgres", "--out", str(tmp_path / "o")]) == 2
    assert not (tmp_path / "o").exists()


def test_bad_schema_exits_2(mod, tmp_path):
    assert mod.main(["--url", "postgresql://u:p@127.0.0.1:9/x", "--schema", "ctc; drop table x", "--out", str(tmp_path / "o")]) == 2


def test_out_inside_git_repo_exits_2(mod, tmp_path):
    (tmp_path / "repo" / ".git").mkdir(parents=True)
    assert mod.main(["--url", "postgresql://u:p@127.0.0.1:9/x", "--out", str(tmp_path / "repo" / "sub" / "arch")]) == 2
    assert not (tmp_path / "repo" / "sub").exists()


def test_cannot_connect_exits_3_masked_and_writes_nothing(mod, tmp_path, capsys):
    assert mod.main(["--url", "postgresql://u:hunter2@127.0.0.1:9/x", "--out", str(tmp_path / "o")]) == 3
    assert "hunter2" not in capsys.readouterr().err
    assert not (tmp_path / "o").exists()


def test_missing_table_exits_3(mod, pg, tmp_path):
    assert mod.main(["--url", pg.url, "--schema", "t03_missing", "--out", str(tmp_path / "o")]) == 3
    assert not (tmp_path / "o").exists()


# --- the archive (D2, D3, D5, D9, D10, D14) ---


def test_archive_content_and_manifest(mod, pg, tmp_path):
    assert run(mod, pg, tmp_path / "o") == 0
    d = rows(one(tmp_path / "o", "decisions-*.jsonl.gz"))
    assert [r["id"] for r in d] == [1, 2, 3, 4, 5]
    assert set(d[0]) == {"id", "session_id", "prompt", "confidence", "bundle", "at", "graph_line"}
    assert d[0]["at"] == "2026-10-22T03:00:00Z" and d[0]["graph_line"] is None and d[0]["bundle"] == {"steps": [[1, 2]], "ü": "x"}
    assert d[1]["confidence"] is None  # NaN
    assert d[2]["prompt"] == PROMPT
    with gzip.open(one(tmp_path / "o", "decisions-*.jsonl.gz"), "rt", encoding="utf-8") as f:
        raw = f.readline()
    assert raw.startswith('{"at":') and "ü" in raw and ", " not in raw.split('"prompt"')[0]
    m = json.loads(one(tmp_path / "o", "manifest-*.json").read_text())
    assert set(m) == {"created_at", "source", "schema", "script_version", "tables"} and m["schema"] == pg.schema
    for t, n in (("decisions", 5), ("events", 3)):
        gz = one(tmp_path / "o", f"{t}-*.jsonl.gz")
        e = m["tables"][t]
        assert (e["file"], e["rows"], e["sha256"]) == (gz.name, n, hashlib.sha256(gz.read_bytes()).hexdigest())
        assert len(rows(gz)) == n
    assert (m["tables"]["decisions"]["min_id"], m["tables"]["decisions"]["max_id"]) == (1, 5)
    assert "héllo" not in one(tmp_path / "o", "manifest-*.json").read_text()


def test_same_rows_same_bytes(mod, pg, tmp_path):
    assert run(mod, pg, tmp_path / "a") == run(mod, pg, tmp_path / "b") == 0
    assert one(tmp_path / "a", "decisions-*.jsonl.gz").read_bytes() == one(tmp_path / "b", "decisions-*.jsonl.gz").read_bytes()


@pytest.mark.parametrize("batch", [1, 2, 5, 6])  # below, equal to and above the row count
def test_batch_keeps_all_rows_in_order(mod, pg, tmp_path, batch):
    mod.BATCH = batch
    assert run(mod, pg, tmp_path / "o") == 0
    assert [r["id"] for r in rows(one(tmp_path / "o", "decisions-*.jsonl.gz"))] == [1, 2, 3, 4, 5]


def test_empty_table(mod, pg, tmp_path):
    pg.conn.execute(f"delete from {pg.schema}.events")
    assert run(mod, pg, tmp_path / "o") == 0
    assert rows(one(tmp_path / "o", "events-*.jsonl.gz")) == []
    e = json.loads(one(tmp_path / "o", "manifest-*.json").read_text())["tables"]["events"]
    assert (e["rows"], e["min_id"], e["max_id"]) == (0, None, None) and "id" in e["columns"]


def test_one_row_table(mod, pg, tmp_path):
    pg.conn.execute(f"delete from {pg.schema}.events where id > (select min(id) from {pg.schema}.events)")
    assert run(mod, pg, tmp_path / "o") == 0
    assert len(rows(one(tmp_path / "o", "events-*.jsonl.gz"))) == 1


def test_modes_and_existing_dir_mode(mod, pg, tmp_path):
    assert run(mod, pg, tmp_path / "a" / "b" / "arch") == 0
    assert stat.S_IMODE((tmp_path / "a" / "b" / "arch").stat().st_mode) == 0o700
    assert {stat.S_IMODE(p.stat().st_mode) for p in (tmp_path / "a" / "b" / "arch").iterdir()} == {0o600}
    keep = tmp_path / "keep"
    keep.mkdir(mode=0o755)
    keep.chmod(0o755)
    assert run(mod, pg, keep) == 0
    assert stat.S_IMODE(keep.stat().st_mode) == 0o755


def test_existing_archive_never_overwritten_exit_5(mod, pg, tmp_path):
    assert run(mod, pg, tmp_path / "o") == 0
    before = {p.name: p.read_bytes() for p in (tmp_path / "o").iterdir()}
    assert run(mod, pg, tmp_path / "o") == 5
    assert {p.name: p.read_bytes() for p in (tmp_path / "o").iterdir()} == before


def test_verification_failure_exits_4_and_leaves_nothing(mod, pg, tmp_path, monkeypatch):
    def boom(path, rows):
        raise ValueError("mismatch")
    monkeypatch.setattr(mod, "verify_archive", boom)
    assert run(mod, pg, tmp_path / "o") == 4
    assert list((tmp_path / "o").iterdir()) == []


def test_foreign_part_file_is_kept_on_failure(mod, pg, tmp_path):
    out = tmp_path / "o"
    out.mkdir()
    date = dt.datetime.now(dt.UTC).strftime("%Y%m%d")
    for name in (f"decisions-{date}.jsonl.gz.part", f"manifest-{date}.json.part"):
        foreign = out / name
        foreign.write_bytes(b"other run")
        assert run(mod, pg, out) == 4
        assert foreign.read_bytes() == b"other run"
        foreign.unlink()
        assert list(out.iterdir()) == []


# --- dry run (D13) and must-nots (D6, D7) ---


def test_dry_run_prints_counts_and_writes_nothing(mod, pg, tmp_path, capsys):
    assert run(mod, pg, tmp_path / "o", "--dry-run") == 0
    out = capsys.readouterr().out.splitlines()
    assert out[:2] == ["decisions: 5 rows", "events: 3 rows"] and out[2].startswith("would write ") and len(out) == 3
    assert not (tmp_path / "o").exists()


def test_dry_run_still_refuses_supabase(mod, tmp_path):
    assert mod.main(["--url", "postgresql://u:p@x.supabase.co/postgres", "--dry-run", "--out", str(tmp_path / "o")]) == 2


def test_read_only_dsn_works_and_database_is_untouched(mod, pg, tmp_path, capsys):
    before = counts(pg)
    assert run(mod, pg, tmp_path / "o", dsn=pg.ro) == 0
    assert counts(pg) == before == [5, 3]
    assert sorted(p.name.split("-")[0] for p in (tmp_path / "o").iterdir()) == ["decisions", "events", "manifest"]
    assert not list((tmp_path / "o").glob("*.part"))
    out = capsys.readouterr()
    assert "héllo" not in out.out + out.err and "ctcdev" not in out.out + out.err


def test_snapshot_ignores_rows_inserted_during_export(mod, pg, tmp_path, monkeypatch):
    real = mod._dump

    def dump_then_insert(conn, schema, table, *rest):
        if table == "decisions":
            pg.conn.execute(f"insert into {schema}.events (session_id, at) values ('late', now())")
        return real(conn, schema, table, *rest)
    monkeypatch.setattr(mod, "_dump", dump_then_insert)
    assert run(mod, pg, tmp_path / "o") == 0
    assert len(rows(one(tmp_path / "o", "events-*.jsonl.gz"))) == 3


def test_help_exits_0_without_connecting(mod):
    buf = io.StringIO()
    import contextlib
    with contextlib.redirect_stdout(buf):
        assert mod.main(["--help"]) == 0
