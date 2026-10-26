# Feature Specification: n8n parity for the m5 workflow runner

**Feature Branch**: `001-n8n-parity` (Spec Kit feature id; code lands one branch per ticket, PR into `staging`)

**Created**: 2026-10-26

**Status**: Draft (converted from `.scratch/n8n-parity/spec.md`, status ready-for-agent, owner grilling Q1–Q19 on 2026-10-25)

**Input**: User description: "Clone n8n parity into the m5 workflow runner, using .scratch/n8n-parity/ (compare.md, spec.md, dispatch.md, issues/01-17)"

**Sources**: `.scratch/n8n-parity/compare.md` (n8n 2.43.7 vs m5 runner, 163 rows, REA evidence), `.scratch/n8n-parity/spec.md` (46 user stories, implementation decisions), `.scratch/n8n-parity/issues/01-17` (tickets), `.scratch/n8n-parity/dispatch.md` (file locks and waves). "Spec story N" below refers to the numbered user stories in `.scratch/n8n-parity/spec.md`.

## Context

The owner runs multi-step coding chains (plan → implement → test → review → PR) as m5 workflows: agent nodes on their own Claude subscription, shell nodes, IF, merge, approval and loops, with each run in its own git worktree. The core engine already matches n8n for this job and beats it on usage limits, token caps, git per run and loop caps. Parity here means closing n8n's **failure, iteration and authoring** gaps while keeping the runner's shape. It does not mean n8n's breadth (≈570 node types, item lists, SaaS nodes, multi-user). n8n is a behaviour reference only. Its code is never copied (decision 2026-10-20: built from scratch).

## Clarifications

### Session 2026-10-25 (owner grilling, carried over)

- Q: Does "never re-run a side effect" forbid a hand-started retry? → A: Manual retry and run-from-node are allowed because a human starts them and the worktree is first reset to the target step's starting commit. Automatic retry-on-fail is allowed only for shell nodes marked `idempotent: true`, never for agents.
- Q: Data model: n8n item lists or one JSON output per node? → A: One JSON output per node plus a for-each node.
- Q: Pinned output scope? → A: Only editor and CLI runs started with `--pinned`; never schedules or MCP. Auto-pinning later.
- Q: Notification channel? → A: One configurable shell command per run event (failed, waiting, quota, done), run data in env; no credentials store.
- Q: Read-only shells? → A: Remove `readonly` from shell nodes; it only changed batching and never sandboxed.
- Q: Sibling order and renames? → A: Keep ordering by node id; rewrite references on rename.
- Q: Draft vs published? → A: Scheduled runs use the committed HEAD of project-scope files; validate the graph when a schedule is enabled.
- Q: Graceful shutdown? → A: Stop claiming batches, let the current batch finish within 5 min, re-queue with walker state.
- Q: Pruning retention? → A: 30 days; always keep runs with a PR URL or a waiting status; dry run by default.
- Q: Sub-workflows, webhooks, Code/HTTP/Set nodes, chat trigger, other vendors, credentials store, team history? → A: Out of scope (see Out of Scope).
- Q: Test seam (Q18)? → A: One engine seam: run workflow YAML through the engine on a scratch Postgres schema with a fake `claude` binary; assert run/step rows.
- Q: Parallel build (Q19)? → A: Tickets that touch the same file never run at the same time.

## User Scenarios & Testing *(mandatory)*

Stories are ordered by value (compare.md "Top gaps"). Each maps to one ticket, one branch and one PR. All engine stories depend on the shared test seam (Foundational, ticket 01).

### User Story 1 - Retry a failed run, run from a node, run up to a node (Priority: P1) 🎯 MVP

Ticket 11 · spec stories 1–7. When a late node fails, the owner retries from the failed step without paying again for earlier agent nodes (≈44k startup tokens each). They can also start a new run from any node of an earlier run, reusing upstream outputs, or run only up to a chosen node to check the first half of a chain cheaply. They can do this from the run page or with `ctc retry`.

**Why this priority**: The biggest token and time saver. Today a late failure reruns the whole chain against the 5-hour window, and tuning one prompt means rerunning everything.

