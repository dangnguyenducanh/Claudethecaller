# claudethecaller Plan

**Goal:** a local router that predicts what a coding agent needs from project memory and the live session, and hands Claude an explainable bundle (workflow → ordered skills → subagents → difficulty and model tier) through one MCP tool plus a prompt hook, managed by a CLI and a dashboard.

**Architecture:** one warm Python daemon does routing, deciding and memory. One database: Supabase Postgres (tables, pgvector for vectors, full-text search for keywords). Local engines: TEI (embed/rerank), llama.cpp (local LLM). The hook is a `curl` one-liner; MCP and the dashboard are served by the same daemon. LLMs never run on the per-prompt path.

---

## Product

- **Problem:** agents rarely call installed skills/workflows/subagents; the user has to type `/plugin:skill`. No record of why a capability was or wasn't used.
- **Evidence:** owner's history (319 sessions, 2026-10-20): ~10,000 tool calls, 52 `Skill` calls (~0.5%), 17 distinct skills of 300+ installed. SRA-Bench (2026) sees the same.
- **Users:** coders with large skill libraries. Portfolio project, so built from scratch (ratel, MCPGateway, metamcp are references only).
- **Proven when:** after install, the Skill/Agent share of tool calls rises well above 0.5%, Recall@5 ≥ 0.90, latency targets hold.
- **In scope (Claude Code only):** index, hybrid search + rerank, decider, prefetch, long-term memory, MCP tool + suggest-only hook, CLI, dashboard, eval.
- **Out of scope:** other agents, executing workflows, blocking the agent, hosted SaaS, marketplace, training models from scratch.

## Stack

| Part | Stack |
|---|---|
| Embed + rerank | TEI (Rust, Docker), FP16 |
| Local LLM (offline only) | llama.cpp `llama-server`, `Qwen2.5-3B-Instruct` Q4_K_M, `-c 32768 -np 1`; Claude API only when `ANTHROPIC_API_KEY` is set |
| Database (tables, vectors, keywords) | Supabase project `claudethecaller` (`iecwnlyqjbigeiobmurn`, ap-southeast-1), Postgres 17 + pgvector (HNSW, cosine) + full-text search with `unaccent`; tables in schema `ctc` (not exposed by the Data API); Python `psycopg` + `pgvector`, via the IPv4 pooler (`CTC_DATABASE_URL` in `.env`) |
| Daemon (route, decide, memory, API, MCP) | Python 3.12, FastAPI + uvicorn, official `mcp` SDK; Unix socket + `127.0.0.1:18310` |
| Hook | `curl` one-liner, fail-open |
| Eval + training | `ranx`, `datasets`, scikit-learn |
| CLI | `typer` |
| Dashboard + workflow editor | TypeScript: React + Vite + Recharts + React Flow, Playwright e2e |
| Packaging | `uv`, `pnpm`, `docker-compose.yml` |

## Constraints

- Local models ≤ 3B; our GPU use ≤ 7 GB (shared host). GPU use = `nvidia-smi --query-compute-apps` summed over this project's `docker compose top` PIDs, never whole-GPU.
- Hook adds ≤ 150 ms and fails open (daemon down → empty output, exit 0).
- Routing p95 ≤ 10 ms on prefetch hit (served from daemon RAM), ≤ 150 ms cold (one SQL round trip to Singapore is ~65 ms).
- Models run locally. Capabilities, decisions and memories live in Supabase; eval data in `data/` stays local; `Llm.json` strips secrets from every LLM call; the DB password lives only in `.env` (gitignored).
- IDs are namespaced: `plugin:name`, `user:name`, `project@<sha8>:name`. Claude-facing names use `invoke` (`name` for user/project, else the id).
- Any prompt language.

## Data & metrics

| Dataset | Use |
|---|---|
| SkillRet (`ThakiCloud/SKILLRET`, 16k skills, 4,392 test queries) | main retrieval benchmark |
| MetaTool reliability subset | "should any tool fire?" → abstain calibration |
| Own transcripts (`~/.claude/projects/**/*.jsonl`) | in-domain test set, LLM-judged, owner hand-checks 200 |
| SRA-Bench, ToolRet | after M1 |

