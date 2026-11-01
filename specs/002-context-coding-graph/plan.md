# Implementation Plan: Context + coding graph (m6)

**Branch**: `m6-graph` (Spec Kit id `002-context-coding-graph`; one ticket = one commit on `m6-graph`, PR into `staging` at the end) | **Date**: 2026-10-26 | **Spec**: [spec.md](spec.md)

**Input**: [spec.md](spec.md) (8 stories, FR-001–FR-030) and the owner-approved [design.md](design.md), which settles architecture, storage, ids, links, hooks, extractor and eval. Research: [research.md](research.md).

## Summary

A new `src/ctc/graph/` package builds two graphs per project into Supabase and serves them from RAM: the coding graph is graphify's `graph.json` (code + rationale nodes) and the context graph is parsed from speckit specs, `.scratch` tickets, PLAN.md, PRDs and CLAUDE.md Decisions, plus a claude-mem-style background extractor (`claude -p --model haiku`) for prose and read-only claude-mem observations. Links from context to code come from named paths, ticket commits, claude-mem files, embeddings and Claude's own work. Agents get a push line on each prompt (existing hook), a new PreToolUse file note, and four MCP pull tools; the owner gets `ctc graph …` commands and an n8n-parity eval.

## Technical Context

**Language/Version**: Python ≥ 3.12 (uv). No dashboard work in m6.

**Primary Dependencies**: existing only: FastAPI, typer, psycopg 3 + pool, pgvector, numpy, httpx, pyyaml, orjson, `mcp` 2.x. **No new dependency** (no networkx, no graphify import, no XML library beyond stdlib `xml.etree`). External tools reached by file/CLI/HTTP: graphify 0.9.93 (`graphify-out/graph.json`), claude-mem 15.2.1 (`http://127.0.0.1:37707/api/observations`), Claude Code 2.1.306 (`claude -p`).

**Storage**: Postgres schema `ctc` (Supabase in prod; scratch `ctc-dev-pg` on 127.0.0.1:18304 for tests): new `graph_nodes`, `graph_edges`, `graph_sources`, and `decisions.graph_line` ([data-model.md](data-model.md)). RAM copy per worker in `State.graphs`.

**Testing**: pytest (`uv run pytest -q tests`), ruff, `scripts/check.sh`. Staging has no DB test fixture yet (only `tests/test_capability.py`), so T01 adds `tests/conftest.py` with a `scratch_store` fixture (throwaway schema on `CTC_DATABASE_URL`, skipped when unset or Supabase). Every new module also keeps a `__main__` self-check where it reads real repo files.

**Target Platform**: Linux host; daemon on `:18310` + `~/.claudethecaller/ctc.sock`; local mode only for m6.

**Project Type**: Python service + CLI (single repo).

**Performance Goals**: prompt hook p95 ≤ 150 ms total (graph part ≤ 5 ms in RAM; the prompt vector is an `emb:` cache hit from `route()`); PreToolUse p95 ≤ 50 ms (RAM lookup by path, no DB, no embedder); build of this repo (≈ 1.4k code + ≈ 0.6k context nodes) under a minute with embeddings.

**Constraints**: hooks fail open; Redis cache-only; GPU unchanged (existing embedder); `claude -p` on the subscription only (preflight `authMethod: claude.ai`), never an API key; no writes to claude-mem or graphify data; real `~/.claude` and live Supabase only with the owner's yes; additive schema only.

**Scale/Scope**: 7 tickets (T01–T07 = G1–G7) in 4 waves. Current sizes: cli.py 719 lines, hooks.py 324, mcp.py 85, jobs.py 127, state.py 49, writer.py 110, schema.sql 264. New package ≈ 1.2–1.6k lines.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is the unfilled template, so the gates come from `CLAUDE.md` and `PLAN.md` "Constraints":

