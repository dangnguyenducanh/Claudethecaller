# Research: Context + coding graph (m6)

All questions were settled by the owner grilling (Q1–Q26) and design.md; this file records the facts checked on 2026-10-26 that the plan relies on, and the few builder-level calls they forced.

## R1. graphify output format (coding graph source)

- **Decision**: Import nodes with `file_type in ('code', 'rationale')` and the links whose both ends are imported. Node fields used: `id`, `label`, `file_type`, `source_file`, `source_location` (`"L<n>"`, start line only), `community_name`. Link fields: `source`, `target`, `relation`, `confidence`, `confidence_score`. Graph-level `built_at_commit` is the freshness key.
- **Rationale**: Checked on HEAD `7f05fc9`: 2,061 nodes, of which 1,396 are code + rationale; relations `calls 1505, contains 1355, imports 705, references 496, imports_from 360, rationale_for 251, uses 126, method 87, indirect_call 78, inherits 68, defines 28`. Every `rationale_for` edge goes rationale → code, so a code node's text = its label + the text of rationale nodes pointing at it + its file path.
- **Alternatives**: graphify's MCP server (`serve.py`) or `graphify query` subprocess: rejected (0.5 s per call, label-match entry, no context graph). Importing graphify as a library: rejected by Q5.

## R2. Claude Code PreToolUse additional context

- **Decision**: `/v1/hook/pre` returns `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "<note>"}}`, never `permissionDecision`, and an empty body when there is nothing to say.
- **Rationale**: The installed Claude Code 2.1.306 binary's PreToolUse output schema contains `additionalContext: o().optional()` next to `permissionDecision`, `updatedInput`; the result builder copies it through. So design.md's PostToolUse fallback is not needed.
- **Alternatives**: PostToolUse additionalContext (arrives after the read; kept only as a fallback if a later CLI drops the field).

## R3. Keeping the extractor's own sessions out of every hook

- **Decision**: the extractor runs `claude -p` with `--settings '{"disableAllHooks": true}'`, cwd `~/.claudethecaller/extract/`, `child_env()`; `hooks._in_run` also skips any cwd under that dir as a second guard.
- **Rationale**: `disableAllHooks` is a setting in 2.1.306 (86 occurrences in the binary, including the "hooks modules are turned off here (disableAllHooks …)" message). It also keeps claude-mem from recording the extractor's sessions. The m5 runner already uses the same "cwd under a ctc dir" guard (`engine.in_runs`).
- **Alternatives**: cwd guard only: would still let claude-mem observe the extractor.

## R4. Running the extractor through the runner's process code

- **Decision**: reuse `runner/proc.py`'s `preflight()` (must be `ok`, `authMethod == "claude.ai"`, pinned version), `_bin()` and `run_agent(argv, prompt, cwd, log_path)`, whose result gives `status` (`done | failed | timeout | quota`), `output.result`, `usage`, `resets_at`. The argv is built in `extract.argv()`, not with `agent_argv` (review fix, 2026-10-26): `--model haiku --max-turns 1 --tools "" --no-session-persistence --permission-mode dontAsk --strict-mcp-config --mcp-config {"mcpServers":{}} --settings {"disableAllHooks":true}`. `--allowedTools` only pre-approves tools, so `--tools ""` is what removes them; `agent_argv` would add the workflow node's "use the tools you have" system prompt and acceptEdits; `--no-session-persistence` keeps the extractor's sessions out of `~/.claude/projects` and so out of the history import.
- **Rationale**: one place for auth, version pin, quota detection and usage parsing; claude-mem itself uses the same `claude` CLI 2.1.306 on the owner's login.
- **Alternatives**: the local Qwen 3B via `Llm`: rejected by the owner (too weak for this extraction).

## R5. claude-mem observations

- **Decision**: `GET http://127.0.0.1:37707/api/observations?project=<name>&limit=<n>` → `{"items": [...]}`; fields used: `id, type, title, subtitle, narrative, facts, concepts, files_read, files_modified, created_at`. Project name = claude-mem's `git-remote` naming (`dangnguyenducanh/Claudethecaller` here); read it from config `graph_links.claudemem_project` when set, else derive `<owner>/<Repo>` from `git remote get-url origin` the way claude-mem does **[call]**. Incremental by the largest `id` seen (stored in `graph_sources`). Worker down / timeout 1 s → skip silently.
- **Rationale**: endpoint verified live (worker `ok`, version 15.2.1, provider `claude`). Only 2 observations exist for this repo today, both seeded memories.

## R6. Ticket commits (EXTRACTED links and eval truth)

- **Decision**: a ticket NN of feature F links to commits whose subject ends `(<words> NN)` where the words come from the feature's commit tag (n8n-parity: `n8n parity`), found with `git log --all --no-merges --format=%H%x09%s`; changed hunks via `git show -U0 <sha>`; a hunk maps to the graphify node in that file with the greatest `source_location` start line ≤ the hunk start **[call]**. The tag words per feature come from the ticket files' own commit convention; for n8n-parity the regex is `\(n8n parity (\d{2})\)$`. Merge commits are excluded.
- **Rationale**: tags `(n8n parity 01)` … `(n8n parity 16)` exist on `m5-n8n-parity` (33 commits ahead of staging, not merged). Ticket 17 has no tagged commit.
- **Eval consequence**: n8n-parity's code is not on `staging`, so truth = changed non-test files **that exist in the current coding graph**; a ticket whose truth set becomes empty is dropped and logged. Spot check: tickets 01/03/05/09/12/16 keep 1/5/3/8/9/6 of their 2/5/4/8/9/6 non-test files.

## R7. Config merge

- **Decision**: new knobs live under distinct top-level keys: `graph_links` and `graph_push` in `config/retrieval.yaml`, `graph_extract` in `config/server.yaml`.
- **Rationale**: `config.cfg()` merges `models.yaml`, `retrieval.yaml`, `server.yaml` with `out.update(...)`, so one top-level key in two files would be overwritten whole.

## R8. Jobs, writer, State

- **Decision**: job handlers follow the existing signature `async def run_job(st, payload: dict, progress) -> dict` and register in `server/jobs.py HANDLERS` as `"graph_build": "ctc.graph.build:run_job"`, `"graph_extract": "ctc.graph.extract:run_job"` (both added to `UNTIMED`: an embedding pass or a quota pause can pass 60 s). Decisions get a nullable `graph_line text` column, written through `writer.py`'s `decision` SQL and defaults. `State` gets `graphs: dict = field(default_factory=dict)`.
- **Rationale**: matches `indexer.run_job`, the writer's explicit column list (`SQL["decision"]`, `DEFAULTS["decision"]`) and the State dataclass in `server/state.py`.

## R9. Environment for builders

- Scratch Postgres `ctc-dev-pg` (pgvector pg17) is up on 127.0.0.1:18304; its URL is the commented line 3 of `.env` (never print the password; never use line 2, the Supabase pooler). TEI embedder up on :18300. The live daemon is up on :18310 and must not be restarted without the owner's yes.
- graphify regenerates `graphify-out/graph.json` on every main-checkout commit (post-commit hook), so tests must use a small fixture graph, not the live file, for exact counts.