- **Split:** own-eval dev/test by `int(sha256(session_id), 16) % 2` (1 = test). Tune on dev only; test is scored only by `--gate`. Test queries never come from the enricher.
- **Metrics:** Recall@{1,5,10}, NDCG@10, MRR, false-trigger rate; later p95 latency, follow rate, memory lift.
- **Baselines:** `ThakiCloud/SKILLRET-Embedding-0.6B` and `BAAI/bge-m3`, dense-only.

## Memory design (M3)

- **Layers:** project profile (CLAUDE.md, manifests → project vector), session state (last 20 turns, running vector; topic shift at cosine < 0.55), decision history (±0.05 per follow/ignore, clamp ±0.2), long-term memory.
- **Long-term memory:** `ctc.memories(id, scope, project, kind, text, hash, source, supersedes, confidence, pinned, created_at, updated_at, last_used_at, use_count, deleted_at, embedding vector)`. Write: ≥ 0.95 NOOP (bump `use_count`), 0.85–0.95 UPDATE, contradiction SUPERSEDE (old soft-deleted), else ADD. Read: top 5 for global + current project, score = similarity × recency (half-life 30 days, pinned exempt) × (1 + log(1 + use_count)); weight 0.1 on the query vector. Claude's own memory files are imported read-only.
- **Query vector:** normalize(0.6·prompt + 0.25·session + 0.15·project).
- **Storage:** Supabase tables in schema `ctc`; memory vectors in a pgvector column with an HNSW index.

## Files

```
pyproject.toml  docker-compose.yml
ctc/capability.py  scan skills/agents/commands/workflows      (done)
ctc/models.py      Embedder, Reranker, Llm clients             (done)
ctc/schema.sql     tables, pgvector + FTS indexes (schema `ctc`, idempotent)
ctc/store.py       Postgres CRUD, vector + keyword queries
ctc/indexer.py     embed capabilities into the DB
ctc/retrieve.py    hybrid search
ctc/cli.py         `ctc`
ctc/daemon.py  ctc/decide.py  ctc/memory.py  ctc/ltm.py  ctc/enrich.py
eval/loaders.py  eval/label.py  eval/run.py  eval/train_difficulty.py  eval/gates.toml
dashboard/
tests/test_*.py
```

## Tests

**Logic tests** (`uv run pytest`; fake embedder/reranker/LLM, no GPU; DB tests run in a throwaway schema `ctc_test_<pid>` in the Supabase project, dropped after):

| File | Checks |
|---|---|
| `test_capability.py` | broken frontmatter skipped with 1 warning; same name in two plugins → two ids (done) |
| `test_index.py` | unchanged rebuild → 0 embed calls; edit 1 skill → only it re-embedded; FTS `kiem thu` finds `kiểm thử`; FTS with quotes/blank doesn't raise |
| `test_retrieve.py` | RRF k=60: ranks (3,3) = 0.03175 beat (1,10) = 0.03068; blocked never returned; pinned first; best rerank < τ → abstain; same `cluster_id` → 1 hit; secrets never reach the LLM |
| `test_route.py` | hook with daemon down → empty, exit 0, < 150 ms; `ctc install` twice → identical settings; workflow keeps its step order; `Skill` call matching a step sets `followed = 1` |
| `test_ltm.py` | NOOP/UPDATE/SUPERSEDE thresholds; project A never sees project B; pinned skips decay; topic shift resets session |
| `test_enrich.py` | dedup: 0.93 merged, 0.88 review, 0.80 apart |
| `dashboard/e2e.spec.ts` | block a skill → search drops it; delete a memory → bundle drops it |

**Metric gates** (`uv run eval/run.py --gate mN`, exit 1 on a miss; thresholds in `eval/gates.toml`):

