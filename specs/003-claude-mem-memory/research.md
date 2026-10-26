# Research: claude-mem memory (m7)

Phase 0 for [plan.md](plan.md). Technical Context had no NEEDS CLARIFICATION: the 7-agent mapping and critic pass behind [`inventory.md`](../../.scratch/claude-mem-port/inventory.md) resolved them. This file records the choices that shape the build, each traced to the inventory.

## R1 — Capture cadence: one observer call per turn, at Stop

- **Decision**:
  - `/v1/hook/stop` queues an `observe` job per Stop. It is not queued when a job for the session is already *queued*; a *running* job does not suppress it.
  - SessionEnd queues a final one.
  - The job makes one `claude -p` call per chunk of about 32k chars, at most 8 per job.
  - Turns with no tool events after the gates make no call.
- **Rationale**:
  - claude-mem made 79 observer calls for 45 observations on this host; per-turn batching would have made about 6.
  - Upstream itself offers opt-in batching (A21).
  - Our single serial job worker and the owner's subscription quota favour fewer calls (D4).
- **Alternatives**: one call per tool use, as upstream does: live, but about 13× the calls. A long-lived Agent SDK conversation (A8): the Agent SDK is ruled out.

## R2 — Raw data stays on disk: transcript re-read with a byte watermark

- **Decision**:
  - The PostToolUse hook is unchanged.
  - The job reads the session's `.jsonl` from `sessions.observed_bytes`, restarts at 0 if the file shrank, and counts typed prompts into `sessions.observed_prompts`.
  - Raw tool I/O and prompts are never stored in Supabase.
- **Rationale**: B9's rule that Supabase keeps distilled knowledge, not logs (D1, D2). The transcript is already the durable queue, and `content_hash` + `unique` make re-reads idempotent.
- **Alternatives**: claude-mem's `pending_messages` / `tool_uses` tables (raw I/O in the cloud), and the hook spool (A6).

## R3 — Observer invocation reuses m6's hardened `claude -p`

- **Decision**:
  - Call `graph.extract.argv("haiku")` → `graph.extract._call` (→ `runner.proc.run_agent`), after `proc.preflight()`.
  - Use cwd = `graph_extract.dir`, so `hooks._in_run` already hides the observer's own session.
  - Pause on quota exactly like `graph/extract.py` (`quota_until`).
- **Rationale**: these flags are already verified on claude 2.1.306: no tools, one turn, no MCP, hooks off, no session file. That is equivalent to claude-mem's `hardened-options.ts` (A13).
- **Alternatives**: local Qwen via `Llm.json`: on-machine, but untested on the XML contract (D3 alternative).

## R4 — Prompts and parsing are translated from claude-mem

- **Decision**:
  - `plugin/modes/code.json` is copied verbatim into `config/observe-mode.yaml`: 9 types, 7 concepts, every prompt string.
  - `prompts.ts` builders and `parser.ts` are translated to Python with `re` + `html.unescape`: independent `<observation>`/`<summary>` blocks, the `<skip_summary/>` sentinel, label-wrapped title unwrap, one retry with `OBSERVATION_SCHEMA_REMINDER`.
