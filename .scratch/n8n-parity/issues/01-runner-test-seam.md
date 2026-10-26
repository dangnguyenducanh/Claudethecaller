# 01 — runner-test-seam

Status: ready-for-agent
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
