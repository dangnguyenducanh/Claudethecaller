# Open items for T1.1 and T1.2 (planner: owner review before the coders start)

YOUR-CHOICE tags in the two DECISIONS.md files: T1.1 24, T1.2 26 (50 in all). Each is listed once below with my default, the alternative, and why it matters.
`!` = I would look at it first.

## T1.1 workspace (agent/t1-1-workspace/DECISIONS.md)

| D | My default | Alternative | Why it matters |
|---|---|---|---|
| D1 ! | YAML aliases refused, core schema, no custom tags; URL values never appear in an error | allow aliases | none of today's config uses anchors; refusing removes the alias-bomb case |
| D2 | TypeScript pinned to the 6.0.x line; exact versions (`save-exact`), committed lockfile, `--frozen-lockfile` in CI | caret ranges | typescript-eslint 8.72 declares `typescript <6.1.0`, so 6.1 would break lint; Vitest 4.1, ESLint 10, Zod 4 all run on Node 22.22.1, so no O6 flag is needed |
| D2 | `eslint --max-warnings 0` | warnings allowed | a warning cannot slip into main |
| D2 | value bounds (port 1-65535, fractions in [0,1], counts ≥ 1) | no bounds | no source states bounds; they only catch typos |
| D3a | package scope `@ctc`; `core → shared`, apps → both, `shared → zod, yaml` | other names or links | every later import path depends on the names |
| D3b ! | packages run as TypeScript source on Node 22's built-in type stripping: `exports` point at `src/*/index.ts`, no build, no `dist/`, `erasableSyntaxOnly` (no enums or parameter properties), imports written with `.ts` | `tsc` or `tsup` build to `dist/` | changes how T1.4 writes the systemd units (`node apps/web/src/main.ts`), how T7.1 deploys, and rules out Node < 22.18; I tested that Node 22.22.1 runs a `.ts` file with no flag and no warning |
| D3c | `loadConfigOrExit` exits 78 (EX_CONFIG); no module cache; default dir found from the nearest `pnpm-workspace.yaml`, or `CTC_CONFIG_DIR` | exit 1; cached | T1.4 units can use `RestartPreventExitStatus=78` |
| D3d | optional `config/ctc.yaml` for the new 007 keys; `context-mode.yaml` not read | put new keys into the three existing files | decides where T2 to T6 coders add keys; the duplicate-key-across-files rule is an issue here |
| D3e | error line `config/<file>: <dotted.path>: <zod message>`, fixed `config/` prefix, sorted | absolute paths | what the operator sees at start |
| D3f ! | defaults equal today's yaml values (`embed.text skillret`, `ranking {0,0}`), not the Python-era `_DEFAULTS` | Python defaults | a missing key then behaves like the m8 flip, which is the shipped behaviour |
| D3f | `runner` also accepts the Python keys `claude_version`, `idle_wait_min`, `poll_s`; `runner.agents.<name>.argv` shape; `library.roots` default `["~/.claude"]` only | other shapes | spec.md:712 writes `{claude: {...argv}, codex: {...argv}}` and 1.6 says "plugin roots"; T6.2 and T3.1 will build on these |
| D3g | `database_url` must be a `postgres(ql)://` URL, `redis_url` `redis(s)://` | any string | catches a pasted wrong value early |
| D4 | collect all issues, unknown key is an error in the 007 sections and at the top level | first error only; ignore unknown keys | a typo like `graph.shrink_gaurd` fails the start instead of using the default |
| D5 | Python-era keys kept untyped under `config.legacy`; quoted numbers in YAML are errors (no coercion; env strings are converted) | type them all; coerce | lets Python and TS share `config/*.yaml` during the overlap |
| D10 | strict flag set, `module nodenext`, `.ts` import extensions | `bundler` resolution | tied to D3b |
| D11 | `typescript-eslint` recommended, not type-checked; ban list `pg`, `pg-pool`, `pgvector`, `kysely` (+ subpaths) by import, export-from, `import()`, `require()`; no exception for tests; message names the allowed folder | type-aware rules; test exception | spec.md:99 names only `pg` and `kysely`; I added `pgvector`/`pg-pool` because they are SQL drivers too |
| D12 ! | `scripts/check.sh` gets the three `pnpm -r` lines; one new file `dashboard/pnpm-workspace.yaml` (`packages: []`) | `--ignore-workspace` in check.sh, ci.yml and release.yml | with a root `pnpm-workspace.yaml`, `pnpm -C dashboard install --frozen-lockfile` silently installs the root workspace instead (I reproduced it: "Scope: all 2 workspace projects", no `dashboard/node_modules`); release.yml is not editable under O9 |
| D13 | no Vitest config file; tests next to code | root config with `projects` | fewer files |

