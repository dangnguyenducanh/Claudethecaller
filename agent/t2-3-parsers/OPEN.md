# T2.3 planner notes: what the owner reviews (O11: defaults "A" are accepted unless the final PR review says otherwise)

Drafted: `agent/t2-3-parsers/` = SPEC.md, DECISIONS.md (D0-D22), PROCESS.md, checks.mjs (one check per D-id, 23), selfcheck.py.
YOUR-CHOICE: 21 tag lines in 20 decision ids (D1-D7, D9-D22; D8 is FROM-OWNER O11). No owner question blocks the run.
Status: `node --import tsx agent/t2-3-parsers/checks.mjs` prints 23 clean FAIL lines (`packages/core/src/context/index.ts` missing) and
`python3 agent/t2-3-parsers/selfcheck.py [--fast]` ends `SELFCHECK: FAIL` for the same reason. The checks were NOT run against an implementation
(none exists). Only the line rules of D5/D6/D9 (task table/checklist/heading/story/bullet regexes, the code-reference token regex, the label
cuts) were run against a throwaway prototype on the checks' own fixtures; resolution, capability, extract and repository expectations come only
from the decision text. Expect a few planner mistakes; triage after the first coder run. The sections of selfcheck.py after `preflight` were
exercised once against a copy with a stubbed entry file (they run, no crash); `scope` and `rebuild_edit_ok` were not exercised on a real diff.
Size warning: this is the largest T2.x task (about 2,000 lines of source and tests). If a single coder run stalls, split it: run 1 = D0-D6, D8-D9, D12,
D14, D21-D22 (core, pure, no Postgres); run 2 = D7, D10-D11, D13, D15-D20 (worker + repository). The checks already group that way.

## A. Decisions with the widest blast radius (A = default, B = alternative)

| # | D | A (default) | B | Why it matters |
|---|---|---|---|---|
| 1 | D4 | capability nodes come ONLY from the F2 library (`library.changed`); project `.claude/skills|agents|commands|workflows` files are not parsed; `.claude/**` parser input is reduced to `.claude/prds` and `.claude/plans` | also parse a project's own `.claude/**` files (spec:284 literally lists `.claude/**`) | two producers for one `skill:<name>` id would fight over `source_file` and the delete scope; F2 already versions project skills when their dir is a library root |
| 2 | D13 | a user's library is copied into EVERY project graph of that user (`maxProjects` 50); new projects get them through `syncCapabilities` on their first rebuild when the capability layer is empty | one global capability graph (needs a schema change, spec:217 says one graph per project) | rows x projects; a capability removed in the library disappears per project only when its `library.changed` runs |
| 3 | D17 | three small changes to `repos.graph.replaceSource/deleteSource` (optional `source`, `keepSource`, edge delete by any node of the file) | new repository functions, or an `origin` column on `graph_sources` | `graph_sources` has one row per file and no origin; without R1/R2 the parser pass would either overwrite the `ast` hash (re-extract loop) or make the file look "never built"; R3 lets `claude` edges leave `parser` nodes and still be replaced by file |
| 4 | D10 | change detection by comparing the NEW parser rows with the STORED ones (no hash column of its own); code-edge freshness only when the document itself is processed | extend `graph_sources` with an origin, or re-resolve all documents on every rebuild | an edge `task -> src/new.ts` appears only when the spec file is next processed (or a full/force pass); same limit as T2.2's dependents rule, but for docs |
| 5 | D4 | new core directory `packages/core/src/context` (not `core/graph`) | put it in `core/graph` as spec:1.2 draws it | T2.1's `graph.test.ts` pins the exact export list of `graph/index.ts` (and forbids `contextId`/`capabilityId`); the T2.2 run needed a scope exception for that. A new directory is exported by the `./*` map as `@ctc/core/context` with no change to frozen files |
| 6 | D16 | composition wrappers (`withContextPass`, `withCapabilityLinks`, a separate `extractHandler`); `graphHandlers` and `libraryHandlers` are untouched | add the context pass inside `rebuildProject` and `graph.extract` into `graphHandlers` | `handler.int.test.ts:27` pins `Object.keys(graphHandlers(..)) = ['graph.rebuild']`; the worker main must bind the wrapped handlers (T7.1/main task) |
| 7 | D15 | `graph.extract` is submitted by `contextPass` only when a `submit` is injected; the worker main decides whether to inject it (default: no paid model call) | always submit | each changed spec/CLAUDE.md edit would cost one haiku call on the user's login |
| 8 | D9 | refs: code paths (and `path::symbol`) found in task/decision source text; resolution tiers: unique symbol EXTRACTED, 2-3 AMBIGUOUS, file fallback INFERRED 0.6, more than 3 none | EXTRACTED only for `path::symbol`, INFERRED for everything else | confidence is the ranking weight (spec:266) of every `implements` / `decides` edge |

