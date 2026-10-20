# claudethecaller Implementation Plan

> **Execution:** gnhf rounds (see "Rounds (run with gnhf)"). Inside a round, work directly: no plan-execution skills, no git commits (gnhf commits). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local skill/workflow router that predicts what a coding agent needs from project memory and the live session, and hands Claude an explainable bundle (workflow → ordered skills → subagents → difficulty and model tier) through one MCP tool plus a prompt hook, managed by a CLI and a control dashboard.

**Architecture:** One warm Python daemon owns routing, decider and memory; the heavy lifting runs in native engines it calls (USearch C++ for vectors, SQLite FTS5 for keywords, TEI in Rust for embed/rerank, llama.cpp for the local LLM). Hooks are `curl` one-liners, MCP is served over HTTP by the same daemon, the dashboard is a static React build it serves. LLMs run only offline or async, never on the per-prompt path.

**Tech Stack:** see "Stack per component" — Python for logic and ML, TypeScript only for the UI, C++/Rust engines for speed.

**Spec:** this file, section "Product" below.

---

## Product

**Problem.** Coding agents have hundreds of skills, workflows and subagents installed but rarely call them; they solve tasks on their own, and the user must type `/plugin:skill` to get one used. Coders get no explainable, reliable record of why a capability was or wasn't used.

**Evidence.** Owner's Claude Code history (319 sessions, 2026-10-20): ~10,000 tool calls, **52 `Skill` calls (~0.5%)**, only **17 distinct skills** used against 300+ installed, mostly user-typed. SRA-Bench (2026) independently finds agents load skills at the same rate whether or not the task needs them. Generalization to other coders: assumption, validate after MVP.

**Users.** Primary: coders globally using coding agents with large skill libraries, who want the agent to pick and sequence capabilities itself with a visible rationale. Secondary: owner's AI-engineer portfolio, so it must be built from scratch (ratel, MCPGateway, metamcp and similar are references only). Not for: non-coding chat, hosted SaaS, autonomous workflow execution.

**Hypothesis.** A router that predicts intent from memory and session and returns an explainable bundle will make coding agents use the right installed capabilities without being told. Proven when, on post-install sessions, the Skill/Agent share of tool calls rises well above the 0.5% baseline (target set after baseline labeling), Recall@5 ≥ 0.90, and latency targets hold.

**In scope (MVP, Claude Code only):** index + enrich + dedup; hybrid retrieval + rerank; decider (workflow, skills, subagents, difficulty, model tier, reasons); intent pre-calculation; **long-term memory** (cross-session facts, preferences, conventions and skill outcomes, stored with provenance and fed back into routing); one MCP meta-tool + suggest-only hook; CLI; control dashboard (incl. sessions and memory views); eval harness.

**Out of scope:** other agents (Cursor/Codex adapters later), executing workflows, hard-blocking the agent, hosted multi-user server, marketplace, training models from scratch.

**Open questions (defaults in use):** offline nodes may call the Claude API (only when `ANTHROPIC_API_KEY` is set, else local llama-server; per-prompt path stays local) · hook escalation to blocking (default never) · distribution (default `uv tool install` + `docker compose` for model servers) · labeling at scale (default LLM judge + 200 hand-checked) · adoption target (set after baseline).

## Stack per component

| Component | Stack | Why this and not something else |
|---|---|---|
| Embedding + rerank serving | **TEI** (Rust, Docker), FP16, dynamic batching | Fastest off-the-shelf encoder server; no Python in the inference loop |
| Local LLM ≤ 3B (offline/async only) | **llama.cpp `llama-server`** (C++), `Qwen2.5-3B-Instruct` Q4_K_M, `-c 32768 -np 1`, the default; Claude API (`claude-haiku-5-5`) only when `ANTHROPIC_API_KEY` is set | ~2.5 GB + 1.2 GB KV fixed footprint on a shared GPU (vLLM pre-allocates); OpenAI-compatible API with JSON-schema constrained output |
| Vector index | **USearch** (C++ core, Python binding), memory-mapped files | Embedded, no server; the C++ part of the hot path |
| Keyword index + all state | **SQLite** FTS5 + WAL (C, Python stdlib `sqlite3`) | No server; one file; BM25 built in |
| Daemon: route, prefetch, decider, memory, dashboard API, MCP | **Python 3.12**, FastAPI + uvicorn on a Unix socket and `127.0.0.1:18310`; MCP via official `mcp` SDK (FastMCP, streamable HTTP) mounted in the same app | Same language as the ML/eval code; per-prompt time is dominated by TEI calls (~5–30 ms), Python overhead ~1 ms; one process serves everything |
| Prompt hook | **`curl` one-liner** in `~/.claude/settings.json` | No runtime startup per prompt (~5 ms vs ~80 ms for Python); `-m 0.12 … \|\| true` gives fail-open for free |
| Offline pipeline: scan, enrich, dedup, index build | Python (`pyyaml`, `numpy`, `usearch`, `httpx`, `pydantic`) | Batch work next to the models |
| File watching | Python `watchfiles` (Rust-backed) | Debounce built in |
| Eval + training | Python: **`ranx`** (Recall/NDCG/MRR, tested), `datasets` (SkillRet), **scikit-learn** (difficulty classifier) | Don't hand-write IR metrics or a classifier |
| CLI `ctc` | Python **`typer`**, same package | Human-speed command; thin client to the daemon plus offline commands |
| Dashboard + workflow editor | **TypeScript**: React + Vite + Recharts + React Flow; static build served by the daemon | UI is the one place TS earns its keep |
| Dashboard e2e | Playwright (TS, inside `dashboard/`) | Lives with the UI |
| Packaging | `uv` (Python), `pnpm` (dashboard), `docker-compose.yml` (TEI, llama.cpp) | |
| Hot-path native module (M6, only if profiled) | C++ via **nanobind** on USearch's C++ API | Python-callable, same interfaces |

