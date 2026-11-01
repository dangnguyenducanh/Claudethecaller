# Feature Specification: Flagship-repo adoption (m8)

**Feature Branch**: none yet (the owner picks it when committing; Spec Kit id `004-flagship-adoption`)

**Created**: 2026-10-27

**Status**: Draft

**Input**: User description: "Use `.scratch/feature-landscape/research.md` (flagship GitHub repos per feature, Adopt-first table, license classes, REA run sheet) as the input. Decide what to reuse or clone from those repos into our features, and plan it." Approved scope (2026-10-27): rows 1–5, 7 and 10 of "Adopt first"; rows 6, 8, 9 deferred; nothing cloned into this repo; code from `references-only` repos is never copied.

## Context

The research note found seven small, evidence-backed changes where outside code or papers show a better way than ours, and three larger ones that need their own step. This feature turns the seven into measured experiments and, where the numbers justify it, config changes. It does not change what the product does; it changes how well and how safely it ranks, abstains and rate-limits.

Why these seven (all traced to the note, rows in "Adopt first"):

- The embedder `SKILLRET-Embedding-0.6B` scores 81.12 NDCG@10 in its authors' harness, which embeds `name | description | skill_md` with its own query instruction; our dense-only run scores 0.787 and embeds a different text (row 1).
- Keyword RRF hurts on tool corpora; score fusion `(1-w)·lexical + w·cos` beats it in ratel's own bench, and a bounded score is the missing absolute signal for the abstain gate that scored CV AUC 0.55 (rows 2, 3, 4).
- `reranker.py` never sends `raw_scores`, so TEI squashes every pair through a sigmoid (row 7; confirmed in TEI v1.8.2 `core/src/infer.rs` L458-L478 and `router/src/http/server.rs` L357).
- "Rerank +0.025 on dev, −0.014 on test" has no significance test (row 5).
- The shared-mode rate limit is a fixed-window `INCR` that allows a 2× burst at the minute boundary (row 10).

## Clarifications

### Session 2026-10-27 (owner approval of the proposal)

- Q: Which rows are in scope? → A: 1, 2, 3, 4, 5, 7, 10. Rows 6 (SKILLRET-Reranker sidecar), 8 (native `http` hook) and 9 (usage arm) stay deferred with a trigger each (see Deferred).
- Q: May code be cloned or copied? → A: Nothing is cloned into this repo. Reading clones go to `~/ref/` outside the repo. Copied lines are allowed only from `copy-safe` repos that are not on the references-only list (ratel, metamcp, both MCPGateways), with an SPDX header, a pinned permalink and a `THIRD_PARTY_NOTICES.md` entry. Everything else is re-implemented.
- Q: What gates the constitution check? → A: `.specify/memory/constitution.md` is still the unfilled template, so `CLAUDE.md` Constraints and `PLAN.md` Constraints are the gates (same as `002`).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Embed the text the embedder was trained on (Priority: P1) 🎯 MVP

The owner can run the SkillRet benchmark with the capability text built the SkillRet way (name, description and full skill body, and the SkillRet query instruction) next to the current text, and read both NDCG@10 and Recall@5 plus a paired significance test, without touching the live index.

**Why this priority**: it is the cheapest lever on a 2.4-point gap and the answer decides whether the live index text changes.

**Independent Test**: run the ablation on the `ctc_skillret` scratch schema; the report shows current vs `skillret` text, dev and test, with p-values.

**Acceptance Scenarios**:

1. **Given** the SkillRet test corpus, **When** the ablation runs with `text=skillret`, **Then** the report lists NDCG@10 and Recall@5 for dense-only and the configured hybrid, for both text modes, on dev and test.
2. **Given** the ablation shows dev and test both improve (paired test, p < 0.05 on test), **When** the owner flips the config knob, **Then** the live index re-embeds on the next `ctc index` because `text_hash` includes the text, and no other behaviour changes.
3. **Given** a capability with no body, **When** its text is built, **Then** it falls back to name and description and the build does not fail.

---

### User Story 2 - Fuse on scores, with raw rerank logits available (Priority: P1)

The owner can choose rank fusion (today) or score fusion for the candidate pool and final order, and every consumer of the rerank score keeps its present meaning while the raw logit is also recorded.

