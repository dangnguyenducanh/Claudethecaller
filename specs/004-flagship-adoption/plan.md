# Implementation Plan: Flagship-repo adoption (m8)

**Branch**: none yet (Spec Kit id `004-flagship-adoption`; the owner picks the branch at commit time; PR into `staging`) | **Date**: 2026-10-27 | **Spec**: [spec.md](spec.md)

**Input**: [spec.md](spec.md) (5 stories, FR-001–FR-010, SC-001–SC-005) and the source note [.scratch/feature-landscape/research.md](../../.scratch/feature-landscape/research.md) (rows 1–5, 7, 10 of "Adopt first"). Research: [research.md](research.md).

## Summary

Seven small changes, each behind a config knob that defaults to today's behaviour, each judged by the existing SkillRet/MetaTool eval before any default moves: (1) a `skillret` embedding-text mode and query instruction, (2) score fusion beside RRF, (3) a calibrated abstain gate and a margin baseline, (4) paired significance tests in the eval report, (7) `raw_scores` from TEI with the sigmoid applied client-side so nothing downstream changes scale, (10) a sliding-window Lua rate limiter. No new runtime dependency (scikit-learn and redis are installed; `ranx` stays a dev-only dependency used by `evaluation/`). Nothing is cloned into the repo; two reading clones live in `~/ref/`.

## Technical Context

**Language/Version**: Python ≥ 3.12 (uv). No dashboard work.

**Primary Dependencies**: existing only: httpx (TEI), numpy, scikit-learn (`LogisticRegression`, `IsotonicRegression`, already used by `retrieval/gate.py`), `redis[hiredis]` (Lua via `register_script`), ranx (dev). External services unchanged: TEI embedder `:18300` and reranker `:18301` (pinned `89-1.8.2`), Redis `:18303`.

**Storage**: Supabase Postgres unchanged (no schema change). Scratch schemas `ctc_skillret`, `ctc_skillret_train` hold ablation vectors. New files: `THIRD_PARTY_NOTICES.md` (repo root), `models/` joblib for a chosen calibrated gate (gitignored, as today). No Redis data model change except key `rl:{user}` becomes a sorted set ([contracts/knobs-and-eval.md](contracts/knobs-and-eval.md)).

**Testing**: pytest (`uv run pytest -q tests`), ruff, `scripts/check.sh`; the eval modules are the judges (`uv run python -m evaluation.retrieval_eval …`). DB/Redis self-checks only against scratch services named in the shell env (as `check.sh` already does).

**Target Platform**: Linux host (this GPU box); shared mode only for the limiter.

**Project Type**: Python service + CLI + eval harness (single repo).

**Performance Goals**: unchanged budgets (≤ 10 ms L1, ≤ 15 ms L2, ≤ 150 ms cold; hook ≤ 150 ms). The limiter adds one Lua call in place of one pipeline of two commands, same 20 ms timeout.

**Constraints**: GPU ≤ 7 GB (a longer embedding text must not push TEI past it: batch size and body cap are config); hooks fail open; Redis cache-only; no write to the live Supabase index or the real `~/.claude` without the owner's yes; copied code only under FR-009.

**Scale/Scope**: 7 tickets (M8-1 … M8-7) in 3 waves, ≈ 300–450 changed lines in `src/` and ≈ 250 in `evaluation/` and `tests/`. Touched today: `indexer.py` (texts L16), `embedder.py` (QUERY_INSTRUCTION L12), `reranker.py` (score L25), `hybrid.py` (search L61-L127), `gate.py`, `cache.py` (hit_rate L272), `app.py` (L137), `retrieval_eval.py`, `loaders.py` (skillret L33), `config/retrieval.yaml`.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is the unfilled template, so the gates come from `CLAUDE.md` and `PLAN.md` "Constraints" (same as `002`):

| Gate | Status |
|---|---|
| Stay in the step's scope; one branch per step; Conventional Commits; PR into `staging` | PASS: branch chosen by the owner at commit time; one commit per ticket |
| Shortest working solution; stdlib + chosen deps; no one-implementation abstractions; `ponytail:` on corner-cuts | PASS: no new dependency; calibrator uses scikit-learn instead of lifting 109 lines; knobs are plain config keys |
| Built from scratch; references only, never dependencies | PASS: nothing from ratel, metamcp or the MCPGateways is copied; the only copied lines are one ~20-line Lua script from an Apache-2.0 repo, with a NOTICE entry (R6) |
| Hook suggests, never blocks; fail-open; ≤ 150 ms | PASS: limiter keeps the 20 ms timeout and fails open |
| Redis cache-only; Supabase single truth | PASS: the sorted-set key has a TTL and is rebuildable by waiting a minute |
| Models local, ≤ 7 GB GPU | WATCH: longer embedding text; mitigated by `skillret_body_chars` and the TEI batch cap, measured in M8-1 |
| Never write real `~/.claude` before the owner's yes | PASS: no install change in this feature (row 8 deferred) |
| Propose first; Supabase writes and daemon restarts need approval | PASS: ablations use scratch schemas; flipping the live text mode (re-embed) and restarting the daemon are separate owner-approved steps |
| `scripts/check.sh` green before push | PASS: each ticket ends with it |