GPU budget: TEI embedder ~1.5 GB + TEI reranker ~1.5 GB + llama.cpp 3B Q4 ~2.5 GB + 32k KV ~1.2 GB ≈ 6.7 GB ≤ 7 GB. **GPU use** (R3 stop, Tier 2 gate) = sum of `used_memory` from `nvidia-smi --query-compute-apps=pid,used_memory --format=csv` over the PIDs in `docker compose top` for this project; never whole-GPU `memory.used`, never a process-name match (another service runs llama-server here). Over 7 GB → lower TEI `--max-batch-tokens` first.

## Global Constraints

- Every local model ≤ 3B parameters; total GPU use ≤ 7 GB (shared host, hard ceiling 14 GB).
- The prompt hook must never add more than 150 ms to a prompt and must fail open (timeout or daemon down → empty output, exit 0).
- Routing latency: p95 ≤ 10 ms on prefetch hit, p95 ≤ 100 ms on a cold query with warm models.
- Everything local by default (Claude API only when `ANTHROPIC_API_KEY` is set); `Llm.json` redacts secrets from every LLM call.
- Capability IDs are namespaced `plugin:name` (or `user:name`, `project@<sha8>:name`); bare names are never keys. Claude-facing text and follow matching use `invoke`: `name` for `user`/`project@…`, else the id.
- `project` (Ctx, overrides, memories) = resolved project_dir; its namespace is `project@<sha256(project)[:8]>`.
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

**Public datasets** (SkillRet and MetaTool download in Task 6; SRA-Bench and ToolRet after M1):

| Dataset | Use |
|---|---|
| SkillRet — `huggingface.co/datasets/ThakiCloud/SKILLRET` (Apache-2.0; 16,129 skills, 4,392 test queries, qrels) | Main public retrieval benchmark; fine-tuning data later |
| SRA-Bench (arXiv 2604.24594; 5,400 instances, 636 gold in 26,262 skills) | Need-aware loading (abstain vs. load) |
| MetaTool / ToolE — `github.com/HowieHwong/MetaTool` (21k queries) | "Should any tool be used?" → abstain calibration |
| ToolRet (arXiv 2503.01763; 7.6k tasks, 43k tools) | Generalization to API/MCP tools |
| Own transcripts (`~/.claude/projects/**/*.jsonl`) | In-domain test set: LLM judge labels which installed capability should fire per turn; owner hand-checks 200 |

**Leakage rule:** test queries never come from the enricher that writes indexed trigger phrasings. Own-eval is split dev/test by `int(sha256(session_id), 16) % 2` (1 = test); the test split (the 200 hand-checked rows + the MetaTool reliability half chosen by the same rule on its query id) is scored only by `--gate`, aggregates only. All tuning (enrichment prompts, triggers, fusion/rerank depth, τ, M3 weights, difficulty classifier) uses dev only.

**Metrics:** Recall@{1,5,10}, NDCG@10, MRR, Completeness@k (all gold items in top k), correct-abstain rate and false-trigger rate, Precision@1 of the bundle; M2 adds difficulty/model-tier macro-F1, step-order Kendall τ, follow rate; M3 adds prefetch Hit@k, memory lift (own-eval Recall@5 with vs. without memories) and extraction precision (owner hand-checks 50 extracted memories); system: p50/p95/p99 latency, cache hit rates, GPU memory.

**Baselines to beat:** `ThakiCloud/SKILLRET-Embedding-0.6B` (fine-tuned Qwen3-Embedding-0.6B) and `BAAI/bge-m3`, dense-only.

## Memory Engine (M3 design, data model starts in M1)

- **Four layers:** project profile (stack, CLAUDE.md rules → project vector + filter tags; slow), session state (ring buffer of last 20 turns, files touched, recent errors, running-average session vector; fast), decision history (bundles followed or ignored → per-project score prior), **long-term memory** (below; durable across sessions).
- **Long-term memory:**
  - *Record:* `memories(id, scope: global|project, project, kind: preference|convention|fact|skill_outcome, text, hash, source (JSON = Memory.source: {session, turn, file} or {kind: "claude-memory", file}), supersedes, confidence, pinned, created_at, updated_at, last_used_at, use_count, deleted_at)` + vectors in `memory.usearch`.
  - *Write path (async, never on the prompt path):* on Stop/session end, a ≤3B or offline LLM extracts candidate memories from the redacted session; each candidate is embedded and matched against existing memories → `ADD` (no neighbor ≥ 0.85), `UPDATE` (neighbor ≥ 0.85, same meaning, merge text, bump confidence), `SUPERSEDE` (neighbor contradicts it → old gets `deleted_at`, new gets `supersedes` = old id), or `NOOP` (≥ 0.95 duplicate, only bump `use_count`). Skill outcomes are written without an LLM from decision history.
  - *Import:* one-way read of Claude Code's own memory (`~/.claude/projects/*/memory/*.md`, `CLAUDE.md`) on change, `source.kind = "claude-memory"`; claudethecaller never writes into Claude's files.
  - *Read path:* top 5 memories for the query vector (filtered to `global` + current project, not deleted), score = similarity × recency decay (half-life 30 days, pinned exempt) × (1 + log(1 + use_count)); they shift the query vector (weight 0.1) and are returned in the bundle as `memories` with provenance.
  - *Retention:* unpinned memories with confidence < 0.3 and unused for 90 days are soft-deleted; nothing is hard-deleted except from the dashboard.
