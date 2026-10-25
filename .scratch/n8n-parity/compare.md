# n8n 2.43.7 vs ctc m5 runner — feature comparison

Date: 2026-10-25

## Bottom line

On the core engine, the ctc m5 runner is close to n8n for the job it is built for, and ahead of n8n in a few places. Our run loop, branching, merge, loops, approval waits, cancel, step records and saved run state match n8n's behaviour. We go further than n8n on quota handling, the run token cap, git worktrees, loop caps and progress that is saved by default. We are far from n8n in breadth. n8n ships about 570 node types and a mature editor. We ship six node types and rely on shell, Claude Code and MCP for the rest. The matrix has 163 rows, and 125 of them apply to us. Of those 125, 36 are "have" or better, 44 are partial and 45 are missing. The other 38 rows are not applicable or ruled out by a written decision. The gaps that matter sit around failure and testing: retry, run-from-node, pinned outputs, notifications, pruning and graceful restarts. Most of them are S or M, because they can reuse the walker state we already save. Full parity is not a goal. Most of the remaining distance is item lists, SaaS nodes and multi-user features that the PRD rules out.

## Method and coverage

**What was compared**
- **n8n 2.43.7:** the shipped JS was copied out of the local n8n Docker image and analysed with REA. The analysis was static only; nothing was executed. Some files were read directly or grepped. Their evidence cells say "read directly" or "no REA" and carry no evidence id.
- **ctc m5 runner:** the `m5-runner-core` working tree (HEAD `931577e`), plus `.claude/prds/workflow-runner.md` (PRD) and `PLAN.md`.
- **Path legend for our evidence:**
  - `graph.py`, `engine.py`, `proc.py`, `schedule.py`, `export.py` are in `src/ctc/runner/`.
  - `runs.py`, `library.py`, `mcp.py`, `app.py`, `schemas.py`, `hooks.py` are in `src/ctc/server/`.
  - `schema.sql` is in `src/ctc/storage/`, `cli.py` in `src/ctc/`, `scanner.py` in `src/ctc/ingestion/`.
  - `Workflows.tsx`, `Runs.tsx`, `App.tsx` are in `dashboard/src/`.
  - "PRD:n" means a line of the PRD.
- **Evidence ids:** the matrix shortens each REA id to `ev_` plus its first 12 hex characters. The appendix lists every full id.

**Four inventories**
- **engine:** n8n-core's execution engine (`workflow-execute.js`, the partial-execution utils, lifecycle hooks) and n8n-workflow (data proxy, expressions). Also engine v2 (`@n8n/engine`) and the CLI's execution services: runner, retry, waits, concurrency, scaling, recovery and pruning.
- **nodes:** the n8n-nodes-base and langchain catalogs (`nodes.json`), the core flow nodes, triggers, `@n8n/scheduler`, node settings and `@n8n/config`.
- **product:** CLI controllers and modules (workflows, executions, history, credentials, MCP, AI, insights, source control, community packages), the public API, the editor UI bundle and `@n8n/api-types`.
- **ours:** the m5 runner, its server routes, the dashboard, the schema, the PRD and PLAN, and the runner's known limits.

**Coverage gaps the inventory agents reported**
- **engine:**
  - The editor side of partial runs was not traced.
  - These engine v2 parts were not read: the compatibility layer, iteration mapping, the loop ledger and the cancel service.
  - Some partial-execution utils were not read line by line.
  - Expression-runtime and task-runner internals were not read.
  - A version mismatch in the Wait node was left unresolved.
  - Not covered: activation, poll jobs, leader election, Bull settings, the storage location and redaction.
- **nodes:**
  - n8n-workflow ships no `.d.ts`, so node fields were inferred from how they are used.
  - `nodes.json` was read by a script, and most SaaS node `execute()` code was never opened.
  - The category counts overlap.
  - From the scheduler, only `misfire.js` was read for meaning.
  - These were seen by file name or description only: MCP trigger internals, the HITL webhooks, evaluation metrics, data tables and Respond to Webhook.
- **product:**
  - Push message shapes come from type literals.
  - Workflow settings were rebuilt from the DTO and the UI strings.
  - REA graphs were truncated on the large UI chunks (node cap 5000), so the UI rows rest on minified code and locale strings.
  - Many enterprise modules were seen only as file listings.
  - Autocomplete, the collaboration CRDT, the template gallery and the AI products are known from routes and strings only.
- **ours:** several Claude Code behaviours are still unverified:
  - real `-p` output when the usage limit is hit
  - the `rate_limit_event` and overage fields
  - `--session-id` combined with `--fork-session`
  - `dontAsk` behaviour
  - `DISABLE_AUTOUPDATER`
  - a setup-token under bare mode
  - the container credential mount
  - whether `--setting-sources` lowers the ~44k startup tokens per node

  `ctc runner upgrade` and `on_error: continue` are also unverified, and WH2, WH3 and WH4 are open.
- **All four:** nothing was observed at run time.

**Verify pass**

| Side | Checks | Confirmed | Partly wrong | Refuted | Missing rows proposed |
|---|---|---|---|---|---|
| Ours | 113 (111 rows, 2 exceed claims) | 96 | 17 | 0 | 7 |
| n8n | 96 (94 rows, 2 exceed claims) | 83 | 13 | 0 | 7 |

- Every partly-wrong verdict is applied below. The cells show the corrected values, and the row's notes start with "Fixed in verify".
- The 14 missing-row proposals became 11 new rows, tagged "Added in verify". Three proposals overlapped: security audit, dedup store and breaking-changes report.
- Of the 152 inventory rows, 87 were checked on both sides, 24 on our side only, 7 on the n8n side only, and 34 on neither. The 34 are tagged "Unverified".
- **Checked on our side only:** execution-modes, file-format-ssh-utilities, n8n-packages, merge-modes, execution-context-flow-node, eval-http-mocks, ci-and-dev-saas, database-nodes, canvas-keyboard-shortcuts, n8n-api-node, publish-draft-model, queue-mode, code-node, respond-to-webhook, chat-trigger, set-and-item-ops, http-request, chat-models, node-credentials, tidy-up-auto-layout, workflow-history-restore, projects-sharing-rbac, static-data, save-conflict-checksum.
- **Checked on the n8n side only:** local-file-trigger, copy-paste-json, drag-mapping, execution-annotations, data-table, workflow-dependencies, environment-promotions.
- The n8n verifier re-ran REA, so its ids differ from the inventory ids for the same packages. The appendix lists both sets.

**Final counts (163 rows)**

| ours | we-exceed | have | partial | missing | n/a | out-of-scope |
|---|---|---|---|---|---|---|
| rows | 3 | 33 | 44 | 45 | 24 | 14 |

**Column meanings**
- **Fit:** how much the feature matters for a local coding runner with one owner.
- **Effort:** a relative estimate of our cost. S is small, M medium, L large, and XL a different product.
- **Out-of-scope:** ruled out by a written decision. "(inferred)" means the decision only implies it.

**Our known limits that are not matrix rows**
- The per-node compare route accepts `[a-z0-9-]+` (`App.tsx:24`), but node ids may contain uppercase letters and underscores (`graph.py:26`).
- 11 projects and 14 sessions imported before the isolation fix are still in Supabase (PLAN.md:799).
- If the DB connection drops between commit and reply, a batch's tokens can be added to the run total twice (`engine.py:222`).
- A quota run whose reset text did not parse can only continue with "now" (`engine.py:438`).
- A shell grandchild that leaves its process group holds the node open until it exits (`proc.py:280-281`).
- In container mode, a host token refresh during a node leaves that node on the old token (`proc.py:58-60`).

This report did not re-check anything itself. It merges the inventory and verifier outputs as given. Rows tagged Unverified rest on the inventory alone.

## Where we exceed n8n

