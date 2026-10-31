# Eval: switch over to the TypeScript stack

What it measures: every gate of spec §7 run once against the dev-instance environment (`CTC_HOME=<repo>/.ctc-dev`, web on port 18410, the scratch Postgres
`127.0.0.1:18304` and Redis `127.0.0.1:18395`), plus `dev-instance`, a smoke test that starts the real `ctc-web` and `ctc-worker`, runs the hook commands of
`.claude/settings.json` against them, and checks that the hooks stay quiet when the web process dies. A gate is green when its test file exits 0 and
every test under the describe named like the gate passed (a skipped describe is red). It does not measure model quality, and it does not touch the live
Python service, the real `~/.claude` or any container.

## Gates

| Gate | Area | How | Where |
| --- | --- | --- | --- |
| tenancy | System | vitest | packages/shared/src/repositories/tenancy.test.ts |
| failopen | System | vitest | apps/web/src/pre/failopen.int.test.ts |
| ci | System | bash scripts/check.sh | runs pnpm -r lint, typecheck, test and the Python and dashboard checks |
| graph.ids | F1 | vitest | packages/core/src/graph/graph.ids.test.ts |
| graph.resolve | F1 | vitest | packages/core/src/graph/graph.resolve.test.ts |
| graph.incremental | F1 | vitest | apps/worker/src/graph/graph.incremental.test.ts |
| graph.query | F1 | vitest | apps/web/src/graph/graph.query.int.test.ts |
| suggest.latency | F1 | vitest, CTC_GATE_SUGGEST=1 | apps/web/src/suggest/suggest.latency.int.test.ts |
| suggest.context | F1 | vitest, CTC_GATE_SUGGEST=1 | apps/web/src/suggest/suggest.context.int.test.ts |
| library.version | F2 | vitest | apps/worker/src/library/library.version.test.ts |
| library.mcp | F2 | vitest | apps/web/src/library/library.mcp.int.test.ts |
| library.override | F2 | vitest | apps/web/src/library/library.override.int.test.ts |
| suggest.skills | F2 | vitest, CTC_GATE_SUGGEST_SKILLS=1 | apps/web/src/skills/suggest.skills.int.test.ts |
| memory.spool | F3 | vitest | apps/web/src/spool/memory.spool.int.test.ts |
| memory.idempotent | F3 | vitest | apps/worker/src/memory/memory.idempotent.int.test.ts |
| memory.bands | F3 | vitest | apps/worker/src/memory/memory.bands.int.test.ts |
| memory.context | F3 | vitest | apps/web/src/memory/memory.context.int.test.ts |
| memory.recall | F3 | vitest | apps/web/src/memory/memory.recall.int.test.ts |
| runner.lifecycle | F4 | vitest | apps/web/src/runs/runner.lifecycle.int.test.ts |
| runner.crash | F4 | vitest | apps/worker/src/runner/runner.crash.int.test.ts |
| runner.fanout | F4 | vitest | apps/worker/src/runner/runner.fanout.int.test.ts |
| runner.idempotent | F4 | vitest | apps/web/src/runs/runner.idempotent.int.test.ts |
| runner.md | F4 | vitest | apps/worker/src/runner/runner.md.int.test.ts |
| dashboard-e2e | Dashboard | not run | O12: no frontend spec (spec §10), the dashboard rework is not built |
| dev-instance | Switch | vitest | apps/web/src/server/switch.live.int.test.ts |

## Run

```
CTC_SCRATCH_PG_URL=postgres://postgres:...@127.0.0.1:18304/postgres node .claude/metric/eval/switch/run.mjs [--list] [--only a,b] [--out file]
```

The ledger is `.ctc-dev/eval/switch.json`; the table below is rewritten by a full run.

## Results

