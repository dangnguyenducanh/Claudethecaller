# 05 — notify-hook

Status: ready-for-agent
Blocked by: 01
Spec: `.scratch/n8n-parity/spec.md` (read it first; this ticket implements part of it)
Touches: src/ctc/runner/notify.py (new), src/ctc/runner/engine.py (call sites only), config/server.yaml (runner.notify), tests/test_notify_hook.py (engine-seam cases using the ticket 01 fixtures from tests/conftest.py)

## What to build

A notify command: daemon-wide `runner.notify` in server config, overridable per workflow by `settings.notify`. After each run status change to failed, waiting, quota or done, run it detached with env `CTC_RUN_ID CTC_RUN_STATUS CTC_RUN_WORKFLOW CTC_RUN_URL CTC_RUN_ERROR` and a 10 s timeout; output goes to the run's log dir; a failing or hanging notify never changes the run. Document an example (`notify-send`, a curl to a chat webhook from env).

## Acceptance criteria

- [ ] Each of the four events fires once per transition with the right env (engine-seam test with a notify script writing env to a file).
- [ ] A notify command that exits 1 or sleeps past the timeout leaves the run status unchanged.
- [ ] No notify configured = no change in behaviour.
- [ ] `scripts/check.sh` green; tests added at the seam the spec names.

## Tests

Engine-seam cases from ticket 01.

## Comments
