# Spec: n8n parity for the m5 workflow runner

Status: ready-for-agent
Date: 2026-10-25
Inputs: `compare.md` (this folder: n8n 2.43.7 vs m5 runner, 163 rows, REA evidence) and the owner's grilling answers Q1–Q19 (2026-10-25). Tickets: `issues/NN-*.md`.

## Problem Statement

The owner runs multi-step coding chains (plan → implement → test → review → PR) as m5 workflows: agent nodes on their own Claude subscription, shell nodes, IF, merge, approval, loops, each run in its own git worktree. The core engine already matches n8n for this job and beats it on usage limits, token caps, git per run and loop caps. But the moments that hurt are failing and iterating:

- A late failure throws away every earlier agent node (about 44k startup tokens each), and there is no retry, no "run from here" and no "run up to here". Tuning one prompt means rerunning the whole chain against the 5-hour window.
- Branch logic can only be tested with real agent runs: there are no pinned outputs.
- Failures, approval waits and quota stops are silent unless the dashboard is open, and approvals can only be given in the dashboard.
- A flaky test step fails the whole run; there is no error branch to route a failure to a fixer; a node cannot be skipped without deleting it.
- IF has four operators and no Switch; there is no for-each over an agent's list output.
- Worktrees, `ctc/*` branches, logs and rows grow forever; a daemon restart fails the run in progress.
- From a Claude chat the owner can start a run but cannot list workflows, read step output, approve, continue or cancel.
- The editor has no undo, copy/paste, notes or rename safety, and a save silently overwrites edits made in git.

## Solution

Close the failure-and-iteration gaps with n8n while keeping the runner's shape: one JSON output per node, YAML workflow files in git, the walker state the engine already saves, the subscription-only execution model. Breadth stays out (SaaS nodes, item lists, credentials store, webhooks, multi-user). Concretely the owner gets: manual retry, run-from-node and run-to-node; pinned outputs for test runs; a notify command per run event plus approve/reject from the CLI and MCP; retry-on-fail for idempotent shell steps; an error branch; disabled nodes; richer IF plus Switch; a for-each node; run and approval timeouts, a stop-and-error node, more template roots and a `vars:` block; graceful daemon shutdown; run pruning; schedules that run the committed version; a declared run input contract and a workflow-builder skill; and editor basics (undo/redo, copy/paste, notes, rename rewrite, save-conflict detection, a step list on the run page).

## User Stories

