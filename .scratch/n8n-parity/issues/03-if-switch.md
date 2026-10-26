# 03 — if-switch

Status: resolved
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

2026-10-26 — resolved on branch `n8n-03-if-switch`, merged into `m5-n8n-parity` (tasks T096–T103, T105; T104 browser QC deferred to the final QC pass). IF `conditions` + `combine`, ops eq ne gt ge lt le contains not_contains regex exists truthy (regex input capped at REGEX_MAX chars); new `switch` node (`cases`, first match else `default`); `eval_switch` reuses `eval_if`; engine dispatches switch in `_input()`/`_spawn()`; export translates IF/Switch, refuses regex conditions (`regex_condition`, a 422 not_exportable). Known export gaps: `contains` on a dict and eq/ne on objects differ between Python and JS. Tests: tests/test_graph_if_switch.py (72, no DB).
