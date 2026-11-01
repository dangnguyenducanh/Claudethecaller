# Quickstart: validating the flagship-adoption changes

Prerequisites: the `docker compose` stack up (TEI embedder `:18300`, reranker `:18301`; check the embedder log shows CUDA, not CPU, per the 2026-10-21 Decision), `uv sync`, `CTC_DATABASE_URL` pointing at a scratch Postgres (not the Supabase project) for anything that writes, and a scratch Redis in `CTC_REDIS_URL` for the limiter test (db 0, see `scripts/check.sh`). The flags below are the planned interface in [contracts/knobs-and-eval.md](contracts/knobs-and-eval.md); until a ticket lands they do not exist.

## 1. Baseline unchanged (SC-002), after every ticket

```bash
scripts/check.sh
uv run python -m evaluation.retrieval_eval ranking-test 500
```

Expect: `check.sh: all ok`; with default config the dense / configured numbers match the 2026-10-21 baseline (SkillRet test dense 0.787, hybrid+rerank 0.771 NDCG@10; the `500` limit gives a smaller sample, compare against a baseline run made with the same limit before the first ticket).

## 2. Text-mode ablation (US1, M8-1)

```bash
uv run python -m evaluation.retrieval_eval index-skillret --text current
uv run python -m evaluation.retrieval_eval run
uv run python -m evaluation.retrieval_eval index-skillret --text skillret --body-chars 8000
uv run python -m evaluation.retrieval_eval run
nvidia-smi --query-compute-apps=pid,used_memory --format=csv
```

Expect: two reports with dev and test NDCG@10 / Recall@5 and p-values; project GPU total ≤ 7 GB; the live `ctc` schema row counts unchanged (`uv run ctc status`).

## 3. Rerank scale preserved (US2, M8-2)

```bash
uv run python -m pytest -q tests/test_reranker.py
uv run python scripts/check_models.py
```

Expect: the sigmoid values equal the old ones within 1e-6 on a fixed (query, docs) pair; `stages["rerank_logit"]` present and `sigmoid(logit) == stages["rerank"]`.

## 4. Fusion sweep and test (US2, M8-3, US4, M8-4)

```bash
uv run python -m evaluation.retrieval_eval ranking --fusion score     # DEV ONLY
uv run python -m evaluation.retrieval_eval ranking-test
```

Expect: `fusion: rrf` output identical to step 1; the `score` sweep lists NDCG@10 per `score_w`; `ranking-test` prints dense vs configured vs old with p-values.

## 5. Gate candidates (US3, M8-5)

```bash
uv run python -m evaluation.retrieval_eval tune
```

Expect: per candidate ECE, threshold, false-trigger (MetaTool dev), then suggest-rate and false-trigger on test; abstain stays off unless a candidate meets SC-003.

## 6. Rate limiter burst (US5, M8-7)

```bash
uv run python -m pytest -q tests/test_rate_limit.py
```

Expect: `limit` requests at t=59 s and `limit` more at t=61 s of one wall minute → the second batch is refused; with Redis stopped (`docker stop` the scratch container) requests are admitted.
