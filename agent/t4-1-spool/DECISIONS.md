# Decisions for T4.1: `hooks/spool`, the spool drain, the 250 ms nudge

Tags: FROM-OWNER (O#, agent/OWNER.md), FROM-SPEC (specs/007-ctc/spec.md line, "spec" below), FROM-CALLERS (file:line), YOUR-CHOICE (the owner reviews every one in the final PR, O11).
No call site exists yet: the web bootstrap, T2.2 and T4.2 are built later, so "callers" = the spec lines that name this module plus the already-merged APIs it must fit (`@ctc/shared/queues` T1.4, `@ctc/shared/repositories` T1.3, `@ctc/shared/env` T1.1).
Tag rule: a tag at the end of a block of indented lines covers the whole block above it.

D0  Purpose and callers. `hooks/spool` is the command Claude Code runs for the PostToolUse, Stop and SessionEnd hooks: it turns the hook's stdin into one spool file and nudges ctc-web, and it must never slow down or break the session. The drain (`apps/web/src/spool`) turns spool files into jobs: `graph.rebuild` (consumed by T2.2), `llm.extract` and `llm.summarize` (T4.2), plus a `sessions` upsert. Callers of the drain: the ctc-web bootstrap (boot, `POST /v1/spool/nudge`, shutdown). Why a spool and not an HTTP hook: "the web process is down during a session → nothing is lost; the spool is processed when it returns". FROM-SPEC (spec:91 code map, spec:108, spec:121, spec:474, spec:502-517, spec:558-559).

D1  Trust. Untrusted: the hook's stdin (any bytes, any size, maybe not JSON), every spool file (written by our script, but anything may sit in that directory: hand-written files, half-written files, other users' files in shared setups, symlinks, FIFOs, directories), every file name in the directory, and every field inside a payload (`session_id`, `cwd`, `tool_input.file_path`, `transcript_path`). Failures this prevents: a file name built from `session_id` escaping the spool dir (`../`), a hostile file crashing or hanging ctc-web, a FIFO blocking the drain forever, a payload making a job for a path outside the project, private text reaching disk. `userId` never comes from a file: it is `deps.userId` (default `local`). FROM-SPEC (spec:138 "local mode … userId = local", spec:141-142 isolation, spec:503 strip at capture); the threat list: YOUR-CHOICE.

D2  Limits. Exported object `spoolLimits`, read at call time (a test may assign to it and restore it):
    `spoolLimits = { maxFileBytes: 1048576, sweepEveryMs: 30000, nudgeTimeoutMs: 250 }`.
    `maxFileBytes` counts the bytes of the spool file on disk (`lstat` size): 1,048,576 is valid, 1,048,577 goes to `corrupt/`. FROM-SPEC (spec:213 "spool file ≤ 1 MB (bigger goes to `corrupt/`)").
    `sweepEveryMs` 30000: FROM-SPEC (spec:506 "in a 30 s sweep"). `nudgeTimeoutMs` 250 is the script's curl `-m 0.25`, exported only so tests can name it: FROM-SPEC (spec:505).
    `keepDays` is NOT a constant: it comes from `deps.keepDays` (config `spool.keep_days`, default 7), counted from the file's mtime; a file is expired when `now - mtime > keepDays × 86,400,000 ms` (exactly 7 days old is still kept). Value FROM-SPEC (spec:547, spec:517 "kept 7 days"); mtime as the clock and the strict `>`: YOUR-CHOICE.
    `spoolFieldLimits = { event: 32, sessionId: 256, toolName: 128, path: 4096 }` (max string lengths, inclusive) in `@ctc/shared/spool`: YOUR-CHOICE.
    Script: no size limit of its own (it writes what it gets; the drain enforces `maxFileBytes`). YOUR-CHOICE

