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

1. **Malformed capability files** → skipped with a warning, scan continues. `tests/capability.test.ts`.
2. **Daemon or TEI down / slow** → hook silent, exit 0, < 150 ms; CLI clear error. `tests/route.test.ts`, Task 5.
3. **Same skill name in two plugins** → two distinct IDs. `tests/capability.test.ts`.
4. **Huge SKILL.md bodies** → truncated to 6,000 chars for enrichment input, full body kept. Task 4 build rule.
5. **No relevant capability** → abstain, not a weak top-1. `tests/retrieve.test.ts` + false-trigger gate.

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

## Verification

No test-first ceremony. Two tiers, nothing else:

**Tier 1 — logic checks** (`bun test`): only code with branching or math. No tests for glue, parsing libraries, SQLite, rename atomicity or anything the type checker already proves.

| File | Asserts (exact values) | Milestone |
|---|---|---|
| `tests/capability.test.ts` | broken frontmatter → skipped, 1 warning with its path; `p1/skills/review` + `p2/skills/review` → both `p1:review`, `p2:review` present | M1 |
| `tests/index.test.ts` | rebuild with no changes → 0 embedder calls; edit 1 skill → only its texts re-embedded; `libraryVersion` changes iff a hash changes; FTS query `kiem thu` finds `kiểm thử` | M1 |
| `tests/retrieve.test.ts` | RRF k=60: item ranked (3,3) scores `2/63 = 0.03175` and beats (1,10) at `1/61 + 1/70 = 0.03068`; blocked never returned; pinned first; best rerank < τ → `{hits: [], abstained: true}`; dedup cluster → 1 hit; dedup: cosine 0.93 merged, 0.88 → review list, 0.80 apart | M1 |
| `tests/metrics.test.ts` | run `[a,b,c]`, gold `{b}` → R@1 = 0, R@2 = 1, MRR = 0.5, NDCG@3 = 0.6309; gold `{a,c}` → Completeness@2 = 0; abstain rates on a 4-item toy map | M1 |
| `tests/route.test.ts` | hook with daemon down → empty stdout, exit 0, < 200 ms; `ctc install` twice → settings byte-identical; workflow hit → its declared step order; agent with rerank < 0.5 not attached; matching `Skill` call sets `followed = 1` | M2 |
| `tests/ltm.test.ts` | cosine ≥ 0.95 → NOOP + `use_count` +1; 0.85–0.95 same meaning → UPDATE (1 row); contradiction → SUPERSEDE (old soft-deleted, linked); fake `sk-…` key never reaches the fake Llm; project A recall never returns project B rows; pinned skips decay; topic shift (cos < 0.55) resets window | M3 |
| `dashboard/e2e.spec.ts` (Playwright) | block a skill → `ctc search` drops it; delete a memory → next bundle's `memories[]` drops it | M4 |

**Tier 2 — metric gates** (`bun eval/run.ts --gate`, exit 1 on any miss; report saved to `data/report-<date>.md`):

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
- [ ] `bun init`; deps `usearch`, `yaml`, `@modelcontextprotocol/sdk`, `hono`; `.gitignore`: `node_modules`, `data/`, `*.usearch`, `*.db`.
- [ ] **Done when:** `bun -e 'const {Index}=require("usearch"); const i=new Index({dimensions:4}); i.add(1n,new Float32Array([1,0,0,0])); console.log(i.search(new Float32Array([1,0,0,0]),1).keys)'` prints `[1]`. If the binding fails under Bun, the daemon runs under Node (`tsx`); nothing else changes.