## T1.2 migrations (agent/t1-2-migrations/DECISIONS.md)

| D | My default | Alternative | Why it matters |
|---|---|---|---|
| D1 | source DB opened read-only; the SELECT-only-role check proves it | trust the code | O3/O7: Python must keep running |
| D2 | names `NNNN_name.sql`, contiguous from 1; 200-row batches; no statement timeout of ours | gaps allowed | later tasks add `0006_…` |
| D3c | CLI by `node:util parseArgs`, no framework; hidden `--dir` flag for tests; `--status` exits 1 unless up to date | commander/citty | no other task owns the other `ctc` commands (see below) |
| D4 | all file problems listed together; refuse in both directions (`schema_too_new` and `schema_behind`); unmapped enum values abort the import before any write | only older-binary refusal; skip rows | spec.md:134 requires only the older-binary case; a newer binary on an older DB would otherwise fail later with a missing table |
| D10 ! | tenant tables all carry `user_id` (added to graph_edges, graph_sources, jobs, idempotency_keys, history_files, dedup_review, session_summaries, wf_schedules) | follow the spec's column lists literally | the `tenancy` test (T1.3) cannot hold without it |
| D10 ! | `idempotency_keys` PK `(user_id, key)`; `session_summaries` unique `(user_id, content_hash)` | spec's global `key PK` and `unique(content_hash)` | global keys let one user's row replay or block another's |
| D10 ! | `projects` has `root` (spec) **and** keeps `name` unique per user, `embedding`, `last_active` (Python); `sessions` keeps `title, source, status, git_branch, processed_at`, drops `turns`; `jobs.id` is text; `overrides.project_id` NULL = all projects; `workflow_cap_id` nullable; `capabilities` gets `removed_at` and `enrichment jsonb`; `cap_vectors.model`; `wf_runs`/`wf_steps.legacy jsonb`; `unaccent` extension kept | spec columns only | spec says "unchanged" for projects/sessions but lists columns that differ from Python (`root` vs `path`); the dashboard keys projects by unique name (CLAUDE.md 2026-10-21); the A1 enrichment is expensive local-LLM output |
| D11 | tenancy-prefixed edge indexes; a trigger enforces "a label sits on one version per capability" | app-level `FOR UPDATE` only | spec.md:389 states the rule, spec.md:420 only the lock |
| D12 | five migration files, one per feature | one big file | later tasks add files instead of editing |
| D13 | capability id = `md5(user\|ns\|kind\|name)::uuid`; `root_path` = dirname of the Python path; file content = body only; all `cap_vectors` rows kept | text ids; keep only the newest vector | deterministic ids make the import idempotent; see "first scan" below |
| D13 | origin map `graphify→ast`, `embed→parser`, `claude-mem→session`; relation, type and ids copied verbatim; `graph_sources`, `jobs`, `decisions`, `events` not imported; `sessions.summary` dropped; `overrides '*'`→NULL, `disable`→`block` | rename relations and types now | T2.x/T2.3 decide the vocabulary; I did not guess |
| D13 | duplicate memories after the new hash: keep a live row, then the newest; redirect `superseded_by` | fail on duplicates | the dev copy has none; Supabase may |
| D14 | import is one transaction, idempotent, `--dry-run` rolls back | per-table commits | a half-imported target is the worst case |
| D15 ! | `memoryHash` = sha256 of NFKC, trimmed, whitespace-collapsed, lower-cased text, exported from `packages/shared/src/memory-hash` | keep `sha256(text)` | spec says "recomputed" without saying how; T4.2 must import this function, not write its own |
| D16 | test env `CTC_TEST_ADMIN_URL`, optional `CTC_TEST_PY_COPY_URL`; databases and roles named `ctc_t12_*`, dropped after | one shared scratch schema | keeps the existing `ctc`, `ctc_qc` databases untouched |

