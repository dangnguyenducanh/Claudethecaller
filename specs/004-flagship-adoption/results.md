# Results: Flagship-repo adoption (m8)

Run 2026-10-27 on branch `m8-flagship-adoption`. Every measurement used the scratch Postgres `ctc-dev-pg` (`127.0.0.1:18304/ctc`, schemas `ctc_skillret`, `ctc_skillret_train`, and the new `_sk` pair); the Supabase index was not written by any measurement. The test split was run once. Raw reports: `data/reports/m8-*.json`, `ablate-*.json`, `gate-2026-10-27.json` (gitignored).

## What changed (and what each default is now)

| Ticket | Change | Default after m8 | Evidence |
|---|---|---|---|
| M8-1 | `embed.text` (`current` \| `skillret`) and `embed.instruction` (`coding` \| `skillret`); `catalog_bodies()` fetches bodies 200 ids per statement | **`skillret` / `skillret`** (flipped) | dev and test below |
| M8-2 | `Reranker` asks TEI for `raw_scores`, applies the sigmoid itself; `stages["rerank_logit"]`; `ranking.rerank_by` | `sigmoid` (unchanged) | live parity check: `sigmoid(raw)` equals the old score to ~1e-11 on 4 pairs; dev: `by: logit` no better (p 0.88 / 0.19) |
| M8-3 | `ranking.fusion: score` beside `rrf` | `rrf` (unchanged) | dev: worse or equal at every `score_w` |
| M8-4 | `ranx.compare` p-values in `ranking-test`; new `ablate` command (variants in one process, paired tests) | n/a | used for every number here |
| M8-5 | gate candidates `margin`, `platt`, `isotonic`, `lr` in `tune` | gate **off** (unchanged) | SC-003 not met, below |
| M8-7 | sliding-window limiter, one Lua call, script from IBM/mcp-context-forge (Apache-2.0) | on in shared mode | unit tests; Lua not run on a real Redis, see Not verified |
| M8-6 | `ranking` weights for the new text | **`{0, 0}`** (dense order, flipped) | dev and test below |

## SC-002: baseline unchanged (code before any m8 change, then the same numbers after)

SkillRet test, 4,392 queries, NDCG@10: dense 0.7866, plain hybrid 0.5603, old `{1, 1}` 0.7708, configured `{0.25, 1}` 0.7734 (the 2026-10-21 record is 0.787 / 0.771 / 0.773). With the `current` text and `rrf` the m8 code reproduces them: 0.7868 dense, 0.7733 full (a TEI fp16 run-to-run wobble of about 2e-3 per score, seen by the reviewer, explains the last digit).

## US1: text mode ablation (SC-001), SkillRet `skillret` text with the SkillRet query prefix, body cut at 8,000 chars

Dev (500 train queries against the train skills), paired Student's t:

| Variant | dense NDCG@10 | full NDCG@10 | full Recall@5 |
|---|---|---|---|
| `current` text, ranking `{0.25, 1}` | 0.5796 | 0.6053 | 0.599 |
| `skillret` text, ranking `{0.25, 1}` | 0.7576 | 0.7110 | 0.694 |
| `skillret` text, ranking `{0, 0}` (dense order) | 0.7576 | **0.7576** | **0.713** |

`current` → `skillret` (dense): +0.178, p = 2.7e-43. Best weights per text on a 24-variant sweep: `current` keeps `{0.25, 1}`; `skillret` prefers `{0, 0}` over `{0.25, 1}` by +0.047 NDCG@10, p = 1.6e-11.

Test (4,392 queries, run once):

| Variant | dense NDCG@10 | full NDCG@10 | full Recall@1 | full Recall@5 | full Recall@10 |
|---|---|---|---|---|---|
| `current`, `{0.25, 1}` (shipped before) | 0.7868 | 0.7733 | 0.5260 | 0.7919 | 0.8679 |
| `skillret`, `{0.25, 1}` | 0.8116 | 0.7837 | 0.5323 | 0.7998 | 0.8810 |
| `skillret`, `{0, 0}` (chosen) | 0.8114 | **0.8114** | **0.5691** | **0.8245** | 0.8764 |

Paired: chosen vs shipped-before, NDCG@10 +0.0381 (p = 6.6e-29), Recall@5 +0.0325 (p = 1.9e-14). Dense-only `skillret` (0.8116) equals SkillRet's published 81.12. Flip rule (dev improves, test does not regress): **met**, so `config/retrieval.yaml` now has `embed: {text: skillret, instruction: skillret}` and `ranking {0, 0}`. Text and instruction were measured only as a pair (the CLI couples them), so the gain is not split between the two.

GPU: peak 3.8 GiB for this project's containers during the 16k-skill `skillret` indexing (budget 7 GiB; guard script sampled every 15 s, never over). Indexing took ~10 minutes for 6,006 + 10,123 skills.

## US2/US4: fusion, rerank order, significance

Dev, full order, NDCG@10 vs the same text with `rrf` (positive Δ = rrf better): score fusion `w` 0.5: +0.189 (`current`) / +0.252 (`skillret`), `w` 0.7: +0.028 / +0.050 (p ≤ 3e-6), `w` 0.9: +0.003 / +0.003 (p 0.43 / 0.33, no difference). `rerank_by: logit` minus sigmoid: −0.0001 / +0.0006 (p 0.88 / 0.19). So both knobs stay at their old defaults; fusion would only be tried further with a BM25-style keyword arm (our `ts_rank_cd` is not bounded like BM25). Not run on test, by the dev rule.

## US3: abstain gate (SC-003), `skillret` text, dense first-stage score, fit and threshold on dev, scored once on test