**Why this priority**: it addresses "keyword RRF hurts" and produces the bounded score US3 needs.

**Independent Test**: sweep the fusion weight on SkillRet dev only, then report test once; the two fusion modes differ only by the config knob.

**Acceptance Scenarios**:

1. **Given** `ranking.fusion: rrf`, **When** a search runs, **Then** the result is identical to today's (same top-k, same stage values).
2. **Given** `ranking.fusion: score`, **When** a search runs, **Then** hits carry a fused score in [0, 1] in `stages["fused"]`, and the order uses it.
3. **Given** TEI is asked with `raw_scores: true`, **When** `agent_min_rerank` (0.5) is evaluated, **Then** it is applied to the sigmoid of the logit, so agent attachment is unchanged.

---

### User Story 3 - A calibrated abstain decision (Priority: P1)

The owner can re-run K2 with a calibrated gate (Platt or isotonic over the fused score, plus a "top1 ≥ 1.5 × top2" margin rule as a no-model baseline) and see suggest-rate and false-trigger rate on SkillRet and MetaTool before choosing whether abstain turns on.

**Why this priority**: abstain is off today because the trained gate had no signal; a bounded score and a calibrator are the cheapest second attempt.

**Independent Test**: the K2 run prints, per candidate gate, the suggest rate on SkillRet test prompts and the false-trigger rate on MetaTool negatives at the chosen threshold.

**Acceptance Scenarios**:

1. **Given** the dev split, **When** K2 fits the calibrator, **Then** it reports ECE before and after and the threshold meeting false-trigger ≤ 10% on MetaTool dev.
2. **Given** no candidate gate beats "abstain off" on both rates on test, **When** K2 finishes, **Then** `abstain_below` and `gate_path` stay off and the reason is written to `CLAUDE.md` Decisions.
3. **Given** a winning gate, **When** the owner turns it on, **Then** hooks stay fail-open and p95 hook latency is unchanged.

---

### User Story 4 - Every ranking claim comes with a significance test (Priority: P1)

Every comparison the eval reports (modes, text, fusion, gate) shows a paired test result, and fusion weights are tuned with `ranx.optimize_fusion` on the train split only.

**Why this priority**: stops the dev/test reversal from recurring and is a few lines in a file that already imports ranx.

**Independent Test**: `ranking-test` prints a p-value for dense vs configured ranking and vs old `{1, 1}`.

**Acceptance Scenarios**:

1. **Given** two runs over the same qrels, **When** the report is built, **Then** it lists the metric difference and whether it is significant at p < 0.01 (ranx default) and p < 0.05.

---

### User Story 5 - Rate limits without the boundary burst (Priority: P2)

In shared mode, an API key cannot exceed its per-minute limit in any 60-second window, and Redis trouble still fails open within the 20 ms timeout.

**Why this priority**: shared mode is the one feature where a burst has a cost; local mode is unaffected.

**Independent Test**: against the scratch Redis, send `limit` requests at second 59 and `limit` at second 61 of the same wall-clock minute; today both pass, after the change the second batch is refused.

**Acceptance Scenarios**:

1. **Given** a key at its limit within the last 60 s, **When** another request arrives, **Then** the API returns 429 and hooks return an empty 200.
2. **Given** Redis is down, **When** a request arrives, **Then** it is allowed and no error reaches the client.

### Edge Cases

