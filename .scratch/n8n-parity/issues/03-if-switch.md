# 03 — if-switch

Status: ready-for-agent
Blocked by: none
Spec: `.scratch/n8n-parity/spec.md` (read it first; this ticket implements part of it)
Touches: src/ctc/runner/graph.py, src/ctc/runner/export.py, dashboard/src/Workflows.tsx, dashboard/src/types.ts, tests/test_graph_if_switch.py

## What to build

IF gains `conditions: [{path, op, value}]` + `combine: and|or` and ops `gt ge lt le not_contains regex exists` (keep `eq ne contains truthy` and the old single path/op/value form). New `switch` node: `cases: [{name, conditions, combine}]`, first matching case fires its named handle, else `default`. Validator: case names are slugs, unique, every outgoing switch edge uses a case name or `default`, regex compiles. Walker: switch fires exactly one handle (like IF). Editor: IF condition list editor and a Switch node with one output dot per case + default. Export: translate IF/Switch faithfully or refuse with a reason.

## Acceptance criteria

- [ ] Old IF workflows still validate and run unchanged.
- [ ] IF with and/or over mixed ops evaluates correctly (unit tests per op incl. numbers given as strings, missing paths, invalid regex rejected on save).
- [ ] Switch routes to the first matching case, else default; validation rejects unknown handles and duplicate case names.
- [ ] Editor can build, save and reload IF conditions and a Switch with 3 cases; browser QC screenshot of both.
- [ ] `scripts/check.sh` green; tests added at the seam the spec names.

## Tests

Pure graph tests (no DB). Editor: browser QC in the lane.

## Comments
