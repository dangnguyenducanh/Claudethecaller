# 08 — disabled-node

Status: resolved
Blocked by: 01
Spec: `.scratch/n8n-parity/spec.md` (read it first; this ticket implements part of it)
Touches: src/ctc/runner/graph.py, src/ctc/runner/engine.py, src/ctc/runner/export.py, dashboard/src/Workflows.tsx, tests/test_disabled_node.py (engine-seam cases using the ticket 01 fixtures from tests/conftest.py)

## What to build

`disabled: true` on any node except trigger: the walker passes straight through it (its output = its input context's upstream output; IF/Switch disabled = first/true handle is NOT assumed: disabled branching nodes are rejected by the validator). The step row is written as skipped with a `disabled` marker. Editor: a toggle, greyed node. Export: drop disabled nodes and reconnect, or refuse with a reason.

## Acceptance criteria

- [ ] A disabled shell in a chain is skipped and the next node receives the previous node's output.
- [ ] Validator rejects `disabled` on trigger, IF and Switch.
- [ ] Run page shows 'skipped (disabled)'. Browser QC screenshot.
- [ ] `scripts/check.sh` green; tests added at the seam the spec names.

## Tests

Engine-seam cases + graph tests.

## Comments

2026-10-26 — resolved on branch `n8n-08-disabled-node`, merged into `m5-n8n-parity` (tasks T051–T056, T058; T057 browser QC deferred to the final QC pass). `disabled: true` (bool) on any node but trigger/IF/switch: execute() completes it through the canned path as `skipped` with marker `disabled`, its output = `graph.passthrough()` (first data in-edge's source; for a loop target readied by a back-edge, the first forward in-edge's source — `ponytail:`); no input, process, log or commit; ctx reload after a resume includes disabled steps. Validator: a disabled approval is not a push gate (safety). Export drops/reconnects disabled nodes, still refuses a disabled approval. Editor toggle, greyed node, "skipped (disabled)". Tests: tests/test_disabled_node.py (14).
