# Decisions for T7.1: switch over (hooks in `.claude/settings.json`, the two process mains, migration 0006, every spec §7 gate on a dev instance)

Tags: FROM-OWNER (O#, agent/OWNER.md), FROM-SPEC (specs/007-ctc/spec.md line), FROM-CALLERS (file:line), YOUR-CHOICE (owner reviews every one, O11).
"spec" = `specs/007-ctc/spec.md`. "web" = `apps/web/src/server/` (new), "worker" = `apps/worker/src/boot/` (new). "dev instance" = `ctc-web` + `ctc-worker` started with
`CTC_HOME=$PWD/.ctc-dev`, `CTC_PORT=18410`. "scratch" = Postgres `127.0.0.1:18304`, Redis `127.0.0.1:18395`. "hook commands" = the six `command` strings of D3.
A tag at the end of a block of indented lines covers the whole block.

D0  Purpose and callers. T7.1 makes the new stack runnable and switches the repo's Claude Code hooks to it. Four parts:
    (a) `.claude/settings.json` gets the six hook commands (D3, D4) next to the two graphify groups that are already there;
    (b) the two process mains the units name (`deploy/systemd/ctc-web.service`: `ctc-web`; `ctc-worker.service`: `ctc-worker`): `apps/web/src/server/main.ts` mounts every
        Route/McpTool the earlier tasks built on Fastify + `/mcp`, `apps/worker/src/boot/main.ts` binds every handler into `startWorkers` (D8-D16);
    (c) migration `0006` adds the two epoch columns the repositories already read (D17);
    (d) a runner that executes every spec §7 gate against the dev instance's environment and records the result (D19, D20, D22).
    Callers: Claude Code (the hook commands), a human or systemd (`ctc-web`, `ctc-worker`), CI (`scripts/check.sh`), the final PR reviewer (`.claude/metric/eval/switch.md`).
    Why a bootstrap is in this task: spec §8 has no task that builds it, yet 14 earlier SPEC.md files say "the ctc-web bootstrap (built later)" and
    "the worker main (built later)"; T7.1 is the first task whose Done ("all §7 gates" on a dev instance) cannot be met without them. No Fastify, no MCP SDK and no main exists at HEAD.
    FROM-SPEC (spec:80-91, spec:102-108, spec:792, spec:750-762). FROM-CALLERS (apps/web/src/spool/index.ts:3 and :376, apps/web/src/pre/index.ts:3-7,
    apps/worker/src/runner/index.ts:3, apps/worker/src/context/index.ts:3-5, apps/worker/src/jobs/index.ts:3, deploy/systemd/*.service ExecStart).
    Putting the bootstrap in T7.1 rather than inventing a task before it: YOUR-CHOICE.

D1  Trust. Untrusted: every hook body (any bytes, up to the body limit), every route param/query/body/header, every MCP argument, the `cwd` and `session_id` inside hook JSON,
    every env value read by the mains (`CTC_*`), every file name and byte in the spool dir. Trusted: `.claude/settings.json` in this repository (it is code reviewed in the PR), `config/*.yaml`.
    Never trusted for identity: a body or header never sets `userId` (spec:138-143); local mode is always `{userId: 'local'}`.
    Failure prevented: a hook that errors or hangs makes Claude Code slow or noisy (spec:166); a body that picks the user reads another user's rows.
    FROM-SPEC (spec:138-143, spec:164, spec:213).

D2  Scope. The coder may add or change only these paths:
    - `apps/web/src/server/` and `apps/worker/src/boot/` (new directories: sources, `*.test.ts`, fixtures);
    - `apps/web/package.json`, `apps/worker/package.json` (new dependencies, `bin`), `pnpm-lock.yaml`;
    - `.claude/settings.json`;
    - `packages/shared/migrations/0006_epochs.sql`, `packages/shared/src/repositories/admin/migrate.test.ts` and `apps/cli/src/migrate.test.ts` (only the pins that count migrations or list files), `packages/shared/src/repositories/fixtures/schema-columns.json` (only the two new `projects` epoch columns; `schema-assumptions.test.ts` compares it with a migrated schema), `packages/shared/src/repositories/scratch.ts` (only if the new migration makes its `epochColumns` helper redundant: then it may become a no-op);
    - `.claude/metric/eval/ci.md`, `.claude/metric/eval/switch.md`, `.claude/metric/eval/switch/` (the runner `run.mjs` and what it needs).
    Everything else is untouched: no earlier task's source, no `hooks/spool`, no `dashboard/`, no `src/` (Python), no `deploy/`, no `apps/cli` source, no `docker/`, no `config/`.
    `apps/web/src/index.ts` and `apps/worker/src/index.ts` stay as they are. No Python file changes (so `pytest` is not part of the self-check unless one does).
    FROM-OWNER (O9 units are written, not installed; O10 pnpm workspace is `apps/*` and `packages/*`; O12 repo-only change). The list itself: YOUR-CHOICE.

D3  `.claude/settings.json` content. A JSON object whose `hooks` keeps the two existing `PreToolUse` groups (`Bash|Grep` and `Read|Glob`, the `graphify hook-guard` ones) deep-equal to HEAD
    and in first position, and no other top-level key is added or changed. New groups, in this order inside each event array (only these seven groups are added):

    | Event | `matcher` | command (D4 gives the template) | `timeout` (s) |
    |---|---|---|---|
    | `UserPromptSubmit` | none | curl `-m 0.15` to `/v1/hook/prompt` | 1 |
    | `PreToolUse` (after the graphify groups) | `Read\|Edit\|Write\|MultiEdit\|Grep\|Glob\|Bash` | curl `-m 0.05` to `/v1/hook/pre` | 1 |
    | `SessionStart` | none | curl `-m 1.5` to `/v1/hook/start` | 3 |
    | `PostToolUse` | `Edit\|Write\|MultiEdit` | spool script with argument `PostToolUse` | 2 |
    | `Stop` | none | spool script with argument `Stop` | 2 |
    | `SessionEnd` | none | spool script with argument `SessionEnd` | 2 |

    Each group has exactly one hook `{type: "command", command, timeout}`. No `async`, no `env`, no absolute home path, no `~`.
    Hook commands never mention `ctc.sock`, `--unix-socket` or port 18310 as a literal host (D4 uses the variable with 18310 as its default).
    FROM-SPEC (spec:105-108 events, routes and curl budgets; spec:792). FROM-CALLERS (apps/web/src/pre/index.ts:1-2 the pre tools: Read/Edit/Write/MultiEdit note, Grep/Glob/Bash hint;
    apps/web/src/spool/index.ts:137-138 `PostToolUse` of any tool but Edit/Write/MultiEdit is dropped, so the narrow matcher loses nothing; packages/shared/src/spool/index.ts:10 `EDIT_TOOLS`;
    the existing graphify groups in .claude/settings.json). Matcher `Edit|Write|MultiEdit` for PostToolUse (the spec table lists the event without a matcher), the seven-tool PreToolUse matcher
    (the Python install used four tools; the F1 hint needs Grep, Glob, Bash), and the `timeout` values: YOUR-CHOICE.

D4  Hook command templates (the `command` strings). `PORT` is the shell expression `${CTC_PORT:-18310}`: the committed file points at the production port, a dev run sets `CTC_PORT=18410`.
    Route hooks (prompt, pre, start), `ROUTE` and `M` from D3:

        LC_ALL=C curl -sf -m M -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:${CTC_PORT:-18310}/v1/hook/ROUTE" || true

    Spool hooks, `EVENT` from D3:

        "$CLAUDE_PROJECT_DIR/hooks/spool" EVENT 2>/dev/null || true

    Behaviour (run with `sh -c` and the hook JSON on stdin; checked against a fake server):
    - reply `200`: stdout is the reply body, byte for byte; `204`: stdout empty; `4xx`/`5xx` (`-f`): stdout empty, so an error JSON never reaches the model's context;
    - the server does not answer, hangs, or is not listening: exit 0, stdout empty, back within `M` plus 0.5 s;
    - the request body is the stdin bytes, `Content-Type: application/json`, method POST, path `/v1/hook/ROUTE`;
    - the exit status is always 0 and nothing is written to stderr by the route hooks; `CLAUDE_PROJECT_DIR` unset or wrong: the spool hooks still exit 0 with empty stdout.
    `hooks/spool` itself is not edited (D5). The loopback port (not the unix socket) is what the hooks use, as the spec table and `hooks/spool` do.
    FROM-SPEC (spec:105-108, spec:164 hooks never error). FROM-CALLERS (hooks/spool:7-8 `CLAUDE_PROJECT_DIR` via "Called from: .claude/settings.json hooks (wired by T7.1)";
    hooks/spool:9 `CTC_PORT`; src/ctc/cli.py:821-823 the Python install used `curl -sf -m … || true`). `LC_ALL=C` (curl parses `0.15` by locale),
    `-sf`, the explicit `Content-Type` (a form content type is not JSON), `"$CLAUDE_PROJECT_DIR/…"` and `2>/dev/null || true` on the spool hooks: YOUR-CHOICE.

D5  `hooks/spool` is T4.1's file and stays byte-identical to HEAD (its header already names T7.1 as the wiring task). No second copy, no wrapper script.
    FROM-CALLERS (hooks/spool:1-9; agent/t4-1-spool). The choice not to add a user-level install script: YOUR-CHOICE (D21: nothing is installed on this machine).

D6  Dev-instance isolation. When env `CTC_HOME` is set (the dev instance), both mains:
    - pass `home: CTC_HOME` to `loadConfigOrExit` so every `~` in the config (socket, spool dir, trash dir, library roots, `claude_home`) lands under `CTC_HOME`;
    - exit 78 before opening any connection when `CTC_PORT` (or `config.port`) is outside 18400-18499 (this keeps them off the live daemon 18310 and the containers 18300-18306);
    - exit 78 before opening any connection when the database URL is not `127.0.0.1:18304` or the Redis URL is not `127.0.0.1:18395` (so Supabase and the daemon's Redis :18303 can never be reached);
    - never read or write `~/.claude`, `~/.claudethecaller` or Supabase; the message of exit 78 names the offending setting and never prints a password.
    When `CTC_HOME` is unset the production defaults apply (config port, `~` is the real home) and these guards do not apply.
    FROM-OWNER (O12 first bullet: dev runs use `CTC_HOME=$PWD/.ctc-dev`, port 18410 web / 18411+ others; second bullet: never write the real `~/.claude`, never Supabase; O7 scratch services).
    The guards as hard exits, and the 18400-18499 range: YOUR-CHOICE (the owner asked for a convention; a refusal makes the convention safe when the owner is asleep).

D7  Environment and exit codes of both mains. Env read: `CTC_HOME`, `CTC_CONFIG_DIR`, `CTC_PORT`, `CTC_MODE`, `CTC_DATABASE_URL`, `CTC_REDIS_URL`, `CTC_SOCKET` (all through `loadConfigOrExit`, unchanged),
    plus two new ones read by the mains only: `CTC_DB_SCHEMA` (default `ctc`; same pattern as `createDb`, a bad value exits 78) and `CTC_REDIS_NAMESPACE` (default empty; passed to `createCache`, `createQueues`, `startWorkers`).
    `config.database_url` null (unset) exits 78 with `database_url is not set`. Exit codes: `0` after a clean stop (D15), `78` bad config, guard (D6), schema stamp (D15), shared mode (D12) or no bind within 60 s,
    `1` any other start failure. Log: one JSON object per line on stdout, always with `msg`; the ready line is exactly
    `{"msg":"ready","app":"ctc-web","port":<n>,"routes":[<sorted \"METHOD url\" strings>],...}` / `{"msg":"ready","app":"ctc-worker","handlers":[<sorted keys>],...}`; secrets (URLs with passwords) are never logged.
    FROM-SPEC (spec:84 "exits 78 if it cannot bind in 60 s", spec:208 bad config key exits with the YAML path). FROM-CALLERS (packages/shared/src/env/index.ts:13-33 `loadConfigOrExit` and
    `ENV_TO_KEY`, EX_CONFIG 78; deploy/systemd/ctc-web.service `RestartPreventExitStatus`-style 78 use; packages/shared/src/repositories/db.ts:61-63 schema default `ctc`).
    The two new env names, the JSON ready line and the 60 s bind rule being a retry-then-78: YOUR-CHOICE.

D8  Web listeners and health. `ctc-web` listens on `127.0.0.1:<config.port>` and on the unix socket `config.socket` (mode 0600, a stale socket file from a dead process is removed first, the file is removed at stop).
    If the socket path is longer than 100 bytes the socket listener is skipped with a log line `{"msg":"socket skipped",...}` and the process still starts (the OS limit is 107). Binds retry every second for up to 60 s,
    then exit 78. `GET /v1/health` always answers `200` JSON `{"status":"ok","mode":"local","uptime_s":<n>,"db":"up|down","redis":"up|down"}`, each probe bounded to 300 ms; a down dependency never changes the status code.
    FROM-SPEC (spec:59 "unix socket + loopback port", spec:84, spec:107, spec:146-162). The 100-byte skip, `0600`, the health shape: YOUR-CHOICE.

D9  Route table. `ctc-web` mounts, with their own `method` and `url`, every route of: `libraryRoutes`, `graphRoutes`, `memoryRoutes`, `hookStartRoute`, `runsRoutes`, `workflowRoutes`, `suggestRoutes`, `preRoutes`, `nudgeRoute(drain)`, and `GET /v1/health`.
    Expected `METHOD url` set (checked): `POST /v1/hook/prompt`, `POST /v1/hook/pre`, `POST /v1/hook/start`, `POST /v1/suggest`, `POST /v1/spool/nudge`, `GET /v1/health`,
    `GET /api/capabilities`, `GET /api/capabilities/:id`, `GET /api/capabilities/:id/versions`, `GET /api/capabilities/:id/versions/:v`, `GET /api/capabilities/:id/versions/:v/diff`,
    `PATCH /api/capabilities/:id/versions/:v/labels`, `POST /api/capabilities/:id/restore`, `PUT|DELETE /api/projects/:pid/capabilities/:id/override`, `POST /api/index`,
    `GET /api/graph/{search,explain,path,affected,neighbors,stats}`, `POST /api/graph/build`, `PATCH /api/graph/edges`,
    `GET /api/memories`, `GET|PATCH|DELETE /api/memories/:id`, `POST /api/memories/import`, `GET /api/sessions/:sid/summary`, `GET /api/history`, `POST /api/history/import`,
    `GET /api/workflows`, `GET /api/workflows/:id`, `POST /api/workflows/:id/runs`, `GET /api/runs`, `GET /api/runs/:rid`, `POST /api/runs/:rid/approve`, `POST /api/runs/:rid/continue`,
    `GET /api/runs/:rid/steps/:sid/log`, `POST /api/runs/:rid/steps/:sid/{retry,fail,report}`, `POST /api/runs/:rid/cancel`.
    The ready line's `routes` array lists exactly this set (sorted strings `"GET /v1/health"`), nothing else. A duplicate `METHOD url` among all factories is a boot error (exit 1, the pair is named), never a silent overwrite. Ctx: every handler gets `ctxOf` returning `{userId: 'local'}`.
    No route outside the expected set exists (so `/api/schedules*` is not mounted: spec:700 says "unchanged", i.e. it is the Python service's, see D23). An unmatched URL answers `404` `{"error":{"code":"not_found",...}}`.
    FROM-SPEC (spec:105-111, spec:700, spec:166). FROM-CALLERS (the route factories' own `url:` fields: apps/web/src/{library,graph,memory,runs,suggest,pre,spool}). `/api/index` and the schedules decision: YOUR-CHOICE.

D10 Bodies and content types. Hook routes (`/v1/hook/*`, `/v1/spool/nudge`, `/v1/suggest`) accept any content type: the bytes are parsed as JSON; if that fails the handler gets an undefined body (so the handler's own invalid path answers).
    Body limit 1,048,576 bytes on hook routes; `/api/*` and `/mcp` accept `application/json` only, limit 1,048,576. Over the limit or a bad JSON body: hook routes answer `204` empty, `/api/*` answers
    `{"error":{"code":"invalid","message":...}}` with `422`, `/mcp` answers a JSON-RPC parse error. Replies use the Route handler's own `reply.code(n).send(x)`; objects are sent as JSON, strings as `text/plain; charset=utf-8`.
    FROM-SPEC (spec:213 hook body ≤ 1 MB, spec:144-166). FROM-CALLERS (apps/web/src/library/http.ts:24-32 `Route` type; apps/web/src/spool/index.ts:376-388 `nudgeRoute` replies through `reply.code(204).send()`).
    Accepting any content type on hooks (curl's default is a form type; D4 sets JSON but Claude Code versions and a hand `curl` differ): YOUR-CHOICE.

D11 Hooks never error. Any failure on `/v1/hook/*` (a thrown error inside a handler, a rejected promise, a parse failure, a body over the limit, a handler that never replies for 2 s) ends as an empty `204` with no body.
    The 2 s watchdog is the outer net only; the handlers keep their own budgets (140, 40, 1,200 ms). Errors on `/api/*` are shaped by the handlers (T3.2 `ErrorCode` model, spec:150-160); a throw that escapes a handler becomes
    `500 {"error":{"code":"internal","message":"<ClassName>"}}` and never the message or a stack. Nothing is logged with request bodies.
    FROM-SPEC (spec:164, spec:162 `internal` returns only the class name, spec:204). FROM-CALLERS (apps/web/src/pre/index.ts:253-262 `204` on every failure). The 2 s watchdog: YOUR-CHOICE.

D12 Modes. Only `local` mode is wired. `config.mode === 'shared'` exits 78 with `shared mode is not wired in T7.1`. No `Authorization` header is read; a bogus `Bearer` header is ignored and the request is served as `local`.
    The rate limit (`cache.rateLimit`) is not applied (it is per key; local mode has none). Reason: shared mode needs the verified-key path (`api_keys`, `key:{hash}`), which no earlier task built into a route layer, and spec §10 lists no task for it.
    FROM-SPEC (spec:138 local mode: no auth, `userId = local`; spec:141 rate limit per key; spec:37 non-goals). Refusing shared mode with 78 rather than serving it unauthenticated, and no local rate limit: YOUR-CHOICE.

D13 Dependencies wired in `ctc-web` (read the earlier tasks' APIs; do not copy their logic): `createDb({url, schema, max: config.db_pool.max})` and `createRepositories`; `createCache({url: redis_url, namespace})` (Redis down never stops the start, spec:205);
    `createQueues`; the embedder (`createEmbedder`/`createTei`) from `config.embed_url`; the graph store (T2.4) loaded for every project at boot and reloaded on `ctc:inval`; the skill channel (T3.3); `createSessionCaps`
    (T5.2, `graphTools({... onToolCall})` calls `caps.markGraphCall`); `createSpoolDrain({dir: config.spool.dir, keepDays: config.spool.keep_days, queues, repos})` with `start()` at boot, `close()` at stop, `nudgeRoute(drain)`;
    `submit` = `submitJob` over the repositories' `jobs` port. Postgres unreachable at boot: the process starts anyway, `/v1/health` says `db: "down"`, hooks answer `204` (spec:204), `/api` answers `500 internal`; it keeps trying to
    connect in the background (the pool does this). The embedder or Redis down at boot never stops the start (spec:205-206).
    FROM-SPEC (spec:198-208 failure modes, spec:88). FROM-CALLERS (apps/web/src/spool/index.ts:3 `start()`/`close()`; apps/web/src/pre/index.ts:4-7 caps wiring; apps/web/src/skills/index.ts:24-40 `SkillChannelDeps`;
    apps/web/src/graph/index.ts exports; packages/shared/src/queues/submit.ts). Starting without Postgres: YOUR-CHOICE (the alternative is exit 1).

D14 MCP at `/mcp`. Streamable HTTP, stateless (every POST is independent; `Mcp-Session-Id` is neither issued nor required). Dependency: `@modelcontextprotocol/sdk` 1.x (spec:63) behind a thin file `apps/web/src/server/mcp.ts`;
    if the SDK cannot be imported on Node 22 with the repository's Zod 4, that file may instead implement the JSON-RPC subset `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`
    (reply `application/json`) and a `judgment:` comment says why. Tools: the union of `graphTools`, `libraryTools`, `memoryTools`, `workflowTools`; `tools/list` returns exactly these 13 names and no other:
    `graph_search graph_explain graph_path graph_affected graph_neighbors get_capability load_capability_resource mem_search mem_timeline mem_get save_memory run_workflow workflow_status`.
    Each tool carries its `description` and a JSON Schema derived from its Zod `inputSchema`. `tools/call` runs `tool.call({userId: 'local'}, args)` and returns its `McpResult` unchanged; an unknown tool is the JSON-RPC error `-32602`;
    a tool that throws is `isError: true` with the class name only. `GET /mcp` and `DELETE /mcp` answer `405`. The server name in `initialize` is `claudethecaller` (the name the Python install registered, src/ctc/cli.py:822 `MCP = "claudethecaller"`).
    FROM-SPEC (spec:63, spec:111 the 13 tools). FROM-CALLERS (apps/web/src/library/http.ts:33-38 `McpTool`; apps/web/src/{graph,library,memory,runs}/tools.ts `name:` fields; src/ctc/cli.py:822).
    Stateless mode, the SDK-or-subset rule, 405 for GET: YOUR-CHOICE.

D15 Boot order, stamp and stop (web). Order: load config → D6 guards → open the database → `assertSchemaVersion({url, schema})` (a `MigrationError` exits 78 and the message says `run: ctc migrate`; the process never migrates by itself; any error here other than a `MigrationError` is not a stamp error: the check is skipped and D13 applies) → cache, queues, repositories →
    graph store and skill vectors load (a failure here is logged and retried every 5 s; hooks answer `204` meanwhile) → drain `start()` → routes → listeners → ready line. `SIGTERM` and `SIGINT`: stop accepting, `drain.close()`, close the server, queues, cache,
    database, remove the socket file, exit 0, all within 15 s (then exit 1). A second signal exits 1 at once. Unhandled rejections are logged (class name) and do not stop the process.
    FROM-SPEC (spec:84, spec:134 "a schema stamp makes a binary older than the database refuse to start"). FROM-CALLERS (packages/shared/src/repositories/admin/migrate.ts:161-167 `assertSchemaVersion` errors `schema_too_new`/`schema_behind`;
    deploy/systemd/ctc-web.service `TimeoutStopSec=15`). Refusing a schema that is *behind* too (not only newer): YOUR-CHOICE.

D16 Worker main. `ctc-worker` runs `startWorkers({url: redis_url, namespace, port: <jobs port of the repositories>, handlers, log})` with exactly these handler keys, no more, no fewer:
    `cleanup.blobs cleanup.receipts cleanup.worktree graph.extract graph.rebuild library.changed library.scan llm.extract llm.summarize memory.distill memory.import runner.step`.
    `llm.enrich` has no handler and none is invented (see D23); `dlq-retry.run` is the framework's. Sources: `graphHandlers` wrapped by `withContextPass`, `libraryHandlers` wrapped by `withCapabilityLinks` (apps/worker/src/context/index.ts:3-5), `extractHandler`,
    `memoryHandlers`, `memoryJobHandlers`, `workflowHandlers` (NOT `runnerHandlers` alone: the engine wraps it), `cleanupHandlers`, `blobCleanupHandlers`. After the workers start: `sweepRunner` once BEFORE the workers (apps/worker/src/runner/index.ts:3),
    then `startRunnerLoop`, `scheduleCleanup`, `startBlobCleanup`, `watchLibrary` and `watchMemoryFiles` for the configured roots that exist (a missing root is skipped, not an error). The ready line lists the handler keys.
    A handler key that two modules both define is a boot error (exit 1, key named). `SIGTERM`/`SIGINT`: stop the loops and watchers, `close({graceMs: queueLimits.closeGraceMs})`, close the database, exit 0 within 15 s. Job submit, the `jobs` row and the poller behave as T1.4 built them.
    FROM-SPEC (spec:81, spec:93, spec:186-196 queues). FROM-CALLERS (apps/worker/src/jobs/index.ts:23-34 `startWorkers`; apps/worker/src/{graph,library,memory,runner,context}/index.ts exports; packages/shared/src/queues/payloads.ts:13-27 the kinds;
    agent/t6-3-runner-gates/DECISIONS.md D0a boot order). Watchers only for roots that exist: YOUR-CHOICE.

D17 Migration `0006_epochs.sql`. Adds `projects.graph_epoch bigint not null default 0` and `projects.mem_epoch bigint not null default 0` (`add column if not exists`, so a schema that `scratch.ts` already patched stays valid).
    Nothing else changes: no index, no data rewrite. After it: a fresh `migrate()` stamps version 6; `loadMigrations` lists six files; `packages/shared/src/repositories/schema-assumptions.test.ts` passes (it was red at HEAD for exactly these two columns);
    `migrate.test.ts` and `apps/cli/src/migrate.test.ts` pins that said 5 say 6. The earlier migration files are not edited (their checksum is stamped).
    FROM-CALLERS (packages/shared/src/repositories/projects.ts:15 and :56 read `graph_epoch`/`mem_epoch`; packages/shared/src/repositories/db.ts:18 the `projects` row type; packages/shared/src/repositories/scratch.ts:22-29 says T1.2 does not create them;
    agent/t3-1-scanner/CHANGES.md and agent/t4-3-recall/CHANGES.md record the red test). FROM-SPEC (spec:182 epochs; spec:205 and spec:356 "60 s poll of `graph_epoch` in Postgres"). The `bigint not null default 0` type: YOUR-CHOICE (it is what `scratch.ts` already uses).

D18 Dependencies. `apps/web/package.json` gains `fastify` (5.x) and `@modelcontextprotocol/sdk` (1.x), each as an exact version (no `^`, like the other pins); `apps/worker/package.json` gains nothing unless a new import needs it. `bin` entries:
    `apps/web` → `"ctc-web": "./src/server/main.ts"`, `apps/worker` → `"ctc-worker": "./src/boot/main.ts"`; both mains start with `#!/usr/bin/env node` and are executable. They run as TypeScript source (O11, T1.1 D3b), no build.
    `pnpm install --frozen-lockfile` passes after the change (the lockfile is updated by the coder with `pnpm add`; the npm registry is allowed, O11). The pins are versions published at least two weeks before 2026-10-31. ESLint bans stay (no `pg`/`kysely` outside
    `packages/shared/src/repositories`; none of the new files imports them).
    FROM-OWNER (O6 versions follow the spec, O11 registry allowed, TS runs as source). FROM-SPEC (spec:59-63). FROM-CALLERS (apps/cli/package.json:15-17 the `bin` pattern). The exact-version rule and the 2-week rule: YOUR-CHOICE.

D19 The gates. `.claude/metric/eval/switch/run.mjs` runs each spec §7 gate and records one row. `--list` prints the gate names, one per line, in this order and nothing else:
    `tenancy failopen ci graph.ids graph.resolve graph.incremental graph.query suggest.latency suggest.context library.version library.mcp library.override suggest.skills memory.spool memory.idempotent memory.bands memory.context memory.recall runner.lifecycle runner.crash runner.fanout runner.idempotent runner.md dashboard-e2e dev-instance`
    (the 24 names of spec §7, `ci` and `dashboard-e2e` included, then `dev-instance`, T7.1's own smoke test, as the 25th). `--only <name>[,<name>…]` runs a subset. `--out <file>` (default `.ctc-dev/eval/switch.json`).

    | Gate | How it runs (from the repo root, under `timeout`) | Test file |
    |---|---|---|
    | `tenancy` | `pnpm exec vitest run <file>` | `packages/shared/src/repositories/tenancy.test.ts` |
    | `failopen` | same | `apps/web/src/pre/failopen.int.test.ts` |
    | `ci` | `bash scripts/check.sh` with `CTC_DATABASE_URL` = the scratch Postgres URL and `CTC_REDIS_URL` = `redis://127.0.0.1:18395/0` (exit 0; it runs `pnpm -r lint`, `typecheck`, `test`) | n/a |
    | `graph.ids`, `graph.resolve` | vitest | `packages/core/src/graph/graph.ids.test.ts`, `graph.resolve.test.ts` |
    | `graph.incremental` | vitest | `apps/worker/src/graph/graph.incremental.test.ts` |
    | `graph.query` | vitest | `apps/web/src/graph/graph.query.int.test.ts` |
    | `suggest.latency`, `suggest.context` | vitest with `CTC_GATE_SUGGEST=1` | `apps/web/src/suggest/suggest.latency.int.test.ts`, `suggest.context.int.test.ts` |
    | `library.version` | vitest | `apps/worker/src/library/library.version.test.ts` |
    | `library.mcp`, `library.override` | vitest | `apps/web/src/library/library.mcp.int.test.ts`, `library.override.int.test.ts` |
    | `suggest.skills` | vitest with `CTC_GATE_SUGGEST_SKILLS=1` | `apps/web/src/skills/suggest.skills.int.test.ts` |
    | `memory.spool` | vitest | `apps/web/src/spool/memory.spool.int.test.ts` |
    | `memory.idempotent`, `memory.bands` | vitest | `apps/worker/src/memory/memory.idempotent.int.test.ts`, `memory.bands.int.test.ts` |
    | `memory.context`, `memory.recall` | vitest | `apps/web/src/memory/memory.context.int.test.ts`, `memory.recall.int.test.ts` |
    | `runner.lifecycle`, `runner.idempotent` | vitest | `apps/web/src/runs/runner.lifecycle.int.test.ts`, `runner.idempotent.int.test.ts` |
    | `runner.crash`, `runner.fanout`, `runner.md` | vitest | `apps/worker/src/runner/runner.crash.int.test.ts`, `runner.fanout.int.test.ts`, `runner.md.int.test.ts` |
    | `dashboard-e2e` | not run | n/a |
    | `dev-instance` | vitest | `apps/web/src/server/switch.live.int.test.ts` (D20) |

    Every vitest gate runs with `--reporter=json`; env for every gate: `CTC_HOME=<repo>/.ctc-dev`, `CTC_PORT=18410`, `CTC_SCRATCH_PG_URL`, `CTC_TEST_DATABASE_URL` (= the scratch URL), `CTC_TEST_ADMIN_URL` (= the scratch URL),
    `CTC_SCRATCH_REDIS_URL=redis://127.0.0.1:18395`. The runner refuses to start (exit 2, nothing run) unless `CTC_SCRATCH_PG_URL` is `postgres(ql)://…@127.0.0.1:18304/…`.
    GREEN means: process exit 0 AND, for the assertions under the top-level `describe` whose title equals the gate name: at least 1 passed, 0 failed, 0 skipped/pending/todo. A gate whose describe is skipped (a strict flag missing) is `fail`, never `pass`.
    `ci` is green on exit 0. `dashboard-e2e` is recorded as `not_run` with reason `O12: no frontend spec (spec §10), the dashboard rework is not built`; it is never `pass`. A missing test file is `fail` (reason `file missing`).
    Row shape: `{gate, area, command, status: "pass"|"fail"|"not_run", passed, failed, skipped, ms, reason?}`; areas: System, F1, F2, F3, F4, Dashboard, Switch. The file also has `{startedAt, head, node, rows}`.
    The default exit code is 1 when any row is `fail`, else 0 (a `not_run` row for `dashboard-e2e` does not fail the run).
    FROM-SPEC (spec:751-762 the §7 table, names and areas). FROM-OWNER (O12 last bullet: dashboard-e2e is reported as not run; O12 first bullet: CTC_HOME and port 18410; O7 scratch services).
    FROM-CALLERS (the describe names in the test files listed; apps/web/src/suggest/suggest.context.int.test.ts:26 and suggest.skills.int.test.ts:23 the strict env flags). The `--list` order, the green rule (no skipped) and `dev-instance` as a 25th row: YOUR-CHOICE.

D20 `dev-instance` (the live smoke, a Vitest file with `describe('switch.live')`). It builds a fresh scratch schema `ctc_t71_<random>` (`migrate`), starts the real `ctc-web` and `ctc-worker` as child processes with
    `CTC_HOME=<repo>/.ctc-dev`, `CTC_PORT=18410`, `CTC_DB_SCHEMA=<schema>`, `CTC_REDIS_NAMESPACE=t71<random>:`, `CTC_SPOOL_DIR`-equivalent via the config (spool under `CTC_HOME`), waits for both ready lines, then in order:
    1. `GET /v1/health` is `200` with `db: "up"`;
    2. creates a throwaway git repo with 2 source files and a `specs/` markdown file, posts `/v1/hook/start` and runs the three route hook commands from `.claude/settings.json` (`sh -c`, `CTC_PORT=18410`, a real hook JSON on stdin): each exits 0, within its `-m` plus 0.5 s,
       with stdout empty or a single reply (prompt ≤ 400 chars, start ≤ 10,000 chars, pre valid JSON with `hookSpecificOutput.additionalContext`);
    3. runs `hooks/spool PostToolUse` (via the settings command, `CLAUDE_PROJECT_DIR=<repo>`, `CTC_SPOOL_DIR` under `CTC_HOME`) with an `Edit` payload for a file of the throwaway repo, and within 15 s a `jobs` row for it exists and the spool file is gone;
    4. `POST /mcp` `tools/list` returns the 13 names (D14) and `tools/call graph_search` answers without `isError` for the throwaway project;
    5. `GET /api/runs` and `GET /api/capabilities` answer `200` JSON;
    6. kills `ctc-web` (its own pid only): the three route hook commands exit 0 with empty stdout within their bound (fail open); restarts it; `GET /v1/health` is `200` again;
    7. `SIGTERM` to both children: both exit 0 within 15 s, the port is closed, no process of the test is left, the schema is dropped.
    It never connects to 18310 or touches `~/.claude`, `~/.claudethecaller`, Supabase, or any container. The test is named `switch.live` and is slow (`*.int.test.ts`).
    FROM-OWNER (O12 first bullet). FROM-SPEC (spec:84, spec:164, spec:198-205 fail open). FROM-CALLERS (hooks/spool:9-10 env; apps/web/src/spool/index.ts:137-160 what a PostToolUse Edit enqueues). The 15 s drain bound and step order: YOUR-CHOICE.

D21 O12 safety. The Python daemon (:18310), the containers (:18300-18306) and the real `~/.claude` are not stopped, restarted, reconfigured or written. "Stop the Python daemon" (spec:792) is therefore NOT done and is reported as not done in `switch.md`
    (section "Not done"); nothing is installed (no unit, no `~/.claude/settings.json` edit, no `claude mcp add`). No new or changed source, script or JSON file (not `*.test.ts`, not `*.md`) contains the words `systemctl`, `pkill`, `killall`, `docker stop`, `docker rm`, `docker restart`, `supabase`, ; no such file except `.claude/settings.json` contains `18310`, and there only as the default of `${CTC_PORT:-18310}`. `.claude/settings.local.json` is not created. `git status` shows no change outside D2.
    FROM-OWNER (O12 bullets 1-3). FROM-SPEC (spec:792). The word list: YOUR-CHOICE.

D22 Reports. `.claude/metric/eval/switch.md` has: what it measures; the gate table of D19 as written under "Gates"; a `## Results` section whose table sits between `<!-- results:start -->` and `<!-- results:end -->` and is rewritten by `run.mjs`
    (columns `gate | area | status | passed | failed | skipped | ms`, one row per D19 name in D19 order); a `## Not done` section with the items "stop the Python daemon (O12)", "install on this machine (O12)", "dashboard-e2e (O12)", "T7.2 deletion (depends on this result)", "shared mode (D12)",
    "`ctc daemon` command and dashboard static serving (D23)"; a `## Settings` section that quotes the six hook commands. `.claude/metric/eval/ci.md` has: what it measures (`pnpm -r lint && pnpm -r typecheck && pnpm -r test` plus `scripts/check.sh`),
    the exact command, a `## Results` table with one row (`command | exit | passed tests | ms | date`) rewritten by `run.mjs` the same way. In the committed state every D19 row except `dashboard-e2e` says `pass` and `dashboard-e2e` says `not_run`.
    FROM-SPEC (spec:751-762 links `ci.md`, `dashboard-e2e.md`; the `ci.md` file does not exist at HEAD). FROM-CALLERS (.claude/metric/eval/runner.md `<!-- results:start -->` pattern). `switch.md` as the single report and its sections: YOUR-CHOICE.
    `dashboard-e2e.md` is not created: the gate is not run (O12).

D23 Non-goals and what does that instead. Not built here: static dashboard serving and any `dashboard/` change (O12, spec §10); shared mode, API-key auth, rate limit (D12); `ctc daemon start|stop|status` and any `apps/cli` change (needs `systemctl`, O9/O12; the units stay uninstalled);
    `/api/schedules*` and the other Python-only `/api` routes (they remain on the Python daemon until T7.2); an `llm.enrich` handler (no task builds it; a submitted `llm.enrich` job stays queued and the Jobs page shows its age, spec:202);
    stopping or replacing the Python daemon; deleting any Python (T7.2); changing any earlier task's source; the spool format; `hooks/spool`.
    FROM-OWNER (O9, O10, O12). FROM-SPEC (spec:790-793, spec:700). Leaving `llm.enrich` unregistered rather than adding a stub that marks jobs done: YOUR-CHOICE.

D24 Code shape and silence. Every new source file starts with the usual header comment: what the module is, `Called from:`, why it exists, `Deliberately NOT done:`. Constants carry the real reason or `chosen by judgment`. No comment explains a chat or a task history.
    Reuse before writing: `loadConfigOrExit`, `createDb`, `createRepositories`, `createCache`, `createQueues`, `submitJob`, `assertSchemaVersion`, `migrate`, the route and tool factories, `Route`/`McpTool` types. New code only for what no module does: the Fastify composition,
    the MCP adapter, the two mains, the guards, the runner script. Where this list is silent, choose the more tolerant, less destructive behaviour and mark it with a `judgment:` comment (O11).
    FROM-OWNER (O11). FROM-SPEC (spec:88 "ESLint bans pg and kysely outside repositories").
