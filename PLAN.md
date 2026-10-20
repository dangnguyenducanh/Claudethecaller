# claudethecaller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local skill/workflow router that predicts what a coding agent needs from project memory and the live session, and hands Claude an explainable bundle (workflow → ordered skills → subagents → difficulty and model tier) through one MCP tool plus a prompt hook, managed by a CLI and a control dashboard.

**Architecture:** One warm Python daemon owns routing, decider and memory; the heavy lifting runs in native engines it calls (USearch C++ for vectors, SQLite FTS5 for keywords, TEI in Rust for embed/rerank, llama.cpp for the local LLM). Hooks are `curl` one-liners, MCP is served over HTTP by the same daemon, the dashboard is a static React build it serves. LLMs run only offline or async, never on the per-prompt path.

**Tech Stack:** see "Stack per component" — Python for logic and ML, TypeScript only for the UI, C++/Rust engines for speed.

**Spec:** this file, section "Product" below.

---

## Product

**Problem.** Coding agents have hundreds of skills, workflows and subagents installed but rarely call them; they solve tasks on their own, and the user must type `/plugin:skill` to get one used. Coders get no explainable, reliable record of why a capability was or wasn't used.

**Evidence.** Owner's Claude Code history (319 sessions, 2026-10-20): ~10,000 tool calls, **52 `Skill` calls (~0.5%)**, only **17 distinct skills** used against 300+ installed, mostly user-typed. SRA-Bench (2026) independently finds agents load skills at the same rate whether or not the task needs them. Generalization to other coders: assumption, validate after MVP.

**Users.** Primary: coders globally using coding agents with large skill libraries, who want the agent to pick and sequence capabilities itself with a visible rationale. Secondary: owner's AI-engineer portfolio, so it must be built from scratch (ratel, MCPGateway, metamcp and similar are references only). Not for: non-coding chat, hosted SaaS, autonomous workflow execution.

**Hypothesis.** A router that predicts intent from memory and session and returns an explainable bundle will make coding agents use the right installed capabilities without being told. Proven when, on labeled real transcripts, the follow rate rises well above the 0.5% baseline (target set after baseline labeling), Recall@5 ≥ 0.90, and latency targets hold.

**In scope (MVP, Claude Code only):** index + enrich + dedup; hybrid retrieval + rerank; decider (workflow, skills, subagents, difficulty, model tier, reasons); intent pre-calculation; **long-term memory** (cross-session facts, preferences, conventions and skill outcomes, stored with provenance and fed back into routing); one MCP meta-tool + suggest-only hook; CLI; control dashboard (incl. sessions and memory views); eval harness.

**Out of scope:** other agents (Cursor/Codex adapters later), executing workflows, hard-blocking the agent, hosted multi-user server, marketplace, training models from scratch.

**Open questions (defaults in use):** offline nodes may call the Claude API (default yes; per-prompt path stays local) · hook escalation to blocking (default never) · distribution (default `uv tool install` + `docker compose` for model servers) · labeling at scale (default LLM judge + 200 hand-checked) · adoption target (set after baseline).

## Stack per component

