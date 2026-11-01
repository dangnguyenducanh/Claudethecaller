# Task: build the shared cache (L1 in-process, L2 Redis, fail-open), epoch tokens, the `ctc:inval` channel, the 7 BullMQ queues with their consumers and `dlq-retry`, and the two systemd unit files.

Callers (all built later): `apps/web` (hooks within 20 ms of Redis budget, auth key cache, rate limit, job submits, RAM reload on `ctc:inval`) and `apps/worker` (job handlers). Redis is a cache and a job carrier, never the truth: the `jobs` row in Postgres is. Untrusted: Redis contents, queue payloads, key parts built from request data. This module has no SQL: the database is reached through the `JobsPort` interface (D9), which T1.3's `repos.system.jobs` satisfies.

Public names (TypeScript, strict; exact shapes in DECISIONS.md D9):

    packages/shared/src/cache:   createCache, keys, ttl, cacheLimits, InvalMessage
    packages/shared/src/queues:  QUEUES, payloads, parsePayload, timeoutMs, bullJobId, createQueues, submitJob, queueLimits,
                             PayloadInvalidError, JobTimeoutError, JobDropped, JobsPort, JobRow
    apps/worker/src/jobs:        startWorkers, runAttempt, pollOnce, dlqRetryOnce, Handler
    deploy/systemd:          ctc-web.service, ctc-worker.service

## How to work
1. `agent/t1-4-cache-queues/DECISIONS.md` is the behaviour contract. Implement exactly that.
2. `agent/t1-4-cache-queues/PROCESS.md` is the order of work.
3. Change only `packages/shared/src/cache/`, `packages/shared/src/queues/`, `apps/worker/src/jobs/`, `deploy/systemd/` (source and `*.test.ts`). Preconditions the orchestrator provides, because you have no network: `bullmq` 5.x, `ioredis` 5.x, `zod` 4 and `vitest` are installed; env `CTC_SCRATCH_REDIS_URL` points at the scratch Redis (`redis://127.0.0.1:18395`, started by the orchestrator). Use a unique key `namespace` per test and clean only your own keys (never `FLUSHDB`).

Test naming (the self-check's `--fast` skips slow files by name): tests that need the scratch Redis are `*.int.test.ts`; pure unit tests are `*.test.ts`.

## Done
`python3 agent/t1-4-cache-queues/selfcheck.py` prints `SELFCHECK: DONE`.
