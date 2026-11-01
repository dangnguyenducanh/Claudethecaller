# fixtures/py-baseline

Recorded by `evaluation/record_baselines.py` against the Python daemon.

## Known gaps

- `skillret.json` is not recorded. It needs `CTC_DATABASE_URL` for ctc-dev-pg and up to 2 h on the shared GPU. Until it is recorded there is no Python number for the `suggest.skills` comparison.
- `latency.json` is recorded. `agent/t5-1-suggest/OPEN.md` still says it was never recorded; that note is stale.

## graph.errors = 3

`graph.jsonl` rows g24, g29 and g30 have `is_error: true` on purpose. They probe the error paths:

- g24 `graph_path` with an unknown node (`no_such_symbol_zzz`)
- g29 `graph_affected` with an ambiguous name (`search` matches 2 nodes)
- g30 `graph_affected` with an unknown node (`no_such_symbol_zzz`)

The TypeScript port must return the same errors, so they stay in the baseline.
