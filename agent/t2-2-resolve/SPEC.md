# Task: build the graph resolver (`packages/core/src/graph`, pure) and the `graph.rebuild` job (`apps/worker/src/graph`): walk, content-hash incremental rebuild, cross-file resolve, shrink guard, per-file write, deletions, epoch + `ctc:inval`, node embeddings.

Callers: the worker main binds `graphHandlers(deps)['graph.rebuild']` into `startWorkers({handlers})` (apps/worker/src/jobs, T1.4); jobs come from the spool drain (one per Edit/Write/MultiEdit, `files: [rel]`, apps/web/src/spool, T4.1), later `POST /api/graph/build` (T2.4) and `ctc graph build`. T2.4 and T5.1 read the stored rows. Input shapes are T2.1's `extractFile` output (`@ctc/core/graph`). All SQL goes through `repos.graph` / `repos.projects` / `repos.jobs` (T1.3). Untrusted: every file under the project root and every `payload.files` entry.

Public names (TypeScript strict; exact shapes in DECISIONS.md D3, D22, D24):

    packages/core/src/graph   (pure, added to index.ts):
      resolveGraph(input: ResolveInput): ResolveOutput        contentHash(relPath: string, content: string): string
      resolveLimits (mutable: maxAmbiguous, maxReexportHops)   SCORES
      types ResolveInput, ResolveOutput, ResolvedEdge, ContextNode, PackageJson, PackageNode, Reexport
    apps/worker/src/graph     (new; file system, repos, queue wiring):
      graphHandlers(deps: GraphDeps): { 'graph.rebuild': Handler }
      rebuildProject(o: { repos; ctx: {userId, projectId}; root; config; files?; force?; cache?; embed?; log?; signal?; grammars? }): Promise<RebuildResult>
      walkProject(root: string, o?: { signal?: AbortSignal }): Promise<{ files; skipped; truncated }>
      graphLimits (mutable)   PACKAGES_SOURCE = '<packages>'   types GraphDeps, GraphConfig, RebuildResult, Embed
    packages/shared/src/repositories/graph.ts:
      replaceSource keeps a node's embedding when its content_hash is unchanged; + deleteSource(ctx, {origin, sourceFile}); + pendingEmbeddings(ctx, {limit?, afterId?})
      (D22, each with its case in tenancy.cases.ts)

## How to work
1. `agent/t2-2-resolve/DECISIONS.md` is the behaviour contract. Implement exactly that.
2. `agent/t2-2-resolve/PROCESS.md` is the order of work.
3. Change only:
   - `packages/core/src/graph/` (new resolver sources, `index.ts` exports, new `*.test.ts`; do not change T2.1's extractor files or fixtures),
   - `apps/worker/src/graph/` (new: sources, `*.test.ts`, `__fixtures__/`),
   - `packages/shared/src/repositories/graph.ts` and `packages/shared/src/repositories/tenancy.cases.ts` (only the D22 additions; new `*.test.ts` files in that directory are allowed),
   - `apps/worker/package.json` and `pnpm-lock.yaml` (only `pnpm --filter @ctc/worker add --save-exact ignore@7.0.14`, already in the local store).
   Do not edit anything else: not `apps/worker/src/jobs`, `apps/worker/src/library`, `packages/shared/src/queues`, `cache`, `env`, the migrations, `admin/`, `apps/web`.
   Preconditions: `kysely`, `pg`, `bullmq`, `ioredis`, `zod`, `vitest`, `tsx` and T2.1's grammar packages are installed; env `CTC_SCRATCH_PG_URL` points at the scratch Postgres (`127.0.0.1:18304` only; `selfcheck.py` sets it when unset); `migrate({url, schema})` from `@ctc/shared/repositories/admin` builds a scratch schema. Never use the real `~/.claude` or this repository as a test project: every test project is a temp directory under `os.tmpdir()`. Dev runs use `CTC_HOME=$PWD/.ctc-dev`.

Test naming (`--fast` skips slow files by name): tests that need the scratch Postgres are `graph.incremental.test.ts` and `*.int.test.ts`; pure and file-system-only tests are `*.test.ts`. Scratch schemas are named `ctc_t22_<random>` and dropped in `afterAll`.

Gate tests (spec §7 F1, DECISIONS D23):
- `packages/core/src/graph/graph.resolve.test.ts`: `describe('graph.resolve')` with `a call becomes EXTRACTED only with an import edge` and `ambiguous names become AMBIGUOUS`.
- `apps/worker/src/graph/graph.incremental.test.ts`: `describe('graph.incremental')` with `edit 1 file → only its rows change`, `callers keep edges`, `guard trips above 20% loss`.

One `packages/shared` test (`schema-assumptions … every column the repositories use exists`) already fails on HEAD (T1.2 lacks `projects.graph_epoch`/`mem_epoch`); the self-check lists it as pre-existing and does not count it.

## Done
`python3 agent/t2-2-resolve/selfcheck.py` prints `SELFCHECK: DONE` (`--fast` for a quick loop; it can only print `SELFCHECK: FAST OK`).
