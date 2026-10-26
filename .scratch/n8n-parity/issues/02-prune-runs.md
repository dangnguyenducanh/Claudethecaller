# 02 — prune-runs

Status: ready-for-agent
Blocked by: none
Spec: `.scratch/n8n-parity/spec.md` (read it first; this ticket implements part of it)
Touches: src/ctc/runner/prune.py (new), src/ctc/cli.py (new `runs prune` command), tests/test_prune.py

## What to build

`ctc runs prune [--days 30] [--apply]`: list the runs older than N days (default 30) that are not waiting and have no PR URL, with what would be removed for each: worktree dir under the runs dir, its `ctc/*` branch in the project repo, gz logs, and the run's step and run rows. Without `--apply` it only prints (dry run). With `--apply` it removes them together per run (worktree via `git worktree remove --force`, then branch, then files, then rows) and reports totals. Never touches non-`ctc/` branches or anything outside the runs dir.

## Acceptance criteria

- [ ] Dry run prints a table (run, workflow, age, branch, size) and deletes nothing.
- [ ] `--apply` removes worktree, branch, logs and rows of eligible runs only; waiting runs and runs with a PR URL are kept.
- [ ] A run whose worktree or branch is already gone is still pruned without error.
- [ ] Re-running `--apply` is a no-op.
- [ ] `scripts/check.sh` green; tests added at the seam the spec names.

## Tests

Pure selection logic unit-tested with fake rows; one test with a real tmp git repo + worktree + scratch DB (skip without DB).

## Comments
