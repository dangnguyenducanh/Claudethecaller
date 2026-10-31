# Decisions for T6.3: workflow engine (parse, walker, shell/if/approval/fanout/join nodes), gates with options, handoff, cleanup

Tags: FROM-OWNER (O#, agent/OWNER.md), FROM-SPEC (specs/007-ctc/spec.md line), FROM-CALLERS (file:line), YOUR-CHOICE (owner reviews every one, O11).
"spec" = `specs/007-ctc/spec.md`. "core" = `packages/core/src/runner` (`@ctc/core/runner`; T6.1 `index.ts`, T6.2 `exec.ts`), "worker" =
`apps/worker/src/runner`, "web" = `apps/web/src/runs`, "repos" = `createRepositories(db)` (T1.3), "step"/"run" = `repos.runner` `Step`/`Run` rows
(camelCase). "T6.1 core" = `transitionStep`, `failStep`, `retryStep`, `cancelRun`, `advanceStage`, `runnerJobId`, `RunnerError`. "T6.2" = `runnerHandlers`,
`sweepRunner`, `runGroup`, `scrubbedEnv`, `runGit`, `withRepo`, `worktreeRecipe`, `AgentNode`. "node" = a node of the workflow file; "step" = a `wf_steps`
row. "current attempt" = highest `attempt` of `(runId, nodeId, visit)` (T6.1 D13b). A tag at the end of a block of indented lines covers the whole block.

D0  Purpose and callers. The engine turns a saved workflow (spec:589-608) into steps: it starts a run, walks the graph, executes every node type
    that is not an agent (shell, if, approval, merge, fanout, join), hands agent nodes to T6.2, derives the run status from the steps, and
    cleans up after a run. This task also owns the walker and "the run status follows its steps" (T6.1 OPEN A1). Callers:
    (a) the worker main (not built yet) binds `workflowHandlers(deps)` and `cleanupHandlers(deps)` into `startWorkers({ handlers })`, calls T6.2
        `sweepRunner` once at boot BEFORE the workers, then `startRunnerLoop(deps)`; it passes `deps` (`EngineDeps`, D9) and never `resolveNode`/
        `onStepEnd` (the engine supplies both to T6.2);
    (b) `runAttempt` (apps/worker/src/jobs/consumers.ts:55-110) calls the `runner.step` handler for EVERY node type that runs as a job, with the T6.2
        payload `{userId, runId, stepId, nodeId, visit, attempt, timeoutS}`; the T6.1 retry route (`deps.enqueueStep`) re-queues any node type through it;
    (c) `startRunnerLoop` ticks `advanceRun` for every active run; `advanceRun` is also called at the end of every step (T6.2 `onStepEnd`);
    (d) the ctc-web bootstrap mounts `workflowRoutes(deps)` next to T6.1 `runsRoutes(deps)`, and registers `workflowTools(deps)` on `/mcp`;
    (e) the dashboard Runs page calls the routes (frontend spec pending, O12); an agent calls MCP `run_workflow` and `workflow_status`.
    Results: functions return plain JSON-safe values or throw; routes reply through the Fastify-style `reply` and never throw (T6.1 D3).
    FROM-SPEC (spec:97 code map, spec:589-608, spec:672-678, spec:687, spec:689-702, spec:791). FROM-CALLERS (agent/t6-1-runner-core/OPEN.md A1 "T6.3
    owns the walker and the run status"; agent/t6-2-runner-exec/DECISIONS.md D0c, D7, D13b, D20; apps/worker/src/runner/types.ts:13-31). The tick loop as the
    only trigger of `advanceRun` besides `onStepEnd` (no new queue kind), and one handler for all node types: YOUR-CHOICE.

D1  Trust. Trusted: `deps`, `ctx` from `deps.ctxOf`, the payload's `userId`. Untrusted: the workflow text (library file), every run input, `repo`, `base`,
    every route param/header/body, every byte a shell command or an agent writes (outputs feed later prompts and shell lines), child branch names read
    from step rows, and `idempotency` replays. Rules:
    (a) every repos call uses the caller's ctx; another user's run, step, workflow or capability is `404 not_found`, never a different code;
    (b) no untrusted value reaches a shell line unquoted: `renderTemplate(text, scope, { shell: true })` wraps every substituted value in single quotes
        (D11); git and the T6.2 agent start with argv arrays; the only `sh -c` of this task is the shell node's own `run` text (D15);
    (c) shell nodes get the scrubbed worker environment (T6.2 `scrubbedEnv`: no `CTC_*` variable) plus `CTC_ROOT_PATH`, `CTC_WORKTREE_PATH`, `CTC_RUN_ID`,
        `CTC_STEP_ID`; they never get a step token;
    (d) `repo` must be an absolute path (no NUL, no `..` segment, at most 4,096 chars) and `base` a plain ref name (`^[A-Za-z0-9][A-Za-z0-9._/@-]{0,199}$`, no
        `..`, no `.lock` suffix); a path to remove or merge into is only ever built from `worktreeRecipe` (D18) or checked to lie under
        `<run.repo>/<worktree.dir>/<runId>/` (D22);
    (e) `bypassPermissions` and any permission outside `PERMISSIONS` never reach T6.2 (D10).
    Prevents: shell injection from inputs or from an agent's previous output, leaking ctc secrets to repo code, cross-user reads, removing a directory that is
    not a ctc worktree. FROM-SPEC (spec:138-140, spec:603, spec:608). FROM-CALLERS (apps/worker/src/runner/proc.ts `scrubbedEnv`; T6.2 D1c). Quoting every
    substituted value, the ref pattern and the path rules: YOUR-CHOICE.

D2  Limits (module constants, read at call time so a test can change and restore them).
    core `workflowLimits` = `{ maxNodes: 200, maxEdges: 1000, idMax: 64, textMax: 20000, fanoutItemsMax: 20, fanoutParallelMax: 3, itemMax: 2000,
      defaultMaxVisits: 3, shellTimeoutS: 600, outTailChars: 4000 }`: `maxNodes`/`maxEdges`/`textMax` (prompt, run, question, left, right, each) are
      inclusive (200 nodes valid, 201 an error); `fanoutItemsMax` is the number of items a fanout may create (20 valid, 21 an error, never silently cut);
      `fanoutParallelMax` 3 and `defaultMaxVisits` 3 and `shellTimeoutS` 600 are FROM-SPEC; `outTailChars` is the length of the stdout tail kept as a shell
      node's output (the last 4,000 chars). From config, read at every call: `runner.max_visits` (3, replaces `defaultMaxVisits`), `runner.fanout.max_parallel`
      (3, the effective parallel limit is `min(node.maxParallel, config, 3)`), `runner.fanout.max_depth` (1; a value above 1 is read as 1, nested
      fanout is not built), `runner.worktree.keep_days` (7), `runner.max_failures` (3).
    worker `engineLimits` = `{ tickMs: 2000, maxRounds: 1000, shellOutputMaxBytes: 10485760, watchMs: 1000, mergeTimeoutS: 600 }`: `tickMs` period of the
      loop; `maxRounds` bound on the start/complete rounds of one `advanceRun` (then it stops and the next tick continues); `shellOutputMaxBytes` the cap
      of a shell node's output file (inclusive: exactly the cap is fine, one byte more is overflow); `watchMs` how often a running shell or join re-reads
      its step to notice a cancel; `mergeTimeoutS` budget of one join.
    web `startLimits` = `{ repoMax: 4096, baseMax: 200, inputsMaxBytes: 65536 }` and `handoffLimits` = `{ waitMs: 8000, pollMs: 100 }`.
    FROM-SPEC (spec:596 and 601 and 710-713 for 3/3/3/600). Every other number: YOUR-CHOICE (chosen by judgment).

D3  Output and error format.
    (a) `parseWorkflow(source)` returns `{ ok: true, workflow }` or `{ ok: false, errors: string[] }`; each error is one line (D10 lists the exact texts).
    (b) The `runner.step` handler resolves `{ stepId: number, status: string, skipped: boolean }` like T6.2 D3a and rejects only like T6.2 (`JobDropped`,
        a non-race repository error). `advanceRun(deps, ctx, runId)` resolves `{ status: string | null, started: string[], skipped: string[] }`
        (`status` = the run status after the call, `null` when the run is not visible; `started`/`skipped` = node ids acted on in this call), never rejects
        for a workflow or step problem (it records it, D13e); `tickRuns(deps)` resolves `{ advanced: number[] }` (run ids).
    (c) Routes (reply `{status, body}`, errors `{ error: { code, message, ...extra } }` as T6.1 D3):
        `GET /api/workflows` `200 { workflows: [{ id, name, namespace, servedVersion }] }` (kind `workflow`, name order);
        `GET /api/workflows/:id` `200 { id, name, namespace, version, workflow | null, errors: string[] }` (`workflow` = the parsed `Workflow`);
        `POST /api/workflows/:id/runs` `202 { run_id: number, status: string }`;
        `GET /api/runs` `200 { runs: [...], next: string | null }` (`runJson`, keyset as library lists); `GET /api/runs/:rid` `200 { run, steps }` (`runJson`,
        `stepDetailJson` of every attempt, oldest first);
        `POST /api/runs/:rid/approve` `200 { applied: boolean, step, run: { id, status } }`; `POST /api/runs/:rid/continue` `200 { applied: boolean, run:
        { id, status }, resumed: number }`; `GET /api/runs/:rid/steps/:sid/log` `200` with a `Readable` of the log (header `content-type:
        application/x-ndjson` when `reply.header` exists).
        `runJson` = `{ id, owner, workflowCapId, workflowVersion, status, trigger, inputs, repo, baseBranch, createdAt, startedAt, endedAt }` (dates ISO or null).
        `stepDetailJson` = every key of T6.1 `stepJson` plus `options, worktree, branch, usage, costUsd`; never `logPath`, `tokenHash`, `pid`, `pidStartedAt`.
    (d) MCP tools return `{ content: [{ type: 'text', text: <JSON string> }] }`, or `isError: true` with the error body (library `McpResult` shape):
        `run_workflow` text = `{ run_id, status, prompt_outcome }`; `workflow_status` text = `{ run_id, status, steps: [{ id, node_id, visit, attempt, status,
        stage, resolution, prompt_outcome }] }`.
    (e) Step `error` texts written by this task (then cut to `errorMax`): `node not found` | `no worktree to run in` | `shell failed: exit <n>` |
        `shell timed out after <s> s` | `shell output over <mb> MB` | `merge conflict: <file>, <file> (branch <b>)` | `merge failed: <git line>` |
        `child <nodeId> failed` | `fanout: <reason>` (`<n> items exceeds <max>`, `bad items`) | `join: <reason>` | `interrupted`.
    FROM-SPEC (spec:694-702 routes, spec:701-702 MCP, spec:152 and 157 error codes). FROM-CALLERS (apps/web/src/runs/index.ts:83-89 `stepJson`; library
    `McpResult` apps/web/src/library/http.ts:35). Every shape and text: YOUR-CHOICE.

D4  Bad input. Order, first problem wins, for every route: (1) params `:id` (uuid) / `:rid`, `:sid` (`^[1-9][0-9]{0,15}$`): junk → `404 not_found`;
    (2) lookup of the run / step / capability → `404`; (3) `Idempotency-Key` header (T6.1 `keyOf`, `422` with `path ['headers','idempotency-key']`);
    (4) body → `422` with `path ['body', ...]`; (5) state: stale attempt → `409 stale_attempt`; wrong status → `409 conflict`. (`approve` carries its step id in the body, so its step lookup → `404` follows (4).) A workflow that does not parse
    is `422 invalid` on POST runs with `message` = the first error and extra `errors` (all of them). Nothing is written for a reply produced in steps 1-4.
    `parseWorkflow`, `renderTemplate`, `evalCondition`, `planFanout` and every `walker*` function never throw on junk (null, numbers, arrays, deep or
    cyclic objects, non-string text): they return `{ ok: false, errors }`, `''`, `false`, `{ ok: false, error }`, or the state unchanged with `error` set.
    FROM-SPEC (spec:152). FROM-CALLERS (agent/t6-1-runner-core/DECISIONS.md D4). YOUR-CHOICE (order and `errors` extra).

D5  Odd but harmless input stays valid: a workflow with unknown extra keys on nodes or at the top (ignored); a node unreachable from the trigger (never runs,
    no error); an `if` whose `right` is missing (`''`); a template variable that does not exist (renders `''`, listed in `missing`, never an error); a
    `fanout` with an empty list (zero children, the join gets `[]`); a run with no inputs; `repo` omitted (null; only nodes that need a repo fail, D14/D15);
    `Idempotency-Key` absent; a repeated approve with the same option (no-op); a `continue` on a running run (no-op); a cleanup job for a run that is not
    due or whose worktree is already gone (no-op); `YAML` and `JSON` text, with CRLF line ends; node ids that differ only by case. judgment: tolerant by
    default (D8). YOUR-CHOICE.

D6  Must never:
    (a) write `wf_steps.status` except through T6.1 core (`transitionStep`, `failStep`, `retryStep`, `cancelRun`) or the core functions of D16/D20 built on
        them: no `.transition(` call anywhere in the new sources; `setRunStatus(` only inside core and inside ONE worker file named `runstate.ts`;
        `setStepFields` never gets `status`;
    (b) run `git push`, `gh pr`, or any git command with `--force`, `-f`, `-B`, `-D`, `branch -d`, `reset`, `clean`, `checkout`, `rebase`, `stash`;
        `worktree remove` appears only in the cleanup file and never with a force flag; never delete a branch; never delete or overwrite a repo file;
    (c) accept or pass `bypassPermissions` (D10), or let a shell line or a prompt that contains `git push` / `gh pr create|merge` run without an approval
        node on every path before it (D10);
    (d) act on absence: a quiet shell or join is never killed for being quiet (only its `timeout_s`, a cancel, overflow); a step found `running` after a crash is
        never re-run by the engine (T6.2 sweep decides; D15 says what a shell does);
    (e) start a node twice: `advanceRun` called any number of times, also at the same time, creates each `(run, node, visit, attempt)` row once and submits
        each job id once (repeat submits are allowed, they are the same job);
    (f) edit its arguments (the workflow, the state, `deps` may be deep-frozen), throw out of `advanceRun`/`tickRuns` for a step or workflow problem, or touch
        a run that is `done`, `failed` or `cancelled` (except `cleanup`, D22);
    (g) import `pg`, `kysely`, `bullmq` or `ioredis` (SQL only through `deps.repos`, queues only through `deps.submit`), read `~/.claude`, `~/.claudethecaller`
        or any path outside `deps.runsDir`, the run's repo and its worktrees, or leak a token, a `tokenHash`, a pid or an `inputs` value into a log line.
    FROM-SPEC (spec:603, spec:608, spec:622, spec:686, spec:687 "keep the branch"). FROM-OWNER (O12). FROM-CALLERS (agent/t6-2-runner-exec/DECISIONS.md D6;
    agent/t6-1-runner-core/DECISIONS.md D6). The word lists and the single-file rule for `setRunStatus`: YOUR-CHOICE.

D7  Non-goals (which code does that instead): `wf_schedules` firing and the `/api/schedules*` routes (unchanged, later); the dashboard pages (no frontend spec,
    O12); nested fanout (depth is 1); more agents than `claude` and `codex`; the T6.2 cold path, report route and restart sweep (built); Fastify, auth, rate limit
    and the worker main (bootstrap); `ctc.yaml` (T6.2); `git push`/PR creation (a user's agent does it after an approval); resolving a merge conflict (the
    join fails and lists the files); exporting workflows to `.claude/workflows/*.js`; the abandoned LLM coordinator. FROM-SPEC (spec:787-791, spec:700 schedules
    unchanged, spec:675 depth 1) FROM-OWNER (O12). YOUR-CHOICE (exact split).

D8  Silence rule. Where this list says nothing, choose the more tolerant, less destructive behaviour (no-op over error for a repeat; refuse over guessing; keep a
    row, branch or worktree over removing it; park a step over failing it) and add a comment starting `judgment:`. FROM-OWNER (O11).

D9  Layout and public names (TypeScript strict, Node type stripping, no build, no new dependency, no `package.json` or lockfile change; `yaml` is already a core
    dependency):
    core: new files in `packages/core/src/runner/` (`workflow.ts`, `walker.ts`, `gates.ts`; more if needed), re-exported from `index.ts` by added
      `export … from` lines only. Pure: no `node:*`, `@ctc/shared` only as `import type`. Exports: `NODE_TYPES`, `workflowLimits`, `parseWorkflow`,
      `renderTemplate`, `evalCondition`, `scopeOf`, `outText`, `planFanout`, `childId`, `parseChildId`, `walkerStart`, `walkerNext`, `walkerComplete`,
      `walkerStatus`, `isReadonlyNode`, `deriveRunStatus`, `approveStep`, `continueRun`, `REJECT_OPTION` (`'reject'`), types `Workflow`, `WorkflowNode`,
      `WalkerState`. Signatures: D10-D12, D16, D17, D20.
    worker: new files in `apps/worker/src/runner/` (`engine.ts`, `shell.ts`, `join.ts`, `fanout.ts`, `cleanup.ts`, `runstate.ts`; more if needed),
      re-exported from `index.ts` by added `export … from` lines only. Exports: `workflowHandlers(deps): { 'runner.step': Handler }`, `advanceRun`, `tickRuns`,
      `startRunnerLoop(deps): { stop(): Promise<void> }`, `cleanupHandlers(deps): { 'cleanup.worktree': Handler, 'cleanup.receipts': Handler }`,
      `scheduleCleanup(deps): Promise<{ submitted: number }>`, `engineLimits`, type `EngineDeps`.
      `type EngineDeps = Omit<RunnerExecDeps, 'resolveNode' | 'onStepEnd' | 'config'> & { config: { runner: RunnerExecDeps['config']['runner'] &
        { max_visits: number; worktree: { add_timeout_s: number; dir: string; keep_days: number }; fanout: { max_depth: number; max_parallel: number } } };
        submit(input: { queue: string; kind: string; payload: unknown; id?: string }): Promise<{ id: string }>;
        loadWorkflow?(ctx: Ctx, run: Run): Promise<Workflow | null>; now?(): Date }` (a full `Config` from `@ctc/shared/env` satisfies `config`). Default
      `loadWorkflow`: `repos.library.getVersion(ctx, run.workflowCapId, run.workflowVersion)` (the pinned version), its manifest, `mainPathOf`, `getBlob`,
      `bodyOf` (`@ctc/core/library`), then `parseWorkflow`; any failure → `null`.
    web: new files in `apps/web/src/runs/` (`workflows.ts`, `start.ts`, `tools.ts`; more if needed), re-exported from `index.ts` by added `export … from`
      lines only: `workflowRoutes(deps: WorkflowApiDeps): Route[]` (exactly the 8 routes of D3c), `workflowTools(deps): McpTool[]` (exactly `run_workflow`,
      `workflow_status`), `startRun`, `runJson`, `stepDetailJson`, `startLimits`, `handoffLimits`, type `WorkflowApiDeps = RunsDeps & { library: LibraryApiDeps;
      runsDir: string; ownerOf?(ctx: Ctx): string | Promise<string>; advance?(ctx: Ctx, runId: number): Promise<void>;
      enqueueResume?(ctx: Ctx, step: Step, jobId: string): Promise<void> }` (`enqueueResume` submits a resumed step under the given job id, D20).
    shared: `packages/shared/src/schemas/workflows/index.ts` (new, Zod only, `@ctc/shared/schemas/workflows`): the body/query schemas of the new routes.
    Small edits outside the modules (nothing else in these files): D24.
    Test helpers live in `testing.ts` files (not exported from `index.ts`). FROM-SPEC (spec:97, spec:89, spec:689-702). FROM-CALLERS (packages/core/package.json
    `exports "./*"`; apps/web/src/runs/index.ts:122 `runsRoutes` stays exactly the 4 routes of T6.1 D9; apps/web/src/library/tools.ts:47 `libraryTools` pattern).
    Names, file split and deps shapes: YOUR-CHOICE.

D10 Workflow format (`parseWorkflow(source, opts?)`, pure). `source` is YAML or JSON text, or an already parsed object. Result `workflow` is
    `{ name: string, description: string | null, inputs: unknown, nodes: WorkflowNode[], edges: { from, to, handle: string | null }[], maxVisits: number }`.
    Key names in the file are snake_case (`timeout_s`, `max_parallel`, `max_visits`), in `Workflow` camelCase. Ids: `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`, unique,
    not `input`, `resolution`, `item`, `index`, `run`. Node types and fields (defaults in brackets):
      `trigger` (exactly one);
      `agent`: `agent` (`claude` | `codex`), `prompt`, `worktree` (`new` | `parent` | `none`, [`new`]), `permission` (`acceptEdits` | `dontAsk` | `plan`,
        [`acceptEdits`]), `model` [null], `timeout_s` [1800], `base` [null];
      `shell`: `run`, `cwd` (`worktree` | `repo`, [`worktree`]), `timeout_s` [600];
      `if`: `op` (`eq` | `ne` | `contains` | `truthy`), `left`, `right` [`''`]; edges out of it carry `handle: true` or `handle: false` (YAML booleans and the strings
        `"true"`/`"false"` are the same handle);
      `approval`: `question`, `options` (`[{id, label}]`, 1 to 8 entries with unique ids matching `^[A-Za-z0-9_-]{1,40}$`, [`approve`/`Approve`, `reject`/`Reject`]);
      `merge`; `fanout`: `over` (a string template or a number), `child` (an agent body with no `id`, and `worktree` `new`), `max_parallel` [3, 1 to 3];
      `join`: `strategy` (`merge` | `collect`, [`merge`]), with exactly one incoming edge, from a `fanout` node.
    `max_visits` at the top (or `opts.maxVisits`, else 3). Edges: `{ from, to, handle? }`. Back-edges are found by DFS from the trigger in node order (an edge to a
    node on the DFS stack); they are the loops (D12).
    Errors (exact texts, in this order of checks: shape, ids, types, fields, edges, graph rules, push guard; all errors are collected, at most 50):
      `workflow must be an object` | `nodes must be a list` | `workflow needs exactly one trigger` | `node <id>: invalid id` | `node <id>: duplicate id` |
      `node <index>: missing id` | `node <id>: unknown type "<t>"` | `node <id>: <field> is required` | `node <id>: permission "<p>" is not allowed`
      (also for `bypassPermissions`) | `node <id>: unknown agent "<a>"` | `node <id>: <field> is too long` | `node <id>: fanout depth exceeded (max_depth 1)`
      (a `child` whose `type` is `fanout`, or a `child` that has a `child`) | `node <id>: fanout child must use worktree new` | `node <id>: max_parallel must be 1 to 3` |
      `node <id>: options must be 1 to 8 entries with unique ids` | `edge <index>: unknown node "<x>"` | `edge <index>: invalid handle "<h>"` |
      `join <id>: needs exactly one incoming edge, from a fanout node` | `workflow has too many nodes` | `workflow has too many edges` |
      `node <id>: git push or gh pr needs an approval node on every path before it`.
    The push guard: a shell `run` or an agent/fanout-child `prompt` that matches `/\b(git\s+push|gh\s+pr\s+(create|merge))\b/` is an error unless every path from
    the trigger to that node (over forward and back edges) passes an `approval` node (graph search that avoids approval nodes cannot reach the node).
    `parseWorkflow` never throws and edits nothing.
    FROM-SPEC (spec:591-608 format, node table, `bypassPermissions` never, push guard, spec:596 defaults, spec:601 `max_parallel ≤ 3`, spec:675 depth 1,
    spec:734 "depth 2 refused", spec:605 max_visits default 3). Key naming, id pattern, option limits, error texts, handle spelling, `cwd` default, `join`
    having exactly one fanout input, the 50-error cap: YOUR-CHOICE.

D11 Templates and conditions (pure).
    `renderTemplate(text, scope, opts?) → { text, missing }`: replaces `{{ name }}` (`/\{\{\s*([\w.-]+)\s*\}\}/g`) by `String(scope[name])` when `scope` has the own key
    (never a prototype key such as `constructor`), else by `''` and `name` joins `missing` (first occurrence order, no duplicates). A substituted value is never
    scanned again. With `opts.shell` every substituted value, empty ones too, becomes `'` + value with each `'` written `'\''` + `'`. Non-string `text` → `''`.
    `scopeOf({ inputs, outputs, resolution?, item?, index? })` builds the scope, every value a string: `input.<key>` for every top-level key of `inputs` (a string as is,
    anything else `JSON.stringify`), `<nodeId>.out` and `<nodeId>.exit` (`String(exit)`) for every entry of `outputs` (`{ out: string, exit?: number }`), `resolution`,
    `item`, `index` (`String(index)`), the last three only when given. `outText(node, output)` is the `out` of a finished step: agent → `output.summary ?? ''`; shell → `output.stdoutTail ?? ''`; approval →
    the chosen option id; if → the handle (`'true'`/`'false'`); join and fanout → a JSON array text of the children's summaries (strings) in index order, or the
    join's `summary` for `merge`; merge/trigger → `''`.
    `evalCondition(op, left, right) → boolean`: both sides are trimmed; `eq` `left === right`; `ne` the opposite; `contains` `left.includes(right)`; `truthy`
    `left.toLowerCase()` is not one of `''`, `0`, `false`, `no`, `null`, `undefined`; an unknown `op` is `false`.
    The engine renders `prompt`, `run`, `question`, `left`, `right`, `over` with the scope at the moment the node starts; the result is cut to `textMax`.
    FROM-SPEC (spec:596 `{{input.x}}` `{{node.out}}`, spec:598 ops, spec:674 `{{resolution}}`). YOUR-CHOICE (the whole syntax details: shell quoting, `.exit`, missing →
    empty, trimming, the truthy list).

D12 Walker (pure; the state is opaque JSON, deep-equal after `JSON.stringify`/`parse`; `{}` is "not started"; no function edits its arguments).
    `walkerStart(wf) → state`: the trigger is completed at once (no step row for it) and its out-edges are taken.
    `walkerNext(wf, state) → { state, start: {nodeId, visit}[], skip: {nodeId, visit}[] }`: a node is READY when it has at least one incoming forward edge, every
    incoming forward edge is resolved (taken or dead) and at least one is taken, or when an incoming back-edge was taken. All its resolved edge marks are then
    consumed (a loop re-entry waits for fresh marks). A node whose forward edges are all dead is SKIPPED (marks consumed, out-edges dead, repeated until nothing
    changes; every skip is listed once with its visit). `visit` = number of times the node was started or skipped before, plus 1. The batch rule (spec:605):
    when any READY node is readonly (`isReadonlyNode`), `start` is all READY readonly nodes in node order and no writer; else `start` is the first READY writer
    in node order, but only if no writer is running (started, not completed); else `start` is empty. `isReadonlyNode`: trigger, if, approval, merge, fanout, join
    with `strategy: collect`, and agent with `permission: plan`; every other node (shell, join merge, other agents) is a writer.
    `walkerComplete(wf, state, nodeId, { ok, handle? }) → { state, error }`: `ok: true` takes every out-edge, except that an `if` takes only the edges whose handle
    equals `handle` (`'true'`/`'false'`) and marks the others dead; a back-edge that is taken makes its target ready again unless the target has already been started
    `maxVisits` times, in which case `error` is `loop <nodeId> exceeded max_visits <n>` and the walker is failed. `ok: false` fails the walker (no edge is taken,
    nothing more starts). A node that is not running or an unknown node leaves the state unchanged with `error: 'unknown node <id>'`.
    `walkerStatus(wf, state) → 'running' | 'done' | 'failed'`: failed after a failure or loop error; done when nothing is running, ready or skipped-pending; else running.
    FROM-SPEC (spec:604-608 walker rules: readonly batch then one writer, loops are back-edges capped by max_visits, merge waits for all incoming edges). YOUR-CHOICE
    (state shape, ready/skip/consume rules, visit numbering, which nodes are readonly, loop error text, a trigger without a step row).

D13 Engine: `advanceRun(deps, ctx, runId)` (idempotent, safe to call at any time and from several places). Under one in-process lock per `(userId, runId)`:
    (a) load the run; `null` → `{ status: null }`; status `done`/`failed`/`cancelled` → return it unchanged. Load the pinned workflow (`deps.loadWorkflow`); `null`
        or unparsable → record it (D13e) and fail the run.
    (b) state `{}` → `walkerStart`, started at `now` (`startedAt` set when empty). Reconcile: for each started-not-completed node, look at the CURRENT attempt of
        `(node, visit)`: `done` → `walkerComplete(ok)` (an `if` passes its handle from the step `output.handle`); `circuit_broken` or `cancelled` →
        `walkerComplete(ok: false)`; `failed`/`timeout`/`start_unknown` (a retry is still possible) and `queued`/`running`/`waiting`/`quota` → left pending. Special
        cases: an approval step done with resolution `reject` (D16) cancels the run (`cancelRun`); an agent step that is `done` with `stage === null` is a setup gate
        answer (D16): it is not a completion, the next attempt is inserted instead. A fanout node is reconciled by D17.
    (c) Rounds (at most `engineLimits.maxRounds`): `walkerNext` → write a `skipped` step per `skip` entry (insert `queued`, then `transitionStep queued → skipped`);
        start every `start` entry by node type: `agent`, `shell`, `join` with `merge` → insert `queued` (attempt 1, `failureCount` 0) and submit job id
        `runnerJobId(...)` to queue `runner` kind `step` with the D0b payload (`timeoutS` = node `timeoutS`, `mergeTimeoutS` for join); `if`, `merge`, `join` with
        `collect`, `approval`, `fanout` run in this call: insert `queued`, `queued → running` (`startedAt`), then the node's own end (if/merge/collect: `running →
        done` with `output`, then `walkerComplete`; approval: `running → waiting` with `options`, D16; fanout: D17). A node whose rendering or evaluation throws ends
        `failed` through `failStep` with the exception class name. Repeat rounds until nothing starts or completes inside this call.
    (d) Derive and write the run status with the pure `deriveRunStatus({ walker, current })`, where `current` lists the current attempt of every started-not-completed
        node `{ nodeId, status, bookkeeping }` (`bookkeeping` true for a fanout row): `failed` if the walker failed (and a circuit-broken step exists or the loop
        error); else `quota` when some step is `quota` and none is `queued`/`running`; else `running` when some step is `queued` or `running`; else `waiting` when some
        step is `waiting` (not bookkeeping), `start_unknown`, `failed` or `timeout` (retry pending) or a fanout has a parked child; else `done` when the walker is done;
        else `running`. `done`/`failed` set `endedAt`. The write goes through `runstate.ts` (`setRunStatus`, one re-read on `ConflictError`, never from a final status;
        `running` that hits the one-running-per-owner index leaves the status as it is).
    (e) A problem with the workflow or the engine (unloadable workflow, `maxRounds` reached) is logged (`deps.log`, ids and class names only) and stored in the run
        `state` under `error`; an unloadable workflow fails the run.
    (f) The walker state is saved after the rows of the round are written (insert is idempotent, so a crash between the two repeats the round harmlessly).
    `tickRuns(deps)`: `repos.system.runner.listActiveRuns(createSystemCtx('runner tick'))` (D24), then `advanceRun` for each with `{ userId: row.userId }`, one at a
    time, errors logged. `quota` runs are also checked for a passed reset time (D20). `startRunnerLoop(deps)` calls `tickRuns` every `engineLimits.tickMs`, never two
    ticks at once; `stop()` waits for the tick in flight. `onStepEnd` (given to T6.2) calls `advanceRun` for the step's run.
    FROM-SPEC (spec:640 "The run status follows its steps", spec:622, spec:644 job id, spec:686, spec:196 "Redis down: the worker polls `jobs`"). FROM-CALLERS
    (agent/t6-1-runner-core/OPEN.md A1; packages/core/src/runner/index.ts:92 `transitionStep`; apps/worker/src/runner/runstatus.ts). Rows-first idempotent rounds, the lock,
    the tick, the status derivation, no step row for the trigger: YOUR-CHOICE.

D14 Agent nodes (the engine's `resolveNode` for T6.2). For a step whose node is an `agent` (or a fanout child, D17): `AgentNode` = `{ agent, prompt: <rendered>,
    worktree, permission, model, timeoutS, workflow: wf.name, child: <index | null>, base, parentWorktree, resolution, setupDecision }`. Scope: `scopeOf` over the run
    `inputs` and the `outputs` of the latest finished step of every node (D11), `resolution` = the `resolution` of the most recent finished approval step of the run
    (null when none), and `item`/`index` for a child. `base` = the node's `base`, else for a child the branch of the nearest upstream step that has a `branch` (the
    "parent's branch", spec:675), else `run.baseBranch`. `parentWorktree` (for `worktree: parent`) = the `worktree` of the nearest upstream step that has one,
    where "nearest upstream" walks incoming edges breadth-first from the node, newest visit first. `setupDecision` = the `resolution` (`run`/`skip`) of the step that
    this attempt retries when that step was a setup gate answer (D16), else null. A step that already has a `worktree` when it is resolved is a resumed attempt (quota, D20): the node is rendered with `worktree: 'parent'` and
    `parentWorktree` = that worktree, so T6.2 works in the existing worktree and does not try `git worktree add` on a branch that exists (T6.2 D12b). A null result
    (unknown node, bad workflow) makes T6.2 fail the step with `node not found`. FROM-SPEC (spec:654 preamble with gate resolution, spec:674 "walker passes `{{resolution}}` into the next agent prompt", spec:675 "from the
    parent's branch"). FROM-CALLERS (packages/core/src/runner/exec.ts:34-47 `AgentNode`; agent/t6-2-runner-exec/DECISIONS.md D0c, D9, D13b). The upstream search,
    the scope content and `setupDecision` source: YOUR-CHOICE.

D15 Shell nodes (job `runner.step`, handled by this task). Claim `queued → running` (`startedAt`), render `run` with the shell scope (D11, quoted), `cwd`:
    `worktree` → the `worktree` of the nearest upstream step that has one (D14), else the step fails `no worktree to run in`; `repo` → `run.repo` (null →
    `no worktree to run in`). Write stage `spawn` before the start; run `['/bin/sh', '-c', <line>]` through T6.2 `runGroup` (new process group, output into
    `<runsDir>/<runId>/<stepId>.out`, cap `shellOutputMaxBytes`, timeout `timeout_s`, abort on the job signal or when the step is no longer `running`, noticed
    every `watchMs`), env = `scrubbedEnv` + the D1c variables, `logPath` = the out file. The step has no `pid` (a crash leaves a `running` step at stage `spawn` with no pid:
    T6.2's restart sweep makes it `start_unknown` and the user retries or fails it; the engine never re-runs a shell, D6d). End: exit 0 → `running → done` with
    `output { outcome: 'done', summary: <stdoutTail>, exitCode: 0, stdoutTail }`, stage `report`; exit ≠ 0 → `failStep failed` `shell failed: exit <n>` with the same
    output keys (`outcome: 'failed'`); timeout → `failStep timeout` `shell timed out after <s> s`; overflow → `failed` `shell output over <mb> MB`. `stdoutTail` = the last
    `outTailChars` chars of the out file (UTF-8, lossy). The handler ends with `onStepEnd` once like T6.2 D16d and resolves D3b.
    FROM-SPEC (spec:597 shell node, spec:628 `shell exit 0 → done`, spec:631 timeout). FROM-CALLERS (apps/worker/src/runner/proc.ts:91 `runGroup`; T6.2 D13c, D19).
    The carried worktree, `no worktree to run in` instead of falling back to the main checkout, the sweep story, the output keys: YOUR-CHOICE.

D16 Gates with options (spec:674).
    (a) An `approval` node (run inline by D13c): `question` and `options` rendered; the step goes `queued → running → waiting` with `options` = the option list and
        `output = { question }`; the run is derived `waiting` (D13d). No agent is started.
    (b) `approveStep(port, ctx, { stepId, optionId }) → { step, applied }` (core, built on `transitionStep`; used by the route): step not visible →
        `RunnerError('not_found')`; not the current attempt → `RunnerError('stale_attempt')`; `optionId` not among the step's `options` ids →
        `RunnerError('conflict', 'unknown option')` (the route checks the option against the step's `options` first and answers `422 invalid` with `path ['body','option_id']`); the step already `done` with the same
        resolution → `{ step, applied: false }` (duplicate no-op); `done` with another resolution, or any status other than `waiting` → `RunnerError('conflict')`; else
        `waiting → done` with patch `{ resolution: optionId, output: { outcome: 'done', summary: optionId, choice: optionId }, endedAt: now }` (a `ConflictError`
        → re-read, then the same no-op/conflict rules).
    (c) Route `POST /api/runs/:rid/approve` `{ step_id, option_id }` (strict body, `Idempotency-Key` accepted through T6.1 `withIdempotency`): D4 order, then
        `approveStep`; reply D3c. The run status is not written here (the engine derives it).
    (d) The choice is the node's output (`{{gate.out}}` = the option id) and `{{resolution}}` for later agent prompts (D14). A resolution equal to `reject` (the
        default option id, `REJECT_OPTION`) of an approval NODE cancels the run at the next `advanceRun` (`cancelRun`); a workflow that wants other behaviour uses
        its own option ids and an `if`.
    (e) Setup gate (T6.2 D13b parks an agent step in `waiting` with options `run`/`skip`): the same route approves it. At the next `advanceRun` an agent step that is
        `done` with `stage === null` is not a completion; the engine inserts the next attempt (`attempt + 1`, `retryOfStepId` = that step, same `failureCount`, same
        `parentStepId`, `queued`) and submits it; D14 gives the new attempt `setupDecision` = the resolution. A cancelled or finished run never gets the new attempt.
    FROM-SPEC (spec:599 approval node, spec:674 gate, spec:653 setup `ask` "makes a gate first", spec:699 route list, spec:726 lost reply replays). FROM-CALLERS
    (agent/t6-2-runner-exec/DECISIONS.md D13b, D3d; packages/core/src/runner/index.ts:33-45 `waiting → done | cancelled` only). The `reject` rule, the new-attempt
    resume of a setup gate (the table has no `waiting → queued`), the 422 mapping and the output shape: YOUR-CHOICE.

D17 Fan-out (spec:675).
    (a) `planFanout(node, scope) → { ok: true, items: string[] } | { ok: false, error }` (pure): `over` a number or digit text N → items `'1'`..`'N'`; else the rendered
        text: a JSON array → its elements (strings as is, others `JSON.stringify`), otherwise one item per non-blank line (trimmed). More than `fanoutItemsMax`
        items or an item longer than `itemMax` → `{ ok: false, error: 'fanout: <n> items exceeds <max>' | 'fanout: bad items' }`. `childId(fanoutId, i) =
        '<fanoutId>[<i>]'` (i from 0) and `parseChildId`.
    (b) Starting a `fanout` node: the fanout step goes `queued → running → waiting` (bookkeeping; `options` null) with `output = { items, base, total }`
        (`base` as D14 for a child); an error from (a) or a missing repo fails the step (`failed`, then `circuit_broken`) and the run. It is derived `running`, not
        `waiting` (D13d). It stays `waiting` until (d).
    (c) Releasing children: on every `advanceRun`, while the number of children whose current attempt is `queued`, `running`, `waiting` or `quota` is below the effective
        parallel limit (D2) and a child index has no row yet, insert child `<fanoutId>[<i>]` (visit = the fanout's visit, attempt 1, `parentStepId` = the fanout step,
        `queued`) and submit it. A child whose current attempt is `failed`/`timeout`/`start_unknown` is parked and does not count against the limit. Each child is
        an agent attempt for T6.2 with its own `worktree new` from the base of (b): so N children use N worktrees and N branches. A fanout inside a child is refused by
        `parseWorkflow` (D10); `runner.fanout.max_depth` above 1 changes nothing.
    (d) The fanout is complete when every item has a child row and every child's current attempt is `done`: `waiting → done` with `output = { outcome: 'done',
        summary: '<n> children done', items, base, total, children: [{ index, stepId, branch, worktree, summary }] }` in index order, then `walkerComplete(ok)`. When a
        child's current attempt is `circuit_broken` or `cancelled` while the run is not cancelled: `waiting → cancelled` with `error: 'child <nodeId> failed'`, children
        that are queued/running/waiting/quota are cancelled through `transitionStep`, then `walkerComplete(ok: false)` and the run fails. A parked failed child leaves the
        fanout waiting (retry of the child is the T6.1 retry route).
    FROM-SPEC (spec:601, spec:675 "at most 3 running at once, each with its own worktree from the parent's branch… depth 1", spec:734 "3 children in 3 worktrees…
    depth 2 refused", spec:192). FROM-CALLERS (packages/shared/src/queues/defs.ts:28-29 `runner` concurrency; agent/t6-2-runner-exec/DECISIONS.md D12a `child` branch part).
    Not using the BullMQ Flow API (the engine releases children itself; defs.ts says Flow is not built), rows created lazily, the bookkeeping `waiting` status (the
    table has no other way to keep a row open without T6.2's sweep failing it), `[i]` ids, items `'1'..'N'`, the cap, `waiting → cancelled` for a failed child: YOUR-CHOICE.

D18 Join (job `runner.step` for `merge`; inline for `collect`, D13c).
    (a) `collect`: `queued → running → done` with `output = { outcome: 'done', summary: <JSON array text of the children's summaries>, results: [<summary>…] }` in index order.
    (b) `merge`, all in the worker through T6.2 `runGit`/`withRepo` (one git command at a time per repo): read the fanout's `output.children` and `base`; for each child
        with a worktree that still exists and has uncommitted or untracked files, make a checkpoint commit in that worktree (`git add -A`, `git commit -m "ctc: checkpoint
        <nodeId>"`; when `git config user.email` is empty in it, pass `-c user.name=ctc -c user.email=ctc@localhost`); create the join's own worktree with
        `worktreeRecipe` (stage `worktree`, `setStepFields({ worktree, branch })` before `git worktree add`, base = the fanout's `base`, else `run.baseBranch`, else `HEAD`);
        then in index order `git -C <joinWorktree> merge --no-ff -m "ctc: merge <branch>" <branch>`; a child without a branch is skipped. The first merge that stops with
        unmerged files: list them (`git diff --name-only --diff-filter=U`, sorted, at most 20), `git merge --abort`, and fail the step `merge conflict: <files>
        (branch <b>)`; any other git failure `merge failed: <first line>`. Both use `failStep failed` (retry allowed). The child branches are never touched (kept).
    (c) Success: `running → done`, `output = { outcome: 'done', summary: 'merged <n> branches', merged: [branches], branch, worktree }`; the step keeps its `branch` and
        `worktree`, so later `worktree: parent` agents and shell nodes work in the merged tree (D14).
    FROM-SPEC (spec:602, spec:676 "`merge` merges child branches in order; a conflict fails the join with the conflicting files listed, and the branches are kept.
    `collect` passes the outputs on as a list", spec:725 "join merge conflict: join fails with the file list; branches kept"). FROM-CALLERS (T6.2 `git.ts` `runGit`,
    `withRepo`; `worktreeRecipe`). The join worktree, the checkpoint commit (without it an uncommitted child merges as a silent no-op), the identity fallback, the
    abort of the merge in the join's own worktree, the 20-file cap: YOUR-CHOICE.

D19 Starting a run. `startRun(deps, ctx, { workflow, inputs, repo, base, trigger })` and `POST /api/workflows/:id/runs` `{ inputs?, repo?, base? }`
    (`Idempotency-Key` accepted, route string `'POST /api/workflows/:id/runs'`): `:id` is a capability id of kind `workflow` of the caller (else `404`); the version is the
    one served to the caller (`servedVersion`, `404` when blocked or none); the file is read like the library does (`manifestAndBody`); `parseWorkflow` (a failure is
    `422`, D4). `inputs` is an object (default `{}`, at most `inputsMaxBytes` as JSON, else `422`); `repo` and `base` follow D1d (else `422`). Then
    `repos.runner.createRun(ctx, { owner: ownerOf(ctx) ?? ctx.userId, workflowCapId, workflowVersion, status: 'running', trigger, inputs, repo, baseBranch: base,
    state: {} })` and `startedAt` set; an owner who already has a `running` run → `409 conflict` (the repo's `ConflictError`), nothing created. `trigger` is `api` for the
    route, `mcp` for the tool. Reply `202 { run_id, status: 'running' }`. After the row exists the route calls `deps.advance?.(ctx, run.id)` best effort (errors ignored); the
    worker tick starts the run otherwise. `GET /api/workflows`, `GET /api/workflows/:id`, `GET /api/runs`, `GET /api/runs/:rid` are read-only (D3c); `GET /api/runs`
    takes `limit` (1..500, default 50) and `cursor`.
    FROM-SPEC (spec:589-591 F2 capabilities pin one version, spec:614 one running per owner, spec:694-695 routes, spec:157 and 166 `Idempotency-Key`). FROM-CALLERS
    (packages/shared/src/repositories/runner.ts:63-86 `createRun`; apps/web/src/library/served.ts `servedVersion`, read.ts `manifestAndBody`; T6.1 `withIdempotency`).
    Creating the run as `running` (a second run for the owner is refused instead of queued), `ownerOf` default, input and path limits, best-effort `advance`: YOUR-CHOICE.

D20 Continue and quota. `continueRun(port, ctx, { runId }) → { run, resumed: Step[] }` (core): run not visible → `RunnerError('not_found')`; run
    `done`/`failed`/`cancelled` → `RunnerError('conflict', 'run is finished')`; `queued`/`running` → `{ run, resumed: [] }` (no-op); `quota` → every current-attempt step in `quota`
    goes `quota → queued` (`transitionStep`, patch `{ error: null }`), then the run `quota → running` (a `ConflictError` from the one-running-per-owner index → `RunnerError('conflict')` before any
    step changes: the run is moved first, the steps after); `waiting` → `RunnerError('conflict', 'run has an open gate')` when a current step is `waiting` (not a fanout row), `RunnerError(
    'conflict', 'run has a start_unknown step')` when one is `start_unknown`, else the run `waiting → running`. The route (`POST /api/runs/:rid/continue`, strict empty body,
    `Idempotency-Key` accepted) calls it and `deps.enqueueResume?.(ctx, step, jobId)` for each resumed step with `jobId = runnerJobId(...) + ':resume:' + <Idempotency-Key or a
    random token>` (the same attempt id would be ignored by BullMQ while the old job record exists); the reply is D3c (`applied` false for a no-op). Automatic resume: in `tickRuns`, a
    `quota` run whose quota steps all carry `error` `usage limit until <ISO time>` with a time at or before `now` is resumed the same way (the worker submits with `deps.submit` and the same id format; a step without a time waits for the user).
    FROM-SPEC (spec:633 "quota → queued: quota reset time reached (same attempt)", spec:697 "`continue` re-queues a `quota` or `waiting` run", spec:721 "re-queued at reset").
    FROM-CALLERS (agent/t6-2-runner-exec/DECISIONS.md D3c `usage limit until <ISO>`, D7). The `waiting` rules, the resume job id, auto-resume only with a parsed time: YOUR-CHOICE.

D21 Handoff (spec:678). MCP `run_workflow { name, inputs?, repo?, base? }` (strict args): `name` as the library MCP names (`resolveCapability`, kind must be `workflow`, else
    `not_found`); `startRun` (trigger `mcp`); then it waits up to `handoffLimits.waitMs`, polling every `pollMs`, until some step of the run has a `promptOutcome` or the
    run has left `running`. Result `{ run_id, status, prompt_outcome }`: `prompt_outcome` = the `promptOutcome` of the first agent step that has one (`delivered` |
    `not_delivered` | `unconfirmed`); `null` when no agent step has started (the workflow begins with shell, approval or a gate); `unconfirmed` when an agent step exists but
    reports nothing within the wait. `workflow_status { run_id }` (strict args) returns D3d for a run of the caller (`not_found` otherwise). Tools never throw: a failure is an
    `isError` result with the error body. FROM-SPEC (spec:678, spec:701-702, spec:654 `prompt_outcome`). FROM-CALLERS (apps/web/src/library/tools.ts:47 tool pattern;
    packages/shared/migrations/0005_runner.sql `prompt_outcome`). The bounded wait, `null` for a run without agent steps, the first-agent rule: YOUR-CHOICE.

D22 Cleanup (spec:687). `cleanupHandlers(deps)['cleanup.worktree']({ userId, runId })`: run not visible → `JobDropped('run_not_found')`; run not final, or `endedAt` newer than `keep_days`
    → `{ runId, removed: 0, kept: [], archived: 0, due: false }` (`runId` as in the payload, a string) and nothing touched. Else per step of the run, oldest first: (1) archive the logs: gzip `<stepId>.jsonl` (and
    `.out`, `.err`, `.setup.log` when present) to `<name>.gz` in the same directory, delete the original only after the gzip is complete (size > 0 and its gunzip length equals the
    original); (2) when the step has a `worktree` that exists, lies under `<run.repo>/<runner.worktree.dir>/<runId>/` and is not the repo itself: `git -C <repo> worktree remove
    <path>` WITHOUT a force flag, through `withRepo`; a refusal (dirty or locked) keeps it and adds `{ stepId, reason: 'dirty' | 'locked' | 'git: <line>' }` to `kept`; a missing path
    counts as nothing to do. Branches are never touched. Result `{ runId, removed, kept, archived, due: true }`; running it again returns `removed: 0`. `['cleanup.receipts']({})`:
    `repos.system.cleanup.pruneIdempotencyKeys(createSystemCtx('cleanup receipts'), 30)` → `{ pruned }`. `scheduleCleanup(deps)` lists `repos.system.cleanup.listFinishedRuns(sctx,
    keep_days)` and submits queue `cleanup` kind `worktree` per run with job id `cleanup:worktree:<runId>` and payload `{ userId: run.userId, runId: String(run.id) }`; resolves
    `{ submitted }`. The log route (D23) reads `.gz` when the plain file is gone.
    FROM-SPEC (spec:687 "archive the logs (jsonl.gz), `git worktree remove`, keep the branch; `cleanup.receipts` prunes `idempotency_keys` older than 30 days", spec:708 keep_days, spec:192
    queues, spec:127 run logs `.jsonl.gz`). FROM-CALLERS (packages/shared/src/repositories/system.ts:66,87; packages/shared/src/queues/payloads.ts:24-25; T6.2 `attemptPaths`).
    No force (a dirty worktree is kept and reported: an agent that did not commit would lose work), which files are archived, the `kept` reasons, who submits: YOUR-CHOICE.

D23 Log route. `GET /api/runs/:rid/steps/:sid/log`: D4 order; the step's `logPath` must be set and resolve (after `path.resolve`) to a file under `deps.runsDir`; the plain file is
    streamed; when it is gone and `<logPath>.gz` exists the route gunzips it on the fly; otherwise `404 not_found`. Never reads a path outside `runsDir`. FROM-SPEC (spec:696).
    Gunzip on the fly, the `runsDir` guard: YOUR-CHOICE.

D24 Small edits outside the module (no other change to these files): `packages/shared/src/repositories/system.ts` gains `runner.listActiveRuns(sctx): Promise<Run[]>` (runs with status
    `queued`, `running`, `waiting` or `quota` of all users, ordered by id; each row carries `userId`); `packages/shared/src/repositories/tenancy.test.ts` gains `'runner.listActiveRuns'`
    in `SYSTEM_ALLOWLIST` (sorted position) and nothing else; a new `packages/shared/src/repositories/system-runner.int.test.ts` covers the function. FROM-CALLERS
    (packages/shared/src/repositories/system.ts:56-62 the allowlisted pattern; tenancy.test.ts:10-13). Adding a system function instead of a second polling table: YOUR-CHOICE.

D25 Gate tests (Vitest, real scratch Postgres, schema `ctc_t63_<random>` dropped in `afterAll`, throwaway git repos under `os.tmpdir()`, a fake agent script registered as `claude`
    through `config.runner.agents`, an in-memory queue that runs `workflowHandlers` for every submitted job (3 at a time); every process a test starts is killed in `afterAll`):
    `apps/worker/src/runner/runner.fanout.int.test.ts`: `describe('runner.fanout')` with
      `it('runs 3 children in 3 worktrees and the join merges their branches')` (a run with trigger → fanout of 3 → join merge → shell that lists the merged files; three distinct
        worktrees and branches; the merged tree has the three files; run `done`),
      `it('refuses a fanout inside a fanout child')` (depth 2: `parseWorkflow` errors and `POST /api/workflows/:id/runs` is `422`),
      `it('fails the join with the conflicting files and keeps the branches')` (two children edit one file; join `failed` with `merge conflict: …`; all child branches still exist),
      `it('never runs more children at once than max_parallel')`;
    `apps/worker/src/runner/runner.md.int.test.ts`: `describe('runner.md')` with `it('runs the 3 sample workflows end to end within the metric thresholds')` (D26).
    FROM-SPEC (spec:734, spec:736, spec:791). The extra tests and the harness: YOUR-CHOICE.

D26 The eval `.claude/metric/eval/runner.md`. Files: `.claude/metric/eval/runner.md` (what it measures, the 3 sample workflows, thresholds, last results table), `.claude/metric/eval/runner/`
    (`implement-review.yaml`, `fanout-merge.yaml`, `loop-gate.yaml`, `fake-agent.mjs`, `run.mjs`). `run.mjs` runs the three workflows on the scratch Postgres with the fake agent in
    throwaway repos (same harness as D25), acts as the user for gates (approve the first option, never `reject`), and rewrites the "Results" table of `runner.md`. Per workflow it
    records `status`, `steps` (rows), `attempts` (rows minus nodes), `agent_steps`, `prompt_outcome` of the first agent step, `children`, `gate_wait_ms`, `wall_ms`, `cost_usd`.
    Thresholds (the gate test asserts them): all three runs end `done`; `attempts` (rows beyond the first for a `(node, visit)`) is 0 for every sample (no retry needed);
    `implement-review` has `prompt_outcome: delivered` and its review prompt contains the approval-free upstream summary; `fanout-merge` has `children: 3`, three distinct worktrees and a
    merged tree with all three files; `loop-gate` ends after exactly 3 loop visits; each run `wall_ms` under 60,000. "Metrics as today" (spec:736): the Python runner kept no
    comparable metric file, so these metrics are new (`[UNVERIFIED]` that the owner wants the same set; OPEN.md). FROM-SPEC (spec:736, spec:763). YOUR-CHOICE (the three workflows,
    the metric set, thresholds).
