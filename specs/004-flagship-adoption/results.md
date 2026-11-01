# Results: Flagship-repo adoption (m8)

Run 2026-10-27 on branch `m8-flagship-adoption`. Every measurement used the scratch Postgres `ctc-dev-pg` (`127.0.0.1:18304/ctc`, schemas `ctc_skillret`, `ctc_skillret_train`, and the new `_sk` pair); the Supabase index was not written by any measurement. The test split was run once. Raw reports: `data/reports/m8-*.json`, `ablate-*.json`, `gate-2026-10-27.json` (gitignored).

## What changed (and what each default is now)

| Ticket | Change | Default after m8 | Evidence |
|---|---|---|---|
| M8-1 | `embed.text` (`current` \| `skillret`) and `embed.instruction` (`coding` \| `skillret`); `catalog_bodies()` fetches bodies 200 ids per statement | **`skillret` / `skillret`** (flipped) | dev and test below |
| M8-2 | `Reranker` asks TEI for `raw_scores`, applies the sigmoid itself; `stages["rerank_logit"]`; `ranking.rerank_by` | `sigmoid` (unchanged) | live parity check: `sigmoid(raw)` matches the old score to between 3e-9 and 1.5e-4 depending on the call (TEI fp16 is not deterministic between calls, 4 pairs); dev: `by: logit` no better (p 0.88 / 0.19) |
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

`current` → `skillret` (dense): +0.178, p = 2.6e-43. Best weights per text on a 24-variant sweep: `current` keeps `{0.25, 1}`; `skillret` prefers `{0, 0}` over `{0.25, 1}` by +0.047 NDCG@10, p = 1.6e-11.

Test (4,392 queries, run once):

| Variant | dense NDCG@10 | full NDCG@10 | full Recall@1 | full Recall@5 | full Recall@10 |
|---|---|---|---|---|---|
| `current`, `{0.25, 1}` (shipped before) | 0.7868 | 0.7733 | 0.5260 | 0.7919 | 0.8679 |
| `skillret`, `{0.25, 1}` | 0.8116 | 0.7837 | 0.5323 | 0.7998 | 0.8810 |
| `skillret`, `{0, 0}` (chosen) | 0.8114 | **0.8114** | **0.5691** | **0.8245** | 0.8764 |

Paired: chosen vs shipped-before, NDCG@10 +0.0381 (p = 6.6e-29), Recall@5 +0.0325 (p = 1.9e-14). Dense-only `skillret` (0.8116) equals SkillRet's published 81.12. Flip rule (dev improves, test does not regress): **met**, so `config/retrieval.yaml` now has `embed: {text: skillret, instruction: skillret}` and `ranking {0, 0}`. Text and instruction were measured only as a pair (the CLI couples them), so the gain is not split between the two.

GPU: peak 3.8 GiB for this project's containers during the 16k-skill `skillret` indexing (budget 7 GiB; guard script sampled every 15 s, never over). Indexing took ~10 minutes for 6,006 + 10,123 skills.

### Body cap (`embed.skillret_body_chars`), `skillret` text, dense order, run 2026-10-27 after the main ablation

| Cap | dev NDCG@10 (500 q) | dev Recall@5 | test NDCG@10 (4,392 q) | test Recall@5 | test Recall@1 |
|---|---|---|---|---|---|
| 2,000 | 0.7188 | 0.6953 | 0.8112 | 0.8229 | 0.5647 |
| **8,000 (shipped)** | 0.7574 | 0.7133 | 0.8115 | 0.8243 | 0.5692 |
| 24,000 (covers 95.5% of test bodies in full) | 0.7608 | 0.7163 | 0.8121 | 0.8243 | 0.5702 |

Paired: on dev 2,000 loses to 8,000 by 0.039 NDCG@10 (p = 1.7e-10) and 24,000 does not beat 8,000 (+0.003, p = 0.16); on test no pair differs (p ≥ 0.5). Dev and test disagree about 2,000, and nothing supports a larger cap, so **8,000 stays**. GPU peak for this project 3.8 GiB (24,000-char indexing). Reports: `data/reports/m8-caps-dev.json`, `m8-caps-test.json`; each non-default cap has its own scratch schema `ctc_skillret[_train]_sk<N>`.

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

