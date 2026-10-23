# m5 workflow runner: finish M1–M6 (execution plan, 2026-10-22)

Spec per step: `PLAN.md` → "Workflow runner (m5)" (Decisions, Walker rules, Data model, API, Build order WB7–WB16 / WF7–WF12).
Requirements and owner decisions: `.claude/prds/workflow-runner.md`. This file is only how tonight runs; it changes no spec.

## Ground rules (every step)
- **Branch:** `m5-runner-core`, cut from `b9-history-import` (step 0). One commit per milestone, made by the main session after that milestone's Done-when passes. No push, no PR, without an explicit owner yes.
- **Daemons:** test only on `:18311` (`CTC_PORT=18311 CTC_SOCKET=~/.claudethecaller/m5.sock CTC_DASHBOARD_DIST=<repo>/dashboard/dist`). Never stop or restart the PR 2 daemon on `:18310`.
- **Code style:** ponytail full + Karpathy. Shortest working diff; no new dependencies (Docker for M6 only); one runnable assert self-check for non-trivial logic; `ponytail:` comments on corner cuts; `graphify query` before grep/read.
- **Claude quota:** Haiku only, only the runs listed per step (about 5 in total). Every other test uses shell nodes or the fake binaries (`scripts/fake_claude_*.sh`).
- **Review:** one reviewer at the end (critical/high only), then one fixer.
- **Execution:** one Workflow per milestone (backend builder ∥ frontend builder on separate files). Between workflows the main session runs the Done-when commands, does a short hand-driven browser check, and commits.

## Overview

| Step | Milestone | Agents | Claude quota | Estimate |
|---|---|---|---|---|
| 0 | Move M1 onto `m5-runner-core`, merge with PR 2, re-check, commit | main session | none | 30–45 min |
| 1 | M2: loops, approval gate, continue after quota, compare runs | backend ∥ frontend | 1 Haiku | 60–90 min |
| 2 | M3: parallel read-only nodes + Merge | backend ∥ frontend | none | 30 min |
| 3 | M4: canvas schedule + idle wait, MCP tools, schedule editor | backend ∥ frontend | 1 Haiku | 45–60 min |
| 4 | M5: owner scoping check + README | 1 builder | none | 15 min |
| 5 | M6: container mode + native export | backend ∥ frontend | 2–3 Haiku | 60 min |
| 6 | Review → fix → final test with browser + video | reviewer, fixer, main | none | 45 min |

**Total:** about 12 agents, 3–5M subagent tokens, 4.5–6 hours.

**Owner steps that can't finish tonight:**
- WH2: your first real chain. Runs 12 and 15 were driven by me.
- WH3: needs ≥ 20 real runs over time.
- WH4: needs a teammate.

Those milestones end as "code done, owner check pending".

---

## Step 0: M1 onto `m5-runner-core` (main session)
1. `git fetch origin`, then `git stash push -u -m m5-m1`. The stash includes the untracked `src/ctc/runner/`, `server/runs.py`, `Runs.tsx`, `scripts/fake_claude_*.sh`, `.claude/ctc-workflows/`, `.claude/prds/` and `.claude/plans/`.
2. `git switch -c m5-runner-core origin/b9-history-import`, then `git stash pop`.
3. Resolve the 11 files both sides changed. Both sides are mostly additive, so keep both.
   - Backend: `src/ctc/storage/schema.sql` (B9 `history_files` + m5 `wf_*`), `src/ctc/server/app.py`, `hooks.py` (B9 SessionEnd + runs-dir guard), `schemas.py`, `src/ctc/cli.py` (`history` + `run`/`runs`/`cancel`/`runner`), `config/server.yaml`.
   - Frontend: `dashboard/src/api.ts`, `types.ts`, `mock.ts`.
   - Docs: `PLAN.md`, `CLAUDE.md`.
4. Re-check:
   - `uv run python -m ctc.runner.graph`
   - `uv run python -c "import ctc.server.app"`
   - `pnpm -C dashboard build`
   - restart the `:18311` test daemon, then `uv run ctc run smoke --wait`, which must end `done`
5. Tick WB1–WB6 and WF1–WF6 in `PLAN.md` with one-line results, and set PRD milestone 1 to "code done, WH2 pending". Then commit `feat(runner): m5 M1 — run a chain (graph walker, claude -p runner, runs API, canvas + run pages)`.

**Done when:** `git log --oneline -1` on `m5-runner-core` shows the M1 commit and `ctc run smoke --wait` ends `done` from that branch.