- **Storage:** RAM (session ring buffers, LRU caches) · SQLite WAL + FTS5 (`~/.claudethecaller/state.db`) · USearch: `skills.usearch` memory-mapped (view=True, rebuilt and swapped tmp → `os.replace`); `memory.usearch` held writable in RAM by the daemon (`Index.restore(view=False)`), updated in place by `write_memory`, saved tmp → `os.replace` once per write batch; the daemon is its only writer (`ctc memory backfill` calls `POST /api/memory/backfill`).
- **Update rules:** content-addressed (`sha256(text)` keys; recompute embedding/enrichment only on hash change) · versions in cache keys (`library_version`, `profile_version`, `model_version`, `enricher_version` = sha256(enrich prompt + Enrichment JSON schema + resolved LLM spec)), never explicit invalidation · topic shift when cosine(turn, session vector) < 0.55 → reset window and re-predict · async summary every 5 turns or on topic shift · new index built beside old, swapped by atomic rename · file events debounced 500 ms (`watchfiles`).
- **Caches:** prefetch `ref` → bundle (`ref` = first 8 hex of sha256(session_id + prompt), filled by UserPromptSubmit, read by the meta-tool) · semantic result cache (recent query cosine ≥ 0.95 + `library_version + profile_version + state_version`; `state_version` = counter in state.db bumped by SQLite triggers on `overrides` and on memory add/edit/pin/delete/supersede (not `use_count`/`last_used_at`), and by each index swap) · embedding cache `text_hash + model_version` · rerank cache `(query_hash, cap_hash)`.

## File Structure

```
pyproject.toml  docker-compose.yml          # uv project; TEI ×2 + llama-server
ctc/capability.py   scan SKILL.md / agents / commands / workflows
ctc/store.py        SQLite schema, hashing, FTS5, overrides
ctc/models.py       Embedder, Reranker (TEI), Llm (Anthropic or OpenAI-compatible, redacts secrets)
ctc/enrich.py       enrichment + dedup
ctc/indexer.py      USearch build, atomic swap, DenseIndex
ctc/retrieve.py     hybrid search, RRF, filters, rerank, abstain
ctc/cli.py          `ctc` (typer)
eval/loaders.py  eval/label.py  eval/run.py  eval/train_difficulty.py  eval/gates.toml (owner-only)
tests/test_*.py  tests/fixtures/
# M2+: ctc/daemon.py ctc/decide.py ctc/memory.py ctc/ltm.py  dashboard/ (React + Vite)
```

## Verification

Two tiers, nothing else.

**Tier 1 — logic checks** (`uv run pytest`): only our own branching or math. Nothing for glue, libraries (`ranx`, SQLite, USearch), rename atomicity, or what type hints already state.

| File | Asserts (exact values) | Milestone |
|---|---|---|
| `tests/test_capability.py` | broken frontmatter → skipped, 1 warning with its path; plugins `p1`, `p2` each with `skills/review` → both `p1:review`, `p2:review` present; `p1/skills/x/SKILL.md` + `p1/commands/x.md` → one `p1:x`, kind=skill, 1 warning; root `cache/m/p/1.0.0/` with plugin.json `{"name": "p", "agents": ["./a.md"], "skills": "./skills/"}`, `skills/s/SKILL.md` and a decoy `docs/ja-JP/skills/x/SKILL.md` → `p:a` and one `p:s` present, 0 warnings, nothing from `docs/`; two project dirs with `.claude/skills/review` → two distinct ids; `user:review` invoke `review`, `p1:review` invoke `p1:review` | M1 |
| `tests/test_index.py` | rebuild with no changes → 0 embedder calls; edit 1 skill → only its texts re-embedded; `enricher_version` change → fake Llm called once per cap; `library_version()` changes iff the set of (id, hash) pairs changes; upsert of project A leaves project B's rows; FTS query `kiem thu` finds `kiểm thử`; `fts("fix a flaky test: it's \"x\" -y AND", 5)` and `fts("  ", 5)` return without raising | M1 |
| `tests/test_retrieve.py` | RRF k=60: item ranked (3,3) scores `2/63 = 0.03175` and beats (1,10) at `1/61 + 1/70 = 0.03068`; blocked never returned; pinned first; best rerank < τ → `hits == [] and abstained`; dedup cluster → 1 hit; dedup: cosine 0.93 merged, 0.88 → review list, 0.80 apart; real `Llm.json` with `sk-…` and `https://u:p@host` in the prompt → request body at a fake HTTP transport contains neither | M1 |
| `tests/test_route.py` | `ctc install`'s exact hook command via `sh -c`: no socket, and a socket that accepts but never replies → empty stdout, exit 0, < 150 ms; stub reply → `[claudethecaller] Suggested:` line; `ctc install` twice (`HOME=tmp_path`, stub `claude` first on PATH) → settings byte-identical; workflow hit → its declared step order; agent with rerank < 0.5 not attached; `Skill` call matching a step's `invoke` sets `followed = 1` | M2 |
| `tests/test_ltm.py` | cosine ≥ 0.95 → NOOP + `use_count` +1; 0.85–0.95 same meaning → UPDATE (1 row); contradiction → SUPERSEDE (old soft-deleted, new `supersedes` = old id); fresh ADD (use_count 0, sim 0.9) outranks use_count 3 at sim 0.2; project A recall never returns project B rows; pinned skips decay; topic shift (cos < 0.55) resets window | M3 |
| `dashboard/e2e.spec.ts` (Playwright) | block a skill → `ctc search` drops it; delete a memory → next bundle's `memories` drops it | M4 |

**Tier 2 — metric gates** (`uv run eval/run.py --gate mN`, exit 1 on any miss; report saved to `data/report-<date>.md`; every row below is written to `eval/gates.toml` by R6 (Task 6) with `milestone = N`, owner-edited only after R6; `--gate mN` enforces rows with milestone ≤ N, a missing metric counts as a miss, report-only rows never fail):