1. **Usage-limit handling (Q1-Q3).** The runner detects the limit and parks the run off the lane. It holds new claims, continues in the same Claude session, and resumes automatically at the reset time. Detection is not yet checked against real `-p` output (PLAN.md:817-818).
2. **Extra-usage guard per node (Q4).** A node stops at once when it starts using paid overage and `allow_extra_usage` is false. The field is undocumented and unverified.
3. **Run token cap.** The cap counts fresh tokens and is checked before each batch (`engine.py:321-323`). A bounded grep found no per-run LLM token budget in n8n; the full tree was not searched.
4. **Git per run (G1, G2, H5, H6).** Each run gets a worktree and a branch. Each node gets a commit and a diff, and there is a run diff. You can compare two runs, or one node across runs, by git diff.
5. **A resumable Claude session per node (H7).** A copy button gives `claude --resume` into any node's session, and `resume_from` forks a session between nodes. S7 is unverified, and `resume_from` is not validated.
6. **Push/PR gate (A1).** A shell step that runs `git push` or `gh pr` must sit behind an approval node, and agents always have the push and PR tools disallowed. The gate is a regex, so a push hidden in a script or an alias is not caught.
7. **Subscription auth checks (A2).** Fixed in verify. At claim time the runner checks the login, the claude.ai auth method, the pinned CLI version and the owner email. `apiKeySource` is checked per agent node, from the stream's init event. The A3 upgrade smoke test is unverified.
8. **Container mode (C1).** It sandboxes agent nodes that run with bypass permissions. The credential mount is unverified.
9. **Parallel read-only agents in one run (P1).** n8n v1 runs one node at a time within one execution. Fixed in verify: only agents are made read-only. A shell marked read-only is only batched in parallel and can still write the worktree. The lock covers only the commit.
10. **Progress saved by default.** A step row is inserted before spawn under a unique (run, node, visit) key, and the walker state is saved after each batch. n8n saves per-node progress only when `saveExecutionProgress` is on, and it is off by default. Fixed in verify: neither tool resumes a crashed run. n8n rebuilds a crashed run's data from its logs for display only.
11. **Loop caps (S10, L1, L2).** Each node has `max_visits`, loops are validated, and there is a backstop on total node runs. n8n has no loop limit. Its guard only catches a stuck re-queue, and its run timeout is off by default.
12. **Graph validation on save and run.** It covers structure, loop rules, the push gate and template quoting. n8n's pre-run check covers only node parameters and unknown node types. Added from the verify pass.
13. **Durable schedules by default.** Schedules live in Postgres and fire through a compare-and-set, with holds while the user is active in Claude Code or during a quota window (T4). n8n's durable scheduler is a preview that is off by default, and its default in-memory cron drops missed slots.
14. **Library capabilities on the canvas (S1, U2).** Skills, commands, subagents and workflows drop onto the canvas as ready-made agent nodes. They run inside the agent node type; you cannot add new node types.
15. **Export to Claude Code's native `.claude/workflows/*.js` (O1).** The native run is unverified, and the export is reachable from the API and editor only, not the CLI.
16. **Shell-safe templating (D3).** Values are shlex-quoted, and the validator rejects a template placed inside quotes.

Dropped in verify: "workflows as plain YAML in git (W3)" is now **have**, not exceed. Only project-scope files live in a repo, and an editor save silently overwrites a change pulled from git.

## Top gaps worth closing

| # | Gap (row ids) | Why it matters | Fit | Effort |
|---|---|---|---|---|
| 1 | retry-failed-execution | A late failure throws away every earlier agent node, at about 44k startup tokens each. Q3 already resumes quota runs from the stopped step. Reuse that path after resetting the worktree to the failed step's pre_sha. | high | M |
| 2 | pin-data, later auto-pin-test-runs | Today the IF, loop, merge and template wiring can only be tested with real agent runs. Partial runs build on pins. | high | M |
| 3 | partial-execution + destination-node-run | Tuning one prompt reruns the whole chain against the 5-hour window. This is the biggest token saver. | high | L + M |
| 4 | error-workflow, external-hook-files, messaging-nodes | Failures, approval waits and quota stops are silent. One on-event shell hook closes most of this. | medium | S |
| 5 | send-and-wait-hitl | An approval only works while the owner watches the dashboard. Add approve to the CLI and MCP, and ping through the hook. | medium | S |
| 6 | execution-pruning | Worktrees, branches, gz logs and rows grow forever on a 500 MB free tier. n8n prunes by default. | high | S |
| 7 | disabled-node-passthrough | Skipping a node means deleting and rewiring it. A hand-written `disabled: true` is silently ignored and the node still runs. | high | S |
| 8 | node-rename-reference-rewrite + paired-item-errors | A rename or a typo turns a template into "" with no warning. | high | S |
| 9 | retry-on-fail | One flaky test or network step fails the run. Retries are safe for shell nodes marked idempotent. | high | S |
| 10 | on-error-modes | There is no error branch to send a failure to a fixer agent. `on_error: continue` covers agents only and is unverified. | high | S |
| 11 | suspend-between-nodes | Every `deploy_local.sh` restart fails the run in progress. | medium | M |
| 12 | if-node + switch-node | IF has no AND/OR, numeric or regex operators. A 3-way verdict needs chained IFs. | high | S |
| 13 | mcp-server-trigger | Claude Code can start runs over MCP, but it cannot list workflows, read step output, approve, continue or cancel. User-scope workflows fail with project_required. | high | S |
| 14 | form-trigger-and-form | A run takes one free-text input, so run_workflow has no input contract. | medium | S-M |
| 15 | ai-workflow-builder | Workflows are plain YAML checked by graph.py, so a "describe it, get a workflow" skill is cheap. n8n gates its builder behind a license and an API key. | high | S-M |
| 16 | save-conflict-checksum | An editor save silently overwrites git or hand edits made after load, and drops YAML comments. | medium | S |
| 17 | execution-timeout | A run has no wall-clock cap, and an approval waits forever. | medium | S |
| 18 | stop-and-error | A graph cannot fail a run on purpose. | medium | S |
| 19 | loop-over-items | There is no for-each over an agent's list output, such as one fixer per failing test or per file. | medium | M |
| 20 | execute-workflow-node | Shared sub-flows cannot be composed, and a child would have to run inline in the parent. Defer this. | medium | L |

**Cheap fixes the verify pass found (each S, each still needs owner approval)**
- Validate the graph when a schedule is enabled (`runs.py:99-115`).
- Keep polling the run page during quota (`Runs.tsx:9`).
- Validate `resume_from` against nodes that ran before (`engine.py:328`).
- Drop or rename "Read-only" on shell nodes, since it only changes batching (`Workflows.tsx:161`).
- Widen the compare route regex (`App.tsx:24`).
- Add `plan` to the editor's permission_mode picker (`Workflows.tsx:149`).

## Gap matrix

### Run loop and graph semantics

