# Quickstart: validate claude-mem memory (m7)

Each scenario runs on the **scratch stack**: scratch Postgres `ctc-dev-pg` (127.0.0.1:18304) and an isolated daemon on `:18311` with its own socket and a HOME in the scratchpad. Steps marked **(owner yes)** touch something real and are asked for at the time. Shapes are in [data-model.md](data-model.md) and [contracts/](contracts/).

## 0. Prerequisites

- Work in the git worktree `.worktrees/m7` (tasks T000), not the main checkout: the live daemon on `:18310` runs from the main checkout and serves its `dashboard/dist`.
- `CTC_DATABASE_URL` points at the scratch DB. The commented URL in `.env` works; never the Supabase one. The worktree has no `.env`, so export it.
- `CTC_REDIS_URL=redis://127.0.0.1:18395/0` points at the scratch Redis (**owner yes** to start it: `docker run -d --rm --name ctc-scratch-redis -p 127.0.0.1:18395:6379 redis:8.2`). Never the real Redis on `:18303`: it shares consumer groups and `ctx:` keys with the real daemon, so a scratch daemon could consume its hook rows and write them to production Supabase.
- TEI embedder `:18300` is up (`uv run ctc status`).
- The dashboard builds: `pnpm -C dashboard build` (the worktree's own `dist`; never leave a `VITE_MOCK=1` build in it).

## 1. Unit and self-checks (every ticket)

```bash
uv run ruff check src tests evaluation
uv run pytest -q tests/test_memory_*.py
uv run python -m ctc.memory.tags          # strip_tags self-check
uv run python -m ctc.memory.observe       # parser + turn reader on a fixture transcript
uv run python -m ctc.memory.observations  # render + budget on synthetic rows
```

Expected: all pass.
- `tags`: private, nested, unbalanced and 100+ tag cases.
- `observe`: the fixture turn yields the expected types and files, the private turn yields nothing, and a second run adds 0 rows.
- `observations`: the rendered index is ≤ 10,000 chars for 0, 5 and 500 observations.

## 2. Schema on scratch

```bash
CTC_DATABASE_URL=<scratch db> uv run ctc status   # Store.open() re-applies schema.sql whenever its hash (schema comment) changes
```

Expected: `observations`, `session_summaries`, `sessions.observed_bytes`/`observed_prompts` and their indexes exist, and re-applying is a no-op.

## 3. Capture with a fake observer (US1, US6, SC-002, SC-006)

1. Start the isolated daemon:

   ```bash
   HOME=<scratch>/home CTC_PORT=18311 CTC_SOCKET=<scratch>/ctc.sock CTC_DATABASE_URL=<scratch db> CTC_REDIS_URL=redis://127.0.0.1:18395/0 \
     CTC_CLAUDE_BIN=$PWD/tests/fixtures/fake-claude-observe.sh CTC_DASHBOARD_DIST=$PWD/dashboard/dist uv run ctc daemon start
   ```

   `memory.enabled` must be true for this daemon (set it in the scratch HOME's config override, or temporarily in `config/server.yaml` inside the worktree; it stays false in the committed file).

2. Copy a recorded transcript fixture (`tests/fixtures/transcript-m7.jsonl`) under `<scratch>/home/.claude/projects/<p>/`. It has 3 turns: one with Read/Edit/Bash, one chat-only, and one with a `<private>` prompt, a planted `ghp_…` token and a PEM block in tool output.
3. The fake script `tests/fixtures/fake-claude-observe.sh` (already set as `CTC_CLAUDE_BIN` above) answers `--version` and `auth status --json` for the preflight and returns canned XML.
4. POST a UserPromptSubmit body (same `session_id`, `cwd` and `transcript_path`) to `/v1/hook/prompt` first, so the `projects` and `sessions` rows exist (the Stop hook alone creates neither, and the job skips a session with no row). Then POST the Stop hook body to `/v1/hook/stop`, and wait for the `observe` job: `GET /api/jobs?kind=observe`.

Expected:
- Turn 1 → observations with the expected types, `files_modified` contains the edited path, and one summary.
- Turn 2 → no call.
- Turn 3 (the `<private>` prompt) → nothing stored, and its tool events do not leak into turn 2.
- `sessions.observed_bytes` equals the end of the last complete turn.
- A planted 250-char tool-result quote in the canned reply is not stored.
- Privacy scan over observations, summaries, sessions, decisions and jobs: 0 hits for the private text, the token and the PEM, and no ≥ 200-char tool-output substring.
- POST Stop again → job result `observations: 0`.

## 4. Session start (US2, SC-003, SC-004)

```bash
curl -s --unix-socket <scratch>/ctc.sock --data-binary @start.json http://ctc/v1/hook/start | jq -r .hookSpecificOutput.additionalContext
```

Expected:
- The template matches contracts/hooks.md and inventory §5, wrapped in `<ctc-memory-context>`, ≤ 10,000 chars.
- `source: resume` → empty.
- A warm call returns in < 150 ms (`curl -w '%{time_total}'`). After deleting the `ctx:` key (cold), it returns in ≤ 1 s.
- With the daemon stopped, `curl -m 1 … || true` exits 0 with no output.
- `CTC_CLAUDE_HOME=<tmp> uv run ctc install --dry-run` lists a SessionStart entry with matcher `startup|clear|compact` and `-m 1` (an empty home also lists the other five hooks).

## 5. MCP pull (US3, SC-007)

From an MCP client on `http://127.0.0.1:18311/mcp`:
- `memory_search({query: "edit"})` → an index with a "Next:" hint.
- `memory_timeline({anchor: <id>})` → a window with the anchor marked.
- `memory_get({ids: [<id>, "S<n>"]})` → full records with evidence framing.
- `memory_search({})` → an error naming what is needed. While `memory.enabled` is false every tool answers "memory is off".
- With sessions in two projects started in the last 12 h, a call without `project` → an error asking for `project=<name>`.

## 6. Dashboard (US4, US5, SC-008, SC-009)

1. The daemon from §3 serves the worktree's `dashboard/dist` (`CTC_DASHBOARD_DIST=$PWD/dashboard/dist`). Open `http://127.0.0.1:18311/#memories`.
2. Check:
   - Timeline is the default tab; chips show counts; filtering by two types matches the counts.
   - Search finds a title word; scrolling reaches "No more items to load".
   - Delete + Undo works, and the deleted item is gone from `memory_search` and from `/v1/hook/start` until restored.
   - A new capture appears within 5 s.
   - The context preview equals the step-4 output.
   - The session drawer shows observations and "Open in Memories".
   - Long-term is unchanged.

## 7. Regression (SC-010)

```bash
uv run pytest -q tests          # m6 graph tests + capability tests still pass
scripts/check.sh                # with CTC_DATABASE_URL / CTC_REDIS_URL on scratch
```

## 8. Live (owner yes each, after wave 4)

In this order (the order matters because claude-mem's PreToolUse bridge fires on `memory_search`, and capture would otherwise start for every repo at the first restart):
1. Apply the schema to Supabase.
2. Restart the daemon (`scripts/deploy_local.sh`). `memory.enabled` is still false, so capture, the session-start route and the `memory_*` tools are inert.
3. The owner disables the claude-mem plugin's hooks.
4. The owner sets `memory.enabled: true` (and `history.skip_projects` for repos that must never be captured) and restarts the daemon.
5. Run `ctc install` on the real `~/.claude` (adds SessionStart), then check in a fresh session that the index appears.
6. Run one real haiku capture on a real session.
7. SC-001 and SC-005: over one day compare each Stop time with its observations' `created_at` (≥ 95% within 2 minutes), and sum the `observe` jobs' `calls` against the session's `tool_use` count (≥ 10× fewer).
8. Run `uv run python evaluation/observation_eval.py data/processed/memory-questions.jsonl --project claudethecaller` (H5 questions) → hit@5 ≥ 16/20. `evaluation/memory_eval.py` is the existing K4/H4 eval and is not used here.