| Gate | Threshold | Data | Group |
|---|---|---|---|
| Recall@5 | ≥ 0.90 | 200 hand-checked test rows | m1 |
| NDCG@10 | hybrid + rerank ≥ dense-only | SkillRet test | m1 |
| False-trigger | ≤ 10% | MetaTool test half + test rows with no gold | m1 |
| GPU use | ≤ 7 GB | during eval | m1 |
| Route p95 cold | ≤ 150 ms | replay through daemon | m2 |
| Route p95 prefetch hit | ≤ 10 ms | replay | m3 |
| Memory lift | Recall@5 with memories ≥ without | own test rows | m3 |
| Extraction precision | ≥ 0.80 | 50 hand-checked memories | m3 |

---

## Build order

Four tracks. Each step ends when its **Done when** exits 0; commit, go on. H = owner step.

**Order:** B3 → B4 → K1 → F1 → H1 → K2 → H2 → B5 → B6 → F2 → K3 → H3 → A1, A2 → B7 → B8 → A3 → H4 → K4 → F3 → F4 → H6 → F5.

**Branches:** `m1-retrieval-core` (B1–B4, K1–K2, F1), `m2-agent-integration` (B5–B6, F2, K3), `m3-memory` (B7–B8, A3, K4), `m4-dashboard` (F3–F4), `ai-<name>` per AI step; PR into `main` at the end of each.

**Rules:** stay in the step's scope; never weaken a test; never edit `eval/gates.toml` or `data/own-eval*` after K1; no secrets, `.env`, `data/` or weights in commits; never write the real `~/.claude/` (use a temp `HOME`); if only the owner can unblock it, say so and stop.

### Backend — API + databases

- [x] **B1** — uv package + capability scanner (`ctc/capability.py`, 632 capabilities found).
- [x] **B2** — model servers (`docker-compose.yml`) + clients (`ctc/models.py`), ~6.4 GB GPU.
- [x] **B2b** — Supabase project `claudethecaller` created (free tier); pgvector 0.8.2, unaccent, pg_trgm available.
- [ ] **H0** — owner puts the pooler connection string (Supabase dashboard → Connect → Session pooler) in `.env` as `CTC_DATABASE_URL`
- [ ] **B3** — `ctc/schema.sql` + Postgres store (CRUD for capabilities, overrides, sessions, events, decisions, memories) + vectors (pgvector HNSW) on name + description (+ enrichment once A1 exists); swap `usearch` for `psycopg[binary]` + `pgvector` in `pyproject.toml`. **Done when:** `uv run pytest tests/test_index.py` exits 0 AND `uv run python -m ctc.indexer` prints the vector count stored in Supabase
- [ ] **B4** — hybrid search: dense 50 ∥ FTS 50 → RRF → drop blocked → collapse clusters → rerank top 20 → pins first → abstain below τ (0.3 until K2) → top 5. **Done when:** `uv run pytest tests/test_retrieve.py` exits 0 AND `uv run python -m ctc.retrieve "fix a flaky test"` has `superpowers:systematic-debugging`, `superpowers:test-driven-development` or `ecc:tdd-workflow` in its top 5
- [ ] **B5** — daemon: `/hook/{event}`, `/route`, `/bundle/{ref}`, `/mcp`, `/api/*` CRUD. **Done when:** hook rows of `tests/test_route.py` pass AND `echo '{"prompt":"fix a flaky test","session_id":"t"}' | curl -s --unix-socket ~/.claudethecaller/ctc.sock --data-binary @- http://ctc/hook/prompt` prints `[claudethecaller] Suggested:`
- [ ] **B6** — bundle + `find_capabilities` MCP tool + follow tracking. **Done when:** `uv run pytest tests/test_route.py` exits 0
- [ ] **B7** — project profile, session state, prefetch, semantic cache. **Done when:** topic-shift test passes AND replay shows prefetch-hit p95 ≤ 10 ms
- [ ] **B8** — long-term memory store (write/recall/import). **Done when:** `uv run pytest tests/test_ltm.py` exits 0

### Benchmark — measure the search

