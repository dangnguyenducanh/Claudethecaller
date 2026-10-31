#!/usr/bin/env bash
# Synthetic fixture for graph.ids: bash functions in both declaration styles.
set -euo pipefail

source ./lib/common.sh

log() { printf '%s\n' "$*" >&2; }

function build_all {
  log "building"
  make -C "$1" all
}

cleanup_tmp() {
  rm -rf "${TMPDIR:-/tmp}/ctc-fixture"
}

trap cleanup_tmp EXIT
build_all .