## Step 1: M2, loops, approval, continue, compare
**Backend builder** (`runner/graph.py`, `runner/engine.py`, `runner/proc.py`, `server/runs.py`, `server/schemas.py`, `cli.py`, new `.claude/ctc-workflows/{loop-demo,gate,bad-push}.yaml`)
- **WB7 loops:**
  - `validate` allows back-edges and enforces rule 6: no `merge`/`approval` inside a loop body, no non-IF fan-out inside one, every IF has both handles.
  - `complete`/`ready` implement rule 5:
    - firing a back-edge resets the loop body's inbox and deferred entries;
    - `visits[target] += 1`, and going over `max_visits` (default 3) fails with `loop cap reached at <id>`;
    - backstop: executions ≤ Σ`max_visits` + node count.
  - The quiescence rule must never send `skip` over a back-edge.
  - `loop-demo.yaml`: a shell counter in a file, an IF on `count >= 3`, and a back-edge.
- **WB8 approval:**
  - Add type `approval` (`message` field). `validate` rejects a shell node matching `PUSH` that is reachable from the trigger without passing an approval node; this replaces the M1 blanket reject.
  - Engine: reaching an approval node writes the step `waiting` and the run `waiting`, saves state, and frees the lane. The sweep leaves `waiting` alone.
  - `POST /api/runs/{id}/approve {approve, note?}`:
    - approve: the step becomes `done` with output `{approved: true, note}`, `complete()` runs, and the run goes back to `queued`, so the runner re-claims it;
    - reject: the run is `cancelled`;
    - not waiting: 409 `not_waiting`.
  - `gate.yaml`: shell `echo hi > x` → approval → shell `echo pushed`.
  - `bad-push.yaml`: `git push` with no gate.
- **WB9 continue after quota:**
  - `POST /api/runs/{id}/continue {when: now|reset}` (409 `not_quota`) and `ctc continue <id> [--now]`.
  - `now` re-queues the run immediately; `reset` sets `auto_resume` and waits.
  - On claim, the `quota` step is re-claimed as the same visit (an update back to `running`, not an insert). It re-runs with `--resume <its session_id>` and the prompt "Continue where you left off."
  - The quota gate at claim must not block a run whose own reset time has passed.
  - The runner's 30 s loop auto-queues `quota` runs that have `auto_resume` once `quota_resets_at <= now()`.
- **WB10 compare:** `GET /api/runs/compare?a=&b=&node=`. Both runs must have the same owner and repo; otherwise 422.
  - Whole run: `git diff <a.branch>..<b.branch>`.
  - With `node`: that node's latest-visit `post_sha` in each run.
  - Output: `{diff, files, truncated}` via `engine.git_diff`.

**Frontend builder** (`Workflows.tsx`, `Runs.tsx`, `api.ts`, `types.ts`, `styles.css`, `App.tsx`)
- **WF7:**
  - an `+ Approval` palette button and approval node view (`message` field in its panel);
  - back-edges drawn dashed and labelled `loop ≤ N`;
  - on the run canvas, a `×N` badge on nodes that ran more than once, and a visit selector in the step panel.
- **WF8:** banners that survive a page reload:
  - `waiting`: "Waiting at `<node>`: `<message>`", the whole-run diff, Approve/Reject plus a note field;
  - `quota`: "Out of usage, resets at …", with **Continue when reset** and **Continue now**.
- **WF9:** checkboxes on the runs list; ticking two enables **Compare**, which opens `#compare/<a>/<b>[/<node>]` with a node selector and `DiffView`.

**Done when** (main session, `:18311`):
- `uv run python -m ctc.runner.graph` passes the new asserts:
  - fix-tests with red, red, green runs the reviewers and join exactly once;
  - a 4th red hits `loop cap`;
  - a loop around a merge is rejected;
  - push without a gate is rejected, push behind a gate passes.
- `uv run ctc run loop-demo --wait` shows the counter at visits 1–3 and ends `done`.
- `gate`: `waiting` → restart the test daemon → still `waiting` → `curl -XPOST …/runs/<id>/approve -d '{"approve":true}'` → `done`.
- POSTing a run for `bad-push` returns 422.
- **Continue** (1 Haiku run): `CTC_CLAUDE_BIN=scripts/fake_claude_quota.sh uv run python -m ctc.runner.engine .claude/ctc-workflows/smoke.yaml` → `quota`, then `uv run ctc continue <id> --now` with the real binary → `done`. The node's log shows `--resume <same session_id>`.
- Comparing two `loop-demo` runs returns `files` as an array.
- `pnpm -C dashboard build` passes.

**Commit:** `feat(runner): m5 M2 — loops, approval gate, continue after quota, compare runs`

