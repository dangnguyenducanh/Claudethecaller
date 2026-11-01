# 05 — MCP pull tools and graphify export (G5)

Status: ready-for-agent
Blocked by: 03
Wave: 3 (parallel with 06)
Spec: `.scratch/context-coding-graph/spec.md`
Touches: src/ctc/graph/query.py, src/ctc/graph/export.py, src/ctc/server/mcp.py, tests/test_graph_query.py

## What to build

tasks.md T040–T044 (Phase 7, US5). Interfaces: contracts/mcp.md, contracts/modules.md (query).

## Acceptance criteria

- [ ] `tests/test_graph_query.py` passes.
- [ ] `python -m ctc.graph.export --kind context` output loads in `graphify query --graph`.
- [ ] `scripts/check.sh` green with and without the scratch URL.

## Comments