## B. Other YOUR-CHOICE items (keep unless told)

| D | Default | Alternative | Why it matters |
|---|---|---|---|
| D1 | context pass, extract job and capability wrappers: local mode and user `local` only for the file readers (`extract_not_local`); capability linking has no local check (library rows are per user) | same rule everywhere | shared mode must never read a client's `cwd` from the server |
| D2 | numbers: `maxNodesPerFile` 2000, `maxRefsPerNode` 20, `maxCapabilityRefs` 50, `maxWorkflowNodes` 200, `maxModelEdges` 100, `maxPromptChars` 40,000, `maxExtractFiles` 10, `maxProjects` 50, `maxSyncCaps` 500, timeout 120 s | other numbers | bounds work and result size |
| D3 | hash recipe `sha256(ctc-ctx-1 \0 id \0 type \0 label \0 sourceText)`, `CONTEXT_VERSION = 'ctc-ctx-1'` | another recipe | any change rewrites every context row |
| D5 | node types only spec / requirement / task / decision (stories become requirements `US<n>`; no feature/criterion/ticket/plan-step); rules per line, first id wins, fenced code skipped, spec node only when a task or requirement exists | richer type set (old Python types) | spec:246 lists four context types |
| D5 | requirement ids `FR-`, `SC-`, `NFR-` + `User Story N`; the 007 spec has none (its features are `F1..F4` rows) so features are not nodes | add `F<n>` as requirements | the 007 spec yields 24 tasks + 10 decisions and no requirement |
| D6 | `.scratch/<feature>/issues/NN-*.md` = one task `issue-NN` linked `part_of` to `ctx:.scratch/<feature>/spec:spec` only when that node exists | ticket type, or no link | the 002-era tickets 01-16 map to tasks; their parent spec node exists only if the feature spec has tasks/requirements |
| D6 | `CLAUDE.md` decisions: id `D<date>` (`-2`, `-3` for repeats of one date), label = first sentence | `D1..Dn` by position | ids stay stable when entries are deleted; a reworded first sentence changes the label, not the id |
| D6 | cross-file `part_of` (tasks.md -> spec.md of one feature directory) is NOT emitted; each file's tasks are `part_of` their own file's spec node | link by directory convention | a pure parser sees one file |
| D11 | the T2.2 `rebuild.ts` gets 4 small edits (export `embedText`/`readText`/`sha`; `meta.embedText` override) | copy ~30 lines into the new module | one embed text recipe; capability nodes (no source lines) get `name + description` |
| D12 | `uses` from explicit `skill:`/`agent:`/`command:` references and frontmatter `skills|agents|commands` lists only; no `/name` or bare-name matching; `workflow -> step` reuses `contains`; agents may `uses` skills; forward references kept (edges may point at nodes that do not exist yet) | `/name` and backticked names as INFERRED; a new relation | noise vs. recall; T2.4 readers must ignore edges with a missing end |
| D13 | duplicate (kind, name) in two namespaces: the smaller `(namespace, id)` wins; the other is skipped `duplicate_name` | link both under distinct ids | one `skill:<name>` id per project |
| D13 | per-project link errors are logged and counted, never thrown (the library work already succeeded) | throw and retry the whole `library.changed` | a graph outage must not re-embed a skill |
| D14/D15 | model call: `<claude> -p --model haiku`, prompt on stdin, fresh empty cwd, no other flags; reply = strict JSON `{"edges":[{from,relation,to}]}` (three extraction forms, no repair) | pass `--output-format json` / `--allowedTools ""` | no flag was verified against the installed `claude` (see "unverified") |
| D15 | model edges are INFERRED 0.6 (AMBIGUOUS 0.3), never replace an existing non-`claude` edge, stored with origin `claude`, replaced per file | store as `parser` | spec:284 says "marked INFERRED"; origin scopes replacement (spec:268) |
| D15 | failures: ENOENT = `dropped:claude_not_found` (no retry), any other failure = `Error('extract_failed: ...')` (queue retries 3x, successes stay) | swallow and log | spec:355 only says parser edges stay |
| D18/D19 | `claude` edges whose parser node vanished dangle until that file's next extract (no repository function to delete them) | add a repository function + tenancy case | harmless for readers that ignore missing ends |

