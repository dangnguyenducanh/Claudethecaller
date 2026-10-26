# Implementation Plan: claude-mem memory in the Memories feature (m7)

**Branch**: `m7-memory` (stacked on `m6-graph`; Spec Kit id `003-claude-mem-memory`; one ticket = one commit on `m7-memory`, PR into `staging` after m6's PR #5 merges) | **Date**: 2026-10-26 | **Spec**: [spec.md](spec.md)

**Input**:
- [spec.md](spec.md): 6 stories, FR-001–FR-029, SC-001–SC-010.
- The port inventory [`.scratch/claude-mem-port/inventory.md`](../../.scratch/claude-mem-port/inventory.md), which settles the data model (§3), pipeline (§4), session-start text (§5), MCP/API surface (§6), Memories page (§7), reusable assets (§8) and owner decisions D1–D23 (§9).
- Research: [research.md](research.md).

## Summary

claude-mem's memory loop moves into claudethecaller's Memories feature in four parts:
- **Capture.** A new `observe` job runs once per finished turn. It re-reads the turn from the transcript on disk, strips `<private>`, redacts secrets, and makes one `claude -p --model haiku` call with claude-mem's observer prompts. The resulting observations and turn summaries go into two new tables, `ctc.observations` and `ctc.session_summaries`, which have tsvector and pgvector indexes.
- **Read side.** A new `ctc.memory.observations` module serves hybrid (RRF) search, a timeline, ordered fetch, a feed with counts, and the session-start renderer: claude-mem's agent template, with a 10K budget and a Redis-cached body.
- **Wiring.** A new `/v1/hook/start` SessionStart hook, three MCP tools (`memory_search` / `memory_timeline` / `memory_get`) and `/api` routes.
- **Dashboard.** The Memories page gains a claude-mem-style Timeline tab, and today's page becomes its Long-term tab. Trusted `ctc.memories` is unchanged.

## Technical Context

**Language/Version**: Python ≥ 3.12 (uv) for the daemon; TypeScript + React (pnpm, Vite) for the dashboard.

**Primary Dependencies**: existing only: FastAPI, typer, psycopg 3 + pool, pgvector, numpy, httpx, pyyaml, orjson, `mcp` 2.x, `redis.asyncio`; React and the dashboard's own `ui.tsx`. **No new dependency.** XML parsing uses `re` + `html.unescape`, as claude-mem's `parser.ts` does. External tool: Claude Code 2.1.306 (`claude -p`, owner's login).

**Storage**: Postgres schema `ctc` (Supabase in prod; the scratch `ctc-dev-pg` on 127.0.0.1:18304 for development and tests). Additions:
- new tables `observations` and `session_summaries`;
- new `sessions.observed_bytes` and `observed_prompts` columns ([data-model.md](data-model.md));
- one Redis key family, `ctx:{user}:{project_id}`.

**Testing**:
- pytest (`uv run pytest -q tests`) with the existing `scratch` / `in_store` fixtures (`tests/conftest.py`, skipped without a scratch DB);
- ruff and `scripts/check.sh`;
- `pnpm -C dashboard build` for the dashboard;
- a `__main__` self-check in each new module;
- a fake `claude` script for capture tests. A real haiku call happens only in the quickstart, with the owner's yes.

**Target Platform**: Linux host; daemon on `:18310` + `~/.claudethecaller/ctc.sock`. Capture runs in local mode only; serving also works in shared mode.

**Project Type**: Python service + CLI + React dashboard (single repo).

**Performance Goals**:
- SessionStart: Redis hit returns in ≤ 150 ms total; cold ≤ 1 s (one SQL round trip + render).
- Search: one SQL round trip (~65 ms network to Supabase) + one `emb:`-cached query embed.
- Feed page of 50: one round trip.
- `observe` job: ≤ 8 haiku calls per job, typically 1 per turn.

**Constraints**:
- Hooks fail open.
- No raw prompts or tool output in Supabase beyond today's decisions rule (D1, D2).
- `claude -p` runs on the subscription only (preflight `authMethod: claude.ai`), never with an API key.
- Additive schema only.
- Dev and live tests use the scratch DB, a scratch Redis (`:18395`: the real `:18303` shares consumer groups and `ctx:` keys with the real daemon) and an isolated daemon (`:18311`, own socket, HOME in the scratchpad), all run from a separate git worktree `.worktrees/m7`, because the live daemon runs from the main checkout and serves its `dashboard/dist`.
- Each of these needs the owner's yes: production Supabase schema, real daemon restart, real `~/.claude` install.

**Scale/Scope**:
- 8 tickets (O1–O8) in 4 waves.
- Current sizes:

  | Area | Files (lines) |
  |---|---|
  | Server | hooks.py 408, mcp.py 151, jobs.py 130, library.py 426, api.py 389, schemas.py 493 |
  | Storage, LLM, CLI | schema.sql 312, client.py 80, cli.py 925 |
  | Dashboard | Memories.tsx 92, parts.tsx 235, Sessions.tsx 98, Jobs.tsx 109, App.tsx 204, types.ts 127, api.ts 173, mock.ts 484, styles.css 220 |

- New code: about 1.3–1.7k Python lines and about 600–800 TSX/CSS lines.
- Measured load: about 43 observations a day on this host.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is the unfilled template, so the gates come from `CLAUDE.md` and `PLAN.md` "Constraints" (same as m6):

| Gate | Status |
|---|---|
| Stay in scope; one branch per phase; Conventional Commits; PR into `staging` | PASS. Branch `m7-memory`, one commit per ticket, PR after O8 with the owner's yes. |
| Shortest working solution; stdlib + chosen deps; no one-implementation abstractions; `ponytail:` on corner-cuts | PASS. No new deps; plain functions in two modules. Corner-cuts are listed in Complexity Tracking. |
| Built from scratch; outside projects are references, never dependencies | PASS **with a new Decision** (FR-027, D22). claude-mem 15.2.1 is an Apache-2.0 source of translated text and logic, never imported or run. Attribution is in `third_party/claude-mem/` and file headers. |
| Hook suggests, never blocks; fail-open; ≤ 150 ms | PASS **with a recorded exception** (D16). SessionStart is allowed `curl -m 1` because it runs once per session. The cache is kept warm by `observe`, so normal starts are Redis hits. All other hooks are unchanged. |
| Models local, ≤ 7 GB GPU | PASS **with a recorded exception** (D3). Observation capture uses `claude -p --model haiku` on the owner's login, after `<private>` stripping and redaction. The GPU is unchanged; the existing TEI embedder is reused. |
| Raw transcripts never leave the machine as stored data | PASS. Only derived observations and summaries are stored. The haiku call sends redacted turn text to Anthropic, which is the D3 exception. |
| Redis cache-only; Supabase single truth | PASS. `ctx:` keys are rebuildable caches with a TTL. |
| Never write real `~/.claude` before the owner's yes | PASS. Done-when steps use `ctc install --dry-run` with `CTC_CLAUDE_HOME=<tmp>`. |
| Propose first; Supabase writes and daemon restarts need approval | PASS. All tickets test on the scratch DB; the live steps are the owner-approved tail. |
| `scripts/check.sh` green before push | PASS. Every ticket ends with its tests and ruff; O8 runs check.sh in full. |

Post-design re-check (after Phase 1): PASS, unchanged. The new outward surfaces are:
- one hook route, `/v1/hook/start` (read-only text);
- three read-only MCP tools;
- `/api` routes, where delete and restore are soft;
- one new job kind.

## Project Structure

### Documentation (this feature)

```text
specs/003-claude-mem-memory/
├── spec.md          # stories, FR, SC
├── plan.md          # this file
├── research.md      # Phase 0 decisions (R1–R12)
├── data-model.md    # tables, cache key, job payload, state transitions
├── quickstart.md    # end-to-end validation on the scratch stack
├── contracts/       # hooks.md, mcp.md, api.md, modules.md, observe-mode.md
├── checklists/requirements.md
└── tasks.md         # /speckit-tasks
.scratch/claude-mem-port/inventory.md   # technical source of truth ("how")
```

### Source Code (repository root)

```text
third_party/claude-mem/LICENSE, NOTICE        # O1  verbatim (Apache-2.0)
config/observe-mode.yaml                      # O1  claude-mem plugin/modes/code.json → YAML (+ attribution header)
config/server.yaml                            # O1  `memory:` block (enabled: false, observe / context / search)
src/ctc/storage/schema.sql                    # O1  observations, session_summaries, sessions.observed_*, RLS lines
src/ctc/memory/tags.py                        # O1  strip_tags (claude-mem tag-stripping.ts), shared by hooks/A3/B9/observe
src/ctc/llm/client.py                         # O1  _redact: add missing secret patterns (redaction.ts)
src/ctc/server/hooks.py                       # O1  _prompt strips tags before route/decision/title · O2 _stop submits `observe` · O4 /v1/hook/start
src/ctc/ai/extract.py, src/ctc/ingestion/history.py   # O1  use strip_tags
src/ctc/memory/observe.py                     # O2  transcript → turns → gates → prompt → claude -p → parse → files → embed → store; jobs handler `observe`
src/ctc/server/jobs.py                        # O2  HANDLERS["observe"], UNTIMED
src/ctc/memory/observations.py                # O3  search (RRF SQL), timeline, get, feed, counts, render_context, ctx cache helpers
src/ctc/cli.py                                # O4  HOOKS/MATCHERS SessionStart (install / uninstall / --dry-run)
src/ctc/server/mcp.py                         # O5  memory_search / memory_timeline / memory_get + instructions
src/ctc/server/library.py, api.py, schemas.py # O6  /api/memories/{feed,feed/counts,timeline,context}, /api/observations/*, /api/summaries/*, sessions counts/lists
dashboard/src/{Memories,parts,Sessions,Jobs,App}.tsx, {types,api,mock}.ts, styles.css   # O7  Timeline tab, cards, chips, feed, preview, session drawer
PLAN.md, CLAUDE.md                            # O8  m7 section + amendments (D21); Decisions (D3, D22)
evaluation/observation_eval.py                # O8  SC-007 hit@5 over a questions file (owner writes the questions: H5); evaluation/memory_eval.py is the existing K4/H4 eval and stays untouched
tests/test_memory_{tags,observe,observations,hook_start,mcp,api}.py   # one per ticket
```

**Structure Decision**: two new modules in the existing `src/ctc/memory/` package, next to `longterm.py` and `session.py`:
- `observe.py` is the write side (job);
- `observations.py` is the read side (search, render).

`tags.py` is separate because hooks, A3, B9 and observe all import it and it must not pull in the job code. Server, CLI and dashboard files get thin wiring. Config uses the distinct top-level key `memory` because `cfg()` merges yaml files with a shallow `dict.update`.

## Data Model Changes (additive)

See [data-model.md](data-model.md):
- `ctc.observations`: bigserial id, nine-type CHECK, `text[]` fields, `content_hash`, generated `tsv`, `vector(1024)` + HNSW, soft delete, `unique (session_id, content_hash)`.
- `ctc.session_summaries`: per turn, generated `tsv`, `unique (session_id, prompt_number)`.
- `sessions.observed_bytes` and `sessions.observed_prompts`.
- RLS enabled on both new tables.
- Redis `ctx:{user}:{project_id}`.

## Interfaces

- **Hooks** ([contracts/hooks.md](contracts/hooks.md)):
  - new `POST /v1/hook/start` returns SessionStart `hookSpecificOutput.additionalContext`;
  - Stop and SessionEnd queue `observe`;
  - the prompt hook strips tags before routing and writes;
  - `ctc install` adds SessionStart (`startup|clear|compact`, `curl -m 1`).
- **MCP** ([contracts/mcp.md](contracts/mcp.md)): `memory_search`, `memory_timeline` and `memory_get`, plus an instructions block.
- **API** ([contracts/api.md](contracts/api.md)):
  - feed, counts, timeline and context routes;
  - observation and summary get, delete and restore;
  - session counts and lists;
  - TS types `Observation`, `Summary`, `PromptItem` and `FeedItem`.
- **Modules** ([contracts/modules.md](contracts/modules.md)): the function signatures that same-wave tickets rely on (`tags.strip_tags`, `observations.*`, `observe.run_job`).
- **Mode file** ([contracts/observe-mode.md](contracts/observe-mode.md)): `config/observe-mode.yaml` schema and the observer's XML.

## File Locks and Lane Plan

Rule (owner, kept from 001/002): tickets that touch the same file never run at the same time. Builders never commit. The lead commits each ticket on `m7-memory` and does the wiring between waves.

| Lock | Tickets |
|---|---|
| hooks.py | O1 (w1) · O2 (w2) · O4 (w3) |
| schema.sql, tags.py, client.py, server.yaml, observe-mode.yaml, third_party/, ai/extract.py, ingestion/history.py | O1 |
| observe.py, jobs.py | O2 |
| observations.py | O3 |
| cli.py | O4 |
| mcp.py | O5 |
| library.py, api.py, schemas.py | O6 |
| dashboard/src/* | O7 |
| PLAN.md, CLAUDE.md, evaluation/observation_eval.py | O8 |

| Wave | Lanes (parallel) | Starts when | Lead wiring after the wave |
|---|---|---|---|
| 1 | O1 foundation (schema, tags, redaction, config, mode file, attribution, prompt strip) · O7 dashboard (against mock data and [contracts/api.md](contracts/api.md)) | now | commit O1, O7; apply schema to scratch |
| 2 | O2 capture job · O3 read side | wave 1 committed | commit O2, O3; run `observe` on a recorded transcript with fake claude on scratch |
| 3 | O4 session-start hook + install · O5 MCP tools · O6 API routes | wave 2 committed | commit O4, O5, O6; switch O7's mock to live routes (`VITE` flag already used by the dashboard) and fix drift |
| 4 | O8 docs + eval script | wave 3 committed | commit O8; quickstart live smoke on the isolated daemon; then 1 reviewer → 1 fixer if needed |

Same-wave dependencies go only through [contracts/modules.md](contracts/modules.md):
- O2 calls `observations.refresh_context()` at the end of a job (O3, same wave). It imports it lazily, and the test stubs it.
- O4, O5 and O6 all read `observations.*`, which O3 committed in wave 2.
- O7 codes against [contracts/api.md](contracts/api.md) and mock data until wave 3 lands.

**Before wave 1** (owner yes): T000 commits the docs, puts the main checkout back on `m6-graph` and adds the worktree `.worktrees/m7`; T001 starts the scratch Redis.

**After wave 4** (owner yes each, asked at the time, in this order: D8/D11 and the `memory.enabled` switch, off by default in `config/server.yaml`, keep capture from starting at the first restart):
1. apply the schema to live Supabase;
2. daemon restart (`scripts/deploy_local.sh`): memory is still inert;
3. the owner turns off the claude-mem plugin's hooks;
4. the owner sets `memory.enabled: true` (and `history.skip_projects`) and restarts;
5. `ctc install` (adds SessionStart) on the real `~/.claude`;
6. one real haiku capture, then the SC-001 / SC-005 measurements;
- H5: the owner writes or checks the 20 SC-007 questions;
- push + PR into `staging` (after PR #5).

## Complexity Tracking

No unjustified gate violations. The three recorded exceptions are above: SessionStart 1 s, haiku capture, translated claude-mem text. Deliberate corner-cuts get `ponytail:` comments:

| Corner-cut | Ceiling | Upgrade path |
|---|---|---|
| One `observe` call per turn, ≤ 8 chunks of 32k chars | very long turns lose their tail (logged) | raise the cap or split jobs |
| Main transcript only | subagent work is not observed | read `<session>/subagents/*.jsonl` |
| Prompt cards come from `decisions` | repeated prompts are collapsed | a prompt table if ever wanted (D1 says no) |
| HNSW post-filtering with filters | can return fewer than 100 vector candidates | pgvector ≥ 0.8 iterative scan |
| 3 s polling while the tab is visible | not live | SSE through Redis pub/sub (D15) |
| Single serial job worker shared with index/history/distill/graph | capture queues behind long jobs | a second worker |
| No type/concept selection knobs for session start | — | port claude-mem's filter if wanted (C3) |
| Chat-only turns get no summary | — | D4 |
