# Process for T1.2 (TypeScript). Every step ends with a check; the next step does not start before it passes.

1. Read the callers and rules. Grep every call site. Done when you can say, per call site, what goes in, what is done with the
   result, and what the module must never do. Also run the real upstream producer on a sample and keep the output as a fixture.
2. Write header, constants, signatures only (bodies `throw new Error("not implemented")`). Header: what the module is, called from, why it
   exists, deliberately NOT done. Each constant gets the real reason, or `chosen by judgment`: never an invented reason.
   Each function gets a docstring (TSDoc): trust, return, copies or modifies, bad input. Done when it type-checks (`pnpm -r typecheck`) and the
   header answers who calls it, why, and what it does not do.
3. Write tests first, covering every decision id. One behaviour per test. For every limit: shrink with `vi.stubEnv` or an argument, equal is valid,
   one more is an error, pin the default. Compare errors with `toEqual`. Must-NOT tests for every non-goal. Public names and tmp paths
   only. Done when the tests collect and fail.
4. Smallest code that passes. Reuse the repo's helpers. Add nothing the decisions do not list. Silence rule D8. Done when tests,
   checks, lint and scope pass.
5. Run the self-check, fix every FAIL. Done at `SELFCHECK: DONE`.
6. Report in at most 150 words: commands and results, every `judgment:` call, doubts.

Where to look (step 1): callers T1.1's `loadConfig`, the Python `src/ctc/storage/schema.sql` as the shape of the source data, `.github/workflows/ci.yml`
and `scripts/check.sh` for how scratch services are named. The real producer is the Python schema applied to a scratch database plus your own rows,
and the read-only copy of the real Python data; keep a small SQL fixture of it in the tests.

Commands (from the repo root, Node 22.22.1, pnpm 10.34.5; scratch Postgres `ctc-dev-pg` is already running on 127.0.0.1:18304):
- tests: `CTC_TEST_ADMIN_URL=postgresql://postgres:ctcdev@127.0.0.1:18304/postgres pnpm -C packages/shared test`
- types and lint: `pnpm -r typecheck`, `pnpm -r lint`
- try it by hand on a scratch database you created (name it `ctc_t12_<something>`):
  `CTC_DATABASE_URL=postgresql://postgres:ctcdev@127.0.0.1:18304/ctc_t12_hand node apps/cli/src/main.ts migrate`
- checks: `node agent/t1-2-migrations/checks.mjs [D#]`
- self-check: `python3 agent/t1-2-migrations/selfcheck.py [--fast]`
