# 10 — error-branch

Status: resolved
Blocked by: 01
Spec: `.scratch/n8n-parity/spec.md` (read it first; this ticket implements part of it)
Touches: src/ctc/runner/graph.py, src/ctc/runner/engine.py, src/ctc/runner/export.py, dashboard/src/Workflows.tsx, tests/test_error_branch.py (engine-seam cases using the ticket 01 fixtures from tests/conftest.py)

## What to build

`on_error: stop | continue | error_output` for shell and agent nodes (default stop). `error_output` adds an `error` handle: on failure the error edge fires with `{error, output_tail, exit_code}` and the run continues down that edge; the normal edge does not fire. `continue` keeps today's behaviour and gets its first real test. Validator: an `error` edge needs `on_error: error_output`; loops through error edges respect max_visits. Editor: error handle dot (red) when error_output is set. Export: refuse error edges with a reason.

## Acceptance criteria

- [ ] Fixer pattern works: test fails -> error edge -> fixer agent (fake) -> back to test, capped by max_visits.
- [ ] `continue` on a failing shell: run goes on with the failed step's output and the step stays `failed`.
- [ ] `stop` (default) unchanged.
- [ ] `scripts/check.sh` green; tests added at the seam the spec names.

## Tests

Engine-seam cases.

## Comments

2026-10-26 — resolved on branch `n8n-10-error-branch`, merged into `m5-n8n-parity` (tasks T070–T075, T077; T076 browser QC deferred to the final QC pass). `on_error: stop | continue | error_output` on shell and agent nodes (old `fail` accepted as stop). With `error_output` a failed/timed-out step stays `failed` and `graph.complete(..., failed=True)` sends `{error, output_tail, exit_code}` down only the `error` edges; normal edges are deferred. `_exit_fails()` is true for retry, continue and error_output (default stop keeps a non-zero exit as data). Validator: an `error` edge needs `on_error: error_output`; loops through error edges respect max_visits. Editor red error handle; export refuses error edges. Tests: tests/test_error_branch.py (23). OPEN BUG (review fix pass): `engine.retry()` copies a reused failed `error_output` step as `done`, so the child walks its normal edge instead of the error edge. Native export ignores `on_error: continue`.
