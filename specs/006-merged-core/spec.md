# 006-merged-core: rebuild ctc's 4 core features on graphify, Langfuse, claude-mem and Orca

Status: **research record**. The main spec is [007-ctc](../007-ctc/spec.md); this document keeps where each design comes from. ctc pinned at `a244268`, branch `m9-project-manager`. Written 2026-10-30.

This one document is everything to read. It has four parts:

| Part | What it answers |
|---|---|
| **A. The plan on one page** | what ctc does after 006, where each feature comes from, the tech stack side by side |
| **B. The four reference systems** | how graphify, Langfuse, claude-mem and Orca work, and what we take or drop from each |
| **C. The merged target spec** | the new ctc, locked item by item (backend checklist sections 0–7 + retrieval) |
| **D. Tasks, decisions, open items** | the build order, what you still decide, and what is unverified |

Full research behind Part B (tables, `file:line` evidence, tuning values): [research/graphify.md](research/graphify.md), [research/langfuse.md](research/langfuse.md), [research/claude-mem.md](research/claude-mem.md), [research/orca.md](research/orca.md). Graphs regenerate with `python -I specs/006-merged-core/mk_graphs.py specs/006-merged-core`.

---

## Part A. The plan on one page

### A1. What ctc does after 006

| # | Feature | What the user gets | Learned from |
|---|---|---|---|
| 1 | **Context graph** | One graph of code + specs + tasks + decisions + skills + workflows. On every prompt, ctc walks it and adds one line: the task, the file and symbol, the skill to use, the decision that applies. Before Read/Edit/Grep, a note says which tasks and decisions touch that file. MCP tools search, explain, trace and show what a change affects. | **graphify** (code graph, queries, hook mechanics) + ctc's own context graph |
| 2 | **Skill library** | Every skill, agent, command and workflow is versioned. Labels say which version is `production`. Multi-file skills keep their files. Each project can pin a label or a version. | **Langfuse** prompt + skill management |
| 3 | **Memory** | ctc learns facts and session summaries from your sessions. At session start it injects the relevant ones within a fixed size. MCP search returns a short index first and full records on request. | **claude-mem** (loop, spool, budget, search) + ctc's local-LLM extractor |
| 4 | **Workflows** | Saved workflows run agents (`claude -p`, `codex`) in git worktrees. Steps have attempts and survive a crash. Approvals offer choices. A step can fan out to N parallel agents in their own worktrees. | **Orca** (worktrees, attempts, gates, fan-out) |

**Removed** (owner decision, 2026-10-30):

| Removed | Today's code | Also goes |
|---|---|---|
| Plan for a suggestion (`find_capabilities(ref)`, `/v1/bundle`) | [`src/ctc/decision/bundle.py`](../../src/ctc/decision/bundle.py), [`src/ctc/server/hooks.py:360-372`](../../src/ctc/server/hooks.py:360), MCP `find_capabilities` | `bundle:{ref}` cache, `Bundle` schema |
| Follow tracking | [`src/ctc/server/hooks.py:250`](../../src/ctc/server/hooks.py:250) follow logic, [`src/ctc/server/writer.py`](../../src/ctc/server/writer.py) `followed` | `decisions` + `events` tables, stream writer, `/api/kpis`, `/timeline`, `/activity`, `/decisions*`, [`.claude/metric/eval/adoption.md`](../../.claude/metric/eval/adoption.md) |
| Separate route/decide pipeline | [`src/ctc/server/hooks.py:96-129`](../../src/ctc/server/hooks.py:96) `route()`, `/v1/route` | replaced by the graph walk in feature 1; `/v1/search` stays as `/v1/suggest` for evals |

Because follow tracking and decisions are gone, **ClickHouse is not needed** (005 added it for decisions/events). 006 runs on Postgres + pgvector + Redis only.

### A2. Where each piece comes from

| Feature | Take from the source | Keep from ctc today | Drop |
|---|---|---|---|
| Context graph | graphify: node ids `path + entity`; tree-sitter extraction; the cross-file call pass that marks a call as certain (EXTRACTED) only when an import proves it; incremental rebuild by file content hash; refusing to write a graph that shrank (shrink guard); lexical seed scoring + BFS (breadth-first walk) with a hub cut-off + a text answer capped by tokens; `explain` / `path` / `affected`; ambiguous / not-found errors that list candidates; the PreToolUse search hint (capped per session); `sanitize_label` | Postgres graph tables with `origin`-scoped replace; context parsers (spec, task, decision ids); embeddings on every node; RAM graph per worker; per-prompt line and file note; `claude -p` haiku doc extraction | graphify's JSON-file store, 35-language extractor set, exporters, multi-repo global graph, LLM dedup |
| Skill library | Langfuse: immutable version rows + mutable `labels[]`, `latest` set by the system, `production` as the default read; per-name advisory lock for version numbers; multi-file manifest over content-addressed blobs; MCP `get_capability` + `load_capability_resource` pinned to one version; post-commit queue job; Zod limits; YAML parse with `maxAliasCount: 0` | scanner of `~/.claude` + plugin roots; SKILLRET embeddings + rerank (tuned, NDCG@10 0.811 test); enrichment; `dedup_review`; per-project `overrides` | Langfuse search (ILIKE only), RBAC roles, nested prompt references, Next.js/Prisma/tRPC |
| Memory | claude-mem: file-per-event hook spool drained by the server; session summary schema (request, investigated, learned, completed, next_steps, notes); retry once then drop on a bad model reply; content-hash idempotency; reinforcement by distinct days; hybrid recall (reciprocal rank fusion, RRF, of Postgres full-text + pgvector, K = 60); SessionStart context that is rendered, measured and trimmed in a fixed drop order under 10,000 chars; MCP `search → timeline → get`; private-tag stripping; memory-file watcher | local llama-server extraction of user words; ADD / UPDATE / NOOP / SUPERSEDE similarity bands (0.95 / 0.85); recency decay | per-tool-use Haiku observer, Chroma, SQLite, Bun, corpora, cloud sync |
| Workflows | Orca: step **attempts** (`retry_of`, circuit break at 3) with **stages** and a `start_unknown` state; one transition function with an allowed `from → to` table; idempotency keys on mutating routes; worktree recipe (`git worktree add --no-track -b`, `branch.<b>.base`, 180 s timeout, git serialized per repo); repo setup hook (`ctc.yaml setup:`, 120 s, process-group kill, 10 MB log cap); decision gate with options whose answer is injected into the next prompt; fan-out (N child steps, depth 1); handoff that returns `prompt_outcome`; agent registry; cleanup that keeps the branch | deterministic DAG walker (readonly batch, then one writer); `SKIP LOCKED` claim; `claude -p` per node; logs + diffs; schedules; export to `.claude/workflows/*.js` | Orca's LLM coordinator, terminal daemon (node-pty), PTY mail injection, hook-based status, SQLite, mobile/relay |

### A3. Tech stack side by side

