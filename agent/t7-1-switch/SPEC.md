# Task: switch the repo to the new stack: wire `.claude/settings.json` hooks to the new routes and `hooks/spool`, build the two process mains the units name, add migration 0006, and run every spec §7 gate on a dev instance.

Callers: Claude Code runs the six hook commands (D3, D4); systemd or a human runs `ctc-web` (`apps/web/src/server/main.ts`) and `ctc-worker` (`apps/worker/src/boot/main.ts`); CI runs `scripts/check.sh`; the final PR reviewer reads `.claude/metric/eval/switch.md`.
The mains compose what T1.3 to T6.3 built (repositories, cache, queues, route and tool factories, handlers); they add no business logic. Untrusted: every hook body, route param, MCP argument, env value and spool file (DECISIONS D1).
Owner rules that bind this task (agent/OWNER.md O12): the Python daemon (:18310) and the containers (:18300-18306) are never stopped or touched; nothing is written to the real `~/.claude`, `~/.claudethecaller` or Supabase;
`.claude/settings.json` changes in the branch only; dev runs use `CTC_HOME=$PWD/.ctc-dev`, web port 18410, others 18411+; the dashboard-e2e gate is reported as not run. "Stop the Python daemon" (spec §8 T7.1) is therefore reported as not done.

Public names (exact shapes in DECISIONS.md D3, D4, D7, D14, D16, D19, D20):

    .claude/settings.json                              six new hook commands next to the two graphify groups (D3, D4)
    apps/web/src/server/main.ts      #!/usr/bin/env node   bin `ctc-web`      ready line {"msg":"ready","app":"ctc-web","port":n}
    apps/web/src/server/*.ts         app composition (Fastify 5), MCP adapter (`/mcp`), guards; unit tests beside them
    apps/worker/src/boot/main.ts     #!/usr/bin/env node   bin `ctc-worker`   ready line {"msg":"ready","app":"ctc-worker","handlers":[...]}
    packages/shared/migrations/0006_epochs.sql         projects.graph_epoch, projects.mem_epoch
    .claude/metric/eval/switch/run.mjs                 node run.mjs [--list] [--only a,b] [--out file]  -> one row per gate
    .claude/metric/eval/switch.md, .claude/metric/eval/ci.md   the reports (D22)

## How to work
1. `agent/t7-1-switch/DECISIONS.md` is the behaviour contract. Implement exactly that.
2. `agent/t7-1-switch/PROCESS.md` is the order of work.
3. Change only the paths of DECISIONS.md D2 (and new `*.test.ts` files inside them). Never edit an earlier task's source, `hooks/spool`, `dashboard/`, `src/` (Python), `deploy/`, `config/`, `apps/cli` source or anything under `agent/`.
   Preconditions the orchestrator provides: dependencies installed (`pnpm install --frozen-lockfile` done); the npm registry is reachable for `pnpm add` of exactly `fastify` and `@modelcontextprotocol/sdk` (O11); the scratch Postgres
   `127.0.0.1:18304` (env `CTC_SCRATCH_PG_URL`, `CTC_TEST_DATABASE_URL`, `CTC_TEST_ADMIN_URL`), the scratch Redis `127.0.0.1:18395` (env `CTC_SCRATCH_REDIS_URL`), the TEI embedder `:18300`, reranker `:18301` and llama-server `:18302` are running (use, never restart);
   `git`, `/bin/sh`, `curl`, `psql` and `node` are on PATH. You may start `ctc-web`/`ctc-worker` only with `CTC_HOME` under this repository's `.ctc-dev/` and a port from 18410-18499. Nothing else may be started or contacted. Never connect to 18310, Supabase or any container,
   never read or write `~/.claude` or `~/.claudethecaller`, never use `pkill -f` (kill the process ids your own test started), never `git push`, never run `systemctl`. Run every test command under `timeout`.

Test naming (the self-check's `--fast` skips slow files by name): tests that need the scratch Postgres, Redis or child processes are `*.int.test.ts`; pure tests are `*.test.ts`. Scratch schemas are named `ctc_t71_<random>` and dropped in `afterAll`; temp dirs start with `ctc-t71-`;
every process a test starts is killed in `afterAll`.

## Done
All spec §7 gates are green on the dev instance (D19), with `dashboard-e2e` reported as `not_run` (O12). Their names, recorded one row each by `.claude/metric/eval/switch/run.mjs` in `.ctc-dev/eval/switch.json` and in the Results table of `.claude/metric/eval/switch.md`:
`tenancy`, `failopen`, `ci` (`.claude/metric/eval/ci.md`: `pnpm -r lint && pnpm -r typecheck && pnpm -r test` + `scripts/check.sh`);
F1 `graph.ids`, `graph.resolve`, `graph.incremental`, `graph.query`, `suggest.latency`, `suggest.context`; F2 `library.version`, `library.mcp`, `library.override`, `suggest.skills`;
F3 `memory.spool`, `memory.idempotent`, `memory.bands`, `memory.context`, `memory.recall`; F4 `runner.lifecycle`, `runner.crash`, `runner.fanout`, `runner.idempotent`, `runner.md`; Dashboard `dashboard-e2e` (not run);
plus T7.1's own `dev-instance`.
The gate tests that T7.1 writes are Vitest files with exactly these names (the self-check greps for them):
- `apps/web/src/server/switch.settings.test.ts`: `describe('switch.settings')`, `it('keeps the two graphify groups and adds exactly the six hook groups')`, `it('runs each hook command against a fake server and fails open')`;
- `apps/web/src/server/switch.web.int.test.ts`: `describe('switch.web')`, `it('mounts the expected route table and refuses a duplicate')`, `it('answers a bad hook body with an empty 204')`, `it('lists exactly the 13 MCP tools')`;
- `apps/worker/src/boot/switch.worker.int.test.ts`: `describe('switch.worker')`, `it('registers exactly the 12 handler keys')`;
- `apps/web/src/server/switch.live.int.test.ts`: `describe('switch.live')`, `it('runs hooks, spool, MCP and fail-open against a real dev instance on port 18410')`;
- `apps/web/src/server/switch.gates.test.ts`: `describe('switch.gates')`, one `it('<gate> is green')` per D19 name except `dashboard-e2e`, plus `it('dashboard-e2e is reported as not run')`; each reads `.ctc-dev/eval/switch.json`.
`python3 agent/t7-1-switch/selfcheck.py` prints `SELFCHECK: DONE`.