| Component | Stack | Why this and not something else |
|---|---|---|
| Embedding + rerank serving | **TEI** (Rust, Docker), FP16, dynamic batching | Fastest off-the-shelf encoder server; no Python in the inference loop |
| Local LLM ≤ 3B (offline/async only) | **llama.cpp `llama-server`** (C++), `Qwen2.5-3B-Instruct` Q4_K_M; Claude API (`claude-haiku-5-5`) as default | ~2.5 GB fixed footprint on a shared GPU (vLLM pre-allocates); OpenAI-compatible API with JSON-schema constrained output |
| Vector index | **USearch** (C++ core, Python binding), memory-mapped files | Embedded, no server; the C++ part of the hot path |
| Keyword index + all state | **SQLite** FTS5 + WAL (C, Python stdlib `sqlite3`) | No server; one file; BM25 built in |
| Daemon: route, prefetch, decider, memory, dashboard API, MCP | **Python 3.12**, FastAPI + uvicorn on a Unix socket and `127.0.0.1:18310`; MCP via official `mcp` SDK (FastMCP, streamable HTTP) mounted in the same app | Same language as the ML/eval code; per-prompt time is dominated by TEI calls (~5–30 ms), Python overhead ~1 ms; one process serves everything |
| Prompt hook | **`curl` one-liner** in `~/.claude/settings.json` | No runtime startup per prompt (~5 ms vs ~80 ms for Python); `-m 0.15 … \|\| true` gives fail-open for free |
| Offline pipeline: scan, enrich, dedup, index build | Python (`pyyaml`, `numpy`, `usearch`, `httpx`, `pydantic`) | Batch work next to the models |
| File watching | Python `watchfiles` (Rust-backed) | Debounce built in |
| Eval + training | Python: **`ranx`** (Recall/NDCG/MRR, tested), `datasets` (SkillRet), **scikit-learn** (difficulty classifier) | Don't hand-write IR metrics or a classifier |
| CLI `ctc` | Python **`typer`**, same package | Human-speed command; thin client to the daemon plus offline commands |
| Dashboard + workflow editor | **TypeScript**: React + Vite + Recharts + React Flow; static build served by the daemon | UI is the one place TS earns its keep |
| Dashboard e2e | Playwright (TS, inside `dashboard/`) | Lives with the UI |
| Packaging | `uv` (Python), `pnpm` (dashboard), `docker-compose.yml` (TEI, llama.cpp) | |
| Hot-path native module (M6, only if profiled) | C++ via **nanobind** on USearch's C++ API | Python-callable, same interfaces |

GPU budget: TEI embedder ~1.5 GB + TEI reranker ~1.5 GB + llama.cpp 3B Q4 ~2.5 GB ≈ 5.5 GB ≤ 7 GB.

## Global Constraints

- Every local model ≤ 3B parameters; total GPU use ≤ 7 GB (shared host, hard ceiling 14 GB).
- The prompt hook must never add more than 150 ms to a prompt and must fail open (timeout or daemon down → empty output, exit 0).
- Routing latency: p95 ≤ 10 ms on prefetch hit, p95 ≤ 100 ms on a cold query with warm models.
- Everything local by default; transcripts and memory are redacted for secrets before any call to a remote LLM.
- Capability IDs are namespaced `plugin:name` (or `user:name`, `project:name`); bare names are never keys.
- Built from scratch: no runtime dependency on existing skill routers or MCP gateways.
- Prompts in any language must be accepted (multilingual embedder).

## Review Focus

1. **Malformed capability files** → skipped with a warning, scan continues. `tests/test_capability.py`.
2. **Daemon or TEI down / slow** → hook silent, exit 0, < 150 ms; CLI clear error. `tests/test_route.py`, Task 5.
3. **Same skill name in two plugins** → two distinct IDs. `tests/test_capability.py`.
4. **Huge SKILL.md bodies** → truncated to 6,000 chars for enrichment input, full body kept. Task 4 build rule.
5. **No relevant capability** → abstain, not a weak top-1. `tests/test_retrieve.py` + false-trigger gate.

---

## Data & Metrics

**Public datasets** (download in Task 6):

| Dataset | Use |
|---|---|
| SkillRet — `huggingface.co/datasets/ThakiCloud/SKILLRET` (Apache-2.0; 16,129 skills, 4,392 test queries, qrels) | Main public retrieval benchmark; fine-tuning data later |
| SRA-Bench (arXiv 2604.24594; 5,400 instances, 636 gold in 26,262 skills) | Need-aware loading (abstain vs. load) |
| MetaTool / ToolE — `github.com/HowieHwong/MetaTool` (21k queries) | "Should any tool be used?" → abstain calibration |
| ToolRet (arXiv 2503.01763; 7.6k tasks, 43k tools) | Generalization to API/MCP tools |
| Own transcripts (`~/.claude/projects/**/*.jsonl`) | In-domain test set: LLM judge labels which installed capability should fire per turn; owner hand-checks 200 |

**Leakage rule:** test queries never come from the enricher that writes indexed trigger phrasings. Own-transcript set is the held-out truth.

