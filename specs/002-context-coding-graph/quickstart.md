# Quickstart: validate m6 end to end

Run from the repo root on branch `m6-graph`. All steps use the scratch database; the live Supabase, the live daemon and the real `~/.claude` are only touched in the last section, with the owner's yes.

## Prerequisites

- `ctc-dev-pg` up on 127.0.0.1:18304 (`docker ps --filter name=ctc-dev-pg`); export its URL from `.env` line 3 into this shell only: `export CTC_DATABASE_URL=postgresql://…@127.0.0.1:18304/ctc`.
- TEI embedder on :18300 (`curl -s 127.0.0.1:18300/health`).
- graphify output for HEAD: `graphify update .` if `jq -r .built_at_commit graphify-out/graph.json` ≠ `git rev-parse HEAD`.
- Optional: claude-mem worker (`curl -s 127.0.0.1:37707/api/health`); everything works without it.

## 1. Coding graph (US1, T01)

```bash
uv run ctc graph import
uv run ctc graph status
```

Expect node/edge counts equal to graph.json's code + rationale subset and `built_at <sha8> · HEAD <sha8>` without `stale`. Run `import` twice: the second prints `skipped (built_at unchanged)`.

## 2. Context graph + links (US1, US2, T02, T03)

```bash
uv run python -m ctc.graph.parse            # self-check on the real files
uv run ctc graph build
```

Expect `stories 16` among the n8n-parity counts, `tickets 17`, the dated decisions, `links: … extracted, … inferred` and `tasks linked: <p>%`. Check one link by hand: `uv run ctc graph status` then the MCP `graph_explain("ctx:specs/001-n8n-parity:T010")` (step 4) names `src/ctc/storage/schema.sql`.

## 3. Freshness (US6, T04)

```bash
uv run ctc graph extract                 # first pass: sends changed chunks to claude -p (haiku)
uv run ctc graph extract                 # second pass: "0 sent"
```

Then edit one heading section of a spec through Claude (a Write/Edit tool call) and confirm, without typing a command, that `uv run ctc graph status` shows a newer `parse:<file>` age and that the next `extract` sends exactly 1 chunk. A quota stop prints `quota until <time>` and resumes later.

## 4. Pull tools and export (US5, T05)

With the daemon from this branch (see last section) or a test client mounting `/mcp`:
- `graph_search("retry a failed run from a node")` → includes `src/ctc/runner/engine.py` symbols and an n8n-parity story/task.
- `graph_affected("code:src_ctc_server_hooks_hook_prompt")` → callers + linked tasks.

```bash
uv run ctc graph export --kind context
graphify query "retry a failed run" --graph graphify-out/ctc-context.json
```

## 5. Push line and file note (US3, US4, T06)

```bash
uv run pytest -q tests/test_graph_push.py
CTC_CLAUDE_HOME=$(mktemp -d) uv run ctc install --dry-run   # diff shows PreToolUse Read|Edit|Write|MultiEdit → /v1/hook/pre
```

## 6. Evaluation (US8, T07)

```bash
uv run python -m evaluation.graph_eval            # builds with --no-commits on the scratch DB
```

Expect dev (01–08) and test (09–16) Recall@3, MetaTool false-trigger rate, graph-path p95 for the prompt line and the file note, each with PASS/FAIL; test Recall@3 ≥ 0.8 and false triggers ≤ 10% to pass.

## 7. Full check

```bash
scripts/check.sh
```

## Live (owner's yes, asked at the time)

1. Apply the schema to Supabase (`unset CTC_DATABASE_URL` so `.env` line 2 is used) and run `uv run ctc graph build`.
2. `scripts/deploy_local.sh` (restarts the daemon from this branch).
3. `uv run ctc install` (real `~/.claude`: adds the PreToolUse hook).
4. In a fresh Claude session here, type "retry a failed run from a node" and see the `ctc graph:` line; open `src/ctc/runner/engine.py` and see the file note.
5. `curl` p95 over 50 prompt hooks ≤ 150 ms and 50 pre hooks ≤ 50 ms (`python -m evaluation.graph_eval --daemon`).