**Independent Test**: On the engine seam, run a 5-node chain whose node 4 fails. Retry it and assert that only node 4 onward executes, nodes 1–3 show as `reused` with the parent's outputs, and the worktree starts at node 4's pre-commit.

**Acceptance Scenarios**:

1. **Given** a run that failed at node 4, **When** the owner retries it, **Then** a new run linked to the parent executes only node 4 onward, nodes 1–3 are recorded as `reused` with the parent's outputs, and its worktree starts at node 4's pre-commit.
2. **Given** a `done` run, **When** the owner starts "run from" a middle node, **Then** upstream outputs are reused and execution starts at that node.
3. **Given** any workflow, **When** the owner starts a run with `to_node` set, **Then** the run stops with status `done` right after that node completes.
4. **Given** a parent run whose saved state or commits were pruned, **When** a retry is requested, **Then** it is rejected with a clear error.
5. **Given** the run page, **When** the owner views a step, **Then** "Retry", "Run from here" and "Run to here" are offered, and the new run links back to its parent.

---

### User Story 2 - Pin node outputs for test runs (Priority: P1)

Ticket 12 · spec stories 8–10. The owner pins a node's output, either from a past step or typed by hand, and starts a test run with `pinned` so IF, Switch, loop and template wiring can be checked without spending agent tokens.

**Why this priority**: Branch logic can only be tested with real agent runs today. Pins are also the basis for cheap iteration together with US1.

**Independent Test**: Engine seam: a 5-node chain with pins on both agent nodes, started with `pinned: true`, spends 0 agent tokens and evaluates IF and templates on the pinned outputs.

**Acceptance Scenarios**:

1. **Given** pins on both agent nodes, **When** a run starts with `pinned: true` from the editor or CLI, **Then** pinned nodes complete instantly with their pinned output, no agent is spawned, no commit is made, and steps are marked `pinned`.
2. **Given** pins exist, **When** a run starts without `pinned`, **Then** the pins are ignored and nodes execute for real.
3. **Given** a schedule or MCP start, **When** it asks for `pinned`, **Then** it is rejected.
4. **Given** the editor, **When** the owner pins a past step's output or edits a pin, **Then** the node shows a pin badge on the canvas and in the run.

---

### User Story 3 - Get notified on run events (Priority: P1)

Ticket 05 · spec story 11. One configurable shell command runs on each run status change to failed, waiting, quota or done. It gets the run id, status, workflow, dashboard URL and error in its environment, so the owner is pinged wherever they want without a credentials store.

**Why this priority**: Failures, approval waits and quota stops are silent unless the dashboard is open. This is cheap (S) and unblocks unattended runs.

**Independent Test**: Engine seam: a notify script writes its env to a file. Each of the four transitions fires it once with the right env, and a notify command that exits 1 or hangs leaves the run status unchanged.

**Acceptance Scenarios**:

1. **Given** `runner.notify` in server config (or a workflow `settings.notify` override), **When** a run moves to failed, waiting, quota or done, **Then** the command runs once per transition with `CTC_RUN_ID`, `CTC_RUN_STATUS`, `CTC_RUN_WORKFLOW`, `CTC_RUN_URL` and `CTC_RUN_ERROR` set.
2. **Given** a notify command that exits non-zero or sleeps past the 10 s timeout, **When** it fires, **Then** the run status is unchanged and output goes to the run's log dir.
3. **Given** no notify configured, **When** runs change status, **Then** behaviour is unchanged.

---

### User Story 4 - Drive runs from the CLI and from Claude over MCP (Priority: P1)

Ticket 04 · spec stories 12–14. The owner approves or rejects a waiting run from the CLI. From a Claude chat (MCP) they list workflows, read a run's step outputs, and approve, reject, continue or cancel runs. User-scope workflows start over MCP without a `project_required` error.

**Why this priority**: Approvals can only be given in the dashboard today, and Claude can start runs but cannot follow or steer them.

