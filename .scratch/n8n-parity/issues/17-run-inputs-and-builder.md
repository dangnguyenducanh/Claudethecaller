# 17 — run-inputs-and-builder

Status: resolved
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

2026-10-26 — resolved on branch `n8n-17-run-inputs-and-builder`, merged into `m5-n8n-parity` (tasks T149–T161, T163; T162 browser QC deferred to the final QC pass). Trigger `inputs: [{name, type: string|number|bool|json, required, default, description}]`; every start path (API, `ctc run --input name=value`, MCP `run_workflow(inputs=...)`, schedules) validates and coerces them in one place (empty = absent); templates use `input.<name>`; workflows without inputs keep free-text `input`. `ctc workflow validate <file>` prints errors and warnings (undeclared `input.<x>` is a warning). Editor run dialog renders declared inputs. New skill `.claude/skills/ctc-workflow-builder/SKILL.md` (manual check: drafted `.claude/ctc-workflows/inputs-demo.yaml`, validates). Tests: tests/test_inputs.py. Open: no editor fields for editing `inputs` (YAML/builder only); schedule form has no typed fields.