Post-design re-check (after Phase 1): unchanged, PASS; the only WATCH item is GPU memory under longer texts, which has a measurement task.

## Project Structure

### Documentation (this feature)

```text
specs/004-flagship-adoption/
├── spec.md                      # stories, FR, SC
├── plan.md                      # this file
├── research.md                  # Phase 0: decision per Adopt-first row
├── data-model.md                # Phase 1: config keys, eval record, notice entry
├── quickstart.md                # Phase 1: runnable validation
├── contracts/
│   └── knobs-and-eval.md        # config schema, eval report fields, Redis key
└── tasks.md                     # Phase 2 (/speckit-tasks, not created here)
```

### Source Code (repository root)

```text
src/ctc/
├── ingestion/indexer.py         # texts(cap, mode): current | skillret            (M8-1)
├── embedding/embedder.py        # QUERY_INSTRUCTION -> selectable instruction     (M8-1)
├── reranking/reranker.py        # raw_scores true, sigmoid client-side, logit kept (M8-2)
├── retrieval/hybrid.py          # ranking.fusion rrf|score, stages["fused"]      (M8-3)
├── retrieval/gate.py            # candidate gates: margin, platt, isotonic        (M8-5)
└── storage/cache.py             # hit_rate -> sliding-window Lua                  (M8-7)
evaluation/
├── retrieval_eval.py            # --text/--fusion flags, ranx.compare, gate sweep (M8-1,4,6)
└── loaders.py                   # skillret(): body field + text mode              (M8-1)
config/retrieval.yaml            # new knobs, defaults = today                     (M8-1,3,5)
THIRD_PARTY_NOTICES.md           # one entry: the Lua script lifted in M8-7 (R6)  (M8-7)
tests/
├── test_text_mode.py            # M8-1
├── test_reranker.py             # M8-2 (sigmoid parity, logit kept)
├── test_fusion.py               # M8-3
├── test_gate_candidates.py      # M8-5
└── test_rate_limit.py           # M8-7 (scratch Redis only)
```

**Structure Decision**: single project, edits in place; no new package. Each ticket adds one knob and one test, and leaves the default unchanged until a measured decision (M8-6) moves it.

## Build order (tickets and waves)

| Wave | Ticket | Rows | Touches | Done when |
|---|---|---|---|---|
| 1 | M8-1 text mode + instruction + SkillRet ablation harness | 1 | `indexer.py`, `embedder.py`, `loaders.py`, `retrieval_eval.py`, `retrieval.yaml` | ablation report: current vs skillret, dev+test, p-values |
| 1 | M8-2 `raw_scores` + sigmoid client-side + `rerank_logit` | 7 | `reranker.py`, `hybrid.py` | scores identical to today within 1e-6; logit in stages |
| 1 | M8-4 significance in the eval report | 5 | `retrieval_eval.py` | `ranking-test` prints p-values |
| 2 | M8-3 score fusion beside RRF | 2 | `hybrid.py`, `retrieval.yaml` | `fusion: rrf` byte-identical; `score` sweep on dev |
| 2 | M8-7 sliding-window limiter | 10 | `cache.py`, `app.py`, `test_rate_limit.py` | burst test passes; Redis-down admits |
| 3 | M8-5 gate candidates (margin, Platt, isotonic) | 3, 4 | `gate.py`, `retrieval_eval.py` | K2 prints suggest-rate and false-trigger per candidate |
| 3 | M8-6 decide: flip defaults or not, write Decisions | all | `retrieval.yaml`, `CLAUDE.md` | each flip backed by numbers; losers stay off |

M8-1, M8-2 and M8-4 touch disjoint files, so they can run as parallel builders; M8-3 follows M8-2 (same `hybrid.py`); M8-5 needs M8-3 and M8-4.

## Complexity Tracking

No constitution violations. Two deliberate simplifications, both marked `ponytail:` when coded: the body cap is a single character count (a token-aware cut is the upgrade if TEI truncation shows in the ablation), and the limiter uses one sorted set per user (a counter-bucket approximation is the upgrade if Redis memory ever matters).