**Independent Test**: MCP/FastAPI test client on the scratch DB: list, status, approve, reject and cancel each call the same code path as the dashboard routes, respect owner scoping, and a user-scope workflow starts over MCP.

**Acceptance Scenarios**:

1. **Given** a waiting run, **When** the owner runs `ctc approve <run> [--note]` or `ctc reject <run> [--note]`, **Then** the run moves on or ends; a run that is not waiting gets a clear error.
2. **Given** Claude connected over MCP, **When** it calls `list_workflows`, `workflow_status`, `approve_run`, `reject_run`, `continue_run` or `cancel_run`, **Then** each uses the dashboard route's code path, respects owner scoping, and returns truncated step outputs where relevant.
3. **Given** a user-scope workflow, **When** `run_workflow` is called over MCP, **Then** it starts without `project_required`.

---

### User Story 5 - Prune old runs (Priority: P2)

Ticket 02 · spec stories 31–32. `ctc runs prune` shows which runs it would delete (worktrees, `ctc/*` branches, gz logs, rows older than 30 days). It deletes only with `--apply`, and always keeps runs that have a PR URL or are waiting.

**Why this priority**: Worktrees, branches, logs and rows grow forever on a 500 MB free tier. It's cheap (S) and has no lock conflicts.

**Independent Test**: Unit-test the selection logic with fake rows, plus one test with a real tmp git repo, a worktree and the scratch DB.

**Acceptance Scenarios**:

1. **Given** old runs, **When** `ctc runs prune` runs without `--apply`, **Then** it prints a table (run, workflow, age, branch, size) and deletes nothing.
2. **Given** eligible runs, **When** `--apply` is passed, **Then** worktree, branch, logs and rows are removed together per run; waiting runs and runs with a PR URL are kept.
3. **Given** a run whose worktree or branch is already gone, **When** pruned, **Then** it is pruned without error; re-running `--apply` is a no-op.
4. **Given** any prune, **Then** non-`ctc/` branches, the user's checkout and anything outside the runs dir are never touched.

---

### User Story 6 - Disable a node (Priority: P2)

Ticket 08 · spec stories 20–21. The owner marks a node `disabled` so the run passes straight through it without deleting or rewiring it. The skip is visible on the canvas and in the run.

**Why this priority**: Skipping a step means deleting and rewiring it today, and a hand-written `disabled: true` is silently ignored. It's cheap (S).

**Independent Test**: Engine seam: a disabled shell in a chain is skipped and the next node receives the previous node's output. Graph tests check that the validator rejects `disabled` on trigger, IF and Switch.

**Acceptance Scenarios**:

1. **Given** a chain with a disabled shell, **When** it runs, **Then** the step is written as skipped with a `disabled` marker and the next node receives the previous node's output.
2. **Given** `disabled` on a trigger, IF or Switch, **When** saved, **Then** the validator rejects it.
3. **Given** the editor and run page, **Then** a disabled node is greyed and its step shows "skipped (disabled)"; export drops and reconnects disabled nodes or refuses with a reason.

---

### User Story 7 - Retry flaky idempotent shell steps automatically (Priority: P2)

Ticket 09 · spec stories 15–16. A shell node marked `idempotent: true` can set `retry: {max_tries, wait_s}` so one flaky test or network step does not fail the run. Automatic retries never apply to agent nodes.

**Why this priority**: One flaky step currently fails the whole run, and safe retries are cheap (S).

**Independent Test**: Engine seam: a shell that fails twice then succeeds (counter file) ends `done` with 3 tries recorded. One that always fails ends `failed` after `max_tries` with the last error.

**Acceptance Scenarios**:

1. **Given** an idempotent shell with `retry: {max_tries: 3}`, **When** it fails twice then succeeds, **Then** the step ends `done` with 3 tries recorded.
2. **Given** a shell that always fails, **When** retries run out, **Then** the step ends `failed` with the last error and the try count.
3. **Given** `retry` on an agent or a non-idempotent shell, **When** saved, **Then** it is rejected.
4. **Given** a run cancel kills a shell, **Then** no retry is attempted.

---

### User Story 8 - Route failures down an error branch (Priority: P2)

