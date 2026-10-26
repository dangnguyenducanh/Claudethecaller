import asyncio
import os
import shutil
import subprocess
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest

from ctc.runner import prune
from ctc.storage.store import Store

NOW = datetime(2026, 10, 26, 12, tzinfo=UTC)
OLD, RECENT = NOW - timedelta(days=40), NOW - timedelta(days=10)


def _row(id, status="done", pr_url=None, created_at=OLD, ended_at=OLD):
    return {"id": id, "workflow": "p:demo", "status": status, "pr_url": pr_url, "created_at": created_at, "ended_at": ended_at}


def test_eligible_keeps_live_runs_runs_with_a_pr_and_recent_runs():
    rows = [_row(1, "done"), _row(2, "failed"), _row(3, "cancelled"), _row(4, "failed", ended_at=None),
            _row(5, "waiting"), _row(6, "quota"), _row(7, "queued", ended_at=None), _row(8, "running", ended_at=None),
            _row(9, pr_url="https://github.com/o/r/pull/1"), _row(10, ended_at=RECENT)]
    assert [r["id"] for r in prune.eligible(rows, 30, NOW)] == [1, 2, 3, 4]


def test_cli_runs_is_a_group_with_prune():
    from typer.testing import CliRunner

    from ctc.cli import app
    r = CliRunner().invoke(app, ["runs", "prune", "--help"])
    assert r.exit_code == 0 and "--days" in r.output and "--apply" in r.output
    r = CliRunner().invoke(app, ["runs", "--help"])
    assert r.exit_code == 0 and "--limit" in r.output and "prune" in r.output


DSN = os.environ.get("CTC_DATABASE_URL", "")


@pytest.mark.skipif(not DSN or "supabase" in DSN, reason="needs a scratch Postgres in CTC_DATABASE_URL, never Supabase")
def test_prune_removes_only_eligible_runs_and_is_idempotent(tmp_path, monkeypatch):
    runs, repo, schema = tmp_path / "runs", tmp_path / "repo", f"ctc_prune_{uuid4().hex[:8]}"
    monkeypatch.setattr("ctc.runner.prune.RUNS", runs)

    def git(*a):
        return subprocess.run(["git", "-C", str(repo), "-c", "core.hooksPath=/dev/null", *a], check=True, capture_output=True, text=True).stdout

    repo.mkdir()
    git("init", "-q", "-b", "main")
    (repo / "f.txt").write_text("mine")
    git("add", "f.txt")
    git("-c", "user.email=t@x", "-c", "user.name=t", "commit", "-qm", "init")
    git("branch", "feature")

    async def go():
        st = await Store.open(DSN, schema=schema, pool_max=2)
        try:
            async def add(status="done", owner="me@x", pr_url=None, age="40 days", wt=None, branch=None):
                return await st.fetchval(
                    "insert into wf_runs (owner, workflow, file_sha, graph, trigger, status, repo, worktree, branch, pr_url, created_at,"
                    " ended_at) values (%s, 'p:demo', 'x', '{}', 'cli', %s, %s, %s, %s, %s, now() - %s::interval, now() - %s::interval)"
                    " returning id", (owner, status, str(repo), wt, branch, pr_url, age, age))

            async def with_worktree(rid):  # what engine._start makes: runs/<id>/wt on branch ctc/demo-<id>
                wt, branch = runs / str(rid) / "wt", f"ctc/demo-{rid}"
                wt.parent.mkdir(parents=True)
                git("worktree", "add", "-q", "-b", branch, str(wt), "HEAD")
                await st.execute("update wf_runs set worktree = %s, branch = %s where id = %s", (str(wt), branch, rid))
                return wt, branch

            a = await add()
            wt_a, br_a = await with_worktree(a)
            (runs / str(a) / "a-1.jsonl.gz").write_bytes(b"log")
            await st.execute("insert into wf_steps (run_id, node_id, visit, kind, status) values (%s, 'a', 1, 'agent', 'done')", (a,))
            b = await add("failed")  # worktree dir rm -rf'd by hand: a stale admin entry still holds its branch
            wt_b, _ = await with_worktree(b)
            shutil.rmtree(wt_b)
            g = await add("cancelled", wt=str(runs / "999" / "wt"), branch="ctc/demo-999")  # worktree and branch never existed
            h = await add(wt=str(repo), branch="feature")  # a corrupt row pointing at the user's checkout and a non-ctc branch
            kept = [await add("waiting"), await add(pr_url="https://github.com/o/r/pull/1"), await add(age="10 days"),
                    await add(owner="other@x")]

            items = await prune.candidates(st, "me@x", 30)
            assert {i["id"] for i in items} == {a, b, g, h}
            item_a = next(i for i in items if i["id"] == a)
            assert item_a["branch"] == br_a and item_a["size"] > 0 and item_a["age_days"] == 40
            assert wt_a.is_dir() and br_a in git("branch", "--list", "ctc/*")  # dry run deletes nothing
            assert await st.fetchval("select count(*) from wf_steps where run_id = %s", (a,)) == 1

            totals = await prune.apply(st, "me@x", items)
            assert totals["runs"] == 4 and totals["worktrees"] == 1 and totals["branches"] == 2 and totals["bytes"] == sum(i["size"] for i in items)
            ids = {r["id"] for r in await st.fetch("select id from wf_runs")}
            assert ids == set(kept)
            assert await st.fetchval("select count(*) from wf_steps") == 0  # by cascade
            assert not (runs / str(a)).exists() and not (runs / str(b)).exists()
            assert git("branch", "--list", "ctc/*") == "" and str(runs) not in git("worktree", "list")
            assert "feature" in git("branch", "--list", "feature") and (repo / "f.txt").read_text() == "mine"

            again = await prune.candidates(st, "me@x", 30)
            assert again == [] and (await prune.apply(st, "me@x", again))["runs"] == 0  # a no-op
        finally:
            await st.execute(f"drop schema if exists {schema} cascade")
            await st.close()

    asyncio.run(go())
