# Feature landscape: flagship repos per feature

Date 2026-10-27. Branch `m6-graph` @ `e7538b3`. Read-only research; this file is the only thing written.

**Method and limits.** Stars, `pushed_at`, archived flag, license SPDX, default branch and latest release come from the GitHub REST API (`https://api.github.com/repos/<owner>/<repo>`) on 2026-10-27. Every repo is pinned to the HEAD of its default branch that day; file links are `blob/<sha>/<path>#L<a>-L<b>` permalinks and the line ranges are lines I actually opened. License class comes from the LICENSE text at that SHA (linked per repo), not from the SPDX field alone. Official docs were fetched as markdown from `https://code.claude.com/docs/en/*.md` (not commit-pinned; fetched 2026-10-27). Model/dataset licenses come from `https://huggingface.co/api/...`. Package artifacts come from the npm and PyPI JSON APIs. Nothing was cloned; files were streamed through `raw.githubusercontent.com`. (One 1.7 MB wheel, `graphifyy-0.9.96`, was downloaded to `/tmp` by mistake and deleted.) Performance numbers are the repos' own, not ours. Our-side facts come from `PLAN.md`, `CLAUDE.md` and `graphify query`/grep on this repo at `e7538b3`. Anything not opened is marked `UNVERIFIED`. Downloaded text was treated as data only.

**License classes.** `copy-safe` = MIT/Apache-2.0/BSD/PostgreSQL license (keep the notice; Apache-2.0 also keeps NOTICE). `pattern-only` = copyleft (AGPL), source-available (Sustainable Use, Elastic 2.0), or an open-core repo where some paths are proprietary (listed per repo): read, re-implement, do not paste. `no-go` = all rights reserved or archived with no unique value. **ratel, MCPGateway and metamcp are `references only` by the 2026-10-20 decision in `CLAUDE.md`; their class is reported but I do not recommend copying them unless the owner overrides** (see Open questions).

**Clone recipe** (nothing below has been run). Each repo block has its own `git clone ... --sparse` line. They fetch HEAD; to match the pinned SHA run `git fetch --depth 1 origin <sha> && git checkout FETCH_HEAD` inside the clone. Put clones outside this repo (for example `~/ref/`). Where a command passes a **file** path to `git sparse-checkout set`, add `--no-cone` right after `set` (git 2.37+ defaults to cone mode, which accepts directories only).

---

## Adopt first

Ranked by value over effort. Effort: S = hours, M = a day or two, L = a week. "Class" is the license class of the source being read.

