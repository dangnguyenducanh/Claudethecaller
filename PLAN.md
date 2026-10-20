# claudethecaller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local skill/workflow router that predicts what a coding agent needs from project memory and the live session, and hands Claude an explainable bundle (workflow → ordered skills → subagents → difficulty and model tier) through one MCP tool plus a prompt hook, managed by a CLI and a control dashboard.

**Architecture:** One warm Bun daemon owns everything: capability index (USearch dense + SQLite FTS5 keyword), retrieval (RRF fusion → cross-encoder rerank → abstain threshold), decider, and memory engine. Claude Code hooks, the MCP server, the CLI and the dashboard are thin clients over a Unix socket / HTTP. LLMs run only offline (enrichment, dedup, labeling) or async (session summaries), never on the per-request path.

**Tech Stack:** TypeScript on Bun (`bun:sqlite`, `bun test`), USearch (C++ HNSW, npm `usearch`), SQLite FTS5, Hugging Face text-embeddings-inference (TEI) in Docker for embedder and reranker, `@modelcontextprotocol/sdk`, Hono, React + Vite (+ React Flow in M5). Python only for one-off eval/training scripts if needed.

**Spec:** this file, section "Product" below (the former PRD is merged here).

---

## Product

**Problem.** Coding agents have hundreds of skills, workflows and subagents installed but rarely call them; they solve tasks on their own, and the user must type `/plugin:skill` to get one used. Coders get no explainable, reliable record of why a capability was or wasn't used.

**Evidence.** Owner's Claude Code history (319 sessions, 2026-10-20): ~10,000 tool calls, **52 `Skill` calls (~0.5%)**, only **17 distinct skills** used against 300+ installed, mostly user-typed. SRA-Bench (2026) independently finds agents load skills at the same rate whether or not the task needs them. Generalization to other coders: assumption, validate after MVP.

**Users.** Primary: coders globally using coding agents with large skill libraries, who want the agent to pick and sequence capabilities itself with a visible rationale. Secondary: owner's AI-engineer portfolio, so it must be built from scratch (ratel, MCPGateway, metamcp and similar are references only). Not for: non-coding chat, hosted SaaS, autonomous workflow execution.

**Hypothesis.** A router that predicts intent from memory and session and returns an explainable bundle will make coding agents use the right installed capabilities without being told. Proven when, on labeled real transcripts, the follow rate rises well above the 0.5% baseline (target set after baseline labeling), Recall@5 ≥ 0.90, and latency targets hold.

**In scope (MVP, Claude Code only):** index + enrich + dedup; hybrid retrieval + rerank; decider (workflow, skills, subagents, difficulty, model tier, reasons); intent pre-calculation; **long-term memory** (cross-session facts, preferences, conventions and skill outcomes, stored with provenance and fed back into routing); one MCP meta-tool + suggest-only hook; CLI; control dashboard (incl. sessions and memory views); eval harness.

**Out of scope:** other agents (Cursor/Codex adapters later), executing workflows, hard-blocking the agent, hosted multi-user server, marketplace, training models from scratch.

**Open questions (defaults in use):** offline nodes may call the Claude API (default yes; per-request path stays local) · hook escalation to blocking (default never) · distribution (default one npm/bun package) · labeling at scale (default LLM judge + 200 hand-checked) · adoption target (set after baseline).

## Global Constraints

- Every local model ≤ 3B parameters; total GPU use ≤ 7 GB (shared host, hard ceiling 14 GB).
- The prompt hook must never add more than 150 ms to a prompt and must fail open (timeout or daemon down → empty output, exit 0).
- Routing latency: p95 ≤ 10 ms on prefetch hit, p95 ≤ 100 ms on a cold query with warm models.
- Everything local by default; transcripts and memory are redacted for secrets before any call to a remote LLM.
- Capability IDs are namespaced `plugin:name` (or `user:name`, `project:name`); bare names are never keys.
- Built from scratch: no runtime dependency on existing skill routers or MCP gateways.
- Prompts in any language must be accepted (multilingual embedder).

## Review Focus