- [ ] **K1** — SkillRet + MetaTool loaders, transcript labeler, report, `eval/gates.toml`. **Done when:** `data/own-eval.jsonl` has ≥ 300 rows (≥ 100 dev), `data/own-eval-review.csv` has 200 test rows, `uv run eval/run.py` writes `data/report-<date>.md`
- [ ] **H1** — owner hand-checks the 200 rows (`gold` column; `data/` stays local)
- [ ] **K2** — tune τ, fusion and rerank depth on dev until m1 passes; if Recall@5 < 0.90, do A1 (then A4). **Done when:** `uv run eval/run.py --gate m1` exits 0
- [ ] **H2** — owner reads the report, PR `m1-retrieval-core` → `main`
- [ ] **K3** — replay through the daemon, add latency to the report. **Done when:** `uv run eval/run.py --gate m2` exits 0
- [ ] **K4** — memory lift, extraction precision, follow rate. **Done when:** `uv run eval/run.py --gate m3` exits 0

### Frontend — CLI + dashboard

- [ ] **F1** — `ctc index | search [--json] | explain | status`; embedder down → exit 1 `embedder unreachable at <url>` in < 2 s. **Done when:** `uv run ctc search --json "fix a flaky test"` matches B4's top 5 AND `uv run ctc explain "fix a flaky test"` exits 0
- [ ] **F2** — `ctc daemon start|stop`, `ctc install`. **Done when:** install rows of `tests/test_route.py` pass
- [ ] **H3** — owner runs the real `ctc install`, uses Claude Code for a day; PR `m2-agent-integration` → `main`
- [ ] **F3** — dashboard: KPI cards, timeline, decision log with explain drawer, heatmap. **Done when:** `pnpm -C dashboard build` exits 0 AND `curl -s 127.0.0.1:18310/api/kpis` has `routing_calls` > 0
- [ ] **F4** — library control, sessions view, memory view. **Done when:** `pnpm -C dashboard exec playwright test` exits 0
- [ ] **H6** — owner visual review; PR `m4-dashboard` → `main`
- [ ] **F5** — React Flow editor → `.claude/workflows/<name>.yaml`. **Done when:** a saved workflow comes back from `ctc search` with its step order

### AI — later

- [ ] **A1** — LLM enrichment (summary, trigger phrasings) + dedup clusters into the store, then rebuild the index. **Done when:** `uv run pytest tests/test_enrich.py` exits 0 AND `uv run python -m ctc.enrich --limit 5` prints 5 valid enrichments
- [ ] **A2** — difficulty / model-tier classifier (LogisticRegression on the query embedding). **Done when:** `uv run eval/train_difficulty.py` prints macro-F1 and writes `data/difficulty.joblib`
- [ ] **A3** — memory extraction + `ctc memory backfill`. **Done when:** `uv run ctc memory backfill --sessions 30` writes ≥ 50 memories
- [ ] **H4** — owner hand-checks 50 memories; below 0.80 precision → redo A3
- [ ] **A4** — only if K2 misses Recall@5 after A1: fine-tune the embedder on SkillRet train + own dev rows (≤ 3B). **Done when:** `--gate m1` passes with it

---

## Spec

### Store + index (B3)
```python
Override = Literal["pin", "block", "disable"]
class Store:
    def __init__(self, path: str | Path): ...                       # ":memory:" allowed
    def upsert(self, caps: list[Capability], namespaces: list[str]) -> Diff   # added/changed/removed ids
    def get(self, cap_id: str) -> dict | None
    def set_enrichment(self, cap_id: str, e: Enrichment, version: str) -> None
    def set_cluster(self, cap_id: str, cluster_id: str) -> None
    def embedding(self, text_hash: str, model: str) -> np.ndarray | None
    def put_embedding(self, text_hash: str, model: str, v: np.ndarray) -> None
    def fts(self, query: str, k: int) -> list[tuple[str, float]]     # websearch_to_tsquery over unaccent text; blank → []
    def dense(self, qv: np.ndarray, k: int) -> list[tuple[str, float]]   # pgvector cosine, max score per capability
    def library_version(self) -> str
    def set_override(self, project: str, cap_id: str, action: Override | None) -> None
    def overrides(self, project: str) -> dict[str, Override]
async def build_index(store: Store, embedder: Embedder) -> int   # vectors written
```
`Store(os.environ["CTC_DATABASE_URL"])`, schema `ctc`, `schema.sql` applied on connect (idempotent). Keyword search: a generated `tsvector` over `unaccent(name || description || summary || triggers)` with a GIN index. One vector per capability text (name + description + summary) plus one per trigger; embed only changed text hashes. Dense + FTS run in one SQL round trip.