**Metrics:** Recall@{1,5,10}, NDCG@10, MRR, Completeness@k (all gold items in top k), correct-abstain rate and false-trigger rate, Precision@1 of the bundle; M2 adds difficulty/model-tier macro-F1, step-order Kendall τ, follow rate; M3 adds prefetch Hit@k, memory lift (own-eval Recall@5 with vs. without memories) and extraction precision (owner hand-checks 50 extracted memories); system: p50/p95/p99 latency, cache hit rates, GPU memory.

**Baselines to beat:** `ThakiCloud/SKILLRET-Embedding-0.6B` (fine-tuned Qwen3-Embedding-0.6B) and `BAAI/bge-m3`, dense-only.

## Memory Engine (M3 design, data model starts in M1)

- **Four layers:** project profile (stack, CLAUDE.md rules → project vector + filter tags; slow), session state (ring buffer of last 20 turns, files touched, recent errors, running-average session vector; fast), decision history (bundles followed or ignored → per-project score prior), **long-term memory** (below; durable across sessions).
- **Long-term memory:**
  - *Record:* `memories(id, scope: global|project, project, kind: preference|convention|fact|skill_outcome, text, hash, source_session, source_turn, confidence, pinned, created_at, updated_at, last_used_at, use_count, deleted_at)` + vectors in `memory.usearch`.
  - *Write path (async, never on the prompt path):* on Stop/session end, a ≤3B or offline LLM extracts candidate memories from the redacted session; each candidate is embedded and matched against existing memories → `ADD` (no neighbor ≥ 0.85), `UPDATE` (neighbor ≥ 0.85, same meaning, merge text, bump confidence), `SUPERSEDE` (neighbor contradicts it → old gets `deleted_at`, new keeps a link), or `NOOP` (≥ 0.95 duplicate, only bump `use_count`). Skill outcomes are written without an LLM from decision history.
  - *Import:* one-way read of Claude Code's own memory (`~/.claude/projects/*/memory/*.md`, `CLAUDE.md`) on change, tagged `source: claude-memory`; claudethecaller never writes into Claude's files.
  - *Read path:* top 5 memories for the query vector (filtered to `global` + current project, not deleted), score = similarity × recency decay (half-life 30 days, pinned exempt) × log(1 + use_count); they shift the query vector (weight 0.1) and are returned in the bundle as `memories` with provenance.
  - *Retention:* unpinned memories with confidence < 0.3 and unused for 90 days are soft-deleted; nothing is hard-deleted except from the dashboard.
- **Storage:** RAM (session ring buffers, LRU caches) · SQLite WAL + FTS5 (`~/.claudethecaller/state.db`) · USearch files memory-mapped (`skills.usearch`, `memory.usearch`).
- **Update rules:** content-addressed (`sha256(text)` keys; recompute embedding/enrichment only on hash change) · versions in cache keys (`library_version`, `profile_version`, `model_version`), never explicit invalidation · topic shift when cosine(turn, session vector) < 0.55 → reset window and re-predict · async summary every 5 turns or on topic shift · new index built beside old, swapped by atomic rename · file events debounced 500 ms (`watchfiles`).
- **Caches:** prefetch `session_id + prompt_hash` → bundle (filled by UserPromptSubmit, read by meta-tool) · semantic result cache (recent query cosine ≥ 0.95 + `project_fp + library_version`) · embedding cache `text_hash + model_version` · rerank cache `(query_hash, cap_hash)`.

## File Structure

```
pyproject.toml  docker-compose.yml          # uv project; TEI ×2 + llama-server
ctc/capability.py   scan SKILL.md / agents / commands / workflows
ctc/store.py        SQLite schema, hashing, FTS5, overrides
ctc/models.py       Embedder, Reranker (TEI), Llm (Anthropic or OpenAI-compatible)
ctc/enrich.py       enrichment + dedup
ctc/indexer.py      USearch build, atomic swap, DenseIndex
ctc/retrieve.py     hybrid search, RRF, filters, rerank, abstain
ctc/cli.py          `ctc` (typer)
eval/datasets.py  eval/label.py  eval/run.py
tests/test_*.py  tests/fixtures/
# M2+: ctc/daemon.py ctc/decide.py ctc/memory.py ctc/ltm.py  dashboard/ (React + Vite)
```

## Verification

Two tiers, nothing else.

