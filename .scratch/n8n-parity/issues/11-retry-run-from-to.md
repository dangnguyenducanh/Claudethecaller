# 11 — retry-run-from-to

Status: ready-for-agent
Blocked by: 01
Spec: `.scratch/n8n-parity/spec.md` (read it first; this ticket implements part of it)
Touches: src/ctc/runner/engine.py, src/ctc/server/runs.py, src/ctc/server/schemas.py, src/ctc/storage/schema.sql, src/ctc/cli.py (`retry`), dashboard/src/Runs.tsx, dashboard/src/types.ts, tests/test_retry_run_from_to.py (engine-seam cases using the ticket 01 fixtures from tests/conftest.py)

## What to build

New run linked to a parent run with optional `from_node` and `to_node`. Retry = from the parent's failed step. The new run's walker state is seeded from the parent's saved state up to `from_node` (upstream outputs reused, steps copied as `reused`), its worktree/branch is created from the `from_node` step's pre-commit (or the parent base for from-start). `to_node`: stop with `done` after that node completes. Schema: additive columns on runs (parent run, from/to node) and a reused/pinned marker on steps. API `POST /api/runs/{id}/retry {from_node?, to_node?}`; CLI `ctc retry <id> [--from X] [--to Y]`; run page buttons Retry / Run from here / Run to here and a link to the parent.

## Acceptance criteria

- [ ] Retry of a run that failed at node 4 executes only node 4 onward; nodes 1-3 show as reused with the parent's outputs; worktree starts at node 4's pre-commit.
- [ ] Run-from a middle node of a done run works the same; run-to stops after the chosen node with `done`.
- [ ] Rejected with a clear error when the parent's state or commits are gone (pruned).
- [ ] Browser QC: buttons appear on steps and start the new run.
- [ ] `scripts/check.sh` green; tests added at the seam the spec names.

## Tests

Engine-seam cases + API test.

## Comments