| Metric | Gate | Data | From |
|---|---|---|---|
| Recall@5 (after abstain) | ≥ 0.90 | own-eval test: the 200 hand-checked rows with `gold` ≠ none | M1 |
| NDCG@10 | hybrid + rerank ≥ dense-only `SKILLRET-Embedding-0.6B` | SkillRet test | M1 |
| False-trigger rate | ≤ 10% at τ calibrated on dev | MetaTool reliability test half + the 200 rows with `gold` = none | M1 |
| GPU use | ≤ 7 GB | GPU use (see Stack) during eval | M1 |
| Route p95 (cold, warm models) | ≤ 100 ms | own-eval replay through daemon | M2 |
| Follow rate | report only: `decisions.followed` share of non-abstained bundles + Skill/Agent share of all tool calls (baseline 0.5%) | live sessions after H3 | M2 |
| Tier macro-F1 | report only (labels are LLM-made) | labeled subset | M2 |
| Route p95 (prefetch hit) | ≤ 10 ms | replay via `find_capabilities(ref=…)` | M3 |
| Memory lift | Recall@5 with memories ≥ without (memory weight fixed 0.1) | own-eval test; memories only from dev sessions that ended before the turn | M3 |
| Extraction precision | ≥ 0.80 (initial) | 50 hand-checked memories | M3 |

Every task's **Done when** names its Tier 1 row and/or Tier 2 gate. gnhf commits each successful iteration.

---

## Rounds (run with gnhf)

