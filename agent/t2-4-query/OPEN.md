# T2.4 planner notes: what the owner reviews in the final PR (O11, O12)

Drafted: `agent/t2-4-query/` (SPEC, DECISIONS D0-D23, PROCESS, checks.mjs with 24 checks, selfcheck.py, `baseline/` with the 30 recorded Python answers and a manifest). YOUR-CHOICE lines: 21 (21 decision ids; every one is a default under O11).
FROM-OWNER: O3 (Python answers are the baseline), O6 (Node 22, no new dependency), O10 (workspace paths), O11 (silence rule, every default below is "A"), O12 (tests use the scratch Postgres and TEI only, never `~/.claude`, :18310 or Supabase).
Status: `node --import tsx agent/t2-4-query/checks.mjs` -> `CHECKS: 0 pass, 24 fail` (module not built); `python3 agent/t2-4-query/selfcheck.py [--fast]` -> `SELFCHECK: FAIL` (module and baseline copy missing). Both fail cleanly.
Validated by the planner: a throwaway reference of the core (D9-D16, D20; not committed) passes the core-only checks D5, D10, D11, D12, D16, D20 and the core parts of D2, D3, D4, D6, D13, D14, D15 (their web parts could not run). The web checks (D1, D17-D19, D21, the web parts above) and D22 were NEVER run against an implementation: expect a few planner mistakes; triage after the first coder run (fix the check, not the code, when a check contradicts DECISIONS.md).
Orchestrator before the coder starts: `python3 agent/t2-4-query/selfcheck.py --snapshot`; keep the scratch Postgres :18304, Redis :18395 and TEI :18300 up (use, never restart).

## A. Cross-task points (ordered by blast radius)
1. **The `graph.query` gate may not be reachable at 27/30 (top risk).** The baseline is the Python daemon's graph (embeddings of its own node texts, `rationale` nodes, `x-` context slugs from docs deleted since). The planner built this repository's graph with the real T2.1-T2.3 pipeline (5,740 nodes, 17,890 edges, rebuild 60 s) and scored the D22 rules with a prototype of the D12-D16 algorithms:
   lexical seeds only 25/30; lexical + TEI dense seeds 27/30 (exactly the bar). Weak rows were search g02, g05, g12 (and g01/g04/g07 without embeddings); explain, path (undirected) and affected rows all passed in the prototype, the 3 error rows always pass.
   So a faithful coder may land at 26 to 28. Options if it misses: (A, kept) report PARTIAL with the printed `GRAPH_QUERY_SCORE`, the owner decides; (B) lower the bar to 25/30 (not done: the spec says 27); (C) widen the search rule to `limit = 20`. The matching rules (50% / 70% / +1 hop / first 3 / `max(k,10)` / vacuous rows) are all YOUR-CHOICE and were set before any coder run, not tuned to it.
2. **Nobody owns the web bootstrap, the MCP server mount or the `ctc:inval` subscription yet.** This task (like T3.2, T4.3) exports plain `Route` / `McpTool` objects and `store.onInval`. Until a later task mounts them, nothing of F1 queries runs on the new stack. The bootstrap must pass `ctxOf`, call `store.onInval` from its subscription, and share one `createGraphStore` between tools and routes (`deps.store`).
3. **`GET/POST/PATCH /api/graph/stats|build|edges` belong to no task in spec §8.** This task builds them (D19) because `/api/graph` is named here and T2.2's code comment already points at `POST /api/graph/build`. `guardTrips` has no source in the repositories: it is `deps.guardTrips?.(ctx) ?? 0`; a later task can count `jobs.error = shrink_guard` rows.
4. **No Postgres `graph_epoch`.** The 60 s poll of spec:205 is an age check at read time plus a Redis epoch compare (D17); `projects.graph_epoch` does not exist in the migrations (the known-red `schema-assumptions.test.ts`). Redis down: a stale index serves for up to 60 s, then a reload.
5. **The path tool is directed by spec (D14) but the baseline ignores direction.** The optional `directed` flag (default true) lets the gate compare apples to apples; two of the four baseline paths exist only undirected. A caller who wants Python behaviour passes `directed: false`.
6. **`graph_search` has a dense channel only when `deps.embed` is given.** Without it (TEI down, unit tests) search is lexical; the plain lexical score favours long doc/test labels with many matching words (coverage²), so quality without embeddings is visibly worse (first prototypes without the embedder: 17/30 with no type filter, 20/30 with the Python `graph` filter).
7. **Prompt-hook reuse.** `lexicalSeeds`, `denseSeeds`, `walkFrom`, `buildIndex` are exported for T5.1, but T5.1 must still add the skill channel, rank "one of each kind" and the 140 ms budget; nothing here is tuned for latency except "one pass over a token index".
8. **`packages/core/src/graph/index.ts` is not touched.** T2.1/T2.2 tests pin its export list (graph.test.ts:361, checks D24 of T2.2), so core is reached as `@ctc/core/graph/query` through the existing `./*` export pattern.