`hit_rate` is one Lua call over a sorted set; it counts blocked attempts too, so a client that keeps sending more than the limit per minute stays blocked until it backs off (no Retry-After). Tests: the fail-open case runs (closed port, no server); the sliding-window case needs a scratch Redis. It **passes on a real Redis 8.2** (`tests/test_rate_limit.py`, 2 passed, run 2026-10-27 against a throwaway `redis:8.2` container on `:18395`, since stopped); before that a builder had run the same script on fakeredis + lupa (Lua 5.4).

## Review (CLAUDE.md /2: one reviewer, critical/high only) and fixes

Two high findings, both on the live-flip path, both fixed (`ce28e91`): `emb:` keys and `router_version()` now follow the instruction and the `embed`/`gate` config; `enrich.dedup` rebuilds the stored `skillret` text with the body (via `catalog_bodies`). The reviewer's non-blocking notes that were acted on: report header now has `tei_reranker_tag` and `git_sha`; reports no longer crash on a missing `data/reports`; `tune` and `ranking --fusion score` no longer rewrite config. The final review of the whole branch is in the last section.

## Final review (one reviewer, read-only): ship, no critical or high defect

Every number in this file and in the two CLAUDE.md Decisions lines was re-derived from `data/reports/*.json` and matched (one cosmetic p-value, corrected above). Tests 97 passed / 13 skipped, ruff clean at review time. It rated nine items medium or low. Fixed in this branch: the name + description cap in `skillret` mode (4,000 chars; SkillRet's longest is 2,487, so no measured text changes) and the upstream copyright line and exact line range in `cache.py`. The rest are open and listed here so the flip is made with eyes open:

| # | Sev | Item | What to do |
|---|---|---|---|
| 1 | medium | `topic_shift_below: 0.55` (`config/retrieval.yaml`, `memory/session.py`) was set under the `coding` prefix. With the `skillret` prefix, same-intent cosines drop (171 same-gold SkillRet pairs: mean 0.655 → 0.513; share below 0.55: 23% → 54%), so follow-up prompts clear the session vector about twice as often | re-tune (about 0.40 by this proxy) on real turns once H1 data exists; session-blend benefit is unmeasured |
| 2 | medium | `models/difficulty.joblib` (A2) was trained on `coding`-prefix query vectors; `decide()` now feeds it `skillret` vectors (cosine between the two vectors of one prompt: 0.87). The file is not in this checkout, so impact is unmeasured | rerun `scripts/train_difficulty.py` after the flip |
| 3 | low | `ctc.ai.enrich --selfcheck` asserts `1 + len(triggers)` vectors per cap, which cannot hold under `skillret` (one vector per cap); not in CI | update the assertion or run the self-check with `embed.text: current` |
| 4 | low | `LocalStore` (no-DB mode, `storage/local.py`) still embeds `name: description` docs but queries with the `skillret` prefix | add body-aware docs there or pin it to the `coding` prefix |
| 5 | low | after a daemon restart the startup `index` job re-embeds the library; bundles computed in that window are semantic-cached for 24 h (`library_version` does not change on re-embed), and each insert batch marks vectors dirty so prompts in the window reload them | flush the `sem:`/`bundle:` Redis keys after the re-embed finishes (cache only, rebuildable; your yes); running `ctc.ai.enrich --dedup-only` before the re-index dissolves clusters, so index first |
| 6 | low | ~~`ablate` `body:N` reads the single `_sk` schema~~ **fixed**: a cap other than 8,000 now has its own `_sk<N>` schema. `ranking` (rrf write path) still drops `rerank_by` from the yaml line (the default fills it); the module docstring line 3 still says `index-skillret` writes `ctc_skillret` (true for `--text current`) | fix when next in that file |
| 7 | low | project vector cache is keyed by model, not instruction (cosine old vs new for this repo's profile 0.967) | negligible; refreshes when CLAUDE.md or the manifests change |

Not verified by the reviewer: the limiter Lua on a real Redis, live Supabase behaviour of the one-statement stale-vector delete (~6.3k rows) and of `dedup`'s large text parameter through the pooler, and the real re-embed time of the live library.

## REA (read-only, static)

- `.scratch/feature-landscape/rea-claude-code-hooks.md`: Claude Code 2.1.306 accepts `type: "http"` hooks (POST, no redirects, no unix socket); a plain-text 2xx body is rejected as non-JSON and adds no context; `additionalContext` is capped at 10,000 characters (larger text is persisted to disk with a 2,000-char preview). Row 8 is safe on 2.1.306 only with a JSON reply from `/v1/hook/prompt` and a TCP URL (`http://127.0.0.1:18310/...`). Never run live.
- `.scratch/feature-landscape/rea-claude-mem-diff.md`: claude-mem 15.2.1 → 15.3.0 has no breaking change for `src/ctc/graph/claudemem.py` or the m7 port (routes +4, observation schema and observer prompt identical, hook events identical); the note lists three pre-existing defects in our client found against the live 15.2.1 worker (the worker clamps `limit` to 100 so `limit=200` returns 100; `TYPES` in `claudemem.py` drops the `change` type, 34 of the newest 100 observations, and the security types; the worker port is derived from the uid). None is touched by this feature; they are a candidate fix for m7.
- REA's `trace_*` tools had no feature seed to trace in a 290 MB binary; searching strings and carving the JS modules worked. The carve (52 MB of Anthropic's bundle) sits in the session scratchpad `m8/rea-dl/`; delete it when done.

## Not verified / not done (be explicit)

- Own-transcript check: **not finished**. `data/processed/own-eval.jsonl` was absent, so I re-ran the K1 labeler (`python -m evaluation.label`, local Qwen2.5-3B on `llama-server`; 304 candidate prompts, 251 test). It was stopped at 71 labelled rows, so there is no `current` vs `skillret` result on your own prompts, and `run` and `memory_eval` were not run. The tooling is in: `index-own` (this machine's 699 capabilities, scanned like K1 does, indexed in both text modes into scratch schemas `ctc_own` and `ctc_own_sk`; A1 summaries read from the live index, read-only) and `ablate --on own --split dev|test`; `run` now reads that library. The labels are LLM-made and unchecked (H1 is yours). The 2026-10-22 Decision makes SkillRet and MetaTool the gate; H1 rows remain the secondary check.
- Live deploy: nothing was re-embedded and the daemon was not restarted. After merging, `ctc index` (or the daemon's startup index) re-embeds every capability with the `skillret` text, and cached bundles built under the old settings are invalidated by the new `router_version`.
- Graph hook: `ctc graph extract` sent 40 of 69 changed chunks (29 left for the next run) and logged several unparsable replies (CLAUDE.md and the n8n-parity docs among them); `ctc graph build` then succeeded (612 extracted, 886 inferred links; 85% of tasks linked). The `after_implement` review hook was run on request after ticking the finished tasks and rebuilding the graph: 30 inferred `implemented_in` links reviewed, 16 kept, 14 dropped (e.g. `build_index`, `rrf`, `Hit`, `LocalStore.candidates` were consumers or untouched code, not the implementation of their task). `ctc graph extract` was not re-run after the last doc edits.
- Deferred rows 6 (SKILLRET-Reranker sidecar: rerank still hurts with the new text, so it is the natural next lever), 8 (native http hook) and 9 (usage arm) have their triggers in `spec.md`.
- `THIRD_PARTY_NOTICES.md` links the Apache-2.0 license rather than bundling its text, and `cache.py` carries the SPDX line but not upstream's copyright line (reviewer nit; one line each to add).

## Reproduce

(Body caps: `index-skillret --text skillret --body-chars 2000|24000`, then `ablate --split dev|test --variant b2000=text:skillret,body:2000,kw:0,rw:0 --variant b8000=... --variant b24000=...`. Own library: `index-own --text current|skillret` with `CTC_LIVE_DATABASE_URL` set to the live URL for A1 summaries, then `ablate --on own --split test ...`.)

```bash
export CTC_DATABASE_URL="$(grep -E '^# dev stand-in' .env | sed -E 's/^.*CTC_DATABASE_URL=//')"   # scratch ctc-dev-pg, never Supabase
uv run python -m evaluation.retrieval_eval index-skillret --text skillret --body-chars 8000
uv run python -W ignore -m evaluation.retrieval_eval ablate --split test --variant cur=text:current,kw:0.25,rw:1 --variant sk=text:skillret,body:8000,kw:0,rw:0
uv run python -W ignore -m evaluation.retrieval_eval tune --text skillret --body-chars 8000
```
