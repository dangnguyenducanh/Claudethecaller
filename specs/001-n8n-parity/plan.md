# Implementation Plan: n8n parity for the m5 workflow runner

**Branch**: `001-n8n-parity` (Spec Kit id; code ships one branch per ticket, PR into `staging`) | **Date**: 2026-10-26 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-n8n-parity/spec.md`; research already done in `.scratch/n8n-parity/compare.md` (n8n 2.43.7, static REA analysis, 163-row gap matrix)

## Summary

Close n8n's failure, iteration and authoring gaps in the m5 runner without changing its shape: one JSON output per node, YAML workflows in git, the walker state the engine already saves, and subscription-only execution. Sixteen user stories (one per ticket 02–17) sit on one foundational test seam (ticket 01). The technical approach reuses existing paths. The quota-resume path (`engine.resume`, saved walker state, `wf_steps` outputs) becomes retry/run-from, and "complete a node without executing it" serves reused steps, pins and disabled nodes. Graph changes stay inside `graph.py` (validator, walker, `eval_if`, `render`), and new self-contained logic goes into new modules (`prune.py`, `notify.py`).

## Technical Context

**Language/Version**: Python ≥ 3.12 (uv), TypeScript (dashboard, React 19, Vite 8, `@xyflow/react` 12)

**Primary Dependencies**: FastAPI + uvicorn (daemon), typer (CLI), psycopg 3 + pool (Postgres), pyyaml, pydantic, `mcp` (MCP server), croniter (schedules), orjson; dashboard: react, `@xyflow/react`, recharts. No new dependency is planned.

**Storage**: Postgres schema `ctc` (Supabase in prod, scratch `ctc-dev-pg` for tests): `wf_runs`, `wf_steps`, `wf_schedules` in `src/ctc/storage/schema.sql` (idempotent, `{schema}` templated). Run worktrees, branches and gz logs under the runs dir (`~/.claudethecaller/runs` by default).

**Testing**: pytest (`uv run pytest -q tests`), ruff, `scripts/check.sh` (CI mirror). There is one engine seam: `tests/conftest.py` fixtures create a throwaway schema on the scratch DB from `CTC_DATABASE_URL` and skip when it is unset or Supabase, with `scripts/fake_claude.sh` as `CTC_CLAUDE_BIN`. Pure graph tests need no DB. Editor features get browser QC (screenshots) plus `pnpm -C dashboard build`.

**Target Platform**: Linux host (daemon on `:18310` + `~/.claudethecaller/ctc.sock`), dashboard served by the daemon.

**Project Type**: Python service + CLI with a React dashboard (single repo).

**Performance Goals**: The engine overhead per node stays negligible next to agent runtime. Notify uses a 10 s timeout and is detached. Shutdown grace is 5 min.

**Constraints**: Subscription-only execution (no API key). Never re-execute a side effect after a crash. Hook budget is untouched. The Supabase free tier (500 MB) is the reason for pruning. Schema changes are additive only. The dashboard API stays field-for-field with `dashboard/src/types.ts`.

**Scale/Scope**: The work is 17 tickets: about 10 touch the hotspot files `graph.py`, `engine.py` and `Workflows.tsx`. Current sizes are engine.py 523 lines, graph.py 453, Workflows.tsx 428, Runs.tsx 291, cli.py 719, runs.py 269, mcp.py 85, schema.sql 264.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is still the unfilled template, so the gates come from `CLAUDE.md` and `PLAN.md` "Constraints":

| Gate | Status |
|---|---|
| Stay in the current step's scope; one branch per ticket, PR into `staging`, Conventional Commits | PASS: one story = one ticket = one PR |
| Shortest working solution; stdlib and chosen deps first; no one-implementation abstractions; mark corner-cuts `ponytail:` | PASS: no new deps; new modules only for self-contained logic (prune, notify) |
| Built from scratch; other projects are references only | PASS: n8n is used as a behaviour reference; no code copied |
| Hook suggests, never blocks; fail-open | N/A: hook path untouched |
| Never re-run a side effect after a crash | PASS with the owner's carve-out: manual retry/run-from resets the worktree first; auto-retry only for `idempotent` shells |
| Propose first; writes to Supabase, `~/.claude`, daemon restarts need approval | PASS: implementation runs per ticket under the working agreement; tests use scratch schemas only |
| `scripts/check.sh` green before push | PASS: every story ends with a check task |

## Project Structure

### Documentation (this feature)

```text
specs/001-n8n-parity/
├── spec.md      # Spec Kit spec (16 stories, from .scratch/n8n-parity/spec.md)
├── plan.md      # This file
└── tasks.md     # /speckit-tasks output
.scratch/n8n-parity/   # research + tickets (compare.md, spec.md, dispatch.md, issues/01-17)
```

### Source Code (repository root)

```text
src/ctc/
├── runner/
│   ├── graph.py      # load, validate, ready/batch walker, complete/_fire/_send, lookup/render, eval_if, derived_steps
│   ├── engine.py     # submit, claim, _save, _input, _spawn, execute, kill_run, cancel, approve, resume, sweep, run_runner
│   ├── proc.py       # claude/shell subprocesses, child_env, CTC_CLAUDE_BIN
│   ├── schedule.py   # durable schedules (compare-and-set firing)
│   ├── export.py     # native .claude/workflows/*.js export
│   ├── prune.py      # NEW (US5)
│   └── notify.py     # NEW (US3)
├── server/
│   ├── app.py        # FastAPI app + lifespan (US9)
│   ├── runs.py       # /api runs, approve/cancel/continue, schedules
│   ├── schemas.py    # pydantic API models (mirror dashboard/src/types.ts)
│   ├── mcp.py        # MCP tools (US4, US16)
│   └── library.py    # workflow files load/save (US15 save conflict)
├── storage/schema.sql  # wf_runs, wf_steps, wf_schedules (additive columns, US1/US2)
└── cli.py            # typer CLI (retry, approve/reject, runs prune, --pinned, --input, workflow validate)