**Tier 1 — logic checks** (`uv run pytest`): only our own branching or math. Nothing for glue, libraries (`ranx`, SQLite, USearch), rename atomicity, or what type hints already state.

| File | Asserts (exact values) | Milestone |
|---|---|---|
| `tests/test_capability.py` | broken frontmatter → skipped, 1 warning with its path; `p1/skills/review` + `p2/skills/review` → both `p1:review`, `p2:review` present | M1 |
| `tests/test_index.py` | rebuild with no changes → 0 embedder calls; edit 1 skill → only its texts re-embedded; `library_version()` changes iff a hash changes; FTS query `kiem thu` finds `kiểm thử` | M1 |
| `tests/test_retrieve.py` | RRF k=60: item ranked (3,3) scores `2/63 = 0.03175` and beats (1,10) at `1/61 + 1/70 = 0.03068`; blocked never returned; pinned first; best rerank < τ → `hits == [] and abstained`; dedup cluster → 1 hit; dedup: cosine 0.93 merged, 0.88 → review list, 0.80 apart | M1 |
| `tests/test_route.py` | hook command with daemon down → empty stdout, exit 0, < 200 ms; `ctc install` twice → settings byte-identical; workflow hit → its declared step order; agent with rerank < 0.5 not attached; matching `Skill` call sets `followed = 1` | M2 |
| `tests/test_ltm.py` | cosine ≥ 0.95 → NOOP + `use_count` +1; 0.85–0.95 same meaning → UPDATE (1 row); contradiction → SUPERSEDE (old soft-deleted, linked); fake `sk-…` key never reaches the fake Llm; project A recall never returns project B rows; pinned skips decay; topic shift (cos < 0.55) resets window | M3 |
| `dashboard/e2e.spec.ts` (Playwright) | block a skill → `ctc search` drops it; delete a memory → next bundle's `memories` drops it | M4 |

**Tier 2 — metric gates** (`uv run eval/run.py --gate`, exit 1 on any miss; report saved to `data/report-<date>.md`):

| Metric | Gate | Data | From |
|---|---|---|---|
| Recall@5 | ≥ 0.90 | own-eval (hand-checked) | M1 |
| NDCG@10 | hybrid + rerank ≥ dense-only `SKILLRET-Embedding-0.6B` | SkillRet test | M1 |
| False-trigger rate | ≤ 10% at calibrated τ | MetaTool reliability + own no-capability turns | M1 |
| GPU memory | ≤ 7 GB | `nvidia-smi` during eval | M1 |
| Route p95 (cold, warm models) | ≤ 100 ms | own-eval replay through daemon | M2 |
| Follow rate | report; gate set once baseline labeled | own-eval replay | M2 |
| Tier macro-F1 | report; gate set once labeled | labeled subset | M2 |
| Route p95 (prefetch hit) | ≤ 10 ms | replay | M3 |
| Memory lift | Recall@5 with memories ≥ without | own-eval | M3 |
| Extraction precision | ≥ 0.80 (initial) | 50 hand-checked memories | M3 |

Every task's **Done when** names its Tier 1 row and/or Tier 2 gate. Commit after each task.

---

# Milestone 1 — Retrieval core and eval

**Exit:** Tier 1 M1 rows pass; Tier 2 M1 gates pass; `ctc explain "fix a flaky test"` shows debugging/TDD skills in the top 5 on the real library.

### Task 1: Scaffold
- [x] Own git repo, remote `origin` = `https://github.com/dangnguyenducanh/Claudethecaller` (public), branch `main`; one branch per milestone (`m1-retrieval-core`, …), merged via PR.
- [ ] `uv init --package ctc` (Python 3.12); deps `usearch numpy pyyaml httpx pydantic typer anthropic openai`; dev `pytest ruff`; eval extra `ranx datasets scikit-learn`. `.gitignore`: `.venv`, `data/`, `*.usearch`, `*.db`, `dashboard/node_modules`, `dashboard/dist`.
- [ ] **Done when:** `uv run python -c "import sqlite3,usearch.index as u; sqlite3.connect(':memory:').execute('create virtual table t using fts5(x)'); i=u.Index(ndim=4); i.add(1,[1,0,0,0]); print(i.search([1,0,0,0],1).keys)"` prints `[1]` (FTS5 available, USearch binding works).