- **Rationale**: these prompts and the parser are the part of claude-mem that has been tuned; copying keeps parity (A10, A12). Apache-2.0 allows it with attribution (R12).
- **Alternatives**: writing our own prompt (no parity baseline); JSON output (claude-mem's prompts are XML-shaped).

## R5 — Tag stripping and redaction run before every model call and every prompt write

- **Decision**:
  - New `ctc.memory.tags.strip_tags`: balanced and linear, at most 100 tags. Tags: `private`, `claude-mem-context`, `ctc-memory-context`, `system_instruction`, `system-instruction`, `persisted-output`, `system-reminder`.
  - It is used by `_prompt` (before routing, the decisions write and `sessions.title`), A3, B9 and `observe`.
  - `llm.client._redact` gains claude-mem's missing builtin patterns (github_pat, slack, stripe, google, PEM) and is applied to the observer prompt.
- **Rationale**: today `ai/extract.py`'s `INJECTED` regex does not match `<private>`, a real gap. Hooks are global, so `history.skip_projects` also gates capture (D14, D23).
- **Alternatives**: claude-mem's default with redaction off (our store is a cloud database).

## R6 — Two new tables beside `ctc.memories`, no merge

- **Decision**: `ctc.observations` and `ctc.session_summaries` (DDL in [data-model.md](data-model.md)), plus two `sessions` columns. `ctc.memories` is untouched.
- **Rationale**:
  - Memories are *trusted* (from the user's typed words only), CHECK-limited to 4 kinds, deduped by bands and measured by K4/H4.
  - Observations come from tool output, so they stay a labelled, untrusted layer and never enter `recall()` (D5, D6).
- **Alternatives**: adding `kind = 'observation'` to memories, which would mix trust levels and break the write_memory bands.

## R7 — Search: one SQL round trip, keyword + vector RRF

- **Decision**:
  - Keyword leg: `websearch_to_tsquery('simple', unaccent_i(q))`, widened to any-term OR when it returns fewer than `limit`.
  - Vector leg: one `vector(1024)` per observation (TEI doc embedding of title + subtitle + narrative + facts).
  - Merge with `sum(1/(60+rank))` over legs of 100.
  - Summaries get the keyword leg only.
  - Default window 90 days (`memory.search.recency_days`).
- **Rationale**: claude-mem's Postgres variant does the same (B6). `'simple'` + `unaccent_i` matches `capabilities` and handles Vietnamese diacritics (D13). Our TEI embedder reads 32k tokens, so per-field vectors are not needed (B5).
- **Alternatives**: Chroma per-field documents; `'english'` stemming; iterative scan, which needs pgvector ≥ 0.8 (`ponytail:` noted).

## R8 — Session start: claude-mem's agent template, budgeted, Redis-warm

- **Decision**:
  - Template and rules as inventory §5: newest 50 observations + 11 summaries, day groups, `"` for repeated times, S-lines, last-summary fields, stats and savings, instructions, welcome hint, `<ctc-memory-context>` wrapper.
  - The 10,000-char budget *includes* the instructions; this fixes an upstream bug.
  - The body is cached at `ctx:{user}:{project_id}` (TTL 600 s) and re-rendered by `observe` at the end of each job.
  - Hook: `curl -m 1`, matcher `startup|clear|compact`, never `resume`.
- **Rationale**:
  - The text is what the agent learns from, so parity matters (C2).
  - A warm key keeps normal starts inside 150 ms; `-m 1` covers a cold miss without blocking, because the hook fails open (D16).
  - Skipping `resume` keeps the prompt-cache prefix byte-stable.
- **Alternatives**: `-m 0.15` (an empty context on a cold miss); computing on every start.

## R9 — MCP tools named `memory_*`, gated on claude-mem's hooks being off

- **Decision**:
  - `memory_search`, `memory_timeline`, `memory_get`, in the shapes of contracts/mcp.md: strict arguments, clamps, "Next:" hints, evidence framing.
  - Project resolution reuses `mcp._graph`'s logic: the name or path argument, else the latest session's project.
  - The tools are enabled once claude-mem's hooks are disabled.
- **Rationale**: claude-mem's PreToolUse bridge matches `^mcp__.+__memory_search$` and would add up to 10,000 chars of its own results to our calls. Its recursion guard does not catch our tools (D8, D11, critic-verified).
- **Alternatives**: `mem_*` names, which avoid the bridge but differ from claude-mem's vocabulary that agents already know.

## R10 — Viewer: Timeline tab inside Memories, 3 s polling

- **Decision**:
  - Segmented **Timeline | Long-term** in `Memories.tsx`.
  - Cards (observation, summary, prompt) are translated into `parts.tsx`.
  - Chips with server-side counts; keyset feed (`before=<iso>,<kind>,<id>`, ordered by `(created_at, kind rank, id)`, because observation, summary and decision ids are separate sequences).
  - Poll `after=<newest>` every 3 s while visible.
  - "extracting N…" pill from jobs; context preview Drawer; three colour-token families in `styles.css`.
- **Rationale**: the owner's target is the existing Memories page (spec Clarifications). SSE would need Redis pub/sub across workers (D15).
- **Alternatives**: a separate page or the claude-mem viewer itself; SSE.

## R11 — m6 claude-mem reader and the claude-mem plugin stay during m7

- **Decision**: `graph/claudemem.py` and the plugin remain until our capture is shown to match side by side. Repointing the reader (with a watermark reset and new origin, D7) and importing the old DB (D9) are follow-ups.
- **Rationale**: this lets us compare the two, and avoids touching m6 before its PR merges.
- **Alternatives**: replacing the reader in m7, which would mean editing m6 code under review.

## R12 — Licence and attribution

- **Decision**:
  - `third_party/claude-mem/{LICENSE,NOTICE}` copied verbatim.
  - Header on each derived file: `# Adapted from claude-mem 15.2.1 (Apache-2.0, © 2026 Alex Newman): <path>. Changes: <what>.`
  - No claude-mem name or logo in our UI.
  - A CLAUDE.md Decision records claude-mem as a translated source, never a dependency.
- **Rationale**: Apache-2.0 §4 (notice + changes) and §6 (no trademark rights); `docs/ip-boundary.md` reserves only features we skip (§8, D22).
- **Alternatives**: none; this is what the licence requires.

## R13 — A `memory.enabled` switch, off by default

- **Decision**: `memory.enabled: false` in `config/server.yaml`. While false: no `observe` job is queued, `/v1/hook/start` answers empty, and the `memory_*` tools answer "memory is off". The owner flips it at go-live, after disabling claude-mem's hooks.
- **Rationale**: a daemon restart with the O2 code would otherwise start capturing every turn of every repo at once (hooks are global; `history.skip_projects` is empty by default), and the `memory_*` tools would go live while claude-mem's PreToolUse bridge still fires on `memory_search` (D8, D11). A switch makes the safe order (schema → restart inert → disable claude-mem → enable → install the hook) explicit and reversible.
- **Alternatives**: relying on the order of the owner's steps alone (nothing enforces it); a separate feature flag per surface (three flags for one decision).

## R14 — The transcript is read only up to where the Stop hook saw it

- **Decision**: `_stop` records `upto = transcript size` at Stop time in the job payload (raised with `greatest` if a job is already queued). The job reads through the last `\n` at or before `upto`. A turn boundary is any main-chain user row with text and no tool result, with private openers counted, so private prompts never leak their tool events into the previous turn.
- **Rationale**: the serial worker often runs the job while the next turn is already being written. Reading to EOF would capture half a turn and move the watermark into the middle of the next one. `history.typed_prompt` drops anything starting with `<`, which is exactly what a `<private>` prompt is.
- **Alternatives**: reading to EOF and detecting an unfinished turn from `stop_reason` (works only if every row is flushed in order); a per-turn job queued at prompt time (more jobs, more model calls).

## R15 — Work happens in a worktree, against a scratch Redis

- **Decision**: all build and test work runs in `.worktrees/m7`, with `CTC_REDIS_URL` on a scratch Redis (`:18395`) and the scratch Postgres.
- **Rationale**: the live daemon runs from the main checkout and serves its `dashboard/dist`, so building there changes what the owner sees. The real Redis `:18303` shares consumer groups (`writers`, `workers`) and `ctx:` keys with the live daemon, so a scratch daemon on it could consume real hook rows and write them to production Supabase (`scripts/check.sh` already warns against it).
- **Alternatives**: db 1 of the real Redis (still the same server and memory limit); working in the main checkout (risks the live dashboard and branch state).

## Still unverified (tested in the quickstart, not assumed)

- That Claude Code honours the stdout JSON of a `curl … || true` SessionStart command. The test is a temp `CTC_CLAUDE_HOME` + one `claude -p` start, run only with the owner's yes.
- `${CLAUDE_PROJECT_DIR}` expansion in HTTP MCP headers. Not relied on: R9 resolves the project without it.