Ticket 10 · spec stories 17–19. Each shell or agent node chooses `on_error: stop | continue | error_output`. With `error_output`, a failure fires a red `error` edge that carries `{error, output_tail, exit_code}`, so a fixer agent can act on it.

**Why this priority**: There is no way to send a failure to a fixer today, and `on_error: continue` has never been verified. For-each (US14) builds on this.

**Independent Test**: Engine seam fixer pattern: a test fails, the error edge fires, a fake fixer agent runs, and the flow returns to the test, capped by `max_visits`. `continue` and `stop` are tested too.

**Acceptance Scenarios**:

1. **Given** `on_error: error_output` and an `error` edge, **When** the node fails, **Then** only the error edge fires with `{error, output_tail, exit_code}` and the run continues down it.
2. **Given** the fixer loop, **When** the test keeps failing, **Then** the loop is capped by `max_visits`.
3. **Given** `on_error: continue` on a failing shell, **When** it fails, **Then** the run goes on with the failed step's output and the step stays `failed`.
4. **Given** the default `stop`, **Then** behaviour is unchanged. An `error` edge without `on_error: error_output` is rejected on save, and export refuses error edges with a reason.

---

### User Story 9 - Survive a planned daemon restart (Priority: P2)

Ticket 15 · spec story 30. On a planned stop (SIGTERM / `ctc daemon stop`), the runner stops claiming batches, waits up to 5 minutes for the running batch, and re-queues the run with its saved walker state. `scripts/deploy_local.sh` no longer fails the run in progress.

**Why this priority**: Every deploy currently fails the active run.

**Independent Test**: Engine seam, simulating the shutdown signal in-process: a run stopped between batches resumes from the next batch after restart with no re-executed step.

**Acceptance Scenarios**:

1. **Given** a run between batches, **When** a planned stop happens and the daemon restarts, **Then** the run continues from the next batch and no step runs twice.
2. **Given** a batch still running past the grace period, **When** time runs out, **Then** the batch is killed and the run fails as today.
3. **Given** no active run, **Then** shutdown behaviour is unchanged; a hard crash keeps "failed: daemon stopped mid-run".

---

### User Story 10 - Fix the known runner defects (Priority: P2)

Ticket 06 · spec story 44 (five of six fixes; the sixth is in US12). The run page keeps polling during `quota`, `resume_from` is validated in the graph validator, shell `readonly` is removed, the per-node compare route accepts every valid node id, and `plan` is in the permission picker.

**Why this priority**: Existing features don't behave as documented. Each fix is tiny (S) and lowers risk for later stories.

**Independent Test**: Graph tests for the `resume_from` and shell-`readonly` validation; browser QC for polling, the compare route and the permission picker.

**Acceptance Scenarios**:

1. **Given** a run in `quota`, **When** the run page is open, **Then** it keeps polling and shows the auto-resume.
2. **Given** a `resume_from` pointing at a node that cannot run earlier, **When** saved, **Then** the validator rejects it.
3. **Given** `readonly` on a shell node, **When** saved, **Then** it is rejected, the editor no longer offers the toggle on shells, and only read-only agents batch in parallel.
4. **Given** node ids with uppercase or underscores, **When** opening the per-node compare page, **Then** the route matches; `plan` is selectable as permission_mode.
5. **Given** the example workflows in `.claude/ctc-workflows/`, **Then** they still validate.

---

### User Story 11 - Richer IF and a Switch node (Priority: P3)

Ticket 03 · spec stories 22–23. IF combines conditions with and/or and supports number comparisons, regex, contains, not-contains and exists. A Switch node routes a multi-way verdict to named outputs with a default.

**Why this priority**: Real verdicts need chained IFs today. It's cheap (S) and has pure graph tests.

**Independent Test**: Pure graph tests (no DB): each op (including numbers given as strings, missing paths and invalid regex), and/or combinations, and Switch routing and validation.

**Acceptance Scenarios**:

