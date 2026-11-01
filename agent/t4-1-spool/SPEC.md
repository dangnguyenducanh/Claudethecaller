# Task: build `hooks/spool` (POSIX sh: hook stdin → one atomic spool file → 250 ms background nudge) and the spool drain in `apps/web/src/spool` (Zod-parse each file, route it to a job, delete it once the job is queued), so no PostToolUse, Stop or SessionEnd event is lost while ctc-web is down.

Callers: Claude Code runs `hooks/spool` for PostToolUse, Stop and SessionEnd (wired in `.claude/settings.json` by T7.1, not here). The ctc-web bootstrap (built later) calls `createSpoolDrain(...)`, `start()` at boot, mounts `nudgeRoute(drain)` at `POST /v1/spool/nudge`, and `close()` at shutdown. The jobs it makes are consumed by T2.2 (`graph.rebuild`) and T4.2 (`llm.extract`, `llm.summarize`). Untrusted: everything on the hook's stdin, every byte of every spool file, every file name in the spool directory. The gate is the Vitest test `memory.spool`: web down → files → web up → each event processed once; a corrupt file lands in `corrupt/`.

Public names (TypeScript strict; exact shapes in DECISIONS.md D9):

    hooks/spool                                  // POSIX sh, executable; `hooks/spool [EventName] < hook-json`
    packages/shared/src/spool (`@ctc/shared/spool`):  SpoolFileSchema, spoolFieldLimits, EDIT_TOOLS
    apps/web/src/spool:  createSpoolDrain(deps: SpoolDeps): SpoolDrain   // { start, drainOnce, nudge, close }
                         nudgeRoute(drain): { method: 'POST'; url: '/v1/spool/nudge'; handler(req, reply) }
                         spoolLimits                                       // module constants, read at call time
                         type DrainReport = { queued; dropped; corrupt; kept; expired }

## How to work
1. `agent/t4-1-spool/DECISIONS.md` is the behaviour contract. Implement exactly that.
2. `agent/t4-1-spool/PROCESS.md` is the order of work.
3. Change only `hooks/spool`, `apps/web/src/spool/`, `packages/shared/src/spool/` (source and `*.test.ts`). No new dependency, no `package.json` or lockfile change: `zod` is reached through `@ctc/shared/spool`, BullMQ through `@ctc/shared/queues`, SQL through `@ctc/shared/repositories` (never import `pg`/`kysely`; ESLint bans it). Preconditions the orchestrator provides, because you have no network: dependencies installed; the scratch Postgres `127.0.0.1:18304` (env `CTC_SCRATCH_PG_URL`) and the scratch Redis `127.0.0.1:18395` (env `CTC_SCRATCH_REDIS_URL`) are running. Tests create their own schema `ctc_t41_<random>` with `migrate({url, schema})` from `@ctc/shared/repositories/admin` and drop it (`db.kysely.schema.dropSchema(s).ifExists().cascade().execute()`); BullMQ keys use a namespace `t41<random>:` and are removed with `obliterate({force: true})`; spool dirs are `mkdtemp(os.tmpdir()/ctc-t41-)` and removed. Never touch `~/.claudethecaller`, `~/.claude`, port 18310 or any other service.

Test naming (the self-check's `--fast` skips slow files by name): the gate test is `apps/web/src/spool/memory.spool.int.test.ts` with a top-level `describe('memory.spool', …)`; every test that needs Postgres or Redis is `*.int.test.ts`; pure unit tests (script-only, fakes) are `*.test.ts`.

## Done
`python3 agent/t4-1-spool/selfcheck.py` prints `SELFCHECK: DONE`. It runs the gate test `memory.spool` (spec §4.8, §7 F3), the module tests, `checks.mjs`, `pnpm -r lint`, `pnpm -r typecheck`, `pnpm -r test`, `sh -n`/`dash -n` on `hooks/spool`, and the scope check.
