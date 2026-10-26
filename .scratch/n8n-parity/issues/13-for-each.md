# 13 — for-each

Status: ready-for-agent
Blocked by: 01, 10
Spec: `.scratch/n8n-parity/spec.md` (read it first; this ticket implements part of it)
Touches: src/ctc/runner/graph.py, src/ctc/runner/engine.py, src/ctc/runner/export.py, dashboard/src/Workflows.tsx, dashboard/src/types.ts, tests/test_graph_foreach.py, tests/test_for_each.py (engine-seam cases using the ticket 01 fixtures from tests/conftest.py)

## What to build

New `foreach` node: `items` = template path to a JSON array, `max_items` (default 50). Its `body` handle enters a sub-graph that returns to the foreach node; the body runs once per item, in order, with `item` and `index` template roots; visits of body nodes are per item (max_visits per item). Output `{items: [body outputs in order]}` on the `done` handle. A failed body item follows the body node's on_error. Validator: body must return to the foreach, no edges leave the body except back to the foreach, items path must be a reachable node field. Export: refuse.

## Acceptance criteria

- [ ] One fixer per failing test: a shell outputs a JSON list of 3 names, foreach runs the (fake) agent body 3 times with each name, output lists 3 results.
- [ ] `max_items` truncates and records it in the step output.
- [ ] Empty list: body never runs, output `{items: []}`.
- [ ] `scripts/check.sh` green; tests added at the seam the spec names.

## Tests

Graph tests + engine-seam cases.

## Comments