### Search (B4)
```python
@dataclass
class Ctx: store: Store; embedder: Embedder; reranker: Reranker; project: str
@dataclass
class Hit: cap_id: str; score: float; stages: dict[str, float]
@dataclass
class SearchResult: hits: list[Hit]; abstained: bool; ms: dict[str, float]; dropped: list[tuple[Hit, str]]
def rrf(rankings: list[list[str]], k: int = 60) -> dict[str, float]
async def search(q: str, ctx: Ctx, k: int = 5, rerank_top: int = 20, abstain_below: float = 0.3) -> SearchResult
```

### Eval (K1–K2)
`label.py`: user turns from `~/.claude/projects/**/*.jsonl` (skip `subagents/` and this repo's own sessions, skip meta/tool-result rows); judge = `llm_from_env()` over the full catalog (id + description), may answer `none`; writes `data/own-eval.jsonl` and `data/own-eval-review.csv` (`id,query,gold`). `run.py`: `ranx.evaluate` on `search()` hits; grid {dense, hybrid, hybrid + rerank}; τ sweep on dev = lowest τ with false-trigger ≤ 10%, written back as the `abstain_below` default.

### Daemon + hook (B5, F2)
`ctc install` (backup first, idempotent) adds to `~/.claude/settings.json`:
```
UserPromptSubmit: LC_ALL=C curl -sf -m 0.12 --unix-socket $HOME/.claudethecaller/ctc.sock --data-binary @- http://ctc/hook/prompt || true
PostToolUse, Stop: same with /hook/tool and /hook/stop, -m 0.05
```
and `claude mcp add --scope user --transport http claudethecaller http://127.0.0.1:18310/mcp` if missing. Hint: `[claudethecaller] Suggested: <invoke names> — call find_capabilities(ref="<ref>") for the plan`, empty when abstained. `ref` = first 8 hex of sha256(session_id + prompt).

### Bundle (B6)
```python
class Step(BaseModel): order: int; cap_id: str; invoke: str; kind: Kind; agent: str | None; reason: str
class Bundle(BaseModel):
    intent: str; confidence: float
    difficulty: Literal["trivial", "standard", "complex", "critical"]   # "standard" until A2
    model_tier: Literal["haiku", "sonnet", "opus"]                        # "sonnet" until A2
    workflow: str | None; steps: list[Step]; memories: list[Memory]; abstained: bool
async def decide(hits: list[Hit], ctx: Ctx) -> Bundle
```
Steps follow the workflow's order when a workflow is top, else rerank order. Agent attached only if its rerank ≥ 0.5. MCP tool `find_capabilities(task, blocker=None, ref=None)` returns the prefetched bundle when `ref` hits. A `Skill`/`Agent`/slash call matching a step's `invoke` in the same turn sets `decisions.followed = 1`.

### Long-term memory (B8, A3)
```python
class Memory(BaseModel):
    id: str; scope: Literal["global", "project"]; project: str | None
    kind: Literal["preference", "convention", "fact", "skill_outcome"]
    text: str; confidence: float; pinned: bool; source: dict
def extract_candidates(session_id: str, llm: Llm) -> list[Memory]                 # A3
async def write_memory(c: Memory, ctx: Ctx) -> tuple[Literal["ADD", "UPDATE", "SUPERSEDE", "NOOP"], str]
def recall(qv: np.ndarray, ctx: Ctx, k: int = 5) -> list[Memory]
async def import_claude_memory(dirs: list[Path], ctx: Ctx) -> int
```

### Dashboard (F3–F5)
`dashboard/` (React + Vite + Recharts), built to `dist/`, served by the daemon at `:18310`, reads/writes `/api/*`. Views: KPIs (7d/30d/90d/all), timeline, decision log → explain drawer, library control (enable/disable/pin/block, dedup review), sessions, memories (edit/pin/delete), heatmap. Writes apply on the next route. F5 adds a React Flow editor saving `{ name, description, steps: [{ cap, agent? }] }`.
