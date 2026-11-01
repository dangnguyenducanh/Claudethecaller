# Research: Flagship-repo adoption (m8)

Source of facts: [.scratch/feature-landscape/research.md](../../.scratch/feature-landscape/research.md) (each claim there carries a pinned permalink; the ones below repeat the permalinks they rely on). Facts re-checked on 2026-10-27 for this plan are marked **[checked]**. No NEEDS CLARIFICATION remains; the three items that need a look at code during a ticket are listed in R9.

## R1. Embedding text and query instruction (row 1 → M8-1)

- **Decision**: add config `embed: {text: current|skillret, instruction: coding|skillret, skillret_body_chars: 8000}`. `skillret` builds `name | description | body` (body cut at `skillret_body_chars`, empty body → name | description) and uses SkillRet's instruction `Instruct: Given a skill search query, retrieve relevant skills that match the query\nQuery: `. Defaults stay `current` / `coding`. The ablation indexes SkillRet into `ctc_skillret` twice (one per text mode, instruction paired with the text) and reports dense-only and hybrid, dev and test, at body caps 2000 and 8000. Flip rule: dev NDCG@10 improves and test does not regress (paired p ≥ 0.05 against "worse").
- **Rationale**: SkillRet's own harness embeds the full `name | description | skill_md` and reports NDCG@10 81.12 for the embedder we run ([eval.py#L84-L89](https://github.com/ThakiCloud/SKILLRET/blob/0cc508e6bfcfff1fe6352d90ff5957ba38a64bba/skillret/eval.py#L84-L89), [config.py#L17](https://github.com/ThakiCloud/SKILLRET/blob/0cc508e6bfcfff1fe6352d90ff5957ba38a64bba/skillret/config.py#L17), [README#L205](https://github.com/ThakiCloud/SKILLRET/blob/0cc508e6bfcfff1fe6352d90ff5957ba38a64bba/README.md#L205)); ours embeds `name: description` (≤ 1,000 chars) + summary + triggers, no body ([indexer.py#L16-L19](../../src/ctc/ingestion/indexer.py)) and asks a different question in `QUERY_INSTRUCTION` ([embedder.py#L12](../../src/ctc/embedding/embedder.py)). The capability already carries `body` (`scanner.py` L35; `loaders.skillret_caps` fills it), so no new data is needed. The 81.12 vs 0.787 gap is a hypothesis about text parity, not a guarantee (different pipeline), hence an ablation.
- **Alternatives**: flip the default straight away (rejected: re-embeds the live index and may lose on test); fine-tune our own embedder (out of scope, A4); embed body chunks instead of one long text (more vectors per capability; try only if the single text loses to truncation).
- **License**: SKILLRET code has no LICENSE file → pattern-only; nothing copied, the 6-line text builder and the instruction string are our own words/values (the string is a dataset-defined input format, not creative code).

## R2. TEI `raw_scores` and where the rerank scale is consumed (row 7 → M8-2)

- **Decision**: `Reranker.score()` posts `raw_scores: true`, applies `1/(1+exp(-x))` client-side and returns the sigmoid (same scale as today); `hybrid.search` also stores the logit in `stages["rerank_logit"]`.
- **Rationale**: **[checked]** In TEI **v1.8.2** (our pinned tag, commit `d7af1fc`) `core/src/infer.rs` `predict()` applies softmax (multi-label) or a sigmoid on the single output when `raw_scores` is false (L458-L478), and the `/rerank` route passes `req.raw_scores` through (`router/src/http/server.rs` L357). So the current scores are `sigmoid(logit)`, which compresses the 0.001–0.04 range the 2026-10-21 Decision found unusable; the logits keep spacing as gate features. Consumers of the sigmoid scale: `bundle.py` L114 (`agent_min_rerank` 0.5), `hybrid.py` L127 (`abstain_below`), the reasons text, and `retrieval_eval.py`'s score memo; keeping the sigmoid client-side leaves all of them unchanged. Ordering cannot change (monotone), so this is a feature-quality change, not a recall change.
- **Alternatives**: move consumers to logit scale (rejected: re-tunes `agent_min_rerank`, invalidates saved gates); leave as is (rejected: loses the logit signal for M8-5).
- **License**: TEI Apache-2.0; read only.

## R3. Score fusion beside RRF (row 2 → M8-3)

