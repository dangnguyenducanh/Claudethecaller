# claudethecaller Plan

**Goal:** a local router that predicts what a coding agent needs from project memory and the live session, and hands Claude an explainable bundle (workflow → ordered skills → subagents → difficulty and model tier) through one MCP tool plus a prompt hook, managed by a CLI and a dashboard.

**Architecture:** one warm Python daemon does routing, deciding and memory. One database: Supabase Postgres (tables, pgvector for vectors, full-text search for keywords). Local engines: TEI (embed/rerank), llama.cpp (local LLM). The hook is a `curl` one-liner; MCP and the dashboard are served by the same daemon. LLMs never run on the per-prompt path.

---

## Product

- **Problem:** agents rarely call installed skills/workflows/subagents; the user has to type `/plugin:skill`. No record of why a capability was or wasn't used.
- **Evidence:** owner's history (319 sessions, 2026-10-20): ~10,000 tool calls, 52 `Skill` calls (~0.5%), 17 distinct skills of 300+ installed. SRA-Bench (2026) sees the same.
- **Users:** coders with large skill libraries. Portfolio project, so built from scratch (ratel, MCPGateway, metamcp are references only).
- **Success:** after install, the Skill/Agent share of tool calls rises well above 0.5%; Recall@5 ≥ 0.90; latency targets hold.
- **In scope (Claude Code only):** index, hybrid search + rerank, decider, prefetch, long-term memory, MCP tool + suggest-only hook, CLI, dashboard, benchmark.
- **Out of scope:** other agents, executing workflows, blocking the agent, hosted SaaS, marketplace, training models from scratch.

## Stack

| Part | Stack |
|---|---|
| Embed + rerank | TEI (Docker): `ThakiCloud/SKILLRET-Embedding-0.6B` (1024-dim) on `:18300`, `BAAI/bge-reranker-v2-m3` on `:18301` |
| Local LLM (offline only) | llama.cpp `llama-server` on `:18302`, `Qwen2.5-3B-Instruct` Q4_K_M; Claude API only when `ANTHROPIC_API_KEY` is set |
| Database | Supabase project `claudethecaller` (`iecwnlyqjbigeiobmurn`, ap-southeast-1): Postgres 17 + pgvector (HNSW, cosine) + full-text search with `unaccent`; tables in schema `ctc`; Python `psycopg[binary]` + `pgvector`; IPv4 session pooler, `CTC_DATABASE_URL` in `.env` |
| Daemon | Python 3.12, FastAPI + uvicorn, official `mcp` SDK (FastMCP); Unix socket `~/.claudethecaller/ctc.sock` + `127.0.0.1:18310` |
| Hook | `curl` one-liner, fail-open |
| Benchmark + training | `ranx`, `datasets`, scikit-learn |
| CLI | `typer` |
| Dashboard | TypeScript: React + Vite + Recharts + React Flow |
| Packaging | `uv`, `pnpm`, `docker-compose.yml` |

## Constraints

- Local models ≤ 3B; our GPU use ≤ 7 GB (shared host): sum of `nvidia-smi --query-compute-apps` over this project's `docker compose top` PIDs.
- Hook adds ≤ 150 ms and fails open (daemon down → empty output, exit 0).
- Routing p95 ≤ 10 ms on prefetch hit (daemon RAM), ≤ 150 ms cold (one SQL round trip to Singapore is ~65 ms).
- Models run locally; capabilities, decisions and memories live in Supabase; benchmark data in `data/` stays local; `Llm.json` strips secrets from every LLM call; the DB password lives only in `.env`.
- IDs are namespaced: `plugin:name`, `user:name`, `project@<sha8>:name`. Claude-facing names use `invoke` (`name` for user/project, else the id).
- Any prompt language.
- Rules while building: stay in the step's scope; no secrets, `.env`, `data/` or weights in commits; never write the real `~/.claude/` until H3 (use a temp `HOME`); if only the owner can unblock it, say so and stop.

## Files