## B. YOUR-CHOICE items (D-id: default | alternative | why it matters)
| D | Default | Alternative | Why it matters |
|---|---|---|---|
| D1 | strict bodies/args, excerpt only under the real root, `sourceFile` with `.`/`..`/absolute never opened | trust stored paths | rows may come from `ctc migrate --from-python` |
| D2 | `charsPerToken 4`, `groupMax 20`, `excerptLineChars 240`, neighbors 50/200, `affectedMax 2000`, `visitMax 200000`, `queryMax 500` cut / `queryHard 20000` reject, `tokenMin 2`, path default 8 | other sizes | reply size and CPU bound |
| D3 | every text line shape and JSON key (`T(n)`, `seed/hopN`, group headers, `no matches`, `no neighbors`, `[truncated: N more]`) | Python's shapes | agents parse these lines; they are frozen once T5.x and the dashboard use them |
| D4 | messages `no node matching '<name>'`, `'<name>' matches N nodes, pass one id`; first problem only | all issues | clients may match on the text |
| D5, D8 | tolerant defaults (empty over error, stale over none) | strict | silence rule |
| D6 | visited cap, read-only, no DROPPED/dangling | - | safety list |
| D7 | non-goals split (bootstrap, T5.1, T5.2 own the rest) | build more here | see A2 |
| D9 | file layout, `@ctc/core/graph/query`, exact export lists, `GraphApiDeps` | other names | later tasks import these |
| D10 | duplicate edge keeps strongest, unknown confidence = AMBIGUOUS, `hubCut = max(hubMin, p99 at ceil(.99n)-1)` | drop unknown | p99 on a graph under 100 nodes is the max degree, so its top node is always a hub |
| D11 | `key()` strips `()` and a leading `.`; bare-path form; suffix match (`b.ts::helper` finds `src/b.ts`); last-`::` split; Dice on bigrams for `nearest` | exact path only; other similarity | decides what resolves vs `ambiguous`; two readers differ (C1) |
| D12 | IDF `ln(1+N/(1+df))`; `coverage` = matched/query tokens; seed lexical scores normalised to best = 1; product of edge weights along the walk; seeds always expand; ties by id; text budget counts characters × 4 | label-length-aware coverage; hubs skipped even when seeds | changes which node is "top seed"; see A1, C2 |
| D13 | group order relation asc then `out` before `in`; 20 per group; excerpt = `meta.lines` start, 40 lines, cleaned | Python's `in` first | ordering of every explain |
| D14 | `directed` flag; no path is a normal reply; BFS ties by sorted edges | error on no path | see A5 |
| D15 | `affected` entries carry `relation` and `via`; groups by type; 2,000 cap | flat list | dashboard rendering |
| D16 | neighbors `limit` 50/200, self loop twice, order | no limit | reply size |
| D17 | LRU 8 projects, 60 s age check, Redis epoch compare, stale on failure, `onInval` events | Postgres epoch | see A4 |
| D18 | optional `cwd` on every tool (as T4.3), `directed`, neighbors `limit`, `onToolCall` | require `ctx.projectId` | without `cwd` an MCP client cannot name a project; `onToolCall` feeds T5.2's 30-minute quiet rule |
| D19 | `project_id` query field, comma list for `types`, edge review rotates the graph epoch, `guardTrips` hook | other param names | see A3 |
| D20 | whitespace collapsed to one space; ids and paths cleaned too | clean labels only | a cleaned id can differ from the stored one (output only) |
| D22 | matching rules and thresholds of the 30 questions | stricter / looser | the gate; see A1 |
| D23 | allowed paths; `fixtures/py-baseline/graph-answers.json` copy | keep the baseline only under `agent/` | `agent/` may be archived; the test must not depend on it |

## C. Places where two reasonable readers would differ
1. **Name resolution of paths** (spec:331 "`path::symbol`"): exact `sourceFile` only, or also a suffix (`b.ts::helper`)? A bare file path as a name (`src/ctc/server/mcp.py`, baseline g19)? D11 accepts both.
2. **"coverage²"** (spec:305): matched query tokens over query tokens (D12), or over the union with the label's tokens (penalises long labels; not measured on the final rules).
3. **"skipping hubs"** (spec:308): never expand a hub, or expand it when it is a seed (D12: seeds expand, so a file node found by its name still lists its symbols).
4. **"seed × 0.5^hop × confidence weight"**: the weight of the last edge or the product along the path (D12: product).
5. **`graph_path` "directed"**: strict (D14 default) or fall back to either direction when none exists.
6. **"reverse BFS over `contains`"** (spec:328): affected(function) includes its file and then every importer of that file (D15 follows the list literally), which makes affected sets large (the prototype returned 54 to 203 nodes at depth 3 where the baseline listed 18 to 61 code nodes).
7. **Token budget** ("≤ 2,000 tokens"): characters / 4 (D2) or a real tokenizer; whole lines only, footer outside the budget.
8. **Baseline owner** (spec:366 says graphify, O3 says Python): O3 and the O11 default "A" of `agent/t0-OPEN.md` item 4 were followed. T0.1's own recorder was never run, so the planner recorded the 30 answers (same questions, argument names and project as `evaluation/record_fixtures.py`; manifest in `baseline/manifest.json`, daemon `library_version 196c3ab5…`).
9. **`explain` neighbours of the baseline** include `implemented_in`, `references` and `indirect_call` edges the TS pipeline does not produce; D22 therefore counts only baseline neighbours of type `code` and needs 50% of them.
10. **Dashboard/MCP project selection**: optional `cwd` (D18) versus a `project` argument like the Python tools.
