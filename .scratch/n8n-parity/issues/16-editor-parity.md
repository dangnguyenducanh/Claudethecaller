# 16 — editor-parity

Status: resolved
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

2026-10-26 — resolved on branch `n8n-16-editor-parity`, merged into `m5-n8n-parity` (tasks T135–T146, T148; T147 browser QC deferred to the final QC pass). Editor: undo/redo (keys + buttons, in-memory history), copy/paste of nodes with internal edges as YAML (ids de-duplicated), node `notes` (validated as text), rename rewrites `{{old.*}}`, `path` and `resume_from` refs and edges (`graph.rename_node` + `renameRefs`), save-conflict prompt (reload/overwrite). Server: GET/PATCH capability return `file_hash`; PATCH with a stale `base_hash` returns 409 `changed_on_disk` (a deleted file counts). Run page: step list (node, visit, status, duration, tokens, error). Tests: tests/test_graph_editor.py, tests/test_library_save.py. Note for 13: a new node-id field under another key (foreach `items`) must be added to `rename_node` and `renameRefs`.
