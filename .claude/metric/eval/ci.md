# Eval: CI checks on this machine

What it measures: that the checks CI runs also pass here: `pnpm -r lint && pnpm -r typecheck && pnpm -r test`, inside `bash scripts/check.sh`, which also runs
`uv sync --frozen`, ruff, pytest, the Python store and cache self-checks (against the scratch Postgres and Redis named in the environment), the dashboard install
and build, and the secret scan when `gitleaks` is installed.

## Run

```
CTC_DATABASE_URL=postgres://postgres:...@127.0.0.1:18304/postgres CTC_REDIS_URL=redis://127.0.0.1:18395/0 bash scripts/check.sh
```

`node .claude/metric/eval/switch/run.mjs --only ci` runs it with that environment and rewrites the table.

## Results

<!-- results:start -->
| command | exit | passed tests | ms | date |
| --- | ---: | ---: | ---: | --- |
| bash scripts/check.sh | 0 | 1113 | 203302 | 2026-10-31 |
<!-- results:end -->