dashboard/src/
├── Workflows.tsx     # editor canvas, node forms
├── Runs.tsx          # run page, steps, approval banner
├── App.tsx           # routes
└── types.ts          # API types

config/server.yaml    # runner.notify (US3), shutdown grace (US9)
scripts/              # check.sh, fake_claude_quota.sh, fake_claude_overage.sh, fake_claude.sh (NEW, ticket 01)
tests/                # conftest.py (NEW seam), test_capability.py (existing), test_<feature>.py per ticket
.claude/ctc-workflows/  # example workflows (must keep validating)
.claude/skills/ctc-workflow-builder/SKILL.md  # NEW (US16)
```

**Structure Decision**: Single repo, existing layout. Each ticket adds its own test file so `tests/` is not a hotspot; shared fixtures land once in `tests/conftest.py` (Foundational).

## Data Model Changes (additive)

- `wf_runs`: `parent_run_id` (fk wf_runs, nullable), `from_node text`, `to_node text`, `pinned boolean default false` (US1, US2).
- `wf_steps`: `marker text` (`reused | pinned | disabled`, nullable) and `tries int default 1` (US1, US2, US6, US7).
- Workflow YAML (validated by `graph.validate`, all optional): node `disabled`, `on_error`, `retry {max_tries 1..5, wait_s 0..300}` + `idempotent` (shell only), `pin {output}`, `notes`; IF `conditions[] + combine`; types `switch`, `foreach`, `stop`; trigger `inputs[]`; workflow `vars`, settings `max_run_minutes`, `approval_timeout_minutes`, `notify`.

## Interfaces

- **API** (field-for-field with `types.ts`): run start accepts `pinned`, typed `inputs`; `POST /api/runs/{id}/retry {from_node?, to_node?}`; run detail adds `parent_run_id`, `from_node`, `to_node`, per-step `marker`/`tries`; workflow save carries `base_hash` and returns 409 on conflict; validation responses include `warnings`.
- **CLI**: `ctc retry <run> [--from] [--to]`, `ctc approve|reject <run> [--note]`, `ctc runs prune [--days 30] [--apply]`, `ctc run --pinned --input name=value`, `ctc workflow validate <file>`.
- **MCP**: `list_workflows`, `run_workflow` (typed inputs, user scope), `workflow_status` (truncated step outputs), `approve_run`, `reject_run`, `continue_run`, `cancel_run`.
- **Notify env**: `CTC_RUN_ID`, `CTC_RUN_STATUS`, `CTC_RUN_WORKFLOW`, `CTC_RUN_URL`, `CTC_RUN_ERROR`.

## File Locks and Lane Plan

Rule (owner, Q19): tickets that touch the same file never run at the same time.

Recomputed from the files the tasks in [tasks.md](tasks.md) edit. This is wider than the tickets' Touches lines: e.g. US11 must dispatch `switch` in engine.py, US9 extends `ctc daemon stop` in cli.py, and US7 adds `wf_steps.tries`.

| Lock | Stories |
|---|---|
| graph.py | US2 US6 US7 US8 US10 US11 US13 US14 US15 US16 |
| Workflows.tsx | US2 US6 US7 US8 US10 US11 US13 US14 US15 US16 |
| engine.py | US1 US2 US3 US6 US7 US8 US9 US11 US13 US14 US16 |
| types.ts | US1 US2 US6 US7 US8 US10 US11 US13 US14 US15 US16 |
| runs.py | US1 US2 US4 US7 US12 US16 |
| schemas.py | US1 US2 US7 US13 US15 US16 |
| cli.py | US1 US2 US4 US5 US9 US16 |
| export.py | US6 US8 US11 US13 US14 US16 |
| Runs.tsx | US1 US7 US10 US15 |
| api.ts | US1 US2 US13 US16 |
| library.py | US3 US13 US15 |
| schema.sql | US1 US2 US7 |
| mcp.py | US4 US16 |
| config/server.yaml | US3 US9 |

Priority-first waves (same 11-PR critical path as `dispatch.md`, but the MVP lands in wave 2 instead of wave 5):

| Wave | Lanes (parallel) | Starts when |
|---|---|---|
| 1 | Foundational (01) · US5 prune (02) · US11 IF/Switch (03) · US12 schedule HEAD (07) | now |
| 2 | US1 retry/run-from/run-to (11) | 01, 02, 03, 07 merged |
| 3 | US2 pins (12) | US1 merged |
| 4 | US3 notify (05) → US9 shutdown (15) (one lane; US9 also waits for US4, since both edit cli.py) · US4 MCP/CLI (04) · US10 fixes (06) | US2 merged |
| 5 | US15 editor parity (16) (may overlap US9) | US10 merged |
| 6 | US6 disabled (08) → US7 retry-on-fail (09) → US8 error branch (10) (one lane) | US9 + US15 merged |
| 7 | US13 graph extras (14) → US14 for-each (13) (one lane) | US8 merged |
| 8 | US16 inputs + builder (17) | US13/US14 + US4 merged |

The strict rule makes waves 2–3 and 5–8 single-lane. Relaxing it for different functions of the same hotspot file is the owner's open decision (dispatch.md "Risks").

## Complexity Tracking

No constitution violations to justify.
