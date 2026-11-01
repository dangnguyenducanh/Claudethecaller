# 01 — store, RAM graph, graphify import (G1)

Status: ready-for-agent
Blocked by: none
Wave: 1 (parallel with 02)
Spec: `.scratch/context-coding-graph/spec.md`
Touches: src/ctc/storage/schema.sql, src/ctc/graph/__init__.py, src/ctc/graph/db.py, src/ctc/graph/core.py, src/ctc/graph/importer.py, src/ctc/server/state.py, src/ctc/cli.py, tests/conftest.py, tests/test_graph_import.py

## What to build

tasks.md T004–T012 (Phase 2). Interfaces: contracts/modules.md (db, core, importer), contracts/cli.md (`graph import`, `graph status`), data-model.md (tables, write rules, RAM graph).

## Acceptance criteria

- [ ] `tests/test_graph_import.py` passes on the scratch DB (skips without it).
- [ ] `uv run ctc graph import` prints the code + rationale counts from T003; a second run prints `skipped`.
- [ ] `uv run ctc graph status` shows built_at = HEAD and per-kind counts.
- [ ] `scripts/check.sh` green with and without the scratch URL.

## Comments