Development runs as [gnhf](https://github.com/kunchenguid/gnhf) rounds: each round is one `gnhf` run with one goal, a command-checkable stop condition and an iteration cap. gnhf commits each successful iteration and rolls back failed ones; three failures in a row abort the round. Milestones and Tasks below are the spec the rounds point at.

**One-time setup:** install gnhf (see its README); `~/.gnhf/config.yml`: `agent: claude`, `commitMessage: { preset: conventional }`.

**Per milestone:** `git checkout -b m<N>-<name>` → run that milestone's rounds in table order (all use `--current-branch`; the tree must be clean before each) → human gates → `gh pr create` into `main`.

**After every round** the controller re-runs that round's Stop-when command once; if it exits 0, start the next round, otherwise re-run the same round (read `.gnhf/runs/<id>/notes.md` first). No other review between rounds; one review at the end of the milestone, before the PR.

### gnhf rules (every round prompt says "follow the gnhf rules in PLAN.md")

1. Work only on the round's goal and files; do not start the next round's work.
2. One small, verified change per iteration; run the round's stop check before finishing the iteration.
3. Never edit `PLAN.md`. Outside R6, never edit `eval/gates.toml` or `data/own-eval*` (labels). Never weaken an existing assertion in `tests/`; only add. After R6, never change how an existing metric, gate or eval row set is computed in `eval/` (only add new ones); never copy own-eval query text into enrichment prompts, trigger phrasings, few-shot examples or code (passing it to `Llm.json` as the item being labeled or extracted is fine); tune on dev rows only; the 200 hand-checked rows are scored only through `--gate`.
4. No dependencies beyond "Stack per component" and Task 1's dep list; one-off tools run via `uvx` (e.g. `uvx py-spy`) are not dependencies. No secrets, `data/`, model weights or `*.usearch` in commits.
5. Stop any process you started (daemon, uvicorn, dev servers) before finishing; `docker compose` model servers may stay up. Never write the real `~/.claude/` or `~/.claude.json`: run `ctc install` and `claude mcp add` only with `HOME` set to a temp dir; the real install is H3.
6. If blocked by something only the owner can do (credentials, hand labels, GPU busy), start `summary` with `BLOCKED: <what the owner must do>`, set `success=false` and `should_fully_stop=false`, and don't touch notes.md (gnhf logs it and aborts after 3 failures). Set `should_fully_stop=true` only after the round's stop check has actually passed.
7. Tier 1 tests use fakes only (no network, no GPU). A pytest stop check passes when `pytest` exits 0.

Each round's command has this shape (fill in from the table below):

```bash
gnhf --current-branch --model <Model> --max-iterations <Cap> \
  --stop-when "<Stop when>" \
  "Follow the gnhf rules in PLAN.md. Spec: PLAN.md sections 'Stack per component', 'Global Constraints', <Spec>. Round <R> goal: <Goal>. The round is done when: <Stop when>."
```

### Milestone 1 — `m1-retrieval-core`

Rows run top to bottom: R3 and R4 precede R2, whose `build_index` calls their code. R1 ran on the old Task 1–2: re-run it once on this plan before R3.

| R | Spec | Goal | Stop when | Cap | Model |
|---|---|---|---|---|---|
| R1 | Task 1, Task 2, `tests/test_capability.py` row | Scaffold the uv package and build `ctc/capability.py` that scans every skill, agent, command and workflow into namespaced `Capability` records | `uv run pytest tests/test_capability.py` exits 0 with ≥ 6 passed AND `uv run python -c 'import sklearn, ranx, datasets'` exits 0 AND `uv run python -m ctc.capability` reports 300–1000 capabilities and ≥ 1 `voltagent-*` agent | 8 | sonnet |
| R3 | Task 4 (compose + clients) | `docker-compose.yml` serving the SkillRet embedder, bge reranker and llama-server; `ctc/models.py` clients incl. `llm_from_env` and redaction | `uv run python -m ctc.models` embeds 2 texts, reranks 2 docs and returns one `Llm.json` result from the local servers AND GPU use ≤ 7 GB | 6 | sonnet |
| R4 | Task 4 (enrich + dedup), dedup rows of `tests/test_retrieve.py` | `ctc/enrich.py`: schema-enforced enrichment and threshold dedup | dedup tests in `tests/test_retrieve.py` pass AND `uv run python -m ctc.enrich --limit 5` prints 5 validated `Enrichment` objects for real capabilities | 8 | sonnet |
| R2 | Task 3, `tests/test_index.py` row | SQLite store with FTS5 and overrides, plus incremental USearch multi-vector index with atomic swap; `build_index` wires in `enrich` and `dedup` | `uv run pytest tests/test_index.py` exits 0 | 10 | sonnet |
| R5 | Task 5, `tests/test_retrieve.py` row | Hybrid retrieval (dense + FTS → RRF → filters → rerank → abstain) and the `ctc` CLI | `uv run pytest tests/test_retrieve.py` exits 0 AND with no overrides set, `uv run ctc search --json "fix a flaky test"` has `superpowers:systematic-debugging`, `superpowers:test-driven-development` or `ecc:tdd-workflow` in its top 5 | 10 | opus |
| R6 | Task 6 (build part) | SkillRet + MetaTool loaders, transcript labeler (filtered human turns, full-catalog judge, dev/test split), `eval/run.py` report and `eval/gates.toml` with every Tier 2 row tagged `milestone = N` | `data/own-eval.jsonl` has ≥ 300 filtered rows (≥ 100 dev), `data/own-eval-review.csv` has 200 test rows, and `uv run eval/run.py` writes `data/report-<date>.md` with every M1 metric computed on dev | 10 | sonnet |
| **H1** | — | **Owner:** hand-check the 200 rows by fixing the `gold` column in `data/own-eval-review.csv` (local only; `data/` is gitignored, never commit it) | — | — | — |
| R7 | Task 6 (gates), "Data & Metrics" | Improve retrieval quality on dev rows (enrichment prompts, trigger phrasings, fusion depth, rerank depth, τ sweep) until the M1 gates pass, without touching gates or labels | `uv run eval/run.py --gate m1` exits 0 | 20 | opus |
| **H2** | — | **Owner:** read the report, open PR `m1-retrieval-core` → `main` | — | — | — |

### Milestone 2 — `m2-agent-integration`

| R | Spec | Goal | Stop when | Cap | Model |
|---|---|---|---|---|---|
| R8 | Task 7, hook rows of `tests/test_route.py` | FastAPI daemon on socket + `:18310`, `/hook/*` and `/route`, `ctc install` writing curl hooks and MCP registration | hook/install tests in `tests/test_route.py` pass AND with the daemon running, `echo '{"prompt":"fix a flaky test","session_id":"t"}' \| curl -s --unix-socket ~/.claudethecaller/ctc.sock --data-binary @- http://ctc/hook/prompt` prints a `[claudethecaller] Suggested:` line | 10 | sonnet |
| R9 | Task 8, decider rows of `tests/test_route.py` | `ctc/decide.py` bundle with difficulty/tier classifier, step order, agent matching; `find_capabilities` MCP tool; follow tracking; `ctc/ltm.py` with only the `Memory` model | `uv run pytest tests/test_route.py` exits 0 AND `uv run eval/train_difficulty.py` prints held-out macro-F1 and writes `data/difficulty.joblib` | 12 | opus |
| R10 | Tier 2 M2 rows | Replay own-eval through the daemon, add M2 latency and tier metrics to the report (follow rate is added in R13, from live sessions after H3) | with the daemon running, `uv run eval/run.py --gate m2` exits 0 | 10 | opus |
| **H3** | — | **Owner:** `ctc install`, use Claude Code normally for a day, check the decision log; PR → `main` | — | — | — |

### Milestone 3 — `m3-memory`

| R | Spec | Goal | Stop when | Cap | Model |
|---|---|---|---|---|---|
| R11 | Task 9, "Memory Engine", topic-shift row of `tests/test_ltm.py` | Project profile, session state, decision prior, prefetch and semantic cache | topic-shift test passes AND replay through `find_capabilities(ref=…)` shows prefetch-hit p95 ≤ 10 ms in the report | 12 | opus |
| R12 | Task 10, `tests/test_ltm.py` row | Long-term memory: extract, ADD/UPDATE/SUPERSEDE/NOOP, recall with decay, Claude memory import | `uv run pytest tests/test_ltm.py` exits 0 AND with the daemon running, `uv run ctc memory backfill --sessions 30` writes ≥ 50 memories from dev sessions | 12 | opus |
| **H4** | — | **Owner:** hand-check 50 extracted memories into `data/own-eval-memories.jsonl`; if precision < 0.80, soft-delete that backfill batch (`deleted_at`), re-run R12 with 'improve the extraction prompt' and the bad memory texts added to its goal, then re-check 50 fresh memories before R13 | — | — | — |
| R13 | Tier 2 M3 rows | Memory lift and extraction precision in the report; tune weights other than the memory weight (fixed 0.1) until gates pass; add the Follow rate row from sessions after H3 (state.db `decisions` + transcript tool calls) | with the daemon running, `uv run eval/run.py --gate m3` exits 0 | 12 | opus |
| **H5** | — | **Owner:** PR → `main` | — | — | — |

### Milestone 4 — `m4-dashboard`

| R | Spec | Goal | Stop when | Cap | Model |
|---|---|---|---|---|---|
| R14 | Milestone 4 | `/api/*` endpoints, dashboard shell, KPI cards, timeline, decision log with explain drawer, activity heatmap | `pnpm -C dashboard build` exits 0 AND `curl -sf 127.0.0.1:18310/` returns the page AND `curl -s 127.0.0.1:18310/api/kpis` has `routing_calls` > 0 | 12 | sonnet |
| R15 | Milestone 4, `dashboard/e2e.spec.ts` row | Library control, sessions view, memory view; Playwright e2e | `pnpm -C dashboard exec playwright test` exits 0 | 12 | sonnet |
| **H6** | — | **Owner:** visual review, PR → `main` | — | — | — |

### Milestones 5–6

| R | Spec | Goal | Stop when | Cap | Model |
|---|---|---|---|---|---|
| R16 | Milestone 5 | React Flow editor saving `.claude/workflows/*.yaml` | after saving a workflow in the UI, its id is in the hits of `uv run ctc search "<its description>"` AND `POST /route` with that description returns a Bundle whose `workflow` is that id and whose `steps[].cap_id` equals the YAML's `steps[].cap` resolved to ids, in order | 12 | sonnet |
| R17 | Milestone 6 | Profile `/route` under replay with `uvx py-spy record -- .venv/bin/python -m ctc.daemon` (ptrace blocks attaching by pid); build the nanobind module only if Python fusion/filter > 20% of p95 | either `data/profile.md` shows ≤ 20% (round ends, no native code) or the gate report shows identical rankings and lower p95 with the native module | 15 | opus |

---

# Milestone 1 — Retrieval core and eval

**Exit:** Tier 1 M1 rows pass; Tier 2 M1 gates pass; `ctc explain "fix a flaky test"` shows debugging/TDD skills in the top 5 on the real library.

### Task 1: Scaffold
- [x] Own git repo, remote `origin` = `https://github.com/dangnguyenducanh/Claudethecaller` (public), branch `main`; one branch per milestone (`m1-retrieval-core`, …), merged via PR.
- [ ] `uv init --package --name ctc --python 3.12 .` at the repo root, flat `ctc/` via `[tool.uv.build-backend] module-root = ""`; deps `usearch numpy pyyaml httpx pydantic typer anthropic openai scikit-learn`; dev group `pytest ruff ranx datasets` (no extras: `uv run` installs the dev group). `.gitignore`: `.venv`, `data/`, `*.usearch`, `*.db`, `models/`, `*.gguf`, `*.safetensors`, `graphify-out/`, `dashboard/node_modules`, `dashboard/dist`.
- [ ] **Done when:** `uv run python -c "import sqlite3,numpy as np,usearch.index as u; sqlite3.connect(':memory:').execute('create virtual table t using fts5(x)'); v=np.array([1,0,0,0],'f4'); i=u.Index(ndim=4); i.add(1,v); print(i.search(v,1).keys)"` prints `[1]` (FTS5 available, USearch binding works).

### Task 2: Capability scanner
**Files:** `ctc/capability.py`
```python
Kind = Literal["skill", "agent", "command", "workflow"]
@dataclass(frozen=True)
class Capability: id: str; kind: Kind; name: str; namespace: str; description: str; body: str; path: str; hash: str   # + invoke @property
def scan_library(roots: list[tuple[Path, str]]) -> tuple[list[Capability], list[str]]   # (caps, warnings)
def default_roots(project_dir: Path) -> list[tuple[Path, str]]
```
- [ ] **Build:** `id = f"{namespace}:{name}"`; `hash = sha256(description + "\n" + body)`. Roots: `~/.claude` (`user`); `<project>/.claude` (`project@<sha256(resolved project_dir)[:8]>`); plugins = the `installPath` of each `~/.claude/plugins/installed_plugins.json` entry with scope `user` or `projectPath` == project_dir, plus the dirs under `~/.claude/plugins/synced/*/*`, namespace = `name` in `<root>/.claude-plugin/plugin.json`; never glob `plugins/**`. Kind by patterns anchored at each root, not recursive: `skills/*/SKILL.md`, `agents/*.md`, `commands/*.md`, `workflows/*.yaml`, plus paths (files or dirs; a string or a list) listed in plugin.json `skills`/`agents`/`commands`. Dedupe by resolved path first; then same id twice → keep by kind skill > workflow > agent > command (then first found), 1 warning naming both paths. `invoke` = `name` for `user`/`project@…`, else `id`. `pathlib.glob` + `yaml.safe_load`.
- [ ] **Done when:** `tests/test_capability.py` passes; real scan reports 300–1000 capabilities with unique ids.

### Task 3: Store + index
**Files:** `ctc/store.py`, `ctc/indexer.py`
```python
Override = Literal["pin", "block", "disable"]
class Store:
    def __init__(self, path: str | Path): ...                      # ":memory:" allowed
    def upsert(self, caps: list[Capability], namespaces: list[str]) -> Diff   # Diff(added, changed, removed: list[str]); removed only within namespaces
    def get(self, cap_id: str) -> dict | None                       # capability + enrichment + enricher_version + cluster_id
    def set_enrichment(self, cap_id: str, e: Enrichment, version: str) -> None   # version = enricher_version(llm)
    def set_cluster(self, cap_id: str, cluster_id: str) -> None
    def embedding(self, text_hash: str, model: str) -> np.ndarray | None
    def put_embedding(self, text_hash: str, model: str, v: np.ndarray) -> None
    def fts(self, query: str, k: int) -> list[tuple[str, float]]   # tokens "quoted" (inner " doubled), OR-joined; blank → []
    def library_version(self) -> str                                # sha256 of sorted (id, hash)
    def set_override(self, project: str, cap_id: str, action: Override | None) -> None
    def overrides(self, project: str) -> dict[str, Override]
async def build_index(store: Store, embedder: Embedder, dir: Path, llm: Llm | None = None) -> BuildStats   # (vectors, enriched, clusters)
class DenseIndex:
    def __init__(self, dir: Path): ...
    def search(self, q: np.ndarray, k: int) -> list[tuple[str, float]]   # one entry per capability
```
- [ ] **Build:** `sqlite3`, WAL. Tables `capabilities`, `triggers`, `fts` (FTS5, `unicode61 remove_diacritics 2`, over name/description/summary/triggers), `embeddings`, `overrides`, `sessions`, `events`, `decisions`, `memories` (columns as in "Long-term memory"). Multi-vector per capability (`name+description+summary` + one per trigger), max score per capability; enrich (when `llm` given, sync `enrich` via `asyncio.to_thread`, then `set_enrichment`) only where (cap hash, `enricher_version`) changed; embed only changed text hashes; `dedup` → `set_cluster`; write `skills.usearch.tmp` → `os.replace`.
- [ ] **Done when:** `tests/test_index.py` passes (async fake embedder = hash-to-vector).

### Task 4: Models, enrichment, dedup
**Files:** `docker-compose.yml`, `ctc/models.py`, `ctc/enrich.py`
```python
class Embedder:  model_version: str; dim: int
    async def embed(self, texts: list[str], kind: Literal["query", "doc"]) -> np.ndarray
class Reranker:
    async def score(self, query: str, docs: list[str]) -> list[float]
class Llm:
    spec: str                                                       # resolved CTC_LLM string
    def json(self, system: str, user: str, schema: type[BaseModel]) -> BaseModel   # redacts secrets before the provider call
def llm_from_env() -> Llm        # CTC_LLM=anthropic:<model> | openai:<base_url>:<model>
class Enrichment(BaseModel): summary: str; triggers: list[str]; prerequisites: list[str]; inputs: str; outputs: str
def enrich(cap: Capability, llm: Llm) -> Enrichment
def enricher_version(llm: Llm) -> str
def dedup(ids: list[str], vecs: np.ndarray) -> tuple[list[list[str]], list[tuple[str, str]]]   # (clusters, review pairs)
```
- [ ] **Build:** compose: TEI ≥ 1.7.2 (`89-*` Ada image) `:18300` = `ThakiCloud/SKILLRET-Embedding-0.6B` with `--pooling ${TEI_POOLING:-last-token}` (env swap to `BAAI/bge-m3` + `TEI_POOLING=cls`), TEI `:18301` = `BAAI/bge-reranker-v2-m3`, `llama-server` `:18302` = `Qwen2.5-3B-Instruct-Q4_K_M.gguf` with `-c 32768 -np 1`; weights from `~/.cache/huggingface`, never in the repo. Query side uses the model card's instruction prefix. `llm_from_env()`: `CTC_LLM` if set; else `anthropic:claude-haiku-5-5` when `ANTHROPIC_API_KEY` is set; else `openai:http://127.0.0.1:18302/v1:qwen2.5-3b` (a missing key is never a rule-6 blocker). `Llm.json` strips API keys, tokens and credential URLs from `system`/`user` first. `enrich`: body truncated to 6,000 chars, 8–12 triggers via schema length bounds, ≥ 2 non-English via a non-ASCII `field_validator` with 1 retry. Dedup: USearch k-NN + union-find at ≥ 0.92; [0.85, 0.92) → review pairs.
- [ ] **Done when:** dedup rows of `tests/test_retrieve.py` pass; R3 and R4 stop commands pass; GPU use ≤ 7 GB.

### Task 5: Retriever + CLI
**Files:** `ctc/retrieve.py`, `ctc/cli.py`
```python
@dataclass
class Ctx: store: Store; index: DenseIndex; embedder: Embedder; reranker: Reranker; project: str   # later tasks append defaulted fields only
@dataclass
class Hit: cap_id: str; score: float; stages: dict[str, float]     # dense, dense_rank, sparse_rank, rrf, rerank
@dataclass
class SearchResult: hits: list[Hit]; abstained: bool; ms: dict[str, float]; dropped: list[tuple[Hit, str]]   # (hit, reason)
def rrf(rankings: list[list[str]], k: int = 60) -> dict[str, float]
async def search(q: str, ctx: Ctx, k: int = 5, rerank_top: int = 20, abstain_below: float = 0.3) -> SearchResult
```
- [ ] **Build:** dense 50 ∥ FTS 50 → `rrf` → drop block/disable and caps whose namespace is not in `default_roots(Path(ctx.project))`, collapse clusters → rerank top 20 → pins to top → abstain below τ (0.3 until Task 6 calibrates) → top 5. CLI `ctc index | search [--json] | explain | status`; `explain` shows every stage score incl. `dropped` with reason; TEI down → exit 1 `embedder unreachable at <url>` in < 2 s.
- [ ] **Done when:** `tests/test_retrieve.py` passes; R5's `ctc search` check passes.

### Task 6: Eval harness + gates
**Files:** `eval/loaders.py`, `eval/label.py`, `eval/run.py`
- [ ] **Build:** `datasets.load_dataset("ThakiCloud/SKILLRET", <config>, split="test")` for configs `skills`, `queries`, `qrels`, and the MetaTool reliability subset → temporary store/index built with `llm=None` (dense + FTS on name/description; say so in the report). `label.py`: from `~/.claude/projects/**/*.jsonl`, skipping `subagents/` and `-home-aiface-dangnguyenducanh-claudethecaller/` (gnhf sessions), keep rows with type=user, not isMeta, string or text-block content with no tool_result, text not starting with `<`; the judge (`llm_from_env()`) sees the full catalog (id + description cut to 100 chars, or 50 if that exceeds 24k tokens), never `ctc.retrieve` output or the ctc index, and may answer `none` (no-capability truth) → `data/own-eval.jsonl` with `split = dev|test` by the Leakage rule + `data/own-eval-review.csv` (`id,query,gold`; 200 rows from test sessions). `run.py`: `ranx.evaluate` for `recall@1,5,10 ndcg@10 mrr` on `search()` hits, own-eval and MetaTool at τ (abstained gold turn = miss), the SkillRet grid with abstain off; own-eval gate metrics from the 200 CSV rows only, the rest report-only; Completeness@k = share of queries with per-query `recall@k == 1` (`return_mean=False`); abstain rates from a 2×2 count. Grid {dense, hybrid, hybrid+rerank} on SkillRet-0.6B; bge-m3 dense-only as a separate `--embedder bge-m3` run after the TEI env swap; p50/p95 per stage. τ sweep: lowest swept τ with false-trigger ≤ 10% on dev negatives (MetaTool dev half + own dev no-capability rows), written back as the `abstain_below` default. Without `--gate`: dev report with per-query misses; `--gate mN`: test split only, aggregates only, enforces Tier 2.
- [ ] **Done when:** owner hand-checks the 200 rows; `uv run eval/run.py --gate m1` exits 0.

---

# Milestone 2 — Agent integration and decider

**Exit:** fresh Claude Code session gets bundles without naming skills; `tests/test_route.py` + M2 gates pass.

### Task 7: Daemon, hooks, MCP
`ctc/daemon.py`: FastAPI on `~/.claudethecaller/ctc.sock` + `127.0.0.1:18310`; keeps index/store/HTTP clients warm; `ctc daemon start|stop`. Routes: `POST /hook/{event}` (raw Claude Code hook JSON in, hint text out), `POST /route`, `GET /bundle/{ref}`, `/api/*` (dashboard), `/mcp` (FastMCP streamable HTTP) and static `dashboard/dist`. `/hook/prompt` computes `ref` = first 8 hex of sha256(session_id + prompt) and prefetches under it; R8 prints the hint from `search()`, prefetch and `GET /bundle/{ref}` land in R11. `ctc install` (backup + idempotent, every path from `$HOME`) writes into `~/.claude/settings.json`:
```
UserPromptSubmit: LC_ALL=C curl -sf -m 0.12 --unix-socket $HOME/.claudethecaller/ctc.sock --data-binary @- http://ctc/hook/prompt || true
PostToolUse, Stop: same with /hook/tool and /hook/stop, -m 0.05
```
and runs `claude mcp get claudethecaller >/dev/null 2>&1 || claude mcp add --scope user --transport http claudethecaller http://127.0.0.1:18310/mcp`. Hint line: `[claudethecaller] Suggested: <invoke names> — call find_capabilities(ref="<ref>") for the plan`, empty when abstained.

### Task 8: Decider + meta-tool
`ctc/decide.py`:
```python
class Step(BaseModel): order: int; cap_id: str; invoke: str; kind: Kind; agent: str | None; reason: str
class Bundle(BaseModel):
    intent: str; confidence: float
    difficulty: Literal["trivial", "standard", "complex", "critical"]; model_tier: Literal["haiku", "sonnet", "opus"]
    workflow: str | None; steps: list[Step]; memories: list[Memory]; abstained: bool   # memories empty until M3
async def decide(hits: list[Hit], ctx: Ctx) -> Bundle
```
Difficulty/tier: scikit-learn `LogisticRegression` on the query embedding. `eval/train_difficulty.py` reads dev prompts in `data/own-eval.jsonl` without editing it, labels `difficulty`/`model_tier` with `Llm.json` into `data/difficulty-labels.jsonl`, fits `data/difficulty.joblib` and prints held-out macro-F1. Steps: workflow's declared order if a workflow is top, else rerank order. Agent: best `agent` hit with rerank ≥ 0.5 vs the step. Every field has a reason. MCP tool `find_capabilities(task: str, blocker: str | None = None, ref: str | None = None)` → the prefetched bundle when `ref` hits and `blocker` is None, else a live route, plus "Use these in order; say why if you skip one." Follow tracking: a `Skill` `skill`, `Agent` `subagent_type` or slash name equal to a step's `invoke` or `agent` (the agent's invoke name) in the same turn sets `decisions.followed = 1`. R9 creates `ctc/ltm.py` holding only the Task 10 `Memory` model, verbatim; R12 adds the functions.

---

# Milestone 3 — Intent pre-calculation, memory engine, long-term memory

**Exit:** `tests/test_ltm.py` + M3 gates pass.

### Task 9: Session + project memory, prefetch
`ctc/memory.py`: `ProjectProfile` (hash of CLAUDE.md + memory dir + manifests + `.git/HEAD`, watched with `watchfiles`), `SessionState` (ring 20, running vector, topic shift < 0.55), decision prior (±0.05 per follow/ignore, clamp ±0.2). Query vector = normalize(0.6·prompt + 0.25·session + 0.15·project), tuned on own-eval dev rows. Prefetch on `/hook/prompt` (keyed by `ref`); semantic cache ≥ 0.95 keyed with `library_version + profile_version + state_version`; async summary every 5 turns.

### Task 10: Long-term memory
`ctc/ltm.py`, implements "Long-term memory" above:
```python
class Memory(BaseModel):
    id: str; scope: Literal["global", "project"]; project: str | None
    kind: Literal["preference", "convention", "fact", "skill_outcome"]
    text: str; confidence: float; pinned: bool; source: dict      # session, turn, file
def extract_candidates(session_id: str, llm: Llm) -> list[Memory]      # the daemon runs it via asyncio.to_thread
async def write_memory(c: Memory, ctx: Ctx) -> tuple[Literal["ADD", "UPDATE", "SUPERSEDE", "NOOP"], str]
def recall(qv: np.ndarray, ctx: Ctx, k: int = 5, sessions: set[str] | None = None) -> list[Memory]   # project = ctx.project; sessions → only source.session ∈ sessions
async def import_claude_memory(dirs: list[Path], ctx: Ctx) -> int
```
CLI `ctc memory backfill --sessions N` has the daemon (`POST /api/memory/backfill`) run extract + write over the last N dev-split transcripts (feeds H4).

---

# Milestone 4 — Control dashboard (TypeScript)

`dashboard/` (React + Vite + Recharts, `pnpm build` → `dist/` served by the daemon at `:18310`; reads/writes `/api/*`): KPI cards 7d/30d/90d/all (routing calls, adoption, lazy misses, p95, tokens saved, cost by tier) · stacked timeline by project/capability · decision log → explain drawer (stage scores + memories used) · library control (enable/disable/pin/block per project, dedup review merge/keep, re-enrich) · sessions view (project rail with counts; per session title, model, agent time, tokens, turns, decisions, extracted memories) · memory view (search/filter, edit, pin, delete, supersede history, link to source session) · activity heatmap. Writes take effect on the next route. **Done when:** `dashboard/e2e.spec.ts` passes.

# Milestone 5 — Visual workflow editor (TypeScript)

React Flow canvas → `<project>/.claude/workflows/<name>.yaml` (`{ name, description, steps: [{ cap, agent? }] }`; `cap` = id or invoke name, resolved to `Step.cap_id`), indexed by Task 2, expanded by Task 8. **Done when:** R16's stop check passes.

# Milestone 6 — C++ hot path (only if profiling justifies)

Gate: `py-spy` on the daemon under eval replay shows Python fusion/filter/graph code > 20% of `/route` p95. Then `native/` (CMake + nanobind on USearch's C++ API: filtered search + RRF + cluster collapse in one call) behind the same `DenseIndex` / `search` signatures. **Done when:** identical rankings on the full eval set and lower p95 in the gate report.
