# T2.2 verifier changes (round 1)

1. selfcheck.py scope: admit T2.1's `packages/core/src/graph/graph.test.ts` when its diff vs HEAD touches only its two export pins
   (`t21_export_edit_only()`). Why: D24 requires `index.ts` to export `resolveGraph`, `contentHash`, `resolveLimits`, `SCORES`, but
   T2.1's test forbids `contentHash`/`resolve` (graph.test.ts:201) and pins the exact export list (graph.test.ts:361); the contract
   was contradictory (planner mistake). Reproducer: `git stash push packages/core/src/graph/graph.test.ts &&
   timeout 300 pnpm --filter @ctc/core exec vitest run src/graph/graph.test.ts` -> 2 failing tests; with the edit, scope FAILed instead.
2. selfcheck.py suites: pass `CTC_SCRATCH_REDIS_URL` (guarded to redis://127.0.0.1:18395) to children. Why: T4.1's
   apps/web/src/spool/memory.spool.int.test.ts:50 asserts the scratch Redis URL; without it `pnpm -r test` fails on HEAD code
   unrelated to T2.2. Reproducer: `env -u CTC_SCRATCH_REDIS_URL timeout 1200 python3 agent/t2-2-resolve/selfcheck.py` -> FAIL pnpm -r test (apps/web 'unparsable').
