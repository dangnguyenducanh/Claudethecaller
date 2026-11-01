# m6 design: context graph + coding graph

Date: 2026-10-26 · Owner-approved decisions: grilling record Q1–Q26 · Target: this repo (claudethecaller) first.
Marked **[call]** = a builder-level choice made while writing this, not discussed with the owner.

## 1. Intent

claudethecaller exists because coding agents rarely use what is installed for them (0.5% of tool calls were Skill calls). The same gap exists for *project knowledge*: the agent writing code here does not see which spec, task or decision it is working under, or which functions already implement a requirement, unless someone pastes it in. m6 gives the agent two graphs and pushes the relevant slice of them into the session, so it follows the spec and lands in the right code.

- **Context graph**: what should be built and why — features, user stories, requirements, success criteria, tasks, tickets, decisions, constraints, PLAN.md steps, and claude-mem observations.
- **Coding graph**: what exists — graphify's AST graph of the repo — plus links from context nodes to the code that implements or tests them.

Why now (our guess, the owner skipped this question): the m5 runner and the n8n-parity work produced 17 tickets, 170 tasks and dozens of decisions; agents re-derive or contradict them, and the graphify graph alone can't say which function a requirement lives in.

## 2. Goals, non-goals, anti-goals

**Goals**
1. Build both graphs for this repo, stored in Supabase, refreshed without manual steps.
2. Push: on each prompt, one short line naming the matching task/story/requirement and its code; before Claude reads or edits a file, a short note naming the tasks, requirements and decisions tied to that file.
3. Pull: MCP tools to search, explain, find impact and find paths across both graphs.
4. Context generation follows claude-mem's procedure (mode file, background observer with `claude -p`, skip/dedup), triggered by speckit's step hooks and by doc saves.
5. Prove it on n8n-parity history (section 8).

**Non-goals (m6)**
- Other projects, shared/team mode upload, the m5 runner's agent nodes (later steps).
- A dashboard graph view **[call]**: `ctc graph export` + graphify's own `graph.html` cover viewing. Say so if you want a React Flow view in m6.
- Fixing graphify's weak spots (unnamed communities, noisy label matching, structural-only docs, worktree commits skipped) or changing graphify/claude-mem code.

**Anti-goals (would be a failure even if it works)**
- A push line on most prompts that points at the wrong files: agents learn to ignore it. It must abstain under a tuned floor.
- Any hook over budget or blocking: prompt p95 ≤ 150 ms (existing), PreToolUse ≤ 50 ms, all fail-open.
- The extractor burning quota: on unchanged chunks, on its own prompts (hook recursion), or in a retry loop.
- A silently stale graph: `ctc graph status` must show graphify's `built_at_commit` vs HEAD and per-source ages.
- Writing claude-mem's database, or the real `~/.claude` without the owner's yes.

## 3. Constraints (from PLAN.md / CLAUDE.md)

- Python 3.12 in the daemon; no new dependencies: no networkx, no graphify import (BFS by hand over dicts). graphify and claude-mem are external tools reached through files, CLIs and HTTP only.
- Supabase is the only source of truth; Redis cache-only; tests use a scratch Postgres (`ctc-dev-pg` :18304 or a lane DB), never the Supabase URL. Applying the schema to live Supabase needs the owner's yes at that moment.
- Embeddings: the running TEI embedder (:18300, 1024-dim); no new model, GPU budget unchanged.
- LLM work: the pinned `claude -p` on the owner's subscription login (preflight must show `apiKeySource: none`), `--model haiku`. No API key. The local Qwen 3B is not used here.
- `ctc install` changes to the real `~/.claude` need the owner's yes; test with `CTC_CLAUDE_HOME=<tmp>`.

## 4. The two graphs

