# 06 — cheap-fixes

Status: resolved
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

2026-10-26 — resolved on branch `n8n-06-cheap-fixes`, merged into `m5-n8n-parity` (tasks T084–T093, T095; T094 browser QC deferred to the final QC pass). (1) run page keeps polling in `quota` (Cancel also shows there); (2) `resume_from` validated in `graph.validate` (must be an agent that runs earlier in the pass); (3) shell `readonly` rejected by the validator, `batch()` batches read-only agents only, editor drops the shell toggle, basic-site/three-reviewers examples and PLAN.md updated; (4) compare route accepts uppercase and `_`; (5) `plan` in the permission picker. Behaviour change: user-scope workflows with `readonly` on a shell now fail validation (FR-005). Left: engine.py docstrings still say "readonly nodes"; export.py's readonly-shell branch is dead code.
