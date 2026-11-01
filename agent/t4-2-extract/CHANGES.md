# Changes to the T4.2 contract after the coder's run

## Verifier round 1: checks.mjs D6 read a snake_case field
- What: `checks.mjs:316` `rows[0].reinforcement_dates` -> `rows[0].reinforcementDates`.
- Why: `createDb` installs Kysely's `CamelCasePlugin` (packages/shared/src/repositories/db.ts:76), so `selectAll()` rows carry `reinforcementDates`; the old read was `undefined` and D6 failed with a TypeError for every implementation. A planner mistake, not a module defect.
- Reproducer: `python3 agent/t4-2-extract/selfcheck.py` before the fix printed `FAIL D6 ... got=TypeError: Cannot read properties of undefined (reading 'length')`.

## Verifier round 3: sanitize was quadratic on nested blocks
- What: `stripBlocks` is one left-to-right pass that re-checks only the joint after a removal (no per-level full pass); `CTC_LINE` leading whitespace no longer spans `\r`/` `/` ` (those are line starts under `m`, so a `\r` run was quadratic).
- Behaviour change: `sanitize('\rctc: x')` now gives `'\r'` (the `\r` is kept; before it was removed with the line). Differential fuzz old vs new: `stripBlocks` identical, `sanitize` differs only by such a kept leading `\r`.
