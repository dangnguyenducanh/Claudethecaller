# Process for T0.2 (Python)

Language: Python 3.12 (project venv, `uv run python`). Module: `evaluation/record_baselines.py`. Tests: `tests/test_record_baselines.py`. Self-check: `agent/t0-2-baselines/selfcheck.py`.
Steps 1 to 6 below are the ORCHESTRATOR section 3 text; only the language and file names are adapted. In step 1, there are no call sites yet (new module): read the producers named in SPEC.md instead (evaluation/latency_eval.py, evaluation/retrieval_eval.py `ranking-test`, src/ctc/server/hooks.py) and call the running daemon read-only for the sample.
The next step does not start before the current one passes.

1. Read the callers and rules. Grep every call site. Done when you can say, per call site, what goes in, what is done with the result, and what the module must never do. Also run the real upstream producer on a sample and keep the output as a fixture.
2. Write header, constants, signatures only (bodies raise NotImplementedError). Header: what the module is, called from, why it exists, deliberately NOT done. Each constant gets the real reason, or `chosen by judgment`: never an invented reason. Each function gets a docstring: trust, return, copies or modifies, bad input. Done when it imports and the header answers who calls it, why, and what it does not do.
3. Write tests first, covering every decision id. One behaviour per test. For every limit: shrink with monkeypatch, equal is valid, one more is an error, pin the default. Compare errors with `==`. Must-NOT tests for every non-goal. Public names and tmp paths only. Done when the tests collect and fail.
4. Smallest code that passes. Reuse the repo's helpers. Add nothing the decisions do not list. Silence rule D8. Done when tests, checks, lint and scope pass.
5. Run the self-check, fix every FAIL. Done at `SELFCHECK: DONE`.
6. Report in at most 150 words: commands and results, every `judgment:` call, doubts.
