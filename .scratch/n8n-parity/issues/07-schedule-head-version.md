# 07 — schedule-head-version

Status: ready-for-agent
Blocked by: none
Spec: `.scratch/n8n-parity/spec.md` (read it first; this ticket implements part of it)
Touches: src/ctc/runner/schedule.py, src/ctc/server/runs.py (schedule enable path), tests/test_schedule.py

## What to build

A scheduled run of a project-scope workflow loads the file from the project's committed HEAD (`git show HEAD:<path>`), not the working tree; the run records that commit's file sha. User-scope workflows run as saved. Enabling a schedule validates the graph first and rejects with the validation errors (compare.md cheap fix 6). If the file is not committed, the scheduled fire is skipped with a logged reason (no run created).

## Acceptance criteria

- [ ] A workflow edited but not committed fires with the committed version (test with a tmp repo).
- [ ] An uncommitted new workflow's schedule fires nothing and logs why.
- [ ] Manual/CLI/MCP runs keep using the saved file as today.
- [ ] `scripts/check.sh` green; tests added at the seam the spec names.

## Tests

Unit tests with a tmp git repo; engine seam not needed.

## Comments