D3  Output formats (exact).
    Spool file name: `<session>-<event>-<epoch_ns>-<rand>.json`, written first as `<that name>.tmp` in the same directory, then renamed. `<session>` = the payload's first `"session_id":"…"` value with every character outside `[A-Za-z0-9_-]` replaced by `_`, cut to 64 chars, `nosession` when empty or absent. `<event>` = D10 event. `<epoch_ns>` = `date +%s%N` when it prints only digits, else `$(date +%s)000000000`. `<rand>` = 8 lowercase hex chars from `/dev/urandom` (fallback: the shell's `$$` padded to 8 with zeros on the left). Shape FROM-SPEC (spec:504); the sanitizing, fallbacks and `.json.tmp` suffix: YOUR-CHOICE
    Spool file body: one JSON object `{"v":1,"event":"<event>","received_at":"<UTC ISO-8601, second precision, e.g. 2026-10-31T09:15:02Z>","payload":<stripped stdin>}`; key order as written, no other keys. FROM-SPEC (spec:504 "{v: 1, event, received_at, payload}"); the time format: YOUR-CHOICE.
    Spool directory: env `CTC_SPOOL_DIR` if set and non-empty, else `$HOME/.claudethecaller/spool`; the drain uses `deps.dir` (the web bootstrap passes `config.spool.dir`, already `~`-expanded by `@ctc/shared/env`). Created with mode 0700 (script: `umask 077; mkdir -p`; drain: `mkdir(dir, {recursive: true, mode: 0o700})`). Corrupt files go to `<dir>/corrupt/<basename>`; if that name exists, `<basename>.<Date.now()>` (never overwrite). Default dir FROM-SPEC (spec:121, spec:547) and FROM-CALLERS (packages/shared/src/env/schema.ts:145-146, packages/shared/src/env/index.ts:209); env name, modes and the collision suffix: YOUR-CHOICE
    Nudge request (script): `POST` to env `CTC_NUDGE_URL` if set and non-empty, else `http://127.0.0.1:${CTC_PORT:-18310}/v1/spool/nudge`, empty body. Path FROM-SPEC (spec:108, spec:505); port default FROM-CALLERS (packages/shared/src/env/schema.ts `port` default 18310, packages/shared/src/env/index.ts:50 `CTC_PORT`); `CTC_NUDGE_URL`: YOUR-CHOICE.
    Nudge reply (drain route): `204`, empty body, sent before any file is read; the request body is ignored. FROM-SPEC (spec:148 "204 empty hook reply") applied to the nudge: YOUR-CHOICE.
    Job id of every job made from a spool file: `spool:<basename without .json>` (one job per file). The `jobs` row keeps that string; T1.4 `bullJobId` encodes it for BullMQ. FROM-CALLERS (packages/shared/src/queues/submit.ts:83 `submitJob({…, id})`, packages/shared/src/queues/defs.ts:63 `bullJobId`); the id rule: YOUR-CHOICE (it is what makes "processed once" hold, D13).
    Job payloads (keys whose value is unknown are omitted, never `undefined`/`null`), exactly the T1.4 schemas: `graph.rebuild {userId, projectId, files: [<rel>]}`; `llm.extract {userId, projectId?, sessionId, transcriptPath?}`; `llm.summarize {userId, projectId?, sessionId}`. FROM-CALLERS (packages/shared/src/queues/payloads.ts:15-23).
    `drainOnce()` resolves `DrainReport = { queued: number, dropped: number, corrupt: number, kept: number, expired: number }`: per file of that pass exactly one counter is incremented (`queued` = its job row exists AND the BullMQ add returned true, then the file was deleted; `dropped` = valid but not routable, deleted; `corrupt` = moved to `corrupt/`; `kept` = left in place for a later pass; `expired` = undeliverable and too old, deleted). YOUR-CHOICE

