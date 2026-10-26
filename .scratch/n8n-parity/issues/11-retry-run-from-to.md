# 11 — retry-run-from-to

Status: resolved
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

2026-10-26 — resolved on branch `n8n-11-retry-run-from-to`, merged into `m5-n8n-parity` (tasks T008–T019, T021; T020 browser QC deferred to the final QC pass). `engine.retry()` queues a child run linked by `parent_run_id` (+ `from_node`, `to_node`, `base_sha`); parent steps before the from step are copied as `marker='reused'` and completed by execute() through the `canned` job path (no process, 0 tokens); the child's worktree starts at the from step's pre_sha; run-to ends `done` after its node. API `POST /api/runs/{id}/retry`, CLI `ctc retry <id> [--from] [--to]`, run page Retry / Run from here / Run to here + parent link. Schema (additive): wf_runs.parent_run_id (on delete set null), from_node, to_node; wf_steps.marker check (reused|pinned|disabled). Open risk: a reused agent node's session_id belongs to the parent's worktree, so `resume_from` on it may miss. Supabase gets these alters when the daemon next opens the store with this code (owner deploy).