```
claudethecaller/
├── config/
│   ├── models.yaml            # TEI / llama-server URLs, model ids, embedding dim, LLM spec
│   └── retrieval.yaml         # candidate depth, RRF k, rerank_top, abstain τ, memory weights (K2 writes tuned values here)
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
│   │   └── store.py           # Postgres CRUD, vector + keyword queries
│   ├── retrieval/
│   │   └── hybrid.py          # dense + FTS → RRF → filters → rerank → abstain
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
│       ├── app.py             # FastAPI app, socket + :18310, lifespan
│       ├── hooks.py           # /hook/*, follow tracking
│       ├── mcp.py             # FastMCP find_capabilities
│       └── api.py             # /api/* for the dashboard
├── evaluation/
│   ├── loaders.py             # SkillRet, MetaTool
│   ├── label.py               # transcript labeler
│   ├── retrieval_eval.py      # ranx metrics, tuning sweep, report
│   └── latency_eval.py        # route p95 replay
├── scripts/
│   ├── check_models.py        # smoke-run embed / rerank / LLM          (done)
│   ├── train_difficulty.py    # A2
│   └── finetune_embedder.py   # A4
├── dashboard/                 # React + Vite (TS)
├── tests/                     # later, owner-guided
├── docker-compose.yml
├── pyproject.toml             # uv, src layout
├── .env                       # CTC_DATABASE_URL (gitignored)
├── CLAUDE.md
└── PLAN.md
```

A subfolder is created by the step that first puts code in it; no empty folders ahead of time.

---

## Build order

Four tracks. H = owner step. Commit after each step.

**Order:** H0 → B3 → B4 → K1 → F1 → H1 → K2 → H2 → B5 → B6 → F2 → H3 → K3 → A1, A2 → B7 → B8 → A3 → H4 → K4 → F3 → F4 → H6 → F5.

**Branches:** `m1-retrieval-core` (B1–B4, K1–K2, F1), `m2-agent-integration` (B5–B6, F2, K3), `m3-memory` (B7–B8, A3, K4), `m4-dashboard` (F3–F5), `ai-<name>` per AI step; PR into `main` at the end of each.

### Done

- [x] **B1** — uv package + capability scanner (`src/ctc/ingestion/scanner.py`, 632 capabilities).
- [x] **B2** — model servers (`docker-compose.yml`) + clients (`embedding/embedder.py`, `reranking/reranker.py`, `llm/client.py`), ~6.4 GB GPU; check with `uv run python scripts/check_models.py`.
- [x] **B2b** — Supabase project `claudethecaller` created; pgvector 0.8.2, unaccent, pg_trgm available.

### Backend — API + databases

- [ ] **H0** — owner puts the session-pooler connection string (Supabase dashboard → Connect → Session pooler) in `.env` as `CTC_DATABASE_URL`.