### Task 2: Capability scanner
**Files:** `src/capability.ts`
```ts
type CapKind = "skill" | "agent" | "command" | "workflow";
interface Capability { id: string; kind: CapKind; name: string; namespace: string;
  description: string; body: string; path: string; hash: string; }
function scanLibrary(roots: { dir: string; namespace: string }[]): { caps: Capability[]; warnings: string[] };
function defaultRoots(projectDir: string): { dir: string; namespace: string }[];
```
- [ ] **Build:** `id = namespace:name`; `hash = sha256(description + "\n" + body)`; kind by path (`skills/*/SKILL.md`, `agents/*.md`, `commands/*.md`, `workflows/*.{md,yaml}`); roots = `~/.claude/{skills,agents,commands}` (`user`), each plugin under `~/.claude/plugins/**` (plugin name), `<project>/.claude/**` (`project`). `yaml` + `Bun.Glob`.
- [ ] **Done when:** `tests/capability.test.ts` passes; real scan prints 300+ capabilities.

### Task 3: Store + index
**Files:** `src/store.ts`, `src/indexer.ts`
```ts
interface CapabilityRow extends Capability { enrichment?: Enrichment; clusterId?: string; }
function openStore(path: string): Store;
interface Store {
  upsertCapabilities(caps: Capability[]): { added: string[]; changed: string[]; removed: string[] };
  getCapability(id: string): CapabilityRow | undefined;
  setEnrichment(id: string, e: Enrichment): void;  setCluster(id: string, clusterId: string): void;
  getEmbedding(textHash: string, modelVersion: string): Float32Array | undefined;
  putEmbedding(textHash: string, modelVersion: string, v: Float32Array): void;
  ftsSearch(query: string, k: number): { id: string; score: number }[];
  libraryVersion(): string;
  setOverride(project: string, id: string, action: "pin" | "block" | "disable" | null): void;
  overrides(project: string): Map<string, "pin" | "block" | "disable">;
}
function buildIndex(o: { store: Store; embedder: Embedder; llm?: Llm; dir: string }): Promise<{ vectors: number; enriched: number; clusters: number }>;
function openIndex(dir: string): DenseIndex;
interface DenseIndex { search(q: Float32Array, k: number): { capId: string; score: number }[]; }
```
- [ ] **Build:** `bun:sqlite`, WAL. Tables `capabilities`, `triggers`, `fts` (FTS5, `unicode61 remove_diacritics 2`, over name/description/summary/triggers), `embeddings`, `overrides`, `sessions`, `events`, `decisions`, `memories`. Multi-vector per capability (`name+description+summary` + one per trigger), max-score per capability; embed/enrich only changed hashes; write `skills.usearch.tmp` → rename.
- [ ] **Done when:** `tests/index.test.ts` passes (fake embedder = hash-to-vector).

### Task 4: Models, enrichment, dedup
**Files:** `docker-compose.yml`, `src/models.ts`, `src/enrich.ts`
```ts
interface Embedder { modelVersion: string; dim: number; embed(texts: string[], as: "query" | "doc"): Promise<Float32Array[]>; }
interface Reranker { score(query: string, docs: string[]): Promise<number[]>; }
interface Llm { json<T>(system: string, user: string, schema: object): Promise<T>; }
function teiEmbedder(url: string, model: string): Embedder;  function teiReranker(url: string): Reranker;
function llmFromEnv(): Llm;   // CTC_LLM=anthropic:<model> | openai:<baseUrl>:<model>
interface Enrichment { summary: string; triggers: string[]; prerequisites: string[]; inputs: string; outputs: string; }
function enrich(cap: Capability, llm: Llm): Promise<Enrichment>;
function dedupClusters(ids: string[], vecs: Float32Array[]): { clusters: string[][]; review: [string, string][] };
```
- [ ] **Build:** TEI `:18300` = `ThakiCloud/SKILLRET-Embedding-0.6B` (env swap to `BAAI/bge-m3`), `:18301` = `BAAI/bge-reranker-v2-m3`, FP16; query side uses the model card's instruction prefix. If TEI can't serve the SkillRet model, a `sentence-transformers` FastAPI sidecar on the same port/shape. Offline LLM default `anthropic:claude-haiku-5-5`, local alt `Qwen/Qwen2.5-3B-Instruct`. `enrich`: body truncated to 6,000 chars, 8–12 triggers (≥ 2 non-English), schema-enforced. Dedup: USearch k-NN + union-find at ≥ 0.92; [0.85, 0.92) → `review`.
- [ ] **Done when:** dedup rows of `tests/retrieve.test.ts` pass; `curl` both TEI endpoints → 200; GPU ≤ 7 GB.

