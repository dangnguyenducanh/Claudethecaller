# 01 — runner-test-seam

Status: resolved
Blocked by: none
Spec: `.scratch/n8n-parity/spec.md` (read it first; this ticket implements part of it)
Touches: src/ctc/runner/ (read only), tests/conftest.py (shared fixtures other tickets import), tests/test_runner_engine.py, scripts/fake_claude.sh (new)

## What to build

Build the one main test seam from the spec: a pytest fixture that creates a throwaway schema on the scratch Postgres in `CTC_DATABASE_URL` (skip the whole module when it is unset or Supabase), opens a Store on it, and a helper `run_yaml(yaml_text, input=..., claude_script=...)` that submits the workflow through the engine, executes it to the end in-process, and returns the run row plus step rows. Add `scripts/fake_claude.sh`: answers `--version` with the pinned version from config, `auth status` with a claude.ai login JSON, and for `-p` replays a scripted stream-json result (text and usage) chosen by an env var, so agent nodes can be faked per test. Reuse the existing fake quota/overage scripts' conventions.

## Acceptance criteria

- [ ] `uv run pytest -q tests` runs and skips the engine module when `CTC_DATABASE_URL` is unset or Supabase.
- [ ] With a scratch DB: a shell-only workflow (trigger -> shell -> IF -> two shells) runs to `done` with the right steps done/skipped.
- [ ] With a scratch DB: an agent node using the fake claude completes with its scripted output and token counts.
- [ ] A fake quota script run ends with run status `quota`.
- [ ] The schema is dropped after the session; nothing touches the real `~/.claudethecaller` (runs dir points at a tmp dir).
- [ ] `scripts/check.sh` green; tests added at the seam the spec names.

## Tests

This ticket IS the tests. Keep the helper tiny and documented in the test module docstring.

## Comments

2026-10-26 — resolved on branch `n8n-01-runner-test-seam`, merged into `m5-n8n-parity` (tasks T001–T007 + T169). Seam: tests/conftest.py fixtures `scratch_db` (throwaway `ctc_test_<hex>` schema, wf_runs ids offset per session to 10^9+x so `kill_run` never hits real or other-lane runs), `seam`, `in_store(fn)`, `walk_run(rid)`, `run_yaml(yaml, input, claude_script)` (dict/list = scripted results, str = another fake binary such as scripts/fake_claude_quota.sh); scripts/fake_claude.sh (CTC_FAKE_CLAUDE_SCRIPT file or dir). CI: `db-selfchecks` runs `uv run pytest -q tests`. Note: the store self-check uses a fixed `ctc_selfcheck` schema, so parallel check.sh runs on one scratch DB can collide; rerun on a collision.
