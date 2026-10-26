#!/usr/bin/env bash
# Fake `claude` for the engine test seam (tests/conftest.py): answers `auth status` and `--version` like the pinned CLI;
# a -p run prints the init line, then replays a scripted result chosen by CTC_FAKE_CLAUDE_SCRIPT (CTC_*: proc.child_env
# strips CLAUDE* and ANTHROPIC_* variables): a dir -> <dir>/<n>.jsonl for its n-th call (counted in <dir>/.calls), else
# <dir>/default.jsonl; a file -> that file every call; unset -> the default result (= conftest DEFAULT_RESULT).
#   CTC_CLAUDE_BIN=scripts/fake_claude.sh uv run python -m ctc.runner.proc agent x   -> result=ok
case "$1" in
  --version) echo "$(grep -o 'claude_version: "[^"]*"' "$(dirname "$0")/../config/server.yaml" | cut -d'"' -f2) (Claude Code)"; exit 0 ;;
  auth) echo '{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "email": "fake@example.com", "subscriptionType": "max"}'; exit 0 ;;
esac
sid=$(printf '%s\n' "$@" | grep -A1 -x -- --session-id | tail -1)
[ -n "$sid" ] || sid=$(printf '%s\n' "$@" | grep -A1 -x -- --resume | tail -1)  # a node continued after a usage limit
cat >/dev/null  # the prompt
echo '{"type":"system","subtype":"init","cwd":"'"$PWD"'","session_id":"'"$sid"'","apiKeySource":"none","claude_code_version":"fake","model":"claude-sonnet-5","permissionMode":"acceptEdits","tools":[],"mcp_servers":[]}'
s=${CTC_FAKE_CLAUDE_SCRIPT:-}
if [ -d "$s" ]; then
  # ponytail: unlocked counter, so parallel readonly agents in one batch may share n; script those with one dict
  n=$(( $(cat "$s/.calls" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$s/.calls"
  if [ -f "$s/$n.jsonl" ]; then s="$s/$n.jsonl"; else s="$s/default.jsonl"; fi
fi
if [ -n "$s" ]; then out=$(cat "$s"); else
  out='{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"ok","total_cost_usd":0,"usage":{"input_tokens":3,"output_tokens":1},"permission_denials":[]}'
fi
echo "$out"
if printf '%s\n' "$out" | grep -q '"is_error": *true'; then exit 1; fi  # like the real CLI
