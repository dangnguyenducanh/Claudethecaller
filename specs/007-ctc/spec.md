# 007-ctc: claudethecaller, the target system

Status: **draft, waiting for owner approval**. Written 2026-10-30, ctc pinned at `a244268` (branch `m9-project-manager`).
This is the main spec: what ctc is and how each core feature works. [006-merged-core](../006-merged-core/spec.md) remains the research record, covering where each design comes from (graphify, Langfuse, claude-mem, Orca) and the `file:line` evidence. Spec 005 is retired.

| Section | What it answers |
|---|---|
| [0. What ctc is](#0-what-ctc-is) | the job, the 4 features, what is out |
| [1. System](#1-system) | stack, processes, code map, interfaces, storage, auth, API rules, caching, failures |
| [2. F1 Context graph](#2-f1-context-graph) | one graph of code, specs, tasks, decisions, skills and workflows; the per-prompt line; query tools |
| [3. F2 Skill library](#3-f2-skill-library) | versioned skills, agents, commands and workflows; labels; version-pinned reads |
| [4. F3 Memory](#4-f3-memory) | learn from sessions; context at session start; search |
| [5. F4 Workflows](#5-f4-workflows) | saved workflows that run agents in worktrees; attempts, gates, fan-out, recovery |
| [6. Retrieval](#6-retrieval) | the RAG checklist across the three search channels |
| [7. Verification gates](#7-verification-gates) | every test and metric that defines done |
| [8. Tasks](#8-tasks) | build order |
| [9. Decisions](#9-decisions) | defaults in bold, used everywhere above |
| [10. Open items](#10-open-items) | unverified points |

Naming rule in this document: files that exist today are links; planned files are written without an extension (test `graph.ids` lives in the Vitest file of that name).

---

## 0. What ctc is

ctc is a local service beside Claude Code. It knows the project (code and plans), the user's skill library and what past sessions learned, and it runs saved multi-agent workflows. Claude Code reaches it through hooks, MCP tools and a dashboard.

| # | Feature | What the user gets | Hot path | Learned from |
|---|---|---|---|---|
| F1 | **Context graph** | One graph of code, specs, tasks, decisions, skills and workflows. On every prompt: one line naming the task, the file and symbol, the skill and the decision that apply. Before Read/Edit/Grep: a note on what touches that file. MCP: search, explain, path, affected. | prompt 140 ms, pre 40 ms | graphify + ctc's context graph |
| F2 | **Skill library** | Every skill, agent, command and workflow is versioned. Labels (`production`, `latest`, own labels) pick the served version. Multi-file skills keep their files. Projects pin a label or version. | none (feeds F1 seeds) | Langfuse prompt and skill management |
| F3 | **Memory** | Facts and session summaries learned from your sessions; a context block at session start under 10,000 chars; MCP search that returns an index first. | start 1,200 ms | claude-mem + ctc's local extractor |
| F4 | **Workflows** | Saved workflows run `claude -p` / `codex` steps in git worktrees. Steps are attempts that survive a crash. Approvals offer options. A step fans out to N agents in their own worktrees. | none | Orca |

**Out of scope (removed 2026-10-30):** the plan for a suggestion (`find_capabilities`, `/v1/bundle`); follow tracking and the adoption KPI (`decisions`, `events`, `/api/kpis`, `/timeline`, `/activity`); the separate route/decide pipeline (`/v1/route`). Without decisions and events there is no telemetry volume, so **no ClickHouse**.

**Not goals:** public ingestion, webhooks, roles/RBAC, remote or mobile access, an LLM scheduler for workflows, PTY terminals.

## Graphs

| Graph | File |
|---|---|
| Architecture: 12 numbered steps, hot (red) and cold (blue) | [arch.svg](arch.svg) |
| Application map: features, surfaces, stores | [app-map.svg](app-map.svg) |
| F1 flows: build, rebuild, parse, suggest, note, query | [flow-graph.svg](flow-graph.svg) |
| F2 flows: scan, changed, label, pin, load, restore | [flow-library.svg](flow-library.svg) |
| F3 flows: capture, drain, learn, summarize, import, recall, search | [flow-memory.svg](flow-memory.svg) |
| F4 flows: start, attempt, finish, gate, fan-out, recover, clean up | [flow-workflow.svg](flow-workflow.svg) |
| F4 step state machine (14 transitions) | [state-step.svg](state-step.svg) |

Regenerate: `cd specs/007-ctc && python3 -I mk_graphs.py .`, then `convert -background white -density 110 X.svg X.png` per file.

---

## 1. System

### 1.1 Stack

| Layer | Choice | Version |
|---|---|---|
| Language / runtime | TypeScript strict on Node | TS 6, Node 24.22 |
| Monorepo | pnpm workspace | pnpm 12 |
| HTTP | Fastify (unix socket + loopback port) | 5 |
| Queue | BullMQ on Redis, plus a file spool for hooks | BullMQ 5, Redis 8 |
| Database | Postgres + pgvector through Kysely on `pg` | Postgres 17 |
| Validation | Zod for routes, MCP tools, queue payloads, YAML config | 4 |
| MCP | `@modelcontextprotocol/sdk` (Streamable HTTP at `/mcp`) | 1.x |
| Parsing | web-tree-sitter (WASM grammars) + a markdown parser | — |
| Graph algorithms | own adjacency lists; graphology for Louvain later | — |
| Models | TEI SKILLRET-0.6B embedder (1,024-d) `:18300`, TEI bge reranker `:18301`, llama-server Qwen2.5-3B `:18302` | unchanged |
| Agents | `claude -p --output-format stream-json`, `codex exec` | user's own login |
| Tests / lint | Vitest, ESLint, `tsc --noEmit` | 4, 10 |
| Dashboard | React + Vite (existing pages, reworked) | — |
| Offline evals | Python [`evaluation`](../../evaluation/) calling `POST /v1/suggest` | unchanged |

### 1.2 Processes and code map

| Process | Runs | Count |
|---|---|---|
| `ctc-web` | Fastify: hooks, spool drain, `/api`, `/mcp`, static dashboard; holds the RAM graph and skill vectors | 1 local; N in shared mode |
| `ctc-worker` | BullMQ consumers for 7 queues | 1 (llama-server has one slot) |
| Postgres + pgvector, Redis, TEI ×2, llama-server | existing services | — |

Local mode runs `ctc-web` and `ctc-worker` on the host as `systemd --user` units (`Restart=on-failure`, `StartLimitBurst=5/60s`), since the runner needs the user's `claude` login and repos. `ctc daemon start|stop|status` wraps them. Shared mode: docker compose. The web process exits 78 if it cannot bind in 60 s.

| Module (pnpm workspace) | Logic inside | Replaces (Python today) |
|---|---|---|
| `apps/web` | hooks, spool drain, `/api`, `/mcp`, RAM graph + skill vectors, `ctc:inval` listener | [`src/ctc/server/app.py`](../../src/ctc/server/app.py), [`src/ctc/server/hooks.py`](../../src/ctc/server/hooks.py), [`src/ctc/server/api.py`](../../src/ctc/server/api.py), [`src/ctc/server/library.py`](../../src/ctc/server/library.py), [`src/ctc/server/runs.py`](../../src/ctc/server/runs.py), [`src/ctc/server/mcp.py`](../../src/ctc/server/mcp.py) |
| `apps/worker` | queues `graph`, `library`, `llm`, `memory`, `runner`, `cleanup`, `dlq-retry` | [`src/ctc/server/jobs.py`](../../src/ctc/server/jobs.py), [`src/ctc/runner/engine.py`](../../src/ctc/runner/engine.py), [`src/ctc/graph/build.py`](../../src/ctc/graph/build.py), [`src/ctc/graph/extract.py`](../../src/ctc/graph/extract.py), `ingestion/*`, `ai/*` |
| `apps/cli` | `ctc` commands (same names minus `route`), plus `ctc hook spool` and `ctc migrate` | [`src/ctc/cli.py`](../../src/ctc/cli.py) |
| `hooks/spool` | POSIX sh: stdin → one atomic spool file → 250 ms background nudge | new |
| `packages/shared/repositories` | the only module with SQL; one file per domain; `ctx` first argument | ~380 SQL sites |
| `packages/shared/schemas`, `env`, `queues`, `migrations` | Zod schemas, config loader, queue names + payloads, numbered SQL | [`src/ctc/server/schemas.py`](../../src/ctc/server/schemas.py), [`src/ctc/config.py`](../../src/ctc/config.py), [`src/ctc/storage/schema.sql`](../../src/ctc/storage/schema.sql) |
| `packages/core/graph` | ids, extract, resolve, query, explain, path, affected, push (line, note, hint), sanitize | `graph/*.py` |
| `packages/core/library` | scan, frontmatter, manifest, version diff, resolve served version | [`src/ctc/ingestion/scanner.py`](../../src/ctc/ingestion/scanner.py), [`src/ctc/ingestion/indexer.py`](../../src/ctc/ingestion/indexer.py) |
| `packages/core/memory` | parse model reply, bands, RRF, recall score, fit-by-measuring | [`src/ctc/memory/longterm.py`](../../src/ctc/memory/longterm.py), [`src/ctc/ai/extract.py`](../../src/ctc/ai/extract.py) |
| `packages/core/runner` | walker (pure), transition table, preamble, worktree recipe, agent registry | [`src/ctc/runner/graph.py`](../../src/ctc/runner/graph.py), [`src/ctc/runner/proc.py`](../../src/ctc/runner/proc.py), [`src/ctc/runner/engine.py`](../../src/ctc/runner/engine.py) |

`packages/core` is pure (no I/O); `apps/*` wire it to stores. ESLint bans `pg` and `kysely` imports outside `packages/shared/repositories`.

### 1.3 Interfaces

| Way in | Endpoint / name | Reply |
|---|---|---|
| Hook UserPromptSubmit | `POST /v1/hook/prompt` (curl `-m 0.15`) | `200 text/plain`, one line or empty (F1) |
| Hook PreToolUse | `POST /v1/hook/pre` (curl `-m 0.05`) | `200` JSON `additionalContext`, or empty (F1) |
| Hook SessionStart | `POST /v1/hook/start` (curl `-m 1.5`) | `200 text/plain` ≤ 10,000 chars, or empty (F3) |
| Hooks PostToolUse, Stop, SessionEnd | `hooks/spool` writes a file; `POST /v1/spool/nudge` | exit 0 always (F1, F3) |
| Debug / eval | `POST /v1/suggest {prompt, cwd}`, `GET /v1/health` | JSON with seeds, candidates, line, timings |
| Dashboard | `/api/*` (per feature below) | JSON |
| MCP (13 tools) | F1 `graph_search`, `graph_explain`, `graph_path`, `graph_affected`, `graph_neighbors`; F2 `get_capability`, `load_capability_resource`; F3 `mem_search`, `mem_timeline`, `mem_get`, `save_memory`; F4 `run_workflow`, `workflow_status` | text or JSON |
| CLI | `ctc …` | exit 0 ok / 1 error / 2 usage / 3 daemon down |
| File reads | `~/.claude` skills, agents, commands, workflows, memory files, transcripts; project repos | — |

### 1.4 Storage

| Engine | Owns |
|---|---|
| Postgres 17 + pgvector, schema `ctc` | all state: tables listed per feature, plus `projects`, `sessions`, `history_files`, `jobs`, `api_keys`, `idempotency_keys`, `dedup_review` |
| Redis 8 | BullMQ queues and failed sets, L2 cache, epoch tokens, rate limit, `ctc:inval` pub/sub |
| File system | spool (`~/.claudethecaller/spool`), worktrees (`<repo>/.ctc/wt/<run>/<step>`), run logs (`~/.claudethecaller/runs/<run>/<step>.jsonl.gz`) |

Shared tables:

| Table | Columns | Notes |
|---|---|---|
| `projects` | id, user_id, root, profile_hash | unchanged |
| `sessions` | id, user_id, project_id, started_at, ended_at, model, tokens, transcript_path | no decisions, no turn counter |
| `history_files` | path, size, mtime, status | feeds F3 distill |
| `jobs` | id, queue, kind, status (queued / running / done / failed / dead), progress, result, error, created_at | the Postgres row is the truth; BullMQ carries it |
| `idempotency_keys` | key PK, route, payload_hash, response jsonb, created_at | pruned after 30 days |
| `api_keys` | unchanged | shared mode only |

Migrations are numbered SQL files applied by `ctc migrate`. A schema stamp makes a binary older than the database refuse to start. One-time import from today's Python database: `ctc migrate --from-python` (per-feature rows below). `decisions` and `events` are exported to `~/.claudethecaller/archive/*.jsonl.gz` and dropped.

### 1.5 Auth and tenancy

- **Local mode:** no auth; unix socket + `127.0.0.1` only; `userId = local`.
- **Shared mode:** `Authorization: Bearer ctc_…` → SHA-256 → Redis `key:{hash}` 300 s, with a 60 s not-found sentinel.
- **Isolation:** every repository function takes `ctx: {userId, projectId?}` first. `userId` comes from the verified key, never from a body. Test `tenancy`: user B's ctx reads zero of user A's rows on every repository function.
- **Rate limit:** 600 requests/min per key (Redis fixed window). Over the limit, hooks get the empty reply and `/api` gets `429` with `retry-after`. If Redis is down, the limit is skipped.
- **Workflow step token:** see F4 §5.6.

### 1.6 API rules

- One Zod schema per route; lists take `limit ≤ 500` with keyset paging on `(created_at, id)`.
- Codes: `200`; `201` create; `202 {job_id}` job submit; `204` empty hook reply.
- Error body `{ "error": { "code", "message", ...extra } }`:

| Code | HTTP | When |
|---|---|---|
| `invalid` | 422 | Zod failed (with the field path) |
| `unauthorized` | 401 | no or revoked key (shared mode) |
| `not_found` | 404 | missing id, or another user's id |
| `conflict` | 409 | version or label race, illegal state transition |
| `stale_attempt` | 409 | step report from an old attempt |
| `idempotency_mismatch` | 409 | same `Idempotency-Key`, different payload |
| `ambiguous` | 409 | F1 name resolves to several nodes (up to 10 candidates in `candidates`) |
| `rate_limited` | 429 | over 600/min |
| `model_unavailable` | 503 | TEI down on `/v1/suggest` |
| `store_timeout` | 504 | Postgres statement timeout (5 s on `/api`) |
| `internal` | 500 | anything else; only the class name is returned |

- **Hooks never error:** any failure gives the empty reply within budget.
- **Idempotency:** `Idempotency-Key` is accepted on every mutating F4 route; same key + same payload hash replays the stored response.
- **Stable paths:** `/v1/hook/*` and MCP tool names are frozen; `/api` is internal to the dashboard.

### 1.7 Caching

Cache-aside: L1 in-process LRU (256 entries) → L2 Redis (20 ms timeout; marked down for 10 s after a miss of that budget) → source.

| Key | TTL | Feature |
|---|---|---|
| `emb:{sha1(text)}` | 7 d | all (TEI embeddings) |
| `sug:{user}:{project}:{sha1(prompt)}:{graph_epoch}` | 1 h | F1 prompt line |
| `proj:{user}:{cwd}` | 24 h | all |
| `ovr:{user}:{project}` | 5 min | F2 overrides |
| `ctx:{user}:{project}:{mem_epoch}` | 10 min | F3 SessionStart block |
| `key:{hash}` | 5 min (sentinel 60 s) | shared-mode auth |
| `rl:{user}:{minute}` | 60 s | rate limit |

Invalidation: `graph_epoch` and `mem_epoch` are per-project tokens in Redis. Every graph rebuild or memory write rotates them, so old keys die without a scan. `ctc:inval` pub/sub makes each web process reload its RAM graph and skill vectors after `graph.rebuild` or `library.changed`.

### 1.8 Queues

| Queue | Jobs | Concurrency | Attempts | Timeout |
|---|---|---|---|---|
| `graph` | `rebuild`, `extract` | 1 | 3, exponential from 5 s | 300 s rebuild; none for extract |
| `library` | `scan`, `changed` | 1 | 3, exponential from 5 s | 300 s |
| `llm` | `enrich`, `extract`, `summarize` | 1 | 2 (retry once, then `jobs.error`) | 120 s |
| `memory` | `import`, `distill` | 1 | 3, exponential from 5 s | none |
| `runner` | `step` | 1 run per login; fan-out children up to 3 | none (F4 retries are explicit attempts) | per node `timeout_s` |
| `cleanup` | `worktree`, `blobs`, `receipts` | 1 | 3 | 600 s |
| `dlq-retry` | repeatable every 10 min | 1 | re-runs each failed job up to 5 times | — |

All payloads are Zod schemas in `packages/shared/queues`. A job that fails every attempt becomes `jobs.status = dead`. BullMQ stalled-job detection re-queues jobs whose worker died, except runner steps (F4 §5.8). **Redis down:** job submits still insert the `jobs` row, the worker polls `jobs` every 5 s until Redis is back, and spool files wait.

### 1.9 System failure modes

| Failure | Detected by | Behavior |
|---|---|---|
| web down | curl fails | Claude Code shows nothing (fail open); spool files wait up to 7 days |
| worker down | jobs stay queued | hooks unaffected; Jobs page shows the age of the oldest queued job |
| Postgres down | pool error | prompt and pre hooks answer from RAM; start hook empty; `/api` `500`; jobs retry |
| Redis down | 20 ms timeout | cache and rate limit skipped; Postgres job polling; no `ctc:inval` (RAM reloads on the next 60 s poll of `graph_epoch` in Postgres) |
| TEI down | HTTP error / budget | F1 uses lexical seeds only; F3 recall uses full-text only; `/v1/suggest` `503` |
| llama-server down | job error | `llm` jobs retried once then `jobs.error`; nothing else affected |
| bad config key | Zod at startup | process exits with the YAML path of the bad key |

### 1.10 Budgets and privacy

- **Memory:** web RSS ≤ 600 MB (graph ≤ 100k nodes × 1,024 floats ≈ 400 MB worst case; this repo ≈ 12 MB); worker RSS ≤ 1 GB; Redis `maxmemory 256mb`.
- **Sizes:** hook body ≤ 1 MB; spool file ≤ 1 MB (bigger goes to `corrupt/`); prompt text ≤ 20,000 chars (truncated, not rejected).
- **Egress:** binds the socket and loopback only. Nothing leaves the machine except `claude -p` / `codex` runs and F1 doc extraction (`claude -p --model haiku`).
- **Sanitize:** all graph and memory text passes `sanitize` (strip control chars, cap labels at 256 chars, remove `<private>`, `<system-reminder>`, `<persisted-output>` and ctc's own injected lines) before it reaches a model or a context block.

### 1.11 Configuration

`config/*.yaml`, parsed by Zod at startup. Existing keys (e.g. [`config/retrieval.yaml`](../../config/retrieval.yaml)) keep their names; new keys are listed in each feature's config table.

---

## 2. F1 Context graph

### 2.1 Purpose

One graph per project that joins the code (files, symbols, calls) with the plan (specs, requirements, tasks, decisions) and the user's capabilities (skills, agents, commands, workflows). Claude gets a short pointer on every prompt and before file tools. Agents query it through MCP instead of grepping.

**User stories**
1. I type "fix the spool drain retry" → ctc adds `ctc: T4.1 spool drain → apps/web/src/spool:drain · skill: tdd · decision: D3`.
2. Claude opens a file → the note says which tasks implement it and which decision constrains it.
3. An agent asks `graph_affected("parseFrontmatter")` → it gets the callers, tests and tasks within depth 2.
4. I edit a file → its graph rows refresh within seconds, and unchanged callers keep their edges.

### 2.2 Graph model

**Node ids** (stable across rebuilds):

| Kind | Id | Example |
|---|---|---|
| code | `code:` + graphify `make_id(path_sans_ext, entity)` (casefold, NFKC, non-word runs → `_`) | `code:src_ctc_decision_bundle_suggestion_line` |
| doc | `doc:` + make_id(path, heading slug) | `doc:specs_007_ctc_spec_2_2_graph_model` |
| context | `ctx:<file>:<id>` | `ctx:specs/007-ctc/spec:T2.1` |
| capability | `skill:<name>`, `agent:<name>`, `command:<name>`, `workflow:<name>`, `workflow:<name>:<node_id>` | `skill:tdd` |

**Node types:** code `file`, `module`, `class`, `function`, `method`, `interface`, `type`, `package` (external); doc `page`, `heading`; context `spec`, `requirement`, `task`, `decision`; capability `skill`, `agent`, `command`, `workflow`, `workflow_step`.

**Relations:**

| Group | Relation | From → to |
|---|---|---|
| code | `contains` | file → symbol, class → method |
| code | `imports`, `imports_from` | file → file / package |
| code | `calls` | function → function |
| code | `inherits`, `implements` | class → class / interface |
| code | `references` | any → any (name use) |
| code | `rationale_for` | comment block → symbol |
| context | `part_of` | task → spec, requirement → spec |
| context | `implements` | task → code |
| context | `decides` | decision → any |
| context | `mentions` | doc → any |
| capability | `uses` | skill / command → skill, command, agent |
| capability | `invokes` | workflow_step → agent, skill, command |
| capability | `serves` | skill → task (learned from F2 enrichment) |

**Confidence** per edge, with its weight in ranking: `CONFIRMED` 1.0 (user reviewed), `EXTRACTED` 1.0 (parser, or a call proven by an import edge), `INFERRED` 0.6 (by meaning or an unproven call; `score` holds the similarity), `AMBIGUOUS` 0.3, `DROPPED` 0 (kept only for review).

**Origin** per row (scopes replacement): `ast`, `parser`, `claude`, `commit`, `review`, `session`. `review` and `session` rows survive rebuilds.

### 2.3 Tables

| Table | Columns | Indexes |
|---|---|---|
| `graph_nodes` | id, user_id, project_id, kind, type, label, source_file, source_location, origin, content_hash, embedding vector(1024), meta jsonb | `(user_id, project_id, type)`; GIN `to_tsvector('simple', label)`; HNSW `embedding vector_cosine_ops` |
| `graph_edges` | src, dst, relation, confidence, score, origin, source_location | `(src, relation)`, `(dst, relation)` |
| `graph_sources` | project_id, file, content_hash, extractor_version, built_at_commit | PK `(project_id, file)` |

Migration: today's `graph_*` rows carry over; ids that point at code are rewritten to the graphify-style `code:` ids.

### 2.4 Build

1. **Walk:** honour `.gitignore` and `.ctcignore`; skip secret files (`.env*`, `*.pem`, `id_*`, `credentials*`); skip binaries and files > 1 MB.
2. **Extract** (queue `graph`, job `rebuild`): web-tree-sitter per code file (ts, tsx, js, python, bash, sql, json). Each file yields nodes (file, symbols) and edges (`contains`, `imports`, raw call sites). Markdown yields page + heading nodes and `mentions`.
3. **Parse context:** ctc parsers read task ids (`T2.1`), requirement ids, decision ids (`D3`), skill names and workflow node ids from specs, `.scratch/*`, CLAUDE.md decisions and `.claude/**`. Doc extraction (`claude -p --model haiku`, job `extract`) adds `implements` / `decides` edges that the parsers cannot see; these are marked `INFERRED`.
4. **Resolve calls:** a call becomes `EXTRACTED` only when an import edge proves the target. With several candidates it is `AMBIGUOUS`; otherwise it is `INFERRED` with a fixed score (0.95 same file, 0.85 same package, 0.6 name only).
5. **Link capabilities:** after F2 `library.changed`, upsert the capability node and its `uses` / `invokes` edges.
6. **Embed:** each node's text (label + source excerpt ≤ 2,000 chars) via TEI, batch 32, only when `content_hash` changed.
7. **Write:** one transaction per `(origin, source_file)`: delete the old rows, insert the new ones, update `graph_sources`. Then rotate `graph_epoch` and publish `ctc:inval`.

**Incremental rebuild.** Triggers: a PostToolUse Edit/Write/MultiEdit spool event (debounced 3 s per project), the git post-commit hook, and `ctc graph build`.
- Changed files are found by `sha256(content + relpath)` against `graph_sources`; markdown hashes the body only.
- Changed files are re-extracted with the old graph's nodes as resolution context, so unchanged callers still bind.
- An `extractor_version` change rebuilds every file.

**Shrink guard.** If a rebuild would drop more than 20% of one source file's nodes, it is refused: `jobs.error = shrink_guard`, the old rows are kept, and the Jobs page shows a "force" action.

### 2.5 Suggest per prompt (hot path)

`POST /v1/hook/prompt` must do all of this before replying, within **140 ms**:

1. Zod-parse the hook JSON; resolve the project from `cwd` (`proj:` cache).
2. Check `sug:` for the same prompt at this `graph_epoch`; on a hit, reply.
3. Embed the prompt (TEI, `emb:` cache).
4. **Seeds**, all three channels in parallel:
   - **Lexical:** label tiers (exact 1000, prefix 100, substring 1) × IDF × coverage²; at most 3 seeds.
   - **Embedding:** top 10 context and code nodes by cosine ≥ `graph_push.floor` (0.3).
   - **Skill:** F2 skill vectors, dense top 50 + keyword 50 → RRF k = 60 → rerank top 20 → top 5 (today's tuned [`config/retrieval.yaml`](../../config/retrieval.yaml) values).
5. **Walk:** BFS depth 2 from the seeds over the RAM graph, skipping hubs with degree ≥ max(50, p99 degree).
6. **Rank:** each reached node scores seed score × 0.5^hop × confidence weight. Pick at most one each of task, file:symbol, skill and decision.
7. **Render:** `ctc: <task id> <task title> → <path>:<symbol> · skill: <name> · decision: <id>`, cut at `graph_push.max_chars` (400). Nothing above the floor → empty reply.

**Over budget:** reply empty now, finish in the background and store the line in `sug:` for the next identical prompt. **Line content (D5):** memories are not in the line; F3 injects them at session start.

### 2.6 Note before a tool (hot path)

`POST /v1/hook/pre`, RAM only, **40 ms**:
- **Read/Edit/Write on a file:** a note listing the tasks that `implements` it, decisions that `decides` it and the top 3 callers, at most 400 chars.
- **Bash grep/rg/find, Grep, Glob:** token-parse the search terms; add at most 5 matching nodes as `path:symbol` hints.
- **Caps:** 5 hints per session; quiet for 30 minutes after any `graph_*` MCP call in that session; nothing for paths outside the project.

### 2.7 Query tools

| MCP tool / `GET /api/graph/*` | Input (Zod) | Output |
|---|---|---|
| `graph_search` | `{query, types?[], limit ≤ 50 (default 10)}` | seed-and-walk text ≤ 2,000 tokens (seeds first, then by hop), plus a truncation footer |
| `graph_explain` | `{name}` | node, its edges grouped by relation, source excerpt ≤ 40 lines |
| `graph_path` | `{from, to, max_hops ≤ 8}` | directed shortest path, one hop per line |
| `graph_affected` | `{name, depth ≤ 3 (default 2)}` | reverse BFS over `calls`, `imports*`, `references`, `inherits`, `implements`, `contains`, `uses`, `invokes`, grouped by type |
| `graph_neighbors` | `{name, relation?, direction?}` | adjacent nodes |

**Name resolution:** exact id → exact label → `path::symbol` → case-insensitive label → prefix. Several matches → `ambiguous` with up to 10 candidates and their `path::symbol` hints; none → `not_found` with the 5 nearest labels.

### 2.8 API

`GET /api/graph/search|explain|path|affected|neighbors` (same schemas as MCP); `GET /api/graph/stats` (node and edge counts by type, last build, guard trips); `POST /api/graph/build {project_id, force?}` → `202 {job_id}`; `PATCH /api/graph/edges {src, dst, relation, confidence: CONFIRMED | DROPPED}` (review; origin `review`).

### 2.9 Config

| Key | Default |
|---|---|
| `graph.languages` | `[ts, tsx, js, python, bash, sql, json, markdown]` |
| `graph.query` | `{seeds: 3, depth: 2, hub_min: 50, budget_tokens: 2000}` |
| `graph.shrink_guard` | 0.2 |
| `graph.debounce_s` | 3 |
| `graph.hint` | `{per_session: 5, quiet_s: 1800, max_nodes: 5}` |
| `graph_push.floor`, `graph_push.max_chars` | 0.3, 400 (existing) |

### 2.10 Failure modes

| Failure | Behavior |
|---|---|
| grammar throws on a file | that file keeps its old rows; `jobs.error` names the file; other files proceed |
| parse wipes a file | shrink guard refuses the write |
| TEI down | lexical and graph-only seeds; nodes embed on the next rebuild |
| doc extract (`claude -p`) fails | `INFERRED` doc edges missing; parser edges still there |
| RAM graph stale (missed `ctc:inval`) | 60 s poll of `graph_epoch` reloads it |
| prompt injection in labels | `sanitize` before any render |

### 2.11 Tests

| Test | Gate |
|---|---|
| `graph.ids` | 20 fixture files: id suffixes equal graphify 0.9.93's |
| `graph.resolve` | a call becomes EXTRACTED only with an import edge; ambiguous names become AMBIGUOUS |
| `graph.incremental` | edit 1 file → only its rows change; callers keep edges; guard trips above 20% loss |
| `graph.query` | 30 fixed questions on this repo: top seed and `affected` set match graphify's ≥ 27 / 30 |
| `suggest.latency` | [latency.md](../../.claude/metric/eval/latency.md) on `/v1/suggest`: cold p95 ≤ 150 ms, L1 hit p95 ≤ 10 ms |
| `suggest.context` | [contextbench.md](../../.claude/metric/eval/contextbench.md), [mulocbench.md](../../.claude/metric/eval/mulocbench.md) file recall of the line ≥ today's m6 numbers |
| `failopen` | TEI, Redis or Postgres down → prompt and pre hooks still reply within budget |

---

## 3. F2 Skill library

### 3.1 Purpose

Skills, agents, commands and workflows live as files under `~/.claude` and plugin roots. ctc turns each name into a versioned record. Edits are never lost, a label decides which version is served, multi-file skills are read consistently, and a project can pin what it uses.

**User stories**
1. I edit a skill → version n+1 appears with `latest`; `production` stays on the version I trust until I move it.
2. A project pins `tdd@3` → its suggestions and MCP reads use version 3.
3. An agent loads a skill and then one of its reference files → both come from the same version, even if a new version lands in between.
4. I break a skill → Restore writes version 4's files back.

### 3.2 Model

- **Capability** = one name per user and namespace (`kind`: skill / agent / command / workflow).
- **Version** = an immutable snapshot of the capability's files. Numbers start at 1 and only grow.
- **Labels** = mutable pointers on versions. `latest` is system-managed (always the newest). `production` is the default read. Other labels match `^[a-z0-9_\-.]{1,36}$`. A label sits on at most one version per capability.
- **Served version** = project override (version, or label) → `production` → `latest`. Only the served version is embedded and becomes the graph node.

### 3.3 Tables

| Table | Columns | Indexes / rules |
|---|---|---|
| `capabilities` | id, user_id, namespace, kind, name, root_path, served_version | unique (user_id, namespace, kind, name) |
| `capability_versions` | id, cap_id, version, body_hash, description, frontmatter jsonb, labels text[], commit_message, created_at | unique (cap_id, version); GIN (labels) |
| `cap_files` | version_id, path, blob_hash | PK (version_id, path) |
| `cap_blobs` | user_id, hash (sha256 hex), content, size | unique (user_id, hash) |
| `cap_vectors` | cap_id, text_hash, embedding | served version only |
| `overrides` | user_id, project_id, cap_id, action (pin / block), label, version | one row per (project, cap) |
| `dedup_review` | pair, similarity, status (open / merged / kept_apart) | unchanged |

**Limits** (Zod): ≤ 200 files and ≤ 1 MB per version; name `^[a-z0-9]+(-[a-z0-9]+)*$` ≤ 64 chars; description ≤ 1,024 chars. YAML frontmatter is parsed with `maxAliasCount: 0`.

Migration: each existing capability becomes version 1 with `labels = [latest, production]`.

### 3.4 Flows

- **Scan** (`library.scan`; triggers: worker start, file watch on `~/.claude` and plugin roots, `POST /api/index`):
  1. For each capability, hash every file; compare with the latest version's manifest.
  2. If it changed, open one transaction under `pg_advisory_xact_lock(hashtext('cap:' || user || ':' || name))`.
  3. Set version = max + 1, move `latest`, insert blobs (`ON CONFLICT DO NOTHING`), the version row and `cap_files`.
  4. Enqueue `library.changed`. A file that disappeared marks the capability `removed` (versions kept).
- **Changed** (`library.changed`):
  1. Embed the served version (SKILLRET text = `name | description | body`, body cut at 8,000 chars).
  2. `llm.enrich` (summary and when-to-use).
  3. Check dedup against neighbours above 0.92 cosine → a `dedup_review` row.
  4. Upsert the graph node and its edges (F1 step 5), then publish `ctc:inval`.
- **Move a label** (`PATCH /api/capabilities/:id/versions/:v/labels {labels[]}`): one transaction with `SELECT … FOR UPDATE` on the target version, removing the labels from other versions. `latest` is refused in the body. The served version is recomputed and `ctc:inval` published.
- **Pin** (`PUT /api/projects/:pid/capabilities/:id/override {action, label? | version?}`): the version must exist; rotates `ovr:`.
- **Load** (MCP):
  - `get_capability {name, label?, version?}` returns `{version_id, version, labels, frontmatter, body, files: [{path, size}]}`.
  - `load_capability_resource {version_id, path}` returns that file's content.
  - Reads are pinned by `version_id`, so a multi-call read never mixes versions.
- **Restore** (`POST /api/capabilities/:id/restore {version}`): writes that version's files back to `root_path` (temp file + rename per file). The next scan then creates version n+1 with commit message `restore v<version>`.
- **Blob cleanup** (weekly `cleanup.blobs`): deletes `cap_blobs` that no `cap_files` row references.

### 3.5 API

`GET /api/capabilities` (filters kind, label, q; keyset); `GET /api/capabilities/:id`; `GET /api/capabilities/:id/versions`; `GET /api/capabilities/:id/versions/:v` (manifest + body); `GET /api/capabilities/:id/versions/:v/diff?against=:w`; `PATCH …/labels`; `POST …/restore`; `PUT …/override`; `POST /api/capabilities/:id/enrich`; `GET|PATCH /api/dedup*`; `POST /api/index` → `202`.

### 3.6 Config

| Key | Default |
|---|---|
| `library.roots` | `[~/.claude, plugin roots from ~/.claude/plugins]` |
| `library.default_label` | `production`, falling back to `latest` |
| `library.dedup_cosine` | 0.92 |
| `library.max_files`, `library.max_bytes` | 200, 1 MB |
| `embed.*`, `ranking.*`, `k`, `depth`, `rerank_top`, `rrf_k` | existing [`config/retrieval.yaml`](../../config/retrieval.yaml) values |

### 3.7 Failure modes

| Failure | Behavior |
|---|---|
| two scans race on one name | the advisory lock serializes them; the second sees no change |
| a label race | `SELECT … FOR UPDATE`; the loser gets `409 conflict` |
| over the limits or bad YAML | that capability is skipped with `jobs.error`; the previous version stays served |
| restore target unwritable | `500 internal`, no partial write (rename per file) |
| TEI down at `changed` | job retried; the old vector keeps serving |

### 3.8 Tests

| Test | Gate |
|---|---|
| `library.version` | file hash change → version n+1 with `latest`; label moves are exclusive; parallel scans make no duplicate version |
| `library.mcp` | `get_capability` + `load_capability_resource` stay on the returned version after a new version lands |
| `library.override` | pin by label and by version both change the served version for that project only |
| `suggest.skills` | [skillret.md](../../.claude/metric/eval/skillret.md) on the skill seed channel: NDCG@10 ≥ 0.80 test (today 0.811) |

---

## 4. F3 Memory

### 4.1 Purpose

ctc learns durable facts (preferences, conventions, project facts, skill outcomes) and a summary of each session. It brings the relevant ones back at the next session start within a fixed size, and lets agents search them in three cheap steps.

**User stories**
1. I tell Claude "always use pnpm" → the next session starts with that convention in context.
2. I start work on Monday → the context block shows Friday's session summary: what was done and the next steps.
3. An agent calls `mem_search("spool retry")` → it gets an id index, opens a timeline around the best hit, then fetches 2 full rows.
4. The web process is down during a session → nothing is lost; the spool is processed when it returns.

### 4.2 Model

- **Memory** = one sentence. `scope` is global or project; `kind` is preference / convention / fact / skill_outcome.
- **Write bands** against the nearest live memory (same user, scope, project):

| Similarity | Band | Action |
|---|---|---|
| ≥ 0.95 | NOOP | reinforce: append today to `reinforcement_dates` once |
| 0.85–0.95, same meaning | UPDATE | rewrite the text, keep the id |
| 0.85–0.95, contradicts | SUPERSEDE | new row; the old row gets `superseded_by` |
| < 0.85 | ADD | new row |

- **Session summary** = 6 fields: request, investigated, learned, completed, next_steps, notes.
- **Recall score** = RRF(full-text, vector) × 0.5^(age / 30 d) × (1 + ln(1 + distinct reinforcement days)) × (2 if pinned).

### 4.3 Tables

| Table | Columns | Indexes / rules |
|---|---|---|
| `memories` | id, user_id, scope, project_id, kind, text, hash, source jsonb, superseded_by, confidence, pinned, reinforcement_dates date[], created_at, updated_at, last_used_at, use_count, deleted_at, embedding vector(1024), tsv tsvector | unique (user_id, scope, project_id, hash); GIN (tsv); HNSW (embedding); live index where deleted_at is null |
| `session_summaries` | session_id, project_id, request, investigated, learned, completed, next_steps, notes, content_hash, created_at | unique (content_hash) |

Migration: today's `memories` rows carry over with `hash` recomputed and `tsv` filled; `supersedes` becomes `superseded_by` on the old row.

### 4.4 Flows

- **Capture:** the PostToolUse, Stop and SessionEnd hooks run `hooks/spool`.
  - It reads stdin and strips `<private>…</private>` and harness tags.
  - It writes `~/.claudethecaller/spool/<session>-<event>-<epoch_ns>-<rand>.json` as `.tmp` then renames it, with the body `{v: 1, event, received_at, payload}`.
  - It nudges `POST /v1/spool/nudge` in the background with a 250 ms timeout, and always exits 0.
- **Drain** (web; on boot, on file watch and in a 30 s sweep):
  1. Zod-parse each file; a bad file goes to `spool/corrupt/`.
  2. Route by event:

     | Event | Becomes |
     |---|---|
     | PostToolUse Edit / Write / MultiEdit | F1 `graph.rebuild` |
     | Stop | `llm.extract` |
     | SessionEnd | `llm.summarize` + a `sessions` upsert |
     | any other | dropped |

  3. Delete the file after the BullMQ add. Files the web cannot deliver are kept 7 days.
- **Learn facts** (`llm.extract`):
  1. Read the user's own words from the transcript since the last extract.
  2. Call llama-server with a JSON grammar, giving a list of `{kind, scope, text, confidence}`. An invalid reply is retried once with a fresh prompt, then dropped (`jobs.error = bad_reply`).
  3. Apply the bands, then insert with `ON CONFLICT … DO UPDATE` reinforcement.
  4. Rotate `mem_epoch`.
- **Summarize** (`llm.summarize`): the whole session → the 6 fields; retry once then drop; insert `ON CONFLICT (content_hash) DO NOTHING`.
- **Import** (`memory.import`): watch `~/.claude/projects/*/memory/*.md` and map the frontmatter `type` to a kind (user → preference, feedback → convention, project → fact, reference → fact). The same bands apply. `source` holds the file path; the file is never written.
- **Distill** (`memory.distill`): old transcripts from `history_files` → `llm.extract` jobs, oldest first, 1 at a time.
- **Recall at session start** (`POST /v1/hook/start`, **1,200 ms**):
  1. Two Postgres reads: the last 3 session summaries for the project, and RRF recall (full-text + vector, K = 60, 100 per leg, query = project name + last summary's next_steps) → top 30.
  2. Render, measure, then drop in fixed order until ≤ 10,000 chars: notes → investigated → older summaries → halve the memories → last summary.
  3. Cache the block in `ctx:` at this `mem_epoch`.
- **Search (MCP):**

  | Tool | Input | Output |
  |---|---|---|
  | `mem_search` | `{query, scope?, kind?, since?, limit ≤ 50}` | index rows `id · date · kind · first 80 chars`, about 50–100 tokens each |
  | `mem_timeline` | `{anchor_id, before ≤ 10 (3), after ≤ 10 (3)}` | memories and summaries around that time |
  | `mem_get` | `{ids[] ≤ 20}` | full rows |
  | `save_memory` | `{text, kind, scope}` | id; same bands as extract |

### 4.5 API

`GET /api/memories` (filters scope, kind, q; keyset); `GET|PATCH|DELETE /api/memories/:id` (PATCH text / pinned / kind; DELETE soft-deletes); `POST /api/memories/import` → `202`; `GET /api/sessions/:sid/summary`; `GET /api/history`, `POST /api/history/import` → `202`.

### 4.6 Config

| Key | Default |
|---|---|
| `spool.dir`, `spool.keep_days` | `~/.claudethecaller/spool`, 7 |
| `memory.context_chars` | 10000 |
| `memory.rrf` | `{k: 60, per_leg: 100}` |
| `memory.bands` | `{noop: 0.95, update: 0.85}` |
| `memory.half_life_days` | 30 |
| `memory.start` | `{summaries: 3, memories: 30}` |

### 4.7 Failure modes

| Failure | Behavior |
|---|---|
| web down | spool files wait 7 days; processed once on return |
| corrupt spool file | moved to `corrupt/`; never retried |
| llama reply invalid | retry once, then drop with `jobs.error` |
| same session processed twice | content hash makes it a no-op; reinforcement adds today at most once |
| Postgres slow at start | over 1,200 ms → empty reply; the cached block is used on the next start |
| secrets in transcripts | `<private>` stripped at capture; `sanitize` before the model |

### 4.8 Tests

| Test | Gate |
|---|---|
| `memory.spool` | web down → files → web up → each event processed once; a corrupt file lands in `corrupt/` |
| `memory.idempotent` | same session extracted twice → no new rows; reinforcement adds today once |
| `memory.bands` | fixture pairs land in NOOP / UPDATE / SUPERSEDE / ADD as labelled |
| `memory.context` | 500 memories → block ≤ 10,000 chars, drop order as specified |
| `memory.recall` | new `.claude/metric/eval/memory` set: RRF Recall@5 ≥ vector-only Recall@5 |

---

## 5. F4 Workflows

### 5.1 Purpose

A workflow is a saved graph of steps (agents, shell commands, conditions, approvals, fan-outs) that ctc runs headless. Each agent step works in its own git worktree with the repo's setup applied. Every attempt is recorded, so a crash, a quota stop or a failure can be resumed or retried without guessing.

**User stories**
1. I start "implement + review" on a task → step 1 runs `claude -p` in a new worktree; step 2 reviews its diff; I approve with "merge" or "rework".
2. The worker crashes mid-step → on restart, ctc reattaches to the live agent, or marks the step `start_unknown` and asks me.
3. A fan-out step runs 3 agents in parallel worktrees → the join merges their branches or lists the conflicts.
4. A step fails twice → I retry it (attempt 3); a third failure stops the step for good.

### 5.2 Workflow format

Workflows are F2 capabilities (`kind = workflow`), so a run pins one version. The file is YAML or JSON: `{name, description, inputs?, nodes: [...], edges: [{from, to, handle?}]}`.

| Node type | Fields | Behavior |
|---|---|---|
| `trigger` | `inputs` schema | start; one per workflow |
| `agent` | `agent: claude \| codex`, `prompt` (templated `{{input.x}}`, `{{node.out}}`), `worktree: new \| parent \| none`, `permission: acceptEdits \| dontAsk \| plan`, `model?`, `timeout_s` (default 1,800) | runs one attempt (§5.5) |
| `shell` | `run`, `cwd: worktree \| repo`, `timeout_s` (default 600) | process group; exit code is the result |
| `if` | `op: eq \| ne \| contains \| truthy`, `left`, `right` | edges `handle: true / false` |
| `approval` | `question`, `options: [{id, label}]` (default approve / reject) | step `waiting` until a user picks; the choice is the output and `{{resolution}}` |
| `merge` | — | waits for all incoming edges |
| `fanout` | `over: list template \| count`, `child: <agent node>`, `max_parallel ≤ 3` | one child step per item, each with its own worktree; depth 1 |
| `join` | `strategy: merge \| collect` | waits for the fanout's children; `merge` runs `git merge` of the child branches |

Walker rules (kept from [runner/graph.py](../../src/ctc/runner/graph.py)):
- Readonly ready nodes run as one batch, then one writer.
- Loops are back-edges capped by `max_visits` (default 3).
- `bypassPermissions` is never allowed.
- `git push` and `gh pr create|merge` in a shell or prompt need an approval node first.

### 5.3 Tables

| Table | Columns | Rules |
|---|---|---|
| `wf_runs` | id, user_id, owner (claude auth email), workflow_cap_id, workflow_version, status (queued / running / waiting / done / failed / cancelled / quota), state jsonb (walker), trigger, inputs, repo, base_branch, created_at, started_at, ended_at | one `running` run per owner (partial unique index) |
| `wf_steps` | id, run_id, node_id, visit, attempt, retry_of_step_id, failure_count, parent_step_id (fan-out child), status (§5.4), stage (worktree / setup / spawn / stream / report), liveness (alive / start_unknown), pid, pid_started_at, token_hash, worktree, branch, options jsonb, resolution, prompt_outcome (delivered / not_delivered / unconfirmed), output, usage, cost_usd, error, log_path, started_at, ended_at | unique (run_id, node_id, visit, attempt) |
| `wf_schedules` | unchanged (cron, workflow, inputs, enabled) | |

Migration: old steps become attempt 1 with stage `report`.

### 5.4 Step states

Every status write goes through `transition(step, from, to)`. It checks the allowed table below and runs `UPDATE … WHERE status = from`; 0 rows updated → `409 conflict`. Graph: [state-step.svg](state-step.svg).

| From | To | Cause |
|---|---|---|
| queued | running | runner claims the attempt |
| queued | skipped | branch not taken |
| running | done | exit 0 + report, or shell exit 0 |
| running | waiting | approval node, or setup policy `ask` |
| running | failed | exit ≠ 0, report outcome failed, or the worktree/setup stage failed |
| running | timeout | `timeout_s` passed; process group killed |
| running | start_unknown | worker restart: no live pid and no exit record |
| running | quota | agent reported a usage limit |
| quota | queued | quota reset time reached (same attempt) |
| waiting | done | user picked an option |
| any non-final | cancelled | user cancelled the run |
| start_unknown | failed | user marks it failed |
| failed / timeout / start_unknown | circuit_broken | third failure; retry refused |

**Retry** (`POST /api/runs/:rid/steps/:sid/retry`) inserts attempt n+1 (`retry_of_step_id`, `failure_count + 1`) as `queued`, but only if `failure_count < 3`. Final states: done, skipped, cancelled, circuit_broken (and failed or timeout once no retry is taken). The run status follows its steps.

### 5.5 Agent step attempt (cold path)

Job id `run:<rid>:node:<nid>:visit:<v>:attempt:<a>`, so a double add is one job. Each stage is written to `wf_steps.stage` **before** its side effect:

1. **worktree:**
   - Command: `git worktree add --no-track -b ctc/<workflow>-<run>-<node>[-<child>] <repo>/.ctc/wt/<run>/<step> <base>`, timeout 180 s.
   - Then set `branch.<b>.base` in the git config.
   - Git commands are serialized per repo.
2. **setup:** if the repo has **ctc.yaml** with `setup:`, run it in the worktree.
   - Limits: 120 s, process-group kill, output capped at 10 MB.
   - Env: `CTC_ROOT_PATH`, `CTC_WORKTREE_PATH`.
   - Policy `run` / `ask` / `skip` per repo; `ask` makes a gate first.
3. **spawn:** start the agent through the registry with a preamble (step goal, gate resolution if any, how to report). Store `pid` and `pid_started_at`, and set `prompt_outcome = delivered` once the first stream event arrives.

   | Agent | Command |
   |---|---|
   | `claude` | `claude -p --output-format stream-json --permission-mode <p> [--model m]` |
   | `codex` | `codex exec --json` |

4. **stream:** tail the stream into the log, update `usage` and `cost_usd`, and detect usage-limit messages (→ quota).
5. **report:** the step ends at whichever comes first:
   - the agent's `POST /api/runs/:rid/steps/:sid/report {outcome: done | failed, summary}`;
   - process exit (exit 0 without a report counts as done with the last message as summary).

   Then transition, store `output` and the diff stat, and let the walker complete the node.

### 5.6 Step report auth

Each attempt gets a random 32-byte `CTC_STEP_TOKEN` in its env; only `sha256(token)` is stored. The report route checks the token and that the step is the **current** attempt. A late report from an old attempt gets `409 stale_attempt` and is ignored, and a duplicate report is a no-op.

### 5.7 Gates, fan-out, handoff

- **Gate:** `approval` steps show `question` and `options` on the Runs page. `POST /api/runs/:rid/approve {step_id, option_id}` + `Idempotency-Key` stores the `resolution` and moves the step to done. The walker passes `{{resolution}}` into the next agent prompt.
- **Fan-out:** a `fanout` step creates child steps (`parent_step_id`) as a BullMQ Flow, at most 3 running at once, each with its own worktree from the parent's branch. A `fanout` inside a child is refused (depth 1). The `join` waits for all children:
  - `merge` merges child branches in order; a conflict fails the join with the conflicting files listed, and the branches are kept.
  - `collect` passes the outputs on as a list.
- **Handoff:** `run_workflow` returns `{run_id, status, prompt_outcome}` so the calling agent knows whether the first step actually received its prompt.

### 5.8 Recovery and cleanup

- **Restart sweep (worker boot):** for each step in `running`:
  - Stage `spawn` or `stream` with a live `pid` matching `pid_started_at` → reattach and keep tailing.
  - Otherwise → `liveness = start_unknown`, run `waiting`; the Runs page offers retry or mark failed.
  - Stage `worktree` or `setup` → the attempt fails at that stage (safe to retry).
  - **Never act on absence:** a quiet agent is never assumed dead.
- **Cleanup** (`cleanup.worktree`, 7 days after the run ends): archive the logs (jsonl.gz), `git worktree remove`, **keep the branch**. `cleanup.receipts` prunes `idempotency_keys` older than 30 days.

### 5.9 API and MCP

| Route | Notes |
|---|---|
| `GET /api/workflows`, `GET /api/workflows/:id` | F2 versions apply |
| `POST /api/workflows/:id/runs {inputs, repo, base?}` | `202 {run_id}`; `Idempotency-Key` |
| `GET /api/runs`, `GET /api/runs/:rid` | run + steps (all attempts) |
| `GET /api/runs/:rid/steps/:sid/log` | streamed log |
| `POST /api/runs/:rid/approve`, `/cancel`, `/continue` | `Idempotency-Key`; `continue` re-queues a `quota` or `waiting` run |
| `POST /api/runs/:rid/steps/:sid/retry`, `/fail` | attempt n+1 / mark start_unknown failed |
| `POST /api/runs/:rid/steps/:sid/report` | step token only |
| `GET|POST|PATCH|DELETE /api/schedules*` | unchanged |
| MCP `run_workflow {name, inputs, repo?}` | `{run_id, status, prompt_outcome}` |
| MCP `workflow_status {run_id}` | steps with status, attempt, stage, resolution |

### 5.10 Config

| Key | Default |
|---|---|
| `runner.worktree` | `{add_timeout_s: 180, keep_days: 7, dir: .ctc/wt}` |
| `runner.setup` | `{timeout_s: 120, max_output_mb: 10, policy: run}` |
| `runner.max_failures` | 3 |
| `runner.fanout` | `{max_depth: 1, max_parallel: 3}` |
| `runner.agents` | `{claude: {...argv}, codex: {...argv}}` |
| `runner.max_visits` | 3 |

### 5.11 Failure modes

| Failure | Behavior |
|---|---|
| `git worktree add` hangs | 180 s → attempt fails at stage worktree; retry allowed |
| setup hangs or floods | 120 s / 10 MB → process group killed; fails at stage setup |
| agent hits a usage limit | step and run go to `quota`; re-queued at reset |
| worker crash mid-step | restart sweep: reattach or `start_unknown` |
| late or duplicate report | `409 stale_attempt` / no-op |
| 3 failed attempts | `circuit_broken`; run `failed` |
| join merge conflict | join fails with the file list; branches kept |
| lost HTTP reply on approve | same `Idempotency-Key` replays the stored response |

### 5.12 Tests

| Test | Gate |
|---|---|
| `runner.lifecycle` | every illegal `from → to` rejected; duplicate report no-op; stale report `409` |
| `runner.crash` | kill the worker mid-step → reattach (pid alive) or `start_unknown` (dead) |
| `runner.fanout` | 3 children in 3 worktrees, join merges; depth 2 refused |
| `runner.idempotent` | same key + payload replays; different payload → `409 idempotency_mismatch` |
| [runner.md](../../.claude/metric/eval/runner.md) | 3 sample workflows end to end, metrics as today |

---

## 6. Retrieval

| Stage | F1 graph | F2 skills (seed channel) | F3 memory |
|---|---|---|---|
| Ingestion | tree-sitter per code file; markdown pages and headings; context id parsers; capability files; content hash per file | `SKILL.md` + files, agents, commands, workflows; safe YAML; hash per file | user words for facts; whole session for summaries; Claude memory files |
| Chunking | one node per entity; text = label + excerpt ≤ 2,000 chars | one doc per served version: `name \| description \| body` (body ≤ 8,000 chars) | one memory = one sentence; one summary = 6 fields |
| Embedding / index | SKILLRET 0.6B, 1,024-d, cosine; RAM matrix + HNSW; GIN tsvector on labels | same model and RAM matrix; skillret instruction prefix | same model; HNSW + GIN tsv |
| Retrieval | lexical tiers × IDF (≤ 3) ∪ embedding top 10 ≥ 0.3 ∪ skill channel → BFS depth 2, hub cut-off → seed × 0.5^hop × confidence | dense 50 + keyword 50 → RRF k = 60 → rerank top 20 → k = 5 (`keyword_rrf_weight 0`, `rerank_weight 0`) | RRF tsv + vector K = 60, 100 per leg → × recency × reinforcement |
| Assembly | one line ≤ 400 chars; MCP text ≤ 2,000 tokens with a footer | skill name in the line; content via `get_capability` | ≤ 10,000 chars with a fixed drop order; MCP index rows |
| Evaluation | contextbench, mulocbench, `graph.query` | skillret NDCG@10, Recall@5 | new memory set, Recall@5 |

## 7. Verification gates

Done = all of the following green on the new stack:

| Area | Tests and metrics |
|---|---|
| System | `tenancy`, `failopen`, [ci.md](../../.claude/metric/eval/ci.md) (`pnpm -r lint && pnpm -r typecheck && pnpm -r test` + [check.sh](../../scripts/check.sh)) |
| F1 | `graph.ids`, `graph.resolve`, `graph.incremental`, `graph.query`, `suggest.latency`, `suggest.context` |
| F2 | `library.version`, `library.mcp`, `library.override`, `suggest.skills` |
| F3 | `memory.spool`, `memory.idempotent`, `memory.bands`, `memory.context`, `memory.recall` |
| F4 | `runner.lifecycle`, `runner.crash`, `runner.fanout`, `runner.idempotent`, [runner.md](../../.claude/metric/eval/runner.md) |
| Dashboard | [dashboard-e2e.md](../../.claude/metric/eval/dashboard-e2e.md) on the reworked pages (Library versions, Memories, Runs with attempts) |

## 8. Tasks

Phases run in order; `[P]` = can run in parallel within the phase. Each task ends with its named tests green.

| Phase | Task | Done when |
|---|---|---|
| 0 Safety net (Python still serves) | T0.1 record fixtures: `/v1/search` top-5 for 200 prompts, 30 graph answers, `/api` reply shapes | fixtures saved |
| | T0.2 latency + skillret baselines on the Python daemon | baseline saved |
| | T0.3 archive `decisions` + `events` | jsonl.gz written |
| 1 System | T1.1 pnpm workspace, TS strict, Vitest, ESLint SQL ban, Zod config | CI green on empty packages |
| | T1.2 migrations + `ctc migrate --from-python` | row counts match on a copy |
| | T1.3 `[P]` repositories with `ctx` | `tenancy` |
| | T1.4 `[P]` cache, epochs, `ctc:inval`, 7 queues, `dlq-retry`, systemd units | unit tests |
| 2 F1 graph | T2.1 ids + web-tree-sitter extract + markdown | `graph.ids` |
| | T2.2 resolve, incremental rebuild, shrink guard, `graph` queue | `graph.resolve`, `graph.incremental` |
| | T2.3 context parsers, doc extract, capability nodes | parser fixtures |
| | T2.4 query, explain, path, affected, neighbors; MCP + `/api/graph` | `graph.query` |
| 3 F2 library `[P]` with 4 | T3.1 scanner → versions, labels, manifest, blobs; `library` queue | `library.version` |
| | T3.2 MCP pair, versions/labels/restore/override API, blob cleanup | `library.mcp`, `library.override` |
| | T3.3 SKILLRET dense + rerank channel | `suggest.skills` |
| 4 F3 memory `[P]` with 3 | T4.1 spool script + drain + nudge | `memory.spool` |
| | T4.2 extract (bands), summarize, retry-once, content hash | `memory.idempotent`, `memory.bands` |
| | T4.3 recall + `/v1/hook/start` + MCP memory tools + import + distill | `memory.context`, `memory.recall` |
| 5 F1 hooks | T5.1 `/v1/hook/prompt` + `/v1/suggest` (three seed channels, walk, rank, render, `sug:` cache) | `suggest.latency`, `suggest.context` |
| | T5.2 `/v1/hook/pre` note + hint with caps | `failopen` |
| 6 F4 workflows | T6.1 transition table, attempts, stages, idempotency keys | `runner.lifecycle`, `runner.idempotent` |
| | T6.2 worktree recipe, setup hook, agent registry, stream, report token | `runner.crash` |
| | T6.3 gates with options, fanout + join, handoff, cleanup | `runner.fanout`, runner.md |
| 7 Switch over | T7.1 point [`.claude/settings.json`](../../.claude/settings.json) hooks at the new routes and spool script; stop the Python daemon | all §7 gates |
| | T7.2 delete the Python service code (keep [`evaluation`](../../evaluation/)); retire [adoption.md](../../.claude/metric/eval/adoption.md) | ci.md green |

## 9. Decisions

Defaults in bold are used everywhere above.

| # | Decision | Default | Alternative |
|---|---|---|---|
| D1 | analytics store | **no ClickHouse** | bring it back only if raw tool-use capture is wanted |
| D2 | SQL layer | **Kysely on `pg`** | Prisma 6 (codegen, own migration engine) |
| D3 | memory extraction | **local llama-server** | Haiku observer per tool use (paid call each time) |
| D4 | model output format | **llama.cpp JSON grammar** + retry once | claude-mem's XML parser |
| D5 | prompt line content | **task → file:symbol · skill · decision**, ≤ 400 chars | add one memory |
| D6 | workflow agents | **`claude` and `codex`** | more CLIs on demand |
| D7 | fan-out | **3 at once, depth 1** | — |
| D8 | worktree retention | **7 days, branch kept forever** | — |
| D9 | local supervisor | **`systemd --user`** | pm2, docker |
| D10 | skill library in 007 | **yes, as F2** (also versions workflows for F4) | defer, keep today's flat capabilities |

## 10. Open items

- `[UNVERIFIED HYPOTHESIS]` The prompt hook fits 140 ms with three seed channels + BFS in Node. Proof: T5.1 `suggest.latency`. Fallback: drop the lexical channel on cold misses.
- `[UNVERIFIED]` web-tree-sitter WASM grammars give the same node spans as graphify's native tree-sitter 0.25. Proof: `graph.ids` (T2.1).
- `[UNVERIFIED]` graphify 0.9.97 behaves like the 0.9.93 we read. Check before T2.1 (see [006 open items](../006-merged-core/spec.md#d3-open-items-and-unverified-points)).
- `[UNVERIFIED]` codex's `exec --json` stream carries usage and a final message in a form the runner can parse. Check before T6.2.
- The memory eval set (`.claude/metric/eval/memory`) does not exist yet; T4.3 creates it (50 queries over this project's memories, hand-labelled).
- Dashboard page changes (Library versions and labels, Memories with summaries, Runs with attempts and gates) need a frontend spec once 007 is approved.
- Project docs (CLAUDE.md, PLAN.md, older specs) were deleted on 2026-10-30. This spec supersedes their decisions (Python core, route/bundle, adoption KPI).