| id | n8n feature | ours | fit | effort | n8n evidence | our evidence | notes |
|---|---|---|---|---|---|---|---|
| execution-stack-loop | Single-process loop: pick a ready node, run it, record it, queue its children | have | high | S | ev_93b09fd4d297 workflow-execute.js processRunExecutionData | graph.py:165-178, 233-250; engine.py:287-318 | A token walker. State is saved with each batch's outcomes in one transaction (engine.py:210-223). |
| execution-order-v1 | v1 order: depth-first; children sorted top-most then left-most on a LIFO stack | partial | high | S | ev_93b09fd4d297 addNodeToBeExecuted | graph.py:181-185 | Fixed in verify: deterministic, but neither depth-first nor positional. All ready read-only nodes run together; otherwise the smallest id runs. Renaming ids is the only way to reorder writers. |
| execution-order-v0-legacy | Legacy v0 breadth-first order | n/a | low | S | ev_93b09fd4d297 isLegacyExecutionOrder | none | Unverified (n8n side seen in passing). Back-compat mode; we have no legacy graphs. |
| run-data-record | Per-node, per-run records (runData[node][runIndex]) | have | high | S | ev_93b09fd4d297 createTaskData, upsertTaskData | schema.sql:197-241; engine.py:356-361 | One wf_steps row per (run, node, visit): input, output, error, tokens, session, turns, pre/post sha, diff. |
| endless-loop-guard | A stuck-requeue guard only. Real loops are uncapped, and the run timeout is off by default | we-exceed | high | S | ev_b6e23fce9af1 workflow-execute.js L1184-1219; ev_6e1792bf5189 executions.config.js | graph.py:83-86, 217-230 | Fixed in verify (n8n side). Ours: max_visits per node (default 3) plus a backstop on total runs. |
| waiting-for-inputs | Multi-input nodes wait; on stack drain they run if any input has data; requiredInputs sets a minimum | have | high | S | ev_b6e23fce9af1 L1395-1470; ev_799da78a322d Merge v3 requiredInputs | graph.py:188-193, 233-250 | Fixed in verify (n8n side). Ours needs a data or skip token on every forward in-edge. There is no "every input must carry data" option (n8n's chooseBranch). A merge behind an IF waits until nothing else is ready. |
| empty-output-stops-branch | An empty output starts no children (v0 exception on input > 0) | have | high | S | ev_93b09fd4d297 nodeSuccessData length check | graph.py:204-211; engine.py:73-74 | An untaken IF edge is deferred, then becomes a skip token. Skipped nodes get step rows; n8n records nothing. |
| workflow-issues-precheck | Pre-run check: missing required parameters and unknown node types only | have | high | S | ev_93b09fd4d297 checkForWorkflowIssues | graph.py:98-162; library.py:149-166; runs.py:89; Workflows.tsx:305-308 | Runs on save and on submit; a 422 highlights the node. Ours also checks structure, loops, the push gate and quoting. |
| disabled-node-passthrough | Disable a node: it is skipped and passes input[0] through | missing | high | S | ev_93b09fd4d297 handleDisabledNode; ev_13621ea7b138 | schemas.py:116-117 | A hand-written `disabled: true` is kept on save and ignored. The node still runs. |
| if-node | IF v2: AND/OR over typed operators (gt/lt, regex, dates, arrays) | partial | high | S | ev_d298551c8b93 IfV2.node.js; ev_462cb5dc5ffc filter-parameter.js | graph.py:23, 278-292 | One condition; ops eq, ne, contains, truthy. A missing path is false, even for ne. |
| switch-node | Switch: N outputs by rules or expression, with fallback | missing | medium | S | ev_d298551c8b93 SwitchV3.node.js | graph.py:22, 135-136 | A 3-way verdict needs chained IFs. A switch can reuse the IF deferral logic. |
| merge-modes | Merge modes: append, combine, SQL, chooseBranch | partial | low | S | ev_d298551c8b93 Merge v3 versionDescription.js | graph.py:188-193; engine.py:306-307 | One mode: {inputs: {node_id: output}}. The item-joining modes mean nothing without items. |
| graph-cycles | Cycles allowed; each re-entry is a new runIndex | have | high | S | ev_93b09fd4d297 computeRunIndex, handle-cycles.js | graph.py:43-62, 76-80, 153-161 | Back-edges found by DFS; each re-entry is a new visit with its inbox cleared. No merge, approval or non-IF fan-out inside a loop. |
| loop-over-items | Loop Over Items: batches out on "loop", all results on "done" | missing | medium | M | ev_8eef1fb0629b SplitInBatchesV3.node.js | graph.py:43-62, 259-260; engine.py:297 | Loops cannot index a list by visit; lookups take literal digit indexes only. |

### Data, expressions and state

| id | n8n feature | ours | fit | effort | n8n evidence | our evidence | notes |
|---|---|---|---|---|---|---|---|
| items-model | Item lists as the unit of data | n/a | low | XL | ev_93b09fd4d297 taskData.data.main | graph.py:253-275; engine.py:297 | Unverified. One JSON output per visit. Running per item would multiply claude -p sessions. |
| paired-item-lineage | pairedItem lineage | n/a | low | L | ev_93b09fd4d297 addPairedItemLineage | none | Unverified. No items, so no lineage. |
| data-proxy-variables | $json, $input, $('Node'), $runIndex, $now, $env, $workflow, $execution | partial | medium | S | ev_f3dff27b10a9 workflow-data-proxy.js | graph.py:27-28, 253-275; engine.py:297, 348 | Roots: input, run.branch, <node_id>; latest visit only. No run id, visit, time, env or earlier visit. |
| expression-engine | Sandboxed ={{ }} expression engine | missing | low | L | ev_f3dff27b10a9 expression.js; ev_09053533ae15 | graph.py:27-28 | Unverified. A regex plus a dotted lookup, no functions. PRD:91 says shell and templating cover it. |
| paired-item-errors | Explicit errors for unresolved references | partial | medium | S | ev_f3dff27b10a9 createExpressionError | graph.py:139-141, 266-267 | Only the first path segment is checked. A missing value renders "" with no warning; {{run.id}} passes validation and renders "". |
| execution-context-flow-node | Per-run scratch context | partial | low | S | ev_f3dff27b10a9 node-helpers.js getContext | engine.py:297, 348 | ctx holds node outputs only; worktree files carry other state. |
| static-data | Workflow static data across runs | missing | low | S | ev_f3dff27b10a9 workflow.js getStaticData | engine.py:199, 297 | Each run starts a fresh worktree at HEAD. A root that reads the last good run's output is S. |
| dedup-store | Cross-run dedup (Remove Duplicates "seen before"); poll cursors committed after handling | missing | medium | S | deduplication-helper.js; poll-cursor-hooks.js (read directly) | none | Added in verify. The mechanism behind the polling and static-data gaps. |
| last-successful-execution | GET /workflows/:id/executions/last-successful | missing | low | S | workflows.controller.js (read directly) | runs.py:126-134 | Added in verify. A small building block for static-data. |
| binary-data | Binary data on items (filesystem, S3, DB) | n/a | low | S | ev_93b09fd4d297 convert-binary-data.js | engine.py:195-202, 278-284 | Unverified. Files live in the worktree and move through per-node commits. |
| payload-size-caps | Payload and output size limits (Execute Command keeps 10 MB per stream) | have | medium | S | payload limit (grep); ev_799da78a322d ExecuteCommand | proc.py:34-35; engine.py:47 | Added in verify. Ours: agent result 64 KB, shell tails 4 KB, diff 64 KB. The 4 KB tail limits what reaches templates. |

### Sub-workflows

| id | n8n feature | ours | fit | effort | n8n evidence | our evidence | notes |
|---|---|---|---|---|---|---|---|
| execute-workflow-node | Execute Sub-workflow: own run, typed inputs, wait or fire-and-forget; the child runs the published version | missing | medium | L | ev_8eef1fb0629b ExecuteWorkflow; ev_cb3f6423e9d5 executeWorkflow; ev_d298551c8b93 trigger | mcp.py:50-72; proc.py:140-144; engine.py:55-59 | Strict MCP blocks recursion. A queued child runs after its parent ends and deadlocks only if the parent waits on it. Not in the PRD out-of-scope list. |
| sub-workflow-deadline | A child cannot outlive its parent's deadline | missing | low | S | ev_cb3f6423e9d5 resolveSubworkflowDeadline | none | Unverified (n8n side seen in passing). Needs sub-workflows and a run timeout first. |
| caller-policy | Sub-workflow caller policy | n/a | low | S | ev_756681018aa5 base-workflow-public.dto.js | library.py:124-126; runs.py:51-70 | Unverified (n8n side seen in passing). Owner scoping is the whole access model. |
| workflow-dependencies | Workflow dependency view | missing | low | S | workflow-dependency.controller.js (no REA) | none | Matters only once sub-workflows exist. |

### Errors, retry and recovery

| id | n8n feature | ours | fit | effort | n8n evidence | our evidence | notes |
|---|---|---|---|---|---|---|---|
| retry-on-fail | Node retry: 2-5 tries (default 3), 0-5 s wait (default 1 s) | missing | high | S | ev_93b09fd4d297 getRetryParams | engine.py:363-372, 380; PLAN.md:592 | "Never retry" today. A retry can reset the worktree to pre_sha, but side effects outside the worktree would repeat. |
| on-error-modes | On Error: stop, continue, or route to an error output | partial | high | S | ev_93b09fd4d297 continuesOnError, handleNodeErrorOutput | engine.py:347-349; Workflows.tsx:149; PLAN.md:554 | on_error: continue covers agents with is_error only, and is unverified (PRD:125). Shells never return failed. Timeout, quota and crash still fail the run. |
| always-output-data | Always Output Data | n/a | low | S | ev_93b09fd4d297 ensureAlwaysOutputData | proc.py:180-184, 277-296 | Unverified. Every node emits one output object. |
| execute-once | Execute Once (first item only) | n/a | low | S | ev_93b09fd4d297 handleExecuteOnce | none | Unverified. No item lists. |
| stop-and-error | Stop and Error node | missing | medium | S | ev_8eef1fb0629b StopAndError.node.js | engine.py:252-253; proc.py:278 | A non-zero shell exit is data here, whereas n8n's Execute Command fails on it. Failing on purpose today needs a hack. |
| error-workflow | Error workflow or Error Trigger on failed non-manual runs | missing | medium | S | ev_cb3f6423e9d5 execute-error-workflow.js; ev_d298551c8b93; ev_c6c0149d9bbc | none | Nothing notifies on failure, wait or quota. One on-event shell hook covers most of it. |
| error-recording | Error stored on the node run and the execution; failed node re-stacked | have | high | S | ev_93b09fd4d297 handleNodeExecutionError | engine.py:356, 363-374; Runs.tsx:59, 110, 186 | Stored and shown. We do not re-stack the failed node. |
| retry-failed-execution | Retry a failed run from the failed node, with the original or current workflow | missing | high | M | ev_cb3f6423e9d5 / ev_c7f284d935d4 ExecutionService.retry; ev_e1f4e2f99b37 | engine.py:80-81, 287-318, 435-442 | Continue works for quota runs only (engine.py:440). Reuse the Q3 path. Conflicts with "a crash means failed" (PLAN.md:501). |
| crash-recovery | Crashed run marked crashed; data rebuilt from logs for display; error workflow runs. Auto-deactivate off by default | have | high | S | ev_21c4f9aad10b; ev_55265a2daf13 execution-recovery.service.js; ev_6e1792bf5189 | engine.py:62-67, 385-396, 445-466; app.py:79-85 | Fixed in verify (n8n side): n8n does not resume crashed runs either. Ours kills orphans and the unique step key blocks repeats. A crashed run is terminal. |
| suspend-between-nodes | Graceful shutdown: regular mode waits for runs; queue workers suspend at the next node | missing | medium | M | ev_93b09fd4d297 suspend; ev_cb3f6423e9d5 active-executions.js | engine.py:385-396; app.py:73-85 | Shutdown fails running runs. deploy_local.sh restarts the daemon. Re-queue at the batch boundary instead (the R2 path). |

### Waits, approvals and run lifecycle

| id | n8n feature | ours | fit | effort | n8n evidence | our evidence | notes |
|---|---|---|---|---|---|---|---|
| wait-node-modes | Wait: interval, date, webhook or form resume, optional limit; waits under 65 s sleep in process | partial | medium | S | ev_8eef1fb0629b Wait.node.js; ev_cb3f6423e9d5 wait-tracker.js; ev_21c4f9aad10b | engine.py:270-271, 409-442; runs.py:222-229 | Approvals wait with no limit; quota waits carry resets_at. No timed wait. A shell sleep holds the lane. |
| resume-semantics | A resumed node is not re-run; downstream gets the resume data | have | high | S | ev_93b09fd4d297 handleWaitingState | engine.py:287-318, 335-337, 409-432 | {approved, note} feeds downstream. A quota stop resumes the same session with --resume. |
| send-and-wait-hitl | Send-and-wait approvals in 9 nodes (Slack, email, Teams, Telegram...) | partial | medium | S | ev_34b6bc882eb0 nodes.json sendAndWait; hitl webhooks (grep) | Runs.tsx:113-124; runs.py:222-229 | Approval node with a diff banner, from the UI or API only. No CLI or MCP approve, no ping, no timeout. |
| execution-timeout | Whole-run timeout, off by default (-1), max 3600 s | partial | medium | S | ev_cb3f6423e9d5 workflow-runner.js; ev_93b09fd4d297; ev_09053533ae15 | proc.py:212-221; engine.py:272, 321-323 | Per-node timeout_s (1800 s) and a token cap. No run wall clock. |
| cancel-execution | Cancel with an abort signal; tasks marked cancelled | have | high | S | ev_93b09fd4d297 setupCancellation; ev_cb3f6423e9d5 | engine.py:385-406; runs.py:214-219; cli.py:567-571 | Tested with no orphans left. Race: a cancel between step inserts and spawns misses those processes (engine.py:339). |
| execution-statuses | new, running, waiting, success, error, canceled, crashed, unknown | have | high | S | ev_462cb5dc5ffc execution-status.js | schema.sql:206-207, 228 | Fixed in verify (n8n adds unknown; suspended = waiting). Ours adds quota and step skipped/timeout. A crash is plain failed. |
| lifecycle-hooks | Internal lifecycle hooks | missing | low | M | ev_93b09fd4d297 / ev_cb3f6423e9d5 execution-lifecycle-hooks.js | none | Unverified. external-hook-files covers the part users see. |
| external-hook-files | Operator hook files on workflow activate/update/delete and postExecute | missing | medium | S | external-hooks.js (read directly) | none | Added in verify. n8n's version of our proposed on_event shell hook. |
| on-execution-finish | Node cleanup functions | n/a | low | S | ev_93b09fd4d297 closeFunctions | proc.py:212-221 | Unverified. Killing the process group is the cleanup. |
| push-to-editor | Live progress over WebSocket or SSE | have (not at quota) | high | S | ev_cb3f6423e9d5 hookFunctionsPush; ev_c7f284d935d4 push | Runs.tsx:9-10, 42, 79; runs.py:165-188 | Fixed in verify: the 1.5 s polling stops at quota, so an open page misses the auto-resume. SSE is the named upgrade path (PLAN.md:505). |
| streaming-chunks | Stream partial output to an HTTP caller | n/a | low | M | ev_cb3f6423e9d5 sendChunk | Runs.tsx:218-271 | Unverified. No HTTP caller waits on a run (PRD:90). |
| execution-modes | Mode per run drives behaviour (pins, limits) | have | low | S | ev_cb3f6423e9d5 getQueue, resolvePinData | runs.py:73-96; schemas.py:359-365 | The trigger label is set by the caller and changes no behaviour. |

### Partial runs and testing

| id | n8n feature | ours | fit | effort | n8n evidence | our evidence | notes |
|---|---|---|---|---|---|---|---|
| destination-node-run | Run up to a node (inclusive or exclusive) | missing | high | M | ev_93b09fd4d297 runNodeFilter | engine.py:319-372; schemas.py:362-365 | The walker always runs to the end. Each agent node skipped saves about 44k startup tokens (PRD:138). |
| partial-execution | Run from a node reusing earlier outputs; dirty nodes re-run | missing | high | L | ev_93b09fd4d297 runPartialWorkflow2; ev_cb3f6423e9d5; ev_90bf85442d44 | engine.py:195-202, 287-318 | Every run starts at the trigger. Plan: fork run N's branch at post_sha and seed ctx from wf_steps. |
| pin-data | Pinned output, manual and evaluation modes only | missing | high | M | ev_93b09fd4d297 getPinnedOutput; ev_cb3f6423e9d5 resolvePinData | proc.py:39-41 | The only stub is the daemon-wide CTC_CLAUDE_BIN. Pins must never apply to schedules or MCP runs. |
| auto-pin-test-runs | MCP test_workflow auto-pins triggers, credentialed and HTTP nodes | missing | medium | M | ev_bbfef8cdd3dc test-workflow.tool.js | none | Added in verify. Maps to stubbing agent nodes automatically. Needs pin-data first. |
| debug-in-editor | Load a past run and re-run it (licensed: feat:debugInEditor) | missing | medium | S | ev_32a285020e5b useExecutionDebugging | runs.py:73-96; Runs.tsx:198-216 | Fixed in verify (n8n side). No "run again with this input". The claude --resume copy is a debug path n8n lacks. |
| eval-http-mocks | Eval mocks; Debug Helper and Simulate nodes | partial | low | S | ev_93b09fd4d297 eval-mock-helpers.js | proc.py:39-41; PLAN.md:817-818 | Fake claude scripts exist for tests only; they apply daemon-wide, not per node. |
| evaluations-test-runs | Evaluations: datasets, metrics incl. LLM judge, compare | partial | medium | L | ev_cb3f6423e9d5 test-runner.service.ee.js; ev_c7f284d935d4 | runs.py:137-154; Runs.tsx:157-175 | Manual A/B of runs or one node. No datasets or metrics; WH3 is open. |

### Concurrency, scaling and persistence

| id | n8n feature | ours | fit | effort | n8n evidence | our evidence | notes |
|---|---|---|---|---|---|---|---|
| concurrency-limits | Production cap: off by default, webhook and trigger runs only, FIFO when on | have | high | S | ev_55265a2daf13 concurrency-control.service.js; ev_6e1792bf5189 | engine.py:55-59, 177-190; schema.sql:219 | Fixed in verify (n8n side). Ours is always on: one running run per owner, for every trigger. A quota window parks new claims too. |
| queue-mode | Queue mode with Bull/Redis workers | out-of-scope | low | XL | ev_cb3f6423e9d5 scaling.service.js, job-processor.js | PRD:92; PLAN.md:503 | Worker scaling is ruled out; the jobs queue was rejected because its retries duplicate side effects. |
| multi-main-leader | Leader election so triggers fire once | have | low | S | multi-main-setup.ee.js (no REA) | schedule.py:31-32 | Added in verify. A different mechanism: compare-and-set on last_fired_at. |
| save-settings | Per-workflow save policy | n/a | low | S | ev_cb3f6423e9d5 to-save-settings.js | schema.sql:197-241; PLAN.md:502 | Unverified (n8n side seen in passing). Every step is saved. |
| save-progress | Save state after each node: opt-in, off by default | have | high | S | ev_21c4f9aad10b; ev_55265a2daf13 hookFunctionsSaveProgress; ev_6e1792bf5189 | engine.py:291-292, 329, 356-374 | Fixed in verify (n8n side). Ours is always on. A batch is saved when its slowest node ends. |
| execution-pruning | Pruning on by default: >336 h or >10,000 runs; keeps annotated and active runs | missing | high | S | ev_21c4f9aad10b pruning service; ev_a60f2e549001 | engine.py:195-202; schema.sql:224 | Nothing is ever removed. Supabase free tier is 500 MB. Each deletion needs owner approval. |
| resumable-run-state | Serializable run state; retry, resume and partial runs share one path | have | high | S | ev_93b09fd4d297 createRunExecutionData; ev_cb3f6423e9d5 | engine.py:210-223, 287-318, 413-425 | wf_runs.state holds the walker. Retry and partial runs could reuse it. |

### Engine v2 (n8n's next engine, opt-in module)

| id | n8n feature | ours | fit | effort | n8n evidence | our evidence | notes |
|---|---|---|---|---|---|---|---|
| engine-v2-step-model | Durable step rows with statuses | have | high | S | ev_dc5677b70cd4 step-ready-handler.js; ev_b413887b45c4 | schema.sql:237; engine.py:62-67, 329-334 | Our model already: rows keyed node@visit, inserted before spawn. |
| engine-v2-successor-decision | Queue if any input has data, skip if none, wait while undecided | have | high | S | ev_dc5677b70cd4 settlement.js | graph.py:188-193, 233-250 | Same rule. |
| engine-v2-fail-fast | A failed step fails the run and cancels pending steps | have | high | S | ev_dc5677b70cd4 step-settled-handler.js | engine.py:291-292, 340-342, 363-372 | Fails after the batch; siblings run to their end. Steps that never started get no row. |
| engine-v2-loops | Explicit loops (SCC + batch node) with validation | have | high | S | ev_dc5677b70cd4 graph/loops.js; ev_b413887b45c4 | graph.py:43-62, 153-161; engine.py:326 | No batch-slicing node (see loop-over-items). |
| engine-v2-waits | Declarative waits with a deadline and outputs at the deadline; sweeper | partial | medium | S | ev_dc5677b70cd4 wait-sweeper.js | engine.py:79-81, 409-432, 470 | Quota waits have a deadline. Approvals have no deadline and no default output. |
| engine-v2-status | v2 rollout and its unsupported-feature list | n/a | low | S | ev_cb3f6423e9d5 engine-v2-dispatcher.service.js | none | Unverified (n8n side seen in passing). n8n's migration state, not a feature. |

### Triggers and scheduling

| id | n8n feature | ours | fit | effort | n8n evidence | our evidence | notes |
|---|---|---|---|---|---|---|---|
| manual-trigger | Manual Trigger / run from the editor | have | high | S | ev_34b6bc882eb0 ManualTrigger.node.js | Workflows.tsx:304, 326-333, 364-366 | A Run button with an input box; disabled until the canvas is saved. |
| manual-trigger-execution | Triggers and pollers run once for sample data in manual runs | n/a | low | S | ev_93b09fd4d297 executeTriggerNode | engine.py:266-267 | Unverified. Our trigger is passive. |
| schedule-trigger | Schedule: several rules, intervals or cron, workflow timezone | partial | high | S | ev_34b6bc882eb0 ScheduleTrigger; ev_93b09fd4d297 | schedule.py:35-110; runs.py:99-123 | One 5-field cron per project workflow, in local time. No user or plugin schedules; the input cannot be edited in the UI. |
| schedule-misfire-policy | Skip, coalesce or grace: Schedule 1.4+ on the durable scheduler only; the default path drops missed slots | partial | medium | S | ev_a0d8c7289ea9 misfire.js; ev_799da78a322d; ev_6e1792bf5189 | schedule.py:23, 35-110 | Fixed in verify (n8n side). Ours is fixed: held slots fire once, and slots >2 min before start are skipped. Holds during idle, quota or an active run. |
| durable-scheduler | DB-backed scheduler: a preview, off by default; default is in-memory cron on the leader | have | high | S | ev_a0d8c7289ea9; ev_c6c0149d9bbc registrar; ev_6e1792bf5189 | schedule.py:26-32, 35-110 | Fixed in verify (both sides). Ours is durable by default. The compare-and-set stops a double fire; only a slot from before a schedule save can leak. |
| workflow-activation | Publishing activates triggers; refuses a workflow with no trigger | partial | medium | S | ev_c6c0149d9bbc active-workflow-manager.js | runs.py:99-115; schedule.py:104-107 | Fixed in verify: enabling a schedule never validates the graph. A broken file fails at fire time, with the slot spent. |
| webhook-trigger | Webhook trigger with test and live URLs and auth | out-of-scope | medium | M | ev_34b6bc882eb0 Webhook.node.js; ev_c6c0149d9bbc | PRD:90; runs.py:73-96; app.py:167-169 | The localhost POST trigger is open to every local user on the TCP port. |
| respond-to-webhook | Respond to Webhook mid-workflow | out-of-scope | low | M | ev_34b6bc882eb0 nodes.json | PRD:90; runs.py:73 | T3 returns 202 {run_id}. |
| form-trigger-and-form | Form trigger; typed workflow inputs | partial | medium | M | ev_34b6bc882eb0 formTrigger; ev_d298551c8b93 inputSource | Workflows.tsx:326-333; engine.py:297 | One free-text {{input}}. A typed inputs: schema would also give run_workflow a contract. |
| chat-trigger | Chat Trigger, chat hub | out-of-scope | low | L | ev_1cc7eae0925d ChatTrigger; ev_c7f284d935d4 | PRD:93; mcp.py:50-72 | Claude Code is the chat. |
| n8n-trigger | n8n Trigger (instance start, workflow updated) | missing | low | S | ev_34b6bc882eb0 N8nTrigger.node.js | none | Unverified. Little use. |
| polling-triggers | 18 polling triggers; dedup by cursors | partial | medium | M | ev_34b6bc882eb0 nodes.json; ev_13621ea7b138 | schedule.py:78-110; graph.py:278-292 | Cron, a gh poll and an IF imitate polling, but nothing remembers what was already seen. |
| push-event-triggers | AMQP, Kafka, MQTT, Redis, Postgres notify, IMAP triggers | n/a | low | L | ev_13621ea7b138 triggers-and-pollers.js | none | Unverified. A local coding runner has no message-queue use case. |
| local-file-trigger | Local File Trigger (excluded by default) | missing | medium | M | ev_34b6bc882eb0 LocalFileTrigger; ev_3f1819c61cda | hooks.py:125-127 | A better fit for us: a Claude Code hook or git post-commit trigger. |
| saas-dev-triggers | GitHub (43 events), GitLab, Jira, Linear, Bitbucket triggers | out-of-scope | medium | M | ev_34b6bc882eb0 nodes.json | PRD:90, 182 | Cron plus a gh poll stands in. PRD:182 points to claude-code-action. |

### Nodes and integrations

| id | n8n feature | ours | fit | effort | n8n evidence | our evidence | notes |
|---|---|---|---|---|---|---|---|
| catalog-size | ~570 node types, ~450 credential types | n/a | low | XL | ev_34b6bc882eb0; ev_1cc7eae0925d | proc.py:132-157 | Unverified. Six node types; Bash CLIs or MCP reach other services. |
| execute-command | Execute Command: a non-zero exit fails the node; 10 MB per stream | have | high | S | ev_799da78a322d ExecuteCommand.node.js | proc.py:34, 212-221, 277-296; graph.py:270-275 | Its own process group, a timeout kill chain, shlex templates. The exit code is data; we keep 4 KB per stream. |
| git-node | Git node (clone, commit, push, tag; hardened config) | we-exceed | high | S | ev_34b6bc882eb0 Git.node.js | engine.py:114-133, 195-202, 278-284 | A worktree per run, a commit per node. Hardening covers the runner's own git calls only. |
| http-request | HTTP Request | out-of-scope | low | M | ev_34b6bc882eb0 nodes.json | PRD:91 | curl in a shell node. |
| code-node | Code node (JS/Python) | out-of-scope | low | L | ev_8eef1fb0629b Code.node.js; ev_21c4f9aad10b | PRD:91; proc.py:277-296 | A shell node runs python or node inline. |
| set-and-item-ops | Set, Filter, Aggregate, Split Out, Sort, Limit, Remove Duplicates | out-of-scope (Set, Filter) | low | M | ev_34b6bc882eb0 nodes.json | PRD:91 | Fixed in verify: PRD:91 names only Set and Filter; the rest are out by extension. |
| file-format-ssh-utilities | Files, Convert, Compression, Date/Crypto/XML, SSH | partial | low | S | ev_34b6bc882eb0 ReadWriteFile, Ssh | proc.py:34, 205-209, 277-296 | Fixed in verify: no dedicated nodes. Only the last 4 KB of shell output flows downstream. |
| data-table | Built-in data tables | missing | low | M | data-table.controller.js (no REA) | none | No need has come up. |
| saas-dev-github-trackers | GitHub, GitLab, Linear, Jira nodes | partial | medium | M | ev_34b6bc882eb0 nodes.json | proc.py:27; graph.py:146-152; engine.py:354-355 | gh with push and PR gated. PR capture is untested with a real PR (WH2). Linear and Jira via MCP, untested (S5). |
| ci-and-dev-saas | CI, cloud and monitoring nodes | partial | low | M | ev_34b6bc882eb0 nodes.json | proc.py:140-144, 277-296 | Shell CLIs or MCP. |
| messaging-nodes | Slack, Discord, Telegram, Mattermost, Email, IMAP | missing | medium | S | ev_34b6bc882eb0 nodes.json | none | No notify step. Main use: tell the owner a run is waiting or has failed. |
| database-nodes | Postgres, Redis, MySQL, MongoDB nodes and DB triggers | partial | low | S | ev_34b6bc882eb0 nodes.json | proc.py:277-296; graph.py:22 | psql or redis-cli in a shell; no DB triggers. |
| other-saas-long-tail | ~250 business SaaS nodes | n/a | low | XL | ev_34b6bc882eb0 codex.categories | none | Unverified. |
| node-include-exclude | Node allow/deny list (Execute Command excluded by default) | partial | medium | S | ev_3f1819c61cda nodes.config.js | graph.py:24, 123-124, 146-152; proc.py:141-147 | Safety is set per node instead. No global list, which suits one user. |
| node-credentials | Credentials store, external secrets | out-of-scope | low | L | ev_90bf85442d44 credentials.controller.js | PRD:89; proc.py:44-49 | Claude login, gh auth, env. |
| community-nodes | npm community node packages (on by default) | partial | high | S | ev_90bf85442d44; ev_bbfef8cdd3dc | graph.py:22, 119-120; proc.py:126-129 | Fixed in verify: capabilities run inside the agent type; you cannot add a type. There are six built-in types, not five. |
| n8n-api-node | n8n node: manage workflows and runs from inside a workflow | partial | low | S | N8n.node.js (no REA) | cli.py:531-552, 543 | A shell can call ctc. `ctc run --wait` inside a run deadlocks until the node's timeout_s. |
| type-versioning | Node typeVersion keeps old behaviour | partial | medium | S | ev_da29ba796dd2 versioned-node-type.js | Workflows.tsx:86-91; config/server.yaml:20 | The CLI version is pinned. The YAML carries no format version. |
| breaking-changes-report | Upgrade breaking-changes report with per-workflow migrate | partial | medium | M | ev_bbfef8cdd3dc breaking-changes.controller.js | cli.py:588-599 | Added in verify. Closest: the `ctc runner upgrade` smoke test (unverified). No file migration. |

### AI and MCP

| id | n8n feature | ours | fit | effort | n8n evidence | our evidence | notes |
|---|---|---|---|---|---|---|---|
| ai-agent | AI Agent: chat model, memory, tools, parser, fallback model | we-exceed | high | S | ev_1cc7eae0925d AgentV3, ToolsAgent/V3 | proc.py:132-157, 224-274 | Each node is a full Claude Code session. Claude only (PRD:95); no fallback model. |
| agent-as-tool | AI Agent Tool (sub-agents) | have | medium | S | ev_1cc7eae0925d AgentToolV3.node.js | proc.py:148-152; Workflows.tsx:147 | The agent field becomes --agent <name>. |
| chat-models | 20 chat-model vendors, fallback model | out-of-scope | low | XL | ev_1cc7eae0925d lmChat* | PRD:88, 95 | Other vendors are out under PRD:88's API-key rule. |
| memory-nodes | Session memory (buffer, Postgres, Redis, Mongo, Zep...) | partial | medium | S | ev_1cc7eae0925d MemoryBufferWindow | engine.py:328; proc.py:155-156 | resume_from forks a session. It is not validated: a node that has not run yet silently gives a fresh session. |
| agent-tools | Code Tool, Call Workflow Tool, HTTP Tool, $fromAI | have | high | S | ev_1cc7eae0925d ToolCode, ToolWorkflowV2 | proc.py:140-147 | No call-workflow tool: a child stays queued until its parent ends. |
| mcp-client | MCP Client Tool and node | partial | medium | S | ev_1cc7eae0925d McpClientTool | proc.py:140-144; Workflows.tsx:153 | Per-node mcp_config, untested with a real server (S5). |
| llm-chains-rag-guardrails | Vector stores, chains, AI Transform, Guardrails | n/a | low | XL | ev_1cc7eae0925d nodes.json | proc.py:132-157 | Unverified. Retrieval is the router's job. |
| output-parsers | Structured and auto-fixing output parsers | have | high | S | ev_1cc7eae0925d OutputParserStructured | proc.py:153-154, 181 | json_schema gives structured_output. No auto-fix. |
| engine-requests-subnodes | Agent tool calls run as real node executions | n/a | low | XL | ev_93b09fd4d297 requests-response.js | proc.py:224-274 | Unverified (n8n side seen in passing). Claude Code runs its own tool loop. |
| mcp-server-trigger | Workflows as MCP tools; instance MCP server (search, execute, test, validate, history...); per-workflow opt-in | partial | high | S | ev_1cc7eae0925d McpTrigger; ev_c7f284d935d4; ev_bbfef8cdd3dc | mcp.py:29-38, 50-72; runs.py:94-95 | Only run_workflow and workflow_status. No project argument. |
| mcp-apps-preview | MCP Apps inline preview | missing | low | M | @n8n/mcp-apps (no REA) | none | Unverified. |
| ai-workflow-builder | AI builder (licensed, needs an API key); MCP create/validate workflow code | missing | high | S | ev_bbfef8cdd3dc ai.controller.js | library.py:78; graph.py:98-162 | Fixed in verify (n8n side). A YAML-writing skill is S-M. |
| ai-assistant | AI assistant to debug errors | partial | medium | S | ev_90bf85442d44 ai.controller.js | Runs.tsx:198-216 | A copy button for `claude --resume` into the failed node's session. |
| instance-ai | Instance AI: chat to plan, build and run | partial | medium | M | ev_c7f284d935d4 instance-ai.controller.js | mcp.py:50-72 | Same missing tools as mcp-server-trigger. |
| agents-product | Standalone agents builder | n/a | low | M | agent-publish.controller.js (listed only) | Workflows.tsx:247-260 | Unverified. Subagents and skills are the agents. |

### Editor and canvas

| id | n8n feature | ours | fit | effort | n8n evidence | our evidence | notes |
|---|---|---|---|---|---|---|---|
| canvas-vueflow-editing | Canvas with a context menu (duplicate, rename, pin, group, extract) | partial | high | M | ev_e1f4e2f99b37 app-CNX_HmmJ.js | Workflows.tsx:30-84, 262-264, 398-408 | Drag, connect, delete; dashed loop edges. No context menu or duplicate. |
| canvas-keyboard-shortcuts | Shortcuts: run, save, copy, pin, tidy, zoom | partial | low | S | ev_e1f4e2f99b37 keymap | Workflows.tsx:195, 365, 402 | Fixed in verify: Backspace/Delete, plus Enter in the run and cron fields. No ctrl+s. |
| undo-redo | Undo/redo (100 commands) | missing | medium | M | ev_e1f4e2f99b37 history store | Workflows.tsx:402 | A deleted node comes back only by reloading without saving. |
| copy-paste-json | Copy/paste nodes; import from URL or file | missing | medium | S | ev_32a285020e5b paste handler; ev_bbfef8cdd3dc | Workflows.tsx:30-84 | YAML can be copied by hand. |
| tidy-up-auto-layout | Tidy up (dagre) | out-of-scope | low | S | ev_e1f4e2f99b37 graphlib | PLAN.md:513 | No auto-layout. |
| zoom-fit | Zoom, fit, reset | have | medium | S | ev_e1f4e2f99b37 fitView | Workflows.tsx:401, 404; Runs.tsx:140, 143 | Evidence lines corrected in verify. |
| node-groups | Groups; extract a selection to a sub-workflow | missing | low | M | ev_e1f4e2f99b37 canvas.nodeGroup.* | none | Unverified (n8n side seen in passing). Needs sub-workflows. |
| node-creator-panel | Node creator / search panel | have | high | S | ev_32a285020e5b NodeCreator.js | Workflows.tsx:243-260, 381-397 | Buttons for the five addable types, plus a searchable capability palette. |
| command-bar | Command bar (Cmd-K) | missing | low | M | ev_e1f4e2f99b37 commandBar.* | none | Unverified (n8n side seen in passing). |
| canvas-documentation | Sticky notes, node notes on the canvas, No-Op | missing | medium | S | ev_e1f4e2f99b37 addSticky, notes | library.py:247-275 | A save re-dumps the YAML, so comments are lost. A notes: key survives but is never shown. |
| node-rename-reference-rewrite | Renaming a node rewrites the expressions that use it | missing | high | S | workflow.js renameNode L262 (read directly) | Workflows.tsx:141 | Added in verify. A rename silently breaks {{node.path}} templates. |
| ndv-input-output-panels | NDV: table, JSON, schema, binary views | partial | high | M | ev_32a285020e5b NodeDetailsView.js | Runs.tsx:177-271 | Output, log, diff and meta tabs on the run page. The editor shows no last-run data. |
| drag-mapping | Drag-to-map fields; expression autocomplete | missing | medium | M | ev_e1f4e2f99b37 dataMapping.* | Workflows.tsx:105-176 | Templates are typed blind. |

### Executions view and observability

| id | n8n feature | ours | fit | effort | n8n evidence | our evidence | notes |
|---|---|---|---|---|---|---|---|
| logs-panel | Logs panel: a tree of steps with status, duration and tokens | partial | high | S | ev_32a285020e5b LogsOverviewRow.js | Runs.tsx:136-150, 198-206; cli.py:545-549 | Fixed in verify: no step list. Click nodes one at a time; no duration. Only `ctc run --wait` prints a table. |
| execution-list | Run list: auto refresh, load more, bulk delete, stop | have | high | S | ev_90bf85442d44; ev_32a285020e5b | Runs.tsx:41-75; runs.py:126-134 | Last 50 runs. No delete, bulk stop or load more. |
| execution-filters | Filters (metadata and tag filters licensed) | partial | medium | S | ev_55265a2daf13 executions.controller.js | runs.py:126-134; Runs.tsx:42 | Fixed in verify (n8n side). The API filters; the UI sends none. |
| execution-annotations | Tags and good/bad votes (exempt from pruning) | missing | medium | S | ev_c7f284d935d4 annotate; ev_90bf85442d44 | none | Labels would feed the WH3 metrics. |
| execution-preview-canvas | Past run on a read-only canvas with retry and debug | have | high | S | ev_32a285020e5b WorkflowExecutionsPreview.js | Runs.tsx:104, 113-141 | Actions: cancel, approve, continue. No retry. |
| execution-redaction | Redact run data with audited reveal | n/a | low | S | ev_e1f4e2f99b37 ndv.redacted.* | runs.py:51-70 | Unverified (n8n side seen in passing). Only matters if teammates share Supabase. |
| execution-data-node | Execution Data node (custom metadata) | missing | low | S | nodes.json executionData (no REA) | runs.py:126-134 | Unverified. |
| insights-dashboard | Insights (summary free; per-workflow and over-time views licensed) | partial | medium | M | ev_bbfef8cdd3dc insights.controller.js | Runs.tsx:65, 203 | Fixed in verify (n8n side). No aggregates. |
| node-telemetry-tags | OpenTelemetry spans | missing | low | M | ev_93b09fd4d297 buildCustomTelemetryTracing | schema.sql:197-241 | Unverified. |
| log-streaming | Log streaming | missing | low | M | ev_90bf85442d44 log-streaming.controller.js | none | Unverified. |
| prometheus-metrics | Prometheus /metrics | missing | low | S | dist/metrics/prometheus (no REA) | none | Added in verify. |

### Workflow management, settings, API and organization

| id | n8n feature | ours | fit | effort | n8n evidence | our evidence | notes |
|---|---|---|---|---|---|---|---|
| publish-draft-model | Draft vs published version | out-of-scope (inferred) | low | M | ev_90bf85442d44 /activate; ev_cb3f6423e9d5 | engine.py:158-167; PRD:92 | Fixed in verify: PRD:92 does not name draft/publish. Schedules fire whatever the file holds now. |
| workflow-settings-schema | Run settings: timeout, error workflow, timezone, save policy, MCP opt-in | partial | medium | S | ev_756681018aa5 dto; ev_c7f284d935d4 | schemas.py:141-145; Workflows.tsx:149, 208-221 | No timeout, error workflow or timezone. The defaults block has no editor; plan mode is missing from the editor. |
| save-conflict-checksum | Save conflict detection (expected checksum) | missing | medium | S | workflow.service.js (read directly) | library.py:247-275 | A git pull or hand edit after load is overwritten. |
| workflow-history-restore | Version history: restore, diff | out-of-scope | low | M | ev_90bf85442d44; ev_32a285020e5b | PRD:92; PLAN.md:506 | User-scope files have no history. |
| import-export-json-ui | Export/import, import from URL, duplicate | partial | medium | S | ev_bbfef8cdd3dc workflows.controller.js | export.py; runs.py:242-269 | No duplicate or save-as. |
| cli-export-import-execute | CLI: execute, batch, export, import, publish, audit | partial | high | S | ev_c7f284d935d4 commands/* | cli.py:220-230, 531-581 | Fixed in verify: run and list exist. No import, no CLI for the .js export, no approve. |
| n8n-packages | Package export/import (.n8np) | partial | low | S | openapi.yml (read directly) | scanner.py:22, 240-248; library.py:138 | Fixed in verify: we only read plugin workflows (read-only). |
| templates | Template gallery | missing | low | M | ev_e1f4e2f99b37 templates.* | none | Unverified. |
| tags | Workflow tags | missing | low | S | ev_90bf85442d44 tags.controller.js | none | Unverified. |
| folders | Folders | n/a | low | S | ev_90bf85442d44 folder.controller.js | library.py:78 | Unverified. Workflows are files under each scope's .claude/ctc-workflows. |
| projects-sharing-rbac | Projects, sharing, RBAC | out-of-scope | low | XL | ev_90bf85442d44 project.controller.js | PRD:92; runs.py:51-70 | Rows are scoped by owner. |
| variables | $vars (enterprise: feat:variables) | partial | medium | S | ev_90bf85442d44 variables.controller.ee.js | engine.py:274-277, 298; proc.py:44-49 | Fixed in verify (both sides): shells and agents both get child_env(). Templates have no vars root. |
| source-control-git | Git push/pull (enterprise) | have | high | S | ev_bbfef8cdd3dc source-control.ee | library.py:78, 131-136, 253-272 | Fixed in verify: have, not exceed. No pull or conflict handling. |
| environment-promotions | Promotions, workflow review | n/a | low | M | ev_e1f4e2f99b37 promotions.* | none | Git PR review covers this. |
| public-rest-api | Public API with keys and Swagger (on by default) | partial | medium | S | ev_bbfef8cdd3dc api-keys.controller.js | runs.py:73-96; schema.sql:187-194; app.py:89, 125-147 | Fixed in verify: hashed API keys exist in shared mode; /docs is on (not checked live). |
| collaboration-presence | Presence and a write lock | n/a | low | M | ev_c7f284d935d4 collaboration.service.js | none | Unverified. |
| user-mgmt-sso | Users, SSO, LDAP, MFA | n/a | low | XL | sso, ldap modules (dirs) | schema.sql:187-194 | Added in verify. Owner = the claude auth email. |
| security-audit | `n8n audit` risk report | missing | low | S | dist/commands/audit.js (read directly) | graph.py:146-152 | Added in verify. Could flag bypass nodes and secrets in YAML. |
| canvas-only-mode | Canvas-only UI mode | n/a | low | S | canvas-only.config.js (no REA) | none | Unverified. |

## Decisions for the owner

1. **Retry vs "never re-run a side effect" (PLAN.md:501, 592).** Does the rule forbid a hand-started retry or run-from-node that first resets the worktree to the step's pre_sha? **Recommended:** allow manual retry and run-from-node. Allow automatic retry-on-fail only for shell nodes marked idempotent, never for agents.
2. **Graceful shutdown.** Today a planned stop counts as a crash. **Recommended:** on a planned stop, stop claiming new batches, let the current batch finish within a 5 min grace period, then re-queue the run with its walker state.
3. **Sub-workflows (not in the PRD out-of-scope list, PRD:87-95).** Should we add a node that runs the child inline? **Recommended:** defer until retry and pinned outputs land.
4. **External webhooks (reopens PRD:90).** **Recommended:** keep them out. Add a Claude Code hook or a git post-commit trigger instead.
5. **Code, HTTP, Set and Filter (PRD:91), and the item operations PRD:91 does not name.** **Recommended:** keep them all out, and write the extension into the PRD. Add template roots (run.id, run.visit, now, vars) and a vars: block.
6. **Credentials store (reopens PRD:89).** Notify hooks and MCP servers need tokens. **Recommended:** env only, referenced by name in YAML.
7. **Notification channel.** **Recommended:** one configurable shell command per event (failed, waiting, quota, done), with the run id, status and URL passed in env.
8. **Draft vs published (PRD:92 rules it out only by inference).** **Recommended:** scheduled runs use the committed HEAD version of project-scope files. Validate the graph when a schedule is enabled. Accept that user-scope files have no history for now.
9. **Team run history and sharing UI (PRD:92, PLAN.md:515).** **Recommended:** git only, until WH4 passes.
10. **Chat trigger and other model vendors (reopens PRD:93, PRD:88, PRD:95).** **Recommended:** keep both out. Claude Code plus MCP run_workflow is the chat.
11. **Data model.** One JSON output per node plus a for-each node, or n8n's item lists? **Recommended:** a for-each node.
12. **Pruning retention.** **Recommended:** keep 30 days, and keep runs with a PR URL or a waiting status. Remove worktrees, ctc/* branches, logs and rows together, after a dry run. Each deletion needs owner approval unless you add a standing approval.
13. **Pinned output scope.** **Recommended:** only editor and CLI runs started with --pinned. Never schedules or MCP. Auto-pinning comes later.
14. **Sibling order and renames.** Order goes by node id, and a rename breaks templates. **Recommended:** keep the id rule and rewrite references on rename.
15. **Read-only shells.** The flag only changes batching; it does not sandbox. **Recommended:** remove it from shell nodes until a sandbox exists.
16. **Editor parity with no decisions reopened.** SSE stays the upgrade path (PLAN.md:505), and auto-layout stays out (PLAN.md:513). **Recommended:** undo/redo, copy/paste, node notes, save-conflict detection, rename rewrite, and a step list on the run page.

## Appendix: REA evidence ids

Inventory pass:

| short | full id | covers |
|---|---|---|
| ev_93b09fd4d297 | ev_93b09fd4d297b8465095b35a2de95b1031364e12b982216f521b87ce3bd0b743 | n8n-core execution engine (workflow-execute.js, base-execute-context, requests-response, partial-execution utils, scheduled-task-manager, lifecycle hooks) |
| ev_d298551c8b93 | ev_d298551c8b935afa9ac6a22e7eabd4801b623743f24b6cc5525c5045f616c6ed | n8n-nodes-base: Merge v3, If v2, Switch v3, Execute Workflow Trigger, Error Trigger |
| ev_13621ea7b138 | ev_13621ea7b1386ed4281404ae1348a0819666b96776bda31d6e4e81ccbfb118e6 | n8n-core: disabled checks, trigger and poller activation, node error handling |
| ev_f3dff27b10a9 | ev_f3dff27b10a95727394e01393fd3ce5d370bf1b1a24e0949f4acca4d4d24e72b | n8n-workflow: workflow-data-proxy, expression, node-helpers, workflow.js |
| ev_09053533ae15 | ev_09053533ae1550adac210617a081b6c7f8b07988e6f469094cf8c27ca9448296 | @n8n/config: expression-engine and executions config |
| ev_8eef1fb0629b | ev_8eef1fb0629bde5236e988766b78be253a09aef6a2aa72994dbcf2ea10558fe9 | n8n-nodes-base: SplitInBatches, Execute Workflow, Stop and Error, Wait, Code |
| ev_cb3f6423e9d5 | ev_cb3f6423e9d58d08b94f3c88240a75d7c418b8e9ea515481cedb82306dd8dd09 | n8n CLI execution services (runner, additional data, execution service, wait tracker, concurrency, scaling, lifecycle, test runner, engine-v2 dispatcher) |
| ev_756681018aa5 | ev_756681018aa545fba0cd6a03837625bf42b2705cb53bcc1dff630f352eeceaf5 | @n8n/api-types base-workflow-public.dto.js |
| ev_c6c0149d9bbc | ev_c6c0149d9bbc1014bc2fb57446e24c1897686d7c0a698b1581ad47ae9f29c662 | n8n CLI activation and webhooks (active-workflow-manager, workflow-execution.service, schedule registrar) |
| ev_c7f284d935d4 | ev_c7f284d935d46c900512f2ff2b8669e1b7804e078118f5908ab0ba372c571cad | n8n CLI services and modules (execution service, push, test runs, MCP, chat hub, commands, source control, collaboration, insights, instance AI) |
| ev_21c4f9aad10b | ev_21c4f9aad10ba756793c1a9b64e74c0dd8172f2324dff81c6e0ec45cce2f4841 | n8n CLI: waiting webhooks, recovery, save progress, pruning, task requester |
| ev_90bf85442d44 | ev_90bf85442d44d1b8ea9633c055706616262b1c1dee3c46f5ef501427e3a8639c | n8n CLI controllers (workflows, executions, credentials, history, tags, folders, projects, variables, source control, community packages, insights, AI, log streaming) |
| ev_e1f4e2f99b37 | ev_e1f4e2f99b3762a96b2b0ac047f6c77a2f87c871d771e22d2fa50a47c563b67a | editor-ui main bundle app-CNX_HmmJ.js |
| ev_32a285020e5b | ev_32a285020e5b1cd0c966108cc47b9e7732321a6f4f7f31c758c84aaf9ca8aa19 | editor-ui chunks (NodeView, NodeCreator, NDV, debugging, logs, executions, history) |
| ev_a60f2e549001 | ev_a60f2e5490011e7ec680fe45eff66704b0aff346a36ae3ab3a208f1d44b48e7a | @n8n/db execution.repository.js |
| ev_1cc7eae0925d | ev_1cc7eae0925dc57779b6e91af1f03b2cbcf0e4beb7e00b3a693426f370739d48 | @n8n/n8n-nodes-langchain |
| ev_dc5677b70cd4 | ev_dc5677b70cd44c9d7ad6c647770e41220b4aea4d0c6a0c83633ba9d4a02e830c | @n8n/engine (engine v2) handlers, settlement, loops, wait sweeper |
| ev_b413887b45c4 | ev_b413887b45c41072ac8541c3c8b41d0e339276272e2876acae346527d0fc5695 | @n8n/engine runtime, batch-step.js |
| ev_34b6bc882eb0 | ev_34b6bc882eb0b23748ddbde490fdae278a438339fbff35e290c0d7e9c00c1e7c | n8n-nodes-base package (nodes.json and node files) |
| ev_a0d8c7289ea9 | ev_a0d8c7289ea90bcd2c89e262aef4d61bbe1db1278e6683100bd07786e1a942d9 | @n8n/scheduler |
| ev_3f1819c61cda | ev_3f1819c61cda0a3c946e0a1bdf731b2bfeba6aa9a7d555d01cb681092f6c25fb | @n8n/config nodes.config.js |
| ev_da29ba796dd2 | ev_da29ba796dd208a589f781dfd39a970329c1779171354af0d3e1262c395d0c73 | n8n-workflow versioned-node-type.js |

Verify pass (n8n side, with REA parent ids):

| short | full id | parent | covers |
|---|---|---|---|
| ev_b6e23fce9af1 | ev_b6e23fce9af14f7b1437379daf3bd82e76159045514f77fb56b06ccf5c293a53 | ev_2e532436ea14946040e15292a57672d80ddbf01994c6fda37b7c40d4f319b4b7 | n8n-core execution engine |
| ev_6e1792bf5189 | ev_6e1792bf518983f665d26465670d7ac63aba70a3296c7ab7afe78becbc250f58 | ev_0060a05915be4ca4ded57ec32bec5f134fce0b787b666a5f8f1da6436c8fdf0e | @n8n/config (executions, scheduler, nodes) |
| ev_799da78a322d | ev_799da78a322d255fcd604edef9df3940e730b3cf147e1c179daa8abc673f441c | ev_a3bd16d9cb026778791f268d7fbcd26613daf64c9c737e3e771ac45f7d9d39d9 | n8n-nodes-base (Merge v3, Wait, Schedule, SplitInBatches, Execute Command) |
| ev_55265a2daf13 | ev_55265a2daf132f57ab539dd5172b7652e5819c6e80ed194085d65dab492b4ab0 | ev_5a8350a9c177659a31d15ebc7e3813499076041d7abd463db95a1184d7d867f4 | n8n CLI services (execution, runner, concurrency, recovery, lifecycle, pruning) |
| ev_462cb5dc5ffc | ev_462cb5dc5ffcae00d2037e22c3711036dbd0b6cfaeabddd3655f6ad23b887161 | ev_460707a63660f87f52d5fcadc03df90d28510bbbd417e016ee8f7081272d2e51 | n8n-workflow (filter parameter, execution status, data proxy) |
| ev_bbfef8cdd3dc | ev_bbfef8cdd3dccaa11b3956a2643985f350e990ae102c42523fb79366a51252b2 | ev_09f810288edd53ecce95ff78549efe73ed4ed28dc168fda05cda9ff4237ad1bb | n8n CLI controllers, webhooks and modules (MCP tools, AI, source control, insights, breaking changes) |
| ev_1a1290b44cea | ev_1a1290b44cea07e492e5657e19a2592409911def2df494bcf4c82695b1b5924f | ev_39d66b6e0604b0e28500ad2f55d7dee48c8a4a7f25cf194e217b2a04a54fb974 | @n8n/engine (engine v2) |
| ev_5f95c56904eb | ev_5f95c56904ebbc26832aa6bcf1041ddd767d972ea15c5afad86b56316a409d30 | ev_3fc72d93d4ec0ee69066deeadeecb98c293e6ffa000070e616e4d653a13d4d7b | @n8n/n8n-nodes-langchain |