1. **Malformed capability files** (missing/invalid YAML frontmatter, no description) → skipped with a warning, never abort the scan. Test in Task 2.
2. **Daemon or TEI down / slow** → hook prints nothing and exits 0 within 150 ms; CLI prints a clear error. Test in Task 7 and M2 Task 10.
3. **Same skill name in two plugins** → two distinct IDs, both searchable, not overwritten. Test in Task 2.
4. **Huge SKILL.md bodies** (>8k tokens) → truncated for embedding and enrichment input, full body kept in store. Test in Task 4.
5. **No relevant capability** (query like "what's 2+2") → router abstains (empty bundle), not a weak top-1. Test in Task 6.

---

## Data & Metrics

**Public datasets** (download in Task 8):

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
  - *Write path (async, never on the prompt path):* on Stop/session end, a ≤3B or offline LLM extracts candidate memories from the redacted session; each candidate is embedded and matched against existing memories → `ADD` (no neighbor ≥ 0.85), `UPDATE` (neighbor ≥ 0.85, same meaning, merge text, bump confidence), `SUPERSEDE` (neighbor contradicts it → old gets `deleted_at`, new keeps a link), or `NOOP` (≥ 0.95 duplicate, only bump `use_count`). Skill outcomes are written without an LLM from decision history ("for prompts like X in project P, skill S was followed and the turn succeeded").
  - *Import:* one-way read of Claude Code's own memory (`~/.claude/projects/*/memory/*.md`, `CLAUDE.md`) on change, tagged `source: claude-memory`; claudethecaller never writes into Claude's files.
  - *Read path:* top 5 memories for the query vector (filtered to `global` + current project, not deleted) score = similarity × recency decay (half-life 30 days, pinned exempt) × log(1 + use_count); they shift the query vector (weight 0.1) and are returned in the bundle as `memories[]` with provenance.
  - *Retention:* unpinned memories with confidence < 0.3 and unused for 90 days are soft-deleted; nothing is hard-deleted except from the dashboard.
- **Storage:** RAM (session ring buffers, LRU caches) · SQLite WAL + FTS5 (`~/.claudethecaller/state.db`) · USearch files memory-mapped (`skills.usearch`, `memory.usearch`).
- **Update rules:** content-addressed (`sha256(text)` keys; recompute embedding/enrichment only on hash change) · versions in cache keys (`library_version`, `profile_version`, `model_version`), never explicit invalidation · topic shift when cosine(turn, session vector) < 0.55 → reset window and re-predict · async ≤3B summary every 5 turns or on topic shift · new index built beside old, swapped by atomic rename · file events debounced 500 ms.
- **Caches:** prefetch `session_id + prompt_hash` → bundle (filled by UserPromptSubmit, read by meta-tool) · semantic result cache (recent query cosine ≥ 0.95 + `project_fp + library_version`) · embedding cache `text_hash + model_version` · rerank cache `(query_hash, cap_hash)`.

## File Structure

```
package.json  tsconfig.json  docker-compose.yml    # TEI embedder + reranker
src/capability.ts   parse + scan SKILL.md / agents / commands / workflows
src/store.ts        SQLite schema, content hashing, queries
src/models.ts       Embedder, Reranker (TEI HTTP), Llm (OpenAI-compatible or Anthropic)
src/enrich.ts       enrichment + dedup clustering
src/indexer.ts      USearch + FTS5 build, atomic swap
src/retrieve.ts     hybrid search, RRF, filters, rerank, abstain, explain
src/cli.ts          `ctc` entrypoint
eval/metrics.ts  eval/datasets.ts  eval/label.ts  eval/run.ts
tests/*.test.ts  tests/fixtures/
# M2+: src/daemon.ts src/mcp.ts src/hooks.ts src/decide.ts src/memory.ts src/ltm.ts dashboard/
```

---

# Milestone 1 — Retrieval core and eval

**Exit:** `ctc search` / `ctc explain` work on the owner's real library; eval report shows Recall@5, NDCG@10, abstain rates on SkillRet test + own set vs. both baselines.

### Task 1: Repo scaffold

**Files:** Create `package.json`, `tsconfig.json`, `.gitignore`, `tests/smoke.test.ts`

