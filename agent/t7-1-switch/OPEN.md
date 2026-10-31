# T7.1 planner notes: what the owner reviews in the final PR

Drafted: `agent/t7-1-switch/` (SPEC, DECISIONS D0-D24, PROCESS, checks.mjs, selfcheck.py). YOUR-CHOICE lines: 23 (every one a default under O11; each is in the list below).
No new FROM-OWNER rule was needed. No earlier run of this planner existed (the directory was empty).
Status: `checks.mjs` and `selfcheck.py` run and FAIL cleanly (module not built: 24 of 25 ids fail; D5 passes because `hooks/spool` is untouched). `selfcheck.py --fast` prints the three missing entry
files and stops. With a throwaway settings draft (`T71_SETTINGS_FILE=<draft>`) D3, D4 and D5 pass, and three mutants of the draft (curl without `-f`, without `|| true`, without the JSON content
type) each fail D4 with the right message. D6-D20 start real processes and were never run against an implementation: expect planner mistakes in scenario bodies (timing, exact texts); triage after
the first coder run (fix the check, not the code, when a check contradicts DECISIONS.md).
Orchestrator before the coder starts: `python3 agent/t7-1-switch/selfcheck.py --snapshot`; env `CTC_SCRATCH_PG_URL=postgresql://postgres:ctcdev@127.0.0.1:18304/postgres` and `CTC_SCRATCH_REDIS_URL=redis://127.0.0.1:18395`.
The coder needs the npm registry for `pnpm add fastify @modelcontextprotocol/sdk` (O11 allows it; SPEC.md says so).
Baseline facts measured at HEAD (488a8ad) while planning: `uv run ruff check ...` and `uv run pytest -q tests` are green (152 passed, 29 skipped); `schema-assumptions.test.ts` is red (1 failed | 3 passed); the scratch
Postgres has no `ctc` schema; TEI :18300/:18301 and llama :18302 answer 200; nothing listens on 18410. `scripts/check.sh` as a whole was NOT run (it installs the dashboard and writes caches outside `agent/`).

## A. Highest risk (ordered by blast radius)
1. **There is no web or worker bootstrap at HEAD, and no task for it.** 14 earlier SPEC.md files say "the ctc-web bootstrap / worker main (built later)"; spec §8 lists none; `apps/web/src/index.ts` and `apps/worker/src/index.ts` export a name only;
   Fastify and the MCP SDK are not in the lockfile. A "dev instance on port 18410" cannot exist without them, so T7.1 (D0b, D7-D16) builds the two mains, ~10 new source files and 2 dependencies, on top of its stated job.
   This is the largest task of the build after T6.3. If the coder runs out of room, split after D3-D5 + D17 (settings, hooks tests, migration) and run D6-D16 as T7.1b, then the gate runner (D19-D22) as T7.1c. Alternative I rejected: leave
   the gates as plain Vitest runs and call that "a dev instance"; it would pass without ever starting `ctc-web`, so the hooks the file points at would never be exercised.
2. **Migration 0006 is a real production gap.** `projects.graph_epoch`/`mem_epoch` are read by `repositories/projects.ts:15,56` but no migration creates them; `scratch.ts` patches test schemas, so every suite passed except `schema-assumptions`
   (documented red since T3.1). A fresh `ctc migrate` database would fail on the first epoch read. D17 adds the migration and removes the selfcheck's `KNOWN_RED` tolerance (the ci gate is red otherwise).
3. **The `ci` gate needs more than the TS suites.** `scripts/check.sh` also runs `uv sync --frozen`, ruff, pytest, `python -m ctc.storage.store` and `ctc.storage.cache` (they need `CTC_DATABASE_URL` / `CTC_REDIS_URL` on the scratch services: D19 passes them),
   `pnpm -C dashboard install --frozen-lockfile` and `pnpm -C dashboard build` (network or a warm store), and gitleaks if installed. [UNVERIFIED HYPOTHESIS] all of that is green on this machine; proof: `bash scripts/check.sh` with the D19 env, once,
   by the orchestrator. If the dashboard install needs the network and it is down, `ci` stays red and nothing in T7.1 can fix it.
4. **Strict gates must not be skipped.** `suggest.latency` and `suggest.context` skip unless `CTC_GATE_SUGGEST=1`; `suggest.skills` skips unless the SkillRet file exists or `CTC_GATE_SUGGEST_SKILLS=1`. D19's green rule counts a skipped describe as red, and `run.mjs` sets the flags.
   `suggest.latency` is a 150 ms cold p95 over 100 prompts with the live TEI: it can fail for load reasons unrelated to the code (the shared TEI also serves the Python daemon).
5. **The hook commands are exercised against a fake server, not against Claude Code.** D4 pins the curl flags, the content type and the fail-open behaviour; whether Claude Code feeds `UserPromptSubmit` plain stdout to the model, or parses a `PreToolUse` JSON stdout as
   `hookSpecificOutput`, is from the Python install and the spec table, not verified on this machine (nothing is installed, O12).

