# Phase 0 open items (T0.1, T0.2, T0.3)

37 lines are tagged YOUR-CHOICE (T0.1 11, T0.2 11, T0.3 15), in 33 decision ids. The three D8 silence rules are template wording. The rest are grouped below;
"A" = my default, "B" = the alternative. Section 1 needs an owner answer before the run; sections 2 and 3 are defaults I would keep unless told otherwise.

## 1. Needs the owner (could change what is recorded)

| # | Where | Question | A (default) | B | Why it matters |
|---|---|---|---|---|---|
| 1 | T0.1 D9 vs O1 | `data/processed/own-eval.jsonl` has **71 rows**, not 100 (36 test + 35 dev; 16 have `gold: []`). | 71 own + 129 SkillRet = 200 prompts | exactly 100 SkillRet + 71 own = 171; or wait for K1/H1 to label more | O1 says 100 + 100; the in-domain share of the baseline is 35%, not 50%. |
| 2 | T0.3 D1, T0.1 D6 | Reading Supabase. T0.3's real export is a `SELECT` on Supabase (`decisions`, `events`; the scratch `ctc` copy holds 12 decisions and 0 events, a stale copy). O7 says Supabase is untouched until T7.1. | module refuses Supabase unless `--allow-supabase`; tests use the scratch DB only; the real export waits for your yes | run it now with `--allow-supabase` (read-only transaction); or defer T0.3 to T7.1 | decides whether T0.3 can be "done" in phase 0 at all. The same question applies to the `pg_dump` source for T1.2 (O7). |
| 3 | T0.2 D1, D3 | No `/v1/suggest` exists in Python, and `/v1/hook/prompt` writes session and decision rows to the daemon's database. | measure `POST /v1/search` (miss, warm) and `POST /v1/hook/pre`; list `hook/prompt` and `/v1/suggest` as `not_measured` | start a scratch daemon on a scratch DB and measure `hook/prompt` and the whole chain (needs "start the daemon") | `suggest.latency` (T5.1) compares a 140 ms hot path with a number that does not include the hot path. |
| 4 | O3 vs spec 366 | Spec `graph.query` says "match **graphify's** >= 27 / 30"; O3 makes the **Python** answers the baseline. Python tool arguments differ from the spec (`question`/`node`/`a`,`b` vs `query`/`name`/`from`,`to`; no `depth`). | record the Python answers with Python argument names (T0.1 D13) | also record graphify's answers (no daemon needed) | T2.4's gate text and the fixtures must agree before T2.4 is planned. |
| 5 | Coder brief vs T0.1 / T0.2 PROCESS step 1 | The fixed coder brief says "do not use the network". PROCESS step 1 says run the real producer; the producer is the daemon on `127.0.0.1:18310` (read-only), and T0.2 needs the scratch Postgres. | allow loopback use of the daemon and the scratch DB for the coder | the coder never touches them; the orchestrator runs `selfcheck.py --live` only | with B, the coder cannot see a real reply, so shape bugs show up late (my checks use fake servers, which cover D-ids but not the daemon's quirks). |

## 2. YOUR-CHOICE, by task (keep unless told)

| Task | D | A (default) | B | Why it matters |
|---|---|---|---|---|
| T0.1 | D3 | file layout: `search.public.jsonl`, `local/search.own.jsonl`, `graph.jsonl`, `api-shapes.json`, `manifest.json` under `fixtures/py-baseline/` | one file per subcommand set, or the `data/` tree | T2.4, T5.1 and T7.1 read these names. |
| T0.1 | D3 | graph row keeps `text` whole and `structured` | text only | the TS port must reproduce `structured` (hits, links, confidence); text only hides field drift. |
| T0.1 | D4 | exit codes 0/2/3/4/5, `.part` + atomic rename, refuse to overwrite without `--force` | overwrite silently | a baseline overwritten by a later run is lost. |
| T0.1 | D5 | blank queries dropped, duplicates kept once (own wins) | keep everything | changes the row count below 200 only if the data has blanks (it has none today). |
| T0.1 | D9 | seeded sample (`random.Random(0)`) over rows sorted by id | first N rows | a seeded sample avoids bias to early SkillRet ids; "first N" is simpler to read. |
| T0.1 | D10 | two passes per prompt; `stable` flag; library_version checked before and after (exit 4 on change) | one pass | doubles the 200 calls (about 1 minute) and flags nondeterministic rerank ties so T5.1 does not chase noise. |
| T0.1 | D11 | `shape()`: int and float are both `number`; a key missing in some elements gets `?`; an empty list is `[]` (wildcard) | keep int/float apart; record full values | comparers must treat `[]` as "unknown element type". Values are not recorded because `/api` replies are live and private. |
| T0.1 | D13 | questions: 12 search, 7 explain, 5 path, 6 affected; 3 answer with an error on purpose (not found, ambiguous) | 30 happy-path questions | the error cases pin `ambiguous` / `not_found` behaviour that spec 1.6 requires. |
| T0.1 | D14 | manifest keys per subcommand merged in place | one manifest per run | `all` and single runs then leave one file. |
| T0.2 | D2 | `N_LATENCY` 100, `N_PRE` 50, `WARMUP` 3, `SETTLE_S` 3 s | 200 / 100 | more samples tighten p95 but take longer on a shared GPU host. |
| T0.2 | D3 | `gates_for_ts` and `not_measured` stored in `latency.json` | numbers only | keeps the caveat next to the numbers. |
| T0.2 | D4 | exit codes as T0.1; `compare` block dropped | keep the paired-p block | no consumer needs it. |
| T0.2 | D5, D8, D13, D14 | tolerant defaults, host load recorded, one run | three runs, take the median | p95 on a loaded host moves 20 to 30%; one run keeps the cost small but the file shows `load_1m`. |
| T0.2 | D7 | no pass/fail on today's numbers (`gate.met` is data) | non-zero exit below 0.80 | the baseline must record what is, even if it is bad. |
| T0.2 | D10 | cold = nonce suffix (`\n\nctc-baseline-<run>-<i>`) so the embedding cache misses; warm = same strings again | flush `emb:*` in the daemon's Redis like `latency_eval.py` does | a flush deletes keys the live daemon uses (O7 spirit); the nonce changes the text slightly (a few tokens). |
| T0.2 | D11 | pre tier needs a repo the daemon already has a graph for (`--repo`); `note_rate` and a warning say if not | fixed repo path in the module | the worktree has no graph in the daemon, so the orchestrator must pass `--repo /home/aiface/dangnguyenducanh/claudethecaller`. |
| T0.3 | D1, D2, D3 | modes 0600/0700; refuse `--out` inside a git tree; files `decisions-YYYYMMDD.jsonl.gz`, `events-...`, `manifest-...json` | 0644; allow anywhere | the archive holds prompts. |
| T0.3 | D4 | never overwrite (exit 5), no `--force` | `--force` | the archive may become the only copy. |
| T0.3 | D5, D12 | NaN/inf -> null; naive datetime = UTC; bytes -> `"\\x<hex>"` | fail on them | none occur today (columns are `real`, `timestamptz`, jsonb, text). |
| T0.3 | D6, D9, D10 | read-only `REPEATABLE READ` snapshot for both tables; counts first; verify by re-reading the gzip; test with a read-only DSN | `READ COMMITTED`, no verify | one snapshot makes `rows` exact while the daemon keeps writing. |
| T0.3 | D13, D14 | `--dry-run` prints counts only, creates nothing; dir created after the snapshot | create first | a failed run leaves no empty directory. |

## 3. Places where two reasonable readers would differ

- **"Public" fixtures.** The public search file lists the owner's installed skill ids (plugin and skill names such as `superpowers:test-driven-development`) as `top5`. If the repo is shared outside the owner, move `search.public.jsonl` to `local/` too.
- **Library drift.** Search fixtures hold for one `library_version` (stored in the manifest). Any later `ctc index` or plugin update changes the answers; T5.1 must compare against the same library, or re-record both sides.
- **Graph drift.** The 30 graph answers depend on the daemon's graph build of the main checkout (the graph has no version field in `/v1/health`), so a rebuild after the record changes ids and line numbers. Record right after a clean build, or add a node count to the manifest.
- **`--limit` smoke runs** (T0.1/T0.2) apply the limit before the own/public split, so a `--limit 3` run writes only own rows (local). That is deliberate (it tests the privacy rule) but surprising.
- **Skillret baseline reads the `test` split** (4,392 queries) for reporting only; nothing is tuned on it (D7). A reader who treats any use of test as tuning would want the dev split instead.
- **Environment the orchestrator must prepare** (not the coder): `data/` symlink to the main checkout's `data/` in RUN_DIR (gitignored), `CTC_DATABASE_URL` exported to the scratch Postgres (T0.2 `skillret`, T0.3 tests), TEI embedder and reranker up for `skillret`. `uv sync` creates `.venv` in the worktree (gitignored).
- **Spec references that do not exist here:** `.claude/metric/eval/*.md` (latency.md, skillret.md, ...) are cited by the spec but absent in this checkout, so T0.2 defines its own method (D9 to D12). `scripts/check.sh` runs `ruff check src evaluation scripts tests` with no ruff config; the selfchecks do the same on the touched files only.
- **Selfcheck base.** The scope check diffs against `HEAD` plus untracked files and ignores `agent/`, `specs/`, `.claude/agents/`, `.claude/journal/`; the orchestrator can run `selfcheck.py --freeze` to detect edits to the agent files.
- **Not covered by checks.py:** the real MCP calls of `graph` (T0.1 D13) and the live daemon quirks; only `selfcheck.py --live` exercises them.
- **Checks were validated** only against throwaway reference implementations I wrote outside the repo (15/15 each for T0.1, T0.2, T0.3 with a real scratch Postgres for T0.3). The module for each task does not exist; `python3 agent/<task>/checks.py` prints 15 clean FAIL lines.