1. **Given** existing single-condition IF workflows, **Then** they validate and run unchanged.
2. **Given** IF `conditions` with `combine: and|or` over mixed ops, **When** evaluated, **Then** results are correct; an invalid regex is rejected on save.
3. **Given** a Switch with cases, **When** evaluated, **Then** the first matching case's handle fires, else `default`; unknown handles and duplicate or non-slug case names are rejected.
4. **Given** the editor, **When** the owner builds IF conditions and a Switch with 3 cases, **Then** they save and reload; export translates them faithfully or refuses with a reason.

---

### User Story 12 - Scheduled runs use the committed version (Priority: P3)

Ticket 07 · spec stories 33–34 and the sixth cheap fix. A scheduled run of a project-scope workflow loads the file from the project's committed HEAD, so half-edited workflows never run unattended. Enabling a schedule validates the graph first.

**Why this priority**: It prevents unattended surprises; small (S) with no lock conflicts.

**Independent Test**: Unit tests with a tmp git repo: an edited but uncommitted workflow fires with the committed version, and an uncommitted new workflow's schedule fires nothing and logs why.

**Acceptance Scenarios**:

1. **Given** a project workflow edited but not committed, **When** its schedule fires, **Then** the committed HEAD version runs and the run records that commit's file sha.
2. **Given** a new workflow that was never committed, **When** its schedule fires, **Then** no run is created and the reason is logged.
3. **Given** an invalid graph, **When** the owner enables its schedule, **Then** it is rejected with the validation errors.
4. **Given** manual, CLI or MCP runs and user-scope workflows, **Then** they keep using the saved file.

---

### User Story 13 - Template roots, vars, reference warnings, stop node and timeouts (Priority: P3)

Ticket 14 · spec stories 26–29. Templates reach `run.id`, `run.visit`, `run.trigger`, `now` and a workflow `vars:` block. Validation warns on references that cannot resolve. A `stop` node fails a run on purpose, and `max_run_minutes` and `approval_timeout_minutes` stop runs from hanging or waiting forever.

**Why this priority**: These are authoring safety and control features. A rename or typo silently renders as "" today.

**Independent Test**: Graph tests for template rendering and warnings, plus engine-seam cases with tiny timeout values and a stop node.

**Acceptance Scenarios**:

1. **Given** templates using the new roots and `vars.*`, **When** rendered, **Then** they resolve.
2. **Given** a reference to a node that cannot run earlier, or a field that cannot exist, **When** saved, **Then** a non-blocking warning is returned with the errors and shown in the editor.
3. **Given** a `stop` node, **When** reached, **Then** the run fails with its rendered message.
4. **Given** `max_run_minutes` or `approval_timeout_minutes`, **When** exceeded, **Then** the run is stopped and failed with a clear error.

---

### User Story 14 - For-each over a list (Priority: P3)

Ticket 13 · spec stories 24–25. A `foreach` node runs its body once per item of a JSON array from an earlier node, in order, with a `max_items` cap. It exposes `item` and `index` to templates and outputs an array of body results, e.g. one fixer per failing test.

**Why this priority**: It replaces n8n's item lists within the one-output model. Medium effort (M), and it depends on US8's `on_error` for failed items.

**Independent Test**: Engine seam: a shell outputs a JSON list of 3 names, the foreach runs a fake agent body 3 times with each name, and the output lists 3 results. Graph tests cover body validation.

**Acceptance Scenarios**:

1. **Given** a 3-item list, **When** the foreach runs, **Then** the body runs 3 times in order with `item`/`index` and the node outputs `{items: [3 results]}` on `done`.
2. **Given** more items than `max_items`, **Then** the list is truncated and the truncation is recorded in the step output.
3. **Given** an empty list, **Then** the body never runs and the output is `{items: []}`.
4. **Given** a body that does not return to the foreach, has edges leaving it, or an `items` path that cannot resolve, **When** saved, **Then** it is rejected; export refuses foreach with a reason.

---

### User Story 15 - Editor basics and a step list (Priority: P3)

Ticket 16 · spec stories 38–43. The editor gets undo/redo, copy/paste of nodes with their edges, node notes, and a rename that rewrites every template reference. A save fails with a clear conflict when the file changed on disk. The run page lists every step with status, duration, tokens and error.

