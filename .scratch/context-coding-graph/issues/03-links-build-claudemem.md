# 03 — links, embeddings, claude-mem, ctc graph build (G3)

Status: ready-for-agent
Blocked by: 01, 02
Wave: 2 (parallel with 04)
Spec: `.scratch/context-coding-graph/spec.md`
Touches: src/ctc/graph/link.py, src/ctc/graph/claudemem.py, src/ctc/graph/build.py, src/ctc/cli.py, config/retrieval.yaml, tests/test_graph_link.py

## What to build

tasks.md T016–T022 (Phase 4, US2 + US7 confirm/tick). Interfaces: contracts/modules.md (build.run_job payload incl. `tick`), contracts/cli.md (`graph build`, `graph confirm`), research.md R5 (claude-mem), R6 (commits).

## Acceptance criteria

- [ ] `tests/test_graph_link.py` passes on the scratch DB.
- [ ] `uv run ctc graph build` prints 16 stories, 17 tickets, link totals and `tasks linked: p%`.
- [ ] `scripts/check.sh` green with and without the scratch URL.

## Comments
