"""`ctc runs prune` (spec FR-023, US5): dry run by default; keeps 30 days. Never prunes waiting, quota, queued or running
runs or runs with a PR URL. Removes a run's worktree, ctc/* branch, run dir (gz logs, notify.log, container home) and
rows together. Never touches non-ctc/ branches, the user's checkout or anything outside the runs dir."""

from __future__ import annotations

import os
import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path

from ctc.runner.engine import git
from ctc.runner.proc import RUNS

# RUNS is read as a module global at call time: tests point it at a tmp dir.


def eligible(rows: list[dict], days: int, now: datetime) -> list[dict]:
    """Ended runs (done, failed, cancelled) older than days, without a PR URL."""
    cut = now - timedelta(days=days)
    return [r for r in rows if r["status"] in ("done", "failed", "cancelled") and not r["pr_url"]
            and (r["ended_at"] or r["created_at"]) < cut]


def _size(d) -> int:
    """Bytes of the files under d, symlinks not followed; 0 when d is missing."""
    return sum(os.lstat(os.path.join(root, f)).st_size for root, _, files in os.walk(d) for f in files)


async def candidates(store, owner: str, days: int) -> list[dict]:
    """This owner's eligible runs, each with age_days and size (bytes under RUNS/<id>)."""
    now = datetime.now(UTC)
    rows = await store.fetch("select id, workflow, status, pr_url, repo, worktree, branch, created_at, ended_at"
                             " from wf_runs where owner = %s order by id", (owner,))
    return [r | {"age_days": (now - (r["ended_at"] or r["created_at"])).days, "size": _size(RUNS / str(r["id"]))}
            for r in eligible(rows, days, now)]


async def _ok(repo: str, *args: str) -> bool:
    """git -C repo args; False when it fails (the worktree or branch is already gone)."""
    try:
        await git(repo, *args)
        return True
    except (OSError, RuntimeError):
        return False


async def apply(store, owner: str, items: list[dict]) -> dict:
    """Remove each run's worktree, ctc/* branch, run dir and rows, in that order. Missing pieces are skipped, not errors,
    so a second apply is a no-op. Counts only what was removed: {runs, worktrees, branches, bytes}."""
    totals = dict.fromkeys(("runs", "worktrees", "branches", "bytes"), 0)
    for r in items:
        d = RUNS / str(r["id"])
        size, repo, wt = _size(d), r["repo"], r["worktree"]
        has_repo = bool(repo) and os.path.isdir(repo)
        # only this run's own worktree: a row pointing anywhere else (the user's checkout) is left alone
        if has_repo and wt and Path(wt).resolve().is_relative_to(d.resolve()):
            if Path(wt).exists():
                totals["worktrees"] += await _ok(repo, "worktree", "remove", "--force", wt)
            else:  # rm -rf'd by hand: drop the stale admin entry, else it blocks the branch delete
                await _ok(repo, "worktree", "prune")
        if has_repo and (r["branch"] or "").startswith("ctc/"):
            totals["branches"] += await _ok(repo, "branch", "-D", r["branch"])
        shutil.rmtree(d, ignore_errors=True)
        totals["bytes"] += 0 if d.exists() else size
        totals["runs"] += await store.execute("delete from wf_runs where id = %s and owner = %s", (r["id"], owner))  # steps cascade
    return totals