D4  Bad input. The drain never throws and never rejects for file content; a bad file is classified, never retried:
    `corrupt` (moved to `corrupt/`, logged with a reason code, never read again): size > `maxFileBytes` (reason `too_big`, the file is not read); not UTF-8 JSON (`not_json`); envelope or event fields fail the Zod schema (`schema`, the first issue's path in the log): `v` must be the number 1, `event` a string 1..32, `received_at` an ISO datetime (`z.iso.datetime()`), `payload` an object (not an array, not null); for `Stop` and `SessionEnd` `payload.session_id` must be a string 1..256; for `PostToolUse` with `tool_name` in `EDIT_TOOLS`, `payload.cwd` and `payload.tool_input.file_path` must be strings 1..4096 and `tool_input` an object.
    Optional fields of the wrong type count as absent (not corrupt): `cwd` on Stop/SessionEnd, `transcript_path`. The payload object is loose: unknown keys are ignored. The envelope is loose too (an extra top-level key is ignored).
    Not routable (`dropped`): see D12.
    `deps` that are wrong (no `dir`, `keepDays` not a positive integer) make `createSpoolDrain` throw `TypeError` synchronously; that is a programming error, not input.
    Spool rule FROM-SPEC (spec:507 "a bad file goes to `spool/corrupt/`", spec:559 "never retried"); the field-level split corrupt vs absent vs dropped: YOUR-CHOICE

D5  Odd but harmless input stays valid. Script: empty or whitespace-only stdin writes no file and sends no nudge (exit 0); stdin without a trailing newline; a payload without `session_id` (`nosession`); an event name given only on argv or only in the payload; a missing `curl` (no nudge, file still written); `date +%N` unsupported. Drain: a file deleted by someone else between `readdir` and `read` (skipped, counted nowhere); `*.tmp` files (ignored until expired, D13); non-`.json` names (ignored, never deleted); an empty spool dir; a dir that does not exist yet (created by `start()`, D14); a `cwd` with a trailing slash; a `file_path` that is relative (resolved against `cwd`); the same event twice in two files (two jobs: they are two events); the same file seen by two passes or two processes (one job, D13). YOUR-CHOICE

D6  Must never.
    Script: (a) exit with any status but 0; (b) write anything to stdout or stderr (a Stop hook's stdout JSON is read by Claude Code as a decision); (c) wait for the nudge: the script returns while curl runs in the background, with curl's stdin/stdout/stderr on `/dev/null` so the hook's pipes close; (d) leave a partial `.json` (only the `.tmp` can be partial; a failed write removes it); (e) write outside the spool dir (the file name has no `/`); (f) use bash-only syntax (it runs under `dash`); (g) keep `<private>` text on disk (D11).
    Drain: (h) crash or hang ctc-web: every error is caught per file, `drainOnce()` always resolves; (i) open anything that is not a regular file by `lstat` (symlinks, FIFOs, sockets, directories are skipped and left alone); (j) recurse into subdirectories (`corrupt/` is never re-read); (k) delete a file before its job row exists and the BullMQ add returned `true` (except `dropped`, `corrupt` = moved, `expired`); (l) make two job rows for one spool file; (m) log a payload, a file's content, a path inside the payload or a prompt: logs carry only the file basename, the reason code, the event name and counts; (n) edit its arguments or `deps`; (o) touch anything outside `deps.dir` (it never follows `transcript_path` or `cwd` on disk).
    FROM-SPEC (spec:108 "exit 0 always", spec:152 "hooks never error", spec:505 background nudge, spec:215 privacy); (b), (f), (i)-(o): YOUR-CHOICE

D7  Non-goals (and who does it instead): wiring the drain into a Fastify app, the `ctc-web` process and its boot order (the web bootstrap task; this task exports `createSpoolDrain` and `nudgeRoute` only and adds no Fastify dependency); the 3 s per-project debounce of `graph.rebuild` (T2.2 graph queue / rebuild; this task makes one job per edit event); the job handlers (T2.2, T4.2); reading transcripts, `sanitize`, the bands (T4.2); `.claude/settings.json` hook wiring and the `matcher` for PostToolUse (T7.1); `ctc hook spool` in `apps/cli` (spec:90; not built here, `hooks/spool` is the hook command); shared mode (a remote ctc-web cannot read a client's spool dir: in shared mode the hooks keep using the HTTP routes); skipping events from F4 runner sessions or the doc extractor (T4.2 / T6.2 decide); pruning `corrupt/` (kept forever); a Node or bash fallback of the script; Windows. FROM-SPEC (spec:290 debounce is F1's, spec:785 T4.2, spec:792 T7.1); the split of ownership: YOUR-CHOICE

D8  Silence rule. Where this list says nothing, choose the more tolerant, less destructive behaviour (keep a file over delete it, `kept` over `corrupt`, skip over fail, log over throw) and comment it `judgment:`. FROM-OWNER (O11) and FROM-SPEC (ORCHESTRATOR §3 D8).

D9  Public names and module layout.
    `packages/shared/src/spool/index.ts` (`@ctc/shared/spool`): `SpoolFileSchema` (the Zod envelope of D4, `payload` loose), `spoolFieldLimits` (D2), `EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit'] as const`. No I/O. It lives in `packages/shared` because `apps/web` has no direct `zod` dependency and the spec puts Zod schemas in `packages/shared` (spec:93); its own folder so it cannot collide with other tasks' `schemas/`. YOUR-CHOICE
    `apps/web/src/spool/index.ts`: `createSpoolDrain(deps: SpoolDeps): SpoolDrain`, `nudgeRoute(drain)`, `spoolLimits`, types `SpoolDeps`, `SpoolDrain`, `DrainReport`.

        type SpoolDeps = {
          dir: string;                     // config.spool.dir
          keepDays: number;                // config.spool.keep_days
          userId?: string;                 // default 'local'
          queues: Queues;                  // from @ctc/shared/queues createQueues()
          repos: {                         // structurally satisfied by T1.3 createRepositories(db)
            projects: { upsert(ctx: { userId: string }, input: { root: string }): Promise<{ id: string }> };
            sessions: { upsert(ctx: { userId: string }, input: { id: string; projectId: string; endedAt?: string; transcriptPath?: string }): Promise<unknown> };
            jobs: { create(ctx: { userId: string }, input: { id: string; queue: string; kind: string; payload: unknown }): Promise<{ job: { id: string }; created: boolean }> };
          };
          log?: (message: string, fields?: Record<string, unknown>) => void;
          now?: () => number;              // ms; default Date.now (tests pass a fake clock for expiry)
        };
        type SpoolDrain = { start(): Promise<void>; drainOnce(): Promise<DrainReport>; nudge(): void; close(): Promise<void> };
        nudgeRoute(drain) => { method: 'POST'; url: '/v1/spool/nudge'; handler(req: unknown, reply: { code(n: number): { send(): unknown } }): unknown }

    Jobs are made only through `submitJob({ queues, create: (row) => repos.jobs.create(ctx, row) mapped to {id, created}, log }, { queue, kind, payload, id })`. FROM-CALLERS (packages/shared/src/queues/submit.ts:75-91, packages/shared/src/repositories/jobs.ts:20, sessions.ts:21, projects.ts:24); the port shape and the Fastify-compatible route object: YOUR-CHOICE

D10 Script `hooks/spool` (POSIX sh, mode 0755, first line `#!/bin/sh`). In order:
    1. `exec >/dev/null 2>&1`; no `set -e`; `umask 077`.
    2. Read all of stdin. If it is empty or only whitespace: exit 0.
    3. Strip (D11).
    4. Event = `$1` if it matches `^[A-Za-z][A-Za-z0-9_]{0,31}$`, else the first `"hook_event_name":"…"` value of the payload if it matches the same pattern, else `unknown`.
    5. Dir (D3); `mkdir -p` it; on failure exit 0.
    6. Write the D3 body to `<name>.tmp`, then `mv -f` it to `<name>`; on any failure remove the `.tmp` and exit 0.
    7. If `curl` is on PATH: `curl -s -m 0.25 -X POST -o /dev/null --data '' "$url" </dev/null >/dev/null 2>&1 &` (background, never waited for).
    8. `exit 0`.
    Tools allowed: `sh` builtins, `cat`, `awk` (POSIX only: no gawk extensions), `sed`, `tr`, `head`, `od`, `date`, `mkdir`, `mv`, `rm`, `curl`. The whole script returns in ≤ 500 ms for a 10 KB payload whatever the nudge target does (checked with a server that accepts and never answers, and with a closed port).
    Steps 2, 5-8 FROM-SPEC (spec:502-505); order, the argv-first rule, tools and the 500 ms budget: YOUR-CHOICE

D11 Strip rule (script step 3). Remove each block from an opening tag to the first matching closing tag after it, both tags included, for exactly these tags (no attributes, case-sensitive): `<private>…</private>`, `<system-reminder>…</system-reminder>`, `<persisted-output>…</persisted-output>`. Repeat until none is left; blocks may span lines. An opening tag with no closing tag removes everything from the tag to the end of stdin (privacy wins: the file then fails JSON parsing and goes to `corrupt/` with the private text already gone). Text outside blocks, including a lone closing tag, is kept byte for byte. `<private>` FROM-SPEC (spec:503, spec:563 "`<private>` stripped at capture"); "harness tags" = the two tags of spec:215; the unclosed-tag rule and exact matching: YOUR-CHOICE

D12 Routing (by the envelope's `event`; names are case-sensitive).
    `PostToolUse` with `payload.tool_name` in `EDIT_TOOLS` → project = `repos.projects.upsert(ctx, {root: cwd})` with `cwd` minus trailing slashes; `rel` = `path.relative(cwd, path.resolve(cwd, file_path))` in POSIX form; if `cwd` is not absolute, or `rel` is `''`, absolute, or starts with `..` → `dropped` (reason `outside`); else `graph.rebuild {userId, projectId, files: [rel]}`. Lexical check only (no `realpath`). Any other `tool_name` → `dropped`.
    `Stop` → `llm.extract {userId, sessionId: session_id, projectId?, transcriptPath?}`; `projectId` from `projects.upsert` only when `payload.cwd` is an absolute path string.
    `SessionEnd` → when a project is known (as for Stop): `repos.sessions.upsert(ctx, {id: session_id, projectId, endedAt: received_at, transcriptPath?})` first; a `RepoError`/`ConflictError` from it is logged and ignored, any other error makes the file `kept`; then `llm.summarize {userId, sessionId, projectId?}`.
    Any other event (`unknown`, `SubagentStop`, `PreToolUse`, …) → `dropped`.
    Unusable roots (added by the verifier, round 2). A root (`cwd` minus trailing slashes) longer than 2048 UTF-8 bytes is not a project, and neither is one whose `repos.projects.upsert` throws a `RepoError` (e.g. `ConflictError` on an id collision; logged with its `code`): `PostToolUse` → `dropped` (reason `outside`); `Stop`/`SessionEnd` → no `projectId` (so no sessions upsert). Why: T1.2 stores the root as `projects.name` under `unique (user_id, name)`, a btree whose entries max out at 2704 bytes; Postgres rejects a longer root on every pass (`54000 index row size … exceeds btree version 4 maximum 2704`), and by D13 that one file would stop delivery of every later file for `keepDays`. 2048 leaves room for a 128-char `user_id`. YOUR-CHOICE
    `ctx = { userId: deps.userId ?? 'local' }`. FROM-SPEC (spec:508-516 the table, spec:138); upserting the project from `cwd`, the lexical path rule, the session-upsert error rule: YOUR-CHOICE

D13 Delivery, deletion, once.
    A pass lists `deps.dir` (non-recursive), takes regular `*.json` files, sorts them by mtime then name (oldest first), and handles each in turn: size check → read → parse → route → `submitJob` → delete on `{enqueued: true}`.
    `submitJob` throws (Postgres down, `ConflictError`) or returns `enqueued: false` (Redis down) → the file is `kept` (the row, if created, stays `queued` for the T1.4 poller). After the first such delivery failure in a pass, the remaining files of that pass are not delivered: each is only checked for expiry (deleted as `expired` when older than `keepDays`) or counted `kept`.
    A file is `expired` only when it could not be delivered in this pass AND is older than `keepDays` (D2). A file that can be delivered is delivered whatever its age. `*.tmp` files older than `keepDays` are deleted (counted `expired`); younger ones are ignored.
    "Processed once": the job id is `spool:<basename>` (D3) and `jobs.create` returns `{created: false}` for an existing id, so a file seen again (crash between add and delete, two passes, two processes) never makes a second row; BullMQ ignores a duplicate job id and the T1.3 claim never re-runs a `done` row. FROM-SPEC (spec:517 "Delete the file after the BullMQ add. Files the web cannot deliver are kept 7 days", spec:196 "spool files wait", spec:558 "processed once on return"); ordering, the stop-after-first-failure rule and `.tmp` expiry: YOUR-CHOICE

D14 Triggers and concurrency.
    `start()`: creates `deps.dir` and `<dir>/corrupt` (D3 modes), runs the boot pass and resolves when it has finished, then starts `fs.watch(dir)` (each event triggers a pass; a watch error is logged once and the sweep and nudge keep working) and a `setInterval(sweepEveryMs)` with `unref()`. A second `start()` is a no-op.
    At most one pass runs at a time per drain. A trigger (watch, sweep, `nudge()`, `drainOnce()`) during a pass schedules exactly one more pass after it (coalesced). `drainOnce()` resolves with the report of a pass that started after the call.
    `nudge()` returns at once (void), never throws, triggers a pass; it is ignored before `start()` and after `close()`.
    `close()`: stops the watcher and the interval, waits for a running pass, resolves; idempotent; it does not close `queues` or the database (the caller owns them).
    FROM-SPEC (spec:506 "on boot, on file watch and in a 30 s sweep", spec:505 nudge); the rest: YOUR-CHOICE

D15 Gate test `memory.spool` (`apps/web/src/spool/memory.spool.int.test.ts`, `describe('memory.spool')`), against the scratch Postgres and Redis, with the real `hooks/spool` run under `dash`:
    1. Web down: the script runs with `CTC_SPOOL_DIR=<tmp>` and `CTC_NUDGE_URL` at a closed loopback port, for one PostToolUse Edit inside `cwd`, one PostToolUse Read, one Stop and one SessionEnd (fixture payloads shaped like Claude Code's: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`, `tool_response`). Each run exits 0 within 500 ms with empty stdout and stderr; 4 `.json` files exist, no `.tmp`. Plant one corrupt file (`not json`).
    2. Web up: a `node:http` server mounting `nudgeRoute(drain)`; `start()`. Then exactly: 1 `graph.rebuild`, 1 `llm.extract`, 1 `llm.summarize` row in `jobs` and in BullMQ (namespace), 1 `sessions` row with `ended_at`; the spool dir holds only `corrupt/` with the planted file; report `{queued: 3, dropped: 1, corrupt: 1, kept: 0, expired: 0}`.
    3. Once: `drainOnce()` again, a second drain on the same dir, and re-placing a copy of an already-delivered file → still exactly 3 rows.
    4. Nudge: with the web up, one more Stop through the script → its job row appears within 2 s without calling `drainOnce()`.
    FROM-SPEC (spec:569 "web down → files → web up → each event processed once; a corrupt file lands in `corrupt/`", spec:760); steps 3-4 and the fixtures: YOUR-CHOICE