## Step 2: M3, parallel + merge
**Backend** (`graph.py`, `engine.py`, new `.claude/ctc-workflows/three-reviewers.yaml`)
- Add type `merge`. It is ready once every inbound forward edge has a token and at least one is `data`. Its output is `{inputs: {node_id: output}}` over the `data` inputs.
- Rule 7 batches in `execute`:
  - all ready `readonly` nodes run together under `asyncio.gather`, each step row claimed before its spawn;
  - otherwise only the first ready writer, by id, runs;
  - commit and diff stay under the existing `LOCK`.
- `three-reviewers.yaml`: 3 readonly shell nodes `sleep 5; echo r<n>` → merge → shell `echo merged`.

**Frontend** (`Workflows.tsx`, `Runs.tsx`, `styles.css`)
- A `+ Merge` button and a merge node view that shows its inbound count.
- The run canvas shows several `running` nodes at once (it already colours per node; check the poll keeps up).

**Done when:**
- `time uv run ctc run three-reviewers --wait` ends `done` in under 9 s.
- `curl -s …/runs/<id> | python3 -c "…merge output inputs length"` prints 3.
- The graph asserts and `pnpm build` pass.

**Commit:** `feat(runner): m5 M3 — parallel read-only nodes and merge`

## Step 3: M4, hands-free triggers
**Backend** (`engine.py` runner loop, `server/runs.py`, `server/library.py` (schedule in capability GET), `server/mcp.py`, `schemas.py`)
- **WB12 schedules:**
  - `PUT /api/workflows/{cap_id}/schedule {cron, input?, enabled}`: 422 `bad_cron` via `croniter.is_valid`; returns the schedule with `next_at`. `DELETE` removes it.
  - `GET /api/capabilities/{id}` adds `schedule`.
  - The 30 s runner loop handles the owner's enabled schedules:
    - fire when `croniter(cron, last_fired_at or created).get_next(datetime) <= now`;
    - skip missed fires older than 2 min, but still set `last_fired_at`;
    - don't fire while that workflow has a queued/running/waiting run, or during the owner's quota window.
  - **Idle wait:** hold the fire while the newest `~/.claude/projects/*/*.jsonl` mtime is within `runner.idle_wait_min`. Skip directories whose name contains `claudethecaller-runs`, which belong to runner sessions.
- **WB13 MCP:** two tools on the existing FastMCP in `mcp.py`, both local-only and reusing `runs.py`'s submit/read code.
  - `run_workflow(workflow, input="")`: takes a cap id or a unique name; trigger `mcp`; returns `{run_id}` at once.
  - `workflow_status(run_id)`: returns `{status, error, quota_resets_at, steps:[{node_id, visit, status}]}`.

**Frontend** (`Workflows.tsx`, `Runs.tsx`)
- **WF11:** the trigger node panel gets a cron input with the hint "min hour dom mon dow, daemon local time", an enabled toggle, "Next run …" or the 422 message, and Save schedule / Remove.
- The runs list shows the `schedule` and `mcp` triggers.

**Done when:**
- `curl -XPUT …/workflows/<edit-demo>/schedule -d '{"cron":"* * * * *","enabled":true}'` with the test daemon started with `CTC_RUNNER_IDLE_WAIT_MIN=0` (or a config override) produces a `schedule` run within 70 s.
- With `idle_wait_min: 60` while this session is active, no run fires; check the logs. Then DELETE the schedule.
- **MCP** (1 Haiku run): `claude -p --model haiku --strict-mcp-config --mcp-config '{"mcpServers":{"ctc":{"type":"http","url":"http://127.0.0.1:18311/mcp"}}}' --allowedTools 'mcp__ctc__*' "call run_workflow for edit-demo, then workflow_status on the returned run_id"` prints a run id and a status, and that run is `done` with trigger `mcp`.

**Commit:** `feat(runner): m5 M4 — canvas schedules with idle wait, MCP run_workflow/workflow_status`