## Places where two reasonable readers differ (not a YOUR-CHOICE; need an owner word)

1. **! Supabase: both stacks want schema `ctc`.** Spec 1.4 puts the TS tables in schema `ctc`; Python's tables are already `ctc` in the same Supabase database, with different layouts. The importer refuses when source and target are the same database and schema (`same_schema`). T7.1 therefore needs a step the spec lacks: rename Python's schema first (`alter schema ctc rename to ctc_py`, which breaks the Python daemon at that moment) or give the TS schema another name (`--schema` exists; T1.3's pool would need the same name, and there is no config key for it).
2. **! No-build TypeScript (T1.1 D3b).** Tell me if you want a compiled `dist/` instead; T1.4's units and T7.1 depend on it.
3. **! Which Python data T1.2 is proven on.** O7 says "a pg_dump copy in the scratch DB". `ctc-dev-pg` database `ctc`, schema `ctc` already holds a dev copy (2 projects, 52 memories, 2,041 nodes, 5,508 edges, 21 dedup rows, but 1 capability and no workflow rows). The planned proof uses that copy (read-only) plus a synthetic fixture with every table filled. If you want a fresh `pg_dump` of Supabase (a read of Supabase, which O7 forbids until T7.1), someone has to make it.
4. **First scan after migrate.** Python rows hold the body without its frontmatter, so version 1 is built from columns; unless T3.1 hashes the same way, the first scan makes version 2 of every capability.
5. **`root_path` for single-file agents and commands** is the folder (`~/.claude/agents`); a restore writes files relative to it. T3.1/T3.2 may want the file path instead.
6. **Relation and type vocabulary.** Python has `implemented_in`, `indirect_call`, types `rationale`, `plan_step`, `ticket`, `story`; the spec lists `implements` (opposite direction) and other node types. Rows carry over untouched, so T2.3 must migrate them.
7. **`graph_sources` is not carried over**, so the first TS graph build re-extracts every file and may re-embed ~2,000 nodes if its `content_hash` differs from Python's.
8. **`decisions`/`events` archive.** Spec 1.4 attributes the export to `ctc migrate --from-python`; the task list gives it to T0.3. The importer only warns (`archive_missing`).
9. **T1.3 `tenancy` test must skip `repositories/admin/`** (migration and import functions take no `ctx`).
10. **Parallel merge conflicts.** T1.2, T1.3 and T1.4 each add dependencies to `packages/shared/package.json` and `pnpm-lock.yaml`; and T1.2 to T1.4 all need T1.1 merged into `ctc-007-build` before their branches are cut (O5), otherwise T1.2's selfcheck prints `SELFCHECK: BLOCKED`.
11. **Who owns the other `ctc` commands?** `apps/cli` has no task in spec §8 besides `migrate` here; the `ctc` bin name also collides with the Python console script once both are on PATH.
12. **Spec text vs O6.** spec.md:61-62 still says Node 24.22 / pnpm 12 (nvm has Node 24.22.1 installed); with `engine-strict` a `pnpm install` under Node 24 will fail by design.
13. **Coder brief.** The fixed brief says "do not use the network" and "only run that python"; T1.1 needs the npm registry, T1.2 needs `psql`/`node`/`pnpm` and the scratch Postgres on 127.0.0.1:18304. The brief must say so for these two tasks. The scratch Redis on :18395 (O7) is not needed by T1.1 or T1.2.
14. **Scope check.** `agent/`, `specs/` and `.claude/agents` are untracked in this worktree, so `selfcheck.py` ignores them. To catch edits to the contract, write `sha256sum SPEC.md DECISIONS.md PROCESS.md checks.* selfcheck.py > .contract.sha256` in each task folder before the coder starts; selfcheck verifies it when present.
15. **Checks are written without a module to run on.** `checks.mjs` for both tasks fails cleanly now (T1.1: 44 FAIL, T1.2: 46 FAIL + 2 SKIP in `--fast`, no leftover `ctc_t12_*` objects). Neither has been run against a working implementation, so a wrong expectation in a check is still possible; run them against the first coder result and fix the decision, not the code.
