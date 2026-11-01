# 04 — background extractor, save triggers, speckit hooks, /ctc-context (G4)

Status: ready-for-agent
Blocked by: 01, 02
Wave: 2 (parallel with 03; reaches 03 only through the job name `graph_build`)
Spec: `.scratch/context-coding-graph/spec.md`
Touches: src/ctc/graph/extract.py, config/context-mode.yaml, config/server.yaml, src/ctc/server/jobs.py, src/ctc/server/hooks.py, .claude/skills/ctc-context/SKILL.md, .specify/extensions.yml, tests/test_graph_extract.py

## What to build

tasks.md T023–T031 (Phase 5, US6 + US7 tick detection). Interfaces: contracts/context-mode.md, contracts/hooks.md (PostToolUse, speckit hooks), contracts/modules.md (extract.run_job), research.md R3/R4 (disableAllHooks, proc reuse).

## Acceptance criteria

- [ ] `tests/test_graph_extract.py` passes; no test calls the real `claude -p`.
- [ ] A Write to a spec file through the PostToolUse route queues `graph_build` + `graph_extract`; a rerun of extract on unchanged docs sends 0 chunks.
- [ ] `scripts/check.sh` green with and without the scratch URL.

## Comments
