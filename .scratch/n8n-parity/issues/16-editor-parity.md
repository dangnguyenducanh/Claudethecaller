# 16 — editor-parity

Status: ready-for-agent
Blocked by: none
Spec: `.scratch/n8n-parity/spec.md` (read it first; this ticket implements part of it)
Touches: dashboard/src/Workflows.tsx, dashboard/src/Runs.tsx, dashboard/src/types.ts, src/ctc/server/library.py (save conflict), src/ctc/runner/graph.py (rename helper only), tests/test_library_save.py

## What to build

Editor: undo/redo (keyboard + buttons, in-memory history of the graph), copy/paste selected nodes with their internal edges (as YAML text via clipboard, ids de-duplicated), node `notes` field shown on hover, rename node rewrites every `{{old.*}}` reference and edge (graph helper used by the editor through the API or ported logic). Save conflict: the save request carries the file hash the editor loaded; the server returns 409 when the file changed on disk, and the editor shows a reload/overwrite choice. Run page: a step list (node, visit, status, duration, tokens, error) under the canvas.

## Acceptance criteria

- [ ] Undo/redo, copy/paste, notes and rename work in browser QC (screenshots).
- [ ] Saving after an on-disk edit returns 409 and nothing is overwritten (API test).
- [ ] Rename rewrites templates in prompts and commands (graph unit test).
- [ ] `scripts/check.sh` green; tests added at the seam the spec names.

## Tests

API test for save conflict, graph test for rename, browser QC for the rest.

## Comments
