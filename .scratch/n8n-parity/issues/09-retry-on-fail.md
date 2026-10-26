# 09 — retry-on-fail

Status: resolved
Blocked by: 01
Spec: `.scratch/n8n-parity/spec.md` (read it first; this ticket implements part of it)
Touches: src/ctc/runner/graph.py, src/ctc/runner/engine.py, dashboard/src/Workflows.tsx, tests/test_retry_on_fail.py (engine-seam cases using the ticket 01 fixtures from tests/conftest.py)

## What to build

Shell nodes may set `idempotent: true` and `retry: {max_tries: 1..5, wait_s: 0..300}`. On failure (not timeout-killed by run cancel), the engine re-runs the shell in the same worktree up to max_tries, waiting between tries, recording each try in the step (try count + last error). Validator: `retry` only on shell nodes with `idempotent: true`; never on agents. Editor fields for both.

## Acceptance criteria

- [ ] A shell that fails twice then succeeds ends `done` with 3 tries recorded (engine seam, a script using a counter file).
- [ ] A shell that always fails ends `failed` after max_tries with the last error.
- [ ] `retry` on an agent or a non-idempotent shell is rejected on save.
- [ ] `scripts/check.sh` green; tests added at the seam the spec names.

## Tests

Engine-seam cases + graph validation tests.

## Comments

2026-10-26 — resolved on branch `n8n-09-retry-on-fail`, merged into `m5-n8n-parity` (tasks T059–T067, T069; T068 browser QC deferred to the final QC pass). Shell `retry: {max_tries 1-5, wait_s 0-300}` only with `idempotent: true` (validator; never agents). `_spawn()` re-runs the shell in the same worktree before its one commit until exit 0 or max_tries, checks the run is still `running` after each wait (`ponytail:` a cancel is seen when the wait ends); with retry a non-zero exit fails the step ("exit N on try k/n: <tail>"), `_exit_fails(node)` is the hook ticket 10 extends. Schema (additive): wf_steps.tries; schemas.py/types.ts/Runs.tsx show tries. Tests: tests/test_retry_on_fail.py (22). Open (for Polish/review): export.py ignores `retry` (FR-050 needs translate or refuse); mcp workflow_status omits tries; retry() copies reused rows without tries; a planned stop during a long wait_s can outlast the grace.