| Gate | Status |
|---|---|
| Stay in the step's scope; one branch per phase/step; Conventional Commits; PR into `staging` | PASS: branch `m6-graph`, one commit per ticket, PR after G7 with the owner's yes |
| Shortest working solution; stdlib + chosen deps; no one-implementation abstractions; `ponytail:` on corner-cuts | PASS: no new deps; plain functions + one RAM dataclass; BFS by hand |
| Built from scratch; outside projects are references, never dependencies | PASS with the 2026-10-26 decision: graphify and claude-mem are read through their files/HTTP only |
| Hook suggests, never blocks; fail-open; ≤ 150 ms | PASS: push line + PreToolUse note only add text; both under `wait_for` budgets; curl `|| true` |
| Redis cache-only; Supabase single truth | PASS: graphs in Postgres; RAM copy rebuildable |
| Models local, ≤ 7 GB GPU | PASS: reuses the running embedder; extractor uses the owner's Claude login, not the GPU |
| Never write real `~/.claude` before the owner's yes | PASS: `ctc install --dry-run` with `CTC_CLAUDE_HOME=<tmp>` in Done-when; the real install is a separate yes |
| Propose first; Supabase writes and daemon restarts need approval | PASS: all builds/tests on the scratch DB; live schema + restart are a final owner-approved step |
| `scripts/check.sh` green before push | PASS: every ticket ends with check.sh against the scratch DB |

Post-design re-check (after Phase 1): unchanged, PASS. The only new outward surface is one hook route (`/v1/hook/pre`) and four MCP tools, both read-only.

## Project Structure

### Documentation (this feature)

```text
specs/002-context-coding-graph/
├── design.md        # owner-approved design (source of truth for "how")
├── spec.md          # stories, FR, SC
├── plan.md          # this file
├── research.md      # Phase 0 decisions
├── data-model.md    # tables, RAM graph, id rules
├── quickstart.md    # end-to-end validation
├── contracts/       # cli.md, mcp.md, hooks.md, modules.md, context-mode.md
├── checklists/requirements.md
└── tasks.md         # /speckit-tasks
.scratch/context-coding-graph/   # tickets 01–07 + dispatch.md (implement-spec input)
```

### Source Code (repository root)

```text
src/ctc/graph/                 # new package
├── __init__.py
├── db.py          # T01  graph_* table reads/writes (replace_origin, sources, embeddings, counts, confirm)
├── core.py        # T01  RAM Graph: load, by-id, by-file, nearest(qv), neighbours; graph_for(st, cwd) cache
├── importer.py    # T01  graphify graph.json → coding nodes/edges; staleness check
├── parse.py       # T02  context parser (pure): specs, .scratch, PLAN.md, PRDs, CLAUDE.md Decisions
├── link.py        # T03  embeddings + EXTRACTED (paths, commits) + INFERRED links; confirm/drop; tick confirm
├── claudemem.py   # T03  read-only observations import
├── build.py       # T03  orchestration + jobs handler `graph_build`
├── extract.py     # T04  background extractor (mode file, chunks, claude -p, XML), jobs handler `graph_extract`
├── query.py       # T05  search / explain / affected / path
├── export.py      # T05  graphify-format export
└── push.py        # T06  prompt line + file note formatting
src/ctc/storage/schema.sql     # T01  graph tables + decisions.graph_line
src/ctc/server/state.py        # T01  State.graphs
src/ctc/server/jobs.py         # T04  HANDLERS graph_build, graph_extract
src/ctc/server/hooks.py        # T04  PostToolUse triggers + event file_path + _in_run extract dir; T06 push line + /v1/hook/pre
src/ctc/server/writer.py       # T06  decision.graph_line
src/ctc/server/mcp.py          # T05  graph_search / graph_explain / graph_affected / graph_path
src/ctc/cli.py                 # T01 `graph import|status`; T03 `graph build|confirm`; T06 install PreToolUse; lead: `graph extract|export`
config/retrieval.yaml          # T03 `graph_links:`; T06 `graph_push:`
config/server.yaml             # T04 `graph_extract:`
config/context-mode.yaml       # T04  mode file
.claude/skills/ctc-context/SKILL.md   # T04
.specify/extensions.yml        # T04
evaluation/graph_eval.py       # T07
tests/conftest.py              # T01  scratch_store fixture
tests/test_graph_{import,parse,link,extract,query,push}.py   # one per ticket
```

