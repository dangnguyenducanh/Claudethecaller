# T5.2 planner notes: what the owner reviews in the final PR

Drafted: `agent/t5-2-pre/` (SPEC, DECISIONS D0-D22, PROCESS, checks.mjs, selfcheck.py). YOUR-CHOICE tags: every one is a default under O11 (the more tolerant, less destructive reading).
Status: `checks.mjs` and `selfcheck.py` run and FAIL cleanly while the module is not built (23/23 ids fail with that reason; selfcheck stops at preflight, then scope). The checks were validated against a throwaway reference I wrote outside the repo
(21/23 pass; D21 and D22 need the gate file and the wiring test, which only the coder writes; two deliberate mutants, "charge at run time" and "quiet also silences notes", were caught by D18/D17 and D7/D17); that reference is not shown to the coder and not kept.
The gate `failopen` and the selfcheck sections after preflight (tests, lint, tsc, gate, suites, leftovers) were never run against a real implementation; `verify_results` was exercised on synthetic good and bad result files.
Orchestrator before the coder starts: `python3 agent/t5-2-pre/selfcheck.py --snapshot`; keep TEI :18300, scratch Postgres :18304 and scratch Redis :18395 up (never restart them); export `CTC_SCRATCH_PG_URL` and `CTC_SCRATCH_REDIS_URL`.

## A. Highest risk (ordered by blast radius)
1. **`failopen` is defined here, not by the spec's eval docs.** spec:369 says only "TEI, Redis or Postgres down → prompt and pre hooks still reply within budget". D21 turns that into: real clients pointed at dead endpoints (refused and hanging), in-process handlers,
   5 timed calls per scenario, `budget + 25 ms` slack, content asserted only where deterministic (single dependency down, graph warm). Two readers differ: (a) run it over a real Fastify socket with `curl -m` (the hook as Claude Code sees it; adds a few ms and a
   second process); (b) assert only timing, never content. Timing on a shared GPU host is the flake risk: a busy neighbour can add scheduler jitter above 25 ms, and a hanging Postgres pool keeps handles open (the coder must close pools in `afterAll`).
2. **The session key does not exist on the MCP side.** spec:319 "quiet for 30 minutes after any `graph_*` MCP call in that session", but `onToolCall` (apps/web/src/graph/common.ts:28) carries `{userId, projectId, tool}` and no Claude `session_id`; MCP over HTTP has its own
   session id, not Claude's. D17 falls back: a call with a session id marks that session; otherwise it marks the whole project (user-wide if the project is unknown). Effect: one session's `graph_search` also silences hints of a second concurrent session in the
   same project for 30 minutes. This is the quieter (less intrusive) reading. Alternative: the bootstrap reads `Mcp-Session-Id` and maps it to Claude sessions (needs a new mapping that no task builds), or the quiet window is per project only.
3. **The hot path is RAM only only after the first call.** The store's first `get` after boot loads from Postgres (seconds for a large graph); within the 40 ms budget the hook replies empty and the load continues. D12's memo (30 s) and the `proj:` L1 make later calls RAM-only.
   If the owner wants a note on the very first call, the bootstrap has to warm the store at start (`graph.get` for known projects); that is bootstrap work, not this task.

