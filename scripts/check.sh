#!/usr/bin/env bash
# Run before pushing: the CI checks (.github/workflows/ci.yml) on this machine.
# DB self-checks write and drop schemas/keys, so they only run against scratch services named in the shell env:
#   CTC_DATABASE_URL (any non-Supabase Postgres + pgvector), CTC_REDIS_URL (db 0 of a scratch Redis 8, not the daemon's
#   :18303: the query engine only indexes db 0), e.g. docker run -d --rm --name ctc-scratch-redis -p 127.0.0.1:18395:6379 redis:8.2
set -euo pipefail
cd "$(dirname "$0")/.."

uv sync --frozen
uv run ruff check src evaluation scripts tests
uv run pytest -q tests
uv run python -c "import ctc.server.app, ctc.cli"
uv run python -m ctc.decision.bundle  # needs no services

case "${CTC_DATABASE_URL:-}" in
  "" | *supabase*) echo "skip store self-check: CTC_DATABASE_URL unset or Supabase" ;;
  *) uv run python -m ctc.storage.store ;;
esac
if [ -n "${CTC_REDIS_URL:-}" ]; then uv run python -m ctc.storage.cache; else echo "skip cache self-check: CTC_REDIS_URL unset"; fi

pnpm -C dashboard install --frozen-lockfile
pnpm -C dashboard build

if command -v gitleaks >/dev/null; then gitleaks git --no-banner .; else echo "skip secret scan: gitleaks not installed (CI runs it)"; fi
echo "check.sh: all ok"