### Task 2: Capability scanner
**Files:** `ctc/capability.py`
```python
Kind = Literal["skill", "agent", "command", "workflow"]
@dataclass(frozen=True)
class Capability: id: str; kind: Kind; name: str; namespace: str; description: str; body: str; path: str; hash: str
def scan_library(roots: list[tuple[Path, str]]) -> tuple[list[Capability], list[str]]   # (caps, warnings)
def default_roots(project_dir: Path) -> list[tuple[Path, str]]
```
- [ ] **Build:** `id = f"{namespace}:{name}"`; `hash = sha256(description + "\n" + body)`; kind by path (`skills/*/SKILL.md`, `agents/*.md`, `commands/*.md`, `workflows/*.{md,yaml}`); roots = `~/.claude/{skills,agents,commands}` (`user`), each plugin under `~/.claude/plugins/**` (plugin name), `<project>/.claude/**` (`project`). `pathlib.glob` + `yaml.safe_load`.
- [ ] **Done when:** `tests/test_capability.py` passes; real scan prints 300+ capabilities.

### Task 3: Store + index
**Files:** `ctc/store.py`, `ctc/indexer.py`
```python
Override = Literal["pin", "block", "disable"]
class Store:
    def __init__(self, path: str | Path): ...                      # ":memory:" allowed
    def upsert(self, caps: list[Capability]) -> Diff                # Diff(added, changed, removed: list[str])
    def get(self, cap_id: str) -> dict | None                       # capability + enrichment + cluster_id
    def set_enrichment(self, cap_id: str, e: Enrichment) -> None
    def set_cluster(self, cap_id: str, cluster_id: str) -> None
    def embedding(self, text_hash: str, model: str) -> np.ndarray | None
    def put_embedding(self, text_hash: str, model: str, v: np.ndarray) -> None
    def fts(self, query: str, k: int) -> list[tuple[str, float]]
    def library_version(self) -> str                                # sha256 of sorted (id, hash)
    def set_override(self, project: str, cap_id: str, action: Override | None) -> None
    def overrides(self, project: str) -> dict[str, Override]
def build_index(store: Store, embedder: Embedder, dir: Path, llm: Llm | None = None) -> BuildStats   # (vectors, enriched, clusters)
class DenseIndex:
    def __init__(self, dir: Path): ...
    def search(self, q: np.ndarray, k: int) -> list[tuple[str, float]]   # one entry per capability
```
- [ ] **Build:** `sqlite3`, WAL. Tables `capabilities`, `triggers`, `fts` (FTS5, `unicode61 remove_diacritics 2`, over name/description/summary/triggers), `embeddings`, `overrides`, `sessions`, `events`, `decisions`, `memories`. Multi-vector per capability (`name+description+summary` + one per trigger), max score per capability; embed/enrich only changed hashes; write `skills.usearch.tmp` → `os.replace`.
- [ ] **Done when:** `tests/test_index.py` passes (fake embedder = hash-to-vector).

### Task 4: Models, enrichment, dedup
**Files:** `docker-compose.yml`, `ctc/models.py`, `ctc/enrich.py`
```python
class Embedder:  model_version: str; dim: int
    async def embed(self, texts: list[str], kind: Literal["query", "doc"]) -> np.ndarray
class Reranker:
    async def score(self, query: str, docs: list[str]) -> list[float]
class Llm:
    def json(self, system: str, user: str, schema: type[BaseModel]) -> BaseModel
def llm_from_env() -> Llm        # CTC_LLM=anthropic:<model> | openai:<base_url>:<model>
class Enrichment(BaseModel): summary: str; triggers: list[str]; prerequisites: list[str]; inputs: str; outputs: str
def enrich(cap: Capability, llm: Llm) -> Enrichment
def dedup(ids: list[str], vecs: np.ndarray) -> tuple[list[list[str]], list[tuple[str, str]]]   # (clusters, review pairs)
```
- [ ] **Build:** compose: TEI `:18300` = `ThakiCloud/SKILLRET-Embedding-0.6B` (env swap to `BAAI/bge-m3`), TEI `:18301` = `BAAI/bge-reranker-v2-m3`, `llama-server` `:18302` = `Qwen2.5-3B-Instruct-Q4_K_M.gguf`. Query side uses the model card's instruction prefix. If TEI can't serve the SkillRet model, a `sentence-transformers` FastAPI sidecar on the same port/shape. Offline LLM default `anthropic:claude-haiku-5-5`, local alt `openai:http://127.0.0.1:18302/v1:qwen2.5-3b`. `enrich`: body truncated to 6,000 chars, 8–12 triggers (≥ 2 non-English) enforced by the pydantic schema. Dedup: USearch k-NN + union-find at ≥ 0.92; [0.85, 0.92) → review pairs.
- [ ] **Done when:** dedup rows of `tests/test_retrieve.py` pass; `curl` all three servers → 200; GPU ≤ 7 GB.

