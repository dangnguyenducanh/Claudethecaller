# 06 — prompt line, PreToolUse file note, install (G6)

Status: ready-for-agent
Blocked by: 03, 04
Wave: 3 (parallel with 05)
Spec: `.scratch/context-coding-graph/spec.md`
Touches: src/ctc/graph/push.py, src/ctc/server/hooks.py, src/ctc/server/writer.py, src/ctc/cli.py, config/retrieval.yaml, tests/test_graph_push.py

## What to build

tasks.md T032–T039 (Phase 6, US3 + US4). Interfaces: contracts/hooks.md (prompt line, /v1/hook/pre), contracts/modules.md (push), research.md R2 (PreToolUse additionalContext).

## Acceptance criteria

- [ ] `tests/test_graph_push.py` passes.
- [ ] `CTC_CLAUDE_HOME=$(mktemp -d) uv run ctc install --dry-run` shows the PreToolUse `Read|Edit|Write|MultiEdit` group.
- [ ] `scripts/check.sh` green with and without the scratch URL; the real `ctc install` is NOT run.

## Comments
