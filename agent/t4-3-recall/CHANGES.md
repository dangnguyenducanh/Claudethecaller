# CHANGES (verifier round 1)

- selfcheck.py `tests()`: the own-tests vitest step now applies `known_red_only()` like the `pnpm -r test` step. Why: the own-tests run includes `packages/shared/src/repositories/schema-assumptions.test.ts`, which is red at HEAD (no migration defines `projects.graph_epoch`/`mem_epoch`; file and migrations unchanged), so SELFCHECK could never reach DONE; planner mistake. Reproducer: `python3 agent/t4-3-recall/selfcheck.py` printed `vitest exited 1` with 1 failed | 287 passed, the one failure being the known-red test.
