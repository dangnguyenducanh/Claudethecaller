# T4.3 planner notes: what the owner reviews in the final PR (O11, O12)

Drafted: `agent/t4-3-recall/` (19 decisions D0-D18, 19 checks) and the eval set `agent/t4-3-recall/eval/` (120 memories, 50 hand-labelled queries, TEI vectors). FROM-OWNER: O2 (no private memories or transcripts committed: the eval corpus is written from committed repo files), O11 (silence rule, every default below is "A"), O12 (tests use `mkdtemp` claude_home dirs, fakes for TEI and llama, the scratch Postgres and Redis only; never `~/.claude` or :18310).
Status: `node --import tsx agent/t4-3-recall/checks.mjs` → `CHECKS: 0 pass, 19 fail` (module not built); `python3 agent/t4-3-recall/selfcheck.py [--fast]` → `SELFCHECK: FAIL` at the eval copy and preflight (entry files missing). The checks have never run against an implementation: expect a few planner mistakes; triage after the first coder run (fix the check only when the decision says otherwise).
Measured by the planner (scratch Postgres, real schema, committed vectors, 4 runs, identical): RRF@5 0.920 vs vector-only 0.900 with the repository's AND full-text leg; OR semantics gave 0.79-0.85. The gate therefore passes on the current leg with a 0.02 margin.

## A. Cross-task points (ordered by blast radius)
1. **Nobody owns the web bootstrap, the MCP server or the worker main yet.** This task (like T3.2, T4.1, T4.2) exports plain `Route` / `McpTool` objects and job handlers. Until a later task mounts `hookStartRoute`, `memoryRoutes`, `memoryTools`, binds `memoryJobHandlers` and `watchMemoryFiles`, nothing of F3 runs on the new stack, and the T7 switch-over (`.claude/settings.json` SessionStart → `curl -m 1.5 /v1/hook/start`) has no server. The bootstrap must also pass `ctxOf`, cap hook bodies at 1 MB, and serve a string reply as `text/plain`.
2. **The session-start query rarely hits the full-text leg.** The query is `project name + last next_steps` (spec:527) and the leg is `plainto_tsquery` (AND of every word), so a long query matches almost nothing and start-time recall is in practice vector-only (plus the recency/reinforcement/pin factors). Kept on purpose: OR semantics measured worse (the `simple` config has no stop words). Alternative: an `english` or stop-word-filtered OR leg, re-measured on the eval set.
3. **No project known at session start → global-only block** (D12 step 4). A brand-new project gets the user's global memories but no summaries and no cache until the spool drain creates its `projects` row. Alternative: upsert the project in the hook (a write in the hot path) or reply empty.
4. **Distill sees only the newest 12,000 chars of user words per transcript** (T4.2 A1, no extract cursor). Old long sessions lose their early facts. Alternative: the T4.2 A1 migration (`sessions.extracted_turns`) before backfilling history.
5. **`projectDirName` is a guess** (D15): `root.replace(/[^A-Za-z0-9]/g, '-')` matches `-home-aiface-dangnguyenducanh-claudethecaller` but is [UNVERIFIED] for roots with `_`, `.`, or non-ASCII characters. A wrong guess only skips that project's memory files (counted `skipped`). Proof: list `~/.claude/projects/` next to `select root from projects` (owner, read-only).
6. **The `ctc: ` prefix on every block line** (D3) costs 5 chars per line of the 10,000 budget but lets T4.2 `sanitize` strip the whole block if Claude Code stores SessionStart output inside a user turn ([UNVERIFIED], T4.2 A4). Alternative: one header line and no prefix (needs a different strip rule in `sanitize`).
7. **Global memories do not refresh other projects' cached blocks** until the 10 min `ctx:` TTL (T4.2 A8): `mem_epoch` is per project; `save_memory` / import / PATCH of a global row rotate nothing.
8. **`bandPorts` moves from the worker into `@ctc/core/memory`** (D13) so the web (`save_memory`) and the worker (`memory.import`, `llm.extract`) share one implementation. The T4.2 worker code is edited; its tests and gates must stay green (the self-check runs `pnpm -r test`).
9. **The `/api` memory routes are owned here** (D14) although spec §8 names no task for them; the dashboard rework has no frontend spec (O12), so nothing calls them yet.
10. **Distill backfill is slow on purpose**: 20 extract jobs per run by default (500 max) on the single-slot `llm` queue, and live Stop extracts queue behind them. There is no priority between live and distill jobs.