**Node ids** **[call]** — stable across rebuilds, namespaced by source:
- `ctx:specs/001-n8n-parity:US1`, `…:FR-012`, `…:SC-003`, `…:T012`; feature node `ctx:specs/001-n8n-parity`
- tickets `ctx:.scratch/n8n-parity:ticket-09`; PLAN.md steps `ctx:PLAN:WB2`; CLAUDE.md decisions `ctx:CLAUDE:decision:<date>:<n>`
- Claude-extracted nodes `ctx:<file>:<slug>`; claude-mem `ctx:claude-mem:obs-<id>`
- code nodes: `code:<graphify id>`

**Context node types**: feature, story, requirement, criterion, task, ticket, decision, constraint, plan_step, observation.

**Edges** (relation · from → to):
- context: `has_story` feature→story · `needs` story→requirement · `measures` criterion→story/feature · `serves` task→story · `part_of` task→ticket · `blocks` task→task, ticket→ticket · `constrains` decision/constraint→requirement/task/plan_step · `refines` requirement→requirement
- context→code: `implemented_in` · `tested_by` (targets under `tests/`) · `mentions` (doc names a symbol without claiming it implements it)
- code→code: graphify's own relations, imported unchanged.

Every edge carries `confidence` EXTRACTED | INFERRED | CONFIRMED, a `score` (1.0 for EXTRACTED), and `origin` parser | claude | graphify | claude-mem | commit | session.

**Imported from graphify**: nodes with `file_type` code or rationale and the edges among them. Document/concept nodes and hyperedges are dropped.

## 5. How the graphs are built

**5.1 graphify import (coding graph).** graphify keeps running as installed (post-commit hook, hook-guard). claudethecaller reads `graphify-out/graph.json`; it re-imports when `built_at_commit` differs from the stored one, checked lazily on the next hook call (a stat + one JSON field), or on `ctc graph import`. Worktree commits stay invisible until a main-checkout commit (graphify limit).

**5.2 Parser (context graph, no LLM).** Reads:
- `specs/*/spec.md`: `### User Story N - title (Priority: Pn)`, `**FR-###**:`, `**SC-###**:`; `plan.md` sections; `tasks.md`: `- [ ] T### [P] [US#] text`, phase headers naming a ticket (`— ticket 01 …`), file paths in backticks or bare `src/…`, `tests/…`.
- `.scratch/*/spec.md`, `.scratch/*/issues/NN-slug.md` (title, Status, Touches/file paths, blocking refs), `dispatch.md` locks.
- `PLAN.md` step ids (`#### M1:`, `**WB2 — …**`, `B9`, `K2` …) and their Done-when lines.
- `.claude/prds/*.md` headings and requirement bullets; CLAUDE.md `**Decisions**` bullets (`- YYYY-MM-DD — …`).
Exact rules for these patterns are the builder's; each source gets a `__main__` self-check on the real files with expected counts.