1. As the owner, I want to retry a failed run by hand, so that a late failure does not cost me every earlier agent node again.
2. As the owner, I want a retry to start from the failed step on a worktree reset to that step's starting commit, so that the retry never builds on the failed step's half-done edits.
3. As the owner, I want to start a new run from any node of an earlier run, reusing the upstream outputs, so that I can tune one prompt without rerunning the chain.
4. As the owner, I want to run a workflow only up to a chosen node, so that I can check the first half of a chain cheaply.
5. As the owner, I want the run page to offer "Retry", "Run from here" and "Run to here" on steps, so that I do not need the CLI for it.
6. As the owner, I want `ctc retry <run> [--from <node>] [--to <node>]`, so that I can do the same from a terminal or a script.
7. As the owner, I want a run started from another run to link back to it, so that history shows where it came from.
8. As the owner, I want to pin a node's output (from a past step or typed by hand), so that I can test IF, Switch, loop and template wiring without spending agent tokens.
9. As the owner, I want pins to apply only when I start an editor or CLI run with `--pinned`, so that schedules and MCP runs always execute for real.
10. As the owner, I want pinned nodes shown as pinned on the canvas and in the run, so that I never mistake a pinned output for a real one.
11. As the owner, I want one configurable shell command to run on each run event (failed, waiting, quota, done) with the run id, status and dashboard URL in its environment, so that I get pinged wherever I want without a credentials store.
12. As the owner, I want to approve or reject a waiting run from the CLI, so that an approval does not need the dashboard.
13. As the owner, I want Claude (over MCP) to list workflows, read a run's step outputs, approve, reject, continue and cancel runs, so that I can drive runs from a chat.
14. As the owner, I want user-scope workflows to start over MCP without a `project_required` error, so that every workflow I can see is runnable from chat.
15. As the owner, I want a shell node marked idempotent to retry on failure with a max tries and a wait between tries, so that one flaky test does not fail the run.
16. As the owner, I want automatic retries never to apply to agent nodes, so that a side effect is never repeated without me deciding it.
17. As the owner, I want each node to choose `on_error: stop | continue | error_output`, so that a failure can stop the run, be tolerated, or be sent down an error edge.
18. As the owner, I want an error edge to carry the failed step's error and output tail, so that a fixer agent can act on it.
19. As the owner, I want `on_error: continue` proven by a test, so that I can trust it (today it is unverified).
20. As the owner, I want to disable a node so the run passes straight through it, so that I can skip a step without deleting and rewiring it.
21. As the owner, I want a disabled node shown greyed on the canvas and as "skipped (disabled)" in the run, so that the skip is visible.
22. As the owner, I want IF to combine conditions with and/or and to support number comparisons, regex, contains, not-contains and exists, so that one IF can express a real verdict.
23. As the owner, I want a Switch node with named outputs and a default output, so that a three-way verdict does not need chained IFs.
24. As the owner, I want a for-each node that runs its body once per item of a JSON array from an earlier node, in order, with a `max_items` cap, and outputs an array of the body's results, so that I can run one fixer per failing test or file.
25. As the owner, I want for-each items and their index available to templates inside the body, so that each pass knows its item.
26. As the owner, I want templates to reach `run.id`, `run.visit`, `now` and a workflow-level `vars:` block, so that prompts and commands can use run metadata and shared constants.
27. As the owner, I want validation to warn when a template references a node or field that cannot exist, so that a typo or rename does not silently render as an empty string.
28. As the owner, I want a stop-and-error node, so that a graph can fail a run on purpose with a message.
29. As the owner, I want a per-run wall-clock limit and an approval wait limit, so that a run cannot hang or wait forever.
30. As the owner, I want a planned daemon stop to finish the current batch within a grace period and re-queue the run with its saved state, so that `deploy_local.sh` no longer fails runs in progress.
31. As the owner, I want `ctc runs prune` to show what it would delete (worktrees, `ctc/*` branches, logs, rows older than 30 days) and delete only with `--apply`, so that disk and the free-tier database stop growing without surprises.
32. As the owner, I want pruning to keep runs that have a PR URL or are waiting, so that nothing I still need disappears.
33. As the owner, I want a scheduled run to use the committed HEAD version of a project workflow file, so that half-edited workflows never run unattended.
34. As the owner, I want enabling a schedule to validate the graph first, so that a broken workflow cannot be scheduled.
35. As the owner, I want a workflow's trigger to declare named inputs with types and required flags, so that runs from the editor, CLI and MCP all get a checked input instead of one free-text string.
36. As the owner, I want the editor and `run_workflow` to show and enforce that input contract, so that a run cannot start with missing inputs.
37. As the owner, I want `ctc workflow validate <file>` and a workflow-builder skill that drafts YAML from a description and validates it, so that I can describe a chain and get a runnable workflow.
38. As the owner, I want undo and redo in the editor, so that a mistaken drag or delete is cheap.
39. As the owner, I want to copy and paste nodes (with their edges) as YAML/JSON, so that I can reuse parts of workflows.
40. As the owner, I want notes on nodes, so that a workflow explains itself.
41. As the owner, I want renaming a node to rewrite every template reference to it, so that a rename never breaks the graph silently.
42. As the owner, I want a save to fail with a clear conflict when the file changed on disk since I opened it, so that I never overwrite edits made in git or by hand.
43. As the owner, I want the run page to list every step with status, duration, tokens and error, so that I can read a run without the canvas.
44. As the owner, I want the six small defects found in the comparison fixed (schedule validation, polling during quota, `resume_from` validation, the misleading read-only flag on shell nodes, the compare route regex, `plan` in the permission picker), so that existing features behave as documented.
45. As the owner, I want every new node type and setting to survive export to native `.claude/workflows/*.js` or be refused there with a clear reason, so that export never produces a wrong workflow.
46. As the owner, I want every new feature covered by tests at the engine seam, so that the runner keeps working as lanes change it in parallel.

## Implementation Decisions

**Model and invariants (unchanged unless stated)**
- One JSON output per node; no n8n item lists. The for-each node is the only iteration construct besides loops with visit caps.
- Workflow files stay YAML (project scope in the repo, user scope in the user's folder); every new field is optional and validated by the graph validator on save and on run.
- Runs still never re-execute a side effect after a crash. Manual retry and run-from-node are allowed because a human starts them and the worktree is first reset to the target step's starting commit (owner, Q2). Automatic retry-on-fail is allowed only for shell nodes marked `idempotent: true`, never for agents.
- Ordering of siblings stays by node id. Renames rewrite references instead of changing ordering rules (Q9).
- The `readonly` flag is removed from shell nodes: it only changed batching and never sandboxed anything (Q9). Only read-only agents batch in parallel.

**New and changed workflow fields**
- Node: `disabled: bool`; `on_error: stop | continue | error_output` (default `stop`); `retry: {max_tries, wait_s}` and `idempotent: bool` (shell only); `pin: {output: <json>}`; `notes: str`.
- IF: `conditions: [{path, op, value}]` with `combine: and | or`; ops `eq ne gt ge lt le contains not_contains regex exists truthy`. The old single `path/op/value` form stays valid.
- Switch (new type): `cases: [{name, conditions, combine}]` plus an implicit `default` output; outgoing edges use the case name as handle.
- For-each (new type): `items: <template path to a JSON array>`, `max_items` (default 50), a body sub-graph entered by a `body` handle and returning to the for-each node; the node outputs `{items: [...body outputs...]}`. Sequential only; `parallel: N` is later.
- Stop-and-error (new type): `message` template; fails the run with that message.
- Trigger: `inputs: [{name, type: string|number|bool|json, required, default, description}]`; templates reach them as `input.<name>`; the old free-text `input` keeps working when no inputs are declared.
- Workflow: `vars: {name: value}`; settings `max_run_minutes`, `approval_timeout_minutes`, `notify` (overrides the daemon-wide notify command).
- Template roots: `input`, `run` (`run.id`, `run.visit`, `run.trigger`), `now`, `vars`, `item`/`index` inside a for-each body, plus node ids. Validation warns on references that cannot resolve.

**Engine**
- A retry or partial run is a new run row linked to its parent run, carrying a start node and/or a stop node; its walker state is seeded from the parent's saved state up to the start node, and its worktree is created from the start step's starting commit. Run-to stops cleanly (status `done`) after the stop node.
- Pinned nodes complete instantly with their pinned output and a `pinned` step marker, only for runs started with the pinned flag from the editor or CLI; schedule and MCP triggers reject the flag.
- Error edges fire with `{error, output_tail, exit_code}` of the failed step; `continue` keeps today's behaviour (the node's output, failed status, run goes on).
- Notify: after each run status change to failed, waiting, quota or done, the engine runs the configured command with `CTC_RUN_ID`, `CTC_RUN_STATUS`, `CTC_RUN_WORKFLOW`, `CTC_RUN_URL`, `CTC_RUN_ERROR` in the environment, with a short timeout; a failing notify command never changes the run.
- Graceful shutdown: on a planned stop the runner stops claiming batches, waits up to 5 minutes for the current batch, then re-queues the run with its saved walker state; only a hard crash still marks the run failed.
- Run timeout and approval timeout end the run as failed with a clear error.

