# 14 — graph-extras

Status: resolved
Blocked by: 01
Spec: `.scratch/n8n-parity/spec.md` (read it first; this ticket implements part of it)
Touches: src/ctc/runner/graph.py, src/ctc/runner/engine.py, src/ctc/runner/export.py, dashboard/src/Workflows.tsx, tests/test_graph_templates.py, tests/test_graph_extras.py (engine-seam cases using the ticket 01 fixtures from tests/conftest.py)

## What to build

(1) Template roots `run.id run.visit run.trigger now vars.*` and a workflow `vars:` block. (2) Validation warnings (returned with the errors, not blocking) for template refs to nodes that cannot run before this node or fields that cannot exist. (3) `stop` node type: fails the run with its rendered `message`. (4) Settings `max_run_minutes` (run wall clock) and `approval_timeout_minutes` (waiting -> failed with a clear error).

## Acceptance criteria

- [ ] Templates render the new roots; unknown refs produce warnings shown in the editor on save.
- [ ] A stop node fails the run with its message.
- [ ] A run past max_run_minutes is stopped and failed; an approval past its timeout ends failed.
- [ ] `scripts/check.sh` green; tests added at the seam the spec names.

## Tests

Graph tests + engine-seam cases (timeouts with tiny values).

## Comments

2026-10-26 — resolved on branch `n8n-14-graph-extras`, merged into `m5-n8n-parity` (tasks T110–T121, T123; T122 browser QC deferred to the final QC pass). Template roots `run.id`, `run.visit`, `run.trigger`, `now`, `vars.*` (+ workflow `vars:`); each node renders with its own `nctx`. `graph.warnings(g)` (`_refs`, `OUT_KEYS`) returns non-blocking `[{message, node_id}]`; `check_graph()` returns them, saves return `SavedCapability.warnings`, the editor shows them. `stop` node fails the run with its rendered message ("stopped at <id>" if empty). Settings `max_run_minutes` (deadline from started_at; `_kill_at` kills the batch) and `approval_timeout_minutes` (`expire_approvals()` in the runner loop, notify fired directly) in WorkflowSettings/types.ts. Tests: tests/test_graph_templates.py (26), tests/test_graph_extras.py (4). Review note: max_run_minutes counts wall clock from started_at, so a run resumed after a long quota wait fails at once.