- [x] **Step 1:** Own git repo inside `claudethecaller/` (the parent home directory is itself a git repo), remote `origin` = `https://github.com/dangnguyenducanh/Claudethecaller` (public), branch `main`. Expected: `git rev-parse --show-toplevel` prints `/home/aiface/dangnguyenducanh/claudethecaller`. Work on feature branches per milestone (`m1-retrieval-core`, …) and merge to `main` via PR.
- [ ] **Step 2:** `bun init`; add deps `usearch`, `yaml`, `@modelcontextprotocol/sdk`, `hono`; `.gitignore` covers `node_modules`, `data/`, `*.usearch`, `*.db`.
- [ ] **Step 3:** Smoke test: `import { Index } from "usearch"`, add 3 vectors of dim 4, search returns the exact match first. Run `bun test tests/smoke.test.ts` → PASS. If USearch's N-API binding fails under Bun, record it and run the daemon under Node (`tsx`) instead; everything else unchanged.
- [ ] **Step 4:** Commit `chore: scaffold`.

### Task 2: Capability parser and scanner

**Files:** Create `src/capability.ts`, `tests/capability.test.ts`, `tests/fixtures/library/**`

**Interfaces — Produces:**
```ts
type CapKind = "skill" | "agent" | "command" | "workflow";
interface Capability { id: string; kind: CapKind; name: string; namespace: string;
  description: string; body: string; path: string; hash: string; }
function parseCapability(path: string, namespace: string): Capability | null;
function scanLibrary(roots: { dir: string; namespace: string }[]): { caps: Capability[]; warnings: string[] };
function defaultRoots(projectDir: string): { dir: string; namespace: string }[];
```
`id = namespace + ":" + name`; `hash = sha256(description + "\n" + body)`. Kinds by path: `skills/*/SKILL.md` → skill, `agents/*.md` → agent, `commands/*.md` → command, `workflows/*.{md,js,yaml}` → workflow. `defaultRoots` covers `~/.claude/{skills,agents,commands}` (namespace `user`), each enabled plugin under `~/.claude/plugins/**` (namespace = plugin name), and `<project>/.claude/**` (namespace `project`).

- [ ] **Step 1: Failing tests**
  - `parses SKILL.md frontmatter`: fixture `p1/skills/tdd/SKILL.md` → `{ id: "p1:tdd", kind: "skill", description: <frontmatter description> }`.
  - `skips malformed frontmatter with warning`: fixture with broken YAML → not in `caps`, one entry in `warnings` containing the path.
  - `same name in two plugins stays distinct`: `p1/skills/review` and `p2/skills/review` → ids `p1:review`, `p2:review`, both present.
  - `agent and command kinds`: fixtures yield `kind === "agent"` / `"command"`.