## B. YOUR-CHOICE items (D-id: default | alternative | why it matters)
| D | Default | Alternative | Why it matters |
|---|---|---|---|
| D1 | threat list; every DB string re-cleaned before the block | trust stored text (sanitized at write) | PATCHed or imported rows bypass the extract sanitize |
| D2 | `searchDefault` 20, `queryMax` 500 (cut), `maxImportBytes` 64 KiB, debounce 3 s, `distillMinAgeMs` 1 h, distill 20/500, head 64 KiB | other sizes | MCP reply size; backfill speed vs. live extract latency |
| D3 | block layout with `ctc: ` on every line; `cleanLine` (whitespace collapsed); `MemoryView`; result count shapes; `model_unavailable` in an MCP error | multi-line fields; no prefix | a newline in a stored field would otherwise break the line prefix rule; see A6 |
| D4 | per-file skips counted; query cut not rejected; foreign id = 404 | fail the job; reject long queries | one bad file never blocks an import |
| D5 | odd inputs listed stay valid | — | — |
| D6 | no DB write on the hook path; no reinforcement on re-import; logs carry no text | touch memories at start | start latency; inflated reinforcement from a file being re-read |
| D7 | ownership split (bootstrap, worker main, T7.1, no extract cursor) | do more here | see A1, A4 |
| D9 | `recallLimits` (core) vs `memoryApiLimits` (shared, Zod) split; plain objects; http.ts reused | one limits object | `@ctc/shared` cannot import `@ctc/core`, so `textMax`/`distillMax` repeat values |
| D10 | age from `updatedAt`; tie rules; non-finite → 0 | age from `createdAt` | a reinforced memory counts as fresh |
| D11 | "halve" repeated until it fits (floor), field steps apply to every summary, measure = `text.length` | halve once, then cut | see C1 |
| D12 | no project = global-only; timer → 204 while the work finishes and fills the cache; `''` cached; label = last root segment | reply empty; upsert the project | A3 |
| D13 | `cwd` optional arg on the MCP tools; `confidence: 1`; `source {type:'mcp'}`; search without a project covers all of the user's rows; `touch` only on `mem_get` | require ctx.projectId | without `cwd` an MCP client cannot reach project scope |
| D14 | 8 `/api` routes here; PATCH text re-embeds inline; history `status` default `imported` | leave to a dashboard task | A9 |
| D15 | text = `description` else first body line; `user` → global, others → project by dir name, unknown dir skipped; `confidence: 1`; no reinforcement on re-import | store unknown-dir files as global | A5; global pollution |
| D16 | min age 1 h; `known` = any history row (a resumed transcript is not re-distilled); no project creation; runner/bad names → `skipped` rows | re-distill on size change | duplicates vs. missed resumed sessions (their Stop hooks extract them live) |
| D17 | `recallLegs` takes `queryVector: null`; new `history.byPaths` (≤ 500) | zero vector; page `listByStatus` | TEI-down path (spec:206); distill without N+1 queries |
| D18 | planner-written labels; Recall@5 = macro mean of `|rel ∩ top5| / |rel|`; vectors committed (941 KB) | embed at test time | CI has no TEI; the coder cannot tune the set |

## C. Places where two reasonable readers would differ
1. "Drop in fixed order: notes → investigated → older summaries → **halve the memories** → last summary" (spec:528): halve once or until it fits; per-field steps on every summary or on the oldest first (D11 picks: repeat, every summary).
2. "**Age**" in the recall score (spec:489): since creation, last update, or last reinforcement (D10: `updatedAt`).
3. "Query = **project name** + last summary's next_steps" (spec:527): the full root path or its last segment (D12: last segment).
4. "Old transcripts **from `history_files`**" (spec:525): `history_files` as the source list (filled by someone else) or as the record of what distill already did (D16: the record; the source is the `claude_home/projects` tree).
5. "**1 at a time**" (spec:525): one extract job per distill run, or many jobs run one at a time by the `llm` queue (D16: the queue's concurrency 1).
6. "`mem_search` → **index rows**" scope: the current project or all of the user's memories when the tool call has no project (D13: all; with `cwd`: global + that project).
7. "The **file is never written**" (spec:524): does a deleted file delete its memory? (D7: no.)
8. "**Hand-labelled**, this project's memories" (spec:818): the owner's real memories (private, O2) or a committed set written about the project (D18: committed, planner-written).
9. "Over 1,200 ms → empty reply; **the cached block is used on the next start**" (spec:562): the late result is cached (D12 step 0) or the previous block is served stale.
10. `save_memory` reply "id" (spec:537): just the id or `{id, action}` (D3: both).