- [ ] **B3 — schema, store, indexer**
  - `pyproject.toml`: drop `usearch`; add `psycopg[binary]`, `pgvector`, `python-dotenv`. `[project.scripts] ctc = "ctc.cli:app"`. Create `config/models.yaml`, `config/retrieval.yaml` and `src/ctc/config.py` (`yaml.safe_load` + `python-dotenv`, env vars override).
  - `src/ctc/storage/schema.sql` (idempotent, applied by `Store.__init__`):
    - `create extension if not exists vector with schema extensions; create extension if not exists unaccent with schema extensions; create schema if not exists ctc;`
    - `ctc.unaccent_i(text)`: `language sql immutable` wrapper around `extensions.unaccent('extensions.unaccent', $1)`, so it can feed a generated column.
    - `ctc.capabilities(id text pk, kind, name, namespace, invoke, description, body, path, hash, summary, triggers text[], enricher_version, cluster_id, updated_at)` + `tsv tsvector generated always as (to_tsvector('simple', ctc.unaccent_i(name || ' ' || description || ' ' || coalesce(summary,'') || ' ' || array_to_string(coalesce(triggers,'{}'), ' ')))) stored`, GIN index on `tsv`. (`'simple'` = no stemming, works for any language; wrap the concat in an immutable SQL helper if Postgres rejects `array_to_string` in a generated column.)
    - `ctc.cap_vectors(cap_id text references ctc.capabilities on delete cascade, text_hash text, model text, embedding vector(1024), primary key (cap_id, text_hash))` + `hnsw (embedding vector_cosine_ops)`.
    - `ctc.overrides(project, cap_id, action check in ('pin','block','disable'), pk (project, cap_id))`, `ctc.sessions(id pk, project, title, model, started_at, ended_at, turns, tokens)`, `ctc.events(id bigserial, session_id, type, payload jsonb, at timestamptz default now())`, `ctc.decisions(id bigserial, session_id, ref, prompt, bundle jsonb, latency_ms real, followed bool default false, at)`, `ctc.memories(...)` (see Memory design) with its own HNSW index.
    - `alter table … enable row level security` on every table (no policies: only the `postgres` role, which bypasses RLS, can touch them).
  - `src/ctc/storage/store.py` — `class Store(dsn: str, schema: str = "ctc")`: one `psycopg.connect(dsn, autocommit=True)`, `register_vector(conn)`, `set search_path to <schema>, extensions`. Every method is one SQL statement:
    - `upsert(caps, namespaces) -> Diff`: `insert … on conflict (id) do update … where capabilities.hash <> excluded.hash returning id, (xmax = 0) as inserted` → added/changed; `delete … where namespace = any(%s) and not (id = any(%s)) returning id` → removed.
    - `candidates(qv, query, k=50) -> (dense, sparse)`: one round trip, two CTEs. Dense: `select cap_id, max(1 - (embedding <=> %s)) from (select … order by embedding <=> %s limit k*4) group by cap_id order by 2 desc limit k`. Sparse: tokens = `re.findall(r"\w+", query)` joined with ` | `, `to_tsquery('simple', ctc.unaccent_i(%s))`, ranked by `ts_rank_cd`; blank query → no sparse rows.
    - `overrides(project)`, `set_override(project, cap_id, action)`, `set_enrichment(cap_id, e, version)`, `set_cluster(cap_id, cluster_id)`, `library_version()` (`md5(string_agg(id || hash, ',' order by id))`), `get(cap_id)`.
  - `src/ctc/ingestion/indexer.py` — `async build_index(store, embedder) -> int`: per capability the texts are `"{name}: {description}"` (+ summary) and each trigger; `text_hash = sha256(model + text)`; read existing `(cap_id, text_hash)` pairs, embed only the missing ones in batches of 32 with `embedder.embed(texts, "doc")`, `executemany` insert, delete pairs no longer current. `__main__` (`python -m ctc.ingestion.indexer`): load config, `scan_library(default_roots(Path.cwd()))` → `upsert` → `build_index` → print vector count.

- [ ] **B4 — hybrid search** (`src/ctc/retrieval/hybrid.py`)
  - `Ctx(store, embedder, reranker, project)`; `Hit(cap_id, score, stages: dict)`; `SearchResult(hits, abstained, ms, dropped)`.
  - `rrf(rankings, k=60)`: `score[id] += 1 / (k + rank)`, ranks 1-based.
  - `async search(q, ctx, qv=None)`, with k, candidate depth, rerank_top and abstain τ read from `config/retrieval.yaml` (start: 5, 50, 20, 0.3):
    1. `qv = qv or embed([q], "query")[0]`; `dense, sparse = store.candidates(qv, q, 50)`.
    2. `rrf([dense ids, sparse ids])`.
    3. Drop `block`/`disable` overrides and capabilities from other projects' namespaces (record each in `dropped` with the reason); keep only the best-ranked member of each `cluster_id`.
    4. Rerank the top 20 with `reranker.score(q, ["{name}: {description}"])`, sort by it, move `pin` overrides to the front.
    5. Best rerank < `abstain_below` → `abstained=True, hits=[]`; else top k. `ms` holds `time.perf_counter` timings per stage.
  - `__main__`: `python -m ctc.retrieval.hybrid "<query>"` prints the top 5 as JSON.