### Task 5: Retriever + CLI
**Files:** `ctc/retrieve.py`, `ctc/cli.py`
```python
@dataclass
class Hit: cap_id: str; score: float; stages: dict[str, float]     # dense, dense_rank, sparse_rank, rrf, rerank
@dataclass
class SearchResult: hits: list[Hit]; abstained: bool; ms: dict[str, float]
def rrf(rankings: list[list[str]], k: int = 60) -> dict[str, float]
async def search(q: str, ctx: Ctx, k: int = 5, rerank_top: int = 20, abstain_below: float = 0.3) -> SearchResult
```
- [ ] **Build:** dense 50 ∥ FTS 50 → `rrf` → drop block/disable, collapse clusters → rerank top 20 → pins to top → abstain below τ (0.3 until Task 6 calibrates) → top 5. CLI `ctc index | search [--json] | explain | status`; `explain` shows every stage score incl. dropped items with reason; TEI down → exit 1 `embedder unreachable at <url>` in < 2 s.
- [ ] **Done when:** `tests/test_retrieve.py` passes; `ctc explain "fix a flaky test"` sanity check.

### Task 6: Eval harness + gates
**Files:** `eval/datasets.py`, `eval/label.py`, `eval/run.py`
- [ ] **Build:** `datasets.load_dataset("ThakiCloud/SKILLRET")` test split and MetaTool reliability subset → temporary store/index. `label.py`: user turns from `~/.claude/projects/**/*.jsonl`, secrets redacted (API keys, tokens, credential URLs) before the judge → `data/own-eval.jsonl` + 200-row `data/own-eval-review.csv`. `run.py`: `ranx.evaluate` for `recall@1,5,10 ndcg@10 mrr`; Completeness@k = share of queries with per-query `recall@k == 1` (`return_mean=False`); abstain rates from a 2×2 count. Grid {SkillRet-0.6B, bge-m3} × {dense, hybrid, hybrid+rerank}, p50/p95 per stage, τ sweep (max correct-abstain at false-trigger ≤ 10%) written back as the `abstain_below` default; `--gate` enforces Tier 2.
- [ ] **Done when:** owner hand-checks the 200 rows; `uv run eval/run.py --gate` exits 0 on M1 gates.

---

# Milestone 2 — Agent integration and decider

**Exit:** fresh Claude Code session gets bundles without naming skills; `tests/test_route.py` + M2 gates pass.

### Task 7: Daemon, hooks, MCP
`ctc/daemon.py`: FastAPI on `~/.claudethecaller/ctc.sock` + `127.0.0.1:18310`; keeps index/store/HTTP clients warm; `ctc daemon start|stop`. Routes: `POST /hook/{event}` (raw Claude Code hook JSON in, hint text out), `POST /route`, `GET /bundle/{session}/{prompt_hash}`, `/api/*` (dashboard), `/mcp` (FastMCP streamable HTTP) and static `dashboard/dist`. `ctc install` (backup + idempotent) writes into `~/.claude/settings.json`:
```
UserPromptSubmit: curl -sf -m 0.15 --unix-socket $HOME/.claudethecaller/ctc.sock --data-binary @- http://ctc/hook/prompt || true
PostToolUse, Stop: same with /hook/tool and /hook/stop, -m 0.05
```
and runs `claude mcp add --transport http claudethecaller http://127.0.0.1:18310/mcp`. Hint line: `[claudethecaller] Suggested: <ids> — call find_capabilities for the plan`, empty when abstained.

