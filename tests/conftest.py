"""The engine test seam (spec "Testing Decisions", Q18) every engine story builds on: a workflow YAML goes in, run and
step rows come out. A throwaway schema on the scratch Postgres in CTC_DATABASE_URL (DB cases skip when it is unset or
Supabase), scripts/fake_claude.sh as the claude binary, and run_yaml()/walk_run()/in_store() driving ctc.runner.engine
in this process. Runs, worktrees and logs go to tmp_path: nothing touches the real ~/.claudethecaller.
"""

import asyncio
import hashlib
import json
import subprocess
import tempfile
import uuid
from pathlib import Path
from types import SimpleNamespace

import psycopg
import pytest
import yaml

from ctc.config import cfg
from ctc.runner import engine, graph, proc
from ctc.storage.store import Store

ROOT = Path(__file__).resolve().parents[1]
FAKE = ROOT / "scripts" / "fake_claude.sh"
# the fake's result event when no script is set; run_yaml's claude_script dicts override its fields
DEFAULT_RESULT = {"type": "result", "subtype": "success", "is_error": False, "num_turns": 1, "result": "ok",
                  "total_cost_usd": 0, "usage": {"input_tokens": 3, "output_tokens": 1}, "permission_denials": []}


@pytest.fixture(scope="session")
def scratch_db():
    """(dsn, schema): a fresh ctc_test_<hex> schema from src/ctc/storage/schema.sql, dropped after the session."""
    dsn = cfg()["database_url"] or ""  # cfg() also loads .env, like the store self-check
    if not dsn or "supabase" in dsn:
        pytest.skip("engine seam needs a scratch Postgres: CTC_DATABASE_URL unset or Supabase")
    schema = f"ctc_test_{uuid.uuid4().hex[:8]}"

    async def apply():
        await (await Store.open(dsn, schema, pool_min=1, pool_max=1)).close()

    try:
        asyncio.run(apply())
        with psycopg.connect(dsn, autocommit=True) as c:
            # engine.kill_run(rid) (cancel, sweep, stop_runner, max_run_minutes) stops every process on this host whose
            # environ holds CTC_RUN=<rid> and docker-kills ctc-run-<rid>-*: test run ids must never equal the owner's
            # daemon run ids (schema ctc, from 1), nor another lane's test ids, so each session starts at its own 10^9+x.
            c.execute(f"alter table {schema}.wf_runs alter column id restart with {10**9 + uuid.uuid4().int % 10**9}")
        yield dsn, schema
    finally:
        with psycopg.connect(dsn, autocommit=True) as c:
            c.execute(f"drop schema if exists {schema} cascade")  # never `extensions` or `ctc`


@pytest.fixture
def seam(scratch_db, tmp_path, monkeypatch):
    """Empty wf tables, a git repo with one commit to run in, runs dir in tmp, the fake claude, no cached owner."""
    dsn, schema = scratch_db
    with psycopg.connect(dsn, autocommit=True) as c:
        # a quota run's future reset would gate every later claim of this owner, a leftover running row would block
        # CLAIM_SQL; no `restart identity`, which would undo the id offset above
        c.execute(f"truncate {schema}.wf_steps, {schema}.wf_runs, {schema}.wf_schedules")
    repo = tmp_path / "repo"
    repo.mkdir()
    for args in (["init", "-q", "-b", "main"], ["config", "user.email", "seam@example.com"],  # engine._spawn commits
                 ["config", "user.name", "seam"], ["commit", "-q", "--allow-empty", "-m", "init"]):  # claim(): worktree add HEAD
        subprocess.run(["git", "-C", str(repo), "-c", "core.hooksPath=/dev/null", *args], check=True)
    runs = tmp_path / "runs"
    monkeypatch.setattr(engine, "RUNS", runs)  # engine imported RUNS by name
    monkeypatch.setattr(proc, "RUNS", runs)
    monkeypatch.setenv("CTC_CLAUDE_BIN", str(FAKE))
    monkeypatch.delenv("CTC_FAKE_CLAUDE_SCRIPT", raising=False)
    monkeypatch.setattr(engine, "_owner", None)  # owner() caches the email
    return SimpleNamespace(dsn=dsn, schema=schema, repo=repo, runs=runs, tmp=tmp_path)


@pytest.fixture
def in_store(seam, monkeypatch):
    """call(fn) -> await fn(st) on a Store over the test schema; st = {store, cfg} like the daemon's app.state.st."""
    def call(fn):
        async def go():
            # the module-level primitives bind to the first loop that waits on them; each call has its own loop
            monkeypatch.setattr(engine, "LOCK", asyncio.Lock())
            monkeypatch.setattr(engine, "WAKE", asyncio.Event())
            store = await Store.open(seam.dsn, seam.schema, pool_min=1, pool_max=2)
            try:  # /api route code reads st.cfg (_local_only, _cap_root); the engine only st.store
                return await fn(SimpleNamespace(store=store, cfg=cfg() | {"mode": "local", "claude_home": str(seam.tmp / "home")}))
            finally:
                await store.close()
        # ponytail: one asyncio.run per call, no pytest-asyncio; add it if a test must hold one loop across calls
        return asyncio.run(go())
    return call


@pytest.fixture
def walk_run(in_store):
    """walk(rid) -> (run, steps): claim the run and walk it to its end or pause; rows even when the claim stopped it."""
    def walk(rid):
        async def go(st):
            if run := await engine.claim(st, rid):
                await engine.execute(st, run)
            return (await st.store.fetchrow("select * from wf_runs where id = %s", (rid,)),
                    await st.store.fetch("select * from wf_steps where run_id = %s order by id", (rid,)))
        return in_store(go)
    return walk


@pytest.fixture
def run_yaml(seam, in_store, walk_run, monkeypatch):
    """run(yaml_text, input="", claude_script=None) -> (run, steps): submit, claim and walk one run of the workflow."""
    def run(yaml_text, input="", claude_script=None):
        g = graph.load(yaml.safe_load(yaml_text))
        assert graph.validate(g) == [], graph.validate(g)
        # a str is another fake binary, repo-relative (e.g. scripts/fake_claude_quota.sh)
        monkeypatch.setenv("CTC_CLAUDE_BIN", str(ROOT / claude_script if isinstance(claude_script, str) else FAKE))
        monkeypatch.delenv("CTC_FAKE_CLAUDE_SCRIPT", raising=False)
        if isinstance(claude_script, (dict, list)):  # one result per agent call, in order; the last one after that
            items = claude_script if isinstance(claude_script, list) else [claude_script]
            d = Path(tempfile.mkdtemp(dir=seam.tmp))
            for name, item in [*enumerate(items, 1), ("default", items[-1])]:
                (d / f"{name}.jsonl").write_text(json.dumps(DEFAULT_RESULT | item) + "\n")
            monkeypatch.setenv("CTC_FAKE_CLAUDE_SCRIPT", str(d))

        async def go(st):
            return await engine.submit(st, await engine.owner(), f"test:{g.get('name') or 'wf'}", g,
                                       hashlib.sha256(yaml_text.encode()).hexdigest(), str(seam.repo), None, "cli", input)
        return walk_run(in_store(go))
    return run