- [ ] **Step 2:** `bun test tests/capability.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement with `yaml` for frontmatter, `Bun.Glob` for scanning.
- [ ] **Step 4:** Tests PASS; also run `bun -e` scan on real `defaultRoots(cwd)` and print count (expect 300+).
- [ ] **Step 5:** Commit `feat: capability parser and scanner`.

### Task 3: Store

**Files:** Create `src/store.ts`, `tests/store.test.ts`

**Interfaces — Consumes:** `Capability`. **Produces:**
```ts
interface CapabilityRow extends Capability { enrichment?: Enrichment; clusterId?: string; }
function openStore(path: string): Store;   // ":memory:" allowed
interface Store {
  upsertCapabilities(caps: Capability[]): { added: string[]; changed: string[]; removed: string[] };
  getCapability(id: string): CapabilityRow | undefined;
  setEnrichment(id: string, e: Enrichment): void;          // Enrichment from Task 4
  setCluster(id: string, clusterId: string): void;
  getEmbedding(textHash: string, modelVersion: string): Float32Array | undefined;
  putEmbedding(textHash: string, modelVersion: string, v: Float32Array): void;
  ftsSearch(query: string, k: number): { id: string; score: number }[];   // FTS5 bm25()
  libraryVersion(): string;   // sha256 of sorted (id, hash) pairs
  setOverride(project: string, id: string, action: "pin" | "block" | "disable" | null): void;
  overrides(project: string): Map<string, "pin" | "block" | "disable">;
}
```
Tables: `capabilities`, `triggers(cap_id, text)`, `fts` (FTS5 over name, description, enrichment summary, triggers; tokenizer `unicode61 remove_diacritics 2`), `embeddings`, `overrides`, plus `sessions`, `events`, `decisions(id, session_id, prompt_hash, bundle_json, latency_ms, followed, created_at)` and `memories` (columns in "Long-term memory" above) created now for M2/M3.

- [ ] **Step 1: Failing tests:** `upsert reports added/changed/removed by hash`; `libraryVersion changes only when a hash changes`; `ftsSearch finds Vietnamese text without diacritics` (insert "kiểm thử", query "kiem thu" → hit); `embedding round-trips byte-exact`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement on `bun:sqlite`, WAL mode. **Step 4:** Run → PASS. **Step 5:** Commit `feat: sqlite store`.

### Task 4: Model clients, enrichment and dedup

**Files:** Create `docker-compose.yml`, `src/models.ts`, `src/enrich.ts`, `tests/enrich.test.ts`

**Interfaces — Produces:**
```ts
interface Embedder { modelVersion: string; dim: number; embed(texts: string[], as: "query" | "doc"): Promise<Float32Array[]>; }
interface Reranker { score(query: string, docs: string[]): Promise<number[]>; }
interface Llm { json<T>(system: string, user: string, schema: object): Promise<T>; }
function teiEmbedder(url: string, model: string): Embedder;
function teiReranker(url: string): Reranker;
function llmFromEnv(): Llm;   // CTC_LLM=anthropic:<model> | openai:<baseUrl>:<model>
interface Enrichment { summary: string; triggers: string[]; prerequisites: string[]; inputs: string; outputs: string; }
function enrich(cap: Capability, llm: Llm): Promise<Enrichment>;
function dedupClusters(ids: string[], vecs: Float32Array[], threshold?: number): string[][];  // default 0.92
```
Compose: TEI embedder on `:18300` serving `ThakiCloud/SKILLRET-Embedding-0.6B` (swap to `BAAI/bge-m3` by env for the baseline comparison), TEI reranker on `:18301` serving `BAAI/bge-reranker-v2-m3`, both FP16 on GPU. Query side uses the model card's instruction prefix. Default offline LLM `anthropic:claude-haiku-5-5`; local alternative `Qwen/Qwen2.5-3B-Instruct` behind any OpenAI-compatible server. `enrich` returns 8–12 triggers, mixed phrasing and at least 2 non-English; input body truncated to 6,000 chars. Dedup: USearch k-NN over capability vectors, union-find on pairs ≥ threshold; pairs in [0.85, 0.92) are listed for LLM/user review, not auto-merged.

- [ ] **Step 1:** `docker compose up -d`; `curl :18300/embed` and `:18301/rerank` return 200. Verify TEI supports both models; if the SkillRet (Qwen3-based) model is unsupported, serve it from a 30-line `sentence-transformers` FastAPI sidecar on the same port with the same request shape. Check VRAM with `nvidia-smi` ≤ 7 GB.
- [ ] **Step 2: Failing tests** (fake `Llm` and fake vectors, no network): `enrich truncates huge body to 6000 chars before the LLM call`; `enrich rejects output with < 8 triggers` (throws); `dedupClusters groups vectors with cosine ≥ 0.92 and keeps 0.80 pair apart`.
- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement. **Step 5:** Run → PASS; integration test `tests/models.int.test.ts` (skipped unless `CTC_INT=1`) embeds 2 texts and asserts `dim` and finite values.
- [ ] **Step 6:** Commit `feat: model clients, enrichment, dedup`.

### Task 5: Indexer

**Files:** Create `src/indexer.ts`, `tests/indexer.test.ts`

**Interfaces — Consumes:** Store, Embedder, `enrich`, `dedupClusters`. **Produces:**
```ts
function buildIndex(opts: { store: Store; embedder: Embedder; llm?: Llm; dir: string }): Promise<{ vectors: number; enriched: number; clusters: number }>;
function openIndex(dir: string): DenseIndex;
interface DenseIndex { search(q: Float32Array, k: number): { capId: string; score: number }[]; }
```
Multi-vector per capability: one vector for `name + description + summary`, one per trigger; vector key → cap id map persisted next to the index; `search` returns max score per capability. Enrichment and embeddings only for changed hashes. Writes `skills.usearch.tmp` then renames to `skills.usearch`.

- [ ] **Step 1: Failing tests** (fake embedder = deterministic hash-to-vector): `second build with no changes calls embedder 0 times`; `search aggregates multiple vectors to one hit per capability`; `crash before rename leaves previous index readable`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat: incremental indexer`.

