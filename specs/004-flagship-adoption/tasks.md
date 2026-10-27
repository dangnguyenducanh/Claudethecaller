---

description: "Task list for flagship-repo adoption (m8)"
---

# Tasks: Flagship-repo adoption (m8)

**Input**: Design documents from `/specs/004-flagship-adoption/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/knobs-and-eval.md](contracts/knobs-and-eval.md), [quickstart.md](quickstart.md)

**Tests**: included, one test file per ticket (plan.md "Source Code"). Every test that needs Postgres, Redis or a GPU service skips unless the scratch service is named in the shell env, as `scripts/check.sh` already does.

**Organization**: tasks are grouped by user story; the ticket id (`M8-n`) from plan.md is kept in each task. Builders work in separate git worktrees, return a patch and never commit (CLAUDE.md working agreement).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallel with other `[P]` tasks of the same wave (different files)
- **[Story]**: US1–US5 from spec.md

## Waves and file ownership (read this before assigning builders)

Files shared between tickets, so those tickets are NOT parallel with each other: `evaluation/retrieval_eval.py` (M8-1, M8-4, then M8-5/M8-3 sweep), `src/ctc/retrieval/hybrid.py` (M8-2, M8-3), `config/retrieval.yaml` (M8-1, M8-3, M8-5), `src/ctc/storage/store.py` (M8-1 catalog if needed, M8-3 `candidates()`). Resolution: one builder owns each file in a wave, and **Group A adds every new config key with its default in one go** (T004), so no other group edits `config/retrieval.yaml`.

| Wave | Group | Tickets | Owns (edits only these) |
|---|---|---|---|
| 1 | A | M8-1 + M8-4 (+ T004 config) | `config/retrieval.yaml`, `src/ctc/config.py`, `src/ctc/ingestion/indexer.py`, `src/ctc/embedding/embedder.py`, `evaluation/loaders.py`, `evaluation/retrieval_eval.py`, `tests/test_text_mode.py`, `tests/test_eval_compare.py`; `src/ctc/storage/store.py` catalog function only if R9-1 needs it |
| 1 | B | M8-2 + M8-3 | `src/ctc/reranking/reranker.py`, `src/ctc/retrieval/hybrid.py`, `src/ctc/storage/store.py` (`candidates()` only), `tests/test_reranker.py`, `tests/test_fusion.py` |
| 1 | C | M8-7 | `src/ctc/storage/cache.py`, `THIRD_PARTY_NOTICES.md`, `tests/test_rate_limit.py` |
| 2 | D | M8-5 + fusion sweep | `src/ctc/retrieval/gate.py`, `evaluation/retrieval_eval.py`, `tests/test_gate_candidates.py` (after A and B are merged and committed) |
| 3 | lead | M8-6 | runs in the main checkout (has `.env`, `data/`, `models/`, GPU services); edits `config/retrieval.yaml`, `CLAUDE.md` Decisions, `specs/004-flagship-adoption/results.md` |

## Phase 1: Setup (no story)

- [ ] T001 [P] Confirm eval prerequisites and record them in `data/reports/m8-env.json`: TEI embedder `:18300` and reranker `:18301` answer (embedder log shows CUDA, not CPU); the scratch Postgres is `ctc-dev-pg` (`CTC_DATABASE_URL` is the commented dev line in `.env`, `127.0.0.1:18304/ctc`; never print the password); list which database holds schemas `ctc_skillret` and `ctc_skillret_train`; abort any plan that would write to the Supabase URL.
- [ ] T002 [P] Baseline on UNCHANGED code (SC-002), saved to `data/reports/m8-baseline.json`: `uv run python -m evaluation.retrieval_eval ranking-test` and `run` against the scratch DB, plus `scripts/check.sh` result. Run it in the main checkout while the builders work in worktrees, before any patch is applied.
- [ ] T003 [P] In each builder worktree run `uv sync --frozen` and `uv run ruff check src evaluation scripts tests` once to prove the worktree is clean.

## Phase 2: Foundational (blocks all stories)

- [ ] T004 (M8-1, Group A) Add every new config key with its default to `config/retrieval.yaml` exactly as in data-model.md: `embed: {text: current, instruction: coding, skillret_body_chars: 8000}`, `ranking.fusion: rrf`, `ranking.score_w: 0.7`, `gate: {kind: off, margin_ratio: 1.5, min_p: 0.5}`; keep the existing `ranking`, `gate_path`, `gate_min_p` keys and comments untouched.
- [ ] T005 (M8-1, Group A) In `src/ctc/config.py` validate at load: `embed.text` ∈ {`current`, `skillret`}, `embed.instruction` ∈ {`coding`, `skillret`}, `ranking.fusion` ∈ {`rrf`, `score`}, `gate.kind` ∈ {`off`, `margin`, `platt`, `isotonic`, `lr`}; any other value raises a `ValueError` naming the key (fail fast, contracts/knobs-and-eval.md). Missing keys fall back to the defaults from T004, so old config files still load.

**Checkpoint**: config loads with the defaults and behaviour is unchanged.

## Phase 3: User Story 1 - Embed the text the embedder was trained on (P1) 🎯 MVP

**Goal**: ablate SkillRet-style text and instruction against today's, without touching the live index.
**Independent Test**: quickstart.md §2 yields two reports (current vs skillret) with dev and test numbers.

- [ ] T006 [US1] (M8-1, Group A) `src/ctc/ingestion/indexer.py`: make `texts(cap, mode=None)` (`mode` defaults to `cfg()["embed"]["text"]`). `current` returns exactly today's list (`[f"{name}: {description}"[:1000] + summary, *triggers]`). `skillret` returns `[f"{name} | {description} | {body[:skillret_body_chars]}"]` (one string, no summary, no triggers; empty body → `f"{name} | {description}"`). `text_hash` stays `sha256(model + text)`.
- [ ] T007 [US1] (M8-1, Group A) `src/ctc/embedding/embedder.py`: replace the single constant with `QUERY_INSTRUCTIONS = {"coding": <today's string>, "skillret": "Instruct: Given a skill search query, retrieve relevant skills that match the query\nQuery: "}`; the embedder picks by `embed.instruction`; keep the name `QUERY_INSTRUCTION` importable (grep its users first). The `skillret` string is the SkillRet `config.py` L17 value.
- [ ] T008 [US1] (M8-1, Group A) Check whether the catalog dict passed to `indexer.texts(cap)` carries `body` (R9-1: `graphify query` then read `src/ctc/storage/store.py` catalog code). If it does not, add `body` to that one query in `src/ctc/storage/store.py` without changing other columns.
- [ ] T009 [US1] (M8-1, Group A) `evaluation/retrieval_eval.py` and `evaluation/loaders.py`: `index-skillret [--text current|skillret] [--body-chars N]` pairs the instruction with the text, indexes `current` into schema `ctc_skillret` and `skillret` into `ctc_skillret_sk` (both can coexist; never the live `ctc` schema), and writes `text_mode`, `instruction`, `body_chars` into the report header (contracts: report header).
- [ ] T010 [US1] (M8-1, Group A) `tests/test_text_mode.py`: `current` mode output equals a frozen expected list for a fixed cap dict (regression); `skillret` mode cuts a 20,000-char body at the cap and falls back to name | description when the body is empty or missing; instruction strings are the two documented values.

**Checkpoint**: unit tests pass; the ablation can run (executed in T031).

## Phase 4: User Story 2 - Fuse on scores, keep the rerank scale (P1)

**Goal**: `ranking.fusion: score` available; rerank score scale preserved; raw logits recorded.
**Independent Test**: quickstart.md §3–§4.

- [ ] T011 [US2] (M8-2, Group B) `src/ctc/reranking/reranker.py`: `/rerank` request body gains `"raw_scores": true`; `score()` returns `1/(1+exp(-logit))` per doc (same order as `texts`, numerically stable for |logit| > 30); new `score_with_logits(query, docs) -> list[tuple[float, float]]` returns `(sigmoid, logit)`; no other call sites change.
- [ ] T012 [US2] (M8-2, Group B) `src/ctc/retrieval/hybrid.py` `search()` L111: call `score_with_logits`, keep `stages["rerank"]` = sigmoid (so `agent_min_rerank` in `src/ctc/decision/bundle.py` L114 and `abstain_below` at `hybrid.py` L127 keep their scale), add `stages["rerank_logit"]`.
- [ ] T013 [US2] (M8-2, Group B) `tests/test_reranker.py`: an httpx mock transport returns raw logits; assert the request body has `raw_scores: true`, `score()` equals `1/(1+exp(-x))` within 1e-6 against a fixture of the values the old sigmoid server returned, and `score_with_logits()` returns both.
- [ ] T014 [US2] (M8-3, Group B) `src/ctc/storage/store.py` `candidates()`: also return the raw keyword score (`ts_rank_cd`) per keyword hit (R9-2) without changing existing result keys or ordering.
- [ ] T015 [US2] (M8-3, Group B) `src/ctc/retrieval/hybrid.py`: read `ranking.fusion` and `ranking.score_w` from the `ranking` dict (default `rrf` / `0.7`, via `.get`, because the yaml lands from Group A). `rrf` path unchanged byte for byte. `score` path: `fused = (1 - w) * lex_norm + w * cos`, `lex_norm = ts_rank_cd / max(ts_rank_cd over the pool)` (0 when the keyword arm is empty, so fused falls back to `w * cos` ordering), candidates ordered by `fused`, value stored in `stages["fused"]` in [0, 1]; the reranker still re-orders the top `rerank_top`.
- [ ] T016 [US2] (M8-3, Group B) `tests/test_fusion.py`: golden test that `fusion: rrf` returns the same hits and stages as a frozen result of the current algorithm; `score` arithmetic on a synthetic pool; empty keyword arm; `w = 1.0` equals dense order; `stages["fused"]` ∈ [0, 1].

**Checkpoint**: with `fusion: rrf` everything matches the baseline; `score` is selectable.

## Phase 5: User Story 3 - Calibrated abstain decision (P1)

**Goal**: K2 compares `off`, `margin`, `platt`, `isotonic`, `lr` on SkillRet and MetaTool.
**Independent Test**: quickstart.md §5. Depends on US2 (fused score) and US4 (p-values) being merged.

- [ ] T017 [US3] (M8-5, Group D) `src/ctc/retrieval/gate.py`: add `margin(top1, top2, ratio)` (fire only if `top1 >= ratio * top2`), `fit_platt(scores, y)` (scikit-learn `LogisticRegression`, smoothed targets), `fit_isotonic(scores, y)` (`IsotonicRegression(out_of_bounds="clip")`) and `ece(p, y, bins=10)`; fitting refuses single-class labels with a clear `ValueError`. Inputs come from `stages["fused"]` when present, else the dense score. The existing LR gate and `gate_path` loading stay as they are.
- [ ] T018 [US3] (M8-5, Group D) `evaluation/retrieval_eval.py` `tune`: candidates `off`, `margin`, `platt`, `isotonic`, `lr`; labels: SkillRet queries positive, MetaTool no-tool prompts negative (reuse the loader K2 used on 2026-10-21); per candidate print ECE before/after, the threshold meeting false-trigger ≤ 10% on MetaTool dev, then suggest-rate (SkillRet test) and false-trigger (MetaTool test), with per-language counts; write `data/reports/gate-<date>.json` in the contract shape; never overwrite `models/abstain.joblib` automatically.
- [ ] T019 [US3] (M8-5, Group D) `tests/test_gate_candidates.py`: synthetic scores where positives score higher: Platt/isotonic ECE ≤ raw ECE; `margin` fires only when top1 ≥ 1.5 × top2; single-class input raises; clipping of out-of-range scores for isotonic.
- [ ] T020 [US2] (M8-3, Group D) `evaluation/retrieval_eval.py` `ranking [--fusion score]`: DEV-only sweep of `score_w` ∈ {0.5, 0.6, 0.7, 0.8, 0.9} using `ranx.optimize_fusion` or a plain loop on SkillRet train/dev, report NDCG@10 and Recall@5 per `w`; never reads the test split.

## Phase 6: User Story 4 - Every ranking claim has a significance test (P1)

**Goal**: p-values in `ranking-test` and `run`.
**Independent Test**: quickstart.md §4 (`ranking-test` prints p-values).

- [ ] T021 [US4] (M8-4, Group A) `evaluation/retrieval_eval.py`: add `compare_runs(qrels, runs: dict)` using `ranx.compare` (`stat_test="student"`, `max_p=0.01`, and 0.05 reported too) returning the eval-record rows from data-model.md (`a, b, metric, split, delta, p, sig_0.01, sig_0.05`); call it in `ranking_test` (dense vs configured vs old `{1, 1}`) and `run`, and print the table in `report-<date>.md`.
- [ ] T022 [US4] (M8-4, Group A) `tests/test_eval_compare.py`: two synthetic runs where A clearly beats B → `sig_0.01` true; identical runs → `p` ≈ 1 and both flags false (ranx is a dev dependency, so the test imports it normally).

## Phase 7: User Story 5 - Rate limits without the boundary burst (P2)

**Goal**: sliding-window limiter with fail-open.
**Independent Test**: quickstart.md §6.

- [ ] T023 [US5] (M8-7, Group C) `src/ctc/storage/cache.py` `hit_rate(user)` (L272): replace the `INCR`+`EXPIRE` pipeline with one registered Lua script over sorted set `rl:{user}`: `ZREMRANGEBYSCORE` older than the window, `ZADD` this request (score = Redis `TIME` in ms, member = `<ms>-<seq>`, unique), `EXPIRE` window seconds, return `ZCARD`; window length is `ARGV` (default 60) so tests can use 2 s. Signature `hit_rate(user) -> int` unchanged, the 20 ms timeout and the `_safe` fail-open path (returns 0) stay. Start from the context-forge script at `IBM/mcp-context-forge@85dabf0` `mcpgateway/middleware/rate_limit_middleware.py` L51-L73 (fetch with `gh api` at that SHA), adapt, and put `SPDX-License-Identifier: Apache-2.0`, the permalink and a one-line "changed: Redis TIME, unique member" above the script string.
- [ ] T024 [US5] (M8-7, Group C) `THIRD_PARTY_NOTICES.md` (repo root, new): one entry for that script: file path in this repo, source repo and pinned permalink, license name and the Apache-2.0 notice requirement, what changed.
- [ ] T025 [US5] (M8-7, Group C) `tests/test_rate_limit.py`: (a) fail-open: with a client pointed at a closed port `hit_rate` returns 0 within the timeout (runs with no server); (b) skip unless `CTC_REDIS_URL` is a scratch Redis: limit 3, window 2 s: three calls return 1, 2, 3; one more after 1 s returns 4 (a fixed window could have reset); after 2.1 s from the first call the count drops. Do not touch `src/ctc/server/app.py`; confirm its L137 call site still type-checks.

**Checkpoint**: wave 1 patches (Groups A, B, C) are applied and committed before Group D starts.

## Phase 8: Measure, decide, document (no story)

- [ ] T026 (M8-6, lead) Merge wave 1 then wave 2 patches into branch `m8-flagship-adoption`, run `uv run ruff check src evaluation scripts tests` and `uv run pytest -q tests`, then `scripts/check.sh`; show real output. One commit per ticket group with Conventional Commits (`feat(retrieval): …`, `feat(eval): …`, `feat(cache): …`).
- [ ] T027 (M8-6, lead) Ablation (US1): `index-skillret --text current` and `--text skillret --body-chars 8000` (also 2000), then `run` for each, with `nvidia-smi --query-compute-apps` sampled during indexing; stop and report if this project's GPU total passes 7 GB (PLAN Constraint). Scratch DB only.
- [ ] T028 (M8-6, lead) Fusion and significance (US2, US4): `ranking --fusion score` (dev only), then `ranking-test` once on test with p-values.
- [ ] T029 (M8-6, lead) Gate (US3): `tune` with the fused score; apply the SC-003 rule (≥ 50% suggest-rate on SkillRet test at ≤ 10% false-trigger on MetaTool test, else off).
- [ ] T030 (M8-6, lead) Decide defaults per SC-001/SC-003 and FR-010: change `config/retrieval.yaml` only for knobs whose numbers pass (text flips only if dev improves and test does not regress; fusion only if test does not regress against `rrf` per `ranx.compare`); append dated lines to `CLAUDE.md` Decisions with the numbers, including the losers that stay off. The live Supabase index is not re-embedded; flipping `embed.text` live remains a separate owner step.
- [ ] T031 (M8-6, lead) Write `specs/004-flagship-adoption/results.md`: baseline vs each experiment, p-values, GPU peak, which knobs flipped and why, which tests ran and which were skipped (for example Redis sections if no scratch Redis was available), deferred rows 6/8/9 triggers, and the REA findings pointer (`.scratch/feature-landscape/rea-*.md`).
- [ ] T032 (M8-6, lead) Run `quickstart.md` §1–§6 end to end on the merged branch and paste the real outputs into `results.md`.

## Dependencies and order

- T001–T003 first; T002 must finish before any patch is applied to the main checkout.
- T004–T005 (Group A) gate the config-dependent tests of all groups only in the merged tree; Groups B and C code against defaults via `.get()` so they start at once.
- Wave 1 groups A, B, C run in parallel (disjoint files except `store.py`, edited in different functions; the lead resolves any 3-way conflict).
- Group D (T017–T020) starts after wave 1 is merged and committed (needs `stages["fused"]`, `score_w`, `compare_runs`).
- Phase 8 starts after Group D is merged.

## Parallel examples

- Wave 1: three builders at once, each in its own worktree: A (T004–T010, T021–T022), B (T011–T016), C (T023–T025).
- Inside Group A, T006/T007 are independent files; T009 follows T006–T008; T021 follows T009 (same file).

## Implementation strategy

MVP = US1 (the ablation). Everything else is independently valuable but each default flip waits for its measured evidence (FR-010). If a ticket's measurement does not justify a flip, its code stays merged behind the knob and the default stays today's.

## Mapping check (spec stories → tasks)

US1: T006–T010 · US2: T011–T016, T020 · US3: T017–T019 · US4: T021–T022 · US5: T023–T025 · Foundational: T004–T005 · Measure/decide: T026–T032. Total 32 tasks.
