# 04 — run-control-mcp-cli

Status: ready-for-agent
Blocked by: none
Spec: `.scratch/n8n-parity/spec.md` (read it first; this ticket implements part of it)
Touches: src/ctc/server/mcp.py, src/ctc/server/runs.py (only if a helper is missing), src/ctc/cli.py (approve/reject), tests/test_mcp_runs.py

## What to build

MCP tools: `list_workflows` (id, name, scope, project, description, has_schedule), `workflow_status` returns steps with truncated outputs (cap per step) and errors, `approve_run`, `reject_run` (with note), `continue_run` (now|reset), `cancel_run`. Fix `run_workflow` for user-scope workflows that fail with `project_required` today (resolve the project from the caller's cwd or allow none for user scope). CLI: `ctc approve <run> [--note]` and `ctc reject <run> [--note]` calling the existing approve route.

## Acceptance criteria

- [ ] Every new MCP tool calls the same code path as the dashboard route and respects owner scoping.
- [ ] A user-scope workflow starts over MCP without `project_required`.
- [ ] `ctc approve/reject` move a waiting run on / end it, and print a clear error for a run that is not waiting.
- [ ] Tool descriptions are short and say what each returns.
- [ ] `scripts/check.sh` green; tests added at the seam the spec names.

## Tests

FastAPI/MCP test client on the scratch DB (skip without DB) for list/status/approve/reject/cancel.

## Comments
