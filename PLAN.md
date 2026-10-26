# claudethecaller Plan

**Goal:** a local router that predicts what a coding agent needs from project memory and the live session, and hands Claude an explainable bundle (workflow → ordered skills → subagents → difficulty and model tier) through one MCP tool plus a prompt hook, managed by a CLI and a dashboard.

**Architecture:** warm Python daemon(s) do routing, deciding and memory. One database: Supabase Postgres (tables, pgvector for vectors, full-text search for keywords) is the only source of truth. One cache: Redis 8 (shared hot state, semantic cache, write queue), in front of a small in-process L1; losing Redis loses speed, never data. Local engines: TEI (embed/rerank), llama.cpp (local LLM). The hook is a `curl` one-liner; MCP and the dashboard are served by the same daemon. LLMs never run on the per-prompt path. Two run modes: **local** (one daemon on the coder's machine, default) and **shared** (N stateless daemon workers behind a proxy, one Redis, one Supabase, for teams).

---

## Product

- **Problem:** agents rarely call installed skills/workflows/subagents; the user has to type `/plugin:skill`. No record of why a capability was or wasn't used.
- **Evidence:** owner's history (319 sessions, 2026-10-20): ~10,000 tool calls, 52 `Skill` calls (~0.5%), 17 distinct skills of 300+ installed. SRA-Bench (2026) sees the same.
- **Users:** coders with large skill libraries. Portfolio project, so built from scratch (ratel, MCPGateway, metamcp are references only).
- **Success:** after install, the Skill/Agent share of tool calls rises well above 0.5%; Recall@5 ≥ 0.90; latency targets hold.
- **In scope (Claude Code only):** index, hybrid search + rerank, decider, prefetch, cache, long-term memory, MCP tool + suggest-only hook, CLI, dashboard, benchmark; local mode and self-hosted shared mode (API keys, rate limits) for coders anywhere; workflow runner (m5): run saved workflows locally, one at a time, on each user's own Claude login; context + coding graph (m6): specs, tasks and decisions linked to graphify's code graph and pushed into the session.
- **Out of scope:** other agents, blocking the agent, billing / sign-up SaaS, marketplace, training models from scratch; running workflows on someone else's subscription or as a hosted service (Anthropic terms).

## Stack

| Part | Stack |
|---|---|
| Embed + rerank | TEI (Docker): `ThakiCloud/SKILLRET-Embedding-0.6B` (1024-dim) on `:18300`, `BAAI/bge-reranker-v2-m3` on `:18301` |
| Local LLM (offline only) | llama.cpp `llama-server` on `:18302`, `Qwen2.5-3B-Instruct` Q4_K_M; Claude API only when `ANTHROPIC_API_KEY` is set |
| Database | Supabase project `claudethecaller` (`iecwnlyqjbigeiobmurn`, ap-southeast-1): Postgres 17 + pgvector (HNSW, cosine) + full-text search with `unaccent`; tables in schema `ctc`; Python `psycopg[binary]` + `pgvector`; IPv4 session pooler, `CTC_DATABASE_URL` in `.env` |
| DB driver | `psycopg[binary,pool]` async: `AsyncConnectionPool` (min 1, max 5 per worker), `prepare_threshold=None`; session pooler in both modes (each connection sets `search_path`, `hnsw.ef_search`, `statement_timeout`, which the transaction pooler would drop) |
| Cache | Redis 8 (`redis:8.2`, Query Engine built in) on `127.0.0.1:18303`, `--maxmemory 256mb --maxmemory-policy allkeys-lru --save "" --appendonly no`; client `redis[hiredis]` (`redis.asyncio`); `CTC_REDIS_URL` in `.env` |
| Daemon | Python 3.12, FastAPI + `uvicorn[standard]` (uvloop, httptools), `orjson` responses, official `mcp` SDK 2.x (`MCPServer`, formerly FastMCP); local: Unix socket `~/.claudethecaller/ctc.sock` + `127.0.0.1:18310`; shared: `:18310` only, N workers |
| HTTP clients | one `httpx.AsyncClient` per model server for the daemon's life (keep-alive), 2 s timeout |
| Hook | `curl` one-liner, fail-open |
| Benchmark + training | `ranx`, `datasets`, scikit-learn |
| CLI | `typer` |
| Dashboard | TypeScript: React + Vite + Recharts + React Flow |
| Packaging | `uv`, `pnpm`, `docker-compose.yml` |
| Workflow runner | `src/ctc/runner/` asyncio walker in the daemon. Agent node = the pinned `claude -p` on the user's login; Shell node = `bash -c`; one git worktree per run under `~/.claudethecaller/runs/<id>/wt` |
| Scheduling | `croniter` 6.2.4 (the only new Python dependency) |
| Run logs | `~/.claudethecaller/runs/<id>/<node>-<visit>.jsonl.gz` |
| Container mode (M6) | Docker image `ctc-runner:<claude_version>` (Node base plus the pinned Claude Code CLI) |

## Constraints

- Local models ≤ 3B; our GPU use ≤ 7 GB (shared host): sum of `nvidia-smi --query-compute-apps` over this project's `docker compose top` PIDs.
- Hook adds ≤ 150 ms and fails open (daemon down → empty output, exit 0).
- Routing p95 ≤ 10 ms on L1 hit (daemon RAM), ≤ 15 ms on L2 hit (Redis), ≤ 150 ms cold (one SQL round trip to Singapore is ~65 ms).
- Redis is a cache, never a source of truth: every key has a TTL or is rebuildable from Supabase; every Redis call has a 20 ms timeout and fails open (Redis down → L1 + DB, writes go straight to the DB).
- Models run locally; capabilities, decisions and memories live in Supabase; benchmark data in `data/` stays local; `Llm.json` strips secrets from every LLM call; the DB password lives only in `.env`.
- IDs are namespaced: `plugin:name`, `user:name`, `project@<sha8>:name`. Claude-facing names use `invoke` (`name` for user/project, else the id).
- Any prompt language.
- Rules while building: stay in the step's scope; no secrets, `.env`, `data/` or weights in commits; never write the real `~/.claude/` until H3 (use a temp `HOME`), except m5 runner child processes, which use the real login; if only the owner can unblock it, say so and stop.
- Workflow runner (m5): subscription only, local-only execution, never re-execute a side effect; full list in "Workflow runner (m5) → Constraints".

## Files

```
claudethecaller/
├── config/
│   ├── models.yaml            # TEI / llama-server URLs, model ids, embedding dim, LLM spec
│   ├── retrieval.yaml         # candidate depth, RRF k, rerank_top, abstain τ, memory weights (K2 writes tuned values here)
│   └── server.yaml            # mode (local|shared), ports, cache TTLs + thresholds, rate limit
├── data/                      # gitignored
│   ├── raw/                   # downloaded SkillRet, MetaTool
│   ├── processed/             # own-eval.jsonl, own-eval-review.csv, own-eval-memories.jsonl
│   └── reports/               # benchmark reports
├── models/                    # gitignored: difficulty.joblib, fine-tuned embedder
├── src/ctc/
│   ├── config.py              # loads config/*.yaml + .env (env vars override)
│   ├── cli.py                 # `ctc`
│   ├── ingestion/
│   │   ├── scanner.py         # scan skills/agents/commands/workflows      (done)
│   │   └── indexer.py         # embed capabilities into the DB
│   ├── embedding/
│   │   └── embedder.py        # TEI embedder client                         (done)
│   ├── storage/
│   │   ├── schema.sql         # tables + indexes, schema `ctc`
│   │   ├── store.py           # Postgres CRUD, vector + keyword queries
│   │   └── cache.py           # L1 (in-process LRU) + L2 (Redis): keys, semantic cache, write stream, invalidation
│   ├── retrieval/
│   │   ├── hybrid.py          # dense + FTS → RRF → filters → rerank → abstain
│   │   └── gate.py            # calibrated abstain gate (features + joblib model from K2)
│   ├── reranking/
│   │   └── reranker.py        # TEI reranker client                         (done)
│   ├── decision/
│   │   └── bundle.py          # Bundle, decide(), difficulty model loading
│   ├── memory/
│   │   ├── session.py         # project profile, session state, prefetch + semantic cache
│   │   └── longterm.py        # long-term memory store
│   ├── llm/
│   │   └── client.py          # Llm + redaction + llm_from_env               (done)
│   ├── ai/                    # later
│   │   ├── enrich.py          # enrichment + dedup
│   │   └── extract.py         # memory extraction
│   └── server/
│       ├── state.py           # State: store, cache, model clients, llm; one per worker
│       ├── app.py             # FastAPI app, socket + :18310, lifespan, shared-mode auth
│       ├── hooks.py           # /v1/hook/*, /v1/route, /v1/search, follow tracking
│       ├── writer.py          # Redis stream → Postgres batch writer (direct write when Redis is down)
│       ├── jobs.py            # job table + Redis job stream + the one-at-a-time LLM worker
│       ├── mcp.py             # MCPServer find_capabilities
│       ├── api.py             # /api/*: projects, overview, decisions, sessions, index, jobs, keys
│       └── library.py         # /api/*: capabilities CRUD, overrides, dedup, memories CRUD
├── evaluation/
│   ├── loaders.py             # SkillRet, MetaTool
│   ├── label.py               # transcript labeler
│   ├── retrieval_eval.py      # ranx metrics, tuning sweep, report
│   └── latency_eval.py        # route p95 replay
├── scripts/
│   ├── check_models.py        # smoke-run embed / rerank / LLM          (done)
│   ├── check.sh               # the CI checks, run before every push
│   ├── deploy_local.sh        # CD to this host: pull, build, restart the daemon
│   ├── train_difficulty.py    # A2
│   └── finetune_embedder.py   # A4
├── dashboard/                 # React + Vite (TS)
├── tests/                     # later, owner-guided
├── .github/                   # ci.yml (required checks), release.yml (CD), dependabot.yml, PR template
├── docker-compose.yml
├── pyproject.toml             # uv, src layout
├── .env                       # CTC_DATABASE_URL, CTC_REDIS_URL (gitignored)
├── CLAUDE.md
└── PLAN.md
```

A subfolder is created by the step that first puts code in it; no empty folders ahead of time.

## Git workflow and CI/CD

- **Branches:** `main` = releases (tags `vX.Y.Z`), `staging` = integration. Work branches are named after the PLAN step or milestone (`b9-history-import`, `m2-agent-integration`, `ci-cd`), cut from `staging`, PR into `staging`.
- **PRs:** title is a conventional commit, `type: subject` with type in `feat fix docs perf test chore ci refactor` (checked by `pr-title`; after fixing a title, re-run the job). Fill the template (Summary / PLAN step / Checks run / Risks). Run `scripts/check.sh` before pushing. Squash-merge into `staging` (the title becomes the commit); `staging` → `main` uses a merge commit, never squash, so the two never diverge.
- **Required checks** on `staging` and `main` (`.github/workflows/ci.yml`): `lint-test` (ruff, pytest, import smoke), `db-selfchecks` (store/cache/bundle self-checks on pgvector pg17 + Redis 8.2 service containers), `dashboard` (pnpm build), `secret-scan` (gitleaks), `pr-title`. Model servers need a GPU, so search quality stays with the Done-when commands and K steps on this host.
- **CD** (`.github/workflows/release.yml`): every push to `staging` uploads the wheel, sdist and dashboard tarball as a workflow artifact; a `vX.Y.Z` tag publishes them as a GitHub Release with generated notes (fails if the tag ≠ the pyproject version or the commit is not on `main`).
- **Release:** 1) `uv version X.Y.Z` in a `chore: release vX.Y.Z` PR into `staging`; 2) PR `staging` → `main`; 3) `git tag vX.Y.Z origin/main && git push origin vX.Y.Z`.
- **Deploy to this host:** `scripts/deploy_local.sh` in the main checkout (on `main`, or `staging` to preview): `git pull --ff-only`, `uv sync --frozen`, dashboard build, daemon restart.
- **Dependabot:** weekly PRs into `staging` for GitHub Actions, dashboard npm and uv, 2–3 open at most per ecosystem, titled `ci(deps): …` / `chore(deps): …`.

---

## Build order

Four tracks. H = owner step. Commit after each step.

**Order:** F3 → F4 (done first, on mock data) → H0 → B3 → B4 → K1 → F1 → H1 → K2 → H2 → B4b → B5 → B6 → F2 → H3 → K3 → A1, A2 → B7 → B8 → A3 → B9 → H4 → K4 → F3 → F4 → H6 → F5.

