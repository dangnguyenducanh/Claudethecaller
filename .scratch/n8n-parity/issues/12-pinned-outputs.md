# 12 — pinned-outputs

Status: resolved
Blocked by: 11
Spec: `.scratch/n8n-parity/spec.md` (read it first; this ticket implements part of it)
Touches: src/ctc/runner/graph.py, src/ctc/runner/engine.py, src/ctc/server/runs.py, src/ctc/cli.py (`--pinned`), dashboard/src/Workflows.tsx, dashboard/src/types.ts, tests/test_pinned_outputs.py (engine-seam cases using the ticket 01 fixtures from tests/conftest.py)

## What to build

Node field `pin: {output: <json>}` (validated JSON). Runs started with `pinned: true` from the editor or CLI complete pinned nodes instantly with their pinned output (step marked pinned, no agent spawned, no commit); schedule and MCP triggers reject `pinned`. Editor: 'Pin this output' on a past step's output and a pin editor on the node; pinned nodes show a pin badge. Reuse ticket 11's 'complete a node without executing it' path.

## Acceptance criteria

- [ ] A run with pins on both agent nodes of a 5-node chain spends 0 agent tokens and evaluates IF/templates on the pinned outputs.
- [ ] `pinned` from a schedule or MCP start is rejected.
- [ ] Without `pinned` the pins are ignored.
- [ ] `scripts/check.sh` green; tests added at the seam the spec names.

## Tests

Engine-seam cases; browser QC for pin UI.

## Comments

2026-10-26 — resolved on branch `n8n-12-pinned-outputs`, merged into `m5-n8n-parity` (tasks T022–T031, T033; T032 browser QC deferred to the final QC pass). Node `pin: {output}` (validated); runs started with `pinned` (editor, `ctc run --pinned`, API) complete pinned nodes through ticket 11's canned path with marker `pinned` (no argv, log, process, commit; 0 tokens). `submit_run` refuses `pinned` for triggers schedule/mcp (422 `pinned_not_allowed`); retry children are never pinned. Editor: pin editor, "Pin output of run #N", pin badge. Schema (additive): wf_runs.pinned. Export ignores `pin` (no change needed).
