# 06 — cheap-fixes

Status: ready-for-agent
Blocked by: none
Spec: `.scratch/n8n-parity/spec.md` (read it first; this ticket implements part of it)
Touches: src/ctc/runner/graph.py, dashboard/src/Runs.tsx, dashboard/src/Workflows.tsx, dashboard/src/App.tsx, tests/test_graph_validate.py

## What to build

Five of the six defects from compare.md 'Cheap fixes': (1) keep polling the run page while a run is in `quota` (Runs.tsx); (2) validate `resume_from` against nodes that can run before this node, in the graph validator, not at run time; (3) remove the `readonly` option from shell nodes (validator rejects it on shell, batching uses read-only agents only, editor drops the toggle on shell nodes); (4) widen the per-node compare route regex to accept every valid node id (uppercase, underscore); (5) add `plan` to the editor's permission_mode picker. (The sixth fix, validating the graph when a schedule is enabled, lives in ticket 07.)

## Acceptance criteria

- [ ] Each fix has a test or a browser QC check named in the PR.
- [ ] Existing example workflows in `.claude/ctc-workflows/` still validate (update any that used shell `readonly`).
- [ ] `scripts/check.sh` green; tests added at the seam the spec names.

## Tests

Graph tests for (2)(3); browser QC for (1)(4)(5).

## Comments
