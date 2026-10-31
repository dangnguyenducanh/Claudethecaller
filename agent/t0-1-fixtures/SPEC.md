# Task: T0.1 record what the Python daemon answers today (search top-5, 30 graph answers, /api shapes) as fixtures

The TypeScript rewrite (spec 007) must give the same answers as the Python daemon that serves now. This module records those answers
once, from the running daemon, into `fixtures/py-baseline/`. Callers: a person or the orchestrator runs it by hand. Untrusted: nothing
executes the replies; the private part is the owner's own prompts (D1), which must never reach a tracked path.

Public names (module `evaluation/record_fixtures.py`):

    N_PROMPTS: int; N_OWN: int; K: int; SEED: int; TIMEOUT_S: float; DAEMON: str; OUT: str; PROJECT: str; NEUTRAL_CWD: str
    select_prompts(skillret: list[dict], own: list[dict], n: int | None = None, n_own: int | None = None, seed: int | None = None) -> list[dict]
    split_rows(rows: list[dict]) -> tuple[list[dict], list[dict]]            # (public = source skillret, local = source own)
    search_row(prompt: dict, reply: dict, stable: bool = True) -> dict        # D3 search row from a /v1/search reply
    graph_row(question: dict, is_error: bool, text: str, structured: dict | None) -> dict
    shape(value: object) -> object                                           # D11
    plan_routes(openapi: dict) -> tuple[list[str], list[dict]]               # D12: (paths to record, skipped entries)
    fill_path(template: str, ids: dict[str, object]) -> str | None
    file_sha256(path: str | os.PathLike) -> str
    main(argv: list[str] | None = None) -> int                               # D4 exit codes

## Environment facts (read from the producers; check them yourself in PROCESS step 1)
- Daemon: `http://127.0.0.1:18310` (healthy). Read-only use only (D6). `POST /v1/search {q, cwd, k, explain}` -> `{query, abstained, p, hits[], ms}`;
  each hit has `id`, `score`, `stages` (src/ctc/server/hooks.py:372, src/ctc/retrieval/hybrid.py:172).
- MCP: `<url>/mcp/` (trailing slash), `mcp.client.streamable_http.streamable_http_client` + `mcp.ClientSession`; mcp v2 yields `(read, write)`.
  Tool argument names are the Python ones (src/ctc/server/mcp.py:113-139), not the spec's.
- Data: `data/processed/own-eval.jsonl` (own prompts, 71 rows) and the cached SkillRet test split (`evaluation.loaders.skillret("test")`) live in the
  main checkout's `data/` (gitignored). The orchestrator links `data/` into RUN_DIR; do not download anything.
- Python: the project venv (`uv run python`); `httpx`, `mcp`, `datasets` are installed. Scratch Postgres/Redis are not needed by this task.

## How to work
1. agent/t0-1-fixtures/DECISIONS.md is the behaviour contract. Implement exactly that.
2. agent/t0-1-fixtures/PROCESS.md is the order of work.
3. Change only `evaluation/record_fixtures.py`, new `tests/test_record_fixtures*.py`, one line in `.gitignore` (D1), and copy
   `agent/t0-1-fixtures/graph_questions.json` unchanged to `fixtures/py-baseline/graph-questions.json`. Do not commit generated fixtures
   (the orchestrator records them after review). Never edit SPEC.md or anything under agent/.

## Done
`python agent/t0-1-fixtures/selfcheck.py` prints `SELFCHECK: DONE`. (The orchestrator also runs it with `--live` against the daemon.)