**Why this priority**: Quality of life plus safety, because a save silently overwrites git edits today. Mostly UI (browser QC).

**Independent Test**: An API test (save after an on-disk edit returns 409 and overwrites nothing), a graph test (rename rewrites templates in prompts and commands), and browser QC for undo/redo, copy/paste, notes and the step list.

**Acceptance Scenarios**:

1. **Given** edits in the editor, **When** the owner presses undo/redo (keyboard or buttons), **Then** the graph history moves back and forth.
2. **Given** selected nodes, **When** copied and pasted, **Then** they and their internal edges are pasted as YAML with de-duplicated ids.
3. **Given** a node rename, **Then** every `{{old.*}}` reference and edge is rewritten.
4. **Given** the file changed on disk after load, **When** the owner saves, **Then** the server returns 409, nothing is overwritten, and the editor offers reload or overwrite.
5. **Given** a run, **Then** the run page shows a step list (node, visit, status, duration, tokens, error).

---

### User Story 16 - Typed run inputs and a workflow builder skill (Priority: P3)

Ticket 17 · spec stories 35–37. A trigger declares named, typed inputs that the editor, CLI, MCP and API all validate. `ctc workflow validate` checks a file, and a `ctc-workflow-builder` skill drafts workflow YAML from a description and validates it.

**Why this priority**: An input contract and "describe it, get a workflow" are cheap here (S–M) because workflows are plain YAML. It depends on US4's MCP work.

**Independent Test**: API/MCP tests show that a missing required input or a wrong type is rejected at start; graph tests check input coercion; browser QC covers the run dialog.

**Acceptance Scenarios**:

1. **Given** trigger `inputs` with types and required flags, **When** a run starts from the API, CLI (`--input name=value`) or MCP with a missing or wrong input, **Then** it is rejected with a clear message; valid inputs are coerced and reachable as `input.<name>`.
2. **Given** a workflow without `inputs`, **Then** the free-text `input` keeps working.
3. **Given** the editor, **When** the owner clicks run, **Then** the dialog renders the declared inputs.
4. **Given** `ctc workflow validate <file>`, **Then** it prints validation errors and warnings; the builder skill produces a workflow that validates.

---

### Edge Cases

- Retry or run-from when the parent's worktree, branch or step commits were pruned (US1 rejects with a clear error; US5 must not prune runs a retry still needs if they are waiting or have a PR URL).
- Run-from a node inside a loop body or after a merge (seed walker state so visit counts and merge inputs match the parent).
- Pinned node whose pinned output lacks a field a downstream template uses (US13 warnings should flag it at save time).
- Retry-on-fail when the run is cancelled mid-wait (no further tries; the step ends cancelled).
- An error edge that loops back forever (capped by `max_visits` and the run node backstop).
- For-each body item failing with `on_error: stop` (the run fails; earlier item outputs stay recorded).
- Planned shutdown during a quota wait or an approval wait (the run stays waiting/quota; nothing to re-queue).
- Notify command that prints huge output or never exits (10 s timeout, output to the run log dir, run status unchanged).
- Schedule fires while the workflow file is staged but not committed (the committed HEAD version runs).
- Switch/IF regex that is valid Python but catastrophic on long input (cap input length or time; validator compiles it).
- Save conflict when the file was deleted on disk (treated as a conflict).
- Typed `json` input that is invalid JSON (rejected at start).

## Requirements *(mandatory)*

### Functional Requirements

**Model and invariants**
- **FR-001**: The runner MUST keep one JSON output per node; for-each is the only new iteration construct besides loops with visit caps.
- **FR-002**: Workflow files MUST stay YAML (project scope in the repo, user scope in the user folder). Every new field MUST be optional and checked by the graph validator on save and on run.
- **FR-003**: Runs MUST NOT re-execute a side effect after a crash. Manual retry and run-from-node MUST first reset the worktree to the target step's starting commit. Automatic retry MUST apply only to shell nodes with `idempotent: true`, never to agents.
- **FR-004**: Sibling ordering MUST stay by node id; renames MUST rewrite references instead.
- **FR-005**: The `readonly` flag MUST be removed from shell nodes; only read-only agents batch in parallel.