- [ ] **B5 — daemon** (`src/ctc/server/`: `app.py`, `hooks.py`, `mcp.py`, `api.py`)
  - One FastAPI app served twice from one event loop: `asyncio.gather(uvicorn.Server(Config(app, uds=sock)).serve(), uvicorn.Server(Config(app, port=18310)).serve())`.
  - Startup builds one `Ctx`; Store calls run in `asyncio.to_thread` behind one `asyncio.Lock` (single connection; `# ponytail:` one lock, a pool if the dashboard gets slow).
  - `POST /hook/prompt` (raw Claude hook JSON: `prompt`, `session_id`, `cwd`): `ref = sha256(session_id + prompt)[:8]`; `search(prompt, ctx with project=cwd)`; keep the bundle in `prefetch[ref]` (`OrderedDict`, last 256); write the decision row as a background task; return text `[claudethecaller] Suggested: <invokes> — call find_capabilities(ref="<ref>") for the plan`, or empty when abstained.
  - `POST /hook/tool`, `POST /hook/stop`: insert into `ctc.events`; follow tracking (B6).
  - `POST /route {prompt, session_id, cwd}` → `Bundle` JSON. `GET /bundle/{ref}` → prefetched bundle.
  - `/mcp`: `FastMCP("claudethecaller")` with tool `find_capabilities(task, blocker=None, ref=None)`, mounted via `streamable_http_app()`; run `mcp.session_manager.run()` inside the FastAPI lifespan.
  - `/api/*`: `kpis`, `decisions` (paged), `sessions`, `capabilities` (+ `PUT …/override`), `memories` CRUD. Each is one SQL query.
  - Static `dashboard/dist` mounted at `/` once it exists.

- [ ] **B6 — bundle** (`src/ctc/decision/bundle.py`)
  - `Step(order, cap_id, invoke, kind, agent, reason)`, `Bundle(intent, confidence, difficulty, model_tier, workflow, steps, memories, abstained)`.
  - `async decide(hits, ctx)`: if the top hit is a workflow, load its YAML and emit its declared steps in order; otherwise emit the skill/command hits in rerank order. Attach the best `agent` hit to the steps only if its rerank ≥ 0.5. `reason` = the rerank score plus the matched trigger or description snippet. `confidence` = top rerank. `difficulty = "standard"`, `model_tier = "sonnet"` until A2 exists.
  - `find_capabilities`: return `prefetch[ref]` when `ref` hits and there is no `blocker`; otherwise `decide(search(task + blocker))`. Append "Use these in order; say why if you skip one."
  - Follow tracking in `/hook/tool`: `tool_name == "Skill"` → `tool_input["skill"]`; `Agent`/`Task` → `subagent_type`; if it equals a step's `invoke` or `agent` in the session's latest decision → `update ctc.decisions set followed = true`.

- [ ] **B7 — session memory + prefetch** (`src/ctc/memory/session.py`)
  - `ProjectProfile`: sha256 of CLAUDE.md + `.claude/` memory files + package manifests + `.git/HEAD`; project vector = embed of the first 2,000 chars, cached in `ctc.projects(project, profile_hash, embedding)`.
  - `SessionState` in RAM: `deque(maxlen=20)` of turn vectors + running mean; cosine(turn, mean) < 0.55 → clear (topic shift).
  - Query vector = normalize(0.6·prompt + 0.25·session + 0.15·project) → passed to `search(qv=…)`.
  - Semantic cache: last 256 `(qv, library_version, bundle)` in a numpy array; cosine ≥ 0.95 with the same `library_version` → reuse the bundle.

- [ ] **B8 — long-term memory store** (`src/ctc/memory/longterm.py`)
  - `Memory(id, scope, project, kind, text, confidence, pinned, source)`.
  - `async write_memory(m, ctx)`: embed; nearest live neighbour in scope (`order by embedding <=> %s limit 1`); ≥ 0.95 → NOOP (`use_count += 1`); `m.supersedes` set (by A3) → SUPERSEDE (old gets `deleted_at`); ≥ 0.85 → UPDATE (newer text, `confidence = min(1, max + 0.1)`); else ADD.
  - `recall(qv, ctx, k=5)`: one SQL computing `sim * (case when pinned then 1 else power(0.5, age_days / 30) end) * (1 + ln(1 + use_count))` over global + current-project rows, `deleted_at is null`.
  - `import_claude_memory(dirs)`: each `~/.claude/projects/*/memory/*.md` → one memory (`kind` from its frontmatter `type`, `source = {kind: "claude-memory", file}`), read-only.

### Benchmark — measure the search

