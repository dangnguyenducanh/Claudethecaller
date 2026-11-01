# 02 — context parser (G2)

Status: ready-for-agent
Blocked by: none
Wave: 1 (parallel with 01)
Spec: `.scratch/context-coding-graph/spec.md`
Touches: src/ctc/graph/parse.py, tests/test_graph_parse.py

## What to build

tasks.md T013–T015 (Phase 3, US1). Pure module: no DB, no network, no imports from db/core. Interfaces: contracts/modules.md (parse), ids per data-model.md "Node ids".

## Acceptance criteria

- [ ] `tests/test_graph_parse.py` passes.
- [ ] `uv run python -m ctc.graph.parse` asserts 16 stories (001-n8n-parity), 17 tickets, ≥ 20 decisions and prints the summary.
- [ ] ruff clean.

## Comments