## Step 4: M5, team runs (owner decision: history in the shared Supabase, keyed by owner)
**Builder** (any runner file that needs it, `README.md`)
- Check that every `wf_runs` / `wf_steps` / `wf_schedules` query filters on `owner`, or reaches the rows through a run that does. Use `grep -n "wf_runs\|wf_steps\|wf_schedules" src/ctc` and fix any gap.
- Check that the hooks' runs-dir guard holds for any runs dir, so teammates' runs never feed router stats.
- Add a README section "Team runs": each teammate runs their own daemon on their own login; workflow files live in git; run history goes to the shared Supabase but each person sees only their own; never share a login (Anthropic's terms).

**Done when:**
- Insert a test `wf_runs` row with `owner = 'someone@else.test'`. `GET /api/runs`, `GET /api/runs/<that id>` (expect 404) and `workflow_status` must not show it.
- Delete the row.

**Commit:** `feat(runner): m5 M5 — owner scoping check and team-runs docs`

## Step 5: M6, container mode + native export
**Backend** (new `docker/ctc-runner.Dockerfile`, `proc.py`, `engine.py`, `graph.py` (settings), `server/runs.py` or `library.py` (export), new `src/ctc/runner/export.py` only if it doesn't fit in one function)
- **WB15 container:**
  - Dockerfile: `node:22-slim` plus `git` plus `npm i -g @anthropic-ai/claude-code@<runner.claude_version>`. Build with `docker build -t ctc-runner:<version> -f docker/ctc-runner.Dockerfile docker/`.
  - With `settings.permission: container`, an Agent node runs `docker run --rm -i --name ctc-run-<run>-<node>-<visit> --user $(id -u):$(id -g) -e HOME=/home/claude -v <worktree>:/work -v ~/.claude:/home/claude/.claude -v ~/.claude.json:/home/claude/.claude.json -w /work ctc-runner:<v> claude -p … --dangerously-skip-permissions`. The prompt goes in on stdin, as now.
  - Cancel, timeout and the sweep must also `docker kill ctc-run-<run>-*`. Killing the process group only stops the docker CLI.
  - Run the auth check inside the container once per run: `claude auth status`, expecting `authMethod: claude.ai`.
  - If the login does not work inside the container, keep the code, label the option "experimental" in the UI, and report it. Never fall back to host bypass.
  - Touch no other container.
- **WB16 export:**
  - `POST /api/workflows/{cap_id}/export` writes `<root>/.claude/workflows/<name>.js` in Claude Code's native workflow format (`export const meta = {name, description}` plus `agent()` calls).
  - Mapping:
    - agent → `agent(prompt, {label})`
    - shell → `agent("Run exactly: <cmd>. Report the exit code.", {schema: {exit_code: number, stdout_tail: string}})`
    - IF → a JS `if` on that structured output
    - loop → a `while` capped at `max_visits`
    - parallel read-only nodes → `parallel()`
  - A workflow with an approval node returns 422 `has_approval`. The file is refused if it already exists and differs.

**Frontend** (`Workflows.tsx`)
- **WF12:** the permission select gains `container` (labelled "experimental" if WB15 says so).
- An **Export** button in the editor toolbar shows the written path or the 422.

**Done when:**
- `docker images ctc-runner` lists the pinned tag.
- (1 Haiku run) A container-mode copy of `smoke` ends `done`, and `wf_runs.auth->>'authMethod'` is `claude.ai`.
- Cancelling a container `sleep` run leaves no `ctc-run-*` container in `docker ps`.
- Exporting `edit-demo` writes `.claude/workflows/edit-demo.js`.
- (1–2 Haiku runs) `claude -p --model haiku --allowedTools Workflow "run the edit-demo workflow"` completes.
- Exporting `gate` returns 422.

**Commit:** `feat(runner): m5 M6 — container mode (experimental if login fails) and native workflow export`

## Step 6: review, fix, final test
- **Reviewer** (1 agent, critical/high only) over `git diff <M1 commit>..HEAD`:
  - side effects that run twice (approval or continue re-running a finished node, parallel commits);
  - approval or quota state lost on restart;
  - container orphans;
  - shell injection in exported JS;
  - owner leaks;
  - contract mismatches between the dashboard and the API.
- **Fixer** (1 agent): applies the confirmed issues, then reruns the graph asserts, the import check and `pnpm build`.
- **Main session:**
  - restart `:18311` and re-run every milestone's Done-when;
  - a hand-driven browser pass recorded as **one video**: loop run with `×3` badges, the approval banner then Approve, the quota banner with the fake binary then Continue now, a compare page, the parallel run, the schedule editor, Export;
  - tick WB7–WB16 and WF7–WF12 in `PLAN.md`, update the PRD milestones table, then make a final commit if anything changed.
- **Report:** what's done, what's unverified, where the code lives (`m5-runner-core`, not pushed), and next owner steps (WH2, WH3, WH4, PR).

## Risks tonight
| Risk | Mitigation |
|---|---|
| Merging with PR 2 breaks something | Step 0 re-runs smoke before any new work; PR 2 stays untouched on its own branch and daemon |
| M2–M4 all edit `engine.py`/`graph.py` | Milestones run strictly in sequence; only backend ∥ frontend run in parallel |
| Approval/continue re-runs a finished node | Covered by asserts; the reviewer's first focus |
| Container login fails (credential mount) | Ship as experimental; no host bypass |
| Quota | Haiku only, about 5 runs; everything else uses shell nodes or the fake binary |
| Running past tonight | Each milestone ends in its own commit, so stopping at any point leaves a clean branch |