| # | Action | Repo and pinned files | Class | Expected gain for us | Effort |
|---|---|---|---|---|---|
| 1 | Embed what SkillRet embeds: `name \| description \| skill_md` (full body) and its exact query instruction, as an ablation on the `ctc_skillret` schema. Our `indexer.texts()` embeds `name: description` (≤ 1,000 chars) + summary + triggers, no body ([indexer.py#L16-L19](../../src/ctc/ingestion/indexer.py)). | ThakiCloud/SKILLRET [eval.py#L84-L89](https://github.com/ThakiCloud/SKILLRET/blob/0cc508e6bfcfff1fe6352d90ff5957ba38a64bba/skillret/eval.py#L84-L89), [config.py#L17](https://github.com/ThakiCloud/SKILLRET/blob/0cc508e6bfcfff1fe6352d90ff5957ba38a64bba/skillret/config.py#L17) | pattern-only (code has no LICENSE file; HF model/dataset cards say apache-2.0) | Their paper-grade table reports NDCG@10 **81.12** for this very embedder ([README#L205](https://github.com/ThakiCloud/SKILLRET/blob/0cc508e6bfcfff1fe6352d90ff5957ba38a64bba/README.md#L205)); our dense-only run is 0.787. Closing part of a 2.4-point gap is the cheapest quality lever (hypothesis, not tested). | S |
| 2 | Try score fusion instead of RRF: `(1-w)·lexical_norm + w·cos`, w=0.7, plus the fused magnitude as a gate feature. | ratel-ai/ratel [fusion.rs#L164-L233](https://github.com/ratel-ai/ratel/blob/b525ca86a535f57e3ff3a17af763d809a1960242/src/core/src/fusion.rs#L164-L233), [ADR-0024#L91-L110](https://github.com/ratel-ai/ratel/blob/b525ca86a535f57e3ff3a17af763d809a1960242/docs/adr/0024-hybrid-fuses-on-scores.md#L91-L110) | `ratel-ai-core` crate is Apache-2.0, rest MIT ([NOTICE](https://github.com/ratel-ai/ratel/blob/b525ca86a535f57e3ff3a17af763d809a1960242/NOTICE)); references-only, so re-implement the 10-line formula | Same finding as ours (keyword RRF hurts): their bench shows score fusion beats RRF on every metric at every k on BFCL, and RRF returns the same ~0.033 for right and wrong queries ([ADR-0024#L47-L64](https://github.com/ratel-ai/ratel/blob/b525ca86a535f57e3ff3a17af763d809a1960242/docs/adr/0024-hybrid-fuses-on-scores.md#L47-L64)). A bounded fused score is also the missing absolute signal for the abstain gate. Needs a [0,1] keyword arm (our `ts_rank_cd` is not BM25; normalise it, my suggestion, untested). | S |
| 3 | Re-run K2 with a calibrator: Platt/isotonic + ECE over a score, `None` label = "no capability fires" (MetaTool negatives). | aurelio-labs/semantic-router [calibration.py#L11-L109](https://github.com/aurelio-labs/semantic-router/blob/1fa1937e390fe57fb85ee3bbb8b3db593a4145db/semantic_router/calibration.py#L11-L109), [routers/base.py#L160-L176](https://github.com/aurelio-labs/semantic-router/blob/1fa1937e390fe57fb85ee3bbb8b3db593a4145db/semantic_router/routers/base.py#L160-L176) | copy-safe (MIT) | 109 self-contained numpy lines replace the LR gate that scored AUC 0.55. Only helps once the input score carries signal (rows 2 and 5). | S |
| 4 | Add a margin ("clear winner") rule as a classifier-free abstain baseline: fire only if top1 ≥ 1.5 × top2 on the raw score. | ratel-local [suggest.ts#L128-L145](https://github.com/ratel-ai/ratel-local/blob/948cdbd33cdcb770183ededc310202e2aaa145bd/apps/ratel-local/src/cli/skills/suggest.ts#L128-L145) | MIT, references-only: re-implement | One parameter to sweep on dev; they ship it as their push-hook gate. Our `gate.py` already has `dense_gap`/`rerank_gap` features, so this is a 10-line threshold test. | S |
| 5 | Use `ranx.compare` (paired test) and `ranx.optimize_fusion` to settle "rerank +0.025 dev, -0.014 test" and to tune `ranking` weights with a proper split. | AmenRa/ranx [meta/compare.py#L11-L35](https://github.com/AmenRa/ranx/blob/7363db0c35e92e90d6fa6fe73907b760678f765e/ranx/meta/compare.py#L11-L35), [meta/optimize_fusion.py#L8-L77](https://github.com/AmenRa/ranx/blob/7363db0c35e92e90d6fa6fe73907b760678f765e/ranx/meta/optimize_fusion.py#L8-L77) | copy-safe (MIT); already our dependency | Turns an ambiguous dev/test disagreement into a p-value. ranx is quiet since 2025-08-07 but works. | S |
| 6 | Evaluate **SKILLRET-Reranker-0.6B** (Qwen3 yes/no reranker trained on SkillRet) in place of bge-reranker-v2-m3. | ThakiCloud/SKILLRET [eval.py#L890-L960](https://github.com/ThakiCloud/SKILLRET/blob/0cc508e6bfcfff1fe6352d90ff5957ba38a64bba/skillret/eval.py#L890-L960); model [HF](https://huggingface.co/ThakiCloud/SKILLRET-Reranker-0.6B) apache-2.0, 596M params, `Qwen3ForCausalLM` | model copy-safe; code pattern-only (re-implement the ~70-line yes/no scorer) | Their table: +1.3 NDCG@10 over embed-only on top-20 ([README#L209-L215](https://github.com/ThakiCloud/SKILLRET/blob/0cc508e6bfcfff1fe6352d90ff5957ba38a64bba/README.md#L209-L215)); ours is -0.014 with bge on test. **TEI cannot serve it**: its README lists only XLM-R/GTE/ModernBERT rerankers ([README#L109-L112](https://github.com/huggingface/text-embeddings-inference/blob/069ceab366d7cab14cfd40dbcb0d58c93f892583/README.md#L109-L112)), so it needs a small transformers/vLLM sidecar (~1.2 GB in bf16, computed from 596M params, not measured). | M |
| 7 | One-line probe: `raw_scores: true` on TEI `/rerank` and put logit-space features in the gate. | TEI [core/src/infer.rs#L458-L480](https://github.com/huggingface/text-embeddings-inference/blob/069ceab366d7cab14cfd40dbcb0d58c93f892583/core/src/infer.rs#L458-L480), [http/types.rs#L243-L260](https://github.com/huggingface/text-embeddings-inference/blob/069ceab366d7cab14cfd40dbcb0d58c93f892583/router/src/http/types.rs#L243-L260); our call [reranker.py#L26](../../src/ctc/reranking/reranker.py) | copy-safe (Apache-2.0) | Without `raw_scores` TEI applies a sigmoid per pair, which squashes our "0.001-0.04" scores; logits keep their spacing. It cannot change the ordering, so expect gate features, not recall. | S |
| 8 | Replace the `curl` hook with Claude Code's native `type: "http"` hook. | [hooks.md `#http-hook-fields`](https://code.claude.com/docs/en/hooks.md) and `#http-response-handling` | docs (not code) | No process spawn per prompt, `headers` + `allowedEnvVars` for shared-mode API keys, connection failure is a non-blocking error (same fail-open). Catch: a 2xx **plain-text** body is a non-blocking error and adds nothing to context, so `/v1/hook/prompt` must return `hookSpecificOutput.additionalContext` JSON (capped at 10,000 chars). | S-M |
| 9 | Feed `followed` history back into ranking as a bounded, sub-unit "usage arm" (invocation-only evidence, impressions as denominator). | ratel [usage_learner.rs#L1-L45](https://github.com/ratel-ai/ratel/blob/b525ca86a535f57e3ff3a17af763d809a1960242/src/core/src/usage_learner.rs#L1-L45), [fusion.rs#L23-L37](https://github.com/ratel-ai/ratel/blob/b525ca86a535f57e3ff3a17af763d809a1960242/src/core/src/fusion.rs#L23-L37) | Apache-2.0 core, references-only: pattern | Our Memory design already nudges ±0.05 per follow/ignore; ratel's rule "only invocations become edges, a search nobody acts on teaches nothing" fixes the self-reinforcement risk. | M |
| 10 | Swap the fixed-window `INCR rl:{user}:{minute}` for an atomic sliding-window Lua script. | IBM/mcp-context-forge [rate_limit_middleware.py#L51-L73](https://github.com/IBM/mcp-context-forge/blob/85dabf0beb75d05f8ff230fb823f7fe60aa1871a/mcpgateway/middleware/rate_limit_middleware.py#L51-L73) | copy-safe (Apache-2.0; no `ee/` or `enterprise/` path in the tree at this SHA) | Removes the boundary burst of fixed windows in shared mode; our limiter is `Cache.hit_rate` used at [app.py#L137](../../src/ctc/server/app.py). | S |

---

## F1. Capability index and enrichment

**Ours today.** `src/ctc/ingestion/scanner.py` scans skills/agents/commands/workflows; `src/ctc/ingestion/indexer.py` embeds `name: description` + summary + each trigger (L16-L19, no body); `src/ctc/ai/enrich.py` (A1: summary, triggers, dedup); `src/ctc/server/library.py` (CRUD, `pin|block|disable` overrides, namespaces).
**Question.** What do other skill/tool routers index per capability (body, hints, learned usage), and how do they do overrides, filters and namespaces?

| Repo | Stars / last push / license (2026-10-27) | Class | What it gives | Verdict |
|---|---|---|---|---|
| [ratel-ai/ratel](https://github.com/ratel-ai/ratel) (+ [ratel-local](https://github.com/ratel-ai/ratel-local), [ratel-bench](https://github.com/ratel-ai/ratel-bench)) | 535 / 2026-10-26 / MIT; `ratel-ai-core` Apache-2.0 | copy-safe, **references-only** | Rust core with BM25 + dense + score fusion + a learned usage arm; first-class skills; Claude plugin and CLI; a benchmark harness | pattern (closest product) |
| [metatool-ai/metamcp](https://github.com/metatool-ai/metamcp) | 2,732 / 2026-06-22 (branch `ai-dev`) / MIT | copy-safe, **references-only** | Middleware chain: inactive-tool filter and per-tool overrides with TTL caches | pattern (4 months quiet) |
| [IBM/mcp-context-forge](https://github.com/IBM/mcp-context-forge) | 4,700 / 2026-10-25 / Apache-2.0 | copy-safe | Registry/gateway; useful parts are token scoping and rate limits (F11) | pattern (see F11) |
| [abdullah1854/MCPGateway](https://github.com/abdullah1854/MCPGateway) | 17 / 2026-06-25 / MIT | copy-safe, **references-only** | `*_search_tools` with detail levels (`name_description`, `micro`) | skip, tiny |
| [managedcode/MCPGateway](https://github.com/managedcode/MCPGateway) | 5 / 2026-10-24 / MIT (.NET) | copy-safe, **references-only** | Graph + vector + lexical search, confidence diagnostics | skip (`UNVERIFIED` which "MCPGateway" `CLAUDE.md` means) |

**ratel-ai/ratel** @ `b525ca8` · [LICENSE.md](https://github.com/ratel-ai/ratel/blob/b525ca86a535f57e3ff3a17af763d809a1960242/LICENSE.md) + [NOTICE](https://github.com/ratel-ai/ratel/blob/b525ca86a535f57e3ff3a17af763d809a1960242/NOTICE)
- Read: [usage_learner.rs#L1-L45](https://github.com/ratel-ai/ratel/blob/b525ca86a535f57e3ff3a17af763d809a1960242/src/core/src/usage_learner.rs#L1-L45) (how a search window is joined to a later invoke by `turn_id`; only invocations become evidence); [rerank.rs#L1-L45](https://github.com/ratel-ai/ratel/blob/b525ca86a535f57e3ff3a17af763d809a1960242/src/core/src/rerank.rs#L1-L45) (a reranker only re-scores stage-1's top `depth`, ties keep stage-1 order). ADR list at [docs/adr/](https://github.com/ratel-ai/ratel/tree/b525ca86a535f57e3ff3a17af763d809a1960242/docs/adr); 0014 (adaptive usage ranking, 48 KB) and 0019 (retrieval experiments, 32 KB) are `UNVERIFIED` beyond their names.
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/ratel-ai/ratel ~/ref/ratel && cd ~/ref/ratel && git sparse-checkout set src/core/src docs/adr`
- REA/graph: built artifacts exist (npm [`@ratel-ai/ratel-local@0.9.0`](https://registry.npmjs.org/@ratel-ai/ratel-local/-/ratel-local-0.9.0.tgz), 6.9 MB unpacked; [`@ratel-ai/sdk@0.12.0`](https://registry.npmjs.org/@ratel-ai/sdk/-/sdk-0.12.0.tgz) carries the Rust core as a native binding). Source is open, so use graphify on the sparse clone; REA only if you want the shipped CLI bundle.
- Maps to: `indexer.py`/`hybrid.py` (fusion, F2), `memory`/`decisions` follow tracking (usage arm).

**metatool-ai/metamcp** @ `ff4ff2d` · [LICENSE](https://github.com/metatool-ai/metamcp/blob/ff4ff2de9d25453c52dcc7be32680b30700a6012/LICENSE) (MIT)
- Read: [filter-tools.functional.ts#L21-L104](https://github.com/metatool-ai/metamcp/blob/ff4ff2de9d25453c52dcc7be32680b30700a6012/apps/backend/src/lib/metamcp/metamcp-middleware/filter-tools.functional.ts#L21-L104) (1 s TTL `ToolStatusCache` in front of the DB); [tool-overrides.functional.ts#L19-L61](https://github.com/metatool-ai/metamcp/blob/ff4ff2de9d25453c52dcc7be32680b30700a6012/apps/backend/src/lib/metamcp/metamcp-middleware/tool-overrides.functional.ts#L19-L61) (override name/title/description/annotations, cached).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/metatool-ai/metamcp ~/ref/metamcp && cd ~/ref/metamcp && git sparse-checkout set apps/backend/src/lib/metamcp/metamcp-middleware`
- REA/graph: source-only: graphify on that path.
- Maps to: `library.py` overrides and `ovr:{user}:{project}` 5-min cache (PLAN Cache design).

**IBM/mcp-context-forge** @ `85dabf0` · [LICENSE](https://raw.githubusercontent.com/IBM/mcp-context-forge/85dabf0beb75d05f8ff230fb823f7fe60aa1871a/LICENSE) (Apache-2.0). Covered in F11.

**abdullah1854/MCPGateway** @ `549f494` · [LICENSE](https://raw.githubusercontent.com/abdullah1854/MCPGateway/549f494a9e363f40530149de324b8097de424230/LICENSE) (MIT)
- Read: [gateway-tools/discovery.ts#L4-L60](https://github.com/abdullah1854/MCPGateway/blob/549f494a9e363f40530149de324b8097de424230/src/code-execution/gateway-tools/discovery.ts#L4-L60) (progressive discovery tool surface: search, categories, detail levels).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/abdullah1854/MCPGateway ~/ref/mcpgateway-a && cd ~/ref/mcpgateway-a && git sparse-checkout set src/code-execution`
- REA/graph: source-only.
- Maps to: `server/mcp.py` `find_capabilities` response detail. Low value.

**managedcode/MCPGateway** @ `f79260e` · [LICENSE](https://raw.githubusercontent.com/managedcode/MCPGateway/f79260ed7ccb4656050897b15639d0bc76578049/LICENSE) (MIT). Only idea worth noting: a confidence that blends the raw score with the share of query terms the descriptor supports ([SearchConfidence.cs#L23-L62](https://github.com/managedcode/MCPGateway/blob/f79260ed7ccb4656050897b15639d0bc76578049/src/ManagedCode.MCPGateway/Search/Internal/Confidence/McpGatewayRuntime.SearchConfidence.cs#L23-L62)): a "term coverage" gate feature for `gate.py`. Clone/REA: not needed.

---

## F2. Hybrid retrieval and rerank

**Ours today.** `src/ctc/retrieval/hybrid.py`: weighted RRF ([L52](../../src/ctc/retrieval/hybrid.py)), `search()` L61-L119 (dense in RAM, keywords via Postgres `ts_rank_cd`, rerank top 20, final order = RRF(dense rank, rerank rank)); `src/ctc/reranking/reranker.py` ([L25-L26](../../src/ctc/reranking/reranker.py): `POST /rerank {query, texts}`); `src/ctc/embedding/embedder.py` (query instruction prefix); `src/ctc/storage/store.py` (`candidates()`).
**Question.** Why is dense-only (NDCG@10 0.787) ≥ hybrid + rerank (0.771) on SkillRet test? Is RRF the right fusion, is our keyword arm weak, is bge-reranker the wrong reranker, and are we embedding the same text the embedder was trained on? (Fusion, reranker and text-parity answers are in rows 1, 2, 6, 7 of "Adopt first"; the SkillRet sources are detailed in F9.)

| Repo | Stars / last push / license | Class | What it gives | Verdict |
|---|---|---|---|---|
| [huggingface/text-embeddings-inference](https://github.com/huggingface/text-embeddings-inference) | 5,088 / 2026-10-13 / Apache-2.0 (latest v1.9.4) | copy-safe | The server we run: exact `/rerank` scoring semantics, supported reranker list | reuse as-is; read for semantics |
| [FlagOpen/FlagEmbedding](https://github.com/FlagOpen/FlagEmbedding) | 12,278 / 2026-08-24 / MIT | copy-safe | Reference scoring for bge rerankers (raw logit, optional sigmoid), LLM rerankers | pattern |
| [pgvector/pgvector](https://github.com/pgvector/pgvector) + [pgvector-python](https://github.com/pgvector/pgvector-python) | 23,489 and 1,539 / 2026-10-26 and 2026-10-21 / PostgreSQL License (API says NOASSERTION) and MIT | copy-safe | Canonical SQL RRF; iterative index scans | pattern (confirms our shape) |
| [supabase/supabase](https://github.com/supabase/supabase) (docs) | 114,051 / 2026-10-27 / Apache-2.0 | copy-safe (docs content license `UNVERIFIED`) | Weighted RRF SQL function for our exact stack | pattern (no new info) |
| [paradedb/paradedb](https://github.com/paradedb/paradedb) | 9,453 / 2026-10-27 / AGPL-3.0 | **pattern-only** | In-Postgres BM25 (`pg_search`) + weighted RRF docs | pattern; availability on Supabase `UNVERIFIED` |
| ratel-ai/ratel; ThakiCloud/SKILLRET | see F1, F9 | | Score fusion; SkillRet reranker and text format | **reuse the ideas** |

**huggingface/text-embeddings-inference** @ `069ceab` · [LICENSE](https://raw.githubusercontent.com/huggingface/text-embeddings-inference/069ceab366d7cab14cfd40dbcb0d58c93f892583/LICENSE) (Apache-2.0)
- Read: [core/src/infer.rs#L458-L480](https://github.com/huggingface/text-embeddings-inference/blob/069ceab366d7cab14cfd40dbcb0d58c93f892583/core/src/infer.rs#L458-L480) (unless `raw_scores`, a single-label output goes through a sigmoid; multi-label through softmax); [router/src/http/server.rs#L346-L361](https://github.com/huggingface/text-embeddings-inference/blob/069ceab366d7cab14cfd40dbcb0d58c93f892583/router/src/http/server.rs#L346-L361) (rerank = one `predict` per (query, text) pair, so scores are per-pair, not softmaxed across the batch); [README#L109-L112](https://github.com/huggingface/text-embeddings-inference/blob/069ceab366d7cab14cfd40dbcb0d58c93f892583/README.md#L109-L112) (reranker support list: XLM-R, GTE, ModernBERT; no Qwen3 reranker).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/huggingface/text-embeddings-inference ~/ref/tei && cd ~/ref/tei && git sparse-checkout set core/src router/src/http`
- REA/graph: Docker image `ghcr.io/huggingface/text-embeddings-inference:89-1.8.2` (the tag we pin) exists locally, but source answers every question here: source-only.
- Maps to: `reranker.py#L26` (add `"raw_scores": true`). Note we pin 1.8.2, this reading is 1.9.4-era `main`; the sigmoid logic should be re-checked in the 1.8.2 tag (`UNVERIFIED`).

**FlagOpen/FlagEmbedding** @ `fd1a2bd` · [LICENSE](https://raw.githubusercontent.com/FlagOpen/FlagEmbedding/fd1a2bdf69488ffebe0327999d4400d8c8058a0b/LICENSE) (MIT)
- Read: [inference/reranker/encoder_only/base.py#L11-L13](https://github.com/FlagOpen/FlagEmbedding/blob/fd1a2bdf69488ffebe0327999d4400d8c8058a0b/FlagEmbedding/inference/reranker/encoder_only/base.py#L11-L13) and `#L33` (`normalize=False` default, i.e. raw logits; sigmoid is opt-in). Decoder-only (LLM) rerankers live in `inference/reranker/decoder_only/{base,layerwise,lightweight}.py` (listed in the [tree](https://github.com/FlagOpen/FlagEmbedding/tree/fd1a2bdf69488ffebe0327999d4400d8c8058a0b/FlagEmbedding/inference/reranker/decoder_only), contents `UNVERIFIED`).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/FlagOpen/FlagEmbedding ~/ref/flag && cd ~/ref/flag && git sparse-checkout set FlagEmbedding/inference/reranker`
- REA/graph: source-only.
- Maps to: the interpretation of `reranker.py` scores in `gate.py` features.

**pgvector** @ `0dc5fa2` · [LICENSE](https://raw.githubusercontent.com/pgvector/pgvector/0dc5fa2ccbe9185117dc428d193bb3d0093317f3/LICENSE) (PostgreSQL License text) / **pgvector-python** @ `e0f3ac3` (MIT)
- Read: [README#L633-L642](https://github.com/pgvector/pgvector/blob/0dc5fa2ccbe9185117dc428d193bb3d0093317f3/README.md#L633-L642) (hybrid search); [README#L450-L500](https://github.com/pgvector/pgvector/blob/0dc5fa2ccbe9185117dc428d193bb3d0093317f3/README.md#L450-L500) (filters apply after the HNSW scan; `hnsw.iterative_scan`); [examples/hybrid_search/rrf.py#L24-L46](https://github.com/pgvector/pgvector-python/blob/e0f3ac37b8f05216cd02a3e4cdd502bcbdb0539d/examples/hybrid_search/rrf.py#L24-L46) (full-outer-join RRF, `ts_rank_cd`, k=60: what `Store.candidates` mirrors).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/pgvector/pgvector-python ~/ref/pgvector-python && cd ~/ref/pgvector-python && git sparse-checkout set examples/hybrid_search`
- REA/graph: source-only. Maps to: `store.py candidates()`; the iterative-scan note matters only if dense moves back from RAM to pgvector.

**supabase/supabase docs** @ `fdab2cc` · [hybrid-search.mdx#L84-L100](https://github.com/supabase/supabase/blob/fdab2cc75197438adbb87af9e975fd51d06afd58/apps/docs/content/guides/ai/hybrid-search.mdx#L84-L100): `hybrid_search(query_text, query_embedding, match_count, full_text_weight=1, semantic_weight=1, rrf_k=50)`. Same design as ours; `keyword-search.mdx` and `semantic-search.mdx` sit beside it. Clone: not needed (read online).

**paradedb/paradedb** @ `3350c6d` · [LICENSE](https://raw.githubusercontent.com/paradedb/paradedb/3350c6d738b1aa75e38397c7001413a5d7c90f10/LICENSE) (AGPL-3.0) → pattern-only
- Read: [docs/reference/hybrid/rrf.mdx#L1-L40](https://github.com/paradedb/paradedb/blob/3350c6d738b1aa75e38397c7001413a5d7c90f10/docs/reference/hybrid/rrf.mdx#L1-L40) (per-branch weights, `weight/(k+rank)`, a "Choosing Weights" section); [docs/concepts/hybrid/overview.mdx](https://github.com/paradedb/paradedb/blob/3350c6d738b1aa75e38397c7001413a5d7c90f10/docs/concepts/hybrid/overview.mdx) (why they merge by rank).
- Supabase check: the extension docs directory has `pgroonga.mdx` and `rum.mdx` but no `pg_search` page at [fdab2cc](https://github.com/supabase/supabase/tree/fdab2cc75197438adbb87af9e975fd51d06afd58/apps/docs/content/guides/database/extensions), so `pg_search` on the free tier is `UNVERIFIED` (probably not available).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/paradedb/paradedb ~/ref/paradedb && cd ~/ref/paradedb && git sparse-checkout set docs/reference/hybrid docs/concepts/hybrid`
- REA/graph: source-only. Maps to: ideas only for a better keyword arm; our Postgres FTS ranker is `ts_rank_cd` with the `simple` config.

---

## F3. Router, decider, abstain gate, model tier

**Ours today.** `src/ctc/retrieval/gate.py` (abstain gate: `FEATURES` L21 = top_rerank, top_dense, top_rrf, rerank_gap, dense_gap, sparse_hits, prompt_tokens; joblib LR; the 2026-10-21 attempt was rejected at CV AUC 0.55, gate is off); `src/ctc/decision/bundle.py` (`decide()`, difficulty and model tier from `models/difficulty.joblib`, trained by `scripts/train_difficulty.py`).
**Question.** What calibrated abstain rules exist that need no strong classifier, and how do routers pick a tier or difficulty threshold against a target rate?

| Repo | Stars / last push / license | Class | What it gives | Verdict |
|---|---|---|---|---|
| [aurelio-labs/semantic-router](https://github.com/aurelio-labs/semantic-router) | 3,978 / 2026-10-22 / MIT (v1.1.1) | copy-safe | Platt/isotonic calibrator + ECE; `None` = no route; `fit()`/`evaluate()` | **reuse** `calibration.py` |
| [lm-sys/RouteLLM](https://github.com/lm-sys/RouteLLM) | 5,638 / **2024-08-10** (stale) / Apache-2.0 | copy-safe | `P(strong wins)` routers + quantile threshold calibration to a target share | pattern (unique, stale) |
| [vllm-project/semantic-router](https://github.com/vllm-project/semantic-router) | 6,270 / 2026-10-26 / Apache-2.0 (v0.4.0) | copy-safe (Go/Rust) | Signals → AND/OR/NOT decisions; "complexity" signal from hard/easy exemplar phrases | pattern |
| ratel-local (F1), redis-vl (F4) | | | Margin gate; per-route distance thresholds | pattern |

**aurelio-labs/semantic-router** @ `1fa1937` · [LICENSE](https://raw.githubusercontent.com/aurelio-labs/semantic-router/1fa1937e390fe57fb85ee3bbb8b3db593a4145db/LICENSE) (MIT)
- Read/lift: [semantic_router/calibration.py#L11-L109](https://github.com/aurelio-labs/semantic-router/blob/1fa1937e390fe57fb85ee3bbb8b3db593a4145db/semantic_router/calibration.py#L11-L109) (`Calibrator.fit(scores, correct, "platt"|"isotonic")`, `_platt` with smoothed targets, `ece`); [routers/base.py#L160-L176](https://github.com/aurelio-labs/semantic-router/blob/1fa1937e390fe57fb85ee3bbb8b3db593a4145db/semantic_router/routers/base.py#L160-L176) (`fit(X, y)` where a `None` label is correct when nothing passes; `evaluate` = end-to-end accuracy with the threshold).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/aurelio-labs/semantic-router ~/ref/semantic-router && cd ~/ref/semantic-router && git sparse-checkout set semantic_router/calibration.py semantic_router/routers/base.py`
- REA/graph: source-only (pure Python wheel on PyPI).
- Maps to: `retrieval/gate.py` and the K2 re-run on MetaTool negatives (CLAUDE.md 2026-10-22: SkillRet and MetaTool decide the gate).

**lm-sys/RouteLLM** @ `0b64fda` · [LICENSE](https://raw.githubusercontent.com/lm-sys/RouteLLM/0b64fdafe049e596a3f5657c219329f24af24198/LICENSE) (Apache-2.0)
- Read: [routellm/routers/routers.py#L32-L50](https://github.com/lm-sys/RouteLLM/blob/0b64fdafe049e596a3f5657c219329f24af24198/routellm/routers/routers.py#L32-L50) (`Router`: score ≥ threshold → strong model); [#L133-L208](https://github.com/lm-sys/RouteLLM/blob/0b64fdafe049e596a3f5657c219329f24af24198/routellm/routers/routers.py#L133-L208) (similarity-weighted ranking router over embeddings); [routellm/calibrate_threshold.py#L50-L58](https://github.com/lm-sys/RouteLLM/blob/0b64fdafe049e596a3f5657c219329f24af24198/routellm/calibrate_threshold.py#L50-L58) (threshold = quantile of scores so that a chosen share goes to the strong model).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/lm-sys/RouteLLM ~/ref/routellm && cd ~/ref/routellm && git sparse-checkout set routellm/routers routellm/calibrate_threshold.py`
- REA/graph: source-only.
- Maps to: `scripts/train_difficulty.py` and `decide()` model tier: choose the tier cut by a target share of "opus" calls instead of a fixed 0.5; same quantile trick can set the abstain threshold for "false-trigger ≤ 10%".

**vllm-project/semantic-router** @ `b85ad12` · [LICENSE](https://raw.githubusercontent.com/vllm-project/semantic-router/b85ad127888c107adc19b2ce3449bd99ce7bab66/LICENSE) (Apache-2.0)
- Read: [config/fragments/signal/complexity/escalation.yaml](https://github.com/vllm-project/semantic-router/blob/b85ad127888c107adc19b2ce3449bd99ce7bab66/config/fragments/signal/complexity/escalation.yaml) (a signal = `threshold` + `hard.candidates` + `easy.candidates` phrases, no training); implementation file names: [complexity_classifier.go](https://github.com/vllm-project/semantic-router/blob/b85ad127888c107adc19b2ce3449bd99ce7bab66/src/semantic-router/pkg/classification/complexity_classifier.go), `complexity_candidate_embeddings.go` (contents `UNVERIFIED`).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/vllm-project/semantic-router ~/ref/vllm-sr && cd ~/ref/vllm-sr && git sparse-checkout set config/fragments/signal/complexity src/semantic-router/pkg/classification`
- REA/graph: source-only (Go; graphify/codebase-memory).
- Maps to: a zero-training baseline for `difficulty` to compare against the LR in `models/difficulty.joblib`.

---

## F4. Cache (L1, Redis L2, semantic cache)

**Ours today.** `src/ctc/storage/cache.py` (`Cache` L52: L1 `OrderedDict` LRU, L2 Redis with 20 ms timeout and a "down for" breaker, `FT.CREATE ctc_sem`, [`semantic_get/put` L169-L200](../../src/ctc/storage/cache.py), stream `enqueue` L207); semantic key parts include the library version and gate/knob hash ([hooks.py#L80](../../src/ctc/server/hooks.py)); hit when cosine ≥ 0.95.
**Question.** Is a single-threshold KNN hit safe, and is there a cheap second-stage check (or per-entry TTL, range query) worth adding?

| Repo | Stars / last push / license | Class | What it gives | Verdict |
|---|---|---|---|---|
| [redis/redis-vl-python](https://github.com/redis/redis-vl-python) | 432 / 2026-10-26 / MIT (v0.28.0) | copy-safe | Official `SemanticCache` + `SemanticRouter` on Redis Query Engine | pattern (confirms our design) |
| [zilliztech/GPTCache](https://github.com/zilliztech/GPTCache) | 8,216 / 2026-09-22 / MIT (last tag 0.1.44, 2024-08-01) | copy-safe | Retrieve → **evaluate** → threshold pipeline with swappable evaluators | pattern (second-stage check) |
| litellm (F11) | | | `DualCache` L1+L2 with a Redis read throttle | pattern |

**redis/redis-vl-python** @ `31d2d0a` · [LICENSE](https://raw.githubusercontent.com/redis/redis-vl-python/31d2d0a1aece9cd486ddc3a6615f43f5738048dc/LICENSE) (MIT)
- Read: [extensions/cache/llm/semantic.py#L53-L80](https://github.com/redis/redis-vl-python/blob/31d2d0a1aece9cd486ddc3a6615f43f5738048dc/redisvl/extensions/cache/llm/semantic.py#L53-L80) and [#L286-L308](https://github.com/redis/redis-vl-python/blob/31d2d0a1aece9cd486ddc3a6615f43f5738048dc/redisvl/extensions/cache/llm/semantic.py#L286-L308) (`distance_threshold` default 0.1, validated 0-2); [#L431-L520](https://github.com/redis/redis-vl-python/blob/31d2d0a1aece9cd486ddc3a6615f43f5738048dc/redisvl/extensions/cache/llm/semantic.py#L431-L520) (`check()` builds a `VectorRangeQuery`, i.e. a range query, not KNN 1); [extensions/router/semantic.py#L413-L420](https://github.com/redis/redis-vl-python/blob/31d2d0a1aece9cd486ddc3a6615f43f5738048dc/redisvl/extensions/router/semantic.py#L413-L420) (per-route `@distance <=` filter).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/redis/redis-vl-python ~/ref/redisvl && cd ~/ref/redisvl && git sparse-checkout set redisvl/extensions/cache/llm redisvl/extensions/router`
- REA/graph: source-only.
- Maps to: `cache.py semantic_get`. Nothing to change; useful if we add per-project thresholds.

**zilliztech/GPTCache** @ `a74ac65` · [LICENSE](https://raw.githubusercontent.com/zilliztech/GPTCache/a74ac654473f7bf4109118e8576945161616e17a/LICENSE) (MIT)
- Read: [adapter/adapter.py#L83-L110](https://github.com/zilliztech/GPTCache/blob/a74ac654473f7bf4109118e8576945161616e17a/gptcache/adapter/adapter.py#L83-L110) (hit path: ANN candidates → `similarity_evaluation` → `rank_threshold = (max-min) * similarity_threshold * cache_factor`); evaluators in [similarity_evaluation/](https://github.com/zilliztech/GPTCache/tree/a74ac654473f7bf4109118e8576945161616e17a/gptcache/similarity_evaluation) (`distance`, `sbert_crossencoder`, `kreciprocal`, `time`, `exact_match`; only `distance.py` opened).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/zilliztech/GPTCache ~/ref/gptcache && cd ~/ref/gptcache && git sparse-checkout set gptcache/adapter/adapter.py gptcache/similarity_evaluation`
- REA/graph: source-only. Maps to: an optional verification step after `semantic_get` (e.g. require the cached bundle's top-1 to still be in the fresh dense top-k). Needs an eval of wrong-hit rate first; not a priority.

---

## F5. Long-term memory for coding agents

**Ours today.** `src/ctc/memory/longterm.py` (write rule ≥ 0.95 NOOP / supersede / ≥ 0.85 UPDATE / ADD; recall = sim × 30-day half-life × (1+ln(1+use_count))), `src/ctc/memory/session.py` (session blend, topic shift), `src/ctc/ai/extract.py` (A3), `src/ctc/ingestion/history.py` (B9), `src/ctc/graph/claudemem.py` (reads claude-mem over `:37707`). Milestone m7 (clone claude-mem into Memories) is in your memory notes.
**Question.** How do mature memory systems handle contradiction, temporal validity and what to inject per turn?

| Repo | Stars / last push / license | Class | What it gives | Verdict |
|---|---|---|---|---|
| [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) | 103,455 / 2026-10-26 / Apache-2.0 (v15.3.0; local worker is 15.2.1) | copy-safe (NOTICE + per-file SPDX) | Observation prompts, context budget, hooks, SQLite schema; the m7 source | **reuse** (m7) |
| [mem0ai/mem0](https://github.com/mem0ai/mem0) | 67,869 / 2026-10-26 / Apache-2.0 | copy-safe | Fact-extraction and ADD/UPDATE/DELETE prompts; additive scoring (semantic + BM25 + entity) | pattern |
| [getzep/graphiti](https://github.com/getzep/graphiti) | 32,250 / 2026-10-26 / Apache-2.0 (v0.31.2) | copy-safe | Bi-temporal edges: contradicted facts are expired, not deleted | pattern |
| [letta-ai/claude-subconscious](https://github.com/letta-ai/claude-subconscious) (+ [letta-ai/letta](https://github.com/letta-ai/letta)) | 2,904 / 2026-09-25 / MIT; letta 25,262 / 2026-10-18 / Apache-2.0 | copy-safe | A memory agent wired to Claude Code hooks; injects only **changed** blocks as a diff | pattern |

**thedotmack/claude-mem** @ `35f2ec0` · [LICENSE](https://raw.githubusercontent.com/thedotmack/claude-mem/35f2ec0eb5b2b1e745564db4ce1ecec58eb331e7/LICENSE) is Apache-2.0 and [NOTICE](https://raw.githubusercontent.com/thedotmack/claude-mem/35f2ec0eb5b2b1e745564db4ce1ecec58eb331e7/NOTICE) credits "Alex Newman"; `ragtime/LICENSE` is also Apache-2.0 text; `dsh/` and `pi/` carry their own license files (not read). Preserve NOTICE when porting.
- Read/lift: [src/core/schemas/memory-item.ts#L1-L26](https://github.com/thedotmack/claude-mem/blob/35f2ec0eb5b2b1e745564db4ce1ecec58eb331e7/src/core/schemas/memory-item.ts#L1-L26) (observation fields: `title, subtitle, narrative, facts, concepts, filesRead, filesModified`, SPDX header); [src/sdk/prompts.ts#L99-L129](https://github.com/thedotmack/claude-mem/blob/35f2ec0eb5b2b1e745564db4ce1ecec58eb331e7/src/sdk/prompts.ts#L99-L129) and `#L373-L430` (observer init and observation prompts); [src/services/context/ContextBudget.ts#L9-L81](https://github.com/thedotmack/claude-mem/blob/35f2ec0eb5b2b1e745564db4ce1ecec58eb331e7/src/services/context/ContextBudget.ts#L9-L81) (10,000-char output limit, `fitContextToBudget`); [plugin/hooks/hooks.json](https://github.com/thedotmack/claude-mem/blob/35f2ec0eb5b2b1e745564db4ce1ecec58eb331e7/plugin/hooks/hooks.json) (events: Setup, SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop, SubagentStop, SessionEnd); schema store [SessionStore.ts](https://github.com/thedotmack/claude-mem/blob/35f2ec0eb5b2b1e745564db4ce1ecec58eb331e7/src/services/sqlite/SessionStore.ts) (216 KB, `UNVERIFIED` contents).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/thedotmack/claude-mem ~/ref/claude-mem && cd ~/ref/claude-mem && git sparse-checkout set src/core/schemas src/sdk src/services/context plugin/hooks NOTICE LICENSE`
- **REA target (exists locally):** `/home/aiface/.claude/plugins/cache/thedotmack/claude-mem/15.2.1/scripts/worker-service.cjs` (4.2 MB bundle, verified present). Also npm [`claude-mem@15.3.0`](https://registry.npmjs.org/claude-mem/-/claude-mem-15.3.0.tgz) (26 MB unpacked) for a 15.2.1 vs 15.3.0 diff.
- Maps to: `graph/claudemem.py` (field list matches R5 in `specs/002-context-coding-graph/research.md`), the m7 Memories port, and G6's push-line budget.

**mem0ai/mem0** @ `26cdefb` · [LICENSE](https://raw.githubusercontent.com/mem0ai/mem0/26cdefb46600c0fa5953c4b5ee5003c125539fc4/LICENSE) (Apache-2.0)
- Read: [mem0/utils/scoring.py#L1-L110](https://github.com/mem0ai/mem0/blob/26cdefb46600c0fa5953c4b5ee5003c125539fc4/mem0/utils/scoring.py#L1-L110) (query-length-adaptive BM25 sigmoid, additive semantic + BM25 + entity boost; only the first ~65 lines opened); [mem0/configs/prompts.py#L176](https://github.com/mem0ai/mem0/blob/26cdefb46600c0fa5953c4b5ee5003c125539fc4/mem0/configs/prompts.py#L176) (`DEFAULT_UPDATE_MEMORY_PROMPT`, ADD/UPDATE/DELETE/NONE) vs `#L468` (`ADDITIVE_EXTRACTION_PROMPT`, the newer additive-only path); [mem0/memory/main.py#L881](https://github.com/mem0ai/mem0/blob/26cdefb46600c0fa5953c4b5ee5003c125539fc4/mem0/memory/main.py#L881) (`_add_to_vector_store`).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/mem0ai/mem0 ~/ref/mem0 && cd ~/ref/mem0 && git sparse-checkout set mem0/utils/scoring.py mem0/configs/prompts.py mem0/memory/main.py`
- REA/graph: source-only (graphify on `main.py`, 170 KB).
- Maps to: `longterm.py recall()` (a keyword/entity term next to vector sim) and `ai/extract.py` prompt.

**getzep/graphiti** @ `2b5db9e` · [LICENSE](https://raw.githubusercontent.com/getzep/graphiti/2b5db9e139b2627c3ba18ff55f9181569b0d8224/LICENSE) (Apache-2.0)
- Read: [graphiti_core/utils/maintenance/edge_operations.py#L715-L785](https://github.com/getzep/graphiti/blob/2b5db9e139b2627c3ba18ff55f9181569b0d8224/graphiti_core/utils/maintenance/edge_operations.py#L715-L785) (`_apply_temporal_invalidation`, `resolve_edge_contradictions`: set `invalid_at`/`expired_at` on the old fact); [graphiti_core/search/search_utils.py#L1786](https://github.com/getzep/graphiti/blob/2b5db9e139b2627c3ba18ff55f9181569b0d8224/graphiti_core/search/search_utils.py#L1786) (`rrf`) and `#L1912` (`maximal_marginal_relevance`).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/getzep/graphiti ~/ref/graphiti && cd ~/ref/graphiti && git sparse-checkout set graphiti_core/utils/maintenance graphiti_core/search`
- REA/graph: source-only.
- Maps to: `longterm.py` supersede: add `valid_from/valid_to` instead of only `deleted_at`, so "what was true in March" stays answerable. MMR is a diversity step for `recall(k=5)`.

**letta-ai/claude-subconscious** @ `4f766fb` · [LICENSE](https://raw.githubusercontent.com/letta-ai/claude-subconscious/4f766fbae3984cf0b10d9345b6eaf0ff1ae57b25/LICENSE) (MIT, "Copyright (c) 2026 Letta, Inc."). **letta-ai/letta main is now only a pointer**: its [README](https://github.com/letta-ai/letta/blob/8816d3a8516893bfdc0fa14bfb1235226012e295/README.md) says current code lives in `letta-ai/letta-code` and the V1 server is on the `archive` branch (`@56ba9c2`, files like `letta/schemas/memory.py`, `letta/services/block_manager.py`, `letta/groups/sleeptime_multi_agent_v4.py` exist; contents `UNVERIFIED`).
- Read: [hooks/hooks.json](https://github.com/letta-ai/claude-subconscious/blob/4f766fbae3984cf0b10d9345b6eaf0ff1ae57b25/hooks/hooks.json) (SessionStart, PreToolUse, UserPromptSubmit, Stop wiring); [scripts/pretool_sync.ts#L200-L350](https://github.com/letta-ai/claude-subconscious/blob/4f766fbae3984cf0b10d9345b6eaf0ff1ae57b25/scripts/pretool_sync.ts#L200-L350) (PreToolUse `hookSpecificOutput.additionalContext`); [scripts/sync_letta_memory.ts#L119-L175](https://github.com/letta-ai/claude-subconscious/blob/4f766fbae3984cf0b10d9345b6eaf0ff1ae57b25/scripts/sync_letta_memory.ts#L119-L175) (inject only blocks that changed since last seen, as a line diff).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/letta-ai/claude-subconscious ~/ref/claude-subconscious && cd ~/ref/claude-subconscious && git sparse-checkout set hooks scripts`
- REA/graph: source-only (TypeScript).
- Maps to: `server/hooks.py` push line and by-file note (G6): "only say what changed" keeps repeated lines out of the context.

---

## F6. MCP server, Claude Code hooks, installer

**Ours today.** `src/ctc/server/mcp.py` (`MCPServer` tools `find_capabilities`, `run_workflow`, `workflow_status`, `graph_*`); `src/ctc/server/hooks.py` (`/v1/hook/prompt|tool|stop|pre`); installer in `src/ctc/cli.py` (`HOOKS` map [L819](../../src/ctc/cli.py), `install` L864, `uninstall` L900; backs up `settings.json`, adds only missing hooks, registers MCP via `claude mcp add`).
**Question.** Is `curl` still the best hook transport, what is the current hook output schema, and how do others install hooks idempotently?

| Repo / doc | Stars / last push / license | Class | What it gives | Verdict |
|---|---|---|---|---|
| [modelcontextprotocol/python-sdk](https://github.com/modelcontextprotocol/python-sdk) | 24,677 / 2026-10-25 / MIT (v2.3.0) | copy-safe | `MCPServer`, `streamable_http_app(stateless_http=)`, bearer auth, stateless example | reuse (our dependency) |
| Claude Code docs: [hooks.md](https://code.claude.com/docs/en/hooks.md), [plugins-reference.md](https://code.claude.com/docs/en/plugins-reference.md), [settings.md](https://code.claude.com/docs/en/settings.md) | official | docs | The authoritative hook schema | primary source |
| [anthropics/claude-code](https://github.com/anthropics/claude-code) | 153,486 / 2026-10-26 / **none: "© Anthropic PBC. All rights reserved"** ([LICENSE.md](https://raw.githubusercontent.com/anthropics/claude-code/08c6a4f5121ae140d3c1b5c96e3e5ae53587b54b/LICENSE.md)) | **no-go** for copying | Changelog, `plugins/*` and `examples/hooks/*` samples | docs only |
| [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | 44,770 / 2026-10-27 / Apache-2.0 | copy-safe | Plugin manifests (`.claude-plugin/plugin.json`, `.mcp.json`) in [external_plugins/](https://github.com/anthropics/claude-plugins-official/tree/41f619d61b999adec1a1c8deb97d1a5b6ac35bb6/external_plugins) | pattern (contents `UNVERIFIED`) |
| ratel-local (F1) | | MIT, references-only | Idempotent hook installer | pattern |

**Claude Code hooks (official)** fetched 2026-10-27: [`type: "http"` handlers](https://code.claude.com/docs/en/hooks.md) POST the event JSON and read the same JSON output as command hooks; a 2xx body that is plain text, non-2xx and connection failure are all **non-blocking errors** (`#http-response-handling`); `additionalContext`, `systemMessage` and stdout are capped at 10,000 characters; `disableAllHooks` is a documented setting (hooks.md L712; line numbers refer to the 2026-10-27 fetch, the docs are not versioned); PreToolUse accepts `hookSpecificOutput` (allow/deny/ask/defer, `updatedInput`, `additionalContext`). `allowedHttpHookUrls` and `httpHookAllowedEnvVars` can restrict HTTP hooks in managed settings (hooks.md L270-L271), so a managed machine could block our URL.
- REA target: the installed binary `/home/aiface/.local/share/claude/versions/2.1.306` (our pinned CLI; R2 in `specs/002-context-coding-graph/research.md` already used it). Ask it for the strings `additionalContext`, `allowedHttpHookUrls` to confirm behaviour matches the docs for 2.1.306 (latest on npm is [2.1.311](https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.311.tgz), a 189 KB wrapper).
- Maps to: `hooks.py` (add a JSON-returning variant), `cli.py HOOKS` (switch the command string to an `http` handler), shared-mode `Authorization` via `headers`.

**modelcontextprotocol/python-sdk** @ `a525a3d` · [LICENSE](https://raw.githubusercontent.com/modelcontextprotocol/python-sdk/a525a3d9bece967d91534b746a6c842931b7b4ec/LICENSE) (MIT)
- Read: [mcpserver/server.py#L157](https://github.com/modelcontextprotocol/python-sdk/blob/a525a3d9bece967d91534b746a6c842931b7b4ec/src/mcp/server/mcpserver/server.py#L157) (`class MCPServer`) and [#L1288-L1306](https://github.com/modelcontextprotocol/python-sdk/blob/a525a3d9bece967d91534b746a6c842931b7b4ec/src/mcp/server/mcpserver/server.py#L1288-L1306) (`streamable_http_app(..., stateless_http)`); [auth/middleware/bearer_auth.py#L44-L82](https://github.com/modelcontextprotocol/python-sdk/blob/a525a3d9bece967d91534b746a6c842931b7b4ec/src/mcp/server/auth/middleware/bearer_auth.py#L44-L82) (`BearerAuthBackend`); [server/caching.py#L1-L18](https://github.com/modelcontextprotocol/python-sdk/blob/a525a3d9bece967d91534b746a6c842931b7b4ec/src/mcp/server/caching.py#L1-L18) (SEP-2549 `ttlMs`/`cacheScope` hints; client support `UNVERIFIED`); example [simple-streamablehttp-stateless](https://github.com/modelcontextprotocol/python-sdk/tree/a525a3d9bece967d91534b746a6c842931b7b4ec/examples/servers/simple-streamablehttp-stateless).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/modelcontextprotocol/python-sdk ~/ref/mcp-sdk && cd ~/ref/mcp-sdk && git sparse-checkout set src/mcp/server examples/servers/simple-streamablehttp-stateless`
- REA/graph: source-only.
- Maps to: `server/mcp.py` and shared mode (N stateless workers need `stateless_http=True`; check that `find_capabilities(ref=...)` does not rely on session state, it reads `bundle:{ref}` from Redis so it should be fine).

**ratel-ai/ratel-local** @ `948cdbd` · [LICENSE.md](https://github.com/ratel-ai/ratel-local/blob/948cdbd33cdcb770183ededc310202e2aaa145bd/LICENSE.md) (MIT), references-only
- Read: [install-hook.ts#L17-L19](https://github.com/ratel-ai/ratel-local/blob/948cdbd33cdcb770183ededc310202e2aaa145bd/apps/ratel-local/src/cli/skills/install-hook.ts#L17-L19) (marker substring for idempotent add/remove) and [#L111-L190](https://github.com/ratel-ai/ratel-local/blob/948cdbd33cdcb770183ededc310202e2aaa145bd/apps/ratel-local/src/cli/skills/install-hook.ts#L111-L190) (prepared change, `documentRevision` check, `MutationConflictError` if `settings.json` changed under you, backup). Compare [plugin/hooks/hooks.json](https://github.com/ratel-ai/ratel-local/blob/948cdbd33cdcb770183ededc310202e2aaa145bd/apps/ratel-local/plugin/hooks/hooks.json) (PreToolUse/PostToolUse `matcher: "*"` logging).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/ratel-ai/ratel-local ~/ref/ratel-local && cd ~/ref/ratel-local && git sparse-checkout set apps/ratel-local/src/cli/skills apps/ratel-local/plugin/hooks`
- REA: npm `@ratel-ai/ratel-local@0.9.0` (see F1). Maps to: `cli.py install` (add a revision check before writing `settings.json`; Claude Code can write it concurrently).

---

## F7. Workflow runner (m5)

**Ours today.** `src/ctc/runner/graph.py` (pure walker: ready tokens, back-edges, quiescence, loop caps), `engine.py` (asyncio, worktree per run, step rows, resume via `--resume`), `proc.py` (`claude -p` child, quota regex, `rate_limit_event` at [L172](../../src/ctc/runner/proc.py)), `schedule.py` (croniter), `export.py` (native `.js` export), `src/ctc/server/runs.py`. Walker rules are in PLAN "Walker rules".
**Question.** How do production engines define retry/restart-from-node, pause/resume and loop semantics, and what do other Claude-in-worktree runners pass to `claude`?

| Repo | Stars / last push / license | Class | What it gives | Verdict |
|---|---|---|---|---|
| [n8n-io/n8n](https://github.com/n8n-io/n8n) | 208,689 / 2026-10-27 / Sustainable Use License | **pattern-only** (`.ee.` files and `.ee` dirs are proprietary) | Reference semantics for IF/merge/loops, partial re-execution, wait/resume, recovery (our n8n-parity target) | pattern |
| [kestra-io/kestra](https://github.com/kestra-io/kestra) | 30,022 / 2026-10-26 (branch `develop`) / Apache-2.0 (v2.0.7) | copy-safe (Java) | `restart`, `replay` from a task, `markAs`, `resume` on executions | pattern |
| [activepieces/activepieces](https://github.com/activepieces/activepieces) | 25,238 / 2026-10-26 / MIT outside `packages/ee/` and `packages/server/api/src/app/ee` | copy-safe outside `ee` | Small TypeScript step executors (sequence, loop, router) and waitpoint resume | pattern/reuse ideas |
| [windmill-labs/windmill](https://github.com/windmill-labs/windmill) | 18,280 / 2026-10-27 / AGPL-3.0 backend + frontend; Apache-2.0 clients and OpenFlow spec; proprietary `enterprise` snippets | **pattern-only** | Rust flow state machine, schedules | skim only |
| [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) | 28,472 / 2026-10-26 / Apache-2.0 | copy-safe (Rust) | Claude CLI flags in a worktree manager; `--resume`, `--resume-session-at` | pattern |
| [pallets-eco/croniter](https://github.com/pallets-eco/croniter) | 566 / 2026-10-23 / MIT | copy-safe | Our cron library | confirmed: tag **6.2.4** exists (2026-07-10) |
| claude-squad (AGPL-3.0, 8,675★), crystal (MIT, renamed Nimbalyst, last push 2026-02-26) | | no-go / skip | | not opened |

**n8n-io/n8n** @ `e145ac4` · [LICENSE.md](https://github.com/n8n-io/n8n/blob/e145ac4b234ae78105ec12c89562cc0849df2aeb/LICENSE.md) (SUL: internal business or non-commercial use only; no `.ee.` files)
- Read: [workflow-execute.ts](https://github.com/n8n-io/n8n/blob/e145ac4b234ae78105ec12c89562cc0849df2aeb/packages/core/src/execution-engine/workflow-execute.ts) (106 KB): `runPartialWorkflow2` [L246](https://github.com/n8n-io/n8n/blob/e145ac4b234ae78105ec12c89562cc0849df2aeb/packages/core/src/execution-engine/workflow-execute.ts#L246), `addNodeToBeExecuted` [L469](https://github.com/n8n-io/n8n/blob/e145ac4b234ae78105ec12c89562cc0849df2aeb/packages/core/src/execution-engine/workflow-execute.ts#L469), `checkReadyForExecution` [L889](https://github.com/n8n-io/n8n/blob/e145ac4b234ae78105ec12c89562cc0849df2aeb/packages/core/src/execution-engine/workflow-execute.ts#L889), `runNode` [L1377](https://github.com/n8n-io/n8n/blob/e145ac4b234ae78105ec12c89562cc0849df2aeb/packages/core/src/execution-engine/workflow-execute.ts#L1377), `processRunExecutionData` [L2286](https://github.com/n8n-io/n8n/blob/e145ac4b234ae78105ec12c89562cc0849df2aeb/packages/core/src/execution-engine/workflow-execute.ts#L2286); [partial-execution-utils/find-start-nodes.ts#L159](https://github.com/n8n-io/n8n/blob/e145ac4b234ae78105ec12c89562cc0849df2aeb/packages/core/src/execution-engine/partial-execution-utils/find-start-nodes.ts#L159) and `handle-cycles.ts#L15` (retry/partial run from a node, loop detection `isALoop` L137); [packages/cli/src/wait-tracker.ts](https://github.com/n8n-io/n8n/blob/e145ac4b234ae78105ec12c89562cc0849df2aeb/packages/cli/src/wait-tracker.ts) and [execution-recovery.service.ts](https://github.com/n8n-io/n8n/blob/e145ac4b234ae78105ec12c89562cc0849df2aeb/packages/cli/src/executions/execution-recovery.service.ts) (contents `UNVERIFIED`); [scheduled-task-manager.ts](https://github.com/n8n-io/n8n/blob/e145ac4b234ae78105ec12c89562cc0849df2aeb/packages/core/src/execution-engine/scheduled-task-manager.ts) (`cron` package).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/n8n-io/n8n ~/ref/n8n && cd ~/ref/n8n && git sparse-checkout set --no-cone packages/core/src/execution-engine/workflow-execute.ts packages/core/src/execution-engine/partial-execution-utils packages/core/src/execution-engine/scheduled-task-manager.ts packages/cli/src/wait-tracker.ts`
- **REA target:** npm [`n8n-core@2.16.1`](https://registry.npmjs.org/n8n-core/-/n8n-core-2.16.1.tgz) (1.5 MB unpacked; compiled `dist/execution-engine/workflow-execute.js`). `n8n-core` is versioned separately from the `n8n@2.44.7` release, so its mapping to the pinned source SHA is `UNVERIFIED`. Study only; nothing pasted (SUL).
- Maps to: `runner/graph.py` rules 2-5, and "retry from a node" semantics (n8n-parity tickets 09/11).

**kestra-io/kestra** @ `6f8d021` · [LICENSE](https://raw.githubusercontent.com/kestra-io/kestra/6f8d0216e32b910c8cc4f838cf1198cd0ba23b86/LICENSE) (Apache-2.0; no `ee/` path found in the tree at this SHA, enterprise code location `UNVERIFIED`)
- Read: [core/.../services/ExecutionService.java](https://github.com/kestra-io/kestra/blob/6f8d0216e32b910c8cc4f838cf1198cd0ba23b86/core/src/main/java/io/kestra/core/services/ExecutionService.java): `restart` [L365](https://github.com/kestra-io/kestra/blob/6f8d0216e32b910c8cc4f838cf1198cd0ba23b86/core/src/main/java/io/kestra/core/services/ExecutionService.java#L365), `replay` (from a `taskRunId`, optional breakpoint) [L529](https://github.com/kestra-io/kestra/blob/6f8d0216e32b910c8cc4f838cf1198cd0ba23b86/core/src/main/java/io/kestra/core/services/ExecutionService.java#L529), `markAs` [L732](https://github.com/kestra-io/kestra/blob/6f8d0216e32b910c8cc4f838cf1198cd0ba23b86/core/src/main/java/io/kestra/core/services/ExecutionService.java#L732), `resume` [L940](https://github.com/kestra-io/kestra/blob/6f8d0216e32b910c8cc4f838cf1198cd0ba23b86/core/src/main/java/io/kestra/core/services/ExecutionService.java#L940); [runners/FlowableUtils.java#L36-L262](https://github.com/kestra-io/kestra/blob/6f8d0216e32b910c8cc4f838cf1198cd0ba23b86/core/src/main/java/io/kestra/core/runners/FlowableUtils.java#L36-L262) (`resolveSequentialNexts`, `resolveParallelNexts`, `resolveState`).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/kestra-io/kestra ~/ref/kestra && cd ~/ref/kestra && git sparse-checkout set core/src/main/java/io/kestra/core/services core/src/main/java/io/kestra/core/runners`
- **REA target (optional):** release asset `kestra-2.0.7` (131 MB JAR, [release](https://github.com/kestra-io/kestra/releases/tag/v2.0.7)) for `inspect_managed_members` on `ExecutionService`; the Java source is already readable, so only use it to confirm behaviour.
- Maps to: `engine.py` replay-from-node and manual `markAs`-style recovery (our model forbids re-running side effects, so Kestra's `restart` is the contrast).

**activepieces/activepieces** @ `a3b5f0e` · [LICENSE](https://raw.githubusercontent.com/activepieces/activepieces/a3b5f0e44bd95a15a9e2e70d8d03156c34b5aad5/LICENSE) (MIT; `packages/ee/` and `packages/server/api/src/app/ee` excluded; 404 files under `/ee/` in the tree)
- Read: [engine/.../handler/flow-executor.ts#L32-L135](https://github.com/activepieces/activepieces/blob/a3b5f0e44bd95a15a9e2e70d8d03156c34b5aad5/packages/server/engine/src/lib/handler/flow-executor.ts#L32-L135) (executor registry, `execute` loop, break when verdict ≠ RUNNING, continue-on-failure branch); `loop-executor.ts` (3.8 KB, same folder, `UNVERIFIED`); [api/.../waitpoints/resume-service.ts#L14-L82](https://github.com/activepieces/activepieces/blob/a3b5f0e44bd95a15a9e2e70d8d03156c34b5aad5/packages/server/api/src/app/waitpoints/resume-service.ts#L14-L82) (`resumeFromWaitpoint`, `waitpointWasConsumed` = idempotent resume).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/activepieces/activepieces ~/ref/activepieces && cd ~/ref/activepieces && git sparse-checkout set packages/server/engine/src/lib/handler packages/server/api/src/app/waitpoints`
- REA/graph: source-only. Maps to: `engine.py` approval wait/resume (consume-once guard).

**windmill-labs/windmill** @ `f2f38dd` · [LICENSE#L1-L20](https://github.com/windmill-labs/windmill/blob/f2f38ddd4fbbaa32583866b9da5e23824a0899e9/LICENSE#L1-L20): backend and frontend AGPLv3 except enterprise snippets (proprietary); `python-client/`, `deno-client/` etc. and the OpenAPI/OpenFlow spec Apache-2.0. [worker_flow.rs](https://github.com/windmill-labs/windmill/blob/f2f38ddd4fbbaa32583866b9da5e23824a0899e9/backend/windmill-worker/src/worker_flow.rs) is 275 KB; skim for state-machine naming only. Clone: skip. REA: skip.

**BloopAI/vibe-kanban** @ `a019ceb` · [LICENSE](https://raw.githubusercontent.com/BloopAI/vibe-kanban/a019cebf0693f787ef0f8dc2bb8d37edd35527ac/LICENSE) (Apache-2.0)
- Read: [crates/executors/src/executors/claude.rs#L160-L195](https://github.com/BloopAI/vibe-kanban/blob/a019cebf0693f787ef0f8dc2bb8d37edd35527ac/crates/executors/src/executors/claude.rs#L160-L195) (`--permission-mode`, `--dangerously-skip-permissions`, `--verbose --output-format=stream-json --input-format=stream-json`) and [#L364-L376](https://github.com/BloopAI/vibe-kanban/blob/a019cebf0693f787ef0f8dc2bb8d37edd35527ac/crates/executors/src/executors/claude.rs#L364-L376) (`--resume <id>`, `--resume-session-at` which truncates history); [crates/worktree-manager/src/worktree_manager.rs](https://github.com/BloopAI/vibe-kanban/blob/a019cebf0693f787ef0f8dc2bb8d37edd35527ac/crates/worktree-manager/src/worktree_manager.rs) (22 KB, `UNVERIFIED`).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/BloopAI/vibe-kanban ~/ref/vibe-kanban && cd ~/ref/vibe-kanban && git sparse-checkout set --no-cone crates/executors/src/executors/claude.rs crates/executors/src/executors/claude crates/worktree-manager`
- REA/graph: source-only. Maps to: `runner/proc.py agent_argv` (PLAN "still unverified": `--session-id` + `--fork-session`; they use `--resume-session-at` instead), and `engine.py` worktree create/cleanup.

---

## F8. Context + coding graph (m6)

**Ours today.** `src/ctc/graph/`: `importer.py` (graphify `graph.json` code+rationale nodes), `parse.py` (speckit/tickets/PLAN/decisions → context nodes), `link.py` (EXTRACTED/INFERRED/CONFIRMED links), `extract.py` (`claude -p --model haiku` extractor), `claudemem.py`, `push.py` (prompt line, by-file note), `query.py`, `export.py`, `build.py`, `db.py`, `core.py`. Eval: `evaluation/graph_eval.py` (test Recall@3 0.750 vs 0.8 target).
**Question.** How do others rank code nodes for a prompt, compute blast radius, and parse spec-kit artifacts?

| Repo | Stars / last push / license | Class | What it gives | Verdict |
|---|---|---|---|---|
| [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify) (PyPI `graphifyy`) | 136,221 / 2026-10-26 (branch `v8`) / Apache-2.0 (+ MIT portions) | copy-safe | The tool whose `graph.json` we import; `affected.py` blast-radius relations | reuse (already an external tool) |
| [Aider-AI/aider](https://github.com/Aider-AI/aider) | 49,768 / 2026-05-22 / Apache-2.0 (v0.86.0, 2025-08) | copy-safe | Repo map: tree-sitter tags + personalized PageRank + token budget | pattern |
| [github/spec-kit](https://github.com/github/spec-kit) | 143,044 / 2026-10-26 / MIT (v1.2.3) | copy-safe | Templates that define the grammar our parser reads; extension hooks | reuse (reference) |
| [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) | 47,576 / 2026-10-26 / MIT (v0.12.1, C) | copy-safe | Peer code-graph MCP with Cypher-like `query_graph`, `detect_changes`; installed locally | pattern |
| [microsoft/graphrag](https://github.com/microsoft/graphrag) | 36,456 / 2026-10-26 / MIT (v3.3.0) | copy-safe | Leiden communities and report summarization | skip for now (we have no community summaries) |
| [tree-sitter/tree-sitter](https://github.com/tree-sitter/tree-sitter) | 27,289 / 2026-10-26 / MIT (v0.27.1) | copy-safe | The parser behind graphify and aider | skip (indirect; not opened) |

**Graphify-Labs/graphify** @ `dac0634` · [LICENSE](https://raw.githubusercontent.com/Graphify-Labs/graphify/dac063456bc1f5d92354ec3936fd9dd1513a83f3/LICENSE) (Apache-2.0) + [NOTICE](https://raw.githubusercontent.com/Graphify-Labs/graphify/dac063456bc1f5d92354ec3936fd9dd1513a83f3/NOTICE) (MIT portions kept in `LICENSE-MIT`). Real repo: `Graphify-Labs/graphify` (PyPI project `graphifyy`, found through the installed package's `Project-URL`). Local install is `graphifyy 0.9.93`; latest release is v0.9.96.
- Read: [graphify/affected.py#L12-L30](https://github.com/Graphify-Labs/graphify/blob/dac063456bc1f5d92354ec3936fd9dd1513a83f3/graphify/affected.py#L12-L30) (`DEFAULT_AFFECTED_RELATIONS`: calls, indirect_call, references, imports, imports_from, dynamic_import, re_exports, inherits, extends, implements, uses, ...; compare with our `graph_affected`); [graphify/export.py#L287](https://github.com/Graphify-Labs/graphify/blob/dac063456bc1f5d92354ec3936fd9dd1513a83f3/graphify/export.py#L287) and [#L483](https://github.com/Graphify-Labs/graphify/blob/dac063456bc1f5d92354ec3936fd9dd1513a83f3/graphify/export.py#L483) (`to_json(..., built_at_commit)` is our freshness key).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/Graphify-Labs/graphify ~/ref/graphify && cd ~/ref/graphify && git sparse-checkout set graphify/affected.py graphify/export.py graphify/paths.py`
- REA/graph: PyPI wheel [`graphifyy-0.9.96`](https://pypi.org/pypi/graphifyy/json) is pure Python: source-only.
- Maps to: `graph/importer.py` (relation allow-list), `graph/query.py` affected traversal.

**Aider-AI/aider** @ `5dc9490` · [LICENSE.txt](https://raw.githubusercontent.com/Aider-AI/aider/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/LICENSE.txt) (Apache-2.0)
- Read: [aider/repomap.py#L365-L424](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repomap.py#L365-L424) (`get_ranked_tags`: personalized PageRank, personalization from files mentioned in chat), [#L103-L145](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repomap.py#L103-L145) (`get_repo_map` token budgeting); per-language tag queries in [aider/queries/tree-sitter-language-pack/](https://github.com/Aider-AI/aider/tree/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/queries/tree-sitter-language-pack) (`python-tags.scm` exists).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/Aider-AI/aider ~/ref/aider && cd ~/ref/aider && git sparse-checkout set aider/repomap.py aider/queries/tree-sitter-language-pack`
- REA/graph: source-only.
- Maps to: `graph/push.py` ranking: weight candidate code nodes by PageRank over graphify's call/import edges personalised on files in the prompt, before the embedding links.

**github/spec-kit** @ `ee94598` · [LICENSE](https://raw.githubusercontent.com/github/spec-kit/ee94598c3c87ae231027b22fb2be2b5a13e8820f/LICENSE) (MIT)
- Read: [templates/tasks-template.md#L18](https://github.com/github/spec-kit/blob/ee94598c3c87ae231027b22fb2be2b5a13e8820f/templates/tasks-template.md#L18) and [#L48-L67](https://github.com/github/spec-kit/blob/ee94598c3c87ae231027b22fb2be2b5a13e8820f/templates/tasks-template.md#L48-L67) (`T001`, `[P]`, `[US#]`, phases: the grammar `graph/parse.py` must read); extension hook engine [src/specify_cli/extensions/__init__.py](https://github.com/github/spec-kit/blob/ee94598c3c87ae231027b22fb2be2b5a13e8820f/src/specify_cli/extensions/__init__.py) (275 KB, `UNVERIFIED`; our local `specify-cli` is 1.2.3, same as the latest release).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/github/spec-kit ~/ref/spec-kit && cd ~/ref/spec-kit && git sparse-checkout set templates`
- REA/graph: source-only. Maps to: `graph/parse.py` and the G4 speckit `extensions.yml` hooks.

**DeusData/codebase-memory-mcp** @ `8530c8c` · [LICENSE](https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/8530c8cd1c1ac8e1e3d2962bc213a8c9025fea0a/LICENSE) (MIT)
- Read: layout only: `src/pipeline/` (index passes), `src/cypher/cypher.c`, `src/store/store.c`, `src/mcp/mcp.c` (contents `UNVERIFIED`).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/DeusData/codebase-memory-mcp ~/ref/cbm && cd ~/ref/cbm && git sparse-checkout set src/pipeline src/cypher`
- **REA target (exists locally):** `/home/aiface/.local/bin/codebase-memory-mcp` (ELF, reports `0.9.0`); latest release is [v0.12.1](https://github.com/DeusData/codebase-memory-mcp/releases/tag/v0.12.1) with `*.tar.gz` assets per platform. Ask REA for the tool list and the graph schema the binary builds.
- Maps to: a second opinion for `graph/query.py` (`detect_changes`-style impact).

**microsoft/graphrag** @ `c600ff8` · [LICENSE](https://raw.githubusercontent.com/microsoft/graphrag/c600ff80b77b9b62c47d539a3ac9569e95d8949b/LICENSE) (MIT). Only `index/operations/summarize_communities/build_mixed_context.py` ([listed](https://github.com/microsoft/graphrag/tree/c600ff80b77b9b62c47d539a3ac9569e95d8949b/packages/graphrag/graphrag/index/operations/summarize_communities), contents `UNVERIFIED`) maps to our "fit context in a token budget" problem; skip until communities are wanted. **tree-sitter** is reached through graphify; not opened.

---

## F9. Benchmark and eval

**Ours today.** `evaluation/loaders.py` (SkillRet pinned `SKILLRET_REV = 6583d7d...` = current HF head, MetaTool), `retrieval_eval.py` (ranx `evaluate`), `latency_eval.py`, `memory_eval.py`, `graph_eval.py`, `label.py`. SRA-Bench and ToolRet are not wired.
**Question.** Are our metrics comparable to the dataset authors', is there a significance test, and what else should be loaded?

| Repo / dataset | Stars / last push / license | Class | What it gives | Verdict |
|---|---|---|---|---|
| [ThakiCloud/SKILLRET](https://github.com/ThakiCloud/SKILLRET) | 28 / 2026-09-25 / no LICENSE file (README badge says Apache-2.0); [dataset](https://huggingface.co/datasets/ThakiCloud/SKILLRET) and [models](https://huggingface.co/ThakiCloud/SKILLRET-Embedding-0.6B) apache-2.0 | data copy-safe; code **pattern-only** until the owner confirms | Eval harness, exact text/prompt formats, reranker training code | **reuse the ideas** |
| [AmenRa/ranx](https://github.com/AmenRa/ranx) | 701 / 2025-08-07 / MIT | copy-safe | Metrics, `compare` (stat tests), fusion, `optimize_fusion` | reuse (dependency) |
| [oneal2000/SR-Agents](https://github.com/oneal2000/SR-Agents) | 111 / 2026-07-02 / MIT | copy-safe | SRA-Bench data (`data/bench/`) and `src/sragents/retrieve/` baselines | reuse for the "after M1" benchmark |
| [mangopy/tool-retrieval-benchmark](https://github.com/mangopy/tool-retrieval-benchmark) (ToolRet) | 220 / 2025-12-22 / Apache-2.0 (HF datasets: license field empty) | copy-safe code | `toolret/eval.py` with `pytrec_eval` incl. completeness | optional |
| [HowieHwong/MetaTool](https://github.com/HowieHwong/MetaTool) | 121 / **2024-03-21** (stale) / MIT | copy-safe | Tool-usage-awareness and selection tasks (our abstain negatives) | already used |
| [beir-cellar/beir](https://github.com/beir-cellar/beir) | 2,317 / 2025-10-16 / Apache-2.0 (v2.2.0) | copy-safe | `hole@k` (unjudged-in-top-k) metric | pattern, one function |
| [embeddings-benchmark/mteb](https://github.com/embeddings-benchmark/mteb) | 3,477 / 2026-10-26 / Apache-2.0 | copy-safe | General embedding benchmark | skip (not opened; adds nothing over SkillRet's harness) |

**ThakiCloud/SKILLRET** @ `0cc508e`: no LICENSE file in the [tree](https://github.com/ThakiCloud/SKILLRET/tree/0cc508e6bfcfff1fe6352d90ff5957ba38a64bba) (GitHub API reports none); [README#L5](https://github.com/ThakiCloud/SKILLRET/blob/0cc508e6bfcfff1fe6352d90ff5957ba38a64bba/README.md#L5) shows an Apache-2.0 badge pointing at the missing file. Treat the code as pattern-only; the dataset and both models are apache-2.0 on the Hub.
- Read: [skillret/eval.py#L84-L89](https://github.com/ThakiCloud/SKILLRET/blob/0cc508e6bfcfff1fe6352d90ff5957ba38a64bba/skillret/eval.py#L84-L89) (document = `name | description | skill_md`, full, no truncation); [#L315-L322](https://github.com/ThakiCloud/SKILLRET/blob/0cc508e6bfcfff1fe6352d90ff5957ba38a64bba/skillret/eval.py#L315-L322) (query/doc prefixes per model); [skillret/config.py#L17](https://github.com/ThakiCloud/SKILLRET/blob/0cc508e6bfcfff1fe6352d90ff5957ba38a64bba/skillret/config.py#L17) (`Instruct: Given a skill search query, retrieve relevant skills that match the query\nQuery: `, vs ours in `embedder.py#L12-L15` which asks for "coding task ... capabilities"); [#L750-L800](https://github.com/ThakiCloud/SKILLRET/blob/0cc508e6bfcfff1fe6352d90ff5957ba38a64bba/skillret/eval.py#L750-L800) (bge-reranker evaluated through `FlagReranker`, so the paper's bge numbers are raw FlagEmbedding scores, not TEI's); [#L890-L960](https://github.com/ThakiCloud/SKILLRET/blob/0cc508e6bfcfff1fe6352d90ff5957ba38a64bba/skillret/eval.py#L890-L960) (Qwen3 reranker: system prompt, `yes`/`no` token logits); [train/reranker-ft/train.py](https://github.com/ThakiCloud/SKILLRET/blob/0cc508e6bfcfff1fe6352d90ff5957ba38a64bba/train/reranker-ft/train.py) (fine-tune Qwen3-Reranker with BCE on hard negatives; the A4/K2 recipe if you ever fine-tune). Results table: [README#L187-L215](https://github.com/ThakiCloud/SKILLRET/blob/0cc508e6bfcfff1fe6352d90ff5957ba38a64bba/README.md#L187-L215) (BM25 NDCG@10 51.69, Qwen3-Embedding-0.6B 61.94, SKILLRET-Embedding-0.6B 81.12; test split = 6,006 skills / 4,392 queries / 7,187 labels, [README#L49-L54](https://github.com/ThakiCloud/SKILLRET/blob/0cc508e6bfcfff1fe6352d90ff5957ba38a64bba/README.md#L49-L54)).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/ThakiCloud/SKILLRET ~/ref/skillret && cd ~/ref/skillret && git sparse-checkout set skillret train/reranker-ft scripts`
- REA/graph: source-only; the reranker weights are on the Hub (`Qwen3ForCausalLM`).
- Maps to: `evaluation/loaders.py` (text), `evaluation/retrieval_eval.py` (add `skillret_prompt` mode), `reranking/` (new yes/no scorer if row 6 passes).

**AmenRa/ranx** @ `7363db0` · [LICENSE](https://raw.githubusercontent.com/AmenRa/ranx/7363db0c35e92e90d6fa6fe73907b760678f765e/LICENSE) (MIT)
- Read: [ranx/meta/compare.py#L11-L35](https://github.com/AmenRa/ranx/blob/7363db0c35e92e90d6fa6fe73907b760678f765e/ranx/meta/compare.py#L11-L35) (`stat_test="student"`, `max_p=0.01`, permutations); [ranx/meta/optimize_fusion.py#L8-L77](https://github.com/AmenRa/ranx/blob/7363db0c35e92e90d6fa6fe73907b760678f765e/ranx/meta/optimize_fusion.py#L8-L77); fusion methods in [ranx/fusion/](https://github.com/AmenRa/ranx/tree/7363db0c35e92e90d6fa6fe73907b760678f765e/ranx/fusion) (`rrf`, `wsum`, `mixed`, `isr`, `bayesfuse` ...).
- Clone: not needed (installed). REA/graph: source-only. Maps to: `evaluation/retrieval_eval.py#L22` (already imports `Qrels, Run, evaluate`).

**oneal2000/SR-Agents** @ `277fd8d` · [LICENSE](https://raw.githubusercontent.com/oneal2000/SR-Agents/277fd8d2bbd7d3b81a5cf4ffa6e87e18c7906e4f/LICENSE) (MIT, per API)
- Read: `src/sragents/retrieve/` [tree](https://github.com/oneal2000/SR-Agents/tree/277fd8d2bbd7d3b81a5cf4ffa6e87e18c7906e4f/src/sragents/retrieve): `dense.py`, `hybrid.py` (round-robin merge of two retrieval files, [L1-L60](https://github.com/oneal2000/SR-Agents/blob/277fd8d2bbd7d3b81a5cf4ffa6e87e18c7906e4f/src/sragents/retrieve/hybrid.py#L1-L60)), `llm_rerank.py` (listwise LLM rerank prompt), `metrics.py`; data in [data/bench/](https://github.com/oneal2000/SR-Agents/tree/277fd8d2bbd7d3b81a5cf4ffa6e87e18c7906e4f/data/bench) (corpus zip 71 MB).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/oneal2000/SR-Agents ~/ref/sr-agents && cd ~/ref/sr-agents && git sparse-checkout set src/sragents/retrieve` (add `data/bench/instances` only if you want the data).
- REA/graph: source-only. Maps to: a second skill benchmark for the "after M1" step in PLAN Data.

**beir-cellar/beir** @ `ef83d29` · [`custom_metrics.py#L65`](https://github.com/beir-cellar/beir/blob/ef83d29307061c65d04b035b4f4e7c18bd8374af/beir/retrieval/custom_metrics.py#L65) `hole` (share of top-k with no judgement) and [`evaluation.py#L137-L138`](https://github.com/beir-cellar/beir/blob/ef83d29307061c65d04b035b4f4e7c18bd8374af/beir/retrieval/evaluation.py#L137-L138). Use it to quantify how noisy the own-transcript labels are before H1. Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/beir-cellar/beir ~/ref/beir && cd ~/ref/beir && git sparse-checkout set beir/retrieval`. **ToolRet** `toolret/eval.py` ([L75-L93](https://github.com/mangopy/tool-retrieval-benchmark/blob/c4181d914a227134705ecb6bab13fbd92ccd2938/toolret/eval.py#L75-L93): `pytrec_eval` NDCG, MAP, recall, precision, completeness); **MetaTool** [README](https://github.com/HowieHwong/MetaTool/blob/35e81bb7576826e980c80fed8f8c0a2b4a1e6fbb/README.md) lists subtasks `similar` and `reliable` (the reliability subset we use for abstain).

---

## F10. Dashboard and traces

**Ours today.** `dashboard/src/` (React + Vite + Recharts + `@xyflow/react`): `Overview.tsx` (KPIs, timeline, heatmap), `Library.tsx`, `Sessions.tsx`, `Memories.tsx`, `Jobs.tsx`, `Keys.tsx`, `Workflows.tsx` (canvas), `Runs.tsx` (run overlay), `types.ts` (generated), `api.ts`.
**Question.** What do the flagship canvas and trace UIs do that our decision drawer and run view do not?

| Repo | Stars / last push / license | Class | What it gives | Verdict |
|---|---|---|---|---|
| [xyflow/xyflow](https://github.com/xyflow/xyflow) | 38,791 / 2026-10-26 / MIT | copy-safe | React Flow itself and its examples | reuse (dependency) |
| [langfuse/langfuse](https://github.com/langfuse/langfuse) | 36,545 / 2026-10-27 / MIT outside `ee/`, `web/src/ee/`, `worker/src/ee/`, `packages/shared/src/server/ee/` | copy-safe outside those dirs | Trace timeline and dashboard widgets | pattern |
| [langflow-ai/langflow](https://github.com/langflow-ai/langflow) | 156,045 / 2026-10-27 / MIT | copy-safe | A React Flow canvas with per-node build status streamed live | pattern |
| [Arize-ai/phoenix](https://github.com/Arize-ai/phoenix) | 12,016 / 2026-10-27 / Elastic License 2.0 | **pattern-only** | Trace UI | study via the shipped wheel |
| Flowise | 55,530, **archived** (last push 2026-08-13) | dropped | | do not use |

**xyflow/xyflow** @ `bb63f4c` · [LICENSE](https://raw.githubusercontent.com/xyflow/xyflow/bb63f4cc345acf4e6c73e0371be3ea3ca01b2a18/LICENSE) (MIT)
- Read: [examples/react/src/examples/Layouting/index.tsx#L1-L44](https://github.com/xyflow/xyflow/blob/bb63f4cc345acf4e6c73e0371be3ea3ca01b2a18/examples/react/src/examples/Layouting/index.tsx#L1-L44) (dagre auto-layout; PLAN WF decision chose "no auto-layout", this is the 40-line option if wanted); [examples/.../Edges/CustomEdge.tsx#L1-L35](https://github.com/xyflow/xyflow/blob/bb63f4cc345acf4e6c73e0371be3ea3ca01b2a18/examples/react/src/examples/Edges/CustomEdge.tsx#L1-L35) (custom edge via `BaseEdge`, `getBezierPath`: dashed back-edges and "loop ≤ N" labels live here); `Handle`/`ConnectionLine` in [packages/react/src/components](https://github.com/xyflow/xyflow/tree/bb63f4cc345acf4e6c73e0371be3ea3ca01b2a18/packages/react/src/components) (listed, not opened).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/xyflow/xyflow ~/ref/xyflow && cd ~/ref/xyflow && git sparse-checkout set examples/react/src/examples/Layouting examples/react/src/examples/Edges`
- REA/graph: source-only (the package is already in `dashboard/node_modules`).

**langfuse/langfuse** @ `7526ede` · [LICENSE](https://raw.githubusercontent.com/langfuse/langfuse/7526ede92399d7e04235b581b12470a401aaf5d7/LICENSE) (MIT Expat except the `ee` dirs above; © ClickHouse)
- Read: [web/src/features/traces/components/TraceTimelineDense/TimelineDense.tsx](https://github.com/langfuse/langfuse/blob/7526ede92399d7e04235b581b12470a401aaf5d7/web/src/features/traces/components/TraceTimelineDense/TimelineDense.tsx) (79 KB waterfall; model for our per-decision `stages[]` timeline), [TraceLayoutDesktop.tsx](https://github.com/langfuse/langfuse/blob/7526ede92399d7e04235b581b12470a401aaf5d7/web/src/features/traces/components/TraceLayoutDesktop.tsx) (trace + detail pane), [dashboard/components/LatencyChart.tsx](https://github.com/langfuse/langfuse/blob/7526ede92399d7e04235b581b12470a401aaf5d7/web/src/features/dashboard/components/LatencyChart.tsx) (chart widgets go through an internal `Chart` wrapper, not raw Recharts; contents of the wrapper `UNVERIFIED`). Only file headers were opened.
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/langfuse/langfuse ~/ref/langfuse && cd ~/ref/langfuse && git sparse-checkout set web/src/features/traces/components/TraceTimelineDense web/src/features/dashboard/components`
- REA/graph: source-only. Maps to: `Overview.tsx` decision drawer.

**langflow-ai/langflow** @ `aeb10d9` · [LICENSE](https://raw.githubusercontent.com/langflow-ai/langflow/aeb10d96bb2ea797696613af931e91ddf51f3320/LICENSE) (MIT)
- Read: [src/frontend/src/utils/buildUtils.ts#L160-L290](https://github.com/langflow-ai/langflow/blob/aeb10d96bb2ea797696613af931e91ddf51f3320/src/frontend/src/utils/buildUtils.ts#L160-L290) (`buildFlowVertices`, `onBuildUpdate(data, BuildStatus, buildId)`, streamed events set `TO_BUILD/BUILDING/ERROR` per vertex); canvas in [pages/FlowPage/components/PageComponent/index.tsx](https://github.com/langflow-ai/langflow/blob/aeb10d96bb2ea797696613af931e91ddf51f3320/src/frontend/src/pages/FlowPage/components/PageComponent/index.tsx) and [stores/flowStore.ts](https://github.com/langflow-ai/langflow/blob/aeb10d96bb2ea797696613af931e91ddf51f3320/src/frontend/src/stores/flowStore.ts) (50 KB; both `UNVERIFIED` contents).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/langflow-ai/langflow ~/ref/langflow && cd ~/ref/langflow && git sparse-checkout set src/frontend/src/utils/buildUtils.ts src/frontend/src/stores/flowStore.ts`
- REA/graph: source-only. Maps to: `Runs.tsx` live overlay; ours polls every 1.5 s (PLAN), the SSE upgrade path is visible here.

**Arize-ai/phoenix** @ `deb0731` · [LICENSE](https://raw.githubusercontent.com/Arize-ai/phoenix/deb0731a4606b77c786d86953301ecca39916829/LICENSE) (Elastic License 2.0) → pattern-only. I did not locate its trace components in the tree (`UNVERIFIED`). **REA target:** PyPI wheel [`arize_phoenix-20.26.1`](https://pypi.org/pypi/arize-phoenix/json) (8.0 MB, PyPI license `Elastic-2.0`) ships the built UI; use `analyze_web_bundle` on its static assets for UI structure. Study only.

---

## F11. Shared team mode (API keys, rate limits, N stateless workers)

**Ours today.** `src/ctc/server/app.py` (shared-mode auth: `Authorization: Bearer ctc_...` → sha256 → cache or `ctc.api_keys`; rate-limit check [L137](../../src/ctc/server/app.py) via `Cache.hit_rate`, 429 for APIs and empty 200 for hooks); `src/ctc/server/api.py` keys endpoints; `src/ctc/server/state.py` (per-worker state); `uvicorn --workers N`.
**Question.** Is fixed-window INCR good enough, and how do gateways structure key lookup caching and cross-worker limits?

| Repo | Stars / last push / license | Class | What it gives | Verdict |
|---|---|---|---|---|
| [IBM/mcp-context-forge](https://github.com/IBM/mcp-context-forge) | 4,700 / 2026-10-25 / Apache-2.0 (v1.1.0) | copy-safe | Redis sliding-window Lua limiter with lockout; token scoping | **reuse** the Lua |
| [BerriAI/litellm](https://github.com/BerriAI/litellm) | 62,095 / 2026-10-27 / MIT outside `enterprise/` | copy-safe outside `enterprise/` (214 files there) | `DualCache` (L1+L2), key hashing, Lua window limiter v3 | pattern |
| [Portkey-AI/gateway](https://github.com/Portkey-AI/gateway) | 13,277 / 2026-05-25 (5 months quiet) / MIT | copy-safe | Hooks/guardrails middleware, retries | skip (not our problem; only `src/middlewares/hooks/index.ts` size known) |
| metamcp (F1) | | MIT, references-only | `rate-limit.middleware.ts`, `api-key-oauth.middleware.ts` | skip (not opened) |

**IBM/mcp-context-forge** @ `85dabf0` · [LICENSE](https://raw.githubusercontent.com/IBM/mcp-context-forge/85dabf0beb75d05f8ff230fb823f7fe60aa1871a/LICENSE) (Apache-2.0)
- Read/lift: [mcpgateway/middleware/rate_limit_middleware.py#L51-L73](https://github.com/IBM/mcp-context-forge/blob/85dabf0beb75d05f8ff230fb823f7fe60aa1871a/mcpgateway/middleware/rate_limit_middleware.py#L51-L73) (Lua: `ZREMRANGEBYSCORE`, `ZCARD`, `ZADD`, `EXPIRE` in one call, registered via `register_script` at L181); `mcpgateway/middleware/token_scoping.py` ([78 KB](https://github.com/IBM/mcp-context-forge/blob/85dabf0beb75d05f8ff230fb823f7fe60aa1871a/mcpgateway/middleware/token_scoping.py), `UNVERIFIED` contents).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/IBM/mcp-context-forge ~/ref/context-forge && cd ~/ref/context-forge && git sparse-checkout set mcpgateway/middleware`
- REA/graph: source-only. Maps to: `Cache.hit_rate` in `storage/cache.py` (replace INCR+EXPIRE with the script; 20 ms Redis timeout and fail-open stay).

**BerriAI/litellm** @ `ebe0871` · [LICENSE#L1-L5](https://github.com/BerriAI/litellm/blob/ebe0871a28bbd585b73988c78edebf675985b9de/LICENSE#L1-L5) (MIT; `enterprise/` is separately licensed)
- Read: [litellm/caching/dual_cache.py#L70-L96](https://github.com/BerriAI/litellm/blob/ebe0871a28bbd585b73988c78edebf675985b9de/litellm/caching/dual_cache.py#L70-L96) (in-memory + Redis, `redis_batch_cache_expiry` throttles how often a key is re-read from Redis); [litellm/proxy/hooks/parallel_request_limiter_v3.py#L217-L229](https://github.com/BerriAI/litellm/blob/ebe0871a28bbd585b73988c78edebf675985b9de/litellm/proxy/hooks/parallel_request_limiter_v3.py#L217-L229) (Lua window/counter keys, 265 KB file); [litellm/proxy/utils.py#L7884](https://github.com/BerriAI/litellm/blob/ebe0871a28bbd585b73988c78edebf675985b9de/litellm/proxy/utils.py#L7884) (`hash_token`).
- Clone: `git clone --depth 1 --filter=blob:none --sparse https://github.com/BerriAI/litellm ~/ref/litellm && cd ~/ref/litellm && git sparse-checkout set litellm/caching litellm/proxy/hooks`
- REA/graph: source-only (PyPI wheel exists but source is clearer). Maps to: `storage/cache.py` read throttling for `key:{hash}` lookups.

---

## REA run sheet

Order: artifacts that already exist on this machine first, then packaged builds, then source-only repos (graphify or codebase-memory on a sparse clone). The REA tool names below come from the MCP listing; I did not run any of them.

| # | Repo | Command or location | Target | Ask REA / graph |
|---|---|---|---|---|
| 1 | claude-mem | local file | `/home/aiface/.claude/plugins/cache/thedotmack/claude-mem/15.2.1/scripts/worker-service.cjs` (4.2 MB) | `analyze_javascript_application`: routes on `:37707`, observation table schema, the prompt text sent to the observer; then `compare_application_versions` against `claude-mem@15.3.0` |
| 2 | Claude Code | local binary | `/home/aiface/.local/share/claude/versions/2.1.306` | `search_strings` for `additionalContext`, `allowedHttpHookUrls`, `asyncRewake`: does 2.1.306 accept `type: "http"` and cap 10,000 chars? |
| 3 | codebase-memory-mcp | local ELF | `/home/aiface/.local/bin/codebase-memory-mcp` (0.9.0) | `binary_overview`, `search_strings` for tool names and Cypher keywords; compare with release `v0.12.1` |
| 4 | ratel | `npm pack @ratel-ai/ratel-local@0.9.0` into a scratch dir | tarball (6.9 MB unpacked) | which hooks it installs into `~/.claude/settings.json`, daemon API shape |
| 5 | n8n | `npm pack n8n-core@2.16.1` into a scratch dir | `dist/execution-engine/workflow-execute.js` | `trace_javascript_semantics` for the ready/waiting-execution stack and partial re-run; study only (SUL) |
| 6 | kestra (optional) | GitHub release asset `kestra-2.0.7` | JAR (131 MB) | `inspect_managed_members` on `io.kestra.core.services.ExecutionService` (`restart`, `replay`) |
| 7 | phoenix (optional) | `pip download --no-deps arize-phoenix==20.26.1` into a scratch dir | wheel's static UI bundle | `analyze_web_bundle` for trace-view components; study only (ELv2) |
| 8 | ThakiCloud/SKILLRET | `git clone --depth 1 --filter=blob:none --sparse https://github.com/ThakiCloud/SKILLRET ~/ref/skillret && cd ~/ref/skillret && git sparse-checkout set skillret train/reranker-ft` | `skillret/eval.py`, `config.py` | graphify: how `build_skill_text` and `_format_query` feed `eval_retrieval`; port to `evaluation/loaders.py` |
| 9 | ratel-ai/ratel | clone in F1 | `src/core/src/{fusion,usage_learner,rerank}.rs`, `docs/adr/0014`, `0019`, `0024` | graphify `explain` on `score_fuse`, `UsageLearner`; read ADR-0014 and ADR-0019 (not opened here) |
| 10 | semantic-router | clone in F3 | `semantic_router/calibration.py` | copy-shape review for `retrieval/gate.py` |
| 11 | litellm / context-forge | clones in F11 | `litellm/caching/dual_cache.py`, `rate_limit_middleware.py` | compare against `storage/cache.py` |
| 12 | n8n, kestra, activepieces | clones in F7 | engine files listed in F7 | graphify `path` from `runNode` to `processRunExecutionData`; list restart/replay entry points |
| 13 | aider, graphify, spec-kit | clones in F8 | `aider/repomap.py`, `graphify/affected.py`, `templates/tasks-template.md` | PageRank personalisation; relation allow-list; task grammar |

---

## Open questions

1. **References-only override (decision needed).** ratel (MIT, core Apache-2.0), metamcp (MIT) and the two MCPGateways (MIT) are copy-safe, but `CLAUDE.md` (2026-10-20) says references only. Default: keep it. Rows 2, 4 and 9 of "Adopt first" re-implement ideas (a 10-line formula, a threshold test, a bounded bonus arm), which the decision allows. Say so if you want to paste code instead.
2. **Which "MCPGateway"?** `CLAUDE.md` names it without an owner. Candidates: `abdullah1854/MCPGateway` (17 stars) and `managedcode/MCPGateway` (5 stars, .NET). Default: treat both as skipped.
3. **A non-TEI sidecar for SKILLRET-Reranker-0.6B.** It is `Qwen3ForCausalLM`, not a sequence classifier, and TEI's README lists no such reranker. Trying it needs a new model server (transformers or vLLM) in place of the bge container, about 1.2 GB (estimate). Default: propose it as its own step after rows 1-5, not now.
4. **SKILLRET code license.** The GitHub repo has no LICENSE file though its README claims Apache-2.0 (HF cards say apache-2.0). Default: pattern-only; re-implement `Qwen3RankModel` and the text builder.
5. **Native `http` hook (row 8).** It changes `ctc install` output and needs a JSON response variant of `/v1/hook/prompt`; `allowedHttpHookUrls` in managed settings can block it. Default: keep `curl` until you approve a small step.
6. **m7 and claude-mem.** claude-mem is Apache-2.0 with a NOTICE, so porting is permitted with attribution; it is not a "reference only" case unless you decide it is. Default: port with NOTICE preserved.
7. **Study of source-available code via REA.** n8n (Sustainable Use), Phoenix (Elastic 2.0) and Windmill (AGPL) are pattern-only; running REA on their published bundles is for understanding only. Default: allowed for study, nothing pasted. I did not check what each license says about reverse engineering of the shipped builds; confirm if that matters.
8. **Noticed, not acted on.** (a) PLAN "Still unverified: croniter 6.2.4" is now verified (tag exists, 2026-07-10). (b) `claude-squad` is AGPL-3.0 and Flowise is archived: both dropped. (c) `letta-ai/letta` main no longer holds the server; the memory-block code is on its `archive` branch. (d) Our TEI pin is 1.8.2 while the reading above is `main` (v1.9.4-era); re-check the rerank scoring code on the 1.8.2 tag before relying on row 7. (e) Not opened: mteb, tree-sitter, Portkey internals, metamcp rate-limit files, SkillRet ADR-0014/0019 in ratel.