## B. YOUR-CHOICE items (D-id: default | alternative | why it matters)
| D | Default | Alternative | Why it matters |
|---|---|---|---|
| D1 | paths from the tool input are cleaned and cut to 256 code points | trust the path | a path with `\nctc: ...` could become a second line in `additionalContext` |
| D2 | `itemChars` 80, `tokenMin` 3, `tokenMax` 64, `tokensMax` 4, `commandChars` 4096, memo 30 s / 256, sessions 1000 / 24 h; `note_max` (3) caps tasks, decisions and callers | other numbers; `note_max` for callers only | 3 callers is in the spec; 3 tasks and 3 decisions are not, but a file with 20 tasks would eat the 400 characters |
| D3 | text formats `ctc: <path> · tasks: …; … · decisions: … · callers: …` and `ctc: graph nodes matching this search: p; p`; `PreResult` keys; reason values | other wording | the model reads these strings; spec:317-318 fixes content, not wording |
| D4 | `session_id` of the wrong type is ignored, not a rejection; `tool_name` ≤ 64 | reject | one odd field must not silence the note |
| D5 | tolerant list (relative paths, `./..` inside the project, no-node files, empty graph) | reject some | — |
| D6 | the "must never" list beyond the spec (no log of paths/commands, no reads but `byRoot`, `proj:`, `graph.get`, charge only sent hints) | fewer | pins RAM-only and privacy so a later edit cannot add a TEI call or a file read quietly |
| D7 | no de-duplication of repeated notes, no ancestor walk, `NotebookEdit` excluded, no persistence of counters | add them | each is cheap to add later; each changes what the model sees (see C) |
| D9 | new dirs `packages/core/src/graph/note`, `packages/shared/src/schemas/pre`, `apps/web/src/pre`; `caps` is injected so the bootstrap can share it with `onToolCall` | put it in `push/` | T5.1 pinned the `push` export list; a new dir needs no edit of merged files |
| D10 | pure checks and caps before any I/O | project first | an outside path or a capped session costs no Postgres call |
| D11 | `MultiEdit` is a file tool | exclude | the m6 hook covered it |
| D12 | RAM memo of project lookups (30 s, hits and misses, in-flight shared); `outside` is its own reason | no memo | keeps the hot path RAM-only and bounds Postgres load when it hangs |
| D13 | tasks via `implements`, decisions via `decides`, callers via `calls` from other files; weight desc then id; code nodes only | include `imports`, doc nodes, open/done status | spec:317 names the three lists, not the edge rules |
| D14 | greedy fill by section; the first item that does not fit ends its section; an empty section is dropped | a `renderLine`-style ladder | a cut must not split an item (ORCHESTRATOR lesson) |
| D15 | a parser, not a shell: grep/egrep/fgrep/rg/find, wrappers skipped, first non-option word is the pattern, flag list for value options | handle more commands (`ag`, `ack`, `git grep`) | `git grep foo` is not recognised (command word `git`) |
| D16 | hint = code node whose label has a token equal to or starting with a term; pool 4 × `max_nodes`; ranking by `lexicalSeeds` | any `lexicalSeeds` hit (substring tier included) | substring hits make `grep log` hint `catalog` |
| D17 | count sent hint replies (not nodes); quiet and cap apply to hints only; project- and user-level fallback marks | count nodes; silence notes too | see A.2 and C |
| D18 | charge at send time through `commit()` | charge in `run` | a hint lost to the 40 ms timer must not use up one of the 5 |
| D19 | reason value `error` | — | — |
| D21 | gate method, scenarios, 5 calls, 25 ms slack, no switch, result file shape | see A.1 | the owner has no eval doc to compare with |
| D22 | one new wiring test in `apps/web/src/graph/` | none | proves `onToolCall` → `markGraphCall` → quiet end to end without editing merged files |

## C. Places where two reasonable readers differ
- spec:319 "5 hints per session": D17 counts hint REPLIES (each reply carries up to `max_nodes` = 5 nodes). Counting nodes would allow one reply and stop; counting replies allows five.
- spec:319 "quiet for 30 minutes after any `graph_*` MCP call": D17 silences hints only. Reading it as covering the file note too is a one-line change in `run` (check `blocked` for notes) and in D7/D17; the note carries tasks and decisions that a graph query does not obviously replace, so it stays on.
- spec:317 "the top 3 callers": D13 reads callers as `calls` edges into any node of the file from another file. A reader could mean importers (`imports`) or callers of the file node only.
- spec:316 "RAM only": D12 allows `projectOf` (which may hit Redis or Postgres on a cold memo) and the store's first load; both are bounded by the 40 ms race. A strict reader would require the bootstrap to preload.
- spec:106 "`200` JSON `additionalContext`, or empty" vs spec:147 "`204` empty hook reply": D3 follows `204` (as T4.3 and T5.1); the m6 Python route answered `200` with an empty body. Claude Code treats both as "no output".
- spec:318 lists `grep/rg/find`, `Grep`, `Glob`: D15 also accepts `egrep`/`fgrep`. A literal reader would reject them.
- A note is repeated on every `Read`/`Edit` of the same file in a session (D7: no de-duplication). It is at most 400 characters, but ten edits of one file add ten identical notes.
- A sub-directory `cwd` (session started in `apps/web`) resolves to no project (D7: no ancestor walk), exactly as T5.1's prompt hook does; the hook is silent there.
- Not covered by `checks.mjs`: the real TEI, Postgres, Redis, the real graph (PROCESS step 1 asks the coder to compare D13 with this repo's real edges), the gate numbers (only the gate and the self-check's re-read cover those), the wiring test body (only its presence and key terms).
- `schema-assumptions.test.ts` may still be red at the base (T1.2 migrations lack `projects.graph_epoch` / `mem_epoch`); `selfcheck.py` keeps the `KNOWN_RED` tolerance used by T3.1 to T5.1 for `pnpm -r test`. Remove it once the integration branch has the migration.