**Failure and iteration (US1–US2, US7–US9)**
- **FR-010**: The system MUST create a retry or partial run as a new run row linked to its parent, with optional `from_node` and `to_node`, seeded from the parent's saved walker state up to `from_node`, with its worktree created from the `from_node` step's starting commit.
- **FR-011**: A run with `to_node` MUST stop with status `done` after that node completes.
- **FR-012**: Pinned nodes MUST complete instantly with their pinned output and a `pinned` step marker, only for runs started with the pinned flag from the editor or CLI. Schedule and MCP triggers MUST reject the flag.
- **FR-013**: Shell nodes MUST support `retry: {max_tries 1..5, wait_s 0..300}` only together with `idempotent: true`, and record the try count and last error.
- **FR-014**: Shell and agent nodes MUST support `on_error: stop | continue | error_output` (default `stop`). Error edges MUST fire with `{error, output_tail, exit_code}`.
- **FR-015**: A planned stop MUST stop claiming batches, wait up to 5 minutes (configurable) for the current batch, then re-queue the run with its saved walker state.
- **FR-016**: `disabled: true` MUST make the walker pass through a node (output = upstream output); it MUST be rejected on trigger, IF and Switch.

**Visibility and control (US3–US5)**
- **FR-020**: After each run status change to failed, waiting, quota or done, the engine MUST run the configured notify command with `CTC_RUN_ID`, `CTC_RUN_STATUS`, `CTC_RUN_WORKFLOW`, `CTC_RUN_URL` and `CTC_RUN_ERROR`, with a 10 s timeout. A failing notify MUST NOT change the run.
- **FR-021**: The CLI MUST offer `ctc approve`, `ctc reject`, `ctc retry`, `ctc runs prune [--days 30] [--apply]`, `ctc run --pinned`, `--input name=value` and `ctc workflow validate <file>`.
- **FR-022**: MCP MUST offer `list_workflows`, `run_workflow` (typed inputs, user scope works), `workflow_status` (truncated step outputs), `approve_run`, `reject_run`, `continue_run` and `cancel_run`, each reusing the dashboard route's code path and owner scoping.
- **FR-023**: Pruning MUST default to a dry run, keep 30 days, always keep runs with a PR URL or a waiting status, and remove worktree, `ctc/*` branch, gz logs and rows together. It MUST never touch non-`ctc/` branches or the user's checkout.

**Graph expressiveness (US11, US13, US14, US16)**
- **FR-030**: IF MUST accept `conditions: [{path, op, value}]` with `combine: and | or` and ops `eq ne gt ge lt le contains not_contains regex exists truthy`; the old single `path/op/value` form stays valid.
- **FR-031**: A `switch` node MUST route to the first matching named case, else `default`.
- **FR-032**: A `foreach` node MUST run its body per item in order (sequential), with `items`, `max_items` (default 50) and `item`/`index` roots, and output `{items: [...]}`.
- **FR-033**: A `stop` node MUST fail the run with its rendered `message`.
- **FR-034**: Templates MUST reach `input`, `run.id`, `run.visit`, `run.trigger`, `now`, `vars`, `item`/`index` inside a for-each body, and node ids. Validation MUST warn (not block) on unresolvable references.
- **FR-035**: Workflow settings MUST support `max_run_minutes`, `approval_timeout_minutes` and `notify`, plus a `vars:` block.
- **FR-036**: Triggers MUST support `inputs: [{name, type: string|number|bool|json, required, default, description}]`. All run starts MUST validate and coerce them; workflows without `inputs` keep the free-text `input`.

**Operations and authoring (US10, US12, US15)**
- **FR-040**: Scheduled runs of project-scope workflows MUST load the committed HEAD version and record its sha. Enabling a schedule MUST validate the graph.
- **FR-041**: Workflow saves MUST carry the base file hash; the server MUST return a conflict (409) when the file changed on disk.
- **FR-042**: The editor MUST offer undo/redo, copy/paste, node notes, a rename that rewrites references, and a run-page step list.
- **FR-043**: The five defects in US10 MUST be fixed.

