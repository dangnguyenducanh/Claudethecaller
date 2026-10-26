# Contract: hooks (m7)

All hooks stay `curl` one-liners to the daemon socket and fail open (`|| true`). Only SessionStart is new. The details are in inventory §4 and §5.

## Install (`src/ctc/cli.py`, O4)

```python
HOOKS["SessionStart"] = ("start", "1")          # D16: the one hook allowed 1 s (runs once per session)
MATCHERS["SessionStart"] = "startup|clear|compact"   # never `resume`: keeps the prompt-cache prefix stable
```

- `ctc install` adds only the missing events. `ctc uninstall` removes by the `ctc.sock` marker, as today.
- Done-when: `CTC_CLAUDE_HOME=<tmp> uv run ctc install --dry-run` lists a SessionStart entry with matcher `startup|clear|compact` and `-m 1`. An empty home also lists the other five hooks; the "no other diff" check is the O4 test over a pre-m7 `settings.json`, which clears `cfg()`'s cache after setting `CTC_CLAUDE_HOME`.

## `POST /v1/hook/start` (new, O4)

**Request**: Claude Code's SessionStart hook body (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `source`).

**Behaviour**:
1. `memory.enabled` false, `_in_run(body)`, `source == "resume"` or the project in `history.skip_projects` → empty 200.
2. `pid = project_id(cwd)`; name = `st.names.get((user, pid)) or Path(cwd).name`. Never `ensure_project` or `submit` here.
3. Read `ctx:{user}:{project_id}`; on a miss, `observations.refresh_context(...)` (one SQL round trip + render).
4. Prepend the header line `# [<project name>] recent context, <YYYY-MM-DD h:mmpm TZ>` and wrap the result in `<ctc-memory-context>…</ctc-memory-context>`.

**Response** (200, `application/json`):

```json
{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "<ctc-memory-context>…</ctc-memory-context>"},
 "systemMessage": "ctc memory: 50 observations · http://127.0.0.1:18310/#memories"}
```

`systemMessage` is omitted when the project has no memory. Any exception → empty 200 (fail open). The route waits at most `0.9` s internally.

## `POST /v1/hook/prompt` (existing, changed in O1)

- `prompt = _redact(strip_tags(prompt))` runs before `route()`, the `decisions` write and the `sessions.title = prompt[:200]` write (so a pasted secret is not stored). `history.py` applies the same to its prompts before computing `ref`, so live hook rows and distilled rows still match.
- If the stripped prompt is empty: no routing, no prompt text written, empty response.

## `POST /v1/hook/stop` (existing, changed in O2)

- **Stop:** after today's `_stop` work, submit `observe` with payload `{session_id, project_id, user_id, transcript_path, final: false, upto}` where `upto` is the transcript size read at Stop time. If an `observe` job for the session is already `queued`, raise its payload `upto` (`greatest`) instead of submitting another. A `running` job does not suppress a new one.
- **SessionEnd:** the same, with `final: true`.
- Only when `memory.enabled` is true, in local mode, for a project not in `history.skip_projects` (name or folder basename); `_in_run(body)` is respected.
- The Stop body's `last_assistant_message` is never copied into the payload.
- A3's 30-minute `extract` throttle is unchanged.

## `POST /v1/hook/tool`, `POST /v1/hook/pre`

Unchanged.
