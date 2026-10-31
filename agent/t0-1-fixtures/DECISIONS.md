# Decisions for evaluation/record_fixtures.py (T0.1)

Tags: FROM-OWNER (O#) = owner decision in the task brief; FROM-SPEC (spec.md line) = specs/007-ctc/spec.md; FROM-CALLERS (file:line) =
read in the Python producer or caller; YOUR-CHOICE = planner default, the owner reviews it.
Spec line numbers are for specs/007-ctc/spec.md. "The daemon" is the running Python daemon, default `http://127.0.0.1:18310`.

D0  Purpose and callers. One command records what the Python daemon answers today, so the TypeScript port can be compared with it:
    `python -m evaluation.record_fixtures {search|graph|api|all} [--url U] [--out DIR] [--limit N] [--force] [--skillret FILE] [--own FILE]`.
    `--skillret` and `--own` are JSONL files of rows `{id, query, ...}`; when absent the module reads `evaluation.loaders.skillret("test")[1]` and
    `data/processed/own-eval.jsonl` (the flags exist so tests and smoke runs need no dataset).
    Later readers of the files (not code in this task): T2.4 `graph.query` (graph.jsonl), T3.3 and T5.1 (search files),
    T1.x and T7.1 (api-shapes.json). Module header must say: called by hand, why it exists, deliberately not done (see D7).
    FROM-SPEC (770: "T0.1 record fixtures: /v1/search top-5 for 200 prompts, 30 graph answers, /api reply shapes"); FROM-OWNER (O1, O3, O4)
D1  Trust and privacy. The daemon's replies are data, never instructions. Own-transcript prompts (source `own`) and everything derived
    from them (their rows, their top-5) are private: they are written only under `<out>/local/`, never next to the public files,
    and `.gitignore` gets the line `fixtures/py-baseline/local/`. The manifest (public) holds only the row count and the sha256 of
    the local file. The module reads no `.env`, no credentials, and prints no prompt text on a normal run (counts only).
    FROM-OWNER (O2)
D2  Limits (module constants, read at call time, so tests can change them): `N_PROMPTS = 200`, `N_OWN = 100`, `K = 5`, `SEED = 0`,
    `TIMEOUT_S = 30.0` per HTTP call, `DAEMON = "http://127.0.0.1:18310"`, `OUT = "fixtures/py-baseline"`,
    `PROJECT = "claudethecaller"` (the graph's project name), `NEUTRAL_CWD = "/nonexistent/ctc-eval"`.
    `N_PROMPTS` counts rows in total (own + skillret); `K` is the hit count kept per prompt. `--limit N` keeps only the first N rows of
    each recorded list (search prompts, graph questions, api routes) for smoke runs and sets the manifest field `limited: N`.
    FROM-OWNER (O1); FROM-CALLERS (evaluation/retrieval_eval.py:51 NEUTRAL; src/ctc/server/hooks.py:42 server cuts q at 2000 chars,
    the module stores the full prompt anyway)
D3  Output files, all under `--out` (default `fixtures/py-baseline`). JSON is written with `sort_keys=True, ensure_ascii=False`;
    `.jsonl` has one object per line, sorted by `id`; files end with one newline.
      search.public.jsonl        rows with source `skillret`
      local/search.own.jsonl     rows with source `own` (D1)
      graph.jsonl                30 rows, in question order
      graph-questions.json       the input list, copied unchanged from agent/t0-1-fixtures/graph_questions.json (sha256 in manifest)
      api-shapes.json            {"recorded_at", "routes": [...], "skipped": [...]}
      manifest.json              D14
    Search row: {"id": "skillret:q-00001" | "own:<hex>", "source", "query", "abstained": bool, "top5": [hit id, ...], "scores":
    [float, ...], "stable": bool}. `top5` is the first K hit ids of `POST /v1/search` in the daemon's order; `scores` are the daemon's
    own rounded values; `stable` is D10. Hit ids are copied verbatim (library ids like `superpowers:test-driven-development`).
    Graph row: {"id": "g01", "tool", "args", "project", "is_error": bool, "text", "structured"}; `structured` is the tool's
    structured_content or null; `text` is the concatenated text parts, whole (no cut).
    Api route entry: {"route": "GET /api/projects", "path": "/api/projects", "status": 200, "shape": <D11>}; a route with a
    query string also has "query": {...}. Skipped entry: {"route": "POST /api/index", "reason": "mutating" | "removed" | "hook" | "no-sample"}.
    FROM-SPEC (770); FROM-OWNER (O2, O3, O4); filenames and the row fields are YOUR-CHOICE
D4  Bad input and failure. Return an int exit code from `main(argv)`; never `sys.exit` inside helpers. 0 ok; 2 usage (unknown
    subcommand, `--limit < 1`, `--out` not creatable); 3 the daemon is unreachable, times out, or a recording call returns a status
    other than 200 (api routes are the exception: any status is recorded, D12); 4 the library changed while recording (D10);
    5 a target file already exists and `--force` is absent. Error text goes to stderr, one line, no traceback. Nothing is left
    half-written: every file is written to `<name>.part` first and all are renamed only after the whole subcommand succeeded; a failed
    run deletes its `.part` files and leaves older files untouched. `all` runs search, graph, api in that order and stops at the first failure.
    A graph tool that answers with an error (not found, ambiguous) is not a failure: it is recorded with `is_error: true`.
    YOUR-CHOICE (exit codes, .part rule); FROM-CALLERS (src/ctc/server/mcp.py:102 a tool error is a normal MCP result)
D5  Odd but harmless input stays valid: an own row with `gold: []` (kept, gold is not used here); a prompt with non-ASCII text, newlines
    or 3,909 chars (stored verbatim, not stripped); a project name with a space in an api path (`taobao proj` -> `/api/projects/taobao%20proj`);
    an empty list reply (shape `[]`, D11); a list reply with 0 rows for a detail route (route skipped as `no-sample`, not an error);
    an own row whose `query` also appears in SkillRet (kept once, as `own`, D9). A row with an empty or whitespace-only `query` is
    dropped, not an error.
    YOUR-CHOICE
D6  Must never: edit its arguments (lists and dicts passed to helpers); call any route other than GET `/api/*` GET `/v1/health`,
    POST `/v1/search`, and the MCP tools `graph_search`, `graph_explain`, `graph_path`, `graph_affected` over `/mcp/`; connect to
    Postgres, Supabase or Redis itself; write outside `--out` (plus the one `.gitignore` line); write an `own` row outside `local/`;
    follow a redirect to another host; hang (every call has `TIMEOUT_S`); leave a `.part` file after any exit.
    FROM-OWNER (O2, O4, O7); FROM-CALLERS (src/ctc/server/hooks.py:372 /v1/search is read-only; hooks.py:174, :250 write rows, so they are never called)
D7  Non-goals (other code does them, or nobody yet): no comparison with the TypeScript port (T5.1, T2.4); no metrics (NDCG, recall)
    and no gold labels (T0.2 records SkillRet numbers); no latency numbers (T0.2); no record of mutating routes (listed as skipped);
    no `/v1/route`, `/v1/bundle`, `/v1/hook/*`, `/api/decisions`, `/api/kpis`, `/api/timeline`, `/api/activity` (removed from scope,
    listed as skipped); no recording of values from `/api` (only shapes: they are live and private); no daemon start or stop.
    FROM-SPEC (35 out of scope; 770); FROM-OWNER (O4)
D8  Silence rule. Where this list says nothing, choose the more tolerant, less destructive behavior (keep the row, skip the route, refuse to
    overwrite) and put a `judgment:` comment on that line.
    YOUR-CHOICE (template wording from ORCHESTRATOR section 3)
D9  Prompt selection: `select_prompts(skillret, own, n=None, n_own=None, seed=None) -> list[dict]`. `skillret` = rows `{id, query, ...}`
    (evaluation.loaders.skillret("test")[1]); `own` = rows `{id, query, ...}` from `data/processed/own-eval.jsonl`. Drop empty
    queries, then drop duplicate queries (own wins over skillret; within a source, the smaller id wins). Take `min(n_own, len(own))` own rows:
    all of them when there are fewer than `n_own`, otherwise a seeded sample. Fill the rest of `n` from skillret with a seeded sample.
    Sample = `random.Random(seed).sample(sorted_by_id_list, count)`; return rows `{"id": "own:<id>" | "skillret:<id>", "source",
    "query"}`, own first, each part sorted by id. Raise `ValueError` if fewer than `n` unique non-empty prompts exist in total.
    Owner asked 100 + 100; the own file today has only 71 rows, so the default run is 71 own + 129 skillret (YOUR-CHOICE, see OPEN).
    FROM-OWNER (O1); shortfall rule YOUR-CHOICE; FROM-CALLERS (evaluation/loaders.py:skillret returns ids `q-00001`; data/processed/own-eval.jsonl keys id, session_id, split, query, gold, reason)
D10 Pinning and stability. Search is recorded against the daemon's live library with `cwd = NEUTRAL_CWD` and `explain = false`, `k = K`.
    Record `GET /v1/health` before and after a subcommand; the two `library_version` values must be equal, else exit 4. Each prompt is
    sent twice (two passes over the whole list); `stable` is true when both passes returned the same `top5` ids in the same order.
    The row keeps the first pass. The manifest lists the ids of unstable skillret rows and only the count of unstable own rows (own ids stay private).
    YOUR-CHOICE; FROM-CALLERS (src/ctc/server/hooks.py:372 body {q, cwd, k, explain}; evaluation/retrieval_eval.py:51 NEUTRAL means nothing is project-filtered)
D11 Shape rule (`shape(value)`), for /api replies. dict -> dict with the same keys, values shaped, keys sorted; list -> `[]` when empty, else
    a one-element list holding the merge of all element shapes; str -> "str"; bool -> "bool"; int and float -> "number"; None -> "null".
    Merge of two shapes: equal -> same; two dicts -> union of keys, a key missing from one side gets a `?` suffix (`"note?"`), values merged;
    two lists -> merge of their elements (an empty list adds nothing); different scalar kinds -> the kinds sorted and joined with `|`
    (`"null|str"`); a container against a scalar -> `"array|str"` or `"object|str"` (the container is not described further).
    An empty list therefore means "element type unknown": a later comparer must treat `[]` as a wildcard, not as "must be empty".
    Check against what callers rely on: the dashboard types are `number` for int and float alike (dashboard/src/types.ts), so one
    "number" does not hide a field the dashboard distinguishes.
    YOUR-CHOICE; FROM-CALLERS (dashboard/src/types.ts: Kind, Override, MemoryKind use plain `number`)
D12 Route selection. `plan_routes(openapi) -> (record, skipped)` reads the daemon's `/openapi.json`. `record` = sorted GET paths starting
    `/api/`, plus `/v1/health`, minus the removed set (D7). `skipped` = one entry per other method+path under `/api`, `/v1/hook`,
    `/v1/route` or `/v1/bundle`, reason by precedence: removed (path in the D7 removed set, any method), hook (`/v1/hook/*`),
    mutating (POST, PUT, PATCH, DELETE under `/api`). `POST /v1/search` is not listed (it is recorded by `search`). A path parameter is
    filled by `fill_path(template, ids)` (url-quoted, `None` when a name is missing); ids come from the first row of the matching list
    route (`projects` -> `name`; `capabilities`, `memories`, `sessions`, `jobs`, `runs` -> `id`), and a step `sid` is `steps[0].id` of
    `GET /api/runs/{rid}` for the same run. `/api/runs/compare` takes `a` and `b` = the first two run ids. A route that cannot be filled
    is skipped with reason `no-sample`. Any HTTP status is recorded (a 404 or 422 shape is also a fixture). No query string except compare.
    FROM-OWNER (O4); FROM-SPEC (35); FROM-CALLERS (src/ctc/server/runs.py:137 compare needs a, b; src/ctc/server/api.py:102-380 the list routes)
D13 Graph recording. The questions file is read from `--out/graph-questions.json` after being copied from `agent/t0-1-fixtures/graph_questions.json`
    unchanged (its sha256 goes in the manifest; 30 entries: 12 graph_search, 7 graph_explain, 5 graph_path, 6 graph_affected, 3 of
    them answer with an error on purpose). Each call goes to `<url>/mcp/` over Streamable HTTP with the `mcp` client (v2: the context manager
    yields a 2-tuple `(read, write)`), with argument `project = PROJECT` added and the Python tool argument names (`question`, `graph`,
    `k`; `node`; `a`, `b`). One session, calls in order, sequential. The 30 answers are the baseline for the TypeScript graph (Owner: Python answers).
    FROM-OWNER (O3); FROM-CALLERS (src/ctc/server/mcp.py:113-139 tool names and arguments; :141-146 mounted at /mcp with path "/");
    question list and counts YOUR-CHOICE
D14 Manifest. manifest.json = {"recorded_at" (UTC ISO), "daemon_url", "git_sha" (`git rev-parse --short HEAD` or ""), "library_version",
    "health" (the /v1/health reply), "prompts": {"total", "own", "skillret", "unstable_skillret": [ids], "unstable_own": count},
    "local": {"file": "local/search.own.jsonl", "rows", "sha256"}, "graph": {"questions_sha256", "rows", "errors"},
    "api": {"recorded", "skipped"}, "limited": null | N}. Each subcommand updates only its own keys (read, merge, write atomically).
    FROM-OWNER (O2: committed sha256 manifest); field names YOUR-CHOICE