| Layer | graphify 0.9.93 | Langfuse 4.72 | claude-mem 15.7 | Orca 1.4.214 | ctc today | **ctc 006** |
|---|---|---|---|---|---|---|
| Language | Python 3.10+ | TypeScript 6/7 | TypeScript 6 | TypeScript 7 | Python 3 | **TypeScript 6** |
| Runtime | CPython (uv tool) | Node 24 | Bun (worker), Node (CLI) | Electron 43 + Node 24.22 (`orcad`) | CPython + uvicorn | **Node 24.22** |
| Monorepo | single package | pnpm 12 + Turborepo | single package (+ plugin) | pnpm 12 workspace | uv | **pnpm 12 workspace** |
| HTTP | MCP over Starlette | Next.js 16 API routes + tRPC 11 | Express 5 | own JSON RPC on unix socket / WebSocket | FastAPI | **Fastify 5** |
| Queue | none (process pool) | BullMQ 5 (44 queues) + DLQ re-run | RAM buffer + file spool (worker); BullMQ (server mode) | none (LLM coordinator) | Redis streams | **BullMQ 5** + DLQ re-run + file spool |
| Main DB | JSON files | Postgres 17 via Prisma 6 | SQLite (FTS5), schema v71 | `node:sqlite` WAL, schema v43 | Postgres 17 (Supabase), raw SQL | **Postgres 17 + pgvector, Kysely** |
| Vectors | none (lexical only) | Topics only (Bedrock Cohere 1024-d) | Chroma, MiniLM 384-d | none | pgvector + RAM matrix, SKILLRET 1024-d | **pgvector + RAM matrix, SKILLRET 1024-d** |
| Analytics DB | — | ClickHouse 25.12 | — | — | — | **none** |
| Cache | content-hash files | Redis (prompt epoch, 1 h) | rendered-context cache | in-process | L1 + Redis + semantic | **L1 + Redis** |
| Parsing | tree-sitter 0.25 + regex | YAML frontmatter | tree-sitter (smart_* tools) | — | regex parsers | **web-tree-sitter + markdown parser** |
| Graph lib | networkx 3.7, Louvain | — | — | — | own adjacency dicts | **own adjacency + graphology (Louvain later)** |
| LLM | optional (docs, labels) | Vercel `ai` 7, Mastra | Claude Agent SDK (Haiku 4.5) | Claude Agent SDK, 40+ agent CLIs | llama-server (Qwen2.5-3B), `claude -p` | **llama-server + `claude -p` / `codex`** |
| Validation | own schema check | Zod 4 | Zod 4 | Zod 4 | Pydantic | **Zod 4** |
| MCP | `mcp` SDK, 10 tools | `@modelcontextprotocol/sdk` 1.32 | MCP SDK 1.29, 26 tools | skills docs, not MCP | FastMCP, 7 tools | **`@modelcontextprotocol/sdk` 1.x** |
| Tests | 474 files (pytest) | Vitest 4 + Playwright | `bun test` (1,085 files) | Vitest 5 + Playwright | pytest + self-checks | **Vitest 4** |
| Lint | — | ESLint 10, knip | tsc, lint scripts | oxlint, ratchets | ruff | **ESLint 10 + tsc** |

---

## Part B. The four reference systems

Each section: what it is, a flow graph, how it works, what we take. Evidence is in the matching `research/*.md`.

### B1. graphify: a code knowledge graph for coding agents

`Graphify-Labs/graphify`, read at installed **0.9.93** (+ clone `0a8cd4e1`, 0.9.97). Apache-2.0. Python 3.13, tree-sitter 0.25, networkx 3.7. Graph: [src-graphify.svg](src-graphify.svg).

**What it is.** A CLI, MCP server and Claude Code skill. It parses a repo into nodes (files, classes, functions, markdown pages and headings, rationale comments, external packages) and edges (`calls 2035, contains 1854, references 841, imports 831, imports_from 487, rationale_for 395, …` on this repo: 2,863 nodes, 6,914 edges, 173 communities). Building the code graph makes **zero LLM calls**. It has **no embeddings**: every query is lexical.

**How it works.**
1. **Build:** `detect` walks the tree (honours `.gitignore`, skips secret files) → a process pool runs one tree-sitter extractor per file → cross-file passes resolve calls. A call becomes `EXTRACTED` only when an import edge proves it; otherwise it stays `INFERRED` with a fixed score (0.95 / 0.85 / …). Then dedup → Louvain communities → god nodes and "surprising connections" → `graph.json` + `GRAPH_REPORT.md`.
2. **Node ids:** `make_id` = casefold + NFKC + `_` for non-word runs over `path_sans_ext + entity` (e.g. `src_ctc_decision_bundle_suggestion_line`). The same id comes from AST, LLM and builder.
3. **Incremental:** a git post-commit hook runs a detached rebuild. Changed files are found by `sha256(content + relpath)` (markdown hashes the body only). Changed files are re-extracted with the **old graph's nodes as resolution context**, so unchanged callees still bind. Results merge by file + tier (`_origin`). Writing refuses a graph with fewer nodes unless forced (**shrink guard**).
4. **Query:** score labels by tiers (exact 1000, prefix 100, substring 1) × IDF × coverage² → pick ≤ 3 seeds → BFS depth 2, skipping hubs with degree ≥ max(50, p99) → render text within 2,000 tokens (seeds first, then by hop).
5. **explain / path / affected:** tiered name resolution. More than one match → exit 3 with the candidates listed; none → exit 4. `path` = directed shortest path. `affected` = reverse BFS over 15 relations, depth 2.
6. **Hook:** PreToolUse on Bash/Grep/Read/Glob. It token-parses the search command and adds ≤ 5 nodes matching the searched terms. Capped at 5 nudges per session, silent for 30 min after a `graphify query`, fail-open. **There is no per-prompt hook.**

**Weak spots seen here.** A natural-language query returned 559 nodes padded with `asyncio`, `numpy`, `cfg()`. That is why ctc keeps embeddings as a second seed signal.

**We take:** the id recipe, extraction approach, cross-file call rule, incremental rebuild + content-hash cache + shrink guard, query/explain/path/affected algorithms and error codes, the hook mechanics, `sanitize_label`. **We drop:** the JSON store, most of the 35 languages (start with 6), exporters, the multi-repo graph, fuzzy and LLM dedup for code.

### B2. Langfuse: prompts and skills as a versioned library

`langfuse/langfuse` at **`5cb2047`** (v4.72.0). MIT outside `ee/`. Next.js 16 web + Express/BullMQ worker, Postgres via Prisma, ClickHouse, Redis, S3. Graph: [src-langfuse.svg](src-langfuse.svg).

**What it is.** An LLM observability platform whose prompt and **skill** management is a versioned library served to SDKs, a CLI and agents (REST, tRPC, MCP).

**How it works.**
1. **Data model:** one row per version, with `(projectId, name, version)` unique. Content is immutable; `labels[]` is mutable; `tags[]` are shared by all versions. A skill version = `skills` row + `skill_files(path → blob)` + `skill_blobs(sha256, content)`, deduplicated by hash per project. Limits: 200 files, 1 MB per skill, name `^[a-z0-9]+(-[a-z0-9]+)*$` ≤ 64, description ≤ 1,024.
2. **Create:** Zod check → parse `SKILL.md` frontmatter → one transaction under `pg_advisory_xact_lock(hashtext(skills, project, name))` → version = max + 1, take `latest` off the previous version, insert blobs (skip duplicates) + row + files → audit log.
3. **Labels:** `latest` is system-managed; `production` is the default read. A label sits on at most one version per name. `production` moves need the protected-label permission. Label moves lock the row (`SELECT … FOR UPDATE`) on the REST path.
4. **Serve:** `getSkill(name, label|version)` returns the manifest and the version; `loadSkillResource(version, path)` loads one file, so a multi-call read stays on one version. The CLI `langfuse skills install <tag>` writes a lockfile. Prompts resolve through a Redis cache keyed by a project-wide **epoch token**: every write rotates the token, so old keys are dead without a scan.
5. **After commit:** an `EntityChange` BullMQ job matches triggers and sends webhooks.

**Gaps to avoid:** blobs are never garbage-collected; the tRPC label path takes no row lock.

