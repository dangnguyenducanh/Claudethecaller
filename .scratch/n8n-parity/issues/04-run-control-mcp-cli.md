# 04 — run-control-mcp-cli

Status: resolved
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

2026-10-26 — resolved on branch `n8n-04-run-control-mcp-cli`, merged into `m5-n8n-parity` (tasks T040–T046). MCP tools `list_workflows`, `workflow_status` (steps with outputs/errors cut to 2000 chars, marker), `approve_run`, `reject_run`, `continue_run` (now|reset), `cancel_run`, all through runs.py's route helpers (`scope`, `detail`, `approve`, `resume`, `cancel`) so owner scoping matches the dashboard; tools return `dict[str, Any]` so clients get structured content. `run_workflow` takes `project`; for a user/plugin workflow without one it uses the project of the newest hooked prompt (`ponytail:`), else `project_required`; still trigger `mcp`, no `pinned`. CLI `ctc approve|reject <run> [--note]`. Tests: tests/test_mcp_runs.py (9). For 17: add `inputs` to run_workflow and forward it to submit_run.
