#!/usr/bin/env bash
# CD to this host: fast-forward the current branch, rebuild, restart the daemon (serves the built dashboard).
set -euo pipefail
cd "$(dirname "$0")/.."

git pull --ff-only
uv sync --frozen
pnpm -C dashboard install --frozen-lockfile
pnpm -C dashboard build
export CTC_DASHBOARD_DIST="$PWD/dashboard/dist"
uv run ctc daemon stop || true
uv run ctc daemon start