**We take:** versions + labels + advisory lock, multi-file manifest over blobs, the version-pinned MCP read pair, the post-commit job, Zod limits, safe YAML. **We drop:** ILIKE search (ctc's hybrid search is stronger), roles/RBAC (single user), nested prompt references, the whole Next.js/Prisma/ClickHouse/S3 stack.

### B3. claude-mem: the memory loop

`thedotmack/claude-mem` at **`325afb6`** (v15.7.0). TypeScript on Bun, Express 5, SQLite (FTS5), Chroma via `uvx chroma-mcp`, Claude Agent SDK (Haiku 4.5). Optional server mode: Postgres + pgvector + BullMQ. Graph: [src-claude-mem.svg](src-claude-mem.svg).

**What it is.** A Claude Code plugin that watches your sessions, compresses them into observations and summaries, and feeds them back at session start and through MCP search.

**How it works.**
1. **Capture:** 9 hook events. PostToolUse/Stop/SessionEnd hooks strip `<private>` and harness tags, then write **one atomic spool file per event** under `~/.claude-mem/state/hook-spool` and exit. A 250 ms best-effort nudge tells the worker to drain. Hooks never fail the session (always exit 0).
2. **Drain:** the worker drains on boot, on file-watch events and in a 30 s sweep. Entries are kept for 7 days if the worker is down; rejected ones go to `corrupt/`.
3. **Observe:** a RAM buffer per session (deduplicated by `tool_use_id`) feeds one Haiku conversation per session (no tools). It replies in XML: type, title, facts, narrative, concepts, files. A bad reply is retried once in a fresh conversation, then dropped. Quota, auth or transport errors keep the batch.
4. **Store:** `observations` with `UNIQUE(session, content_hash)` and `ON CONFLICT DO NOTHING`. Re-observing a fact appends the ISO day to `reinforcement_dates`. Chroma gets one doc per field.
5. **Summarize:** on Stop, `<summary>` with request / investigated / learned / completed / next_steps / notes goes to `session_summaries`.
6. **Inject:** at SessionStart it renders the newest 50 observations + summaries + work state, **measures**, and drops in a fixed order (narratives → last summary → last message → halve sessions → halve observations) until the block is **≤ 10,000 chars** (Claude Code discards bigger hook output).
7. **Search (MCP):** `search` returns an id index (~50–100 tokens per row) → `timeline(anchor, 3 before, 3 after)` → `get_observations(ids)`. Server mode fuses bm25 and HNSW with **RRF, K = 60, 100 candidates per leg**.

**We take:** the spool, summary schema, retry-once-then-drop, content hash + `ON CONFLICT`, reinforcement days, RRF hybrid recall, fit-by-measuring injection, the 3-step MCP search, tag stripping, the memory-file watcher. **We drop:** the per-tool Haiku observer (it needs a paid frontier model on every tool call; ctc's session-level local extraction is cheaper), Chroma, SQLite, Bun, title dedup (ctc's similarity bands are stronger), corpora, cloud.

### B4. Orca: agents in git worktrees

`stablyai/orca` at **`2c4eb87`** (app v1.4.214, `orcad` 0.1.0, installed here and running on `127.0.0.1:6768`). MIT. Electron 43, TypeScript 7, Node 24.22, `node:sqlite`, node-pty, Claude Agent SDK, 40+ agent CLIs. Graph: [src-orca.svg](src-orca.svg).

**What it is.** A desktop app + headless daemon that creates worktrees, launches coding agents in them, watches their status and coordinates many agents on one task.

**How it works.**
1. **Worktree:** sanitize the name → resolve the base → `git worktree add --no-track -b <branch> <path> <base>` (180 s timeout) → write `branch.<b>.base` + `push.autoSetupRemote` → run `orca.yaml scripts.setup` (120 s, process-group kill, 10 MB output cap, env `ORCA_ROOT_PATH`, `ORCA_WORKTREE_PATH`). Git operations go through a per-repo admission scheduler.
2. **Launch:** an agent registry (`TUI_AGENT_CONFIG`) knows each CLI's argv and prompt delivery. The agent runs in a PTY owned by a separate terminal daemon, or as a Claude SDK child. The result carries `prompt.outcome` = `journaled` / `handed-to-terminal` / `not-delivered` / `unconfirmed` plus an `operationId` for replay.
3. **Status:** Orca writes hooks into the agent's own config; they POST to a loopback server (random token). States: working / blocked / waiting / done. It never acts on absence: an agent that went quiet is `unverifiable`, not dead.
4. **Orchestrate:** the domain model is Run → Task (deps) → Dispatch (one attempt, `retry_of`) → worker_dispatches (`starting, ready, start_unknown, …`). `worker-start` creates them in **one transaction**, then places the agent and delivers a preamble. The worker sends `worker_done` once; settlement is atomic, a duplicate is a no-op, a stale one is rejected. 3 failed attempts **circuit-break** the task. A **decision gate** has options; its resolution is injected into the next prompt. The scheduler is **an LLM coordinator agent**, not code.
5. **Idempotency:** every mutation takes `request_id`; `mutation_receipts(fingerprint, request_id, payload_hash)` replays a lost reply.
6. **Cleanup:** `worker-release` archives output and closes the terminal; `worktree rm` runs an archive hook, then `git worktree remove`, and **keeps the branch**.

**We take:** attempts + stages + `start_unknown` + circuit break, the single transition function, idempotency keys, the worktree recipe + setup hook, gates with options, fan-out (as a deterministic node, depth 1), handoff with `prompt_outcome`, a small agent registry (`claude`, `codex`), cleanup that keeps branches. **We drop:** the LLM coordinator (ctc workflows are saved graphs; an LLM scheduler adds nondeterminism), the terminal daemon and PTYs, PTY mail injection, hook-based status (ctc nodes are headless; status comes from `claude -p --output-format stream-json`), SQLite, federation/mobile/relay.

---

## Part C. The merged target spec

### C0. System map and domain

**Graphs**

| Graph | File |
|---|---|
| Architecture, 12 numbered steps, hot (red) and cold (blue) | [arch-merged.svg](arch-merged.svg) |
| Application map, 4 features + ops + removed | [app-map-merged.svg](app-map-merged.svg) |
| Feature flows, 7 lanes | [flows-merged.svg](flows-merged.svg) |
| ctc today, for comparison | [today-arch-current.svg](today-arch-current.svg), [today-app-map.svg](today-app-map.svg) |

**Hot path** = steps 1–4 (hooks that Claude Code waits on). **Cold path** = steps 5–12 (everything in the worker).

**Code map (planned modules, pnpm workspace):**

| Module | Logic inside | Replaces (Python) | Learned from |
|---|---|---|---|
| `apps/web` | Fastify on `~/.claudethecaller/ctc.sock` + `127.0.0.1:18310`: hooks `prompt`, `pre`, `start`; spool drain; `/api`; `/mcp`; static dashboard; RAM graph + skill vectors | [`src/ctc/server/app.py`](../../src/ctc/server/app.py), [`src/ctc/server/hooks.py`](../../src/ctc/server/hooks.py), [`src/ctc/server/api.py`](../../src/ctc/server/api.py), [`src/ctc/server/library.py`](../../src/ctc/server/library.py), [`src/ctc/server/runs.py`](../../src/ctc/server/runs.py), [`src/ctc/server/mcp.py`](../../src/ctc/server/mcp.py) | Langfuse web/worker split |
| `apps/worker` | BullMQ workers for queues `graph`, `library`, `llm`, `memory`, `runner`, `cleanup`, `dlq-retry` | [`src/ctc/server/jobs.py`](../../src/ctc/server/jobs.py), [`src/ctc/runner/engine.py`](../../src/ctc/runner/engine.py), `ingestion/*`, `ai/*`, [`src/ctc/graph/build.py`](../../src/ctc/graph/build.py), [`src/ctc/graph/extract.py`](../../src/ctc/graph/extract.py) | Langfuse worker |
| `apps/cli` | `ctc` commands (same names), `ctc hook spool` | [`src/ctc/cli.py`](../../src/ctc/cli.py) | — |
| `hooks/spool.sh` | POSIX sh: stdin → one atomic spool file → background 250 ms nudge | — (new) | claude-mem spool |
| `packages/shared/repositories` | the only module with SQL; one file per domain; `ctx.userId` first arg | every SQL site (~380) | Langfuse repositories |
| `packages/shared/schemas`, `env`, `queues` | Zod for routes, MCP tools, queue payloads, YAML config | [`src/ctc/server/schemas.py`](../../src/ctc/server/schemas.py), [`src/ctc/config.py`](../../src/ctc/config.py) | Langfuse, Orca |
| `packages/core/graph` | ids, extract (web-tree-sitter), resolve, query (lexical + embedding seeds, BFS, render), explain, path, affected, push (prompt line, file note, search hint), sanitize | `graph/*.py` | graphify |
| `packages/core/library` | scan, frontmatter, version diff, manifest | [`src/ctc/ingestion/scanner.py`](../../src/ctc/ingestion/scanner.py), [`src/ctc/ingestion/indexer.py`](../../src/ctc/ingestion/indexer.py) | Langfuse skills |
| `packages/core/memory` | parse, bands (ADD / UPDATE / NOOP / SUPERSEDE), RRF, fit-by-measuring | [`src/ctc/memory/longterm.py`](../../src/ctc/memory/longterm.py), [`src/ctc/ai/extract.py`](../../src/ctc/ai/extract.py) | claude-mem |
| `packages/core/runner` | walker (pure), transition table, preamble, worktree recipe | [`src/ctc/runner/graph.py`](../../src/ctc/runner/graph.py), [`src/ctc/runner/proc.py`](../../src/ctc/runner/proc.py), [`src/ctc/runner/engine.py`](../../src/ctc/runner/engine.py) | Orca |
| `evaluation/` (Python) | offline evals (ranx, scikit-learn); calls `POST /v1/suggest` | unchanged | — |

**Domain model (Postgres, schema `ctc`):** ownership `user → project → {graph, overrides, memories, sessions, wf_runs}`; capabilities are per user (namespace).

| Table | Key columns (new in **bold**) | Notes |
|---|---|---|
| `projects` | id, user_id, root, profile_hash | unchanged |
| `graph_nodes` | id (`code:<path>[::sym]`, `ctx:<file>:<id>`, **`skill:<name>`**, **`workflow:<name>[:step-n]`**, **`agent:<name>`**, **`command:<name>`**), user_id, project_id, kind (code / context), type, label, source_file, source_location, origin (**ast** / parser / claude / commit / review / session), **content_hash**, embedding vector(1024), meta jsonb | graphify ids for code |
| `graph_edges` | src, dst, relation, confidence (CONFIRMED / EXTRACTED / INFERRED / AMBIGUOUS / DROPPED), score, origin, source_location | graphify relations + ctc relations |
| `graph_sources` | project_id, file, **content_hash**, **extractor_version**, built_at_commit | content-hash cache |
| `capabilities` | id, user_id, namespace, kind (skill / agent / command / workflow), name, **served_version** | one row per name |
| **`capability_versions`** | cap_id, version, body_hash, description, frontmatter jsonb, labels text[], commit_message, created_at; unique (cap_id, version); GIN(labels) | immutable content |
| **`cap_files`**, **`cap_blobs`** | (version_id, path, blob_hash); (user_id, hash sha256 hex, content, size) | multi-file skills |
| `cap_vectors` | cap_id, text_hash, embedding | only for the `production` (else `latest`) version |
| `overrides` | user_id, project_id, cap_id, action (pin / block), **label**, **version** | pin to label or version |
| `dedup_review` | pair, status | unchanged |
| `memories` | id, user_id, project_id, scope, kind, text, **hash** (unique per user, scope, project), embedding, **tsv**, **reinforcement_dates date[]**, superseded_by, created_at | |
| **`session_summaries`** | session_id, project_id, request, investigated, learned, completed, next_steps, notes, **content_hash** unique | from claude-mem |
| `sessions` | id, user_id, project_id, started_at, ended_at, model, tokens, transcript_path | no turn counter, no decisions |
| `history_files` | path, size, mtime, status | feeds memory distill only |
| `wf_runs` | id, user_id, workflow, status, trigger, worktree, branch | |
| `wf_steps` | id, run_id, node_id, visit, **attempt**, **retry_of_step_id**, **failure_count**, status, **stage**, **liveness**, **pid**, **pid_started_at**, **token_hash**, **options jsonb**, **resolution**, **prompt_outcome**, usage, cost_usd | Orca attempts |
| `wf_schedules` | unchanged | |
| **`idempotency_keys`** | key, route, payload_hash, response jsonb, created_at; PK key; pruned after 30 d | Orca mutation receipts |
| `jobs` | id, queue, kind, status (queued / running / done / failed / **dead**), progress, result, error | Postgres row is the truth |
| `api_keys` | unchanged | shared mode |

Dropped tables: `decisions`, `events` (and their writer).

**Event contract.**
- Spool entry: one file `~/.claudethecaller/spool/<session_id>-<event>-<epoch_ns>-<rand>.json` = `{ v: 1, event: "PostToolUse" | "Stop" | "SessionEnd", received_at, payload: <hook stdin JSON> }`. Written as `.tmp` then renamed (atomic).
- Queue payloads (Zod in `packages/shared/queues`): `graph.rebuild {project_id, files[]}`, `graph.extract {project_id, files[]}`, `library.scan {roots[]}`, `library.changed {cap_id, version}`, `llm.enrich {cap_id, version}`, `llm.extract {session_id, transcript_path}`, `llm.summarize {session_id, transcript_path}`, `memory.import {roots[]}`, `memory.distill {history_file}`, `runner.step {run_id, node_id, visit, attempt}`, `cleanup.worktree {run_id}`.
- Each event maps to: PostToolUse(Edit|Write|MultiEdit) → `graph.rebuild` (debounced 3 s per project); Stop → `llm.extract`; SessionEnd → `llm.summarize` + `sessions` upsert. Other PostToolUse events are dropped at drain.

**Deployment topology.**

| Process | Runs | Count |
|---|---|---|
| `ctc-web` | Node 24, Fastify, RAM graph + skill vectors | 1 local; N in shared mode |
| `ctc-worker` | Node 24, BullMQ workers | 1 (llama-server has one slot) |
| Postgres 17 + pgvector (Supabase), Redis 8, TEI ×2, llama-server | unchanged | — |

Local mode: `ctc-web` and `ctc-worker` run on the host (the runner needs the user's `claude` login and repo access) as `systemd --user` units. Shared mode: docker compose. No ClickHouse, no object store.

**Interfaces.**

| Way in | Endpoint / name | Input | Result |
|---|---|---|---|
| Hook UserPromptSubmit | `POST /v1/hook/prompt` (curl `-m 0.15`) | hook JSON | `200 text/plain`: one line or empty |
| Hook PreToolUse | `POST /v1/hook/pre` (curl `-m 0.05`) | hook JSON | `200` JSON `additionalContext` or empty |
| Hook SessionStart | `POST /v1/hook/start` (curl `-m 1.5`) | hook JSON | `200 text/plain` ≤ 10,000 chars or empty |
| Hooks PostToolUse, Stop, SessionEnd | `hooks/spool.sh` → file; `POST /v1/spool/nudge` | hook JSON | exit 0 always |
| Debug / eval | `POST /v1/suggest`, `GET /v1/health` | `{prompt, cwd}` | JSON: seeds, candidates, line, timings |
| Dashboard | `/api/*` (§C1) | Zod | JSON |
| MCP | `graph_search`, `graph_explain`, `graph_path`, `graph_affected`, `graph_neighbors`, `get_capability`, `load_capability_resource`, `mem_search`, `mem_timeline`, `mem_get`, `save_memory`, `run_workflow`, `workflow_status` | Zod | text / JSON |
| CLI | `ctc` (same 27 command names minus `route`; plus `ctc hook spool`, `ctc migrate`) | flags | exit 0 / 1 / 2 usage / 3 daemon down |
| Queue consumers | 7 queues (§C4) | Zod payloads | `jobs.result` |
| File reads | `~/.claude/**` skills, agents, commands, workflows, memory files, transcripts; project repo | — | — |

**Process model and supervision.** `systemd --user` units with `Restart=on-failure`, `StartLimitBurst=5/60s`; `ctc daemon start|stop|status` wraps them. The web watchdog exits 78 if it cannot bind in 60 s (claude-mem). Bad inputs: a spool file that fails Zod moves to `spool/corrupt/`; a job failing all attempts → `jobs.status = dead` and the BullMQ failed set; `dlq-retry` re-runs failed jobs every 10 min up to 5 times (Langfuse); workflow steps never auto-retry beyond `failure_count < 3` (Orca).

**Data lifecycle.** Spool files are deleted after accept, kept 7 days while undeliverable. Graph rows are replaced per `(origin, source_file)` on rebuild; `review` and `session` edges survive. Capability versions are never auto-deleted; blobs without a `cap_files` reference are deleted by a weekly `cleanup` job (fixes the Langfuse gap). Memories are superseded, never hard-deleted except through `DELETE /api/memories/:id`. Worktrees are removed 7 days after the run ends (branch kept). `idempotency_keys` are pruned after 30 days. Schema migrations: numbered SQL in `packages/shared/migrations`, applied by `ctc migrate`; a schema stamp refuses to start a binary older than the database (claude-mem).

**Configuration surface.** `config/*.yaml`, parsed by Zod at startup (a bad key fails startup with its path). New keys (defaults):

| Key | Default | Purpose |
|---|---|---|
| `spool.dir` | `~/.claudethecaller/spool` | hook spool |
| `spool.keep_days` | 7 | undeliverable retention |
| `graph.languages` | `[ts, tsx, js, python, bash, sql, json, markdown]` | tree-sitter grammars |
| `graph.query` | `{seeds: 3, depth: 2, hub_min: 50, budget_tokens: 2000}` | graphify query |
| `graph.shrink_guard` | 0.2 | refuse a rebuild that loses > 20 % of a source's nodes |
| `graph.hint` | `{per_session: 5, quiet_s: 1800, max_nodes: 5}` | PreToolUse search hint |
| `library.default_label` | `production` (fallback `latest`) | served version |
| `memory.context_chars` | 10000 | SessionStart cap |
| `memory.rrf` | `{k: 60, per_leg: 100}` | recall fusion |
| `runner.worktree` | `{add_timeout_s: 180, keep_days: 7}` | Orca recipe |
| `runner.setup` | `{timeout_s: 120, max_output_mb: 10, policy: run}` | `ctc.yaml setup:` |
| `runner.fanout_max_depth` | 1 | nested fan-out limit |
| `runner.max_failures` | 3 | circuit break |

**Resource budgets.** web RSS ≤ 600 MB (graph ≤ 100k nodes × 1,024 × 4 B ≈ 400 MB worst case; this repo ≈ 12 MB); worker RSS ≤ 1 GB; hook body ≤ 1 MB; spool file ≤ 1 MB (bigger → corrupt); skill ≤ 200 files, 1 MB; Redis `maxmemory 256mb`.

**Egress and privacy.** Binds loopback + socket only. Nothing leaves the machine except `claude -p` / `codex` runs and doc extraction (`claude -p --model haiku`, as today), plus an `anthropic:` LLM when configured. All graph text passes `sanitize` (strip control chars, cap 256 per label) before it reaches a model or the context. Memory input strips `<private>`, `<system-reminder>`, `<persisted-output>` and ctc's own injected lines.

**Input coverage and known limits.** Code: ts, tsx, js, python, bash, sql, json (more grammars later). Docs: markdown (`specs/*`, `.scratch/*`, `PLAN.md`, `CLAUDE.md` decisions, `.claude/**`). Skills: `SKILL.md` + files; agents/commands `.md`; workflows `.claude/workflows/*.js` + ctc workflow JSON. Not handled: binaries, images, PDFs, other languages (graphify has them; added on demand).

### C1. API contract and transport layer

- **Routes kept:** `/api/projects*` (4), `/api/sessions*` (3, now with summaries), `/api/index`, `/api/jobs*` (2), `/api/history*` (3), `/api/keys*` (3), `/api/capabilities*` (5), override, enrich, `/api/dedup*` (2), `/api/memories*` (8), workflow/runs routes (15). **Removed:** `/api/kpis`, `/api/timeline`, `/api/activity`, `/api/decisions*`, `/v1/route`, `/v1/bundle/{ref}`, `/v1/search` (→ `/v1/suggest`).
- **Routes added:** `GET /api/capabilities/:id/versions`, `GET /api/capabilities/:id/versions/:v`, `PATCH /api/capabilities/:id/versions/:v/labels {labels[]}`, `POST /api/capabilities/:id/restore {version}` (writes that body back to the file → new version); `GET /api/graph/search|explain|path|affected` (same as MCP); `POST /api/runs/:rid/steps/:sid/report {outcome, summary}` (per-step token header); `POST /api/runs/:rid/steps/:sid/retry`; `GET /api/sessions/:sid/summary`.
- **Request schema:** Zod per route. Limits: list `limit ≤ 500`, keyset pagination on `(created_at, id)`; label regex `^[a-z0-9_\-.]{1,36}$`, `latest` rejected in bodies; skill name `^[a-z0-9]+(-[a-z0-9]+)*$` ≤ 64; prompt ≤ 20,000 chars (truncated on hooks, not rejected).
- **Response codes:** `200`; `201` create; `202 {job_id}` job submit; `204` hooks that answer nothing.
- **Error taxonomy:** `{ "error": { "code", "message", ...extra } }`. Zod → `422 invalid`; no/revoked key → `401 unauthorized`; another user's id → `404 not_found`; version/label race or illegal state transition → `409 conflict`; same idempotency key with a different payload → `409 idempotency_mismatch`; rate limit → `429` + `retry-after`; Postgres timeout → `504 store_timeout`; else `500 internal` (class name only). MCP graph tools: `ambiguous` (with up to 10 candidates and `path::symbol` hints) and `not_found`, as in graphify exit 3/4. Hooks never error: any failure is the empty reply.
- **Idempotency header:** `Idempotency-Key` accepted on `POST /api/workflows/:id/runs`, `/approve`, `/cancel`, `/continue`, `/retry`; same key + same payload hash replays the stored response (Orca).
- **Versioning and non-goals:** `/v1/hook/*` paths are frozen. `/api` is internal. No public ingestion, no webhooks, no RBAC roles, no remote/mobile access.

### C2. Auth, tenancy and blast radius

- **Authentication:** local mode: none (socket + loopback). Shared mode: `Authorization: Bearer ctc_…` → SHA-256 → Redis `key:{hash}` (300 s), with a 60 s not-found sentinel (Langfuse).
- **Step report auth:** each agent step gets a random token in its env (`CTC_STEP_TOKEN`); only `sha256(token)` is stored; the report endpoint checks it plus the step's current attempt (a late report from an old attempt → `409 stale_attempt`) (Orca fencing).
- **Tenant isolation:** every repository function takes `ctx: {userId, projectId?}` first; `userId` comes from the verified key or the constant `local`, never from a body. ESLint bans `pg`/`kysely` imports outside `packages/shared/repositories`. Test: every read with user B's ctx returns zero of user A's rows.
- **Rate limiting:** 600 req/min per key (Redis fixed window); hooks over the limit get the empty reply; Redis down → limit skipped.
- **Setup scripts:** `ctc.yaml setup:` runs repo code. Policy `run` (default) / `ask` / `skip` per repo, as in Orca; `ask` blocks the run at a gate until approved.

### C3. Data layer and storage invariants

- **Engines:** Postgres + pgvector owns all state (tables in C0); Redis owns queues, L2 cache, rate limit, `ctc:inval`; the file system owns the spool, worktrees and run logs (`runs/<id>/steps/<sid>.jsonl.gz`).
- **Indexes (new):** `graph_nodes (user_id, project_id, type)`, `graph_nodes USING gin (to_tsvector('simple', label))`, HNSW `graph_nodes.embedding vector_cosine_ops`; `graph_edges (dst, relation)`, `(src, relation)`; `capability_versions (cap_id, version) UNIQUE`, GIN `labels`; `cap_blobs (user_id, hash) UNIQUE`; `memories USING gin (tsv)`, HNSW `embedding`, `(user_id, scope, project_id, hash) UNIQUE`; `session_summaries (content_hash) UNIQUE`; `wf_steps (run_id, node_id, visit, attempt) UNIQUE`; `jobs (status, created_at)`.
- **Concurrency and idempotency:**
  - Graph rebuild replaces rows for one `(origin, source_file)` in one transaction; content hash unchanged → no-op; shrink guard aborts the write.
  - Version numbers are allocated under `pg_advisory_xact_lock(hashtext('cap:' || user || ':' || name))`; label moves `SELECT … FOR UPDATE` the target row and remove the label from other versions in the same transaction.
  - Memory insert: `ON CONFLICT (user_id, scope, project_id, hash) DO UPDATE SET reinforcement_dates = array_append(...)` only when today is not already present.
  - Workflow: every status write goes through `transition(step, from, to)`, which checks the allowed table and uses `UPDATE … WHERE status = from` (0 rows → `409`); run claim stays `FOR UPDATE SKIP LOCKED`; BullMQ job id = `run:<rid>:node:<nid>:visit:<v>:attempt:<a>`, so a double add is one job.
- **Migration from today (in flight):** 006 is a rewrite, not a dual-write. Data carried over by one `ctc migrate --from-python` step: `capabilities` → `capabilities` + version 1 (`labels = [latest, production]`); `memories` (hash computed); `graph_*` (ids rewritten to graphify-style `code:` ids where they point at code); `wf_*` (old steps become attempt 1); `projects`, `api_keys`, `overrides`, `history_files`. `decisions` and `events` are exported to `~/.claudethecaller/archive/*.jsonl.gz` and dropped.
- **Read path:** prompt hook reads RAM only (graph + skill vectors) plus TEI; SessionStart reads Postgres (2 queries: summaries + RRF recall); dashboard lists are 1 query each.

### C4. Sync vs async execution boundary

- **Hot path (synchronous):**

| Hook | Must finish before the reply | Budget | Over budget |
|---|---|---|---|
| `/v1/hook/prompt` | Zod parse; project from cwd (cached); embed prompt (TEI, `emb:` cache); seeds = lexical label match ∪ embedding nearest context nodes ∪ skill nodes by SKILLRET dense + rerank top 20; BFS depth 2 with hub cut-off; rank task / spec / decision / skill / workflow; render one line | 140 ms (curl `-m 0.15`) | empty reply now; result cached for the next identical prompt |
| `/v1/hook/pre` | RAM only: Read/Edit/Write → file note; Bash/Grep/Glob → search hint (≤ 5 nodes, cap 5 per session, quiet 30 min after a graph MCP call) | 40 ms | empty |
| `/v1/hook/start` | 2 Postgres reads (last summaries; RRF recall for the project), render, measure, trim to 10,000 chars | 1,200 ms | empty |
| spool hooks | write one file, background nudge | ~10 ms (sh) | n/a |

- **Cold path (queues):**

| Queue | Jobs | Producer | Concurrency | Attempts / backoff | Timeout |
|---|---|---|---|---|---|
| `graph` | `rebuild`, `extract` (doc pass via `claude -p` haiku) | spool drain (edits), post-commit hook, CLI, `library.changed` (skill nodes) | 1 | 3, exp 5 s | rebuild 300 s; extract none |
| `library` | `scan`, `changed` (embed + dedup + graph node) | CLI, `/api/index`, worker start, file watch on `~/.claude` | 1 | 3, exp 5 s | 300 s |
| `llm` | `enrich`, `extract`, `summarize` | `library.changed`, Stop, SessionEnd | 1 (one llama-server slot) | 2 (retry once, then drop with `jobs.error`) | 120 s |
| `memory` | `import` (memory files), `distill` (old transcripts) | worker start, file watch, `/api/memories/import`, `/api/history/import` | 1 | 3, exp 5 s | none |
| `runner` | `step` | `/api/workflows/:id/runs`, MCP `run_workflow`, schedules, approve/continue/retry | 1 per login; fan-out children up to `runner.fanout_concurrency` = 3 | no auto-retry; `retry` route creates attempt n+1; 3 failures circuit-break | per node (`timeout_s` in workflow) |
| `cleanup` | `worktree`, `blobs`, `receipts` | run end + 7 d, weekly cron | 1 | 3 | 600 s |
| `dlq-retry` | repeatable `*/10 * * * *` | worker | 1 | 5 re-runs per job | — |

- **Background supervision:** BullMQ stalled-job detection re-queues a job whose worker died. Runner steps are never blindly re-queued: on worker start, a step in stage `spawned` with a live `pid` (matching `pid_started_at`) is reattached by tailing its log; dead with no exit record → `liveness = start_unknown`, run `waiting`, and the Runs page offers retry / fail. **Never act on absence** (Orca rule).
- **Redis down:** hooks still answer (RAM); the drain leaves files in the spool; job submits insert the `jobs` row and the worker polls `jobs` every 5 s until Redis returns (today's rule).

### C5. Caching strategy

- **Pattern:** cache-aside. L1 in-process LRU (256) → L2 Redis (20 ms timeout, marked down for 10 s) → source.
- **Keys and TTLs:** `emb:{sha1(text)}` 7 d; `sug:{user}:{project}:{sha1(prompt)}:{graph_epoch}` 1 h; `proj:{user}:{cwd}` 24 h; `ovr:{user}:{project}` 5 min; `key:{hash}` 5 min (sentinel 60 s); `ctx:{user}:{project}:{mem_epoch}` (rendered SessionStart block) 10 min; `rl:{user}:{minute}` 60 s.
- **Invalidation:** `graph_epoch` and `mem_epoch` are per-project tokens in Redis, rotated on every graph rebuild / memory write. Old keys die without a scan (Langfuse epoch pattern). `ctc:inval` pub/sub makes every web process reload its RAM graph and skill vectors after `graph.rebuild` or `library.changed`.

### C6. External integration and failure modes

| Failure | Detected by | Behavior |
|---|---|---|
| TEI down / slow | HTTP error, 140 ms budget | prompt hook: lexical seeds only, or empty reply; `/v1/suggest` → `503 model_unavailable` |
| llama-server down | job error | `llm` job retried once, then `jobs.error`; memories stay unlearned; nothing else affected |
| Model reply not valid JSON (llama grammar) | Zod parse | retry once with a fresh prompt, then drop (claude-mem rule) |
| Redis down | 20 ms timeout | cache and rate limit skipped; spool keeps files; jobs polled from Postgres |
| Postgres down | pool error | prompt + pre hooks still answer from RAM; start hook empty; `/api` `500`; jobs retry |
| web down | curl fails | Claude Code shows nothing (fail open); spool files wait up to 7 days |
| Bad parse wipes a source | shrink guard | rebuild aborted for that source, `jobs.error = shrink_guard`, old rows kept |
| Ambiguous symbol in MCP | resolver | `ambiguous` + candidates; agent retries with `path::symbol` |
| `git worktree add` hangs | 180 s timeout | step attempt fails at stage `worktree`; retry allowed |
| setup hook hangs / floods | 120 s / 10 MB | process group killed; attempt fails at stage `setup` |
| worker crash mid-step | restart sweep | reattach by pid, else `start_unknown` + run `waiting` |
| late report from an old attempt | step token + attempt | `409 stale_attempt`, ignored |
| 3 failed attempts | `failure_count` | step `circuit_broken`, run `failed`; retry refused |
| fan-out child merge conflict | join node `git merge` | join fails with the conflict file list; branches kept |
| prompt injection in graph or memory text | sanitize | control chars stripped, labels capped, injected tags removed |

### C7. Verification gates (definition of done)

| Test / metric | Scenario | Gate |
|---|---|---|
| `graph.ids.test.ts` | same file → same ids as graphify 0.9.93 on 20 fixture files | equal |
| `graph.resolve.test.ts` | call promoted to EXTRACTED only with an import edge; ambiguous name skipped | fixtures |
| `graph.incremental.test.ts` | edit 1 file → only its rows change; unchanged callers keep their edges; shrink guard trips at > 20 % loss | fixtures |
| `graph.query.test.ts` | 30 fixed questions: top seed and `affected` set equal graphify's on this repo | ≥ 27 / 30 |
| `suggest.latency` | [`.claude/metric/eval/latency.md`](../../.claude/metric/eval/latency.md) against `POST /v1/suggest` | cold p95 ≤ 150 ms, L1 hit p95 ≤ 10 ms |
| `suggest.skills` | [`.claude/metric/eval/skillret.md`](../../.claude/metric/eval/skillret.md) on the skill-seed channel | NDCG@10 ≥ 0.80 test (today 0.811) |
| `suggest.context` | [`.claude/metric/eval/contextbench.md`](../../.claude/metric/eval/contextbench.md) / [`.claude/metric/eval/mulocbench.md`](../../.claude/metric/eval/mulocbench.md) file-level recall on the graph line | ≥ today's m6 numbers |
| `library.version.test.ts` | file hash change → version n+1 with `latest`; label move is exclusive; parallel scans make no duplicate version | pass |
| `library.mcp.test.ts` | `get_capability` + `load_capability_resource` stay on the returned version after a new version lands | pass |
| `memory.spool.test.ts` | web down → spool files → web up → each event processed once; corrupt file → `corrupt/` | pass |
| `memory.idempotent.test.ts` | same session extracted twice → no new rows; reinforcement adds today once | pass |
| `memory.context.test.ts` | 500 memories → SessionStart block ≤ 10,000 chars, drop order as specified | pass |
| `memory.recall` | RRF vs vector-only on the memory eval set (new, `.claude/metric/eval/memory.md`) | RRF ≥ vector-only Recall@5 |
| `runner.lifecycle.test.ts` | every illegal `from → to` rejected; duplicate report no-op; stale report `409` | pass |
| `runner.crash.test.ts` | kill worker mid-step → reattach (pid alive) or `start_unknown` (dead) | pass |
| `runner.fanout.test.ts` | 3 children in 3 worktrees, join merges; depth 2 refused | pass |
| [`.claude/metric/eval/runner.md`](../../.claude/metric/eval/runner.md) metrics | [`.claude/metric/eval/runner.md`](../../.claude/metric/eval/runner.md) on 3 sample workflows | as today |
| `tenancy.test.ts` | user B sees zero of user A's rows on every repository read | pass |
| `failopen.test.ts` | TEI / Redis / Postgres down → prompt + pre hooks reply within budget | pass |
| [`.claude/metric/eval/ci.md`](../../.claude/metric/eval/ci.md) | `pnpm -r lint && pnpm -r typecheck && pnpm -r test` + [`scripts/check.sh`](../../scripts/check.sh) | green |

### R. Retrieval (RAG checklist)

| Stage | Context graph | Skills (seed channel) | Memory |
|---|---|---|---|
| 1. Ingestion | tree-sitter per code file; markdown pages + headings; ctc parsers for task / requirement / decision ids; skill and workflow files; content hash per file | `SKILL.md` + files, agents, commands, workflows; YAML frontmatter (`maxAliasCount: 0`); hash per file | transcripts (user words only for facts; the whole session for the summary); `~/.claude/**/memory/*.md` |
| 2. Chunking | one node per entity (function, class, heading, task, skill, workflow step); text = label + source excerpt ≤ 2,000 chars | one doc per capability version: `name | description | body` cut at 8,000 chars ([`config/retrieval.yaml:6`](../../config/retrieval.yaml:6)) | one memory = one sentence; one summary = 6 fields |
| 3. Embedding / index | SKILLRET 0.6B, 1,024-d, L2, cosine; RAM matrix per project + pgvector HNSW; GIN `tsvector` on labels | same model; RAM matrix; skillret instruction prefix | same model; pgvector HNSW + GIN `tsv` |
| 4. Retrieval | seeds: lexical tiers × IDF (graphify, max 3) ∪ embedding top 10 ≥ floor; BFS depth 2, hub cut-off max(50, p99); rank by seed score × hop decay 0.5^hop × confidence weight | dense 50 + keyword 50 → RRF k = 60 (`keyword_rrf_weight = 0`) → rerank top 20 (`rerank_weight = 0`, sigmoid) → k = 5 ([`config/retrieval.yaml:2-7`](../../config/retrieval.yaml:2), unchanged) | RRF of `tsvector` and pgvector, K = 60, 100 per leg → score × 0.5^(age / 30 d) × (1 + ln(1 + distinct reinforcement days)) → top k |
| 5. Assembly | one line ≤ `graph_push.max_chars`; MCP text ≤ 2,000 tokens with a truncation footer | the skill name goes into the line; full content via `get_capability` | ≤ 10,000 chars, fixed drop order; MCP index rows ≈ 50–100 tokens |
| 6. Evaluation | contextbench, mulocbench, `graph.query.test.ts` | skillret (NDCG@10, Recall@5) | new `memory.md` (Recall@5) |

---

## Part D. Tasks, decisions, open items

### D1. Tasks

Strict phase order; `[P]` = can run in parallel inside its phase. Each task ends with its named test green.

**Phase 0: safety net (Python still serves)**
- [ ] T0.1 Record fixtures: `/v1/search` top-5 for 200 prompts, graph `query` / `affected` answers for 30 questions, `/api/*` reply shapes. → `fixtures/`.
- [ ] T0.2 Latency + skillret baselines on the Python daemon. → `specs/006-merged-core/baseline.json`.
- [ ] T0.3 Archive `decisions` + `events` to `jsonl.gz`.

**Phase 1: workspace and shared**
- [ ] T1.1 pnpm workspace, Node 24, TS strict, Vitest, ESLint (SQL import ban), Zod env from `config/*.yaml`.
- [ ] T1.2 Migrations: baseline of today's kept tables + new tables/columns (C0) + `ctc migrate --from-python`. → migration on a copy = expected row counts.
- [ ] T1.3 `[P]` Repositories per domain with `ctx`. → `tenancy.test.ts`.
- [ ] T1.4 `[P]` Cache (L1, L2, epochs, `ctc:inval`), queues (7, payload Zod, `dlq-retry`). → unit tests.

**Phase 2: context graph (graphify)**
- [ ] T2.1 `core/graph/ids` + extract with web-tree-sitter (ts, tsx, js, python, bash, sql, json) + markdown parser. → `graph.ids.test.ts`.
- [ ] T2.2 Cross-file resolve + incremental rebuild + content-hash cache + shrink guard; `graph` queue. → `graph.resolve`, `graph.incremental`.
- [ ] T2.3 Port ctc context parsers + doc extract job; skill / agent / command / workflow nodes and their edges (`uses`, `calls`, `serves`, `implements`, `references`).
- [ ] T2.4 Query, explain, path, affected, neighbors + MCP tools + `/api/graph/*`. → `graph.query.test.ts`.

**Phase 3: skill library (Langfuse)** `[P]` with Phase 4
- [ ] T3.1 Scanner → versions (advisory lock, labels, manifest + blobs) + `library` queue (`changed` → embed, enrich, dedup, graph node).
- [ ] T3.2 MCP `get_capability`, `load_capability_resource`; `/api` versions, labels, restore; overrides pin by label/version. → `library.*` tests.
- [ ] T3.3 Port SKILLRET dense + rerank channel to `packages/core`. → `suggest.skills` (skillret gate).

**Phase 4: memory (claude-mem)** `[P]` with Phase 3
- [ ] T4.1 `hooks/spool.sh` + drain (boot, watch, 30 s sweep, corrupt dir) + `/v1/spool/nudge`. → `memory.spool.test.ts`.
- [ ] T4.2 `llm.extract` (port bands) + `llm.summarize` (new) + retry-once-then-drop + content hash + reinforcement days. → `memory.idempotent.test.ts`.
- [ ] T4.3 RRF recall + `/v1/hook/start` fit-by-measuring + MCP `mem_search / mem_timeline / mem_get / save_memory`; memory-file watcher; history → `distill`. → `memory.context.test.ts`, `memory.recall`.

**Phase 5: suggestion from the graph**
- [ ] T5.1 `/v1/hook/prompt` + `/v1/suggest`: seeds (lexical ∪ embedding ∪ skill channel), walk, rank, render, `sug:` cache. → `suggest.latency`, `suggest.context`.
- [ ] T5.2 `/v1/hook/pre`: file note + search hint (caps, quiet window). → `failopen.test.ts`.

**Phase 6: workflows (Orca)**
- [ ] T6.1 Transition table + attempts + stages + `idempotency_keys`. → `runner.lifecycle.test.ts`.
- [ ] T6.2 Worktree recipe + `ctc.yaml setup:` + agent registry (`claude`, `codex`) + stream-json status + step report endpoint with token. → `runner.crash.test.ts`.
- [ ] T6.3 Gate options + resolution injection; `fanout` + join nodes (BullMQ Flow, depth 1); handoff action; cleanup job. → `runner.fanout.test.ts`, [`.claude/metric/eval/runner.md`](../../.claude/metric/eval/runner.md).

**Phase 7: switch over**
- [ ] T7.1 Point [`.claude/settings.json`](../../.claude/settings.json) hooks at the new routes + spool script; stop the Python daemon. → all C7 gates on the new stack.
- [ ] T7.2 Delete the Python server, storage, runner, ingestion, ai, memory, retrieval, decision, graph and [`src/ctc/cli.py`](../../src/ctc/cli.py); keep `evaluation/` (calls `/v1/suggest`); retire [`.claude/metric/eval/adoption.md`](../../.claude/metric/eval/adoption.md). → [`.claude/metric/eval/ci.md`](../../.claude/metric/eval/ci.md) green.

### D2. Decisions needed (defaults in bold, used everywhere above)

1. **Drop ClickHouse (yes).** Without decisions/events there is no telemetry volume to justify it. Bring it back only if raw tool-use capture (claude-mem `tool_uses`) is wanted later.
2. **SQL layer: Kysely on `pg`.** Langfuse uses Prisma 6; Prisma adds codegen and its own migration engine.
3. **Memory extraction stays local (llama-server).** The alternative is claude-mem's Haiku observer per tool use (better observations, but a paid API call per tool use).
4. **Model output format: keep llama.cpp JSON grammar**, plus claude-mem's retry policy. Switch to claude-mem's XML parser only if the grammar proves flaky.
5. **Per-prompt line content: task → file:symbol · skill · decision.** At most one of each, capped at `graph_push.max_chars`. Memories are not in the line; they are injected at SessionStart.
6. **Agents in workflows: `claude` and `codex` only.** Orca's other 38 CLIs are added on demand.
7. **Fan-out concurrency: 3 children at once, depth 1.**
8. **Worktree retention: 7 days after the run, branch kept forever.**
9. **Local supervisor: `systemd --user`.**

### D3. Open items and unverified points

- `[UNVERIFIED]` graphify 0.9.97 (clone) behaves like the 0.9.93 we read. Check: diff `extract.py` / [serve ↗](https://github.com/Graphify-Labs/graphify/blob/b90b9df7949bd04a15b40a1624af85d0a9cfdf04/graphify/serve.py) before T2.1.
- `[UNVERIFIED]` today's runner reads `claude -p` stream-json events and leaves finished worktrees on disk. Check: [`src/ctc/runner/proc.py`](../../src/ctc/runner/proc.py), [`src/ctc/runner/engine.py:445-500`](../../src/ctc/runner/engine.py:445) before T6.2.
- `[UNVERIFIED]` web-tree-sitter WASM grammars give the same node spans as graphify's native tree-sitter 0.25. Proof: `graph.ids.test.ts` (T2.1).
- `[UNVERIFIED HYPOTHESIS]` the prompt hook fits in 140 ms with three seed channels + BFS in Node. Proof: T5.1 latency gate. Fallback: drop the lexical channel on cold misses.
- Not read: graphify's 35 extractors beyond markdown and [resolution ↗](https://github.com/Graphify-Labs/graphify/blob/b90b9df7949bd04a15b40a1624af85d0a9cfdf04/graphify/extractors/resolution.py); Langfuse UI, evals, ClickHouse queries; claude-mem `ChromaMcpManager`, CloudSync, viewer; Orca renderer, mobile, relay, ACP. None are on the 006 path.
- Project docs (`CLAUDE.md`, `PLAN.md`, older specs) were deleted on 2026-10-30. Their decisions (Python core, route/bundle, adoption KPI) are superseded by this spec once approved.
- `specs/005-ts-backend` was deleted on 2026-10-30; its two "ctc today" graphs moved here as `today-*`.

### D4. Sources

| Source | Pin | Research file |
|---|---|---|
| graphify | installed `graphifyy` 0.9.93 + clone `0a8cd4e1` (0.9.97) | [research/graphify.md](research/graphify.md) |
| Langfuse | `5cb204754430fb77f3f7d830c651e5be7e4ad7f6` (v4.72.0) | [research/langfuse.md](research/langfuse.md) |
| claude-mem | `325afb60108d4ab04e24d715f244bd591ca33fbe` (v15.7.0) | [research/claude-mem.md](research/claude-mem.md) |
| Orca | `2c4eb87240a24a0dc83de82db075aa81eb3457a2` (v1.4.214) | [research/orca.md](research/orca.md) |
| ctc | `a244268` | [`src/ctc/server/hooks.py:41,96-129,174-398`](../../src/ctc/server/hooks.py:41), [`src/ctc/server/app.py:60-150`](../../src/ctc/server/app.py:60), [`src/ctc/server/jobs.py:20-31,104`](../../src/ctc/server/jobs.py:20), [`src/ctc/server/writer.py:27-93`](../../src/ctc/server/writer.py:27), [`src/ctc/runner/engine.py:58,445-500`](../../src/ctc/runner/engine.py:58), `graph/*.py` (module docstrings), [`src/ctc/memory/longterm.py:23,93-125`](../../src/ctc/memory/longterm.py:23), [`src/ctc/ai/extract.py:20-65`](../../src/ctc/ai/extract.py:20), [`src/ctc/storage/schema.sql:22-283`](../../src/ctc/storage/schema.sql:22), [`config/retrieval.yaml:2-12`](../../config/retrieval.yaml:2), [`config/models.yaml:4-5`](../../config/models.yaml:4), [`config/server.yaml:1-21`](../../config/server.yaml:1) |