<!-- results:start -->
| gate | area | status | passed | failed | skipped | ms |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| tenancy | System | pass | 6 | 0 | 0 | 3391 |
| failopen | System | pass | 4 | 0 | 0 | 8620 |
| ci | System | pass | 1113 | 0 | 28 | 203302 |
| graph.ids | F1 | pass | 21 | 0 | 0 | 1193 |
| graph.resolve | F1 | pass | 12 | 0 | 0 | 1124 |
| graph.incremental | F1 | pass | 3 | 0 | 0 | 1917 |
| graph.query | F1 | pass | 1 | 0 | 0 | 113222 |
| suggest.latency | F1 | pass | 2 | 0 | 0 | 75795 |
| suggest.context | F1 | pass | 1 | 0 | 0 | 45519 |
| library.version | F2 | pass | 3 | 0 | 0 | 1374 |
| library.mcp | F2 | pass | 1 | 0 | 0 | 1674 |
| library.override | F2 | pass | 2 | 0 | 0 | 2180 |
| suggest.skills | F2 | pass | 1 | 0 | 0 | 84789 |
| memory.spool | F3 | pass | 1 | 0 | 0 | 2282 |
| memory.idempotent | F3 | pass | 1 | 0 | 0 | 2368 |
| memory.bands | F3 | pass | 12 | 0 | 0 | 2584 |
| memory.context | F3 | pass | 4 | 0 | 0 | 5411 |
| memory.recall | F3 | pass | 1 | 0 | 0 | 2864 |
| runner.lifecycle | F4 | pass | 3 | 0 | 0 | 2480 |
| runner.crash | F4 | pass | 3 | 0 | 0 | 12432 |
| runner.fanout | F4 | pass | 4 | 0 | 0 | 13471 |
| runner.idempotent | F4 | pass | 2 | 0 | 0 | 1007 |
| runner.md | F4 | pass | 1 | 0 | 0 | 6306 |
| dashboard-e2e | Dashboard | not_run | 0 | 0 | 0 | 0 |
| dev-instance | Switch | pass | 1 | 0 | 0 | 5154 |
<!-- results:end -->

## Not done

- Stop the Python daemon (spec §8 T7.1): owner rule O12 forbids stopping or touching it; it keeps serving port 18310.
- Install on this machine (O12): no unit, no `~/.claude/settings.json` edit, no `claude mcp add`. The hook commands below use `$CLAUDE_PROJECT_DIR`, so they only work inside this repository.
- dashboard-e2e (O12): no frontend spec exists (spec §10); the gate is reported as `not_run` and `dashboard-e2e.md` is not created.
- T7.2 deletion of the Python code: depends on this result and on the daemon stop.
- Shared mode (D12): `ctc-web` and `ctc-worker` exit 78 in shared mode; no API-key path is wired and no rate limit applies in local mode.
- `ctc daemon` command and dashboard static serving (D23): not built; the units stay uninstalled.

## Settings

The six hook groups added to `.claude/settings.json`, next to the two `graphify hook-guard` groups that were already there. `CTC_PORT` defaults to the
production port; a dev run sets it to 18410.

- `UserPromptSubmit` (matcher `-`, timeout 1 s):

  ```sh
  LC_ALL=C curl -sf -m 0.15 -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:${CTC_PORT:-18310}/v1/hook/prompt" || true
  ```

- `PreToolUse` (matcher `Read|Edit|Write|MultiEdit|Grep|Glob|Bash`, timeout 1 s):

  ```sh
  LC_ALL=C curl -sf -m 0.05 -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:${CTC_PORT:-18310}/v1/hook/pre" || true
  ```

- `SessionStart` (matcher `-`, timeout 3 s):

  ```sh
  LC_ALL=C curl -sf -m 1.5 -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:${CTC_PORT:-18310}/v1/hook/start" || true
  ```

- `PostToolUse` (matcher `Edit|Write|MultiEdit`, timeout 2 s):

  ```sh
  "$CLAUDE_PROJECT_DIR/hooks/spool" PostToolUse 2>/dev/null || true
  ```

- `Stop` (matcher `-`, timeout 2 s):

  ```sh
  "$CLAUDE_PROJECT_DIR/hooks/spool" Stop 2>/dev/null || true
  ```

- `SessionEnd` (matcher `-`, timeout 2 s):

  ```sh
  "$CLAUDE_PROJECT_DIR/hooks/spool" SessionEnd 2>/dev/null || true
  ```

