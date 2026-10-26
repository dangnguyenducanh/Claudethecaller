# 15 — graceful-shutdown

Status: ready-for-agent
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