### Task 6: Retriever

**Files:** Create `src/retrieve.ts`, `tests/retrieve.test.ts`

**Interfaces — Produces:**
```ts
interface Hit { capId: string; score: number; stages: { dense?: number; denseRank?: number; sparseRank?: number; rrf: number; rerank?: number } }
interface SearchResult { hits: Hit[]; abstained: boolean; ms: Record<string, number> }
function search(q: string, ctx: { store: Store; dense: DenseIndex; embedder: Embedder; reranker: Reranker; project?: string },
                opts?: { k?: number; rerankTop?: number; abstainBelow?: number }): Promise<SearchResult>;
```
Pipeline: dense top 50 ∥ FTS top 50 → RRF with k = 60 → drop `disable`/`block` overrides, collapse dedup clusters to their best member → rerank top `rerankTop` (default 20) on `name + description + summary` → `pin` overrides boosted to top → abstain if best rerank score < `abstainBelow` (default 0.3, recalibrated in Task 8) → top `k` (default 5). `ms` records time per stage.

- [ ] **Step 1: Failing tests** (fakes): `RRF ranks item at ranks (1, 3) above item at (2, 2)`; `blocked capability never returned`; `pinned capability returned first when in candidates`; `abstains when best rerank < threshold` → `hits = [], abstained = true`; `one cluster yields one hit`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat: hybrid retrieval with rerank and abstain`.

### Task 7: CLI

**Files:** Create `src/cli.ts`, `tests/cli.test.ts`

Commands: `ctc index [--project DIR]`, `ctc search "<q>" [--json]`, `ctc explain "<q>"` (table of every stage score for the top 10, including dropped/blocked ones with reason), `ctc status` (capability count, library version, model versions, TEI health). Compile with `bun build --compile src/cli.ts --outfile ctc`.

- [ ] **Step 1: Failing tests:** `search --json prints valid JSON with hits[]`; `exits 1 with "embedder unreachable at <url>" when TEI is down` (point to a closed port; finishes < 2 s).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; manual: `./ctc index && ./ctc explain "fix a flaky test"` shows debugging/TDD skills in the top 5.
- [ ] **Step 5:** Commit `feat: ctc cli`.

### Task 8: Eval harness

**Files:** Create `eval/metrics.ts`, `eval/datasets.ts`, `eval/label.ts`, `eval/run.ts`, `tests/metrics.test.ts`

**Interfaces — Produces:**
```ts
type Run = Map<string, string[]>; type Qrels = Map<string, Set<string>>;
function recallAt(run: Run, qrels: Qrels, k: number): number;
function ndcgAt(run: Run, qrels: Qrels, k: number): number;
function mrr(run: Run, qrels: Qrels): number;
function completenessAt(run: Run, qrels: Qrels, k: number): number;
function abstainRates(pred: Map<string, boolean>, gold: Map<string, boolean>): { correctAbstain: number; falseTrigger: number };
```
`datasets.ts` loads SkillRet test (`data/skills/test.jsonl`, `data/queries/test.jsonl`, `data/qrels/test.jsonl`) and MetaTool reliability subset into a temporary store/index. `label.ts` walks `~/.claude/projects/**/*.jsonl`, takes user turns, redacts secrets (API keys, tokens, `.git-credentials`-style URLs) before the LLM call, and asks the judge for `{ capIds: string[] | [], reason }` against the installed library; writes `data/own-eval.jsonl` and a 200-row `data/own-eval-review.csv` for hand checking. `run.ts` writes `data/report-<date>.md` with all metrics × {SkillRet-0.6B, bge-m3} × {dense only, hybrid, hybrid + rerank}, plus p50/p95 per stage, and sweeps `abstainBelow` to pick the value maximizing correct-abstain at false-trigger ≤ 10%.

- [ ] **Step 1: Failing tests** with hand-computed values: run `q1 → [a,b,c]`, gold `{b}` → Recall@1 = 0, Recall@2 = 1, MRR = 0.5, NDCG@3 = 1/log2(3) ≈ 0.6309; Completeness@2 with gold `{a,c}` = 0; `abstainRates` on a 4-item toy map.
- [ ] **Step 2:** FAIL. **Step 3:** Implement metrics, loaders, labeler, runner. **Step 4:** PASS.
- [ ] **Step 5:** `bun eval/run.ts` produces the report; owner hand-checks the 200 rows; rerun on the corrected set. Record Recall@5 on own set (target ≥ 0.90) and the calibrated `abstainBelow` in `src/retrieve.ts` default.
- [ ] **Step 6:** Commit `feat: eval harness and first report`.

---

# Milestone 2 — Agent integration and decider

**Exit:** in a fresh Claude Code session, prompts produce bundles without naming skills; decision log records whether Claude followed them.

### Task 9: Daemon
`src/daemon.ts`: Hono on Unix socket `~/.claudethecaller/ctc.sock` + `127.0.0.1:18310` (dashboard); keeps models, index, store warm; `ctc daemon start|stop`. Endpoints: `POST /route {sessionId, prompt, cwd}`, `POST /event {sessionId, type, payload}`, `GET /bundle/:sessionId/:promptHash`. Tests: `/route` p95 < 100 ms over 50 calls with real TEI (integration); `/route` returns `{abstained:true}` on empty library.

### Task 10: Hooks
`src/hooks.ts` + `ctc hook <event>`; `ctc install` writes hook entries into `~/.claude/settings.json` (backup first, idempotent). UserPromptSubmit → `/route` with 150 ms timeout → prints a one-line hint `[claudethecaller] Suggested: <workflow or skill ids> — call find_capabilities for the plan` only when not abstained. PostToolUse/Stop → `/event` fire-and-forget. Tests: `daemon down → empty stdout, exit 0, < 200 ms`; `install twice → settings unchanged second time`.

### Task 11: Decider
`src/decide.ts`: `decide(hits: Hit[], ctx): Bundle`.
```ts
interface Bundle { intent: string; confidence: number; difficulty: "trivial"|"standard"|"complex"|"critical";
  modelTier: "haiku"|"sonnet"|"opus"; workflow?: string;
  steps: { order: number; capId: string; kind: CapKind; agent?: string; reason: string }[];
  memories: Memory[];   // empty until M3 (Memory defined in M3)
  abstained: boolean; }