| Candidate | SkillRet test suggest-rate | MetaTool test false-trigger | Meets SC-003 (≥ 50% and ≤ 10%) |
|---|---|---|---|
| off | 100% | 100% | no |
| margin (ratio 1.30) | 34.7% | 12.0% | no |
| Platt | 48.9% | 8.4% | no (1.1 points short) |
| isotonic | 41.4% | 5.8% | no |
| lr (the 7-feature gate of 2026-10-21, refit on the new text) | 99.9% | 10.2% (28 of 274) | no (0.2 points over) |

Per the rule the gate stays **off**. The `lr` result is a large change from the 2026-10-21 attempt (CV AUC 0.55, 7–13% suggested) and sits one prompt over the bar: it is the candidate to revisit after H1 labels. `models/gate-lr-2026-10-27.joblib` (gitignored) is in the loader's shape: copying it to `models/abstain.joblib` turns it on, and it is valid only together with the `skillret` text. `margin`, `platt` and `isotonic` are measured but nothing consumes them at query time yet (`hybrid.search` reads only the LR joblib via `gate_path`).

## US5: rate limit

`hit_rate` is one Lua call over a sorted set; it counts blocked attempts too, so a client that keeps sending more than the limit per minute stays blocked until it backs off (no Retry-After). Tests: the fail-open case runs (closed port, no server); the sliding-window case skips without a scratch Redis. The review checked the script against Redis 5.1 Lua rules by reading; a builder ran the same script on fakeredis + lupa (Lua 5.4) and it passed the same scenario.

## Review (CLAUDE.md /2: one reviewer, critical/high only) and fixes

Two high findings, both on the live-flip path, both fixed (`ce28e91`): `emb:` keys and `router_version()` now follow the instruction and the `embed`/`gate` config; `enrich.dedup` rebuilds the stored `skillret` text with the body (via `catalog_bodies`). The reviewer's non-blocking notes that were acted on: report header now has `tei_reranker_tag` and `git_sha`; reports no longer crash on a missing `data/reports`; `tune` and `ranking --fusion score` no longer rewrite config. The final review of the whole branch is in the last section.

## REA (read-only, static)

- `.scratch/feature-landscape/rea-claude-code-hooks.md`: Claude Code 2.1.306 accepts `type: "http"` hooks (POST, no redirects, no unix socket); a plain-text 2xx body is rejected as non-JSON and adds no context; `additionalContext` is capped at 10,000 characters (larger text is persisted to disk with a 2,000-char preview). Row 8 is safe on 2.1.306 only with a JSON reply from `/v1/hook/prompt` and a TCP URL (`http://127.0.0.1:18310/...`). Never run live.
- `.scratch/feature-landscape/rea-claude-mem-diff.md`: claude-mem 15.2.1 → 15.3.0 has no breaking change for `src/ctc/graph/claudemem.py` or the m7 port (routes +4, observation schema and observer prompt identical, hook events identical); the note lists three pre-existing defects in our client found against the live 15.2.1 worker (the worker clamps `limit` to 100 so `limit=200` returns 100; `TYPES` in `claudemem.py` drops the `change` type, 34 of the newest 100 observations, and the security types; the worker port is derived from the uid). None is touched by this feature; they are a candidate fix for m7.
- REA's `trace_*` tools had no feature seed to trace in a 290 MB binary; searching strings and carving the JS modules worked. The carve (52 MB of Anthropic's bundle) sits in the session scratchpad `m8/rea-dl/`; delete it when done.

## Not verified / not done (be explicit)

- The Lua limiter on a real Redis: no scratch Redis was started (starting a container needs your yes). Run `tests/test_rate_limit.py` with `CTC_REDIS_URL` pointing at a throwaway Redis 8 (`docker run -d --rm --name ctc-scratch-redis -p 127.0.0.1:18395:6379 redis:8.2`).
- Own-transcript rows (`data/processed/own-eval.jsonl`) are absent from this checkout, so the in-domain check of the text flip, `run` and `memory_eval` were not run. The 2026-10-22 Decision makes SkillRet and MetaTool the gate; H1 rows remain the secondary check.
- Body cap: 8,000 chars truncates 2,432 of 6,006 test bodies; the 2,000 and uncapped caps were not measured (the `_sk` schema holds the 8,000 index).
- Live deploy: nothing was re-embedded and the daemon was not restarted. After merging, `ctc index` (or the daemon's startup index) re-embeds every capability with the `skillret` text, and cached bundles built under the old settings are invalidated by the new `router_version`.
- Graph hook: `ctc graph extract` sent 40 of 69 changed chunks (29 left for the next run) and logged several unparsable replies (CLAUDE.md and the n8n-parity docs among them); `ctc graph build` then succeeded (612 extracted, 886 inferred links; 85% of tasks linked). The `after_implement` review hook (`ctc graph confirm` writes to Supabase) was **not** run: it needs your yes.
- Deferred rows 6 (SKILLRET-Reranker sidecar: rerank still hurts with the new text, so it is the natural next lever), 8 (native http hook) and 9 (usage arm) have their triggers in `spec.md`.
- `THIRD_PARTY_NOTICES.md` links the Apache-2.0 license rather than bundling its text, and `cache.py` carries the SPDX line but not upstream's copyright line (reviewer nit; one line each to add).

## Reproduce

```bash
export CTC_DATABASE_URL="$(grep -E '^# dev stand-in' .env | sed -E 's/^.*CTC_DATABASE_URL=//')"   # scratch ctc-dev-pg, never Supabase
uv run python -m evaluation.retrieval_eval index-skillret --text skillret --body-chars 8000
uv run python -W ignore -m evaluation.retrieval_eval ablate --split test --variant cur=text:current,kw:0.25,rw:1 --variant sk=text:skillret,body:8000,kw:0,rw:0
uv run python -W ignore -m evaluation.retrieval_eval tune --text skillret --body-chars 8000
```
