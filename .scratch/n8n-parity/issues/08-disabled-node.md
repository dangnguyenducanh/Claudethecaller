# 08 — disabled-node

Status: ready-for-agent
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
