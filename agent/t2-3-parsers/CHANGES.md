# CHANGES

## Round 1 (verifier): checks.mjs D15
- What: added `reply = '{"edges":[]}';` before the `maxExtractFiles: 1` block in the D15 check.
- Why: `reply` was left as `'garbage'` from the bad_reply step, so the later over_limit call legitimately threw `extract_failed ... (bad_reply)` (D15 requires that). Planner mistake, not module code.
- Reproducer: `python3 agent/t2-3-parsers/selfcheck.py` printed `FAIL D15 ... got=Error: extract_failed: specs/900-demo/spec.md (bad_reply)`.