**Branches:** `m1-retrieval-core` (B1–B4, K1–K2, F1), `m2-agent-integration` (B4b, B5–B6, F2, K3), `m3-memory` (B7–B8, A3, K4), `m4-dashboard` (F3–F5), `m5-runner-core` (all of m5, one commit per milestone; see "Workflow runner (m5)"), `m6-graph` (G1–G7; see "Context + coding graph (m6)"), `ai-<name>` per AI step; PR into `staging` at the end of each (see Git workflow and CI/CD).

### Done

- [x] **B1** — uv package + capability scanner (`src/ctc/ingestion/scanner.py`, 632 capabilities).
- [x] **B2** — model servers (`docker-compose.yml`) + clients (`embedding/embedder.py`, `reranking/reranker.py`, `llm/client.py`), ~6.4 GB GPU; check with `uv run python scripts/check_models.py`.
- [x] **B2b** — Supabase project `claudethecaller` created; pgvector 0.8.2, unaccent, pg_trgm available.

### Backend — API + databases

- [ ] **H0** — owner puts the session-pooler connection string (Supabase dashboard → Connect → Session pooler) in `.env` as `CTC_DATABASE_URL`.

- [x] **B3 — schema, store, indexer**
  - `pyproject.toml`: drop `usearch`; add `psycopg[binary,pool]`, `pgvector`, `python-dotenv`. `[project.scripts] ctc = "ctc.cli:app"`. Create `config/models.yaml`, `config/retrieval.yaml` and `src/ctc/config.py` (`yaml.safe_load` + `python-dotenv`, env vars override).
  - `src/ctc/storage/schema.sql` (idempotent, applied by `Store.__init__`):
    - `create extension if not exists vector with schema extensions; create extension if not exists unaccent with schema extensions; create schema if not exists ctc;`
    - `ctc.unaccent_i(text)`: `language sql immutable` wrapper around `extensions.unaccent('extensions.unaccent', $1)`, so it can feed a generated column.
    - `ctc.capabilities(id text pk, kind, name, namespace, invoke, description, body, path, hash, summary, triggers text[], enricher_version, cluster_id, updated_at)` + `tsv tsvector generated always as (to_tsvector('simple', ctc.unaccent_i(name || ' ' || description || ' ' || coalesce(summary,'') || ' ' || array_to_string(coalesce(triggers,'{}'), ' ')))) stored`, GIN index on `tsv`. (`'simple'` = no stemming, works for any language; wrap the concat in an immutable SQL helper if Postgres rejects `array_to_string` in a generated column.)
    - `ctc.cap_vectors(cap_id text references ctc.capabilities on delete cascade, text_hash text, model text, embedding vector(1024), primary key (cap_id, text_hash))` + `hnsw (embedding vector_cosine_ops)`.
    - `ctc.projects(id text pk /* sha256(cwd)[:8] */, user_id, name, path, profile_hash, embedding vector(1024), created_at, last_active, unique (user_id, name))`.
    - `ctc.overrides(user_id, project text /* project id or '*' */, cap_id, action check in ('pin','block','disable'), at, pk (user_id, project, cap_id))`.
    - `ctc.sessions(id text pk, user_id, project_id references ctc.projects on delete cascade, title, model text default '', started_at, ended_at, turns int default 0, tokens bigint default 0)`; `ctc.events(id bigserial, session_id references ctc.sessions on delete cascade, type, payload jsonb, at timestamptz default now())`.
    - `ctc.decisions(id bigserial pk, user_id, session_id references ctc.sessions on delete cascade, project_id, ref, prompt, abstained bool, followed bool default false, confidence real, difficulty, model_tier, latency_ms real, bundle jsonb /* steps */, stages jsonb /* StageRow[] */, at timestamptz default now(), unique (session_id, ref))` + index `(user_id, project_id, at desc)`.
    - `ctc.memories(...)` (see Memory design; `kind check in ('preference','convention','fact','skill_outcome')`, `scope check in ('global','project')`, `project_id` null for global) with its own HNSW index; `ctc.dedup_review(id bigserial, a, b, similarity real, status check in ('open','merged','kept_apart'))`; `ctc.jobs(id uuid pk, user_id, kind, status, progress real, payload jsonb, result jsonb, error, created_at, updated_at)`.
    - `alter table … enable row level security` on every table (no policies: only the `postgres` role, which bypasses RLS, can touch them).
  - `unique (session_id, ref)` lets follow updates target `ref` before the row's id is known; `ctc.api_keys(id, key_hash text unique, user_id text, name, created_at, revoked_at)` for shared mode; every per-user table gets `user_id text not null default 'local'`. The stream writer applies kinds in order sessions → decisions → events → followed, so FKs always resolve.
  - `src/ctc/storage/store.py` — `class Store(dsn: str, schema: str = "ctc")`, async: `AsyncConnectionPool(dsn, min_size=1, max_size=5, kwargs={"autocommit": True}, configure=...)` where `configure` runs `register_vector_async(conn)` and `set search_path to <schema>, extensions`. Every method is one SQL statement:
    - `upsert(caps, namespaces) -> Diff`: `insert … on conflict (id) do update … where capabilities.hash <> excluded.hash returning id, (xmax = 0) as inserted` → added/changed; `delete … where namespace = any(%s) and not (id = any(%s)) returning id` → removed.
    - `candidates(qv, query, k=50) -> (dense, sparse)`: one round trip, two CTEs. Dense: `select cap_id, max(1 - (embedding <=> %s)) from (select … order by embedding <=> %s limit k*4) group by cap_id order by 2 desc limit k`. Sparse: tokens = `re.findall(r"\w+", query)` joined with ` | `, `to_tsquery('simple', ctc.unaccent_i(%s))`, ranked by `ts_rank_cd`; blank query → no sparse rows.
    - `overrides(project)`, `set_override(project, cap_id, action)`, `set_enrichment(cap_id, e, version)`, `set_cluster(cap_id, cluster_id)`, `library_version()` (`md5(string_agg(id || hash, ',' order by id))`), `get(cap_id)`.
  - `src/ctc/ingestion/indexer.py` — `async build_index(store, embedder) -> int`: per capability the texts are `"{name}: {description}"` (+ summary) and each trigger; `text_hash = sha256(model + text)`; read existing `(cap_id, text_hash)` pairs, embed only the missing ones in batches of 32 with `embedder.embed(texts, "doc")`, `executemany` insert, delete pairs no longer current. `__main__` (`python -m ctc.ingestion.indexer`): load config, `scan_library(default_roots(Path.cwd()))` → `upsert` → `build_index` → print vector count.
  - **Done 2026-10-21**: on the local dev Postgres (`ctc-dev-pg`) until H0: schema `ctc` holds 635 capabilities / 6,344 vectors; `uv run python -m ctc.storage.store` self-check passes.

- [x] **B4 — hybrid search** (`src/ctc/retrieval/hybrid.py`)
  - `Ctx(store, embedder, reranker, project)`; `Hit(cap_id, score, stages: dict)`; `SearchResult(hits, abstained, ms, dropped)`.
  - `rrf(rankings, k=60)`: `score[id] += 1 / (k + rank)`, ranks 1-based.
  - `async search(q, ctx, qv=None)`, with k, candidate depth, rerank_top and abstain τ read from `config/retrieval.yaml` (start: 5, 50, 20, 0.3):
    1. `qv = qv or embed([q], "query")[0]`; `dense, sparse = store.candidates(qv, q, 50)`.
    2. `rrf([dense ids, sparse ids])`.
    3. Drop `block`/`disable` overrides and capabilities from other projects' namespaces (record each in `dropped` with the reason); keep only the best-ranked member of each `cluster_id`.
    4. Rerank the top 20 with `reranker.score(q, ["{name}: {description}"])`, sort by it, move `pin` overrides to the front.
    5. Best rerank < `abstain_below` → `abstained=True, hits=[]`; else top k. `ms` holds `time.perf_counter` timings per stage.
  - `__main__`: `python -m ctc.retrieval.hybrid "<query>"` prints the top 5 as JSON.

- [x] **B4b — cache** (`src/ctc/storage/cache.py`, see Cache design)
  - `docker-compose.yml`: add `redis` (`redis:8.2`, `127.0.0.1:18303:6379`, flags from the Stack table; no GPU). Check `redis-cli -p 18303 MODULE LIST` shows `search`; if the pinned image lacks it, pin the newest 8.x that has it and record the tag in CLAUDE.md.
  - `pyproject.toml`: add `redis[hiredis]`. `config/server.yaml`: mode, ports, every TTL and threshold in Cache design.
  - `class Cache(url, cfg)`: `redis.asyncio.from_url(url, socket_timeout=0.02, socket_connect_timeout=0.05)`; L1 = `OrderedDict` LRU (256 per namespace). Methods: `get_json/set_json(key, value, ttl)` (L1 then L2), `get_vec/set_vec` (float32 bytes), `semantic_get(qv, libv, project) / semantic_put(qv, libv, project, bundle)`, `enqueue(kind, row)` (stream), `invalidate(scope)` (publish). Any Redis error → log once per 10 s, mark down for 10 s, behave as L1-only (`# ponytail:` crude breaker, a real one if flapping shows up).
  - On startup `FT.CREATE ctc_sem …` (ignore "Index already exists").
  - `__main__` self-check (`python -m ctc.storage.cache`): asserts set/get round trip, semantic hit for a vector at cosine 0.99, miss for a different `libv`, and that with a bad URL every call returns `None`/no-op without raising.
  - **Done 2026-10-21**: Redis 8.2 with the search module; `uv run python -m ctc.storage.cache` self-check passes.