### Task 5: Retriever + CLI
**Files:** `src/retrieve.ts`, `src/cli.ts`
```ts
interface Hit { capId: string; score: number; stages: { dense?: number; denseRank?: number; sparseRank?: number; rrf: number; rerank?: number } }
interface SearchResult { hits: Hit[]; abstained: boolean; ms: Record<string, number> }
function search(q: string, ctx: { store: Store; dense: DenseIndex; embedder: Embedder; reranker: Reranker; project?: string },
                opts?: { k?: number; rerankTop?: number; abstainBelow?: number }): Promise<SearchResult>;
```
- [ ] **Build:** dense 50 ∥ FTS 50 → RRF (k = 60) → drop block/disable, collapse clusters → rerank top 20 → pins to top → abstain below τ (default 0.3 until Task 6 calibrates) → top 5. CLI `ctc index | search [--json] | explain | status`; `explain` shows every stage score incl. dropped items with reason; TEI down → exit 1 `embedder unreachable at <url>` in < 2 s. `bun build --compile src/cli.ts --outfile ctc`.
- [ ] **Done when:** `tests/retrieve.test.ts` passes; `ctc explain "fix a flaky test"` sanity check.

### Task 6: Eval harness + gates
**Files:** `eval/metrics.ts`, `eval/datasets.ts`, `eval/label.ts`, `eval/run.ts`
```ts
type Run = Map<string, string[]>; type Qrels = Map<string, Set<string>>;
function recallAt(r: Run, q: Qrels, k: number): number;  function ndcgAt(r: Run, q: Qrels, k: number): number;
function mrr(r: Run, q: Qrels): number;  function completenessAt(r: Run, q: Qrels, k: number): number;
function abstainRates(pred: Map<string, boolean>, gold: Map<string, boolean>): { correctAbstain: number; falseTrigger: number };
```
- [ ] **Build:** loaders for SkillRet test (`data/{skills,queries,qrels}/test.jsonl`) and MetaTool reliability subset. `label.ts`: user turns from `~/.claude/projects/**/*.jsonl`, secrets redacted (API keys, tokens, credential URLs) before the judge, output `data/own-eval.jsonl` + 200-row `data/own-eval-review.csv`. `run.ts`: {SkillRet-0.6B, bge-m3} × {dense, hybrid, hybrid+rerank}, p50/p95 per stage, τ sweep (max correct-abstain at false-trigger ≤ 10%) written back as the `abstainBelow` default; `--gate` enforces Tier 2.
- [ ] **Done when:** `tests/metrics.test.ts` passes; owner hand-checks the 200 rows; `bun eval/run.ts --gate` exits 0 on M1 gates.

---

# Milestone 2 — Agent integration and decider

**Exit:** fresh Claude Code session gets bundles without naming skills; `tests/route.test.ts` + M2 gates pass.

### Task 7: Daemon + hooks
`src/daemon.ts`: Hono on `~/.claudethecaller/ctc.sock` + `127.0.0.1:18310`; keeps models/index/store warm; `ctc daemon start|stop`; `POST /route {sessionId, prompt, cwd}`, `POST /event`, `GET /bundle/:sessionId/:promptHash`. `src/hooks.ts`: `ctc hook <event>`; `ctc install` edits `~/.claude/settings.json` (backup, idempotent). UserPromptSubmit → `/route` with 150 ms timeout → one line `[claudethecaller] Suggested: <ids> — call find_capabilities for the plan` unless abstained; PostToolUse/Stop → `/event` fire-and-forget.

