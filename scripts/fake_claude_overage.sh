#!/usr/bin/env bash
# Fake `claude` (PLAN.md m5 WB3/WB6): answers `auth status` and `--version` like the pinned CLI, then a -p run whose
# rate_limit_event says it is spending extra usage (shape seen on 2.1.306, with isUsingOverage flipped), then a normal result.
#   CTC_CLAUDE_BIN=scripts/fake_claude_overage.sh uv run python -m ctc.runner.proc agent x   -> status=quota error='extra_usage'
case "$1" in
  --version) echo "$(grep -o 'claude_version: "[^"]*"' "$(dirname "$0")/../config/server.yaml" | cut -d'"' -f2) (Claude Code)"; exit 0 ;;
  auth) echo '{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "email": "fake@example.com", "subscriptionType": "max"}'; exit 0 ;;
esac
sid=$(printf '%s\n' "$@" | grep -A1 -x -- --session-id | tail -1)
reset=$(( $(date +%s) + 3600 ))
cat >/dev/null  # the prompt
echo '{"type":"system","subtype":"init","cwd":"'"$PWD"'","session_id":"'"$sid"'","apiKeySource":"none","claude_code_version":"fake","model":"claude-sonnet-5","permissionMode":"acceptEdits","tools":[],"mcp_servers":[]}'
echo '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":'"$reset"',"rateLimitType":"five_hour","overageStatus":"allowed","isUsingOverage":true,"unifiedWindows":{"five_hour":{"utilization":1.0,"resetsAt":'"$reset"'}}},"session_id":"'"$sid"'"}'
sleep 1
echo '{"type":"result","subtype":"success","is_error":false,"duration_ms":1400,"num_turns":1,"result":"ok","stop_reason":"end_turn","session_id":"'"$sid"'","total_cost_usd":0.01,"usage":{"input_tokens":3,"output_tokens":1},"permission_denials":[]}'