```
Difficulty and tier from a logistic-regression classifier on the query embedding, trained offline on LLM-labeled prompts from the own-eval set (`eval/train-difficulty.ts`, weights in `data/difficulty.json`). Step order from the workflow's declared steps when a workflow is the top hit, else rerank order. Agent match: best `kind: "agent"` hit whose rerank score against the step's capability text ≥ 0.5. Every field carries a `reason` string. Tests: tier macro-F1 reported in eval; `workflow hit expands to its declared step order`; `no agent attached below 0.5`.

### Task 12: MCP meta-tool and follow tracking
`src/mcp.ts` (stdio, registered by `ctc install`): one tool `find_capabilities({ task: string, blocker?: string })` → returns the cached prefetch bundle if present, else routes live; output = Bundle JSON plus a short directive line "Use these in order; say why if you skip one." Follow tracking: PostToolUse events with `Skill`/`Agent`/slash-command names matching bundle `capId`s within the same turn set `decisions.followed = 1`. Tests: `cache hit served without calling embedder`; `followed flag set when Skill call matches`.

# Milestone 3 — Intent pre-calculation, memory engine and long-term memory

Implements the "Memory Engine" section. `src/memory.ts`: `ProjectProfile` (hash of CLAUDE.md + memory dir + package manifests + `.git/HEAD`), `SessionState` (ring buffer 20, running session vector, topic-shift at cosine < 0.55), decision-history prior (`+0.05` per follow, `−0.05` per ignore, clamped ±0.2, per project). Query vector = normalize(0.6·prompt + 0.25·session + 0.15·project), weights tuned on own-eval. Prefetch on UserPromptSubmit and on PostToolUse errors; semantic cache at cosine ≥ 0.95 keyed with `library_version + profile_version`. Async summary job via `Llm` every 5 turns. Tests: `topic shift resets window`; `unchanged files cause zero re-embeds`; `cache key changes when a skill changes`; eval adds prefetch Hit@5 and p95 on prefetch hit ≤ 10 ms.

**Long-term memory** (`src/ltm.ts`, implements the "Long-term memory" bullets above):
```ts
interface Memory { id: string; scope: "global" | "project"; project?: string; kind: "preference" | "convention" | "fact" | "skill_outcome";
  text: string; confidence: number; pinned: boolean; source: { session?: string; turn?: number; file?: string }; }
