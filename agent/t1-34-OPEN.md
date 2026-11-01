# T1.3 + T1.4 planner notes: what the owner must decide or review

Drafted: T1.3 repositories (17 decisions, `agent/t1-3-repos/`) and T1.4 cache/queues/units (24 decisions, `agent/t1-4-cache-queues/`).
YOUR-CHOICE lines: T1.3 = 15, T1.4 = 26 (41 in total; the table below groups them by choice). No FROM-OWNER line was needed beyond O1-O10.
Status: `python3 agent/<task>/checks.mjs|selfcheck.py` run and FAIL cleanly (module not built, scratch Redis `:18395` not running, `CTC_SCRATCH_*` env unset). The checks were never run against an implementation (none exists): expect a few planner mistakes in them; triage after the first coder run.

## A. Needs an owner answer (cross-task, ordered by blast radius)
1. **T1.2 must supply more than the spec's column lists** (T1.3 D10). Added: `user_id` on `jobs`, `history_files`, `idempotency_keys`, `graph_edges`, `dedup_review`, `wf_schedules`; `jobs.payload jsonb` and `jobs.attempts`; `projects.graph_epoch`/`mem_epoch`; `capabilities.removed_at`. `idempotency_keys` PK is `(user_id, key)`, not the spec's global `key` (a global key lets user B replay user A's response). T1.3 also needs `applyMigrations({url, schema})` from T1.2 (schema parameter, scratch only) and therefore must run after T1.2 although the spec marks T1.3 `[P]`. Default: as written. Alternative: T1.3 ships its own test DDL (duplicate schema, drifts).
2. **What polling does while Redis is down** (T1.4 D20). Default: Redis up = re-add stale `queued` rows to BullMQ; Redis down = run them directly (serial, one try per 5 s tick, `attempts` from the row). Alternative: re-add only (nothing runs until Redis returns). Spec §1.8/§1.9 says "the worker polls `jobs` every 5 s until Redis is back" and "Postgres job polling", which supports either.
3. **`dead` vs `dlq-retry`** (T1.4 D21). Default: all attempts used = `dead`; `dlq-retry` re-queues dead jobs up to 5 times (row `markQueued` first), skips `runner` and `dropped:` failures. Alternative: dlq-retry only touches jobs not yet `dead`. The spec uses both words for the same event.
4. **Redis eviction policy** (infra, outside both tasks). BullMQ wants `maxmemory-policy noeviction`; spec has `maxmemory 256mb` and a cache. Suggest `volatile-lru` (every cache key has a TTL, BullMQ keys have none); BullMQ logs a warning. Needs the owner's call before T1.1/compose is finalised.
5. **Spec bug, FYI**: runner job id `run:<rid>:node:<nid>:visit:<v>:attempt:<a>` (spec:644) is rejected by BullMQ 5 (`Custom Id cannot contain :`, checked in bullmq 5.81.5). T1.4 D3 encodes it (`j|run|r1|…`); the `jobs.id` row keeps the spec string. Suggest amending the spec line.
6. **Toolchain needs from T1.1**: `tsx` (checks.mjs import `.ts` sources with `node --import tsx`), root `vitest` + `eslint`, `packages/shared/tsconfig.json`; module paths are the spec code map without `src/` (constants at the top of each `checks.mjs`/`selfcheck.py` if T1.1 differs). The coder has no network: orchestrator installs `kysely`, `pg`, `@types/pg`, `bullmq@5.x` (5.81.5 works on Node 22.22.1; 6.x exists, spec says 5), `ioredis@5.x` (the one BullMQ bundles; 6.x exists), `zod@4`, then runs `selfcheck.py --snapshot` BEFORE the coder starts (the scope check ignores the pre-installed files), and starts the scratch Redis: `docker run -d --name ctc-scratch-redis -p 127.0.0.1:18395:6379 redis:8.2`. TypeScript 6 / Vitest 4 / Fastify 5 run on Node 22 (engines checked), nothing flagged for O6.

## B. YOUR-CHOICE items (task D-id: default | alternative | why it matters)
| Task D | Default | Alternative | Why it matters |
|---|---|---|---|
| T1.3 D13 | cross-user needs (auth by key hash, worker job claim, restart sweep, cleanup) live in `repos.system.*` with a branded `SystemCtx`, exact allowlist asserted by the test | give those functions a `ctx` with a `'*'`/system user | spec says "every function takes ctx"; a wildcard ctx would weaken `tenancy` |
| T1.3 D14 | ~75 functions listed by name (all tables), later tasks add functions + a tenancy case | only the ~20 spec-named primitives now | size of the T1.3 coder run; later tasks would otherwise edit this module |
| T1.3 D3 | rows `null` for missing-or-foreign, `RepoError` codes from the spec table, camelCase rows with `Date` | throw `not_found`; snake_case rows | every later route depends on it |
| T1.3 D14 library | `moveLabels` uses `FOR UPDATE NOWAIT`, loser gets `409 conflict` | plain `FOR UPDATE` (loser waits, then wins/loses silently) | spec:420 says FOR UPDATE, spec:448 says the loser gets 409 |
| T1.3 D14 projects | project id = `sha256(root)[:8]`; `(user_id, root)` unique | uuid | keeps ids stable with the Python rows `ctc migrate --from-python` carries over |
| T1.3 D2 | page default 50, max 500 clamped (not an error), pool 5, `statement_timeout` 5 s per connection (worker passes its own) | reject over 500 | the route's Zod rejects first anyway |
| T1.3 D12 | tenancy test = reflection + a case per function (a missing case fails) + information_schema structure check | hand-written list | stops a later task adding an unscoped function |
| T1.3 D9/D15/D16 | `createDb/createRepositories` factory, Postgres clock, ids generated in the module | module singleton; Node clock | testability, drift |
| T1.4 D9 | cache lives in `packages/shared/cache` (not in the spec's code map); worker code in `apps/worker/jobs/` | `apps/web`; `apps/worker/src/` | import paths for every later task |
| T1.4 D10 | one shared 256-entry L1; L1 still serves while Redis is down; L1 age cap 60 s; JSON values, vectors as raw float32 | per-prefix LRU; skip L1 when down | hot-path hit rate vs staleness |
| T1.4 D11 | breaker with one probe after 10 s; server error replies do not open it; ioredis `enableOfflineQueue:false` | open-for-window without probe | recovery speed, failure isolation |
| T1.4 D12 | epoch = random 12-hex token in Redis, in-process memo 5 s (stale up to 60 s when Redis is down, else `null`), rotate publishes an `epoch` message | Redis counter; Postgres counter | counter would let a Redis restart revive stale keys |
| T1.4 D13 | every non-epoch message clears all of L1; `cb` not called on reconnect | per-scope L1 invalidation | simplicity; 256 entries only |
| T1.4 D14 | fixed window per minute (spec) | sliding window (CLAUDE.md says the Python daemon now uses it) | the two documents disagree; decide which is current |
| T1.4 D15 | `runner` concurrency 3, attempts 1; `llm`/`cleanup` backoff exponential 5 s; `maxStalledCount` 0 only for runner | runner concurrency 1 | table says "1 run per login; fan-out children up to 3" |
| T1.4 D16 | payload fields are placeholders, `.strict()` | `.passthrough()` | later tasks edit the schema file; typos fail at submit |
| T1.4 D17-D19 | row first, add bounded to 1 s; `JobDropped` (`dropped:<code>`) = unrecoverable and never dlq-retried; claim by `markRunning`; markDone retried 3× then accepted; timeout via AbortSignal (handler must honour it) | fire-and-forget add; hard kill | exactly-once feel with Redis loss |
| T1.4 D22 | units: `ExecStart=%h/.claudethecaller/bin/ctc-{web,worker}`, `EnvironmentFile=-%h/.claudethecaller/env`, `MemoryHigh` 600M/1G (soft), worker `KillMode=process` (agents survive a worker restart so the sweep can reattach; the default would kill them), no `RestartPreventExitStatus=78` | `MemoryMax`; control-group kill; stop restarting on 78 | needs `ctc daemon` (later task) to place the launchers; exit 78 may be a transient bind failure |
| T1.4 D23 | `close()` idempotent; workers closed gracefully then forced after 5 s | wait forever | shutdown time under systemd `TimeoutStopSec` |

## C. Places where two reasonable readers differ
- Spec:170 "cache skipped" while Redis is down: only L2 here (L1 keeps serving).
- Spec:205 `graph_epoch` "in Postgres": there is no table column for it in §1.4; T1.3 adds `projects.graph_epoch`/`mem_epoch` with `epochs`/`bumpEpoch`, T1.4's epochs are Redis only; the 60 s Postgres poll that wires them together is left to apps/web (T2.x/T5.x).
- Spec:196 "dead" vs spec:194 "re-runs each failed job": see A3.
- Spec:605 timeouts are per queue and kind, but `runner` has "per node `timeout_s`": taken from the payload (`timeoutS`).
- Spec:141 rate limit is per API key; local mode has `userId = local`, so one counter for all local callers.
- Spec:134/1.4 `jobs` rows for the repeatable `dlq-retry` scheduler: none are written (internal job).
- Spec:422 `get_capability` reads "pinned by `version_id`": T1.3 exposes `getVersionById`/`manifest`/`getBlob(versionId, path)` and nothing resolves "served version" in SQL (core/library does).
