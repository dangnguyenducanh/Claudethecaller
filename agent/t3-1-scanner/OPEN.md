# T3.1 planner notes: what the owner reviews in the final PR

Drafted: `agent/t3-1-scanner/` (SPEC, DECISIONS D0-D21, PROCESS, checks.mjs, selfcheck.py). YOUR-CHOICE lines: 20 (every one is a default under O11).
Status: `checks.mjs` and `selfcheck.py` run and FAIL cleanly (module not built; `CTC_SCRATCH_PG_URL` unset). The checks were never run against an
implementation (none exists): expect a few planner mistakes in them; triage after the first coder run (fix the check, not the code, when the
check contradicts DECISIONS.md).

## A. Highest risk (ordered by blast radius)
1. **Bad YAML is skipped, as the spec says (D4, D12; spec:449).** Real Claude Code skills often have headers YAML rejects (an unquoted
   `description: … Triggers on: …` is "Nested mappings are not allowed", checked with yaml 2.9.1). Such skills never get a version until fixed.
   Default: skip with `bad_yaml`. Alternative: a lenient fallback (flat `key: value` lines) for name/description only. Matters for coverage of
   `suggest.skills` (T3.3) on a real `~/.claude`.
2. **Shared mode never scans (D1a).** The scan handler reads the host file system only for `userId = local` in `mode = local`
   (`JobDropped('scan_not_local')` otherwise), so user B cannot get the host's `~/.claude` copied into B's library. The spec does not say how
   remote users' files reach the library at all. Alternative: scan for any user (leaks host files across users).
3. **`library.changed` is partial (D7, D17).** It recomputes `served_version`, embeds the served version (only when an `embed` function is
   injected), prunes old vectors, writes dedup pairs and publishes `ctc:inval`. It does NOT submit `llm.enrich` (no consumer yet: the job would
   end `dead`) and does NOT upsert the capability graph node (T2.3). Someone must wire `embed` (a TEI client) in the worker main, add enrich
   once its handler exists, and add the graph node in T2.3; otherwise vectors stay empty.

## B. YOUR-CHOICE items (D-id: default | alternative | why it matters)
| D | Default | Alternative | Why it matters |
|---|---|---|---|
| D1b | `payload.roots` ignored; roots always come from config + `installed_plugins.json` | honour roots that are a subset of the discovered ones | a payload must never point the scanner at `/etc`; the subset rule needs namespace-level bookkeeping for removals |
| D1d/e | outside symlinks, dot-entries (`.env`, `.git`), `node_modules`, `__pycache__` never stored | store everything under the skill dir | secrets in blobs reach Postgres and MCP replies |
| D2 | limits inclusive, counted from `stat` before reading, binary files counted | count only stored files | a skill with a big binary is skipped as `too_large` |
| D3 | skipped capabilities go to `jobs.result.skipped`, the job is `done` | fail the job (`jobs.error`, spec:449 wording) | a failed job retries 3x, goes `dead`, then `dlq-retry` re-runs it 5x for a file only the user can fix |
| D4 | first failing check is the only code; fixed order | report every problem | dashboard message detail |
| D5 | no frontmatter / empty or non-string description is valid (`''`) | require a description (Claude Code does for skills) | more capabilities are versioned; empty descriptions embed poorly |
| D6c/D14.6 | removal only for fully walked namespaces; skipped capabilities (and same-rootPath skills) are protected | remove whatever was not versioned | a broken YAML or an unmounted plugin root must not hide capabilities |
| D7 | no project `.claude` roots, no `plugin.json`-declared paths, no nested `commands/<dir>/` | scan them (Python did project roots and plugin.json paths) | project-local skills and namespaced commands are missing from the library |
| D9 | pure code in `packages/core/src/library`, file walking in `apps/worker/src/library`; `yaml` added to `@ctc/core` | file walk behind a port inside core | code map says core does "scan" but also "core is pure" (spec:95 vs spec:99) |
| D10 | namespaces `user`, `<plugin>` (key before `@`), `root@<sha8>` for other configured roots | plugin key with marketplace; root basename | two plugins with the same name from two marketplaces share a namespace (the second copy is `duplicate_name`) |
| D11 | globs `skills/*/SKILL.md`, `agents/*.md`, `commands/*.md`, `ctc-workflows/*.{yaml,yml,json}`, `workflows/*.{yaml,yml,json,md}`; rootPath = dir as found | resolved real paths | T3.2 restore writes to `root_path`; through a symlinked skill dir it writes into the link target |
| D11 | name = frontmatter `name`, else dir/file stem; names failing `^[a-z0-9]+(-[a-z0-9]+)*$` are skipped `bad_name` | lowercase-normalise | uppercase or underscore names (some real skills) are skipped |
| D13 | non-UTF-8 or NUL files left out with `binary_file`; content keeps the BOM; `bodyHash` = sha256 of the main body (whole text for yaml/json workflows) | base64 blobs | restore (T3.2) cannot bring back binary files |
| D14 | commit message `scan`; changed job id `library.changed:<capId>:<version>`; a submit failure is logged, not fatal | fail the scan | the version is already committed; the deterministic id makes a resubmit idempotent |
| D14 | `restore v<n>` commit message not produced here (T3.2) | detect "manifest equals version k" in the scanner | spec:426 wants it; T3.2 must pass it or the scanner must detect it |
| D15 | no own lock; relies on `createVersion`'s advisory lock + re-check | an in-process mutex | parallel scans are correct across processes only through the DB lock |
| D16 | `served_version` column ignores overrides; dangling pin falls through; highest version as last fallback | column includes the global override | T3.2/T5.1 must resolve project overrides at read time with `resolveServed` |
| D17 | dedup threshold strict `>`; `embed` optional; inval published on every non-skipped run | `>=`; embed required | without an injected embedder nothing is embedded (silently) |
| D19 | adds `repos.library.pruneVectors` + tenancy case (edits T1.3's module) | leave stale vectors (T3.3 filters) | `cap_vectors` keeps one row per old text otherwise; RAM loader would load duplicates of one capability |
| D20 | `fs.watch` recursive, trailing debounce 3 s, dot/`node_modules` paths ignored | chokidar; polling | [UNVERIFIED] Node 22 recursive `fs.watch` on Linux may miss events inside directories created during a burst; proof: checks.mjs D20 on this host |
| D21 | gate test in `apps/worker/src/library/library.version.test.ts`, schema `ctc_t31_<random>` | under packages/core | the gate needs Postgres and the scanner; core is pure |

## C. Places where two reasonable readers differ
- spec:449 "skipped with `jobs.error`" vs a job that also versioned every other capability: `done` with a skipped list here (D3).
- spec:414 "a file that disappeared marks the capability removed": per capability (all its files gone / `SKILL.md` gone) here, not per file; a
  multi-file skill that loses one reference file gets a new version without it.
- spec:390 "project override → production → latest" vs one `served_version` column per capability: the column is override-free (D16).
- spec:437 roots "plugin roots from ~/.claude/plugins": read from `installed_plugins.json` `installPath` (the Claude Code file), not by listing
  `~/.claude/plugins/*`.
- spec:416 SKILLRET text "`name | description | body`": body = the main file after its frontmatter; reference files are not embedded.
- spec:412 lock key `'cap:' || user || ':' || name` ignores namespace and kind: same-name capabilities of different kinds serialise (harmless).
- spec:420 label move "recompute the served version and publish `ctc:inval`": T3.2 submits `library.changed` for that; the handler ignores
  `payload.version` and recomputes from labels (D17).
- The worker main that calls `startWorkers` with these handlers and `watchLibrary` does not exist yet; no task in spec §8 names it explicitly.
