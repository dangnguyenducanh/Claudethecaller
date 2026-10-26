# 17 — run-inputs-and-builder

Status: ready-for-agent
Blocked by: 04
Spec: `.scratch/n8n-parity/spec.md` (read it first; this ticket implements part of it)
Touches: src/ctc/runner/graph.py (trigger inputs), src/ctc/runner/engine.py (input render), src/ctc/server/runs.py, src/ctc/server/mcp.py, src/ctc/cli.py (`--input k=v`, `workflow validate`), dashboard/src/Workflows.tsx (run dialog), .claude/skills/ctc-workflow-builder/SKILL.md (new), tests/test_inputs.py

## What to build

Trigger `inputs: [{name, type: string|number|bool|json, required, default, description}]`. Run start (editor dialog, CLI `--input name=value` repeatable, MCP `run_workflow` typed args, API) validates and coerces inputs; templates use `input.<name>`. Workflows without `inputs` keep the free-text `input`. `ctc workflow validate <file>` prints validation errors/warnings. A project skill `ctc-workflow-builder` that drafts a workflow YAML from a description using the documented node types, runs `ctc workflow validate`, and saves it under `.claude/ctc-workflows/`.

## Acceptance criteria

- [ ] Missing required input or wrong type is rejected at start with a clear message (API, CLI, MCP).
- [ ] The editor run dialog renders the declared inputs.
- [ ] The builder skill produces a workflow that validates (manual check recorded in the PR).
- [ ] `scripts/check.sh` green; tests added at the seam the spec names.

## Tests

API/MCP tests + graph tests; browser QC for the dialog.

## Comments
