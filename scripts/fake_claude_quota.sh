#!/usr/bin/env bash
# Fake `claude` (PLAN.md m5 WB3/WB6): answers `auth status` and `--version` like the pinned CLI, then a -p run that
# hits the session limit (init, an error result, exit 1).
#   CTC_CLAUDE_BIN=scripts/fake_claude_quota.sh uv run python -m ctc.runner.proc agent x   -> status=quota resets_at=...
# The limit text is a guess (PLAN.md "Still unverified"); paste the real one here when it happens.
case "$1" in
  --version) echo "$(grep -o 'claude_version: "[^"]*"' "$(dirname "$0")/../config/server.yaml" | cut -d'"' -f2) (Claude Code)"; exit 0 ;;
  auth) echo '{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "email": "fake@example.com", "subscriptionType": "max"}'; exit 0 ;;
esac
sid=$(printf '%s\n' "$@" | grep -A1 -x -- --session-id | tail -1)
cat >/dev/null  # the prompt
echo '{"type":"system","subtype":"init","cwd":"'"$PWD"'","session_id":"'"$sid"'","apiKeySource":"none","claude_code_version":"fake","model":"claude-sonnet-5","permissionMode":"acceptEdits","tools":[],"mcp_servers":[]}'
echo '{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"duration_ms":412,"num_turns":1,"result":"You'"'"'ve hit your session limit · resets 3pm","stop_reason":null,"session_id":"'"$sid"'","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0},"permission_denials":[]}'
exit 1