- A skill body of 100 KB or more: the text mode needs a length cap or the embedder batch exceeds TEI limits; the cap is a config value and the eval reports results at the cap.
- Changing the text mode re-embeds every capability once (text hash includes model + text); on the live index this is a Supabase write and needs the owner's yes.
- Keyword arm returns nothing: score fusion falls back to the dense score alone.
- Calibrator given one class only (all correct, or all wrong): it refuses to fit and reports why instead of returning a constant.
- MetaTool and SkillRet prompts in other languages: abstain evaluation reports per-language counts, not only the pooled rate.
- Sliding window when the Redis clock and the worker clocks differ: the script uses Redis `TIME`, not the worker's clock.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The embedding text builder MUST support a `skillret` mode (`name | description | body`, body capped by a config length) beside the current mode; the live default stays the current mode until the owner flips it.
- **FR-002**: The query instruction MUST be selectable (`coding` today, `skillret` per SkillRet's `config.py`) and recorded in every eval report.
- **FR-003**: The ablation MUST run on the scratch schemas (`ctc_skillret`, `ctc_skillret_train`) and MUST NOT write to the live capability index.
- **FR-004**: `Reranker` MUST request `raw_scores: true` from TEI and return the sigmoid of each logit from `score()` so existing consumers (`agent_min_rerank`, `abstain_below`, bundle reasons) see the same scale; the logit MUST be kept in `stages["rerank_logit"]`.
- **FR-005**: `ranking.fusion` MUST accept `rrf` (default, today's behaviour byte for byte) or `score`; `score` MUST combine a normalised keyword score and the cosine as `(1 − w)·lexical + w·cos` with `w` in config.
- **FR-006**: K2 MUST support a calibrated gate (Platt and isotonic via scikit-learn, with ECE) and a margin-rule baseline, and MUST report suggest-rate (SkillRet) and false-trigger rate (MetaTool negatives) per candidate.
- **FR-007**: The eval report MUST include a paired significance test for each comparison it prints, and fusion weights MUST be tuned on train/dev only, never on the test split.
- **FR-008**: The rate limiter MUST be a sliding window in one atomic Redis call keyed by user, using Redis `TIME`, with the existing 20 ms timeout and fail-open behaviour.
- **FR-009**: Any copied lines MUST carry an SPDX identifier, the pinned source permalink and an entry in `THIRD_PARTY_NOTICES.md`; no line may be copied from a references-only, pattern-only or no-go repo.
- **FR-010**: Every change that alters a default (text mode, fusion, gate, limiter) MUST add a dated line to `CLAUDE.md` Decisions with the numbers that justified it; changes that lose on test stay off.

### Key Entities

- **Text mode**: how a capability becomes embedding text (`current`, `skillret`) plus the query instruction; part of `text_hash`.
- **Fusion mode**: `rrf` or `score`, with its weights, inside the `ranking` config.
- **Gate candidate**: one abstain rule (`off`, `margin`, `platt`, `isotonic`, the old LR) with its fitted parameters and its dev/test rates.
- **Eval record**: one report row per comparison with metric, delta and p-value.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The ablation report shows dev and test NDCG@10 and Recall@5 for both text modes with p-values; a flip happens only if test does not regress and dev improves.
- **SC-002**: With `ranking.fusion: rrf` the full test suite and the SkillRet dense/hybrid numbers are unchanged from the 2026-10-21 baseline (dense 0.787, hybrid+rerank 0.771 NDCG@10 on test).
- **SC-003**: Abstain turns on only if, on test, it suggests on ≥ 50% of SkillRet prompts at ≤ 10% false-trigger on MetaTool negatives (the 2026-10-21 gate managed 7–13% at that false-trigger rate); otherwise it stays off with a recorded reason.
- **SC-004**: In the burst test no window of 60 s admits more than `limit` requests; Redis-down requests are admitted.
- **SC-005**: Hook p95 stays within PLAN's budgets (≤ 10 ms L1, ≤ 15 ms L2, ≤ 150 ms cold) and `scripts/check.sh` is green.

## Assumptions

- The SkillRet harness numbers (81.12) used a different environment from ours; closing part of the gap is a hypothesis, which is why this is an ablation and not a switch.
- `ranx` is a dev dependency and stays one: `compare` and `optimize_fusion` run only in `evaluation/`.
- TEI 1.8.2 (our pin) honours `raw_scores` on `/rerank` (checked in the v1.8.2 tag, 2026-10-27).
- SC-003's 50% suggest-rate bar is my default for "usable"; the owner may change it before K2 is re-run.
- The live Supabase index is written only with the owner's explicit yes, so all measurement uses scratch schemas.

## Deferred (own steps, not in this feature)

| Row | What | Trigger to plan it |
|---|---|---|
| 6 | SKILLRET-Reranker-0.6B yes/no scorer on a transformers/vLLM sidecar (TEI cannot serve it) | US1 and US2 done and rerank still loses on test |
| 8 | Native `type: "http"` hook with a JSON `additionalContext` reply | owner approves changing `ctc install` output (affects real `~/.claude`) |
| 9 | Bounded usage arm from `followed` history | after H1 labels exist to judge it |
