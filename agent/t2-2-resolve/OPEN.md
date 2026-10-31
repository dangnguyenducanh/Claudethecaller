# T2.2 planner notes: what the owner reviews (O11: defaults "A" are accepted unless the final PR review says otherwise)

Drafted: `agent/t2-2-resolve/` = SPEC.md, DECISIONS.md (D0-D24), PROCESS.md, checks.mjs (one check per D-id, 25), selfcheck.py.
YOUR-CHOICE: 29 lines (30 tags) in 23 decision ids (D1-D7, D9-D24). FROM-OWNER: O11. No owner question blocks the run.
Status: `node --import tsx agent/t2-2-resolve/checks.mjs` prints 25 clean FAIL lines (`apps/worker/src/graph/index.ts` missing) and
`python3 agent/t2-2-resolve/selfcheck.py [--fast]` ends `SELFCHECK: FAIL` for the same reason. The checks were NOT run against an
implementation (none exists). The raw T2.1 shapes the fixtures rely on (ids, labels, `meta.lines`, imports, refs, mentions) were
confirmed by running T2.1's `extractFile` on the fixture sources; the resolution, write and repository expectations come only from
the decision text. Expect a few planner mistakes; triage after the first coder run.
Resumed run: an interrupted planner had left SPEC.md, DECISIONS.md and PROCESS.md. Kept; DECISIONS.md gained the input types
(D3), a precise `maxFiles` truncation rule (D2), `<packages>` kept out of `files`/`counts` (D18) and "empty page, no embed call" (D20).

## A. Decisions with the widest blast radius (A = default, B = alternative)

| # | D | A (default) | B | Why it matters |
|---|---|---|---|---|
| 1 | D16 | shrink guard counts nodes; refused only when loss ≥ 3 nodes (`shrinkMinLoss`) AND loss > 20%; the rest of the run is written; job ends `dropped:shrink_guard: <files>` | the spec literal: any loss > 20% refuses, even 1 of 4 nodes | without the floor, deleting one function from a 3-function file is refused; with it, small files can lose most nodes unguarded |
| 2 | D3/D16 | `jobs.error = dropped:shrink_guard: …` (JobDropped, never retried, never `dlq-retry`) | bare `shrink_guard` text as spec:295 writes it, retried | `dlq-retry` would re-run a refused write five times; the Jobs page "force" action must match on the `dropped:` prefix |
| 3 | D12/D13 | EXTRACTED only by an import binding (named, default, namespace, re-export ≤ 5 hops, python module/`from`); everything else by tiers same file 0.95 → same package 0.85 → name only 0.6; 2-5 candidates AMBIGUOUS, more → no edge | name-only matches stay INFERRED with several targets; no cap | sets the confidence of every `calls` edge that F1 ranking (spec:266) and `graph_affected` use |
| 4 | D17 | files whose stored edges point at a removed id are re-extracted in the same run (one pass) | leave dangling edges until those files change | "callers keep edges" vs. a stale edge to a deleted symbol; one pass costs extra extraction per rename |
| 5 | D18 | external package nodes `code:pkg:<name>` live in one synthetic source `<packages>` | one package node per importing file, or no package nodes | spec:246 lists `package (external)` but no file owns it; `<packages>` is a reserved root file name (D9) |
| 6 | D1a | the rebuild reads the host file system only in local mode for user `local`; else `dropped:rebuild_not_local` | index any project root in shared mode | a remote user's `cwd` must never make the server index `/etc` |
| 7 | D9 | walk: never enter `.git`, `node_modules`, `.ctc`; per-directory `.gitignore` + `.ctcignore` via `ignore@7.0.14`; no `.git/info/exclude`, no git subprocess | `git ls-files` (exact git semantics, needs git and a repo) | which files get graph rows; `ignore` is a new worker dependency (O11 allows the registry) |
| 8 | D19 | `projects.bumpEpoch` failure is logged and ignored (T1.2 has no `graph_epoch` column yet, agent/t1-34-OPEN.md A1) | fail the job | until a migration adds the column, the 60 s Postgres poll (spec:205) has no token to read |

## B. Other YOUR-CHOICE items (keep unless told)

