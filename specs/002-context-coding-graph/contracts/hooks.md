# Contract: hooks

## Prompt hook (existing `POST /v1/hook/prompt`, T06)

After `route()` in `hooks._prompt`, when the project has a graph: `line = push.prompt_line(graph, qv)` where `qv = (await _embed(st, [prompt]))[0]` (an `emb:` cache hit). Response body = existing suggestion line, then `\n` + `line` when not empty. `line` is also written as `decision.graph_line`.

Line format (≤ ~80 tokens, ≤ 400 chars):

```text
ctc graph: <ctx label short> [<US#/ticket>] → <file>:<line> <symbol>(), <file>:<line> <symbol>() · decision: <≤ 60 chars>
```

Empty when the best context match's cosine < `graph_push.floor` (tuned in T07 on tickets 01–08), when no context node has a code link, or on any error.

## PreToolUse hook (new `POST /v1/hook/pre`, T06)

- Install: matcher `Read|Edit|Write|MultiEdit`, command `LC_ALL=C curl -sf -m 0.05 --unix-socket $HOME/.claudethecaller/ctc.sock --data-binary @- http://ctc/v1/hook/pre || true`.
- Input: Claude's PreToolUse JSON (`session_id, cwd, tool_name, tool_input.file_path`).
- Output: `200 application/json` `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "<note>"}}`, or `200` with an empty body. Never `permissionDecision`.
- Note (≤ ~60 tokens): `ctc graph: <file> implements T012 [US1], T017 [US9]; FR-012 · decision: <≤ 60 chars>` (≤ 3 tasks/requirements, ≤ 1 decision/constraint).
- Budget: `asyncio.wait_for(…, 0.04)`; RAM only (no DB, no embedder); skip when `_in_run(body)`.

## PostToolUse hook (existing `POST /v1/hook/tool`, T04)

For `tool_name in (Write, Edit, MultiEdit)` with `tool_input.file_path`:
- the `tool` event payload gains `file_path` (repo-relative when under cwd);
- when the path matches a context source (`specs/**.md`, `.scratch/**.md`, `PLAN.md`, `.claude/prds/*.md`, `CLAUDE.md`): `submit(st, "graph_build", {"cwd": cwd, "files": [rel]})` and `submit(st, "graph_extract", {"cwd": cwd, "files": [rel]})`, at most one queued job per kind and project (skip when one is already queued);
- when the path ends with `tasks.md` and the edit's new text ticks boxes (`- [x]`/`- [X]` on `T###` lines that were `- [ ]`): `submit(st, "graph_build", {"cwd": cwd, "tick": {"session_id": sid, "file": rel, "tasks": ["T012", …]}})`.
All inside the existing 50 ms budget; submits are fire-and-forget background tasks.

## speckit hooks (`.specify/extensions.yml`, T04)

```yaml
hooks:
  after_specify:  [{extension: ctc, command: ctc.context, description: "Rebuild the context graph", prompt: "build", optional: false}]
  after_plan:     [{extension: ctc, command: ctc.context, description: "Rebuild the context graph", prompt: "build", optional: false}]
  after_tasks:    [{extension: ctc, command: ctc.context, description: "Rebuild the context graph", prompt: "build", optional: false}]
  before_implement: [{extension: ctc, command: ctc.context, description: "Show task→code matches", prompt: "matches", optional: false}]
  after_implement:  [{extension: ctc, command: ctc.context, description: "Review inferred links", prompt: "review", optional: false}]
```

`ctc.context` → `/ctc-context` (dots become hyphens). The skill reads the prompt word as its sub-command.