**Interfaces**
- Dashboard API (field-for-field with the dashboard types, as today): run start accepts `pinned`, typed `inputs`; new retry endpoint (run id, optional from/to node); approve/reject/continue/cancel stay as they are; run detail includes `parent_run_id`, start/stop node and per-step `pinned`/`disabled` markers; workflow save carries the base file hash and returns a conflict when the file changed.
- CLI: `ctc retry`, `ctc approve` / `ctc reject`, `ctc runs prune [--days 30] [--apply]`, `ctc run --pinned` and `--input name=value`, `ctc workflow validate <file>`.
- MCP: `list_workflows`, `run_workflow` (typed inputs, user scope works), `workflow_status` (with step outputs, truncated), `approve_run`, `reject_run`, `continue_run`, `cancel_run`.
- Schema: run rows gain a parent run reference, start node, stop node and pinned flag; step rows gain a pinned marker. All changes are additive and applied by the idempotent schema file.
- Native export refuses workflows using approval, pins-only features, error edges, for-each or Switch unless it can translate them faithfully, with a clear reason.

**Pruning**
- Keep 30 days by default; always keep runs with a PR URL and waiting runs. Removes worktree, branch, gz logs and rows together. Dry run by default; `--apply` deletes. Never touches the user's checkout or non-`ctc/` branches.

**Schedules**
- A scheduled run loads the workflow from the committed HEAD of its project file (user-scope files have no history and run as saved). Enabling a schedule validates the graph.

## Testing Decisions

- A good test drives external behaviour: a workflow YAML goes in, run and step rows (statuses, outputs, markers, errors) come out. Tests never assert on private helpers or exact log text.
- **The one main seam (Q18):** run a workflow through the engine against a scratch Postgres schema, with the claude binary replaced by a fake script (`CTC_CLAUDE_BIN`) that answers the version and auth checks and replays scripted stream-json. Assert the rows. It skips cleanly when no scratch database is configured (Supabase or unset), so CI without a database stays green; shipyard lanes run it against their isolated test database. The first ticket builds this seam; every engine ticket adds cases to it.
- Pure graph tests (validation, walker, IF/Switch evaluation, template rendering, rename rewrite) run without a database.
- API and MCP behaviour is tested through the FastAPI test client on the same scratch database where needed.
- Editor features are checked by browser QC in the lane (the harness's local QC agent) plus a type-check and build; no unit tests for React components.
- Prior art: the `__main__` self-checks in the runner modules (walker, engine, schedule, proc, export), the existing pytest file in `tests/`, and the fake-claude quota/overage scripts in `scripts/`.

## Out of Scope

- External webhooks, a chat trigger, other model vendors, a credentials store (secrets stay in the environment, referenced by name), Code/HTTP/Set/Filter and other item nodes, n8n item lists, SaaS integration nodes, team run history, RBAC and sharing UI, version history UI, auto-layout, hosted or multi-user execution (Q3 and the PRD's out-of-scope list).
- Sub-workflow (execute-workflow) nodes: deferred until retry and pins have landed.
- Parallel for-each items, automatic pinning of test runs.
- Updating `PLAN.md`'s build order with this milestone: a separate proposal (Q11).

## Further Notes

- Built in parallel by shipyard lanes on cnsh, one ticket per lane and PR into `staging`; tickets that touch the same files never run at the same time (Q19), so expect three to four lanes per wave.
- Hotspot files: the walker/validator, the engine, the workflow editor, the native exporter, the CLI. Keep changes in them small and local; prefer a new module when a feature has its own logic (pruning, notify).
- Every PR keeps `scripts/check.sh` green and adds tests at the seam above.