- [x] **B5 — daemon** (`src/ctc/server/`: `state.py`, `app.py`, `hooks.py`, `writer.py`, `jobs.py`, `mcp.py`, `api.py`, `library.py`; endpoints in API design, background work in AI integration flow)
  - Local mode: one FastAPI app served twice from one event loop: `asyncio.gather(uvicorn.Server(Config(app, uds=sock)).serve(), uvicorn.Server(Config(app, port=18310)).serve())`. Shared mode: `uvicorn ctc.server.app:app --port 18310 --workers N` (no socket).
  - Lifespan builds one `Ctx` per worker: async `Store` pool, `Cache`, long-lived `httpx.AsyncClient`s; starts the stream writer task and the invalidation subscriber; runs `mcp.session_manager.run()`.
  - `POST /v1/hook/prompt`: `ref = sha256(session_id + prompt)[:8]`; cache chain (Cache design: prefetch → semantic → embed cache → `search`); store the bundle under `bundle:{ref}`; `enqueue("decision", …)`; return text `[claudethecaller] Suggested: <invokes> — call find_capabilities(ref="<ref>") for the plan`, or empty when abstained. Any exception → empty 200.
  - `POST /v1/hook/tool`, `POST /v1/hook/stop`: `enqueue("event", …)`; follow tracking (B6). Return 204 immediately.
  - Stream writer: `XREADGROUP` group `writers`, consumer = hostname:pid, up to 100 entries or 1 s, one `executemany` per kind, then `XACK`; on start `XAUTOCLAIM` entries idle > 30 s (a crashed worker's). Redis down → `enqueue` writes straight to the DB as a FastAPI background task.
  - Shared mode auth middleware: `Authorization: Bearer ctc_…` → `sha256` → `key:{hash}` in cache (TTL 300 s) else `ctc.api_keys`; sets `request.state.user_id`; rate limit `INCR rl:{user}:{epoch_min}` + `EXPIRE 60`, over `rate_limit_per_min` → 429 (hooks: empty 200 instead). Local mode: `user_id = "local"`, no auth (socket file mode 0600, port bound to 127.0.0.1).
  - `/mcp`: `MCPServer("claudethecaller")` (mcp 2.x) with tool `find_capabilities(task, blocker=None, ref=None)`, mounted via `streamable_http_app()`; `session_manager.run()` inside the lifespan.
  - `/api/*`: dashboard endpoints from API design; each is one SQL query; writes call `cache.invalidate`.
  - Static `dashboard/dist` mounted at `/` once it exists.
  - **Done 2026-10-21**: `uv run ctc daemon status`: socket + `:18310` up, health db / redis / embedder / reranker / llm green, serves `/v1`, `/api`, `/mcp` and `dashboard/dist`.

- [x] **B6 — bundle** (`src/ctc/decision/bundle.py`)
  - `Step(order, cap_id, invoke, kind, agent, reason)`, `Bundle(intent, confidence, difficulty, model_tier, workflow, steps, memories, abstained)`.
  - `async decide(hits, ctx)`: if the top hit is a workflow, load its YAML and emit its declared steps in order; otherwise emit the skill/command hits in rerank order. Attach the best `agent` hit to the steps only if its rerank ≥ 0.5. `reason` = the rerank score plus the matched trigger or description snippet. `confidence` = top rerank. `difficulty = "standard"`, `model_tier = "sonnet"` until A2 exists.
  - `find_capabilities`: return `bundle:{ref}` (L1/L2) when `ref` hits and there is no `blocker`; otherwise `decide(search(task + blocker))`. Append "Use these in order; say why if you skip one."
  - Follow tracking in `/hook/tool`: `tool_name == "Skill"` → `tool_input["skill"]`; `Agent`/`Task` → `subagent_type`; if it equals a step's `invoke` or `agent` in `sess:{id}:last` → `enqueue("followed", {session_id, ref})` → the writer runs `update ctc.decisions set followed = true where session_id = %s and ref = %s`.
  - **Done 2026-10-21**: `uv run python -m ctc.decision.bundle` self-check passes; difficulty / model tier come from A2's model.

- [x] **B7 — session memory + prefetch** (`src/ctc/memory/session.py`)
  - `ProjectProfile`: sha256 of CLAUDE.md + `.claude/` memory files + package manifests + `.git/HEAD`; project vector = embed of the first 2,000 chars, cached in `ctc.projects(project, profile_hash, embedding)`.
  - `SessionState` in Redis so any worker can serve the next turn: `sess:{id}:turns` (`LPUSH` float32 bytes + `LTRIM 0 19`, TTL 6 h); mean computed in numpy from the ≤ 20 vectors; cosine(turn, mean) < 0.55 → `DEL` (topic shift). Redis down → L1 `deque(maxlen=20)` per session.
  - Project vector cached as `proj:{project_hash}` (TTL 1 d) in front of `ctc.projects`.
  - Query vector = normalize(0.6·prompt + 0.25·session + 0.15·project) → passed to `search(qv=…)`; the semantic cache (B4b) keys on this blended vector.
  - **Done 2026-10-21**: `uv run python -m ctc.memory.session` self-check passes.

- [x] **B8 — long-term memory store** (`src/ctc/memory/longterm.py`)
  - `Memory(id, scope, project, kind, text, confidence, pinned, source)`.
  - `async write_memory(m, ctx)`: embed; nearest live neighbour in scope (`order by embedding <=> %s limit 1`); ≥ 0.95 → NOOP (`use_count += 1`); `m.supersedes` set (by A3) → SUPERSEDE (old gets `deleted_at`); ≥ 0.85 → UPDATE (newer text, `confidence = min(1, max + 0.1)`); else ADD.
  - `recall(qv, ctx, k=5)`: one SQL computing `sim * (case when pinned then 1 else power(0.5, age_days / 30) end) * (1 + ln(1 + use_count))` over global + current-project rows, `deleted_at is null`.
  - `import_claude_memory(dirs)`: each `~/.claude/projects/*/memory/*.md` → one memory (`kind` from its frontmatter `type`, `source = {kind: "claude-memory", file}`), read-only.
  - **Done 2026-10-21**: `uv run python -m ctc.memory.longterm` self-check passes; live: 16 imported Claude memories + 36 extracted session memories.

- [ ] **B9 — Claude history import, distilled** (`src/ctc/ingestion/history.py`; design in "History import design")
  - The dashboard's sessions, decisions, KPIs, activity and memories come from the user's own Claude Code history in `~/.claude/projects`, not only from live hooks. Raw transcripts never leave the machine: Supabase keeps distilled knowledge (long-term memory), not logs.
  - Phase 1 `scan` (no LLM, seconds): changed transcript files → `history_files`, `projects`, `sessions` (structure only, `status = pending`), `events` (Skill / Agent / Task calls by name).
  - Phase 2 `distill` (local LLM, one background job per pending session): title + summary + one intent per typed prompt → replay each prompt through the router locally → `decisions` (`source = history`, `prompt` = the intent, `followed` from the transcript) → A3 memory extraction → `status = processed`.
  - Triggers: daemon start (incremental), `POST /api/history/import`, `ctc history import`, and `SessionEnd` (that session; also replaces live hook prompts with intents).
  - Done when: `ctc history import` on this host imports every main transcript, all sessions end `processed`, the dashboard Overview / Sessions / Memories show the user's real history with no raw prompt text stored in Supabase, and a second run changes nothing.
  - **Partial 2026-10-22** (this host, Supabase): 84/84 transcripts imported and distilled in ~6 min; 571 history decisions (intents only, no raw prompt text; one summary leak found and fixed, then 0 matches over 265 typed prompts); 14 followed = **2.5% pre-install adoption baseline**; 94 session memories + 316 outcome memories; a second run changes nothing. Open: phase 3 is not fully idempotent for 2 (project, capability) pairs (needs `write_memory(dedup=False)` for outcome rows); outcome memories are mostly "used 0 of n" (write only when used ≥ 1 and suggested ≥ 3); the 8 smoke-test sessions are still in Supabase; the `ctc history import` CLI path was not run on Supabase (the daemon job and `POST /api/history/import` were).

### Benchmark — measure the search

- [x] **K1 — datasets, labels, report**
  - `evaluation/loaders.py`: `load_dataset("ThakiCloud/SKILLRET", name, split="test")` for `skills`, `queries`, `qrels` → indexed into a separate schema `ctc_skillret` with the same `Store` + `build_index`; MetaTool reliability subset JSON from `github.com/HowieHwong/MetaTool`, cached in `data/raw/metatool/` (gold = none).
  - `evaluation/label.py`: user turns from `~/.claude/projects/**/*.jsonl` (skip `subagents/`, this repo's sessions, meta and tool-result rows, text starting with `<`); judge = `llm_from_env().json(...)` given the full catalog (`id: description[:100]`, ~16k tokens) → `{cap_ids: list[str], reason}`, ids not in the catalog dropped, empty = none. Split by `int(sha256(session_id), 16) % 2` (1 = test). Write `data/processed/own-eval.jsonl` and `data/processed/own-eval-review.csv` (200 test rows: `id,query,gold`).
  - `evaluation/retrieval_eval.py`: run `search()` per query in three modes (dense, hybrid, hybrid + rerank) → `ranx.Run`; `ranx.evaluate(qrels, run, ["recall@1", "recall@5", "recall@10", "ndcg@10", "mrr"])`; false-trigger rate = share of gold-none queries that did not abstain; p50/p95 per stage from `ms`. Write `data/reports/report-<date>.md` with each number next to its target (below). Baselines: SKILLRET-0.6B and bge-m3, dense-only.
  - **Done 2026-10-21**: 300 own rows labelled by the Qwen-3B judge (noisy until H1), SkillRet test 4,392 queries in `ctc_skillret`; final `data/reports/report-2026-10-21.md` (enriched library, shipped ranking, gate off): SkillRet test NDCG@10 dense 0.787 vs hybrid + rerank 0.773 (R@5 0.802 / 0.792); own test R@5 0.067; false-trigger 100% (no abstain). bge-m3 baseline skipped (no GPU budget).
- [ ] **H1** — owner hand-checks the 200 rows (`gold` column; `data/` stays local).
- [ ] **K2 — tune**: sweep `abstain_below` (0.05–0.9), candidate depth (25/50/100) and `rerank_top` (10/20/40) on dev rows; keep the best Recall@5 with false-trigger ≤ 10%; write the winners into `config/retrieval.yaml`. If Recall@5 stays < 0.90, do A1 (then A4). Measured on day one: `bge-reranker-v2-m3` absolute scores carry no signal for tool matching (right and junk matches both 0.001–0.04) and dense cosine is higher for chit-chat ("thanks", 0.58) than for real matches, so neither works as an abstain threshold; search currently orders by RRF(dense rank, rerank rank) with abstain off. K2 picks the abstain rule (e.g. a small classifier on dense/rerank/keyword features, calibrated on MetaTool + own no-capability rows) and tries `Qwen3-Reranker-0.6B` (instruction-aware) against bge.
  - **Partial 2026-10-21, blocked on H1**: false-trigger 100% (target ≤ 10%), so not done. **Gate rejected**. depth 50 / rerank_top 20 won on dev; the abstain classifier scored CV AUC 0.55 and is off (`models/abstain-2026-10-21-auc055.rejected.joblib`), so every prompt gets a suggestion; `ranking` knob tuned on dev to keyword 0.25 / rerank 1 (CLAUDE.md decisions); Qwen3-Reranker not tried (no GPU budget). Redo on H1 labels.
- [ ] **H2** — owner reads the report; PR `m1-retrieval-core` → `staging`.
- [x] **K3 — routing speed** (`evaluation/latency_eval.py`): replay dev prompts through `POST /v1/route` three times (cold: Redis flushed + L1 off; L2: L1 off; L1), `numpy.percentile` of wall time per tier + semantic cache hit rate → report.
  - **Done 2026-10-21**: 77 dev prompts through `/v1/route`: cold p95 105 ms, Redis (semantic) p95 6.9 ms, L1 p95 1.2 ms, all within target (dev DB, no Supabase hop yet); `data/reports/latency-2026-10-21.md`.
- [ ] **K4 — memory + adoption**: Recall@5 with vs without `recall()` memories in the query vector; extraction precision from H4's file; follow rate = `avg(followed::int)` over `ctc.decisions` since H3.

**Benchmark priority** (owner, 2026-10-22): SkillRet and MetaTool (clean, large) decide ranking and abstain tuning; own-transcript rows are a secondary in-domain check.

**Targets** (shown in the report): Recall@5 ≥ 0.90 (200 hand-checked rows) · hybrid + rerank NDCG@10 ≥ dense-only (SkillRet) · false-trigger ≤ 10% · GPU ≤ 7 GB · route p95 ≤ 150 ms cold, ≤ 15 ms Redis hit, ≤ 10 ms L1 hit · semantic cache hit rate reported · memory lift ≥ 0 · extraction precision ≥ 0.80.

### Frontend — CLI + dashboard

- [x] **F1 — CLI** (`src/ctc/cli.py`, typer): `ctc index` (= indexer main), `ctc search "<q>" [--json]`, `ctc explain "<q>"` (table: every hit and dropped item with dense rank, sparse rank, rrf, rerank, reason), `ctc status` (capability and vector counts from the DB, TEI `/health`, library version). `httpx.ConnectError` → `embedder unreachable at <url>` on stderr, exit 1; client timeouts 2 s. Built early: `status | caps | index | search | explain` run today on a local in-memory store (`src/ctc/storage/local.py`, vectors cached in `~/.claudethecaller/embeddings.npz`) until B3 swaps in Supabase in `open_ctx()`.
- [x] **F2 — daemon + install**: `ctc daemon start` = `subprocess.Popen([python, "-m", "ctc.server.app"], start_new_session=True)`, pid in `~/.claudethecaller/daemon.pid`; `stop` kills it. `ctc install` backs up `~/.claude/settings.json`, then adds (only if missing):
  ```
  UserPromptSubmit: LC_ALL=C curl -sf -m 0.15 --unix-socket $HOME/.claudethecaller/ctc.sock --data-binary @- http://ctc/v1/hook/prompt || true
  PostToolUse, Stop: same with /v1/hook/tool and /v1/hook/stop, -m 0.05
  ```
  and runs `claude mcp add --scope user --transport http claudethecaller http://127.0.0.1:18310/mcp` if `claude mcp get claudethecaller` fails.
  - **Done 2026-10-21**: `ctc daemon start|stop|status` run the live daemon; `ctc install|uninstall` checked against a temp `CTC_CLAUDE_HOME` (adds UserPromptSubmit, PostToolUse, Stop and SessionEnd; a second install changes nothing; uninstall removes only ours). The real `~/.claude` is H3.
- [ ] **H3** — owner runs the real `ctc install`, uses Claude Code for a day; PR `m2-agent-integration` → `staging`.
- [x] **F3 — dashboard shell** (`dashboard/`, Vite React TS): pages fetch `/api/*`. KPI cards (routing calls, adoption, lazy misses = suggested but not followed, p95, cost by tier; 7d/30d/90d/all), Recharts `AreaChart` timeline stacked by project, decision log table → drawer with the stage scores, activity heatmap as a CSS grid. `pnpm build` → `dist/`, served by the daemon. Built first, on mock data (`dashboard/src/mock.ts`) until B5 serves `/api`; `pnpm -C dashboard dev` → `:18320`.
- [x] **F4 — control views**: library (search, enable/disable/pin/block per project via `PUT /api/capabilities/{id}/override`, dedup review), sessions (project rail + per-session decisions and memories), memories (edit, pin, delete, supersede history). (mock data until B5.)
- [ ] **H6** — owner visual review.
- [ ] **F5 — workflow editor**: React Flow canvas with capability nodes from `/api/capabilities`; save → `POST /api/capabilities` with `kind: workflow` (writes `<project>/.claude/workflows/<name>.yaml`, then indexes it; see API design). PR `m4-dashboard` → `staging`.

### AI — later

- [x] **A1 — enrichment + dedup** (`src/ctc/ai/enrich.py`): `Enrichment(summary, triggers[8..12], prerequisites, inputs, outputs)`; `enrich(cap, llm)` = `llm.json(system prompt, name + description + body[:6000], Enrichment)`, at least 2 non-English triggers (validator, 1 retry); `enricher_version = sha256(prompt + schema + llm.spec)[:12]`; `python -m ctc.ai.enrich [--limit N]` enriches stale caps → `set_enrichment`, then dedup: for each doc vector, 5 nearest neighbours in SQL; union-find on pairs ≥ 0.92 → `cluster_id` = smallest id; pairs 0.85–0.92 → `ctc.dedup_review`; then `build_index`.
  - **Done 2026-10-21**: 630 of 635 capabilities enriched (5 keep failing the multilingual-trigger validator and are retried next run); vectors 635 → 6,344; dedup: 0 clusters ≥ 0.92, 19 pairs in `dedup_review`.
- [x] **A2 — difficulty / model tier**: `scripts/train_difficulty.py` labels dev prompts with `llm.json → {difficulty, model_tier}`, embeds them, fits two `LogisticRegression` models, `joblib.dump` → `models/difficulty.joblib`; `decide` loads it if present.
  - **Done 2026-10-21**: `models/difficulty.joblib` (difficulty + model_tier pipelines); `decide` loads it.
- [x] **A3 — memory extraction** (`src/ctc/ai/extract.py`): `extract_candidates(session_id, llm)`: redacted transcript → `llm.json → [{kind, scope, text, contradicts?}]`; `contradicts` → look up that memory and set `supersedes`; each goes through `write_memory`. `ctc memory backfill --sessions N` → `POST /api/memory/backfill` (the daemon writes).
  - **Done 2026-10-21**: backfill of 20 sessions: 36 memories written, 3 updated, 0 failed; Stop extracts at most once per session per 30 min, SessionEnd always does.
- [ ] **H4** — owner hand-checks 50 memories into `data/processed/own-eval-memories.jsonl`; below 0.80 precision → improve the A3 prompt and redo.
- [ ] **A4 — fine-tune** (`scripts/finetune_embedder.py`; only if Recall@5 < 0.90 after A1): sentence-transformers `MultipleNegativesRankingLoss` on SkillRet train `(query, skill text)` pairs + own dev rows, 1 epoch, gradient checkpointing, small batch to stay ≤ 7 GB; save to `models/` (gitignored), point TEI at it, re-embed (`model` changes → `build_index` rewrites every vector).

---

## Cache design (used by B4b, B5, B6, B7)

**Layers:** L1 in-process `OrderedDict` (per worker, ~µs) → L2 Redis (shared by all workers, ~0.3 ms local) → Supabase (truth, ~65 ms). Reads go down the chain and fill upward; writes go to the DB (or the stream) and then invalidate.

**Versioned keys instead of manual invalidation:** anything derived from the capability library includes `libv = library_version()`. Reindexing changes `libv`, so old entries are never read again and age out by TTL/LRU. The indexer sets `lib:v` and publishes `ctc:inval {"scope": "lib"}`.

| Key | Value | TTL | Written by | Read by |
|---|---|---|---|---|
| `lib:v` | current `library_version` | none (rebuildable) | indexer | every route (L1 copy refreshed on `ctc:inval`) |
| `emb:{model8}:{sha256(text)[:16]}` | query embedding, float32 bytes | 7 d | route | route (skips the TEI call) |
| `bundle:{ref}` | prefetched Bundle JSON | 1 h | `/v1/hook/prompt` | `find_capabilities(ref)`, `GET /v1/bundle/{ref}` |
| `sem:{ref}` (hash: `vec`, `libv`, `project`, `bundle`) | semantic cache entry | 24 h | route on a miss | route: `FT.SEARCH ctc_sem "(@libv:{$v} @project:{$p})=>[KNN 1 @vec $qv AS d]" … DIALECT 2`; hit when `d ≤ 0.05` (cosine ≥ 0.95) |
| `ovr:{user}:{project_hash}` | hash `cap_id → action` | 5 min | `PUT /api/capabilities/{id}/override` deletes it | search filters |
| `sess:{id}:turns`, `sess:{id}:last` | turn vectors; latest decision `{ref, invokes, agents}` | 6 h | `/v1/hook/prompt` | B7 blend, B6 follow tracking (no DB read) |
| `proj:{project_hash}` | project profile hash + vector | 1 d | B7 | B7 |
| `key:{sha256}` | `user_id` | 5 min | auth middleware | auth middleware |
| `rl:{user}:{epoch_min}` | request count | 60 s | auth middleware | auth middleware |
| `ctc:writes` (stream) | `{kind: decision|event|followed, row}` | `MAXLEN ~ 100000` | hooks | stream writer → Postgres |
| `ctc:inval` (pub/sub) | `{scope: lib|ovr|mem, user?, project?}` | n/a | indexer, `/api` writes | every worker drops matching L1 keys |

- Index: `FT.CREATE ctc_sem ON HASH PREFIX 1 sem: SCHEMA libv TAG project TAG vec VECTOR FLAT 6 TYPE FLOAT32 DIM 1024 DISTANCE_METRIC COSINE` (FLAT: the set is small and bounded by `maxmemory`; HNSW if it ever passes ~100k entries).
- TAG values are hex hashes only (`project_hash = sha256(cwd)[:8]`), so no TAG escaping is needed.
- Route chain in `/v1/hook/prompt`: L1/L2 `bundle:{ref}` (same prompt again) → embed (via `emb:` cache) → blend (B7) → semantic cache → `search` + `decide` → write `bundle:{ref}` + `sem:{ref}`.
- **Never cached:** memories' text across users, anything with `user_id` in a key shared across users, raw prompts outside `sem:`/`bundle:` (both expire). Shared mode adds `user_id` to `bundle:`, `sem:` (as a TAG) and `sess:` keys.

**Alternatives considered:** Valkey 8 (BSD, drop-in, but vector search needs the separate `valkey-search` module), Dragonfly (faster multi-threaded, BSL license, partial `FT.*`), Memcached (no vectors, streams or pub/sub), in-process only (no sharing between workers). Redis 8 wins because vector search, streams and pub/sub ship in one open-source (AGPLv3) binary.

## API design (used by B5, B6, F1–F5)

All JSON uses `orjson`. Errors: `{"error": {"code": "not_found", "message": "…"}}` with the matching status. Hooks never error: any failure → `200` with an empty body. Machine-facing routes are versioned (`/v1/…`) because hook commands live in users' `settings.json` and can't change in lock-step; `/api/*` ships with the dashboard and is unversioned.

### Routing (machine-facing, versioned)

| Method + path | Body / query | Returns | Budget |
|---|---|---|---|
| `POST /v1/hook/prompt` | Claude `UserPromptSubmit` JSON (`session_id`, `cwd`, `prompt`, `transcript_path`) | `text/plain` suggestion line or empty | ≤ 120 ms |
| `POST /v1/hook/tool` | Claude `PostToolUse` JSON (`session_id`, `tool_name`, `tool_input`) | `204` | ≤ 50 ms |
| `POST /v1/hook/stop` | Claude `Stop` JSON (`session_id`, `transcript_path`) | `204` | ≤ 50 ms |
| `POST /v1/route` | `{prompt, session_id?, cwd?, k?}` | `Bundle` | p95 targets in Constraints |
| `GET /v1/bundle/{ref}` | | `Bundle` or `404` | ≤ 10 ms |
| `POST /v1/search` | `{q, cwd?, k?, explain?: bool}` | `SearchResult` (`explain` adds per-hit dense/sparse rank, rrf, rerank and `dropped`) | |
| `/mcp` (streamable HTTP) | tool `find_capabilities(task, blocker?, ref?)` | text plan + structured `Bundle` | |
| `GET /v1/health` | | `{db, redis, embedder, reranker, llm, library_version, mode}` each `ok|down` | |

### Dashboard + CRUD (`/api`)

**Contract:** response shapes are `dashboard/src/types.ts` field for field; the Pydantic models in `src/ctc/server/api.py` mirror them, and `pnpm -C dashboard gen:types` (`openapi-typescript` on `/openapi.json`) replaces the hand-written types once B5 runs, so the two can't drift.

**Conventions:**
- `project` (query, body, and every response field) is the project **name**, which the dashboard uses as its key and colour index. Names are unique per user: `basename(cwd)`, suffixed `~2`, `~3` on collision. Rows store `project_id` (= `sha256(cwd)[:8]`) and join for the name.
- `range` = `7d|30d|90d|all` (`all` = since the first row; `delta` is then `null`). `q` = case-insensitive substring (`ilike`), on the fields named per endpoint.
- Lists return a **bare array**, newest first, `limit` default 200 (max 500); `before=<id>` loads the next page (keyset: `where id < %s`), never `offset`.
- Writes publish `ctc:inval` and drop the matching cache keys. Deletes are soft or move files to a trash dir; nothing user-authored is destroyed outright.

**Projects** (app sidebar)

| Method + path | Body / query | Returns | Notes |
|---|---|---|---|
| `GET /api/projects` | | `Project[]` `{id, name, sessions}` | `id` = `project_id`; `sessions` = count |
| `GET /api/projects/{name}` | | `Project` + `{path, decisions, memories, overrides, last_active}` | |
| `PATCH /api/projects/{name}` | `{name}` | `Project` | rename the display name; 409 if taken |
| `DELETE /api/projects/{name}` | | `{ok: true}` | forget the project: its sessions, decisions, events, project memories and overrides (FK cascade); files on disk untouched |

**Overview** (`Overview.tsx`)

| Method + path | Body / query | Returns | Notes |
|---|---|---|---|
| `GET /api/kpis` | `range`, `project?` | `Kpis` `{routing_calls, adoption_rate, lazy_misses, p95_ms, delta{4}, spark{4}}` | adoption = followed / non-abstained; lazy misses = non-abstained − followed; `delta` vs the previous window of equal length; `spark` = one value per day (`generate_series` left join decisions, `percentile_cont(0.95)`) |
| `GET /api/timeline` | `range`, `metric=calls|adoption|latency`, `project?` | `Timeline` `{days[], series[{project, values[]}]}` | adoption in %, latency = daily p95 ms; one series per project |
| `GET /api/activity` | `project?` | `Activity` `{days[84]{day, count}, active_days, streak, longest_streak, busiest, per_active_day}` | SQL returns 84 counts; streaks computed in Python |
| `GET /api/decisions` | `range`, `project?`, `q` (prompt or any step `cap_id`), `session_id?`, `followed?`, `abstained?`, `limit`, `before` | `Decision[]` `{id, at, session_id, project, prompt, abstained, followed, latency_ms, difficulty, model_tier, confidence, steps[], stages[]}` | `stages[]` = `StageRow{cap_id, dense_rank, sparse_rank, rrf, rerank, dropped}` for every hit **and** every dropped candidate, stored at route time |
| `GET /api/decisions/{id}` | | `Decision` | drawer deep link |
| `DELETE /api/decisions/{id}` | | `{ok: true}` | remove one stored prompt (privacy) |

**Capabilities: skills, agents, commands, workflows** (`Library.tsx`, F5)

| Method + path | Body / query | Returns | Notes |
|---|---|---|---|
| `GET /api/capabilities` | `project?`, `q` (id, description, triggers), `kind?`, `namespace?`, `override?`, `limit` | `Capability[]` `{id, kind, namespace, description, override, calls_30d, followed_30d, cluster_id}` | `override` = the project's override, else the all-projects one; `calls_30d` = decisions in 30 d whose steps contain the cap, `followed_30d` = those followed |
| `GET /api/capabilities/{id}` | `project?` | `Capability` + `{name, invoke, path, body, summary, triggers, editable, vectors, cluster_members[], recent_decisions[≤20]}` | `editable` = namespace is `user` or `project@…` |
| `POST /api/capabilities` | `{kind, scope: user|project, project?, name, description, body?, steps?}` | `201 Capability` | writes the file, then upserts + embeds that one cap: skill → `<root>/skills/<name>/SKILL.md`, agent → `<root>/agents/<name>.md`, command → `<root>/commands/<name>.md`, workflow → `<root>/workflows/<name>.yaml` `{name, description, steps: [{cap, agent?}]}` (F5 saves here); `root` = `~/.claude` or `<project path>/.claude`; `name` must match `^[a-z0-9][a-z0-9-]{0,63}$`; 409 if it exists |
| `PATCH /api/capabilities/{id}` | `{description?, body?, steps?}` | `Capability` | editable caps only; rewrites frontmatter + body; plugin caps → `403 read_only` ("managed by plugin <ns>; use an override") |
| `DELETE /api/capabilities/{id}` | | `{ok: true}` | editable caps only; moves the file to `~/.claudethecaller/trash/<utc-ts>/`, deletes the row (vectors cascade) |
| `PUT /api/capabilities/{id}/override` | `{project: string|null, action: pin|block|disable|null}` | `Capability` (updated) | `project: null` = all projects (stored as `'*'`); a project row beats `'*'`; `action: null` deletes the row |
| `POST /api/capabilities/{id}/enrich` | | `{job_id}` | A1, one cap |
| `GET /api/dedup` | `status=open|merged|kept_apart` | `[{id, a, b, similarity, status}]` | F4 dedup review, from `ctc.dedup_review` |
| `POST /api/dedup/{id}` | `{action: merge|keep_apart}` | `{ok: true}` | merge → both get `cluster_id` = the smaller id |

- File writes resolve the final path and refuse anything outside `root` (no traversal); until H3 the daemon's `HOME` is a temp dir (Constraints).

**Sessions** (`Sessions.tsx`)

| Method + path | Body / query | Returns | Notes |
|---|---|---|---|
| `GET /api/sessions` | `project?`, `q` (title, model), `range?`, `limit`, `before` | `Session[]` `{id, project, title, model, started_at, turns, tokens, decisions, followed, memories}` | counts via one grouped subquery each |
| `GET /api/sessions/{id}` | | `Session` + `{decisions: Decision[], memories: Memory[]}` | F4 per-session drill-down |
| `DELETE /api/sessions/{id}` | | `{ok: true}` | cascades its decisions and events; memories stay (their `source` keeps the session id as text) |

- Field sources: a session row is upserted by the first `/hook/prompt` (`title` = that prompt, first 80 chars); `turns` += 1 per prompt hook; on `/hook/stop` the daemon reads `transcript_path` (local mode) for `model` (last `message.model`) and `tokens` (sum of `message.usage` input + output + cache tokens). Shared mode can't read client files: `model = ""`, `tokens = 0` (`# ponytail:` until the hook sends usage).

**Memories** (`Memories.tsx`, B8, A3)

| Method + path | Body / query | Returns | Notes |
|---|---|---|---|
| `GET /api/memories` | `project?` (that project's + global), `q` (text, kind), `kind?`, `scope?`, `pinned?`, `include_deleted?`, `limit` | `Memory[]` `{id, scope, project, kind, text, confidence, pinned, use_count, updated_at, source, supersedes}` | |
| `GET /api/memories/{id}` | | `Memory` + `{history: Memory[]}` | supersede chain, newest first (F4 history) |
| `POST /api/memories` | `{scope, project?, kind, text, pinned?}` | `{action: ADD|UPDATE|NOOP, memory}` | goes through `write_memory`; `source = manual` |
| `PATCH /api/memories/{id}` | `{text?, pinned?, kind?, scope?}` | `Memory` | text change → re-embed; bumps `updated_at` |
| `DELETE /api/memories/{id}` | | `{ok: true}` | soft delete (`deleted_at`); stops shaping routing at once |
| `POST /api/memories/{id}/restore` | | `Memory` | clears `deleted_at` |
| `POST /api/memories/import` | `{dirs?}` | `{job_id}` | Claude's memory files, read-only |
| `POST /api/memories/backfill` | `{sessions: N}` | `{job_id}` | A3 |

- `kind` ∈ `preference|convention|fact|skill_outcome` (Claude memory `type` maps user → preference, feedback → convention, project/reference → fact). `source` is rendered as a string: `claude-memory · <file>`, `session <id>` or `manual`. `supersedes` is rendered as `"<id> (<first 40 chars of its text>)"`.

**Index, jobs, keys**

| Method + path | Body / query | Returns | Notes |
|---|---|---|---|
| `POST /api/index` | `{project?}` | `{job_id}` | scan → upsert → `build_index`; result `{added, changed, removed, vectors, library_version}` |
| `GET /api/jobs` | `status?`, `kind?`, `limit` | `Job[]` `{id, kind, status: queued|running|done|failed, progress, result, error, created_at}` | `ctc.jobs` is the truth, Redis stream `ctc:jobs` the queue |
| `GET /api/jobs/{id}` | | `Job` | |
| `GET /api/keys`, `POST /api/keys`, `DELETE /api/keys/{id}` | `{name}` | key list; `POST` shows the key once | shared mode only |

- `/api/*` and `/v1/*` (except hooks on the socket) require the bearer key in shared mode; CORS is off (dashboard is same-origin).
- Not in the dashboard yet, so not in the API until both sides land together: `cost_by_tier` (needs A2).


## AI integration flow (used by B5, B6, A1–A3, K2)

**Rule:** no LLM call on the per-prompt path. Prompts get embedding + search + rerank + a scikit-learn model at most; every LLM call is a background job.

**Per prompt** (`/v1/hook/prompt`, budget 120 ms):
1. Claude Code's `UserPromptSubmit` hook `curl`s the raw hook JSON to the daemon socket.
2. Cache chain (Cache design) → embed (TEI, `emb:` cache) → blend with session + project vectors (B7) + recalled memories (B8, weight 0.1).
3. `search` (B4): dense + keyword candidates → RRF → filters → rerank.
4. **Abstain gate** (`retrieval/gate.py`): features per query = top rerank, top dense cosine, top RRF, gap top1−top2 (rerank and dense), number of keyword hits, prompt length in tokens; `LogisticRegression` trained by K2 on dev rows (own transcripts: gold empty = negative; MetaTool reliability rows = negative; SkillRet and own rows with gold = positive), saved with its threshold to `models/abstain.joblib` (gitignored). Suggest only when `p ≥ gate_min_p`; `p` is the bundle's `confidence`. No model file → abstain off (current behaviour).
5. `decide` (B6) → Bundle (steps, agent, difficulty + model tier from A2's model when present) → `bundle:{ref}` + `sem:{ref}` + `enqueue("decision")`.
6. Claude sees one suggestion line; `find_capabilities(ref)` over MCP returns the full plan from cache.
7. `PostToolUse` (`Skill` / `Agent` / `Task`) → follow tracking → `decisions.followed`.

**Background jobs** (`server/jobs.py`): a `ctc.jobs` row is the truth; its id goes on the Redis stream `ctc:jobs` (Redis down → the worker polls `ctc.jobs where status = 'queued'`). One worker task per daemon (llama-server has one slot), each job: `status = running`, handler with a `jobs.timeout_s` timeout (index jobs exempt), 1 retry, `failed` after `dead_after` attempts with the error text. Handlers `async (state, payload, progress) -> result dict`:

| Job `kind` | Trigger | Handler | LLM |
|---|---|---|---|
| `index` | `POST /api/index`, `ctc index`, daemon start | scan → `upsert` → `build_index` → `publish_inval("lib")` | no |
| `enrich` | after an `index` job that added/changed caps; `POST /api/capabilities/{id}/enrich` | A1 `enrich` for caps whose `enricher_version` is stale → dedup → `build_index` | yes |
| `extract` | `/v1/hook/stop` (session ended) | A3 `extract_candidates(session)` → `write_memory` each | yes |
| `backfill` | `POST /api/memories/backfill` | `extract` over the last N sessions with transcripts | yes |
| `import_memory` | `POST /api/memories/import`, daemon start | B8 `import_claude_memory` | no |

- LLM provider: `cfg()["llm"]` (local llama-server; `anthropic:<model>` when `ANTHROPIC_API_KEY` is set). Every prompt goes through `Llm.json`, which redacts secrets; transcripts never leave the machine with the local default.
- `extract` reads `transcript_path` from the Stop hook (local mode only; shared mode skips it: the daemon can't read client files).

## History import design (used by B9)

**Principle:** Supabase is the long-term memory. It stores what was learned from the history (summaries, intents, memories, outcomes, counts), never raw transcripts or raw prompts. The raw source stays where Claude Code keeps it, on the user's disk, and is re-read when needed.

**Read (read-only):** `<claude_home>/projects/<project>/<session>.jsonl` (main transcripts; rows: `sessionId`, `cwd`, `gitBranch`, `timestamp`, `type`, `message.model`, `message.usage`, `message.content` text / `tool_use`, `custom-title`), `<project>/<session>/subagents/*.jsonl` (folded into the parent's tokens and tool calls), `<project>/memory/*.md` (already imported by B8). Not read: `file-history/`, `shell-snapshots/`, `session-env/`, `sessions/`, `telemetry/`, `cache/`.

**Pipeline**

| Phase | Work | LLM | Writes |
|---|---|---|---|
| 1 scan | list transcripts; skip files whose `(size, mtime)` match `history_files`; stream-parse changed ones | no | `history_files`, `projects` (`ensure_project(cwd)`), `sessions` (model = most used, turns = typed prompts, tokens = usage summed once per `message.id`, `started_at`/`ended_at`, `git_branch`, `transcript_path`, `source = history` unless a hook made it, `status = pending`, title = `custom-title` or `"<project> · <date>"`), `events` (`type = tool`, payload `{tool, name}` for Skill / Agent / Task only, no inputs) |
| 2 distill | per pending session: typed prompts (label.py's filter, each ≤ 300 chars, secrets redacted) → `llm.json → {title ≤ 8 words, summary 3–5 sentences: goal, what was done, outcome, intents: one ≤ 12-word intent per prompt, no names/paths/secrets}` (chunks of ≤ 30 prompts; intents count must match, 1 retry, else that chunk's intents = "") | yes, local | `sessions.title`, `sessions.summary`; per prompt: `route` replay locally (search + decide, no caches) → `decisions` (`at` = prompt time, `ref` = sha256(session_id + raw prompt)[:8] so live hook rows match, `prompt` = intent, `source = history`, `followed` = Claude called a suggested step's skill/agent before the next typed prompt); existing hook decisions of the session get their raw `prompt` replaced by the intent; A3 `extract_session` → `memories`; `sessions.status = processed`, `processed_at` |
| 3 outcomes | after a history job: per (project, capability) with ≥ 3 suggestions → follow rate | no | `memories` kind `skill_outcome` via `write_memory` ("In <project>, <cap> was used k of n times it was suggested") |

**Schema additions** (`schema.sql`, idempotent `alter table … add column if not exists`): `history_files(user_id, path, session_id, size, mtime, rows, status, error, imported_at, primary key (user_id, path))`; `sessions` + `source text default 'hook'`, `status text default 'processed'` (`pending` / `processed` / `failed`), `summary text`, `git_branch text`, `transcript_path text`, `processed_at timestamptz`; `decisions` + `source text default 'hook'`.

**Jobs:** `history` (phase 1 + 3, then one `distill` job per pending session) and `distill` (`{session_id}`); one LLM job at a time as usual. Config `history: {skip_projects: [], max_prompt_chars: 300, chunk: 30, on_start: true}`.

**API** (shapes go into `dashboard/src/types.ts`)

| Method + path | Body / query | Returns |
|---|---|---|
| `GET /api/history` | | `HistoryStatus {root, files, imported, pending, processed, failed, last_job: Job \| null}` |
| `POST /api/history/import` | `{process?: true, projects?: string[]}` | `{job_id}` |
| `GET /api/history/files` | `status?` | `HistoryFile[] {path, session_id, size, status, error, imported_at}` |
| existing `GET /api/decisions`, `GET /api/sessions` | `source?=hook\|history` (default all) | rows gain `source`; `Session` gains `summary`, `status`, `git_branch` |

**CLI:** `ctc history status`, `ctc history import [--no-process] [--project NAME]`.

**Dashboard:** Jobs view gets an "Import Claude history" button and a history status card (files, pending, processed); Overview gets a Live / History / All source toggle; Sessions show the summary and a pending badge; the decision drawer shows the source.

**Privacy:** `~/.claude` is only read. Raw prompts are used in memory for routing and distilling, never stored (history decisions store intents; live hook decisions keep the raw prompt only until that session is distilled). All LLM work uses `cfg()["llm"]` (the local model by default) through `Llm.json`, which redacts secrets.

## Memory design (used by B7, B8, A3)

- **Layers:** project profile (slow), session state (last 20 turns; topic shift at cosine < 0.55), decision history (±0.05 per follow/ignore, clamp ±0.2), long-term memory.
- **Table:** `ctc.memories(id, scope, project, kind, text, hash, source jsonb, supersedes, confidence, pinned, created_at, updated_at, last_used_at, use_count, deleted_at, embedding vector(1024))` + HNSW index.
- **Write:** ≥ 0.95 NOOP, contradiction SUPERSEDE, ≥ 0.85 UPDATE, else ADD. **Read:** top 5, similarity × recency (half-life 30 days, pinned exempt) × (1 + ln(1 + use_count)), weight 0.1 on the query vector. Claude's own memory files are imported read-only.

## Data (used by K1–K4)

| Dataset | Use |
|---|---|
| SkillRet (`ThakiCloud/SKILLRET`, 6,006 test skills + 10,123 train, 4,392 test queries, 7,187 qrels pairs) | main retrieval benchmark; train split for A4 |
| MetaTool reliability subset | "should any tool fire?" → abstain calibration |
| Own transcripts | in-domain set, LLM-judged, 200 hand-checked |
| SRA-Bench, ToolRet | after M1 |

Tune on dev only; test queries never come from the enricher.

---

## Workflow runner (m5)

Requirements, owner decisions and research: `.claude/prds/workflow-runner.md`. F5 saves move to `<root>/.claude/ctc-workflows/` once WB5 lands.

### Goal and architecture
- **Goal:** run a saved canvas workflow unattended on the user's own Claude login, on its own git branch, and record every node's output, diff, tokens and resumable session.
- **Architecture:** one asyncio runner task in the existing daemon walks the graph. Agent nodes run the pinned `claude -p --output-format stream-json --verbose` as a subprocess, and Shell nodes run `bash -c`, both inside a per-run git worktree. After each node, the walker state is saved to Postgres in the same transaction as the step row. A crash fails the run and re-runs nothing. Approval and quota pauses put the run back in the queue through the same claim.
- **Data:** run summaries go to Supabase (3 tables in `ctc`). Raw logs go to `~/.claudethecaller/runs/<id>/`. Runs use neither Redis nor `ctc.jobs`.

### Decisions
| Area | Choice | Rejected | Why |
|---|---|---|---|
| Orchestration | Hand-rolled walker: `src/ctc/runner/graph.py` (pure functions) driven by `engine.py` (asyncio). The state is data in `wf_runs.state`, not replayed code. | **LangGraph 1.2.x**: "resumes from the start of the node, re-executing all logic" (https://docs.langchain.com/oss/python/langgraph/interrupts), and about 10 packages including langchain-core and langsmith. **DBOS 3.3**: steps run at least once, and names are global across a shared system DB, so teammates' daemons clash (https://docs.dbos.dev/explanations/sharing-a-system-database). **Temporal, Hatchet, Prefect, Inngest**: an extra server each. | "Never re-run a side effect" holds by construction. Both judges picked it; scores were hand-rolled 9/9/8/8/7, DBOS 7–8.5, LangGraph 6–8. One new dependency. |
| Recovery | Step row inserted as `running` before spawn, guarded by `unique (run_id,node_id,visit)`. The outcome and the checkpoint are written in one transaction. The startup sweep turns `running` into `failed` and kills orphans. `waiting`, `quota` and `queued` runs survive. | Resuming mid-run after a crash | PRD rule |
| Database and logs | Supabase `ctc.wf_runs`, `wf_steps`, `wf_schedules`. Diffs are stored up to 64 KB; the full diff is `git show` on the kept branch. Logs: `~/.claudethecaller/runs/<id>/<node>-<visit>.jsonl.gz`. | Logs in Postgres (20–60 MB a week against the 500 MB free tier); SQLite | About 1–2 MB a week in the DB |
| Queue | One runner task. Claim: `update … where id = (select … status='queued' … for update skip locked)`. A partial unique index `(owner) where status='running'` allows one running run per owner. | `ctc.jobs` (retries, 60 s timeout and re-queue would duplicate side effects) | Enforced by the DB |
| Scheduling | `croniter` 6.2.4, a 30 s loop and a per-owner `wf_schedules` row, plus the idle wait (decision 8) | crontab, APScheduler | A schedule spends one person's quota |
| Live updates | Poll `GET /api/runs/{id}` every 1.5 s; logs by byte offset (`ponytail:`, upgrade path is SSE) | SSE (`fastapi.sse`, the upgrade), WebSocket, Supabase Realtime | Same pattern as `useJob` |
| Workflow file | `<root>/.claude/ctc-workflows/<name>.yaml` with `settings`, `nodes`, `edges` and positions, plus a `steps:` list derived for the router | `.claude/workflows/` (native `.js` lives there) | Committed in git, which is the team model |
| Compare runs | `git diff <branchA>..<branchB>`, or per node `git diff <A.post_sha> <B.post_sha>`; both branches live in the same repo | Storing outputs for text diffing | The branches already exist |
| Quota continue | The node goes `quota` with its `session_id` kept. **Continue** re-claims the run and re-enters that node with `--resume <session_id>` and the prompt "Continue where you left off". Auto-continue at `quota_resets_at` if `auto_resume` is set. | Re-running the node from scratch | The half-done work is kept |
| Extra usage | Parse `rate_limit_event`; if it shows overage and `allow_extra_usage` is false, stop the node and mark it `quota` (reason `extra_usage`) **(unverified field)** | | Default: never spend money silently |
| CLI pin | `config/server.yaml runner.claude_version`. The auth check refuses to run if `claude --version` differs. `ctc runner upgrade` runs the auth smoke and rewrites the pin. The child env sets `DISABLE_AUTOUPDATER=1` **(unverified)**. | Following auto-updates | Bare-mode risk |
| Permissions | Per workflow `settings.permission`: `worktree` (default: `--permission-mode acceptEdits`, per-node `--allowedTools`, `--permission-prompts none`) or `container` (M6: `docker run` of a pinned `ctc-runner` image with the worktree and only the login file of `~/.claude` mounted, `--dangerously-skip-permissions`) | Bypass on the host | Owner decision 5 |
| Native export | `POST /api/workflows/{id}/export` writes `.claude/workflows/<name>.js`. Agent → `agent()`; Shell → `agent("Run exactly: …, report exit code", {schema})`; IF → a JS `if` on a structured output; loops → a capped `while`; parallel → `parallel()`. Refused if the workflow has an approval node. | Native workflows as the engine | It can't pause, and gives less control |
| Frontend | Keep Vite 8.3.4, React 19.3.1 and `@xyflow/react` 12.12.0 (multiple handles per node by `id`). Diff viewer: our own `<pre>`, about 15 lines. Plain forms, cron as a text input, no auto-layout, types from `pnpm gen:types`, hash routes. | react-diff-view (add if split view is needed), diff2html, Monaco, react-hook-form, cronstrue, dagre, react-router | The canvas shell already exists |
| Agent node runtime | Explicit child env: `os.environ` minus the API-key variables, plus `HOME=<real>`, `CTC_RUN=<id>`, `DISABLE_AUTOUPDATER=1`. `cwd=<worktree>`, `start_new_session=True`. Flags: `-p --output-format stream-json --verbose --session-id <uuid4> --permission-mode acceptEdits --allowedTools … --disallowedTools "Bash(git push:*)" "Bash(gh pr:*)" --permission-prompts none --strict-mcp-config --mcp-config <node or empty> [--model --effort --agent --json-schema --max-turns]`. Readonly nodes get `dontAsk` and read tools only. Timeout: SIGINT → 10 s → SIGTERM → 5 s → SIGKILL, sent to the process group. | Agent SDK, `--bare`, host bypass | Verified flags on 2.1.306. Unverified: `--session-id` combined with `--fork-session`, and whether `dontAsk` denies everything not on the allowlist. WB3 checks both. |
| Team | Own daemon and login per teammate. Rows are keyed by `owner` (the `claude auth status` email). Run endpoints are `_local_only`. History storage: pending. | Shared-mode execution | Policy |
| Router isolation | Hooks whose `cwd` is under `~/.claudethecaller/runs/` return empty: no suggestions, decisions, `extract` jobs or `own-eval` rows | | Decision 9 |

### Workflow file
```yaml
name: fix-tests
description: Run tests, fix until green (max 3), reviewers, then draft PR after approval
settings: {permission: worktree, allow_extra_usage: false, auto_resume: true, max_run_tokens: null}
defaults: {model: sonnet, max_turns: 30, timeout_s: 1800, max_visits: 3}
nodes:
  - {id: start, type: trigger, input: "", pos: [0, 160]}
  - {id: test, type: shell, command: "uv run pytest -x -q", timeout_s: 600, pos: [180, 160]}
  - {id: green, type: if, path: test.exit_code, op: eq, value: 0, pos: [380, 160]}   # ops: eq|ne|contains|truthy; missing path = false
  - {id: fix, type: agent, cap: "user:tdd-fix", prompt: "Tests fail:\n{{test.stdout_tail}}\nGoal: {{input}}",
     allowed_tools: [Read, Edit, Write, "Bash(uv run pytest:*)"], pos: [380, 320]}
  - {id: review-a, type: agent, readonly: true, prompt: "Review for bugs", json_schema: {type: object}, pos: [580, 80]}
  - {id: review-b, type: agent, readonly: true, agent: security-reviewer, prompt: "Security review", pos: [580, 220]}
  - {id: join, type: merge, pos: [780, 150]}
  - {id: gate, type: approval, message: "Push {{run.branch}} and open a draft PR?", pos: [960, 150]}
  - {id: pr, type: shell, command: "git push -u origin HEAD && gh pr create --draft --fill", pos: [1140, 150]}
edges:
  - {from: start, to: test}
  - {from: test, to: green}
  - {from: green, to: review-a, handle: "true"}
  - {from: green, to: review-b, handle: "true"}
  - {from: green, to: fix, handle: "false"}
  - {from: fix, to: test}            # back-edge, capped by test.max_visits
  - {from: review-a, to: join}
  - {from: review-b, to: join}
  - {from: join, to: gate}
  - {from: gate, to: pr}
steps: [{cap: "user:tdd-fix"}, {agent: security-reviewer}]   # derived on save, for the router
```
- **Node fields:**
  - Agent: `prompt cap agent model effort permission_mode allowed_tools mcp_config json_schema resume_from max_turns timeout_s readonly on_error`. `cap` prefixes the prompt with `/<invoke>`.
  - Shell: `command timeout_s readonly`.
  - Every node: `max_visits`, `pos`.
- **Templates:** `{{input}}`, `{{<node>.<dotted.path>}}`, `{{run.branch}}`. Filled by one regex plus a dotted lookup; missing or skipped values become `""`.
- **Outputs:**
  - agent `{result ≤64 KB, structured_output, is_error, subtype}`; `is_error` fails the run unless `on_error: continue`
  - shell `{exit_code, stdout_tail 4 KB, stderr_tail 4 KB, duration_ms}`; a non-zero exit is data
  - if `{value}`; merge `{inputs: {node: output}}`; approval `{approved, note}`; trigger `{input}`
- **Runner settings** go in `config/server.yaml`: `runner: {claude_version: "2.1.306", idle_wait_min: 15, poll_s: 1.5}`.

### Walker rules (`graph.py`)
1. **Load.** There is exactly one `trigger`. A DFS from it marks an edge as a **back-edge** if it points to a node on the DFS stack; every other edge is forward.
2. **Ready.** Each forward edge carries a token, `data` or `skip`. A node is ready when every inbound forward edge has a token and at least one token is `data`. A back-edge carrying `data` makes its target ready directly.
3. **IF.** The taken handle gets `data`. The untaken edges go into `state.deferred`, not into the inbox.
4. **Quiescence.** When nothing is ready or running:
   - deferred edges become `skip` tokens
   - a node whose tokens are all `skip` is recorded as `skipped` and sends `skip` downstream
   - repeat until a node is ready or nothing changes; nothing changing means the run is `done`
   - `skip` never travels on a back-edge
5. **Back-edge fires.**
   - The loop body is the set of nodes reachable forward from the target that can also reach the source; clear its inbox and deferred entries.
   - Increment `visits[target]`. If it now exceeds `max_visits`, fail with `loop cap reached at <id>`.
   - Backstop: total executions ≤ Σ `max_visits` + node count.
6. **Validator.**
   - No `merge`, and no non-IF node that fans out, inside a loop body.
   - Every IF has both handles.
   - Ids are unique slugs, and edges point at real nodes.
   - Templates reference only existing ids.
   - The push/PR gate rule holds.
   - Errors are `{message, node_id}`.
7. **Batches (M3).**
   - Ready `readonly` nodes run together under `asyncio.gather`; otherwise only the first ready writer runs.
   - Each node's commit and diff happen under one `asyncio.Lock`.

### Constraints

- **Subscription only.**
  - Use the installed, unmodified `claude`. No Agent SDK, no API key, never `--bare`.
  - Check on every claim:
    - `claude auth status` reports `loggedIn` and `authMethod == "claude.ai"`
    - the version matches the pin
    - `apiKeySource` in the init event is null or `none`, otherwise the run fails with `api_key_billing`
- **Local only.** The runner, `/api/runs*` and the MCP run tools are `_local_only`. Tokens are never stored or relayed.
- **Never re-execute a side effect.** No automatic retry after a failure. A crash means `failed`. A quota hit means `quota` and can be continued.
- **One running run per owner,** enforced by a DB index.
- **Never the user's checkout.**
  - Worktree and branch `ctc/<wf>-<id>`, kept after the run.
  - A Shell node matching `\b(git\s+push|gh\s+pr\s+(create|merge))\b` must sit behind an approval node.
  - Agent nodes get the matching `--disallowedTools`.
  - Trusted repos only.
- **Shell templates are quoted** with `shlex.quote`.
- **Runs never feed the router** (decision 9).
- **H3 exception, runs only.** The child's `HOME` is the real home.

### Data model
```sql
create table if not exists ctc.wf_runs (
  id bigint generated always as identity primary key,
  owner text not null,                                   -- claude auth status .email
  workflow text not null,                                -- cap_id
  project_id text references ctc.projects on delete set null,
  file_sha text not null, graph jsonb not null,          -- snapshot at submit
  trigger text not null check (trigger in ('button','cli','api','schedule','mcp')),
  status text not null default 'queued'
    check (status in ('queued','running','waiting','done','failed','cancelled','quota')),
  input text not null default '',
  state jsonb not null default '{}',                     -- {visits, inbox, deferred, ready, execs}
  repo text, worktree text, branch text, base_sha text, pr_url text,
  auth jsonb,                                            -- {authMethod, email, claude_version}
  error text,
  quota_resets_at timestamptz, auto_resume boolean not null default true,   -- decision 2
  tokens bigint not null default 0,                      -- running total, for max_run_tokens
  created_at timestamptz not null default now(), started_at timestamptz, ended_at timestamptz);
create unique index if not exists wf_runs_one_running on ctc.wf_runs (owner) where status = 'running';
create index if not exists wf_runs_owner on ctc.wf_runs (owner, id desc);

create table if not exists ctc.wf_steps (
  id bigint generated always as identity primary key,
  run_id bigint not null references ctc.wf_runs on delete cascade,
  node_id text not null, visit int not null, kind text not null,   -- trigger|agent|shell|if|merge|approval
  status text not null check (status in ('running','waiting','done','failed','timeout','cancelled','quota','skipped')),
  input text, output jsonb, error text,
  session_id text, num_turns int, usage jsonb, cost_usd real,      -- cost is notional
  permission_denials jsonb, overage boolean,
  pre_sha text, post_sha text, files jsonb, diff text,             -- diff ≤ 64 KB
  log_path text,
  started_at timestamptz not null default now(), ended_at timestamptz,
  unique (run_id, node_id, visit));

create table if not exists ctc.wf_schedules (
  owner text not null, workflow text not null, cron text not null, input text not null default '',
  enabled boolean not null default true, last_fired_at timestamptz,
  primary key (owner, workflow));
-- RLS on, no policies (like every ctc table)
```

### API
All endpoints are `_local_only` and scoped to the owner. Shapes go into `dashboard/src/types.ts` through `pnpm gen:types`.

- `Run` = `{id, workflow, project, status, trigger, input, branch, worktree, pr_url, error, quota_resets_at, auto_resume, created_at, started_at, ended_at, tokens, nodes_done, nodes_total}`
- `RunDetail` = `Run & {graph, file_sha, auth, steps: Step[]}`
- `Step` = `{id, node_id, visit, kind, status, input, output, error, session_id, num_turns, tokens{…}, cost_usd, permission_denials, overage, files, started_at, ended_at}`

| Method + path | Body / query | Returns |
|---|---|---|
| `GET /api/capabilities/{id}` (extended) | | adds `graph`, `settings`, `schedule {cron, input, enabled, next_at, last_fired_at}` |
| `POST`/`PATCH /api/capabilities` (extended) | `graph` replaces `steps` for workflows | `Capability`; 422 `invalid_graph {message, node_id}` |
| `POST /api/workflows/{cap_id}/runs` | `{input?, project?, trigger?}` | `202 {run_id}`; 422 `invalid_graph` / `project_required` |
| `GET /api/runs` | `workflow?`, `status?`, `trigger?`, `limit`, `before` | `Run[]` |
| `GET /api/runs/{id}` | | `RunDetail` |
| `GET /api/runs/{id}/steps/{sid}/log` | `offset` | `{text, offset, done}` |
| `GET /api/runs/{id}/steps/{sid}/diff` | | `{diff, files, truncated}` |
| `GET /api/runs/{id}/diff` | | the run's whole diff, `base_sha..HEAD` |
| `GET /api/runs/compare` | `a`, `b`, `node?` | `{diff, files, truncated}`; whole runs = `git diff <a.branch>..<b.branch>`, one node = its `post_sha`s |
| `POST /api/runs/{id}/cancel` | | `Run` |
| `POST /api/runs/{id}/approve` | `{approve, note?}` | `Run`; 409 `not_waiting` |
| `POST /api/runs/{id}/continue` | `{when: now\|reset}` | `Run`; `quota` → `queued` now, or sets `auto_resume`; 409 `not_quota` |
| `PUT` / `DELETE /api/workflows/{cap_id}/schedule` | `{cron, input?, enabled}` | schedule + `next_at`; 422 `bad_cron` |
| `POST /api/workflows/{cap_id}/export` | | `{path}`; 422 `has_approval` (M6) |
| `/mcp` | `run_workflow(workflow, input="")` → `{run_id}`; `workflow_status(run_id)` → `{status, error, quota_resets_at, steps[]}` | |
| CLI | `ctc run <wf> [--input] [--project] [--wait]`, `ctc runs`, `ctc cancel <id>`, `ctc continue <id> [--now]`, `ctc runner upgrade` | |

### Build order (m5)
Tracks: WB = backend, WF = frontend, WH = owner. Each milestone branch is cut from the previous one and PRed into `main`.

#### M1: Run a chain (`m5-runner-core`)
- **Result 2026-10-22:** built and tested end to end on a test daemon: `smoke` done (~41k fresh tokens), cancel and `kill -9` leave no orphans, fake quota/extra-usage end `quota`, the token cap stops before a node, two website workflows (coder → check → IF → reviewer [→ fixer]) built real sites, one built and run by hand in the browser. Fixed on the way: shell-template injection, host permission bypass, agent names, cap counting cache reads, run canvas fit, 5 editor bugs, stale `index.html` cache. WH2 (owner's own chain) open.
- [x] **WH1 — owner: scope**
  - Move Part 3 into `PLAN.md` and apply the Product line change.
  - Grant the runs-only H3 exception.
  - Approve `.claude/ctc-workflows/`.
  - Done when: `grep -c "Workflow runner (m5)" PLAN.md` prints `1` on a commit.
- [x] **WB1 — schema**
  - Add the three tables to `src/ctc/storage/schema.sql`, plus `croniter==6.2.4` and the `runner:` block in `config/server.yaml`.
  - Done when: `uv run python -c "import asyncio;from ctc.server.state import open_state;s=asyncio.run(open_state());print(asyncio.run(s.store.fetchval('select count(*) from wf_runs')))"` prints `0`.
- [x] **WB2 — walker** (`src/ctc/runner/graph.py`, pure functions)
  - `load`, `validate` (rules 1 and 6; in M1 any push/PR node is rejected), `ready`, `complete`, quiescence, `render(tpl, ctx, shell=False)`, `eval_if`, `derived_steps`.
  - Done when: `uv run python -m ctc.runner.graph` passes its `__main__` asserts:
    - IF picks the right branch, and the untaken branch is `skipped`
    - bad graphs are rejected
    - `render` shell-quotes values
- [x] **WB3 — node processes** (`src/ctc/runner/proc.py`)
  - `child_env()`.
  - `preflight()`: auth status, version against the pin.
  - `agent_argv()`.
  - `run_agent()`: stream to the log; parse `system/init` (`session_id`, `apiKeySource`), `rate_limit_event` (overage) and `result`.
  - `run_shell()`.
  - `stop(pgid)`.
  - The quota regex `/hit your (\w+ )?limit.*?resets ([^\n"]+)/i`.
  - `CTC_CLAUDE_BIN` overrides the binary; `scripts/fake_claude_quota.sh` fakes a quota hit.
  - Done when all three hold:
    - `uv run python -m ctc.runner.proc agent "reply with ok"` prints `authMethod=claude.ai result=ok session_id=<uuid> turns=1 exit=0`
    - `… shell "sleep 99" --timeout 2` prints `timeout`, and `pgrep -f "sleep 99"` is empty
    - the fake binary prints `status=quota resets_at=…`

  Also record whether `--session-id` with `--fork-session` and `dontAsk` behave as assumed.
- [x] **WB4 — engine** (`src/ctc/runner/engine.py`)
  - `claim()`:
    - quota gate
    - preflight
    - on the first start, `git worktree add -b ctc/<wf>-<id> ~/.claudethecaller/runs/<id>/wt HEAD`
  - Per node:
    1. Claim the step row.
    2. Spawn.
    3. Under the lock, `git add -A && git commit --allow-empty -m "ctc: <node>#<visit>"`, then numstat and the diff (≤ 64 KB).
    4. In one transaction, update the step and `wf_runs.state`, adding to `tokens`.
    5. Gzip the log.
    6. Capture `pr_url`.
  - `max_run_tokens` exceeded → `failed`.
  - Done when: `uv run python -m ctc.runner.engine .claude/ctc-workflows/smoke.yaml --input hi` prints every node `done` or `skipped`, and `git worktree list | grep ctc/smoke-` matches.
- [x] **WB5 — daemon, API, CLI, library**
  - Runner task in the lifespan; `CTC_WORKER=0` turns it off.
  - Startup sweep through `/proc/*/environ` `CTC_RUN=<id>`.
  - `src/ctc/server/runs.py` endpoints (all but approve, continue, compare, schedule and export).
  - `hooks.py` returns empty under the runs dir.
  - `library.py`: `ctc-workflows/`, `graph`, 422.
  - `scanner.py` glob.
  - `cli.py`: `run`, `runs`, `cancel`, `runner upgrade`.
  - Done when: `uv run ctc daemon stop; uv run ctc daemon start && uv run ctc index && uv run ctc run smoke --input hi --wait && curl -s 127.0.0.1:18310/api/runs?limit=1 | jq -e '.[0].status=="done"'`.
- [x] **WB6 — cancel, crash, quota stop, extra-usage guard**
  - Done when all four hold:
    - Cancel of `sleep.yaml` → `cancelled`, and `pgrep -f "sleep 600"` is empty.
    - `kill -9` of the daemon, then a restart → `failed  daemon stopped mid-run`, with no orphan process.
    - The fake quota binary → `quota` with `quota_resets_at` set; a rerun creates no new steps.
    - A fake overage binary with `allow_extra_usage: false` → `quota`, reason `extra_usage`.
- [x] **WF1 — types and client**
  - Done when: `pnpm -C dashboard gen:types && pnpm -C dashboard build`.
- [x] **WF2 — canvas**
  - Node views: trigger, agent, shell, if (`true`/`false` handles); dashed back-edges.
  - Remove `chainOrder` and `isValid`; save sends `graph`; a 422 highlights the node.
  - Done when: after a UI save, `curl -s 127.0.0.1:18310/api/capabilities/<id> | jq '.graph.nodes|length'` prints the node count.
- [x] **WF3 — node and workflow settings panel**
  - Plain forms per node type, plus workflow `settings`: permission, allow extra usage, auto resume, max run tokens.
  - Done when: the edited prompt and settings show up in `.claude/ctc-workflows/<name>.yaml`.
- [x] **WF4 — Run button**
  - Done when: after clicking Run, `curl -s …/api/runs?limit=1 | jq -r '.[0].trigger'` prints `button`.
- [x] **WF5 — runs list and run detail**
  - Canvas overlay with a status colour per node, Output and Meta tabs, and a copy button for `claude --resume`.
  - Done when: `#run/<id>` shows every node in its final colour.
- [x] **WF6 — live progress, log and diff**
  - 1.5 s poll, `LogView`, `DiffView`.
  - Done when: an open page updates without a reload, and `…/steps/<sid>/diff | jq '.files|length'` is ≥ 1 for an editing node.
- [ ] **WH2 — owner: first real chain, then PR `m5-runner-core`**

#### M2: Loops, approval, continue, compare (`m5-runner-loops`)
- **Result 2026-10-22:** loop-demo counts 1–3 then done; a 4th visit fails with `loop cap reached`; gate waits across a daemon restart, approve → done, reject → cancelled; bad-push → 422; continue after quota re-claims the same step row and resumes the same session (`--resume`, 1 Haiku run); compare returns whole-run and per-node diffs. Recorded UI test 33/33. Auto re-queue at the reset time checked only with a fake binary.
- [x] **WB7 — loops** (rules 5–6, visit numbering, `loop-demo.yaml`)
  - Done when:
    - the fix-tests asserts pass: red, red, green runs the reviewers and join exactly once; a fourth red hits `loop cap`
    - `ctc run loop-demo --wait` shows visits 1–3
- [x] **WB8 — approval gate**
  - An approval node sets `waiting` and frees the lane.
  - `approve` → `queued`; reject → `cancelled`.
  - The gate rule replaces the M1 blanket reject.
  - Done when: a `gate` run stays `waiting` across a daemon restart and is `done` after approve, and `bad-push.yaml` gets 422.
- [x] **WB9 — continue after quota**
  - `POST …/continue` and `ctc continue`. The quota'd step is re-claimed as the same visit and re-run with `--resume <session_id> -p "Continue where you left off."`.
  - The cron loop auto-continues `quota` runs with `auto_resume` once `quota_resets_at` has passed.
  - Done when: a fake-quota run continued with `CTC_CLAUDE_BIN` reset to the real binary ends `done`, and its log shows `--resume <same session_id>`.
- [x] **WB10 — compare runs** (`GET /api/runs/compare`)
  - Done when: two `loop-demo` runs give `curl -s '…/runs/compare?a=<1>&b=<2>' | jq -e '.files|type=="array"'`.
- [x] **WF7 — loops on the canvas**: "loop ≤ N" edge labels, `×N` badges, a visit selector.
- [x] **WF8 — approval and quota banners**
  - "Waiting at `<node>`" with the run diff and Approve/Reject.
  - "Out of usage, resets at …" with **Continue when reset** and **Continue now**.
  - Done when: both banners work after a daemon restart.
- [x] **WF9 — compare page**: tick two runs in the list → `#compare/<a>/<b>[/<node>]` with `DiffView`.

#### M3: Parallel and merge (`m5-runner-parallel`)
- **Result 2026-10-22:** `three-reviewers` ends `done` in 8.8 s (three `sleep 5` shells in one batch, three `ctc: rN#1` commits) and the merge output has 3 inputs; a mixed batch runs the readonly nodes together, then the writer alone; cancel mid-sleep leaves the run and all three steps `cancelled` and no `sleep` process; a merge inside a loop is refused (422). `smoke` (fake binary), `loop-demo` and `gate` end as at M2.
- [x] **WB11 — parallel and merge** (rule 7, merge `{inputs}`, the commit lock, `three-reviewers.yaml`)
  - Done when: the run ends `done` in under 9 s and the merge output has 3 inputs.
- [x] **WF10 — merge view**: several nodes shown running at once.

#### M4: Hands-free triggers (`m5-runner-triggers`)
- **Result 2026-10-22:** `* * * * *` on `edit-demo` fired a `schedule` run 24 s after the save, then every minute; with `CTC_IDLE_WAIT_MIN=60` and a session active nothing fired over two slots (`next_at` stays in the past); a `waiting` `gate` run held its own schedule; a bad cron → 422 `bad_cron`. MCP: `claude -p --model haiku` called `run_workflow` + `workflow_status` (1 Haiku run), and the run ended `done` with trigger `mcp`. Schedule editor checked by build only (no browser on this host).
- [x] **WB12 — schedules and idle wait**
  - A 30 s loop over the owner's enabled schedules; fire when `croniter(cron, last_fired_at or now).get_next() <= now`.
  - Skip missed fires older than 2 min.
  - Don't fire if this workflow is already active, or during a quota window.
  - **Idle wait:** hold the fire while the newest transcript under `~/.claude/projects/` not belonging to a runner (directory names containing `claudethecaller-runs` are excluded) was modified within `idle_wait_min`.
  - Done when: a `* * * * *` schedule produces a `schedule` run within 70 s, and with `idle_wait_min: 60` while a session is active, no run.
- [x] **WB13 — MCP tools** (`run_workflow`, `workflow_status` in `mcp.py`)
  - Done when: `claude -p --strict-mcp-config --mcp-config '{"mcpServers":{"ctc":{"type":"http","url":"http://127.0.0.1:18310/mcp"}}}' --allowedTools 'mcp__ctc__*' "call run_workflow for smoke, then workflow_status"` prints a run id and a status.
- [x] **WF11 — schedule editor**
  - Cron input on the trigger node, "Next run …", and `schedule`/`mcp` shown in the runs list.
- [ ] **WH3 — owner: success check**
  - Done when: `select count(distinct workflow), count(*), avg((status='done')::int) from ctc.wf_runs` gives ≥ 3, ≥ 20 and ≥ 0.8, and no run has `authMethod <> 'claude.ai'`. Then open the PRs for M2–M4.

#### M5: Team runs (`m5-runner-team`), history storage pending
- **Result 2026-10-22:** a run owned by `someone@else.test` is missing from `/api/runs`, 404 on detail, diff, log, cancel, approve and continue, 422 on compare, and `no run` in `workflow_status`; its schedule stays hidden; a prompt hook from a teammate's runs dir writes nothing. History import and backfill now skip runner transcripts; 11 projects and 14 sessions imported from them before this fix are still in Supabase (owner to delete). Fresh-clone check and WH4 pending.
- [x] **WB14 — team check**
  - Every runner query filters on `owner`; teammates' runs never reach router stats; README note.
  - Done when: a fresh clone runs `smoke` to `done` and lists only that login's runs.
- [ ] **WH4 — owner: a teammate runs `smoke` on their own daemon and login**

#### M6: Modes and export (`m5-runner-modes`)
- **Result 2026-10-22:** a container-mode `smoke` ends `done` with `authMethod` `claude.ai` (1 Haiku run), `ctc-run-<run>-agent-1` visible while it runs; cancel and a `kill -9` of the daemon both leave no `ctc-run-*` container (tested with the agent's API pointed at a dead port, no quota). Export: `edit-demo` → `.claude/workflows/edit-demo.js` (Claude Code lists it as `/edit-demo`), again → 200, edited by hand → 409, `gate` → 422 `has_approval`. The native run is unverified: the one Haiku `claude -p "run the edit-demo workflow"` proposed a plan instead of calling Workflow.
- [x] **WB15 — container mode**
  - `docker/ctc-runner.Dockerfile` (Node base plus `@anthropic-ai/claude-code@<claude_version>`).
  - With `settings.permission: container`, Agent nodes run `docker run --rm -i --name ctc-run-<run>-<node>-<visit> --user <uid>:<gid> -v <wt>:<wt> -v <wt>/.git:<wt>/.git:ro -w <wt> -v ~/.claudethecaller/runs/<run>/claude:/home/claude --mount type=bind,src=~/.claude/.credentials.json,dst=/home/claude/.claude/.credentials.json ctc-runner:<v> claude -p --dangerously-skip-permissions …` (the worktree at its host path, so its sessions count as runner sessions; a per-run home with a copy of `~/.claude.json` minus projects and MCP servers, so an agent can't plant a hook or MCP server the host's claude would run); shell nodes stay on the host. The runner's own git calls on a worktree pass `--git-dir` (its admin dir, found from the main repo) and never read the worktree's `.git` file.
  - The auth check runs inside the container too.
  - Done when: a container-mode `smoke` ends `done` and `wf_runs.auth->>'authMethod'` is `claude.ai` **(unverified: credential file mount)**.
- [x] **WB16 — native export** (`POST …/export`, mapping as in Decisions)
  - Done when: exporting `loop-demo` writes `.claude/workflows/loop-demo.js`, and `claude -p "run the loop-demo workflow"` with a `Workflow` allow rule completes; exporting `gate` returns 422.
- [x] **WF12 — settings and Export button**: a permission mode selector (worktree/container) and an Export button with its result path.

### Still unverified
- What `-p` returns at a usage limit (exit code, `subtype`). The plan matches the error text; paste a real one into `fake_claude_quota.sh` when it happens.
- The fields of `rate_limit_event` and the overage flag, seen once and undocumented.
- `--session-id` combined with `--fork-session`; `dontAsk` denying everything not on the allowlist (WB3 checks both).
- Whether `DISABLE_AUTOUPDATER=1` stops auto-updates; whether a `setup-token` token works under bare mode.
- Container mode: mounting `~/.claude` credentials into Docker.
- Whether `--setting-sources` and similar reducers lower the ~44k startup tokens. Measure only if WH3 shows quota pressure.
- Library versions from the design pass: croniter 6.2.4, FastAPI 0.156.4, React Flow 12.12.0.

---

## Context + coding graph (m6)

Design (intent, goals, anti-goals, data model, eval): `specs/002-context-coding-graph/design.md`. Spec, plan and tasks sit beside it.

- **Goal:** the agent coding here sees which task, story, requirement and decision it works under and which code implements them, without anyone pasting it in.
- **Context graph:** features, stories, FR/SC, tasks, tickets, decisions, constraints, PLAN.md steps, claude-mem observations. Built by a parser (no LLM) plus a claude-mem-style background extractor (`claude -p --model haiku`, changed chunks only), triggered by speckit `extensions.yml` hooks and doc saves.
- **Coding graph:** graphify's code + rationale nodes (imported from `graphify-out/graph.json` when `built_at_commit` changes) plus context→code links: EXTRACTED (paths in tasks, ticket commits, claude-mem files), INFERRED (embedding similarity), CONFIRMED (Claude's own edits and review).
- **Surfaces:** a push line on each prompt (abstains under a tuned floor), a PreToolUse by-file note on Read/Edit, MCP `graph_search`/`graph_explain`/`graph_affected`/`graph_path`, CLI `ctc graph import|build|status|export|confirm`.
- **Data:** Supabase `graph_nodes`, `graph_edges`, `graph_sources`; RAM copy per worker; nothing generated is committed.

### Build order (m6, branch `m6-graph`)
- [x] **G1 — tables + graphify import.** Done when: `uv run ctc graph import` prints node/edge counts matching graph.json's code + rationale subset, and `ctc graph status` shows built_at_commit vs HEAD.
  - Result 2026-10-26: `ctc graph import` on the scratch DB: 1396 code+rationale nodes / 3788 edges = graph.json subset; second run `skipped`; status shows built_at = HEAD.
- [x] **G2 — context parser.** Done when: `uv run ctc graph build` prints 16 stories for `specs/001-n8n-parity` plus FR/SC/task/ticket/decision counts.
  - Result 2026-10-26: 16 stories / 31 FR / 7 SC / 170 tasks for 001-n8n-parity, 17 tickets, 20 decisions, 75 PLAN steps (parser self-check + `ctc graph build`).
- [x] **G3 — embeddings + links + claude-mem import.** Done when: build prints the % of tasks with ≥ 1 code link.
  - Result 2026-10-26: scratch build: 515 extracted + 225 inferred links, 194 unresolved paths dropped, tasks linked 79%; claude-mem 2 observations; rebuild with no changes embeds 0.
- [x] **G4 — extractor, `/ctc-context` skill, speckit hooks, re-parse on save.** Done when: editing a spec.md section changes nodes with no manual run, and an unchanged re-run makes 0 Claude calls.
  - Result 2026-10-26: tests (fake claude): a saved spec queues graph_extract then graph_build, unchanged re-run sends 0 chunks, one edited section sends 1; tasks.md left to the parser; packed chunks: first full pass ≈ 66 calls. Live check pending deploy; the real extractor has not run yet.
- [x] **G5 — MCP pull tools + `ctc graph export`.** Done when: `graph_search("retry a failed run from a node")` returns engine.py symbols and the export loads in `graphify query --graph`.
  - Result 2026-10-26: `graph_search("retry a failed run from a node")` → US1, T014 and ticket-11 linked to `src/ctc/runner/engine.py`; export of 462 context nodes loads in `graphify query --graph`.
- [x] **G6 — push line + `/v1/hook/pre` + install.** Done when: `CTC_CLAUDE_HOME=<tmp> uv run ctc install --dry-run` shows the PreToolUse hook and both hooks return their lines on curl.
  - Result 2026-10-26: install dry-run on a temp home adds PreToolUse `Read|Edit|Write|MultiEdit` → `/v1/hook/pre`; in-process both hooks return their lines (prompt_line p95 4.8 ms, file_note < 0.1 ms). Curl on the live daemon pending deploy.
- [ ] **G7 — eval** (`evaluation/graph_eval.py`). Done when: it prints dev (tickets 01–08) and test (09–16) Recall@3, MetaTool false-trigger rate and hook p95; pass = test Recall@3 ≥ 0.8, false triggers ≤ 10%, prompt p95 ≤ 150 ms, PreToolUse p95 ≤ 50 ms.
  - Result 2026-10-26: eval built and run (scratch schema `ctc_eval`, commit links off): test Recall@3 0.750 (6/8) **FAIL** vs 0.8 (misses 09 retry-on-fail, 14 graph-extras); false triggers 2% PASS; prompt_line p95 5.9 ms, file_note p95 0.02 ms PASS (in-process; `--daemon` after deploy). Strict (parser links ignored) test 0.375. Floor tuned on dev to 0.3 (bottom of the sweep).

Order: G1, G2 → G3 → G5, G6; G4 alongside G3; G7 last.