**5.3 Background extractor (claude-mem procedure).**
- A **context mode file** **[call: `config/context-mode.yaml`]** in the shape of claude-mem's `modes/code.json`: node types and edge relations above, field rules (title; facts that stand alone, no pronouns; source line), skip rules (nothing new → `<skip reason=…/>`), dedup by content hash, and the XML output schema.
- Input: only chunks (a heading section) whose content hash changed since the last pass, plus the parser's nodes for that file so Claude links rather than re-creates them.
- Runs as a job kind in the existing daemon job queue (`server/jobs.py`), one chunk per `claude -p --model haiku` call, no tools, max 1 turn, using `runner/proc.py`'s argv/env/preflight/quota detection. cwd under `~/.claudethecaller/extract/` so claudethecaller's own hooks skip these sessions (same idea as `_in_run`) **[call]**.
- Output XML → nodes/edges with origin `claude`, confidence INFERRED. A cache keyed by (chunk hash, mode-file hash) avoids paying twice (graphify's cache idea).
- Quota hit → the job parks until the reset time the runner already parses; token totals logged per pass.
- Skill `/ctc-context` (project skill under `.claude/skills/ctc-context/`): `build` (parser + import now), `extract` (queue the Claude pass now), `status`, `review` (after_implement link review).

**5.4 Triggers.**
- `.specify/extensions.yml`: mandatory `after_specify`, `after_plan`, `after_tasks` → `/ctc-context build`; `before_implement` → print the task→code matches for the feature; `after_implement` → `/ctc-context review`.
- PostToolUse (existing `/v1/hook/tool`): a Write/Edit under `specs/`, `.scratch/`, `PLAN.md`, `.claude/prds/`, `CLAUDE.md` queues a parser rebuild for that file (background, inside the 50 ms budget), which in turn queues the extractor for changed chunks.

**5.5 Matching context → code.**
1. EXTRACTED: file paths and `module.symbol` names in tasks/tickets → file or symbol nodes; commits whose subject/branch names a ticket (`(n8n parity 09)`, `n8n-09-…`, `merge: ticket 09 …`) → the symbols whose line ranges the commit's hunks touch (symbol = nearest preceding graphify node start line in that file **[call]**); claude-mem observations' `files_read`/`files_modified`.
2. INFERRED: cosine between requirement/story/task text and code node text (label + docstring + path) above a floor; top-k per context node.
3. CONFIRMED: (a) when a `tasks.md` box flips to `[X]`, files Claude edited in that session since the previous flip → `implemented_in` for that task (needs the PostToolUse event to keep `file_path` for Edit/Write); (b) in `after_implement`, Claude keeps or drops the feature's INFERRED links via `ctc graph confirm <edge> keep|drop` **[call: CLI, not an MCP tool]**.
Commit-derived edges can be switched off (eval needs it).

**5.6 claude-mem import.** Read-only from `http://127.0.0.1:37707/api/observations` (project `dangnguyenducanh/Claudethecaller`), types decision, bugfix, feature, refactor, discovery; incremental by last seen id; skipped silently when the worker is down.

## 6. Storage

Schema in `src/ctc/storage/schema.sql` (idempotent, `{schema}`, `user_id text not null default 'local'` like other tables) **[call on exact columns]**:
- `graph_nodes (user_id, project_id, id, kind 'context'|'coding', type, label, text, source_file, source_line, content_hash, embedding vector(1024), origin, updated_at)`, pk (user_id, project_id, id)
- `graph_edges (user_id, project_id, src, dst, relation, confidence, score, origin, updated_at)`, pk (user_id, project_id, src, dst, relation)
- `graph_sources (user_id, project_id, source, version, updated_at)`: graphify `built_at_commit`, per-file hashes for parser/extractor, last claude-mem id.
Each daemon worker keeps a RAM copy per project (adjacency dicts + one float32 matrix of node embeddings), loaded at start and after any import, like `Store._load_vectors`. Only changed nodes are re-embedded (content_hash). `ctc graph export --kind context|coding|both` writes graphify's `graph.json` shape so `graphify query --graph <file>` and `graph.html` work; nothing generated is committed.

## 7. What the agent gets

**Push, on each prompt** (added after the existing suggestion line in `hooks._prompt`; the prompt vector comes from `hooks._embed`, whose `emb:` cache already holds it from `route()`, so no extra TEI call): nearest context nodes by cosine; if the best clears the floor, follow `implemented_in`/`tested_by` (CONFIRMED > EXTRACTED > INFERRED) and print one line ≤ ~80 tokens, e.g.
`ctc graph: T012 [US1] retry from a node → src/ctc/runner/engine.py retry() L120, claim() L180 · decision: never re-run a side effect`
Otherwise nothing. Lines are recorded on the decision row for the eval and dashboard.

**Push, before Read/Edit/Write/MultiEdit** (new route `/v1/hook/pre`, matcher `Read|Edit|Write|MultiEdit`, `curl -m 0.05`): RAM lookup by file path → up to 3 tasks/requirements and 1 decision/constraint tied to that file, ≤ ~60 tokens, as additional context; empty when nothing links. The builder must confirm Claude Code 2.1.306 accepts `additionalContext` on PreToolUse; if not, emit it from PostToolUse instead.

**Pull, MCP on `/mcp`**: `graph_search(question, graph='context'|'coding'|'both', k=8)` (entry by meaning + 1–2 hop expansion, ~1.5k-token budget, says when truncated), `graph_explain(node)`, `graph_affected(node)` (code callers + linked tasks/requirements), `graph_path(a, b)`.

**CLI**: `ctc graph import | build | status | export | confirm`.

## 8. Proof (eval)

`evaluation/graph_eval.py` **[call: next to retrieval_eval.py]**:
- Truth: for each n8n-parity ticket NN, the non-test source files changed by commits whose subject ends `(n8n parity NN)` (from `git log --all`).
- Prompt: the ticket's title from `.scratch/n8n-parity/issues/NN-*.md`.
- The graph is built with commit-derived edges **off**.
- Metric: Recall@3 = share of tickets whose push line names at least one truth file among its first 3 code pointers (abstain = miss).
- Dev = tickets 01–08 (tune the floor and top-k), test = 09–16 (report only). Ticket 17 has no `(n8n parity 17)` commit, so it has no truth and is left out **[call: the owner approved 09–17; 17 cannot be scored]**.
- Pass: test Recall@3 ≥ 0.8; prompt-hook p95 ≤ 150 ms and PreToolUse p95 ≤ 50 ms with the graph loaded; false-trigger rate ≤ 10% on MetaTool's no-tool negatives from `evaluation/loaders.metatool()` **[call: added so "abstain under a floor" is measured]**; `ctc graph build` prints counts of stories, requirements, tasks, decisions and the % of tasks with ≥ 1 code link.

## 9. Build steps (milestone m6, branch `m6-graph` from `staging`)

| Step | What | Done when |
|---|---|---|
| G1 | Tables + graphify import (coding graph), RAM copy, `ctc graph import/status` | `uv run ctc graph import` prints node/edge counts matching graph.json's code+rationale subset; status shows built_at_commit vs HEAD |
| G2 | Parser (context graph) for all sources in 5.2 | `uv run ctc graph build` prints 16 stories for 001-n8n-parity plus FR/SC/T/ticket/decision counts; self-checks pass |
| G3 | Embeddings + EXTRACTED/INFERRED links + claude-mem import | build prints % of tasks with ≥ 1 code link; T012-style tasks link to the files they name |
| G4 | Mode file, extractor job, `/ctc-context` skill, `.specify/extensions.yml`, PostToolUse re-parse | editing a spec.md section adds/changes nodes with no manual run; an unchanged re-run spends 0 Claude calls |
| G5 | MCP pull tools + `ctc graph export` | `graph_search("retry a failed run from a node")` returns engine.py symbols; exported file loads in `graphify query --graph` |
| G6 | Push line + `/v1/hook/pre` + `ctc install` for PreToolUse | `CTC_CLAUDE_HOME=<tmp> uv run ctc install --dry-run` shows the new hook; curl on both hooks returns the expected lines |
| G7 | Eval (section 8) | prints dev/test Recall@3, false-trigger rate, hook p95 against the pass bar |

Order: G1, G2 → G3 → G5, G6; G4 alongside G3; G7 last. Each step ends with `scripts/check.sh` green.

## 10. Left to the builder

Exact parser regexes; the mode file's prompt wording (start from claude-mem's `modes/code.json` sections); chunking (one `##`/`###` section, capped by size); top-k and expansion depth inside the token budgets; how session file edits are kept for 5.5-3a (event payload); the PreToolUse output field (verify against the installed Claude Code); RAM structures.

## 11. Known limits at ship

graphify: unnamed communities, label-match noise (bypassed by our embedding entry), structural-only doc nodes (not imported), worktree commits skipped. claude-mem: only 2 observations for this repo today; capture starts in a fresh session. n8n-parity's tasks.md boxes were never ticked, so 5.5-3a only helps future work. One project, local mode only.
