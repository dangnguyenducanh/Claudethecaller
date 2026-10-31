# Decisions for evaluation/record_baselines.py (T0.2)

Tags: FROM-OWNER (O#) = owner decision in the task brief; FROM-SPEC (spec.md line) = specs/007-ctc/spec.md; FROM-CALLERS (file:line) =
read in the Python producer or caller; YOUR-CHOICE = planner default, the owner reviews it. "The daemon" = the running Python daemon,
default `http://127.0.0.1:18310`. Spec line numbers are for specs/007-ctc/spec.md.

D0  Purpose and callers. One command records today's Python numbers so the TypeScript gates have something to be compared with:
    `python -m evaluation.record_baselines {latency|skillret|all} [--url U] [--out DIR] [--repo DIR] [--prompts FILE] [--limit N] [--force]`.
    `latency.json` is read later by T5.1 (`suggest.latency`) and T7.1; `skillret.json` by T3.3 (`suggest.skills`) and T7.1. Nothing imports
    the module. Header must say: run by hand, why it exists, deliberately not done (D7).
    FROM-SPEC (771: "T0.2 latency + skillret baselines on the Python daemon"; 367, 460 the gates they feed)
D1  Trust. The daemon is read through exactly two routes: `POST /v1/search` and `POST /v1/hook/pre` (D10, D11), plus `GET /v1/health`.
    `POST /v1/hook/prompt` is never called: it writes session and decision rows into the daemon's database (src/ctc/server/hooks.py:145-160).
    The `skillret` part runs `python -m evaluation.retrieval_eval ranking-test [limit]` as a child process; it needs a Postgres holding the
    `ctc_skillret_sk` schema, so it refuses (exit 2, before starting anything) unless `CTC_DATABASE_URL` is set in the process environment
    and does not contain `supabase` (same rule as scripts/check.sh:15). The `.env` file is not consulted for that test. Child output is data:
    only the one JSON object is parsed (D12). Any text the module prints or raises has database URLs masked as `scheme://user:***@host`.
    No prompt text is printed. Only public prompts are used (SkillRet test), so both output files are safe to commit.
    FROM-OWNER (O7: Supabase untouched; O2); FROM-CALLERS (scripts/check.sh:15; tests/conftest.py:17)
D2  Limits (module constants, read at call time): `N_LATENCY = 100` prompts per search pass, `N_PRE = 50` files for the pre tier, `WARMUP = 3`
    discarded search requests before the miss pass (the pre tier discards one, D11), `SEED = 0`, `TIMEOUT_S = 30.0` per HTTP call, `SKILLRET_TIMEOUT_S = 7200` for the child process,
    `SETTLE_S = 3.0` pause after the first pre request (D11), `DAEMON = "http://127.0.0.1:18310"`, `OUT = "fixtures/py-baseline"`,
    `METRICS = ["recall@1", "recall@5", "recall@10", "ndcg@10", "mrr"]`, `SKILLRET_GATE = 0.80`, `RANKING_CMD = [sys.executable, "-m",
    "evaluation.retrieval_eval", "ranking-test"]` (the list a test may replace). `--limit N` replaces N_LATENCY and N_PRE, is passed to
    ranking-test as its positional `limit`, and is stored as `limited: N` in the output. 100 and 50 match the sizes the existing latency
    script and the graph eval use for hook timing; they are not tuned.
    FROM-SPEC (460: NDCG@10 >= 0.80 test); FROM-CALLERS (evaluation/graph_eval.py:13 `50 prompt + 50 pre hooks`; evaluation/retrieval_eval.py:475 `limit`); the other numbers YOUR-CHOICE
D3  Output, under `--out` (default `fixtures/py-baseline`), JSON with `sort_keys=True, ensure_ascii=False, indent=1`, one trailing newline.
    latency.json = {"recorded_at" (UTC ISO), "git_sha", "daemon_url", "health" (the /v1/health reply), "host": {"cpus": int, "load_1m": float},
    "limited": null | N, "prompts": int, "tiers": {"search_miss": S, "search_warm": S, "pre": S + {"note_rate": float}},
    "gates_for_ts": {"suggest_cold_p95_ms": 150, "suggest_l1_p95_ms": 10, "hook_pre_p95_ms": 40},
    "not_measured": [{"what": "POST /v1/hook/prompt", "reason": "writes session and decision rows"}, {"what": "POST /v1/suggest",
    "reason": "does not exist in the Python daemon"}]} with S = {"n", "min", "p50", "p95", "p99", "max"} in ms, rounded to 1 decimal.
    skillret.json = {"recorded_at", "git_sha", "source": "evaluation.retrieval_eval ranking-test", "limited", "n", "header", "ranking",
    "scores": {"dense": M, "hybrid": M, "old": M, "full": M}, "gate": {"metric": "ndcg@10", "split": "test", "min": 0.80, "value": float,
    "met": bool}} with M = the five METRICS rounded to 4 decimals; `value` is `scores.full["ndcg@10"]`; `header` and `ranking` are copied
    from the child's JSON unchanged. gates_for_ts numbers are the TypeScript gates, listed so a reader sees them next to the Python
    numbers; they are not tests here.
    FROM-SPEC (366-367: cold p95 <= 150, L1 p95 <= 10; 316: pre 40 ms; 460); FROM-CALLERS (evaluation/retrieval_eval.py:486-489 keys n, header,
    ranking, scores, compare); field names YOUR-CHOICE
D4  Bad input and failure: `main(argv) -> int`, never `sys.exit` in helpers. 0 ok; 2 usage (unknown subcommand, `--limit < 1`) or the D1
    database refusal; 3 the daemon is unreachable, times out, or a measured call returns a non-200 status; 4 the child process failed,
    timed out, printed no JSON object, or the object lacks `n`, `header`, `ranking` or `scores` (last 20 lines of its output, masked, go to
    stderr); 5 a target file exists and `--force` is absent. A bad `--repo` (not a git repo, no files) is exit 2. Files are written as
    `<name>.part` and renamed together after the subcommand succeeded; a failed run removes its `.part` files and leaves older files.
    `all` runs latency then skillret and stops at the first failure. Raise `ValueError` from helpers on empty input (percentile of `[]`).
    YOUR-CHOICE (codes follow T0.1 D4 so both recorders behave alike)
D5  Odd but harmless input stays valid: fewer prompts than `N_LATENCY` (all of them are used); a list with one value (`percentile([5.0], 99) == 5.0`);
    `--limit` smaller than `WARMUP` (warm-up still sends WARMUP requests and they are not counted; measurement runs on `--limit` prompts); a pre reply that is 200 with an empty body (counted, it is the
    normal "nothing to say" answer); prompts with non-ASCII text, newlines or 3,909 chars; queries given as `{id, query}` JSONL rows with extra
    keys; duplicate or blank queries (dropped).
    YOUR-CHOICE
D6  Must never: write to Postgres, Supabase or Redis itself; call any daemon route other than GET /v1/health, POST /v1/search, POST /v1/hook/pre; flush or delete any cache key (cold is made with a nonce, D10); edit its arguments; leave a `.part` file;
    hang (HTTP calls have TIMEOUT_S, the child has SKILLRET_TIMEOUT_S, killed with its process group on timeout); print a database URL with a password
    or the child's environment; start or stop the daemon or a container.
    FROM-OWNER (O7); FROM-CALLERS (evaluation/latency_eval.py:36-38 flush is what the old script does; we do not)
D7  Non-goals: no tuning of any knob; no pass or fail on the numbers (`gate.met` is data, the exit code stays 0); no comparison with the
    TypeScript port; no throughput or concurrency test; no GPU or TEI profile; no `/v1/hook/prompt`, `/v1/route`, `/v1/suggest` numbers; no
    paired significance tests (the child's `compare` block is dropped); no Redis flush; no gold labels from own transcripts.
    FROM-SPEC (771); YOUR-CHOICE (drop `compare`)
D8  Silence rule. Where this list says nothing, choose the more tolerant, less destructive behavior (use all prompts, refuse to overwrite, skip
    rather than guess) and put a `judgment:` comment on that line.
    YOUR-CHOICE (template wording)
D9  Percentile = linear interpolation between order statistics (numpy's default): sort ascending, `k = (n - 1) * p / 100`, `f = floor(k)`,
    `c = min(f + 1, n - 1)`, result `x[f] + (x[c] - x[f]) * (k - f)`. Pure stdlib, no numpy. `summarize(ms)` returns the S dict of D3
    (p50, p95, p99, min, max, n). Rounding happens only in `summarize`, to 1 decimal.
    FROM-CALLERS (evaluation/latency_eval.py:78 `np.percentile(ms, [50, 95])`, printed with `:.1f`)
D10 Search tiers. Prompts: `sample_prompts(queries, n=None, seed=None) -> list[str]` takes rows `{id, query}` (from `--prompts FILE` JSONL, default
    `evaluation.loaders.skillret("test")[1]`), drops blank and duplicate queries, sorts by id, then `random.Random(seed).sample(..., min(n, len))`,
    and returns the query strings in sampled order. Each tier sends the same list sequentially on one keep-alive `httpx.Client` to
    `POST /v1/search` with `{q, cwd: "/nonexistent/ctc-eval", k: 5, explain: false}`. **miss**: the text sent is `nonce_prompt(prompt, run_id, i) =
    f"{prompt}\n\nctc-baseline-{run_id}-{i}"` (run_id = 6 hex chars from uuid4), so the daemon's `emb:{sha1(text)}` key has never been seen and
    the embedder runs. **warm**: the identical nonce texts again right after the miss pass, so the embedding is cached. `WARMUP` extra requests run first and are discarded: texts `nonce_prompt(first prompt, run_id, -k)` for k = 1..WARMUP.
    The warm pass follows the miss pass at once, with no extra discarded request. Time = `time.perf_counter()` around the whole HTTP call (client wall time), in ms.
    The Python daemon has no cache of the search result itself, so "warm" is not the TypeScript "L1 hit"; the file says so (D3 not_measured/gates).
    FROM-CALLERS (evaluation/latency_eval.py:35-47 sequential client wall time; src/ctc/server/hooks.py:372 body {q, cwd, k, explain};
    evaluation/retrieval_eval.py:51 NEUTRAL cwd); nonce instead of a Redis flush YOUR-CHOICE (a flush would delete keys the daemon uses: O7 spirit)
D11 Pre tier. `--repo DIR` (default: the git toplevel of the current directory) lists `git ls-files`; the module samples `N_PRE` paths with the D10 seed
    and posts `pre_body(repo, relpath) = {"hook_event_name": "PreToolUse", "tool_name": "Read", "tool_input": {"file_path": <repo>/<relpath>},
    "cwd": <repo>, "session_id": "ctc-baseline"}` to `POST /v1/hook/pre`, sequentially. The first request is a discarded warm-up, followed by a
    `SETTLE_S` pause: the daemon loads the project graph in the background on first sight and answers empty until it is there. `note_rate` =
    share of measured 200 replies with a non-empty body. If `note_rate` is 0 the module prints one warning line to stderr (the repo has no graph in
    the daemon, so the numbers are the empty-reply latency) and still writes the file.
    FROM-CALLERS (src/ctc/server/hooks.py:189-209 budget 0.04 s, RAM only, empty 200 when there is nothing to say; src/ctc/graph/core.py:112-120
    graph_for returns None on first sight); `session_id`, tool and defaults YOUR-CHOICE
D12 SkillRet extraction. `parse_ranking(stdout) -> dict`: find the first line that is exactly `{`, decode one JSON object from there
    (`json.JSONDecoder().raw_decode`), ignore everything before and after (log lines, the significance table). Raise `ValueError` if none or
    if it is not a dict. `skillret_baseline(report, limit=None) -> dict` builds the skillret.json of D3 from that object: keeps `n`, `header`,
    `ranking`; keeps `scores` for dense, hybrid, old and full (a missing mode is an error); rounds metrics to 4; sets `gate` from
    `scores.full["ndcg@10"]`. It does not modify `report`. The child runs in the repo root with the parent's environment.
    FROM-CALLERS (evaluation/retrieval_eval.py:486-489 the object printed with indent=1 first, the table after)
D13 Context recorded in latency.json so a noisy baseline is visible: `host.cpus = os.cpu_count()`, `host.load_1m = os.getloadavg()[0]` taken
    before measuring, and the daemon's `health` (library_version, mode, service states). One run only; no repeats.
    YOUR-CHOICE
D14 CLI. Subcommands `latency`, `skillret`, `all`; `--url` (daemon), `--out`, `--repo`, `--prompts`, `--limit`, `--force`. `all` writes both files.
    `main(argv)` parses `argv` (None = `sys.argv[1:]`) with argparse or by hand; unknown options are exit 2.
    YOUR-CHOICE