function extractCandidates(sessionId: string, llm: Llm): Promise<Omit<Memory, "id">[]>;
function writeMemory(c: Omit<Memory, "id">, ctx): Promise<{ op: "ADD" | "UPDATE" | "SUPERSEDE" | "NOOP"; id: string }>;
function recallMemories(qv: Float32Array, project: string, k?: number): Memory[];   // default k = 5
function importClaudeMemory(dirs: string[]): Promise<number>;
```
Tests: `near-duplicate (≥ 0.95) is NOOP and bumps use_count`; `0.85–0.95 same meaning merges into one row`; `contradiction supersedes and keeps the old row soft-deleted`; `secrets are redacted before extractCandidates calls the LLM` (fake `sk-…` key never reaches the fake Llm); `recall never returns another project's memories`; `pinned memory ignores decay`; `importClaudeMemory twice adds rows once`.

# Milestone 4 — Control dashboard

`dashboard/` (React + Vite, served by the daemon on `:18310`). Views: KPI cards with 7d/30d/90d/all (routing calls, adoption rate, lazy misses, p95 latency, tokens saved, cost by model tier) · stacked timeline of capability calls by project or capability · decision log table → explain drawer (stage scores from `ctc explain`) · library control (enable/disable/pin/block per project, dedup cluster review: merge/keep, re-enrich button) · activity heatmap · **sessions view** (left rail of projects with session counts; per session: title, project, time, model, agent time, tokens, turns, routing decisions and memories extracted from it, read from `sessions`/`events` plus Claude Code transcript metadata) · **memory view** (search and filter by project/kind/source, edit text, pin, delete, supersede history, provenance link to the source session; "memories used" shown in each decision's explain drawer). All reads from `decisions`/`events`/`capabilities`/`memories`; writes go through `setOverride` / memory endpoints and take effect on the next route. Tests: API contract tests for each endpoint; Playwright flows: block a skill → `ctc search` no longer returns it; delete a memory → next bundle's `memories[]` no longer contains it.

# Milestone 5 — Visual workflow editor

React Flow canvas in the dashboard: nodes are capabilities, agents and conditions; saves to `<project>/.claude/workflows/<name>.yaml` (`{ name, description, steps: [{ cap, agent?, when? }] }`), which Task 2's scanner already indexes as `kind: "workflow"` and Task 11 expands. Test: saved YAML round-trips through `parseCapability`.

# Milestone 6 — C++ hot path (only if profiling justifies)

Gate: a `bun --cpu-prof` profile of `/route` shows TypeScript fusion/filter/graph code > 20% of p95. Then a native addon (`native/`, CMake, node-addon-api) using USearch's C++ API with filtered search (predicate on enabled/blocked bitset) plus RRF and cluster-collapse in C++, behind the same `DenseIndex`/`search` interfaces. Test: identical results to the TS path on the full eval set; report p95 before/after.
