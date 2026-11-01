# Task: build the F1 pre-tool hook: `POST /v1/hook/pre` (a file note for Read/Edit/Write/MultiEdit, a graph hint for Bash grep/rg/find, Grep and Glob, with per-session caps), the pure note and hint core, and the gate `failopen`.

Callers (built later): the ctc-web bootstrap mounts `preRoutes(deps)` with the RAM graph store (T2.4) it already holds and wires `onToolCall` of the graph tools to `caps.markGraphCall`; Claude Code's PreToolUse hook posts
`{session_id, cwd, tool_name, tool_input, ...}` there (`curl -m 0.05`, T7.1 wires `.claude/settings.json`). The same code answers from RAM only: no TEI, no Redis write, no Postgres write. Everything on the wire is untrusted: the body
(tool names, paths, shell commands), every label, path and id read from the RAM graph. The hook never errors (any failure is an empty `204` within 40 ms) and never blocks a tool (the reply carries `additionalContext` only).
The gate is the Vitest test `failopen`: with TEI, Redis or Postgres down, the prompt hook (T5.1, already merged) and this pre hook still reply within their budgets.

Public names (TypeScript strict; exact shapes in DECISIONS.md D3, D9, D17):

    packages/core/src/graph/note/index.ts   (`@ctc/core/graph/note`, pure, no I/O, new directory):
      noteLimits, HINT_TYPES, relInside(root, p), searchTerms(tool, input, { root }), fileNote(index, rel, { max, maxChars }), hintLine(index, terms, { maxNodes, maxChars })
    packages/shared/src/schemas/pre/index.ts   (`@ctc/shared/schemas/pre`, Zod only, new directory):
      PreBody, preApiLimits
    apps/web/src/pre/index.ts:
      createPre(deps: PreDeps): Pre                      (Pre = { run(ctx, input, opts?): Promise<PreResult> })
      preRoutes(deps: PreDeps): Route[]                  (exactly one route: POST /v1/hook/pre)
      createSessionCaps(o?: { now?(): number }): SessionCaps
      preLimits; types Pre, PreDeps, PreResult, SessionCaps
    Also in apps/web/src/pre/: testing.ts (fakes and the gate helpers), fixtures/.

## How to work
1. `agent/t5-2-pre/DECISIONS.md` is the behaviour contract. Implement exactly that.
2. `agent/t5-2-pre/PROCESS.md` is the order of work.
3. Change only these paths (source, `*.test.ts`, fixtures):
   - `packages/core/src/graph/note/` (new),
   - `packages/shared/src/schemas/pre/` (new),
   - `apps/web/src/pre/` (new),
   - new `*.test.ts` files in `apps/web/src/graph/` (the wiring test of DECISIONS.md D22 only; do not edit any existing file there).
   No new dependency, no `package.json`, lockfile, ESLint or tsconfig change, no Python change, no edit of any existing file. Do not edit any existing `index.ts` (`packages/core/src/graph/index.ts`, `packages/core/src/graph/push/index.ts`,
   `apps/web/src/graph|suggest|skills|memory|library/index.ts`): earlier tests pin their export lists. Reuse what exists (`slotOf` from `@ctc/core/graph/push`; `lexicalSeeds`, `nodeRef`, `GraphIndex` from `@ctc/core/graph/query`; inside
   `packages/core/src/graph` you may import `../query/model.ts` helpers `clean`, `keyOf`, `weightOf`, `byCode`); `projectOf`, `rootOf`, `isAbs`, `errClass` from `apps/web/src/memory/common.ts`; `Route` from `apps/web/src/library/http.ts`;
   `keys`, `ttl` are not needed. SQL only through `@ctc/shared/repositories` (never import `pg` or `kysely` outside `packages/shared/src/repositories`; ESLint bans it).
   Preconditions the orchestrator provides, because you have no network: dependencies installed; the scratch Postgres `127.0.0.1:18304` (env `CTC_SCRATCH_PG_URL`), the scratch Redis `127.0.0.1:18395` (env `CTC_SCRATCH_REDIS_URL`), the shared TEI
   embedder `127.0.0.1:18300` running (use, never restart). Unit tests use hand-made graphs (`buildIndex` from `@ctc/core/graph/query`) and fake `repos`, `graph`, `cache`; only `*.int.test.ts` files may call the real TEI, Postgres or Redis.
   Never read or write the real `~/.claude`, `~/.claudethecaller`, port 18310, or any service other than those three.

Test naming (the self-check's `--fast` skips slow files by name): tests that need Postgres, Redis or the real TEI are `*.int.test.ts`; pure tests are `*.test.ts`. Scratch schemas are named `ctc_t52_<random>` and dropped in `afterAll`.

## Done
The gate test file exists with exactly these names (DECISIONS.md D21):
- `apps/web/src/pre/failopen.int.test.ts`: `describe('failopen')` with four tests, each named `it('<dependency> down ...')` as listed in D21;
and it PASSES (not skipped; it needs no switch, it always runs and fails with its reason when a scratch service is missing).

`python3 agent/t5-2-pre/selfcheck.py` prints `SELFCHECK: DONE`.