### Task 8: Decider + MCP tool
`src/decide.ts`:
```ts
interface Bundle { intent: string; confidence: number; difficulty: "trivial"|"standard"|"complex"|"critical";
  modelTier: "haiku"|"sonnet"|"opus"; workflow?: string;
  steps: { order: number; capId: string; kind: CapKind; agent?: string; reason: string }[];
  memories: Memory[];   // empty until M3
  abstained: boolean; }
function decide(hits: Hit[], ctx): Bundle;
```
Difficulty/tier: logistic regression on the query embedding, trained offline on LLM-labeled own-eval prompts (`eval/train-difficulty.ts` → `data/difficulty.json`). Steps: workflow's declared order if a workflow is top, else rerank order. Agent: best `agent` hit with rerank ≥ 0.5 vs the step. Every field has a `reason`. `src/mcp.ts` (stdio, registered by `ctc install`): `find_capabilities({ task, blocker? })` → cached prefetch bundle or live route, plus "Use these in order; say why if you skip one." Follow tracking: matching `Skill`/`Agent`/slash calls in the same turn set `decisions.followed = 1`.

---

# Milestone 3 — Intent pre-calculation, memory engine, long-term memory

**Exit:** `tests/ltm.test.ts` + M3 gates pass.

### Task 9: Session + project memory, prefetch
`src/memory.ts`: `ProjectProfile` (hash of CLAUDE.md + memory dir + manifests + `.git/HEAD`), `SessionState` (ring 20, running vector, topic shift < 0.55), decision prior (±0.05 per follow/ignore, clamp ±0.2). Query vector = normalize(0.6·prompt + 0.25·session + 0.15·project), tuned on own-eval. Prefetch on UserPromptSubmit and PostToolUse errors; semantic cache ≥ 0.95 keyed with `library_version + profile_version`; async summary every 5 turns.

### Task 10: Long-term memory
`src/ltm.ts`, implements "Long-term memory" above:
```ts
interface Memory { id: string; scope: "global" | "project"; project?: string; kind: "preference" | "convention" | "fact" | "skill_outcome";
  text: string; confidence: number; pinned: boolean; source: { session?: string; turn?: number; file?: string }; }
function extractCandidates(sessionId: string, llm: Llm): Promise<Omit<Memory, "id">[]>;
function writeMemory(c: Omit<Memory, "id">, ctx): Promise<{ op: "ADD" | "UPDATE" | "SUPERSEDE" | "NOOP"; id: string }>;
function recallMemories(qv: Float32Array, project: string, k?: number): Memory[];   // k = 5
function importClaudeMemory(dirs: string[]): Promise<number>;
```

---

# Milestone 4 — Control dashboard

`dashboard/` (React + Vite, served on `:18310`): KPI cards 7d/30d/90d/all (routing calls, adoption, lazy misses, p95, tokens saved, cost by tier) · stacked timeline by project/capability · decision log → explain drawer (stage scores + memories used) · library control (enable/disable/pin/block per project, dedup review merge/keep, re-enrich) · sessions view (project rail with counts; per session title, model, agent time, tokens, turns, decisions, extracted memories) · memory view (search/filter, edit, pin, delete, supersede history, link to source session) · activity heatmap. Writes take effect on the next route. **Done when:** `dashboard/e2e.spec.ts` passes.

# Milestone 5 — Visual workflow editor

React Flow canvas → `<project>/.claude/workflows/<name>.yaml` (`{ name, description, steps: [{ cap, agent?, when? }] }`), indexed by Task 2, expanded by Task 8. **Done when:** a saved workflow shows up in `ctc search` and its bundle keeps the drawn step order.

# Milestone 6 — C++ hot path (only if profiling justifies)

Gate: `bun --cpu-prof` on `/route` shows TS fusion/filter/graph > 20% of p95. Then `native/` (CMake, node-addon-api, USearch C++ filtered search + RRF + cluster collapse) behind the same `DenseIndex`/`search` interfaces. **Done when:** identical rankings on the full eval set and lower p95 in the gate report.
