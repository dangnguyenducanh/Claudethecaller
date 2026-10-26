# 10 — error-branch

Status: ready-for-agent
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