## B. YOUR-CHOICE items (D-id: default | alternative | why it matters)
- D0 bootstrap inside T7.1 | a separate task before it | see A1.
- D2 the path list | fewer paths (no `scratch.ts`, no CLI migrate pins) | the pins fail loudly if 0006 is added without them; the list is the minimum.
- D3 PostToolUse matcher `Edit|Write|MultiEdit`; PreToolUse matcher of seven tools; timeouts 1/1/3/2/2/2 s | matcher `*` on PostToolUse; the Python four-tool PreToolUse matcher | narrow loses nothing today (the drain drops other tools) and saves a process per tool call; the seven-tool matcher gives Grep/Glob/Bash the F1 hint (spec:316-319).
- D4 `LC_ALL=C curl -sf … || true`, JSON content type, spool commands `"$CLAUDE_PROJECT_DIR/hooks/spool" EVENT 2>/dev/null || true` | `--unix-socket`; `-sS`; absolute path to the script | `-f` keeps an error JSON out of the model's context; `$CLAUDE_PROJECT_DIR` makes the file work only inside this repo (a user-level install needs an absolute path: a post-merge manual step).
- D5 no install script or wrapper for `hooks/spool` | `ctc install` rewrite | nothing may be installed (O12).
- D6 hard exit 78 outside port 18400-18499 / non-scratch database / non-scratch Redis when `CTC_HOME` is set | a convention only | the default config points Redis at the daemon's :18303 and the port at the live 18310; a missed env var would otherwise hit them while the owner sleeps.
- D7 new env `CTC_DB_SCHEMA`, `CTC_REDIS_NAMESPACE`; JSON log lines; ready line with `routes`/`handlers`; 60 s bind retry then 78 | schema/namespace only in config; text logs | the checks parse the ready line.
- D8 unix socket skipped above 100 bytes; mode 0600; health shape `{status, mode, uptime_s, db, redis}` | fail to start; a fuller health | the repo path is 64 characters, so a throwaway `CTC_HOME` under it exceeds the 107-byte limit and the socket is skipped (checks use `os.tmpdir()`).
- D9 `/api/index` mounted, `/api/schedules*` not | mount stubs | schedules stay on the Python daemon until T7.2; spec:700 says "unchanged".
- D10 hook routes accept any content type; `/api` needs JSON; 422 `invalid` for oversize | 413 | Claude Code and a hand `curl` differ on content type.
- D11 2 s outer watchdog for hooks; `500 internal` with the class name only | none | the handlers have their own budgets; this is the net under them.
- D12 shared mode exits 78; no rate limit in local mode | serve shared mode unauthenticated | no earlier task built the key path into a route layer; serving it open would be the destructive default.
- D13 Postgres down at boot: start anyway | exit 1 | spec:204 says hooks answer from RAM; under systemd a crash loop would hit `StartLimitBurst`.
- D14 stateless Streamable HTTP; SDK 1.x with a JSON-RPC subset as fallback; GET/DELETE `/mcp` 405 | sessions; SDK only | the SDK's zod 4 support is the unknown; the fallback keeps the 13 tools reachable.
- D15 refuse a schema *behind* the binary as well as a newer one; never auto-migrate | auto-migrate | a silent migration at start is a destructive default.
- D16 watchers only for roots that exist; `workflowHandlers` (not `runnerHandlers`) for `runner.step` | all roots | a missing root is the normal state of a dev `CTC_HOME`.
- D17 `bigint not null default 0` | `integer` | it is what `scratch.ts` already adds.
- D18 exact pins, published at least two weeks before 2026-10-31 | caret ranges | the other pins in the workspace are exact; the 2-week age is not machine-checked (no network in checks).
- D19 `--list` order, "no skipped" green rule, `dev-instance` as the 25th row, `ci` = `scripts/check.sh` | `ci` = the three pnpm commands only | the spec links `ci.md` with both.
- D20 the 7-step live smoke and its 15 s bounds | a shorter one | it is the only place where hook command → route → spool → job → MCP are proved together.
- D21 the banned-word list and "no 18310 in sources" | a code review | cheap, mechanical, and the owner is asleep.
- D22 `switch.md` as the single report; `dashboard-e2e.md` not created | create a stub | a stub file would look like a result.
- D23 `llm.enrich` left unregistered; no `ctc daemon`; no static dashboard | stub handler / systemctl wrapper | a stub that marks jobs done would hide a missing feature.

## C. Places two reasonable readers would differ
- "Point settings.json at the new routes and spool script": project-level (this repo's file, what the spec link says) vs user-level (`~/.claude/settings.json`, where the Python install lives). O12 forbids the latter; the file here only takes effect when someone runs Claude Code in this repo, and then it posts to :18310, which is the Python daemon until it is replaced.
  Its `/v1/hook/*` routes have the same paths, so those hooks keep working, with the Python daemon's answers.
- "Stop the Python daemon": reported as not done (O12). A reader who counts "all §7 gates green" as the Done will not need it; one who reads §8 literally will mark T7.1 PARTIAL. `switch.md` says so under "Not done".
- "all §7 gates": whether `ci` includes the Python and dashboard parts of `check.sh` (D19: yes), and whether `dev-instance` counts (it is extra, not a spec gate).
- "on a dev instance": the Vitest gates build their own dependencies; D19 gives them the dev env (`CTC_HOME`, `CTC_PORT=18410`) and D20 runs a real instance. A stricter reader would run every gate through HTTP against one instance; the gates were not written for that.
- Local-mode `userId`: `local` for every request (D12); a second user is shared mode, which exits 78.
- PreToolUse `timeout` 1 s next to `curl -m 0.05`: curl is the real bound; the settings timeout is the safety net.

## D. Findings for the orchestrator (not decisions)
- `config/server.yaml` still carries Python-era keys (`writer`, `jobs`, `history`, `graph_extract`, `redis_url: redis://127.0.0.1:18303/0`); they validate as `legacy` keys. The default Redis URL is the live daemon's: D6 exists for this.
- `deploy/systemd/*.service` run `%h/.claudethecaller/bin/ctc-web`; nothing creates that file. O9 says the units are not installed, so T7.1 does not create the wrapper either.
- `.mcp.json` (untracked in the main clone) is not in this branch; T7.1 does not register the MCP server (`claude mcp add` is a user-level action, O12).
- The `mcp__claudethecaller__*` tools visible in this session talk to the live Python daemon, not to anything built here.
