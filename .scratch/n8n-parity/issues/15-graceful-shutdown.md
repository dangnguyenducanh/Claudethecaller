# 15 — graceful-shutdown

Status: resolved
Blocked by: 01
Spec: `.scratch/n8n-parity/spec.md` (read it first; this ticket implements part of it)
Touches: src/ctc/runner/engine.py (run_runner, sweep), src/ctc/server/app.py (lifespan), tests/test_graceful_shutdown.py (engine-seam cases using the ticket 01 fixtures from tests/conftest.py)

## What to build

On a planned stop (SIGTERM / `ctc daemon stop`), the runner stops claiming new batches, waits up to 5 min (config) for the running batch to land and be saved, then re-queues the run (status queued, walker state kept) so the next daemon start continues it. Only a hard crash keeps today's 'failed: daemon stopped mid-run'. `scripts/deploy_local.sh` needs no change.

## Acceptance criteria

- [ ] A run stopped between batches resumes from the next batch after restart with no re-executed step.
- [ ] A batch still running past the grace period is killed and the run fails as today.
- [ ] No change when no run is active.
- [ ] `scripts/check.sh` green; tests added at the seam the spec names.

## Tests

Engine-seam cases simulating the shutdown signal in-process.

## Comments

2026-10-26 — resolved on branch `n8n-15-graceful-shutdown`, merged into `m5-n8n-parity` (tasks T078–T083). engine.py: `STOPPING` event; `execute()` re-queues its run to `queued` at the next batch (walker state kept, no notify); `run_runner` loops stop claiming; new `stop_runner(st, runner, grace_s)` waits `runner.shutdown_grace_s` (config/server.yaml, 300), cancels past it and always sweeps (fails leftovers through `_fail`). app.py lifespan calls `stop_runner`; `ctc daemon stop` waits grace + 60 s. Tests: tests/test_graceful_shutdown.py (4, in-process). Not run: the live `ctc daemon stop` during a run (restarts the daemon; owner's yes). Notes: a stop during the runner's 30 s startup-sweep retry sleep can take up to 30 s; the dashboard is down during the grace.
