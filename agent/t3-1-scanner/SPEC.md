# Task: build the library scanner (files under the library roots → versions, labels, manifest, blobs) and the `library` queue handlers (`scan`, `changed`).

Callers (built later): the worker main binds `libraryHandlers(deps)` into `startWorkers({handlers})` (apps/worker/src/jobs, T1.4) and starts `watchLibrary`; T3.2 routes submit `library.scan` (`POST /api/index`) and `library.changed` (after a label move or pin); T3.3/T5.1 read the vectors and call `resolveServed` for project overrides. All SQL goes through `repos.library` / `repos.dedup` (T1.3). Untrusted: every file under a root, `installed_plugins.json`, the job payload. The gate is the Vitest test `library.version`: a file hash change gives version n+1 with `latest`; label moves are exclusive; parallel scans make no duplicate version.

Public names (TypeScript strict; exact shapes in DECISIONS.md D3, D9-D20):

    packages/core/src/library  (pure, no I/O):
      libraryLimits, NAME_RE, LABEL_RE, isName, isLabel, sha256Hex, parseFrontmatter, buildVersion, sameManifest, diffManifests,
      resolveServed, skillretText, cosine; types Kind, Skip, SkipCode, FileInput, BuildInput, BuildResult
    apps/worker/src/library   (file system, repos, queue wiring):
      discoverRoots({claudeHome, roots}): Promise<Root[]>
      scanLibrary({repos, ctx, roots, limits?, submit?, cache?, log?, signal?}): Promise<ScanResult>
      libraryHandlers(deps: LibraryDeps): { 'library.scan': Handler; 'library.changed': Handler }
      watchLibrary({roots, onChange, debounceMs?, log?}): { close(): void }
      types Root, ScanResult, LibraryDeps, Embed
    packages/shared/src/repositories/library.ts:  + pruneVectors(ctx, capId, keepTextHash): Promise<number>   (D19, with its tenancy case)

## How to work
1. `agent/t3-1-scanner/DECISIONS.md` is the behaviour contract. Implement exactly that.
2. `agent/t3-1-scanner/PROCESS.md` is the order of work.
3. Change only:
   - `packages/core/src/library/` (source and `*.test.ts`),
   - `apps/worker/src/library/` (source and `*.test.ts`),
   - `packages/shared/src/repositories/library.ts` and `packages/shared/src/repositories/tenancy.cases.ts` (only the D19 addition; new `*.test.ts` files in that directory are allowed),
   - `packages/core/package.json` and `pnpm-lock.yaml` (only `pnpm --filter @ctc/core add yaml@2.9.1`, the version `@ctc/shared` already pins; it is in the local store).
   Do not edit anything else: not `packages/shared/src/queues`, `cache`, `env`, `apps/worker/src/jobs`, the migrations or `admin/`.
   Preconditions the orchestrator provides: `kysely`, `pg`, `bullmq`, `ioredis`, `zod`, `yaml`, `vitest`, `tsx` are installed; env `CTC_SCRATCH_PG_URL` points at the scratch Postgres (`127.0.0.1:18304` only); `migrate({url, schema})` from `@ctc/shared/repositories/admin` builds a scratch schema. Dev runs use `CTC_HOME=$PWD/.ctc-dev`. Never read or write the real `~/.claude`: every test and fixture uses a temp directory as `claude_home`.

Test naming (the self-check's `--fast` skips slow files by name): tests that need the scratch Postgres are `library.version.test.ts` and `*.int.test.ts`; pure and file-system-only tests are `*.test.ts`. Scratch schemas are named `ctc_t31_<random>` and dropped in `afterAll`.

## Done
The gate test file `apps/worker/src/library/library.version.test.ts` has `describe('library.version')` with the three tests of DECISIONS.md D21:
`file hash change → version n+1 with latest`, `label moves are exclusive`, `parallel scans make no duplicate version`.
`python3 agent/t3-1-scanner/selfcheck.py` prints `SELFCHECK: DONE`.