**Structure Decision**: one new package next to `retrieval/`, `memory/`, `runner/`; server and CLI files get thin wiring only. Config keys are distinct top-level names (`graph_links`, `graph_push`, `graph_extract`) because `cfg()` merges the yaml files with a shallow `dict.update`.

## Data Model Changes (additive)

See [data-model.md](data-model.md): `graph_nodes`, `graph_edges` (confidence EXTRACTED | INFERRED | CONFIRMED | DROPPED; origin parser | claude | graphify | claude-mem | commit | embed | session | review), `graph_sources`, `decisions.graph_line text`.

## Interfaces

- **CLI** ([contracts/cli.md](contracts/cli.md)): `ctc graph import | build [--no-commits] | status | extract | export --kind | confirm <src> <dst> <relation> keep|drop`.
- **MCP** ([contracts/mcp.md](contracts/mcp.md)): `graph_search(question, graph, k)`, `graph_explain(node)`, `graph_affected(node)`, `graph_path(a, b)`.
- **Hooks** ([contracts/hooks.md](contracts/hooks.md)): prompt hook appends one `ctc graph:` line; new `POST /v1/hook/pre` returns PreToolUse `hookSpecificOutput.additionalContext` (confirmed supported in Claude Code 2.1.306); PostToolUse queues `graph_build` / `graph_extract` jobs.
- **Modules** ([contracts/modules.md](contracts/modules.md)): the function signatures tickets in the same wave rely on (db, core, build.run_job, extract.run_job, push).
- **Mode file** ([contracts/context-mode.md](contracts/context-mode.md)): `config/context-mode.yaml` schema and the extractor's XML output.

## File Locks and Lane Plan

Rule (owner, 001 Q19, kept): tickets that touch the same file never run at the same time. Builders never commit; the lead commits each ticket on `m6-graph` and does the listed wiring between waves.

| Lock | Tickets |
|---|---|
| cli.py | T01 (w1) · T03 (w2) · T06 (w3) · lead after w2, w3 |
| hooks.py | T04 (w2) · T06 (w3) |
| schema.sql, state.py, db.py, core.py, importer.py, tests/conftest.py | T01 |
| retrieval.yaml | T03 (w2) · T06 (w3) |
| jobs.py, server.yaml, context-mode.yaml, extensions.yml, ctc-context skill | T04 |
| mcp.py, query.py, export.py | T05 |
| writer.py, push.py | T06 |

| Wave | Lanes (parallel) | Starts when | Lead wiring after the wave |
|---|---|---|---|
| 1 | T01 G1 import + store + RAM · T02 G2 parser | now | commit T01, T02; apply schema to scratch |
| 2 | T03 G3 links + build + claude-mem · T04 G4 extractor + triggers + skill | wave 1 committed | `ctc graph extract` in cli.py; commit T03, T04 |
| 3 | T05 G5 pull tools + export · T06 G6 push + PreToolUse + install | wave 2 committed | `ctc graph export` in cli.py; commit T05, T06 |
| 4 | T07 G7 eval | wave 3 committed | commit T07; then 1 reviewer → 1 fixer if needed |

Same-wave dependencies go only through [contracts/modules.md](contracts/modules.md): T04 registers `graph_build` → `ctc.graph.build:run_job` (T03) and submits payloads in the agreed shape; T05 and T06 both read `core.Graph` (T01, already committed).

**After wave 4 (owner yes each, asked at the time)**: apply schema to live Supabase; `ctc graph build` on live; daemon restart (`scripts/deploy_local.sh`); `ctc install` on the real `~/.claude`; push + PR into `staging`.

## Complexity Tracking

No gate violations. Two deliberate corner-cuts get `ponytail:` comments: brute-force cosine over all graph nodes in RAM (fine below ~100k nodes, the same call as capability vectors), and one RAM refresh per worker at most every 30 s in the background (multi-worker shared mode would use the Redis invalidation channel instead).