**Cross-cutting**
- **FR-050**: Every new node type and setting MUST survive export to native `.claude/workflows/*.js` or be refused there with a clear reason (spec story 45).
- **FR-051**: Every new engine feature MUST be covered by tests at the engine seam (spec story 46). Pure graph logic gets DB-free tests, and API/MCP behaviour is tested through the FastAPI test client.
- **FR-052**: Schema changes MUST be additive and applied by the idempotent schema file.
- **FR-053**: The dashboard API MUST stay field-for-field with `dashboard/src/types.ts`.

### Key Entities

- **Workflow (YAML file)**: nodes, edges, settings. Gains `vars`, settings `max_run_minutes` / `approval_timeout_minutes` / `notify`, and trigger `inputs`.
- **Node**: gains `disabled`, `on_error`, `retry` + `idempotent` (shell), `pin`, `notes`. New types: `switch`, `foreach`, `stop`. IF gains `conditions` + `combine`.
- **Edge**: new handles: Switch case names + `default`, `error` (error_output), foreach `body` / `done`.
- **Run (`wf_runs`)**: gains parent run reference, `from_node`, `to_node`, pinned flag.
- **Step (`wf_steps`)**: gains `pinned` / `reused` / `disabled` markers and a try count.
- **Schedule (`wf_schedules`)**: unchanged rows; firing reads committed HEAD.
- **Notify command**: daemon-wide `runner.notify` in `config/server.yaml`, overridable per workflow.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Retrying a run that failed at node N re-executes 0 nodes before N (each skipped agent node saves ≈44k startup tokens).
- **SC-002**: A test run with all agent nodes pinned spends 0 agent tokens.
- **SC-003**: Every failed, waiting, quota or done transition triggers exactly one notify call; 0 run statuses are changed by a failing notify.
- **SC-004**: A planned daemon restart during an active run re-executes 0 completed steps.
- **SC-005**: `ctc runs prune --apply` never removes a waiting run, a run with a PR URL, or a non-`ctc/` branch.
- **SC-006**: All 16 stories ship with tests at the named seam, and `scripts/check.sh` stays green on every PR.
- **SC-007**: The compare.md gap counts for the targeted rows (retry-failed-execution, partial-execution, destination-node-run, pin-data, error-workflow, send-and-wait-hitl, execution-pruning, disabled-node-passthrough, retry-on-fail, on-error-modes, suspend-between-nodes, if-node, switch-node, mcp-server-trigger, form-trigger-and-form, ai-workflow-builder, save-conflict-checksum, execution-timeout, stop-and-error, loop-over-items, node-rename-reference-rewrite) move from missing/partial to have.

## Assumptions

- A scratch Postgres with pgvector (e.g. the `ctc-dev-pg` container) is available for engine-seam tests via `CTC_DATABASE_URL`; tests skip cleanly when it is unset or points at Supabase, so CI stays green.
- Parallel lanes (shipyard on cnsh) build one ticket each with PRs into `staging`; tickets touching the same file never run at the same time.
- No Anthropic API key; agent nodes use the installed `claude` on the owner's subscription; tests use a fake `claude` binary via `CTC_CLAUDE_BIN`.
- The Spec Kit constitution (`.specify/memory/constitution.md`) is still the blank template; `CLAUDE.md` and `PLAN.md` "Constraints" govern.
- Updating `PLAN.md`'s build order for this milestone is a separate proposal.

## Out of Scope

- External webhooks, chat trigger, other model vendors, credentials store (secrets stay in env, referenced by name), Code/HTTP/Set/Filter and other item nodes, n8n item lists, SaaS integration nodes, team run history, RBAC and sharing UI, version history UI, auto-layout, hosted or multi-user execution.
- Sub-workflow (execute-workflow) nodes: deferred until retry and pins land.
- Parallel for-each items and automatic pinning of test runs.
- Copying n8n source code (fair-code licence; behaviour reference only).