## C. Places where two reasonable readers would differ
- **"`.claude/**`" as parser input** (spec:284) vs. capability nodes only after `library.changed` (spec:286): this plan reads `.claude/skills|agents|commands|workflows` only through F2 (A1). A reader who wants project-local skills parsed directly must also decide who owns the id when the library has the same skill.
- **"workflow node ids"** (spec:284): read as the node ids of F2 workflow files (`workflow:<name>:<node_id>`), not as T-ids inside workflow docs.
- **`invokes` targets** (spec:263-264): the workflow file shape (spec:591) has no field naming a skill, agent or command; this plan scans the `prompt`, `run` and `question` strings for explicit `skill:<n>` / `agent:<n>` / `command:<n>` references. A reader may expect a dedicated field.
- **`serves` / `references` / `rationale_for`** (spec:264, spec:258): no producer here; `serves` waits for F2 enrichment, `references` and `rationale_for` have no task.
- **Decision ids**: spec:245 shows `D3` for decision ids; CLAUDE.md decisions have dates, so they get `D<yyyy-mm-dd>`; a reader may number them `D1...`.
- **Table task rows**: the id may sit in the first or the second cell (the 007 §8 table has a phase cell first); `| T2.1 | title | gate |` (id alone) takes the next cell as the label.
- **Checklist labels** drop `[P]` / `[US<n>]` markers and keep the rest of the line (trailing `→ test` hints stay in the label).
- **Packages / dedup**: `GraphNode.sourceFile` of a capability is the synthetic `<cap:<kind>:<name>>`; T2.4 `graph_explain` must not try to read it as a file (T2.2 already reserves `<packages>` the same way).
- **Embedding lag**: a rebuild's own embed loop (T2.2) runs before the context pass; parser nodes are embedded by the context pass's own loop in the same job (D11), capability nodes by the next pass or rebuild (`linkCapability` does not call TEI).
- **Epoch**: every write path bumps `projects.graph_epoch` through `repos.projects.bumpEpoch`; T1.2 has no such column yet (agent/t1-34-OPEN.md A1), so the bump is logged and ignored like in T2.2.
- **Pre-existing failure**: `packages/shared` `schema-assumptions.test.ts > … every column the repositories use exists` is red on HEAD; selfcheck.py tolerates exactly that test (same rule as T2.2/T3.1/T4.1).

## D. Unverified
- `claude -p --model haiku` reads the prompt from stdin and prints the reply on stdout with no extra flag. Not run (rule: never start the real `claude` here). Check before the worker main wires `spawnClaude`: `printf 'say {"edges":[]}' | claude -p --model haiku` in a scratch directory.
- Whether the installed `claude` picks up a `CLAUDE.md`/settings from the (empty) temp cwd's parents; `spawnClaude` uses `os.tmpdir()` children, so none is expected.
- The real `specs/007-ctc/spec.md`, `specs/006-merged-core/spec.md`, `specs/002-context-coding-graph/*` and `CLAUDE.md` counts used by checks (24 + 24 + 55 tasks, 10 decisions, 30 FR + 7 SC + 8 US, 23 dated decisions) were counted with the line rules of D5/D6 on this branch; `checks.mjs` asserts supersets (`>=`) for the files other tasks may edit.