### Task 8: Decider + meta-tool
`ctc/decide.py`:
```python
class Step(BaseModel): order: int; cap_id: str; kind: Kind; agent: str | None; reason: str
class Bundle(BaseModel):
    intent: str; confidence: float
    difficulty: Literal["trivial", "standard", "complex", "critical"]; model_tier: Literal["haiku", "sonnet", "opus"]
    workflow: str | None; steps: list[Step]; memories: list[Memory]; abstained: bool   # memories empty until M3
def decide(hits: list[Hit], ctx: Ctx) -> Bundle
```
Difficulty/tier: scikit-learn `LogisticRegression` on the query embedding, trained by `eval/train_difficulty.py` on LLM-labeled own-eval prompts → `data/difficulty.joblib`. Steps: workflow's declared order if a workflow is top, else rerank order. Agent: best `agent` hit with rerank ≥ 0.5 vs the step. Every field has a reason. MCP tool `find_capabilities(task: str, blocker: str | None)` → cached prefetch bundle or live route, plus "Use these in order; say why if you skip one." Follow tracking: matching `Skill`/`Agent`/slash calls in the same turn set `decisions.followed = 1`.

---

# Milestone 3 — Intent pre-calculation, memory engine, long-term memory

**Exit:** `tests/test_ltm.py` + M3 gates pass.

### Task 9: Session + project memory, prefetch
`ctc/memory.py`: `ProjectProfile` (hash of CLAUDE.md + memory dir + manifests + `.git/HEAD`, watched with `watchfiles`), `SessionState` (ring 20, running vector, topic shift < 0.55), decision prior (±0.05 per follow/ignore, clamp ±0.2). Query vector = normalize(0.6·prompt + 0.25·session + 0.15·project), tuned on own-eval. Prefetch on `/hook/prompt` and on `/hook/tool` errors; semantic cache ≥ 0.95 keyed with `library_version + profile_version`; async summary every 5 turns.

### Task 10: Long-term memory
`ctc/ltm.py`, implements "Long-term memory" above:
```python
class Memory(BaseModel):
    id: str; scope: Literal["global", "project"]; project: str | None
    kind: Literal["preference", "convention", "fact", "skill_outcome"]
    text: str; confidence: float; pinned: bool; source: dict      # session, turn, file
def extract_candidates(session_id: str, llm: Llm) -> list[Memory]
def write_memory(c: Memory, ctx: Ctx) -> tuple[Literal["ADD", "UPDATE", "SUPERSEDE", "NOOP"], str]
def recall(qv: np.ndarray, project: str, k: int = 5) -> list[Memory]
def import_claude_memory(dirs: list[Path]) -> int
```

---

# Milestone 4 — Control dashboard (TypeScript)

`dashboard/` (React + Vite + Recharts, `pnpm build` → `dist/` served by the daemon at `:18310`; reads/writes `/api/*`): KPI cards 7d/30d/90d/all (routing calls, adoption, lazy misses, p95, tokens saved, cost by tier) · stacked timeline by project/capability · decision log → explain drawer (stage scores + memories used) · library control (enable/disable/pin/block per project, dedup review merge/keep, re-enrich) · sessions view (project rail with counts; per session title, model, agent time, tokens, turns, decisions, extracted memories) · memory view (search/filter, edit, pin, delete, supersede history, link to source session) · activity heatmap. Writes take effect on the next route. **Done when:** `dashboard/e2e.spec.ts` passes.

# Milestone 5 — Visual workflow editor (TypeScript)

React Flow canvas → `<project>/.claude/workflows/<name>.yaml` (`{ name, description, steps: [{ cap, agent?, when? }] }`), indexed by Task 2, expanded by Task 8. **Done when:** a saved workflow shows up in `ctc search` and its bundle keeps the drawn step order.

# Milestone 6 — C++ hot path (only if profiling justifies)

Gate: `py-spy` on the daemon under eval replay shows Python fusion/filter/graph code > 20% of `/route` p95. Then `native/` (CMake + nanobind on USearch's C++ API: filtered search + RRF + cluster collapse in one call) behind the same `DenseIndex` / `search` signatures. **Done when:** identical rankings on the full eval set and lower p95 in the gate report.
