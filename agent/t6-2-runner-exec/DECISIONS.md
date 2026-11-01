# Decisions for T6.2: runner cold path (worktree recipe, setup hook, agent registry, stream, report token, restart sweep)

Tags: FROM-OWNER (O#, agent/OWNER.md), FROM-SPEC (specs/007-ctc/spec.md line), FROM-CALLERS (file:line), YOUR-CHOICE (owner reviews every one, O11).
"spec" = `specs/007-ctc/spec.md`. "core" = `packages/core/src/runner` (`@ctc/core/runner`; T6.1 built `index.ts`), "worker" = `apps/worker/src/runner`,
"repos" = `createRepositories(db)` (T1.3), "step"/"run" = `repos.runner` `Step`/`Run` rows (camelCase). "T6.1 core" = the names T6.1 exports
(`transitionStep`, `advanceStage`, `failStep`, `cancelRun`, `reportStep`, `runnerJobId`, `RunnerError`, ...). "attempt dir" = `<runsDir>/<runId>/`.
"the group" = the process group whose leader is the wrapper started at spawn (D14). A tag at the end of a block covers the whole block.

D0  Purpose and callers. One `runner.step` job runs one agent attempt from `queued` to a final or parked status, so a crash, a timeout, a
    quota stop or a failure leaves a record a user can retry. Callers:
    (a) the worker main (not built yet) binds `runnerHandlers(deps)['runner.step']` into `startWorkers({ handlers })` and calls
        `sweepRunner(deps)` once at boot, BEFORE `startWorkers` (no `runner.step` job may run while the sweep decides);
    (b) `runAttempt` (apps/worker/src/jobs/consumers.ts:55-110) calls the handler with the validated `runner.step` payload
        `{userId, runId, stepId, nodeId, visit, attempt, timeoutS}` and `{jobId, attempt, signal, setProgress}`; `signal` aborts when `timeoutS`
        passed (consumers.ts:77-90, defs.ts:51-59); the return value becomes `jobs.result`;
    (c) T6.3 (walker, approve/continue, POST runs, fan-out) supplies `deps.resolveNode` (the rendered agent node) and `deps.onStepEnd` (completes
        the node), and reuses `runGroup` for shell nodes;
    (d) the agent process calls the T6.1 report route with the token this module issues.
    FROM-SPEC (spec:642-666, spec:670, spec:682-686, spec:790, spec:733). FROM-CALLERS (packages/shared/src/queues/payloads.ts:23,
    packages/shared/src/queues/defs.ts:28-29 `runner` attempts 1, maxStalledCount 0; packages/shared/src/repositories/system.ts:57-62
    `listRunningSteps`; agent/t6-1-runner-core/DECISIONS.md D0b, D7). The deps seam (`resolveNode`, `onStepEnd`) and "sweep before
    startWorkers": YOUR-CHOICE.

D1  Trust. Trusted: `deps` (config, repos, runsDir, reportBase), the payload's `userId` (the producer built it from a verified ctx).
    Untrusted: every other payload field (Redis contents), the run row's `repo`/`baseBranch`/`inputs`, the node returned by `resolveNode` (it
    comes from a workflow file and user inputs), the repo's `ctc.yaml`, every byte the agent or the setup script writes, and the content of
    files in the attempt dir. Rules:
    (a) every repos call uses `ctx = { userId: payload.userId }`; a step that this ctx cannot see is `JobDropped('step_not_found')`; the sweep
        reads the cross-user list only through `repos.system.runner.listRunningSteps(createSystemCtx('runner sweep'))` and then works on each
        step with `{ userId: row.userId }`;
    (b) no untrusted value ever reaches a shell: git and the agent start through `execFile`/`spawn` with an argv array; the only `sh -c` are
        the fixed wrapper (D14, whose script text is a constant and takes the exit-record path and the argv as positional parameters) and the
        repo's own setup script (D13), run only under the setup policy;
    (c) the agent and the setup script get the worker's environment WITHOUT any variable whose name starts with `CTC_`, plus only the
        variables D13/D14 name (so the worker's `CTC_DATABASE_URL`, `CTC_REDIS_URL`, ... never reach repo code or an agent);
    (d) the step token exists only in the agent's environment and in worker memory; `wf_steps.token_hash` holds `sha256(token)` as lowercase hex.
    Prevents: one user's job touching another's steps, argument or shell injection from workflow text, leaking ctc's own secrets to repo code,
    a forged report. FROM-SPEC (spec:138-140, spec:670 "only `sha256(token)` is stored", spec:603 bypassPermissions never). FROM-CALLERS
    (packages/shared/src/repositories/system.ts:57-62, apps/web/src/runs/index.ts:114-120 compares `sha256(token)` hex). The env scrub and the
    two allowed `sh -c`: YOUR-CHOICE.

D2  Limits. Core exports `runnerExecLimits` (one object, read at call time so a test can change and restore it):
      killGraceMs 5000 (SIGTERM to the group, then SIGKILL), tailPollMs 250 (log and exit-record poll), statusPollMs 2000 (re-read of the step
      while following), reportExitGraceMs 30000 (after a report ended the step, wait this long for the exit, then kill the group),
      quotaExitGraceMs 10000 (after quota, the same), exitRecordGraceMs 500 (after the leader is gone, look once more for the exit record),
      pidStartToleranceMs 1000 (a live pid matches `pidStartedAt` when the two start times differ by at most this, inclusive),
      summaryMax 20000 (UTF-16 units of a summary or last message; longer is cut, not rejected), errorMax 2000 (step `error` text, cut),
      gitTimeoutMs 30000 (every git command except `worktree add`), defaultTimeoutS 1800 (a reattached step whose node cannot be resolved).
    From `deps.config.runner`, read at every call: `worktree.add_timeout_s` (180), `worktree.dir` ('.ctc/wt'), `setup.timeout_s` (120),
    `setup.max_output_mb` (10; the cap is `max_output_mb * 1024 * 1024` bytes, inclusive: exactly the cap is fine, one byte more is overflow),
    `setup.policy` ('run'), `agents` (`{claude: {argv}, codex: {argv}}`), `max_failures` (3, passed to `failStep`).
    FROM-SPEC (spec:647 180 s, spec:651 120 s / 10 MB, spec:596 timeout_s default 1,800, spec:708-712) FROM-CALLERS
    (packages/shared/src/env/schema.ts:70-75, 150-174; apps/web/src/runs/index.ts `runsLimits.summaryMax` 20000, `reasonMax` 2000). All
    `runnerExecLimits` numbers: YOUR-CHOICE (chosen by judgment).

D3  Output and error format.
    (a) The handler resolves `{ stepId: number, status: string, skipped: boolean }` (`status` = the step's status when the handler ends; `skipped`
        true only for D4c). It rejects only with `JobDropped` (D4a/b) or a repository error that is not a status race; every attempt failure is a
        step status, not a rejection.
    (b) `sweepRunner(deps)` resolves `{ actions: Array<{ stepId: number, action: 'fail_stage' | 'finish' | 'reattach' | 'start_unknown' |
        'skipped' }>, settled: Promise<void> }`, one entry per running step listed, in list order; `settled` resolves when every reattached
        attempt has ended (never rejects; errors are logged).
    (c) Step `error` texts, exact (then cut to `errorMax`):
        `node not found` | `spawn refused: <reason>` (D10) | `spawn failed: <errno code or class name>` |
        `worktree failed: <first non-empty line of git's stderr, or the exit code>` | `worktree timed out after <add_timeout_s> s` |
        `setup failed: exit <n>` | `setup timed out after <timeout_s> s` | `setup output over <max_output_mb> MB` | `setup config invalid` |
        `exit <n>` or `exit <n>: <last non-empty stderr line>` (agent, D16) | `timeout after <timeoutS> s` (D17) |
        `usage limit` or `usage limit until <ISO time>` (D15) | `interrupted at stage <stage>` / `interrupted before stage worktree` (D18).
    (d) `output` written by this module: `{ outcome: 'done' | 'failed', summary: string | null }` plus, when the attempt had a worktree,
        `diffStat: string | null` (D16). Waiting for setup approval: `options = [{id: 'run', label: 'Run setup'}, {id: 'skip', label: 'Skip setup'}]`.
    (e) Log lines (`deps.log(message, fields)`) carry ids, stage names, status names, exit codes and error class names only.
    FROM-CALLERS (apps/worker/src/jobs/consumers.ts:93 result → `markDone`; packages/shared/src/queues/submit.ts:44-52 `JobDropped`;
    agent/t6-1-runner-core/DECISIONS.md D15 `output = {outcome, summary}`). Every text and shape: YOUR-CHOICE.

D4  Bad input. Order, first problem wins:
    (a) `getStep(ctx, Number(payload.stepId))` is null → `JobDropped('step_not_found')`, nothing written;
    (b) the step's `runId`, `nodeId`, `visit`, `attempt` differ from the payload's (`String(step.runId) !== payload.runId`, ...) →
        `JobDropped('payload_mismatch')`, nothing written;
    (c) the step is not `queued` (a repeat of the job, a cancelled or already-running attempt) → `{ skipped: true }`, nothing written, nothing
        spawned; a lost claim race (`ConflictError` from the `queued → running` transition) is the same;
    (d) claim (`transitionStep queued → running`, patch `{ startedAt: now }`); then `getRun` + `deps.resolveNode(ctx, run, step)`: null or a
        throw → `failStep(failed, 'node not found')`;
    (e) the stages refuse what they cannot run safely, each as a failed attempt at that stage with the D3c text: an unknown agent, a permission
        outside the three, a bad model, a banned flag in the configured argv (D10); `run.repo` not an absolute path to a git work tree, or
        `worktree: parent` without `parentWorktree` (D12); a `ctc.yaml` whose `setup` is neither a string nor an array of strings (D13).
    FROM-CALLERS (packages/shared/src/queues/submit.ts:44-52 `JobDropped` ends the job without retry; consumers.ts:63-71 payload already
    shape-checked). Order and which cases drop vs fail: YOUR-CHOICE.

D5  Odd but harmless input stays valid:
    no `ctc.yaml`, or one without `setup` (no setup stage is written); `setup: []` or only blank strings (same); `worktree: none` (cwd =
    `run.repo`, `worktree`/`branch` stay null, no setup); `worktree: parent` (cwd = `parentWorktree`, no new branch, no setup); stream lines
    that are not JSON, JSON that is not an object, unknown event types, a last line without a newline (all ignored, never an error); an agent
    that writes nothing and exits 0 (done, `summary: null`, `promptOutcome: 'not_delivered'`); a report that arrives before the exit (D16b);
    the same job delivered twice (D4c: one spawn); `model` absent or null; `resolution` absent. judgment: tolerant by default (D8).
    YOUR-CHOICE.

D6  Must never:
    (a) write `wf_steps.status` except through T6.1 core (`transitionStep`, `failStep`, `advanceStage` for stages): no call of
        `repos.runner.transition(` or `setRunStatus(` from worker step code except the one run-status helper of D20, and `setStepFields` never
        gets `status`;
    (b) kill on absence: a quiet agent is never killed or failed for being quiet (only `timeoutS`, cancel, quota, a report, or the exit end
        it); a pid is signalled only while its start time matches `pidStartedAt` (D19);
    (c) put the token in the database, a log line, argv, the prompt/preamble, the log file or the handler result;
    (d) run git with `--force`, `-f`, `-B`, `-D`, `branch -d`, `worktree remove`, `reset`, `clean`, `push` or `checkout` of an existing branch;
        never delete or overwrite a branch, a worktree or a repo file (the only repo write besides `worktree add` and `config branch.<b>.base` is
        the `.git/info/exclude` line of D12d);
    (e) pass `bypassPermissions`, `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions` or
        `--dangerously-bypass-approvals-and-sandbox` to an agent (D10);
    (f) read or write `~/.claude`, the network (the agent does its own), Redis, or another user's rows; core keeps no I/O at all
        (no `node:*` import, `@ctc/shared` only as `import type`);
    (g) throw out of the handler for an attempt failure (D3a), leave a group it started running after the handler ended (except a reattach
        handed to the sweep, D18, and a live agent after a worker crash, which is the point), or edit its argument objects.
    FROM-SPEC (spec:603 "`bypassPermissions` is never allowed", spec:622, spec:670, spec:686 "Never act on absence", spec:687 "keep the
    branch", spec:99 core pure) FROM-OWNER (O12 never write `~/.claude`). The git list and the kill rule details: YOUR-CHOICE.

D7  Non-goals (who does it instead): the walker, templating `{{input.x}}`/`{{node.out}}`, the `git push`/`gh pr` approval rule, shell/if/merge/
    approval/fanout/join nodes, run status "follows its steps" (T6.3; this module writes the run status only in D20); resuming a step parked by
    setup `ask` or by `quota`, and re-queueing at the quota reset (T6.3 `continue` and its scheduler); `git worktree remove`, log archiving
    (jsonl.gz), deleting attempt dirs (T6.3 `cleanup.worktree`); issuing the BullMQ job (`submitJob`/`enqueueStep`, T6.3); the report route
    itself (T6.1); resolving the user from the token in shared mode (OPEN.md); the worker main and config loading (later wiring); a per-repo
    setup policy map (only the global `runner.setup.policy`); usage-based pricing for codex (`costUsd` stays null); quota detection through
    `isUsingOverage`. FROM-SPEC (spec:787-791 task split, spec:687) FROM-OWNER (O12). The split: YOUR-CHOICE.

D8  Silence rule. Where this list says nothing, choose the more tolerant, less destructive behaviour (a parked or `start_unknown` step over a
    failed one; keep a branch, worktree, file or process over removing it; no write over a guessed write) and add a comment starting
    `judgment:`. FROM-OWNER (O11).

D9  Layout and public names (TypeScript strict, Node type stripping, no build, no new dependency, no `package.json` or lockfile change):
    core: new file(s) in `packages/core/src/runner/` (e.g. `exec.ts`), re-exported from `index.ts` by added `export … from` lines only (the T6.1
      code in `index.ts` stays as it is). Exports: `AGENTS` (`['claude', 'codex']`), `PERMISSIONS` (`['acceptEdits', 'dontAsk', 'plan']`),
      `runnerExecLimits`, `agentArgv`, `emptyStream`, `readStreamLine`, `worktreeRecipe`, `parseRepoSetup`, `buildPreamble`, `sweepAction`,
      `exitOutcome`, types `StreamState`, `AgentNode`. Pure: no `node:*`, `@ctc/shared` only as `import type`; `yaml` (already a core
      dependency) is allowed.
    worker: `apps/worker/src/runner/index.ts` exports `runnerHandlers(deps: RunnerExecDeps): { 'runner.step': Handler }`,
      `sweepRunner(deps)`, `runGroup(o)`, `procStartTime(pid)`, type `RunnerExecDeps`.
      `type AgentNode = { agent: string; prompt: string; worktree: 'new' | 'parent' | 'none'; permission: string; model?: string | null;
        timeoutS: number; workflow: string; child?: string | number | null; base?: string | null; parentWorktree?: string | null;
        resolution?: string | null; setupDecision?: 'run' | 'skip' | null }` (rendered by T6.3; `child` = fan-out child index or key).
      `type RunnerExecDeps = { repos: Repositories; config: { runner: { max_failures: number; worktree: { add_timeout_s: number; dir: string };
        setup: { timeout_s: number; max_output_mb: number; policy: 'run' | 'ask' | 'skip' }; agents: Record<string, { argv: string[] }> } };
        runsDir: string /* absolute */; reportBase: string /* e.g. 'http://127.0.0.1:18410' */;
        resolveNode(ctx: Ctx, run: Run, step: Step): Promise<AgentNode | null>; onStepEnd?(ctx: Ctx, step: Step): Promise<void>;
        log?(message: string, fields?: Record<string, unknown>): void }` (a full `Config` from `@ctc/shared/env` satisfies `config`).
      `runGroup(o: { cmd: string[]; cwd: string; env: Record<string, string>; timeoutMs: number; maxOutputBytes: number; outFile: string;
        signal?: AbortSignal; onStart?(pid: number): void | Promise<void> }): Promise<{ code: number | null; timedOut: boolean;
        overflow: boolean; aborted: boolean }>` runs `cmd` (argv, no shell) as the leader of a new process group, stdout+stderr piped into
        `outFile` up to `maxOutputBytes` bytes (the file never holds more), and on timeout, overflow or abort kills the group (D19).
      `procStartTime(pid: number): Promise<Date | null>`: the start time of a live, non-zombie process from `/proc/<pid>/stat` (field 22) and
        `/proc/stat` `btime`; null when the process does not exist, is a zombie, or `/proc` is unreadable.
    FROM-SPEC (spec:97 `packages/core/runner` = "worktree recipe, agent registry", spec:99 core pure, spec:89 `apps/worker` runs `runner`)
    FROM-CALLERS (packages/core/package.json exports `./*`, dependency `yaml`; apps/worker/src/jobs/consumers.ts:11-14 `Handler`;
    apps/worker/src/memory/index.ts:27-45 the `xxxHandlers(deps)` pattern; agent/t6-1-runner-core/DECISIONS.md D9 core purity). Names, file
    split and the deps shape: YOUR-CHOICE.

D10 Agent registry. `agentArgv(agent, base, { permission, model? })` returns a NEW array (never edits `base`):
      claude: `[...base, '--verbose' (only when base lacks it), '--permission-mode', permission, ...(model ? ['--model', model] : [])]`;
      codex:  `[...base, '--sandbox', permission === 'plan' ? 'read-only' : 'workspace-write', ...(model ? ['--model', model] : [])]`.
    `base` = `deps.config.runner.agents[agent].argv`. Throws `TypeError` whose message is the D3c `<reason>`: `unknown agent <name>` (not in
    `AGENTS` or not configured), `permission <p> not allowed` (anything outside `PERMISSIONS`, `bypassPermissions` included),
    `model not allowed` (model not matching `^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,99}$`), `banned flag <flag>` (base contains one of D6e).
    The prompt (preamble + node prompt) goes to the agent on stdin, never in argv (both CLIs read the prompt from stdin when argv has none).
    FROM-SPEC (spec:658-659 commands, spec:596 permission values, spec:603, spec:806 D6 `claude` and `codex`) FROM-CALLERS
    (packages/shared/src/env/schema.ts:70-75 default argv `['claude','-p','--output-format','stream-json']`, `['codex','exec','--json']`).
    `--verbose` (claude's `-p` refuses `stream-json` without it), the codex sandbox mapping, the model pattern, stdin: YOUR-CHOICE.

D11 Stream reading. `emptyStream()` = `{ events: 0, lastMessage: null, usage: null, costUsd: null, quota: null, error: null }`.
    `readStreamLine(agent, state, line)` is pure, never throws, never edits `state`, returns a new state. A line that is not a JSON object
    returns `state` unchanged (same value is fine). Every JSON object line adds 1 to `events`. Then, by agent:
    claude: `{type:'assistant', message:{content:[...]}}` → `lastMessage` = the joined `text` of its `{type:'text'}` parts (when non-empty);
      `{type:'result', result, usage, total_cost_usd, is_error}` → `lastMessage = result` (when a string), `usage = usage` (when an object),
      `costUsd = total_cost_usd` (when a finite number); `{type:'rate_limit_event', rate_limit_info:{status:'rejected', resetsAt?}}` →
      `quota = { resetsAt }` (`resetsAt` epoch seconds → ISO string, else null); a `result` with `is_error: true` whose text matches
      `/usage limit|hit your (\w+ )?limit/i` → `quota = { resetsAt: null }` (unless already set).
    codex (`codex exec --json`): `{type:'item.completed', item:{type:'agent_message', text}}` → `lastMessage = text`;
      `{type:'turn.completed', usage}` → `usage = usage` (the last one); `{type:'error', message}` and `{type:'turn.failed', error:{message}}` →
      `error = message`; either message matching the same usage-limit pattern → `quota = { resetsAt: null }`. `costUsd` stays null.
    `lastMessage` and `error` are cut to `summaryMax` / `errorMax`. Shapes verified for codex-cli 0.114.0 on 2026-10-31: the envelope
    `{type}`, `thread.started {thread_id}`, `turn.started`, `error {message}`, `turn.failed {error:{message}}`, exit code 1 on failure.
    Event names `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.started`, `item.updated`, `item.completed`, `error` and the
    keys `thread_id`, `usage`, `input_tokens`, `cached_input_tokens` are present as strings in the codex 0.164.0 binary (grep -a, 2026-10-31).
    NOT verified (no valid codex login on this machine, so no real run): the item type `agent_message` with `text` inside `item.completed`, and
    the exact keys inside `usage` (taken from the codex exec JSON docs; OPEN.md). The reader keeps `usage` as the object it finds.
    FROM-SPEC (spec:654 "first stream event", spec:661 usage, cost_usd, usage-limit → quota, spec:664 "last message", spec:817 open item)
    FROM-CALLERS (packages/shared/migrations/0005_runner.sql:47-48 `usage jsonb`, `cost_usd real`). Field mapping, the pattern, codex shapes:
    YOUR-CHOICE.

D12 Worktree recipe (stage `worktree`, only for `worktree: 'new'`).
    (a) `worktreeRecipe({ repo, dir, workflow, runId, nodeId, stepId, visit, attempt, child?, base })` (pure) returns
        `{ branch, path, add, config }`: `branch = 'ctc/' + [workflow, runId, nodeId, child?].map(clean).join('-') + (visit > 1 ? '-v' + visit : '')
        + (attempt > 1 ? '-a' + attempt : '')`, where `clean` replaces every run of characters outside `[A-Za-z0-9_-]` with one `-`, trims `-`
        at both ends, cuts to 60 characters and gives `x` when empty; `path = repo + '/' + dir + '/' + runId + '/' + stepId` (normalized
        `/`s); `add = ['worktree', 'add', '--no-track', '-b', branch, path, base]`; `config = ['config', 'branch.' + branch + '.base', base]`.
        Throws `TypeError` when `repo` is not absolute, `dir` is absolute or has a `..` segment, or `base` is empty or starts with `-`.
    (b) The handler: base = `node.base ?? run.baseBranch ?? 'HEAD'`; checks `git -C <repo> rev-parse --is-inside-work-tree` (else
        `worktree failed: not a git repository`); writes `advanceStage('worktree')`, then `setStepFields({ worktree: path, branch })`, BEFORE
        running `git -C <repo> <add>` (timeout `add_timeout_s`, group kill), then `git -C <repo> <config>`. An existing branch or path makes git
        fail → `worktree failed: <git's first stderr line>`; nothing is forced, the existing branch keeps its commit.
    (c) Every git command of one repo (rev-parse, show, worktree add, config, diff, info/exclude edit) runs one at a time per real repo path
        (an in-process queue keyed by `realpath(repo)`); different repos run in parallel.
    (d) Before the first `worktree add` into a repo, the line `/<first segment of dir>/` is appended to `<git common dir>/info/exclude` when no
        line equals it (so the main checkout does not list the worktrees as untracked); never written twice.
    `worktree: 'parent'`: `setStepFields({ worktree: node.parentWorktree })`, no branch, no git write. `worktree: 'none'`: nothing.
    FROM-SPEC (spec:646-649, spec:601 fan-out child, spec:687 branch kept, spec:113 worktree path) FROM-CALLERS (packages/shared/src/env/
    schema.ts:151-155). `-v<visit>`/`-a<attempt>` suffixes (without them a retry or a loop collides with the kept branch), the `clean` rule,
    base fallback, info/exclude: YOUR-CHOICE.

D13 Setup hook (stage `setup`, only for `worktree: 'new'`).
    (a) Read before any git write: `git -C <repo> show <base>:ctc.yaml` (missing file → no setup). `parseRepoSetup(text)` (pure) returns
        `{ setup: string[] }` (`setup: "<script>"` → one entry; an array of strings → in order; missing/null → `[]`; blank entries dropped);
        invalid YAML or another `setup` type → throws `TypeError` → `setup config invalid` (the attempt fails before the worktree).
    (b) Policy `deps.config.runner.setup.policy`: `skip` → no setup; `run` → run; `ask` → `node.setupDecision` decides (`run`/`skip`); with no
        decision the step goes `running → waiting` with the D3d `options` and the run goes `waiting` (D20), BEFORE any git write and without
        writing stage `setup`; the handler ends (resume: T6.3). No setup entries → policy is not consulted.
    (c) Run: `advanceStage('setup')` first; each entry runs as `runGroup({ cmd: ['/bin/sh', '-c', entry], cwd: worktree, env, ... })` in order,
        all entries sharing one budget of `setup.timeout_s` and one output cap of `max_output_mb`, output appended to
        `<attempt dir>/<stepId>.setup.log`; `env` = scrubbed worker env (D1c) + `CTC_ROOT_PATH=<repo>`, `CTC_WORKTREE_PATH=<worktree>`. The
        group leader's `pid` and `pidStartedAt` are written with `setStepFields` when it starts (so the sweep can stop an orphan, D18).
        Exit ≠ 0 → `setup failed: exit <n>` (later entries do not run); timeout → `setup timed out after <s> s`; overflow → `setup output over
        <mb> MB`; each is `failStep(failed)` at stage `setup` (retry allowed).
    FROM-SPEC (spec:650-653, spec:630 "the worktree/setup stage failed", spec:720) FROM-CALLERS (packages/shared/src/env/schema.ts:156-160).
    Reading `ctc.yaml` from `<base>` (Orca refuses `ask` before any git work, specs/006-merged-core/research/orca.md:101), the string/array
    forms, one shared budget, the ask parking: YOUR-CHOICE.

D14 Spawn and report token (stage `spawn`).
    (a) Order: build argv (D10; a `TypeError` → `spawn refused: <reason>`, no stage write) → `advanceStage('spawn')` → token = 32 random bytes
        as 64 lowercase hex chars → `setStepFields({ tokenHash: sha256hex(token), logPath, pid: null, pidStartedAt: null })` → write the prompt
        file → start the wrapper → `setStepFields({ pid, pidStartedAt: await procStartTime(pid) })` → `advanceStage('stream')`.
    (b) Files in the attempt dir (dir mode 0700, files 0600): `<stepId>.prompt` (preamble + prompt; kept), `<stepId>.jsonl` (the agent's
        stdout = the log, `logPath`), `<stepId>.err` (stderr), `<stepId>.exit` (the exit record: the decimal exit status, written by the
        wrapper to `<stepId>.exit.tmp` and renamed, so a reader sees all or nothing).
    (c) The wrapper is `/bin/sh -c <constant script> ctc-step <exit record path> <argv...>`, started `detached` (new session and process group,
        leader = wrapper, `pid` = its pid), stdin = the prompt file, stdout = the log, stderr = the err file, `unref()`ed, so the agent and the
        exit record survive the worker. cwd = the worktree (`new`/`parent`) or `run.repo` (`none`).
    (d) Env = scrubbed worker env (D1c) + `CTC_STEP_TOKEN=<token>`, `CTC_REPORT_URL=<reportBase>/api/runs/<runId>/steps/<stepId>/report`,
        `CTC_RUN_ID`, `CTC_STEP_ID`, and for `new`/`parent` also `CTC_ROOT_PATH`, `CTC_WORKTREE_PATH`. A new token per attempt.
    (e) `buildPreamble({ workflow, nodeId, attempt, prompt, resolution? })` (pure) returns text that contains: the node prompt verbatim, the
        resolution when given, and how to report: a `curl` POST to `"$CTC_REPORT_URL"` with header `X-CTC-Step-Token: $CTC_STEP_TOKEN` and a
        JSON body `{"outcome":"done"|"failed","summary":"..."}`, plus "exiting without a report counts as done with your last message as the
        summary". It never contains a token value. Exact wording: the coder's.
    (f) A spawn error of the wrapper itself (`ENOENT` for a missing cwd, `EACCES`) → `spawn failed: <code>` at stage `spawn`. A missing or
        unrunnable agent binary is not a spawn error (the shell exits 127 or 126): it ends as D16 (`exit 127: <stderr line>`). judgment: no
        PATH look-up before the spawn.
    FROM-SPEC (spec:654 preamble "step goal, gate resolution if any, how to report", "Store `pid` and `pid_started_at`", spec:670 32-byte
    token in env, sha256 stored, spec:697-699 report route) FROM-CALLERS (apps/web/src/runs/index.ts:227 header `x-ctc-step-token`;
    agent/t6-1-runner-core/DECISIONS.md D15 body `{outcome, summary}`). Wrapper, file names, env names other than `CTC_STEP_TOKEN`, stdin:
    YOUR-CHOICE.

D15 Following an attempt (stage `stream`; the same code serves the handler and a reattach, D18).
    (a) Every `tailPollMs`: read new bytes of the log, feed each complete line to `readStreamLine` (an incomplete last line waits); when
        `events` first becomes > 0 → `setStepFields({ promptOutcome: 'delivered' })`; when `usage`/`costUsd` changed → `setStepFields({ usage,
        costUsd })` (at most once per `statusPollMs`, and once at the end).
    (b) Every `statusPollMs`: re-read the step. `cancelled` → kill the group now (D19) and end; any other non-`running` status (a report ended
        it, D16b) → wait up to `reportExitGraceMs` for the exit record, then kill the group; then end (no status write).
    (c) Quota (`state.quota` set while the step is `running`): `transitionStep(running → quota, patch { error: 'usage limit' or 'usage limit
        until <resetsAt>', usage, costUsd })`, run → `quota` (D20), wait up to `quotaExitGraceMs` for the exit, then kill the group; end.
    (d) The end of the process: the exit record appears → D16. The leader is gone (`procStartTime(pid)` null or not matching) and still no
        exit record after `exitRecordGraceMs` → `transitionStep(running → start_unknown, patch { liveness: 'start_unknown' })` + run → `waiting`
        (D20). judgment: the record is missing, so the outcome is unknown; the user decides (retry or mark failed).
    FROM-SPEC (spec:654 delivered, spec:661 stream, spec:633 quota, spec:721 "step and run go to `quota`", spec:636 cancel,
    spec:662-664 whichever comes first) FROM-CALLERS (agent/t6-1-runner-core/DECISIONS.md D7, D17 "T6.2 stops on its next transition
    conflict"). Polling (not file watching), the grace periods, start_unknown for a vanished leader: YOUR-CHOICE.

D16 End of an attempt (process exit; stage `report`).
    (a) `exitOutcome({ exitCode, stream, stderrTail? })` (pure): exit 0 → `{ to: 'done', output: { outcome: 'done', summary: stream.lastMessage
        (cut to summaryMax) }, error: null }`; exit ≠ 0 → `{ to: 'failed', output: { outcome: 'failed', summary: lastMessage }, error: 'exit <n>'
        or 'exit <n>: <last non-empty line of stderrTail>' }` (cut to errorMax).
    (b) Step still `running`: done → `transitionStep(running → done, patch { stage: 'report', output, usage, costUsd, endedAt: now,
        promptOutcome: events > 0 ? 'delivered' : 'not_delivered' })`; failed → `failStep({ to: 'failed', error, patch: { stage: 'report', output,
        usage, costUsd, promptOutcome }, maxFailures: config.runner.max_failures })` (which may break the circuit, T6.1 D14). Step no longer
        `running` (the agent reported first, or a cancel won): no status write and no change to `output.outcome`/`summary`; only
        `setStepFields({ usage, costUsd })`. A `ConflictError` from the transition is treated as "no longer running".
    (c) When the attempt had a worktree: `git -C <worktree> diff --shortstat <base>` (tracked changes vs the base, timeout `gitTimeoutMs`) →
        `output.diffStat` = its trimmed text, or `''` for no change, or null when git failed; merged into the step's current `output` object with
        `setStepFields` (only when `output` is an object).
    (d) Then `deps.onStepEnd?.(ctx, finalStep)` once per handler run that changed or ended the step (never for D4a-c); a throw is logged and
        swallowed.
    FROM-SPEC (spec:662-666 "whichever comes first", "exit 0 without a report counts as done with the last message as summary", "store
    `output` and the diff stat, and let the walker complete the node", spec:630) FROM-CALLERS (agent/t6-1-runner-core/DECISIONS.md D14-D15;
    packages/core/src/runner/index.ts `failStep`). Report precedence, the diffStat form, `onStepEnd`: YOUR-CHOICE.

D17 Timeout. The whole attempt (all stages) is bounded by the payload's `timeoutS`: `runAttempt` aborts `jobCtx.signal` then. On abort the
    handler kills the running group (git, setup or agent) (D19) and, when the step is still `running`, `failStep({ to: 'timeout', error:
    'timeout after <timeoutS> s' })`; then it resolves (D3a). The worktree and setup stages also have their own limits (D12b, D13c), which fail
    the attempt as `failed`, not `timeout`. A reattached attempt (D18) enforces the same: deadline = `step.startedAt + node.timeoutS` (or
    `defaultTimeoutS` when `resolveNode` gives null). FROM-SPEC (spec:631 "`timeout_s` passed; process group killed", spec:596 default 1,800)
    FROM-CALLERS (apps/worker/src/jobs/consumers.ts:77-90; packages/shared/src/queues/defs.ts:51-59 `timeoutMs('runner', 'step', payload)`).
    One budget for all stages via the existing signal: YOUR-CHOICE.

D18 Restart sweep. `sweepRunner(deps)` lists every `running` step of every user once and, per step, takes `sweepAction(step, probe)` (pure)
    where `probe = { exitCode: <the exit record as a number, or null>, startedAt: await procStartTime(step.pid) when step.pid else null }`:
      stage null, `worktree` or `setup` → `fail_stage`; else an exit record → `finish`; else `pid`, `pidStartedAt` and `probe.startedAt` all set
      and `|probe.startedAt - pidStartedAt| <= pidStartToleranceMs` → `reattach`; else → `start_unknown`.
    Effects: `fail_stage` → when stage is `setup` and its group leader still matches (`pid`/`pidStartedAt`), kill that group (D19); then
      `failStep({ to: 'failed', error: 'interrupted at stage <stage>' | 'interrupted before stage worktree' })`;
    `finish` → parse the whole log (agent from `resolveNode`; null node → no summary, no usage) and apply D16 (no diffStat when the node is
      unknown); `reattach` → follow it (D15, D16, D17 deadline) in the background, counted in `settled`; `start_unknown` →
      `transitionStep(running → start_unknown, patch { liveness: 'start_unknown', promptOutcome: events > 0 ? 'delivered' : 'unconfirmed' })` +
      run → `waiting` (D20). Nothing is killed on `start_unknown` (a pid whose start time does not match is not ours). A step another writer
      moved meanwhile (`ConflictError`) is `skipped`. Each step's error is logged and does not stop the sweep.
    FROM-SPEC (spec:682-686, spec:632 "no live pid and no exit record", spec:722, spec:733) FROM-CALLERS (packages/shared/src/repositories/
    system.ts:57-62; agent/t6-1-runner-core/OPEN.md C "T6.1 treats `start_unknown` as a status ... leaves the liveness column to T6.2").
    `finish` on an exit record, stage null as interrupted, killing an orphan setup, `promptOutcome` values: YOUR-CHOICE.

D19 Killing a group. `kill(-pid, 'SIGTERM')`, then after `killGraceMs`, if any member is left, `kill(-pid, 'SIGKILL')`. Only for a group this
    process started in this handler run, or a recorded `pid` whose `procStartTime` still matches `pidStartedAt` (D18). `ESRCH` is not an error.
    `runGroup` resolves only after its group leader exited (or was killed). FROM-SPEC (spec:631, spec:651 "process-group kill", spec:686).
    The TERM → KILL escalation: YOUR-CHOICE.

D20 Run status writes. This module changes `wf_runs.status` only to `waiting` (step → `start_unknown`, D15d/D18; step → `waiting` for setup
    `ask`, D13b) and to `quota` (D15c), each from the run's current status and only when that is `queued`, `running`, `waiting` or `quota`
    (a `done`/`failed`/`cancelled` run is never changed), through `repos.runner.setRunStatus` with one re-read on `ConflictError`. A done or
    failed attempt leaves the run as it is (the walker, T6.3; the circuit break inside `failStep` is T6.1's). FROM-SPEC (spec:684 "run
    `waiting`", spec:721 "step and run go to `quota`", spec:640 "The run status follows its steps") FROM-CALLERS (packages/core/src/runner/
    index.ts `failRun` pattern). The guard list: YOUR-CHOICE.

D21 Gate tests (Vitest, real scratch Postgres, schema `ctc_t62_<random>` dropped in `afterAll`, a throwaway git repo under `os.tmpdir()`, a fake
    agent script registered as `claude` through `config.runner.agents`; every process a test starts is killed in `afterAll`):
    `apps/worker/src/runner/runner.crash.int.test.ts`: `describe('runner.crash')` with
      `it('reattaches to a live agent after the worker is killed mid-step')` (the handler runs in a child Node process; the test SIGKILLs that
        process once the step is at stage `stream` with a `pid`, then runs `sweepRunner`: action `reattach`, and after the fake agent exits 0
        the step is `done` with the agent's last message as `output.summary`),
      `it('marks the step start_unknown when the agent died with the worker')` (same, but the agent's group is SIGKILLed too and no exit record
        exists: action `start_unknown`, step `start_unknown` with `liveness: 'start_unknown'`, run `waiting`),
      `it('fails an attempt interrupted in the worktree or setup stage')` (a `running` step at stage `setup` with no live pid: action
        `fail_stage`, step `failed` with `error: 'interrupted at stage setup'`).
    FROM-SPEC (spec:733 `runner.crash`, spec:790, spec:685). The third test and the child-process method: YOUR-CHOICE.
