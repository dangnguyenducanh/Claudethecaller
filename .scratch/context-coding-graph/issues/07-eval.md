# 07 — n8n-parity evaluation (G7)

Status: ready-for-agent
Blocked by: 05, 06
Wave: 4
Spec: `.scratch/context-coding-graph/spec.md`
Touches: evaluation/graph_eval.py, tests/test_graph_eval.py, config/retrieval.yaml (graph_push.floor only)

## What to build

tasks.md T045–T048 (Phase 8, US8). Method: design.md §8, research.md R6 (truth limited to files in the coding graph; ticket 17 excluded).

## Acceptance criteria

- [ ] `tests/test_graph_eval.py` passes.
- [ ] `uv run python -m evaluation.graph_eval --write-floor` prints dev/test Recall@3, false-trigger rate and p95s with PASS/FAIL; FAILs are reported, never tuned on test.
- [ ] `scripts/check.sh` green with and without the scratch URL.

## Comments
