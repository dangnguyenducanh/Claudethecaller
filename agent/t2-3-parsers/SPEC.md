# Task: build the context id parsers, the doc extract job and the capability graph nodes: pure rules in `packages/core/src/context`, wiring in `apps/worker/src/context`, three small additions to the graph repository.

Callers: the worker main binds `withContextPass(graphHandlers(..)['graph.rebuild'], ..)`, `extractHandler(..)['graph.extract']` and `withCapabilityLinks(libraryHandlers(..)['library.changed'], ..)` into `startWorkers({handlers})` (apps/worker/src/jobs, T1.4); T2.4 and T5.1 read the stored rows. Input: repo documents (specs, `.scratch`, `CLAUDE.md`, `.claude/prds|plans`), the F2 library rows (T3.1) and the stored `ast` nodes (T2.2). Untrusted: every document byte, every library file and YAML, every model reply, every `payload.files` entry.

Public names (TypeScript strict; exact shapes in DECISIONS.md D3, D9, D12, D14, D16, D22):

    packages/core/src/context (new, exported as `@ctc/core/context`; pure):
      parseContext({path, content}): ContextParse        isContextPath(path): boolean
      resolveRefs(refs, nodes, opts?): ResolvedRef[]      parseCapability(input): CapabilityParse
      buildExtractPrompt({file, text, nodes}): string     parseExtractReply(reply, {file, nodes}): ExtractReply
      contextLimits (mutable)   CONTEXT_VERSION   types
    apps/worker/src/context (new; file system, repos, queue wiring):
      contextPass(o): Promise<ContextPassResult>          withContextPass(handler, deps): Handler
      extractHandler(deps): { 'graph.extract': Handler }  spawnClaude(o?): RunClaude
      linkCapability(o): Promise<LinkResult>              syncCapabilities(o): Promise<SyncResult>
      withCapabilityLinks(handler, deps): Handler         contextWorkerLimits (mutable)   types
    packages/shared/src/repositories/graph.ts (D17): replaceSource `source` optional; deleteSource `keepSource`; edge delete by any node of the file

## How to work
1. `agent/t2-3-parsers/DECISIONS.md` is the behaviour contract. Implement exactly that.
2. `agent/t2-3-parsers/PROCESS.md` is the order of work.
3. Change only:
   - `packages/core/src/context/` (new: sources, `*.test.ts`, `__fixtures__/`). Do NOT add anything to `packages/core/src/graph/` (T2.1/T2.2 own it; its tests pin its export list) or to `packages/core/src/index.ts`.
   - `apps/worker/src/context/` (new: sources, `*.test.ts`, `__fixtures__/`).
   - `apps/worker/src/graph/rebuild.ts`: ONLY (a) the `export` keyword on `embedText`, `readText` and `sha`, (b) the `meta.embedText` override inside `embedText()` (D11). At most 12 changed lines; its tests stay unchanged and green.
   - `packages/shared/src/repositories/graph.ts` and `packages/shared/src/repositories/tenancy.cases.ts` (only the D17 changes; new `*.test.ts` files in that directory are allowed).
   Do not edit anything else: not `apps/worker/src/library`, `apps/worker/src/jobs`, `apps/worker/src/graph/{handler,walk,limits,index}.ts`, `packages/core/src/library`, the migrations, `apps/web`, package.json files or the lockfile (no new dependency: `yaml` is already a `@ctc/core` dependency, `ignore` a worker one).
   Preconditions: `kysely`, `pg`, `bullmq`, `ioredis`, `zod`, `vitest`, `tsx` and T2.1's grammar packages are installed; env `CTC_SCRATCH_PG_URL` points at the scratch Postgres (`127.0.0.1:18304` only; `selfcheck.py` sets it when unset); `migrate({url, schema})` from `@ctc/shared/repositories/admin` builds a scratch schema. Never run the real `claude` binary and never use the real `~/.claude` or this repository as a test project: every test project is a temp directory under `os.tmpdir()`, and the model is a fake `runClaude` function or a fake shell script. Dev runs use `CTC_HOME=$PWD/.ctc-dev`.

Test naming (`--fast` skips slow files by name): tests that need the scratch Postgres are `*.int.test.ts` (scratch schemas `ctc_t23_<random>`, dropped in `afterAll`); pure and file-system-only tests are `*.test.ts`.

Gate test (spec §8 T2.3 "parser fixtures", DECISIONS D21): `packages/core/src/context/parser.fixtures.test.ts` has `describe('parser fixtures')` with these `it` names: `007 spec tables`, `checklists and requirements`, `issue file and CLAUDE.md decisions`, `fences, duplicates and malformed rows`, `refs and resolution`, `capability nodes`, `extract reply`. The fixtures are real excerpts of this repository's documents (D21).

## Done
`python3 agent/t2-3-parsers/selfcheck.py` prints `SELFCHECK: DONE` (`--fast` for a quick loop; it can only print `SELFCHECK: FAST OK`).
