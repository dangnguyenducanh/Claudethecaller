# Task: T0.2 record the Python daemon's latency and the SkillRet retrieval scores as baselines

Spec 007 gates the TypeScript port with `suggest.latency` and `suggest.skills`. This module records what the Python daemon does today so
those gates have a number to be compared with. Callers: a person or the orchestrator runs it by hand. Untrusted: the child process output
(only one JSON object is parsed) and the database choice (never Supabase, D1).

Public names (module `evaluation/record_baselines.py`):

    N_LATENCY: int; N_PRE: int; WARMUP: int; SEED: int; TIMEOUT_S: float; SKILLRET_TIMEOUT_S: int; SETTLE_S: float
    DAEMON: str; OUT: str; METRICS: list[str]; SKILLRET_GATE: float; RANKING_CMD: list[str]
    percentile(xs: list[float], p: float) -> float
    summarize(ms: list[float]) -> dict
    nonce_prompt(prompt: str, run_id: str, i: int) -> str
    sample_prompts(queries: list[dict], n: int | None = None, seed: int | None = None) -> list[str]
    pre_body(repo: str, relpath: str) -> dict
    parse_ranking(stdout: str) -> dict
    skillret_baseline(report: dict, limit: int | None = None) -> dict
    scratch_url(env: dict | None = None) -> str | None        # CTC_DATABASE_URL if set and not Supabase, else None
    mask_urls(text: str) -> str
    main(argv: list[str] | None = None) -> int

## Environment facts (read from the producers; verify in PROCESS step 1)
- Daemon `http://127.0.0.1:18310`: `POST /v1/search`, `POST /v1/hook/pre`, `GET /v1/health` (src/ctc/server/hooks.py). Read-only use only.
- `evaluation/retrieval_eval.py ranking-test [limit]` prints one JSON object (indent=1) then a text table; it needs `CTC_DATABASE_URL` pointing at the
  scratch Postgres (schema `ctc_skillret_sk` holds the 6,006 SkillRet test skills), TEI embedder and reranker up, and `data/raw/hf` (cached dataset).
  The orchestrator exports `CTC_DATABASE_URL` and links `data/` into RUN_DIR. Without them only the unit tests and checks can run; say so in your report.
- Python: the project venv (`uv run python`); `httpx` and `numpy` are installed (the module itself needs only the stdlib and httpx).

## How to work
1. agent/t0-2-baselines/DECISIONS.md is the behaviour contract. Implement exactly that.
2. agent/t0-2-baselines/PROCESS.md is the order of work.
3. Change only `evaluation/record_baselines.py` and new `tests/test_record_baselines*.py`. Do not commit generated baselines (the orchestrator records
   them). Never edit SPEC.md or anything under agent/.

## Done
`python agent/t0-2-baselines/selfcheck.py` prints `SELFCHECK: DONE`. (The orchestrator also runs it with `--live`.)
