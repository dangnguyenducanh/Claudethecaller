# Task: build the F1 prompt hook: `POST /v1/hook/prompt` and `POST /v1/suggest` (three seed channels, walk, rank, render, `sug:` cache), plus the pure ranking and rendering core, and the gates `suggest.latency` and `suggest.context`.

Callers (built later): the ctc-web bootstrap mounts `suggestRoutes(deps)` with the RAM graph store (T2.4) and the skill channel (T3.3) it already holds; Claude Code's UserPromptSubmit hook posts the prompt there (`curl -m 0.15`, T7.1 wires
`.claude/settings.json`); `evaluation/` and the dashboard call `/v1/suggest`. T5.2 later adds the file note beside this code. Everything on the wire is untrusted: the body, every label read from the RAM graph, every skill name, every TEI reply,
every cached value. The hook never errors (any failure is an empty `204` within 140 ms); `/v1/suggest` answers `422` for a bad body and `503` when the embedder is down. The gates are the Vitest tests `suggest.latency` and `suggest.context`.

Public names (TypeScript strict; exact shapes in DECISIONS.md D3, D9, D14, D15):

    packages/core/src/graph/push/index.ts   (`@ctc/core/graph/push`, pure, no I/O, new directory):
      SEED_TYPES, slotOf(node), rankSlots(index, { seeds, skills, depth, perSlot }): Slots, renderLine(slots, { maxChars }): string; types SkillSeed, Cand, Slots
    packages/shared/src/schemas/suggest/index.ts   (`@ctc/shared/schemas/suggest`, Zod only, new directory):
      SuggestBody, suggestApiLimits
    apps/web/src/suggest/index.ts:
      createSuggest(deps: SuggestDeps): Suggest          (Suggest = { run(ctx, { prompt, cwd }, opts?): Promise<SuggestResult> })
      suggestRoutes(deps: SuggestDeps): Route[]          (POST /v1/hook/prompt, POST /v1/suggest, in this order)
      suggestLimits; types Suggest, SuggestDeps, SuggestResult
    Also in apps/web/src/suggest/: testing.ts (fakes and the gate helpers: snapshot extraction, scratch graph build), fixtures/.

## How to work
1. `agent/t5-1-suggest/DECISIONS.md` is the behaviour contract. Implement exactly that.
2. `agent/t5-1-suggest/PROCESS.md` is the order of work.
3. Change only these paths (source, `*.test.ts`, fixtures):
   - `packages/core/src/graph/push/` (new),
   - `packages/shared/src/schemas/suggest/` (new),
   - `apps/web/src/suggest/` (new),
   - `apps/web/src/library/http.ts` (only: `model_unavailable` → 503 in `ErrorCode` and `STATUS`),
   - `apps/web/src/memory/common.ts` (only: the narrower first parameter type of `projectOf`, DECISIONS.md D23),
   - new `*.test.ts` files in `apps/web/src/library/` and `apps/web/src/memory/` (for those two edits).
   No new dependency, no `package.json`, lockfile, ESLint or tsconfig change, no Python change. Do not edit any existing `index.ts` (`packages/core/src/graph/index.ts`, `apps/web/src/graph|skills|memory|library/index.ts`): earlier
   tests pin their export lists. `fetch`, `AbortSignal`, `node:child_process` and `node:fs` are Node's; the cache, TEI client and config types come from `@ctc/shared/cache|tei|env`; SQL only through `@ctc/shared/repositories`
   (never import `pg` or `kysely` outside `packages/shared/src/repositories`; ESLint bans it).
   Preconditions the orchestrator provides, because you have no network: dependencies installed; the scratch Postgres `127.0.0.1:18304` (env `CTC_SCRATCH_PG_URL`), the scratch Redis `127.0.0.1:18395` (env
   `CTC_SCRATCH_REDIS_URL`), the shared TEI embedder `127.0.0.1:18300` running (use, never restart); `git` and `tar` on PATH; `.ctc-dev/eval/skillret-test.json` written by `python3 agent/t5-1-suggest/selfcheck.py --export` (the full
   self-check writes it when missing). Unit tests use hand-made graphs (`buildIndex` from `@ctc/core/graph/query`), fake `repos`, `tei`, `graph`, `skills`, `cache`; only `*.int.test.ts` files may call the real TEI, Postgres or Redis.
   Never read or write the real `~/.claude`, `~/.claudethecaller`, port 18310, or any service other than those three.

Test naming (the self-check's `--fast` skips slow files by name): tests that need Postgres, Redis or the real TEI are `*.int.test.ts`; pure tests are `*.test.ts`. Scratch schemas are named `ctc_t51_<random>` and dropped in `afterAll`.

## Done
The two gate test files exist with exactly these names (DECISIONS.md D21, D22):
- `apps/web/src/suggest/suggest.latency.int.test.ts`: `describe('suggest.latency')` with `it('cold p95 of /v1/suggest over 100 SkillRet prompts is at most 150 ms')` and
  `it('L1 hit p95 of /v1/suggest over the same prompts is at most 10 ms')`;
- `apps/web/src/suggest/suggest.context.int.test.ts`: `describe('suggest.context')` with `it('n8n-parity test tickets 09-16: file recall@3 of the suggest candidates is at least the m6 number 0.750')`;
and both PASS (not skipped) under `CTC_GATE_SUGGEST=1`.

`python3 agent/t5-1-suggest/selfcheck.py` prints `SELFCHECK: DONE`.