- **Decision**: `ranking.fusion: rrf|score` (default `rrf`, byte-identical output). `score` = `(1 − w)·lex_norm + w·cos` with `w` in `ranking.score_w` (sweep 0.5–0.9 on SkillRet **dev only**, ratel's value is 0.7), `lex_norm` = `ts_rank_cd` divided by the pool's maximum for that query (0 if none), final order by the fused score, fused value stored in `stages["fused"]`. Reranker still re-orders the top `rerank_top` as today; the gate/margin read `stages["fused"]`.
- **Rationale**: ratel's ADR-0024 reports score fusion beating RRF on every metric at every k on BFCL and RRF returning ~0.033 for right and wrong queries alike ([ADR-0024#L47-L64](https://github.com/ratel-ai/ratel/blob/b525ca86a535f57e3ff3a17af763d809a1960242/docs/adr/0024-hybrid-fuses-on-scores.md#L47-L64), [#L91-L110](https://github.com/ratel-ai/ratel/blob/b525ca86a535f57e3ff3a17af763d809a1960242/docs/adr/0024-hybrid-fuses-on-scores.md#L91-L110), [fusion.rs#L164-L233](https://github.com/ratel-ai/ratel/blob/b525ca86a535f57e3ff3a17af763d809a1960242/src/core/src/fusion.rs#L164-L233)); our own result agrees (dense-only 0.787 > hybrid 0.771). A bounded score is also the missing absolute signal for abstain. Our keyword arm is `ts_rank_cd`, not BM25, so the normalisation is my choice and untested; the dev sweep decides.
- **Alternatives**: ranx `wsum`/`mixed` ([ranx/fusion](https://github.com/AmenRa/ranx/tree/7363db0c35e92e90d6fa6fe73907b760678f765e/ranx/fusion)), usable inside `evaluation/` for the sweep via `optimize_fusion` but not at runtime (dev dependency); a learned combiner (rejected: another model to keep honest).
- **License**: ratel is `references-only` (MIT / core Apache-2.0): **re-implement the formula, copy nothing**.

## R4. Calibrated abstain and the margin baseline (rows 3, 4 → M8-5)

- **Decision**: in `retrieval/gate.py` add candidate scorers over `stages["fused"]` (and `rerank_logit` as a second feature set): `margin` (top1 ≥ `margin_ratio` × top2, ratio 1.5, swept), `platt` (`LogisticRegression` on the one score with smoothed targets) and `isotonic` (`IsotonicRegression`, `out_of_bounds="clip"`), each with ECE. Labels: SkillRet queries are positives (some capability should fire); MetaTool no-tool prompts are negatives (`None` = nothing fires). K2 prints, per candidate: ECE, threshold at false-trigger ≤ 10% on MetaTool dev, then suggest-rate on SkillRet test and false-trigger on MetaTool test. Abstain turns on only per SC-003.
- **Rationale**: the LR gate over seven features scored CV AUC 0.55 and suggested on 7–13% of prompts at 10% false-trigger (CLAUDE.md, 2026-10-21); semantic-router fits a calibrator over a score with `None` as a legal label ([calibration.py#L11-L109](https://github.com/aurelio-labs/semantic-router/blob/1fa1937e390fe57fb85ee3bbb8b3db593a4145db/semantic_router/calibration.py#L11-L109), [routers/base.py#L160-L176](https://github.com/aurelio-labs/semantic-router/blob/1fa1937e390fe57fb85ee3bbb8b3db593a4145db/semantic_router/routers/base.py#L160-L176)); ratel-local ships a "clear winner" margin as its push gate ([suggest.ts#L128-L145](https://github.com/ratel-ai/ratel-local/blob/948cdbd33cdcb770183ededc310202e2aaa145bd/apps/ratel-local/src/cli/skills/suggest.ts#L128-L145)). Owner decision of 2026-10-22: SkillRet and MetaTool decide the gate; own-transcript rows are a secondary check.
- **Deviation from the approved proposal [flag]**: the proposal said "lift `calibration.py` with a NOTICE". I plan to **re-implement with scikit-learn instead** (already installed, `gate.py` already imports it): Platt and isotonic are ~15 lines and ECE is ~8, so the 109 lines are not worth a NOTICE entry or a copy. If the owner prefers the lift, it is MIT and FR-009 covers it.
- **Alternatives**: lift calibration.py (above); keep the LR gate and add features (it had no signal); a small reranker-based classifier (needs labels; H1).
- **License**: semantic-router MIT; read only. ratel-local `references-only`: only the idea (a ratio test) is used, the code is not.

## R5. Paired significance in the eval report (row 5 → M8-4)

- **Decision**: in `evaluation/retrieval_eval.py` build the report's comparisons with `ranx.compare` (paired Student's t; `max_p` 0.01, and 0.05 printed too) and tune fusion weights with `ranx.optimize_fusion` on SkillRet **train** (`ctc_skillret_train`) or dev only; `ranking-test` prints dense vs configured vs old `{1, 1}` with p-values.
- **Rationale**: dev said rerank +0.025, test said −0.014 with no test of either ([compare.py#L11-L35](https://github.com/AmenRa/ranx/blob/7363db0c35e92e90d6fa6fe73907b760678f765e/ranx/meta/compare.py#L11-L35), [optimize_fusion.py#L8-L77](https://github.com/AmenRa/ranx/blob/7363db0c35e92e90d6fa6fe73907b760678f765e/ranx/meta/optimize_fusion.py#L8-L77)). ranx is already imported in the file (`Qrels, Run, evaluate`).
- **Alternatives**: scipy `ttest_rel` by hand (more code, same result); bootstrap (slower, no gain here).
- **License**: ranx MIT, a dependency (dev group in `pyproject.toml`: eval only, which is where it runs).

## R6. Sliding-window rate limit (row 10 → M8-7)

- **Decision**: replace the `INCR`+`EXPIRE` pipeline in `Cache.hit_rate` ([cache.py#L272](../../src/ctc/storage/cache.py)) with one `register_script` Lua call over a sorted set `rl:{user}`: drop members older than 60 s (`ZREMRANGEBYSCORE`), add this request with the Redis `TIME` as score and a unique member, `EXPIRE` 60, return `ZCARD`. Signature unchanged (`hit_rate(user) -> int`), so `app.py` L137 is untouched; the 20 ms timeout and fail-open path stay. **Copy** the script shape from context-forge with an SPDX header, the pinned permalink and a `THIRD_PARTY_NOTICES.md` entry (Apache-2.0 requires keeping the notice for copied lines).
- **Rationale**: the fixed window lets a client send `limit` requests at second 59 and `limit` more at second 61; the Lua sliding window removes the boundary burst atomically ([rate_limit_middleware.py#L51-L73](https://github.com/IBM/mcp-context-forge/blob/85dabf0beb75d05f8ff230fb823f7fe60aa1871a/mcpgateway/middleware/rate_limit_middleware.py#L51-L73), no `ee/` or `enterprise/` path in that tree at that SHA). Using Redis `TIME` avoids worker clock skew (edge case in the spec).
- **Alternatives**: keep fixed window (the burst); token bucket (more state); litellm's `parallel_request_limiter_v3` (265 KB file, MIT but `enterprise/` is separate: more than we need).
- **License**: Apache-2.0, copy-safe, not on the references-only list.

## R7. Clone and license policy for this feature

- **Decision**: nothing is cloned into this repo. Reading clones (if wanted) go to `~/ref/` with the sparse commands in the note, for graphify or codebase-memory. Per repo: ratel / ratel-local / metamcp / both MCPGateways: idea only, no code; SKILLRET: pattern-only (no LICENSE file; the HF cards say Apache-2.0 but the code repo does not); TEI, semantic-router, ranx: read or depend; context-forge: one script lifted with NOTICE; claude-code, n8n, Phoenix, Windmill, paradedb, claude-squad: untouched.
- **Rationale**: CLAUDE.md Decision 2026-10-20 (built from scratch, references-only). The note's "Open questions" 1, 4 and 7 are answered by their defaults here.
- **Alternatives**: override the references-only decision for ratel (MIT): rejected, not needed (the formula is ten lines).

## R8. GPU and index cost of a longer text (M8-1)

- **Decision**: the ablation measures peak GPU with `nvidia-smi --query-compute-apps` over this project's containers during the SkillRet index (the Constraint in `PLAN.md`), and stops if the project total passes 7 GB. Batch size stays `TEI_MAX_BATCH = 32` ([retrieval_eval.py#L44](../../evaluation/retrieval_eval.py)); the body cap is the lever.
- **Rationale**: the three containers use ~6.4 GB today (Decision 2026-10-21), 0.6 GB headroom; embedding 6,006 long skills could raise TEI's activation memory.
- **Alternatives**: token-aware truncation (upgrade if the cap shows quality loss at 2000 vs 8000); chunking (R1).

## R9. Items to look at inside a ticket (not blockers)

1. M8-1: whether `Store.catalog()` returns `body` in the dict that `indexer.texts(cap)` gets; if not, add it to that query.
2. M8-3: where the keyword arm exposes its `ts_rank_cd` score in `Store.candidates()` (needed for `lex_norm`); today only the rank may be returned.
3. M8-5: MetaTool negatives loader exists in `evaluation/loaders.py`; reuse the one K2 used on 2026-10-21 so results are comparable.

## Deferred rows (recorded, not planned)

- **Row 6** SKILLRET-Reranker-0.6B: `Qwen3ForCausalLM` yes/no scorer, ~596M params, apache-2.0 weights; TEI's README lists no such reranker, so it needs a transformers/vLLM sidecar (~1.2 GB computed, not measured). Plan it only if M8-2/M8-3 leave rerank losing on test.
- **Row 8** native `type: "http"` hook: needs a JSON `additionalContext` reply (plain-text 2xx adds nothing) and changes `ctc install` output; a real-`~/.claude` step, so owner-approved on its own.
- **Row 9** usage arm: invocation-only evidence with impressions as denominator; judge it on H1 labels.