| D | Default | Alternative | Why it matters |
|---|---|---|---|
| D1b/c | symlinked dirs never followed; file symlinks only inside the root's real path; bad `payload.files` entries skipped `bad_path`, never a job error | fail the job on one bad path | one hostile path must not stop a rebuild |
| D2 | `maxFiles` 20,000 (truncated walk deletes nothing), `maxPayloadFiles` 1,000 (more → full walk), `maxPackageJson` 200, `resultListMax` 100, `maxAmbiguous` 5, `maxReexportHops` 5 | other numbers | bounds work and `jobs.result` size; all chosen by judgment |
| D2 | `SCORES.ambiguous` 0.3 = the spec's AMBIGUOUS ranking weight | another score | `score` column of AMBIGUOUS edges |
| D4 | handler check order: local → project exists → root exists (`root_missing`, nothing deleted) → debounce → rebuild | other order | which `dropped:` code the Jobs page shows |
| D5 | `files: []` = nothing to do (not a full walk); BOM stripped; frontmatter-only markdown edits do not rebuild | empty list = full walk | spool jobs always carry one file |
| D6 | must-never list (no writes under root, no non-`ast` rows touched, no stray edge src, deterministic resolve) | — | basis of the D6 fuzz in verification |
| D7 | non-goals: `graph.extract`, context/capability nodes (T2.3), query tools (T2.4), `ctc graph build` CLI and the git post-commit hook (no task row names them), progress updates, `built_at_commit` (always null) | build the CLI command and hook here | spec:290 names `ctc graph build` and the post-commit hook as triggers but §8 gives them to no task: they need an owner home (T2.4 or T7.1) |
| D10 | hash = sha256(body ‖ relPath); `force` also re-extracts unchanged files | `force` only bypasses the guard | a force rebuild re-reads every file |
| D11 | specifier probing order, workspace `exports`/`main`/`index` lookup, python root rule (shortest prefix without `__init__.py`), `imports` vs `imports_from` split by `*`; no tsconfig `paths`, no node_modules lookup | full TS/Node module resolution | aliased imports (`@/x`) become package nodes, their calls INFERRED |
| D12 | an import that resolves to a package binds its local name EXTERNAL: `fs.readFileSync()` gives no edge | INFERRED name match into repo code | avoids false `calls` edges into same-named repo functions |
| D13 | receiver rules (`this`/`self`/`cls` → enclosing class; other receivers: methods only, no name-only tier); no self edges; strongest edge wins on duplicates | treat receivers like bare names | number of noisy `calls` edges |
| D14 | mentions: links/`path::symbol` EXTRACTED, bare symbols INFERRED 0.6 / AMBIGUOUS; T2.1 left mentions to "T2.2/T2.3", done here | leave to T2.3 | doc → code edges exist before T2.3 |
| D15 | duplicate ids across files (`foo.ts` + `foo.py` → `code:foo`): smaller path owns, loser drops that node, keeps its `graph_sources` row | graphify's cross-file rename | ids stay per-file stable (spec:237) |
| D15/D20/D22 | node `content_hash` = sha256(embed text); `replaceSource` keeps an embedding when the hash is unchanged; embed pages through `pendingEmbeddings` (any origin) | re-embed every written node | TEI load per edit: one edit re-embeds the file node and the edited symbols only |
| D21 | debounce = wait until the job row is `debounce_s` old (bounded, abortable); later jobs of a burst find unchanged hashes | coalesce jobs per project in Redis | spec:290 "debounced 3 s per project": this is per job, not per project |
| D22 | repository additions `deleteSource`, `pendingEmbeddings`, keep-embedding in `replaceSource`, each with a tenancy case | worker-side SQL | T1.3 rule: SQL only in repositories |
| D23 | gate cases: `edit 1 file` compares every other row deep-equal incl. `updatedAt`; guard case pins exactly 20% written and `force` | looser gates | what "done" means for spec §7 F1 |
| D24 | file split (`resolve.ts` in core, `apps/worker/src/graph/`), exact export lists, `ignore@7.0.14` | other split | import paths for T2.3/T2.4 |

## C. Places where two reasonable readers would differ
- **"drop more than 20% of one source file's nodes"** (spec:295): count-based (renaming 5 symbols loses nothing) vs id-based (5 renamed ids = 5 "dropped"). Default count-based.
- **`jobs.error = shrink_guard`** (spec:295): the bare string vs the T1.4 `dropped:<code>` convention (A2).
- **"debounced 3 s per project"** (spec:290): coalescing jobs vs delaying each job; default delays (D21).
- **"same package"** (spec:285): nearest directory with `package.json` or `pyproject.toml`; a reader may use the pnpm workspace package or the python package (`__init__.py`) instead.
- **"a call becomes EXTRACTED only when an import edge proves the target"**: here a re-export chain and a namespace import also prove it; a strict reader would accept only a direct named import.
- **Ambiguity cap**: "with several candidates it is AMBIGUOUS" has no upper bound in the spec; default caps at 5 (6+ → no edge).
- **Deleting rows of files that became ignored, secret, too large or binary** (D17): default deletes them (the file is no longer in the graph); a cautious reader keeps them until the file is gone from disk.
- **`graph_sources` has no origin column**: `replaceSource` for origin `session`/`review` overwrites the `ast` row's `content_hash` of the same file, so that file is re-extracted on the next rebuild. Harmless (extra work), noted for T2.3/T2.4.
- **Embedding nodes of other origins** (D20): `pendingEmbeddings` returns every origin; T2.3's `parser`/`claude` nodes get embedded by the next `graph.rebuild`, not by their own job.
- **Pre-existing failure**: `packages/shared` `schema-assumptions.test.ts > … every column the repositories use exists` is red on HEAD (no `projects.graph_epoch`); selfcheck.py tolerates exactly that test (same rule as T3.1/T4.1 CHANGES.md).
- **Network**: the coder runs `pnpm --filter @ctc/worker add --save-exact ignore@7.0.14` (already in the local pnpm store). If the orchestrator prefers to pre-install, run it and `selfcheck.py --snapshot` before the coder starts; the dependency check accepts either.
