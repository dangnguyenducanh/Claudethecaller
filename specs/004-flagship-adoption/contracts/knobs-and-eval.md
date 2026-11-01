# Contract: config knobs, eval CLI, report fields, Redis key

This feature adds no HTTP route, MCP tool or hook field. Its interfaces are the config file, the eval CLI, the report files and one Redis key. Existing behaviour is the default of every knob (see [data-model.md](../data-model.md)).

## Config (`config/retrieval.yaml`)

```yaml
embed: {text: current, instruction: coding, skillret_body_chars: 8000}
ranking: {keyword_rrf_weight: 0.25, rerank_weight: 1, fusion: rrf, score_w: 0.7}
gate: {kind: off, margin_ratio: 1.5, min_p: 0.5}
```

- Unknown values for `embed.text`, `embed.instruction`, `ranking.fusion` or `gate.kind` raise at config load (fail fast), not at query time.
- `ranking.fusion: rrf` MUST reproduce today's results exactly (SC-002).

## Eval CLI (additions to `evaluation/retrieval_eval.py`)

| Command | New behaviour |
|---|---|
| `index-skillret [--text current\|skillret] [--body-chars N]` | indexes into `ctc_skillret` / `ctc_skillret_train`; writes a `text_mode` field into the report; never touches the live schema |
| `ranking [--fusion rrf\|score]` | DEV ONLY sweep; for `score` sweeps `score_w` in 0.5–0.9 |
| `ranking-test [n]` | TEST, report only; prints metric delta and p-values for dense vs configured vs old `{1, 1}` |
| `tune` | gate candidates `off`, `margin`, `platt`, `isotonic`, `lr`; MetaTool negatives for false-trigger |
| `run [limit]` | unchanged flags; report gains the comparison table with p-values |

## Report (`data/reports/*.json`, `report-<date>.md`)

Each comparison row: `{"a": str, "b": str, "metric": "ndcg@10"|"recall@5", "split": "dev"|"test", "delta": float, "p": float, "sig_0.01": bool, "sig_0.05": bool}`. The header block records `text_mode`, `instruction`, `body_chars`, `fusion`, `score_w`, `tei_reranker_tag`, `git_sha`.

Gate section: per candidate `{"kind", "ece_before", "ece_after", "threshold", "false_trigger_dev", "suggest_rate_test", "false_trigger_test"}`.

## Rerank score contract

`Reranker.score(query, docs) -> list[float]` keeps returning values in (0, 1) (sigmoid of the logit). New: `Reranker.score_with_logits(query, docs) -> list[tuple[float, float]]` returns `(sigmoid, logit)` pairs; `hybrid.search` uses it and stores `stages["rerank"]` (sigmoid) and `stages["rerank_logit"]`.

## Redis key

- `rl:{user}` — sorted set, score = ms from Redis `TIME`, member = `<ms>-<seq>`, TTL 60 s. One Lua call: remove members older than 60 s, add this request, set TTL, return the cardinality. Any Redis error or a call past 20 ms returns `0` (fail open), as today.
