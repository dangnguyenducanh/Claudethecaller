# Process for T1.1 (TypeScript). Every step ends with a check; the next step does not start before it passes.

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

Where to look (step 1): callers `.github/workflows/ci.yml`, `scripts/check.sh`, the Python `src/ctc/config.py`; the real producer is the
`config/*.yaml` files, copy them into a test fixture.

Commands (from the repo root, Node 22.22.1, pnpm 10.34.5):
- tests: `pnpm -r test` (one package: `pnpm -C packages/shared test`)
- types: `pnpm -r typecheck`
- lint: `pnpm -r lint`
- checks: `node agent/t1-1-workspace/checks.mjs [D#]`
- self-check: `python3 agent/t1-1-workspace/selfcheck.py [--fast]`
