# T3.3 planner-file changes (orchestrator, verify round 1)

## selfcheck.py: project suites get the scratch Redis URL
- What: `suites()` now passes `CTC_SCRATCH_REDIS_URL=redis://127.0.0.1:18395` (constant `SCRATCH_REDIS`) to `pnpm -r test`.
- Why: `apps/web/src/spool/memory.spool.int.test.ts` (T4.1, already on the base branch) asserts the Redis URL is the scratch one and does not
  skip when it is unset, so `pnpm -r test` failed for a reason unrelated to T3.3 and `known_red_only` could not discount it. With the URL set,
  the only failure is the KNOWN_RED `schema-assumptions.test.ts`.
- Reproducer: `CTC_SCRATCH_PG_URL=postgresql://postgres:ctcdev@127.0.0.1:18304/postgres CTC_TEST_DATABASE_URL=$CTC_SCRATCH_PG_URL
  CTC_SKILLRET_FILE=$PWD/.ctc-dev/eval/absent.json pnpm -r --no-bail test` → apps/web `memory.spool.int.test.ts:50` Received "unparsable";
  add `CTC_SCRATCH_REDIS_URL=redis://127.0.0.1:18395` → apps/web 123 passed, only KNOWN_RED fails in packages/shared.