- [ ] **K1 — datasets, labels, report**
  - `evaluation/loaders.py`: `load_dataset("ThakiCloud/SKILLRET", name, split="test")` for `skills`, `queries`, `qrels` → indexed into a separate schema `ctc_skillret` with the same `Store` + `build_index`; MetaTool reliability subset JSON from `github.com/HowieHwong/MetaTool`, cached in `data/raw/metatool/` (gold = none).
  - `evaluation/label.py`: user turns from `~/.claude/projects/**/*.jsonl` (skip `subagents/`, this repo's sessions, meta and tool-result rows, text starting with `<`); judge = `llm_from_env().json(...)` given the full catalog (`id: description[:100]`, ~16k tokens) → `{cap_ids: list[str], reason}`, ids not in the catalog dropped, empty = none. Split by `int(sha256(session_id), 16) % 2` (1 = test). Write `data/processed/own-eval.jsonl` and `data/processed/own-eval-review.csv` (200 test rows: `id,query,gold`).
  - `evaluation/retrieval_eval.py`: run `search()` per query in three modes (dense, hybrid, hybrid + rerank) → `ranx.Run`; `ranx.evaluate(qrels, run, ["recall@1", "recall@5", "recall@10", "ndcg@10", "mrr"])`; false-trigger rate = share of gold-none queries that did not abstain; p50/p95 per stage from `ms`. Write `data/reports/report-<date>.md` with each number next to its target (below). Baselines: SKILLRET-0.6B and bge-m3, dense-only.
- [ ] **H1** — owner hand-checks the 200 rows (`gold` column; `data/` stays local).
- [ ] **K2 — tune**: sweep `abstain_below` (0.05–0.9), candidate depth (25/50/100) and `rerank_top` (10/20/40) on dev rows; keep the best Recall@5 with false-trigger ≤ 10%; write the winners into `config/retrieval.yaml`. If Recall@5 stays < 0.90, do A1 (then A4).
- [ ] **H2** — owner reads the report; PR `m1-retrieval-core` → `main`.
- [ ] **K3 — routing speed** (`evaluation/latency_eval.py`): replay dev prompts through `POST /route`, `numpy.percentile` of wall time → report.
- [ ] **K4 — memory + adoption**: Recall@5 with vs without `recall()` memories in the query vector; extraction precision from H4's file; follow rate = `avg(followed::int)` over `ctc.decisions` since H3.

**Targets** (shown in the report): Recall@5 ≥ 0.90 (200 hand-checked rows) · hybrid + rerank NDCG@10 ≥ dense-only (SkillRet) · false-trigger ≤ 10% · GPU ≤ 7 GB · route p95 ≤ 150 ms cold, ≤ 10 ms prefetch hit · memory lift ≥ 0 · extraction precision ≥ 0.80.

### Frontend — CLI + dashboard

- [ ] **F1 — CLI** (`src/ctc/cli.py`, typer): `ctc index` (= indexer main), `ctc search "<q>" [--json]`, `ctc explain "<q>"` (table: every hit and dropped item with dense rank, sparse rank, rrf, rerank, reason), `ctc status` (capability and vector counts from the DB, TEI `/health`, library version). `httpx.ConnectError` → `embedder unreachable at <url>` on stderr, exit 1; client timeouts 2 s.
- [ ] **F2 — daemon + install**: `ctc daemon start` = `subprocess.Popen([python, "-m", "ctc.server.app"], start_new_session=True)`, pid in `~/.claudethecaller/daemon.pid`; `stop` kills it. `ctc install` backs up `~/.claude/settings.json`, then adds (only if missing):
  ```
  UserPromptSubmit: LC_ALL=C curl -sf -m 0.12 --unix-socket $HOME/.claudethecaller/ctc.sock --data-binary @- http://ctc/hook/prompt || true
  PostToolUse, Stop: same with /hook/tool and /hook/stop, -m 0.05
  ```
  and runs `claude mcp add --scope user --transport http claudethecaller http://127.0.0.1:18310/mcp` if `claude mcp get claudethecaller` fails.
- [ ] **H3** — owner runs the real `ctc install`, uses Claude Code for a day; PR `m2-agent-integration` → `main`.
- [ ] **F3 — dashboard shell** (`dashboard/`, Vite React TS): pages fetch `/api/*`. KPI cards (routing calls, adoption, lazy misses = suggested but not followed, p95, cost by tier; 7d/30d/90d/all), Recharts `AreaChart` timeline stacked by project, decision log table → drawer with the stage scores, activity heatmap as a CSS grid. `pnpm build` → `dist/`, served by the daemon.
- [ ] **F4 — control views**: library (search, enable/disable/pin/block per project via `PUT /api/capabilities/{id}/override`, dedup review), sessions (project rail + per-session decisions and memories), memories (edit, pin, delete, supersede history).
- [ ] **H6** — owner visual review.
- [ ] **F5 — workflow editor**: React Flow canvas with capability nodes from `/api/capabilities`; save → `POST /api/workflows` writes `<project>/.claude/workflows/<name>.yaml` (`{name, description, steps: [{cap, agent?}]}`), then reindex. PR `m4-dashboard` → `main`.

### AI — later

- [ ] **A1 — enrichment + dedup** (`src/ctc/ai/enrich.py`): `Enrichment(summary, triggers[8..12], prerequisites, inputs, outputs)`; `enrich(cap, llm)` = `llm.json(system prompt, name + description + body[:6000], Enrichment)`, at least 2 non-English triggers (validator, 1 retry); `enricher_version = sha256(prompt + schema + llm.spec)[:12]`; `python -m ctc.ai.enrich [--limit N]` enriches stale caps → `set_enrichment`, then dedup: for each doc vector, 5 nearest neighbours in SQL; union-find on pairs ≥ 0.92 → `cluster_id` = smallest id; pairs 0.85–0.92 → `ctc.dedup_review`; then `build_index`.
- [ ] **A2 — difficulty / model tier**: `scripts/train_difficulty.py` labels dev prompts with `llm.json → {difficulty, model_tier}`, embeds them, fits two `LogisticRegression` models, `joblib.dump` → `models/difficulty.joblib`; `decide` loads it if present.
- [ ] **A3 — memory extraction** (`src/ctc/ai/extract.py`): `extract_candidates(session_id, llm)`: redacted transcript → `llm.json → [{kind, scope, text, contradicts?}]`; `contradicts` → look up that memory and set `supersedes`; each goes through `write_memory`. `ctc memory backfill --sessions N` → `POST /api/memory/backfill` (the daemon writes).
- [ ] **H4** — owner hand-checks 50 memories into `data/processed/own-eval-memories.jsonl`; below 0.80 precision → improve the A3 prompt and redo.
- [ ] **A4 — fine-tune** (`scripts/finetune_embedder.py`; only if Recall@5 < 0.90 after A1): sentence-transformers `MultipleNegativesRankingLoss` on SkillRet train `(query, skill text)` pairs + own dev rows, 1 epoch, gradient checkpointing, small batch to stay ≤ 7 GB; save to `models/` (gitignored), point TEI at it, re-embed (`model` changes → `build_index` rewrites every vector).

---

## Memory design (used by B7, B8, A3)

- **Layers:** project profile (slow), session state (last 20 turns; topic shift at cosine < 0.55), decision history (±0.05 per follow/ignore, clamp ±0.2), long-term memory.
- **Table:** `ctc.memories(id, scope, project, kind, text, hash, source jsonb, supersedes, confidence, pinned, created_at, updated_at, last_used_at, use_count, deleted_at, embedding vector(1024))` + HNSW index.
- **Write:** ≥ 0.95 NOOP, contradiction SUPERSEDE, ≥ 0.85 UPDATE, else ADD. **Read:** top 5, similarity × recency (half-life 30 days, pinned exempt) × (1 + ln(1 + use_count)), weight 0.1 on the query vector. Claude's own memory files are imported read-only.

## Data (used by K1–K4)

| Dataset | Use |
|---|---|
| SkillRet (`ThakiCloud/SKILLRET`, 16k skills, 4,392 test queries) | main retrieval benchmark; train split for A4 |
| MetaTool reliability subset | "should any tool fire?" → abstain calibration |
| Own transcripts | in-domain set, LLM-judged, 200 hand-checked |
| SRA-Bench, ToolRet | after M1 |

Tune on dev only; test queries never come from the enricher.
