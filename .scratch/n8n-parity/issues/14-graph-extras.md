# 14 — graph-extras

Status: ready-for-agent
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
