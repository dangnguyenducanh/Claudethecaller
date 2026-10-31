# Decisions for T2.2: resolve, incremental rebuild, shrink guard, `graph` queue (packages/core/src/graph, apps/worker/src/graph)

Tags: FROM-OWNER (O#, agent/OWNER.md), FROM-SPEC (specs/007-ctc/spec.md line), FROM-CALLERS (file:line), YOUR-CHOICE (owner reviews every one in the
final PR; O11 accepted planner defaults, listed again in agent/t2-2-resolve/OPEN.md). "spec" = `specs/007-ctc/spec.md`. "repos" =
`createRepositories(db)` (packages/shared/src/repositories/index.ts). "extract" = T2.1's `extractFile` (`@ctc/core/graph`), whose output shapes
(`ExtractResult`, `RawImport`, `RawRef`, `RawMention`) are this task's input (packages/core/src/graph/types.ts:24-80). A tag at the end of an indented
block covers the whole block.

D0  Purpose and callers. Turns T2.1's per-file extraction into the stored project graph: walks the project, finds changed files by content hash,
    re-extracts them with the old graph as resolution context, resolves raw imports, calls, class bases and markdown mentions into edges with a
    confidence, refuses writes that shrink a file too much, writes one transaction per source file, removes rows of deleted files, embeds node
    text, rotates the graph epoch and publishes `ctc:inval`. Callers: the worker main binds `graphHandlers(deps)['graph.rebuild']` into
    `startWorkers({handlers})` (apps/worker/src/jobs/index.ts:22-27); producers of `graph.rebuild` jobs are the spool drain (one job per
    Edit/Write/MultiEdit event, `files: [rel]`, apps/web/src/spool/index.ts:137-144), later `POST /api/graph/build {project_id, force?}` (T2.4,
    spec:335) and `ctc graph build` / the git post-commit hook (spec:290). Readers of the rows: T2.4 query tools and T5.1 hot paths through
    `repos.graph.loadGraph`/`loadVectors`. FROM-SPEC (spec:280-295, spec:778) FROM-CALLERS (packages/shared/src/queues/payloads.ts:14,
    packages/shared/src/repositories/graph.ts:33-79)

D1  Trust. Untrusted: every byte, name, symlink and size under the project root; the job payload (Redis content; re-validated by `runAttempt`,
    apps/worker/src/jobs/consumers.ts:55-63), in particular every entry of `payload.files`; the stored graph rows (written earlier, may be stale).
    Trusted: `config` (Zod-checked at start), `projects.root` of a `local` user. Rules:
    (a) the handler reads the host file system only when `config.mode === 'local'` and `payload.userId === 'local'`; otherwise
        `JobDropped('rebuild_not_local')` before any file is read (in shared mode a remote user's `cwd` must never make the server index `/etc`);
    (b) no file outside the root's real path is ever read: symlinked directories are not followed, a symlinked file is read only when its real
        path is inside the root's real path (D9);
    (c) `payload.files` entries are relative POSIX paths without `..`/`.`/empty segments, NUL, backslash or a leading `/`; anything else is
        skipped with reason `bad_path` (never an error for the whole job);
    (d) file content reaches only `extractFile`, `contentHash` and the embed text; nothing is evaluated, imported or fetched; specifiers are
        resolved against the walked file list only (never `require.resolve`, never the disk outside the root, never the network);
    (e) secret files (D9) are never read, stored or embedded.
    FROM-SPEC (spec:282 skip secret files; spec:140 userId from the key) YOUR-CHOICE ((a), (b), (c))

D2  Limits. Two exported mutable objects, read at call time (a test assigns and restores):
    `graphLimits` (apps/worker/src/graph): `maxFileBytes = 1_048_576` bytes from `stat` (inclusive: equal is read, one more is skipped
    `too_large`) FROM-SPEC (spec:282 "files > 1 MB"); `maxFiles = 20_000` files a walk includes (the 20,000th is included; when one more file
    would be included the walk stops with `truncated: true`; exactly 20,000 files is not truncated) YOUR-CHOICE; `maxPayloadFiles = 1000` entries in `payload.files` (equal is a files-only rebuild, one more turns the
    job into a full walk) YOUR-CHOICE; `shrinkMinLoss = 3` nodes (a file that loses fewer nodes than this is never refused, D16) YOUR-CHOICE;
    `embedBatch = 32` texts per embed call FROM-SPEC (spec:287); `embedTextChars = 2000` code points of embed text FROM-SPEC (spec:287);
    `maxPackageJson = 200` package.json files read per rebuild (the rest are ignored for specifier resolution) YOUR-CHOICE;
    `resultListMax = 100` entries per list in the job result (counts stay exact) YOUR-CHOICE.
    `resolveLimits` (packages/core/src/graph): `maxAmbiguous = 5` candidates (5 candidates give 5 `AMBIGUOUS` edges, 6 give no edge) YOUR-CHOICE;
    `maxReexportHops = 5` re-export hops followed for an import proof (D12) YOUR-CHOICE.
    Config, read at call time from `deps.config`: `graph.shrink_guard` (0.2), `graph.debounce_s` (3), `graph.languages`. FROM-SPEC (spec:341-344)
    FROM-CALLERS (packages/shared/src/env/schema.ts:120-139)
    Fixed scores (exported `SCORES`, not tunable): `sameFile 0.95`, `samePackage 0.85`, `nameOnly 0.6`, `ambiguous 0.3`, `extracted 1`.
    FROM-SPEC (spec:266, spec:285) YOUR-CHOICE (`ambiguous` score = its ranking weight)

D3  Output and error format.
    Input types (packages/core/src/graph):
        `ResolveInput = { results: ExtractResult[]; context: ContextNode[]; files: string[]; packages: PackageJson[] }`: `results` = the
        files extracted in this run; `context` = stored `ast` nodes of every other file (D12 node universe); `files` = the resolution file
        list (D11); `packages` = parsed package.json files (D11).
        `ContextNode = { id: string; type: string; label: string; sourceFile: string; meta?: unknown }` (a `GraphNode` row is assignable).
        `PackageJson = { dir: string; name: string; exports?: unknown; main?: unknown }`, `dir` = the POSIX directory relative to the root
        (`''` = root, no trailing `/`).
        `Reexport = { specifier: string; names: { imported: string; local: string }[] }` (D12).
    `GraphConfig = { mode: string; graph: { languages: string[]; shrink_guard: number; debounce_s: number } }` (a parsed env config is
        assignable); `Embed = (texts: string[]) => Promise<number[][]>` (same as apps/worker/src/library/handlers.ts:14);
        `GraphDeps` = D21.
    `resolveGraph(input)` returns `{ edges: Record<file, ResolvedEdge[]>; reexports: Record<file, Reexport[]>; packages: PackageNode[] }`:
        `ResolvedEdge = { src; dst; relation: 'imports' | 'imports_from' | 'calls' | 'inherits' | 'implements' | 'mentions';
                          confidence: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS'; score: number; sourceLocation: string }` (`L<line>` of the raw ref);
        assignable to `GraphEdgeInput` (packages/shared/src/repositories/graph.ts:13). `edges[f]` holds only edges whose `src` is a node of result
        `f`, never `contains` edges, unique on `(src, dst, relation)`, sorted by `src`, `relation`, `dst`. A key exists for every input result
        with `error === null` (value `[]` when nothing resolved). `reexports[f]` = D12's list for that file (key absent when empty).
        `packages` = the package nodes (D11) that the returned edges point at, unique, sorted by id:
        `{ id: 'code:pkg:<name>'; kind: 'code'; type: 'package'; label: <name>; sourceLocation: null; meta: {} }`.
    `contentHash(relPath, content)` returns 64 lowercase hex chars (D10).
    `rebuildProject(o)` returns `RebuildResult` (JSON-safe, also the `jobs.result` of the handler):
        `{ mode: 'full' | 'files'; counts: { walked, changed, unchanged, written, deleted, dependents, refused, failed, duplicates, skipped,
           embedded }; files: { written: string[]; deleted: string[]; dependents: string[]; refused: string[];
           failed: { file: string; code: string }[]; duplicates: { id: string; file: string; owner: string }[];
           skipped: { file: string; reason: string }[] }; truncated: boolean; epoch: string | null }`
        every list in path order (then id), cut to `graphLimits.resultListMax`; `counts` are the uncut lengths; `epoch` = the token
        `cache.epoch.rotate` returned, else `null`. `walked` = files the walk (or the payload list) included; `skipped` reasons: `bad_path`,
        `ignored`, `secret`, `too_large`, `binary`, `symlink_outside`, `not_file`, `missing`, `reserved`, `language` (lang off in config).
    `walkProject(root, o?)` returns `{ files: string[]; skipped: { file: string; reason: string }[]; truncated: boolean }` (`files` = every
        included regular file of any extension, sorted by UTF-16 code unit order).
    Handler errors (become the `jobs.error` text through `errText`, apps/worker/src/jobs/consumers.ts:31-35):
        `JobDropped('rebuild_not_local')`, `JobDropped('project_not_found')`, `JobDropped('root_missing')`, `JobDropped('grammar_missing')`
        → `dropped:<code>`, no retry; refused files → `JobDropped('shrink_guard: <f1>, <f2>, … (+N more)')` (at most 10 names, whole text
        ≤ 1000 chars) → `dropped:shrink_guard: …`; extraction failures → `new Error('extract_failed: <f1> (<code>), …')` (same caps) →
        `Error: extract_failed: …`, retried by BullMQ. When both happen, the shrink-guard error is thrown. Both are thrown only AFTER every other
        file was written and the epoch rotated.
    FROM-SPEC (spec:295 `jobs.error = shrink_guard`; spec:352 "jobs.error names the file; other files proceed") FROM-CALLERS
    (packages/shared/src/queues/submit.ts:47-55 `dropped:<code>`) YOUR-CHOICE (all shapes; `dropped:` prefix instead of the bare `shrink_guard`,
    so `dlq-retry` never re-runs a refused write, apps/worker/src/jobs/dlq-retry.ts:34)

D4  Bad input. `resolveGraph` and `contentHash` never throw on any value (results with `error !== null`, non-array fields, junk strings are
    ignored entry by entry). `rebuildProject` reports per file (D3 `skipped`/`failed`) and throws only for: repository errors (propagate; BullMQ
    retries), the abort signal (`AbortError` after D19 ran), `GrammarError` from `loadGrammars` (the handler turns it into
    `JobDropped('grammar_missing')`). The handler checks in this order and the first failing check wins: local mode (D1a) → project exists
    (`repos.projects.get`) → root is an absolute path to an existing directory (`root_missing`; nothing is deleted) → debounce (D21) → rebuild.
    YOUR-CHOICE

D5  Odd but harmless input stays valid: an empty project (no files: result with zeros, nothing written, no epoch rotation); a project with no
    `.gitignore`; a `payload.files` list with duplicates (processed once), with a file that was never in the graph, or with a file that is now
    ignored or deleted (its rows are removed, D17); `files: []` (nothing to do; NOT a full walk); a file whose extraction has no symbols (file
    node only); CRLF and BOM files (decoded with a BOM-stripping UTF-8 decoder, then passed to `extractFile` as text); a package.json that is not
    valid JSON or has no `name` (ignored for resolution); a markdown file whose frontmatter alone changed (unchanged hash, D10); stored rows of
    other origins (`parser`, `claude`, `review`, `session`) for the same file (never touched, D15). YOUR-CHOICE

D6  Must never: write, rename or delete anything under the project root; follow a symlinked directory or read outside the root (D1b); delete the
    rows of a file that the walk did not see because it was truncated, because the root was missing, or because the file failed to extract or was
    refused; touch rows whose origin is not `ast` (the repository keeps `review`/`session`, packages/shared/src/repositories/graph.ts:20, and
    the worker only ever passes `origin: 'ast'`); store an edge whose `src` is not a node of the file it is written with (so a later replace of
    that file removes it); store two nodes with one id (D15); modify `input` or the arrays of `resolveGraph`'s input; hang (every wait is bound
    to `debounce_s` and the AbortSignal; walks do not follow directory symlinks); read env vars, `~/.claude` or the network (the embedder is
    injected); throw from `resolveGraph`. Same input → deep-equal `resolveGraph` output. YOUR-CHOICE

D7  Non-goals (and who does them instead): the `graph.extract` handler and doc extraction with `claude -p` (T2.3); context parsers, `ctx:` and
    capability nodes and their `part_of`/`implements`/`decides`/`uses` edges (T2.3); query, explain, path, affected, neighbors, MCP, `/api/graph`
    and the RAM graph reload on `ctc:inval` (T2.4, T5.1); `ctc graph build` in apps/cli and installing the git post-commit hook (not in any
    task row; listed in OPEN.md); the TEI client (`embed` is injected; the worker main wires it); job progress updates (`jobs.progress` stays
    as runAttempt leaves it); `built_at_commit` (always `null`); `references` and `rationale_for` edges (no producer yet); tsconfig `paths`
    aliases, Python `sys.path` tweaks, node_modules package resolution; Louvain/communities; type-based receiver inference; a per-project
    lock (one worker, `graph` concurrency 1, spec:81, spec:188); the `node.text` column (left at its default). FROM-SPEC (spec:779-780 T2.3/T2.4
    rows) YOUR-CHOICE

D8  Silence rule: where this list says nothing, choose the more tolerant, less destructive behaviour (keep old rows rather than delete, emit no
    edge rather than a wrong `EXTRACTED` one) and write a `judgment:` comment at that spot naming the choice. FROM-OWNER (O11)

D9  Walk (`walkProject`, apps/worker; also applied to each `payload.files` entry, which is included iff a full walk would include it).
    Directories are visited depth-first in name order; `.git`, `node_modules` and `.ctc` directories (any depth) are never entered (`.ctc` holds
    workflow worktrees, spec:121). Every `.gitignore` and `.ctcignore` is read (gitignore syntax, via the `ignore` package) and applies to the
    paths below its directory; deeper files win over shallower ones (a `!x` in a subdirectory re-includes x unless a parent directory of x is
    itself ignored, like git); an ignored directory is not entered. Not read: `.git/info/exclude`, the global git excludes file. A file is
    skipped as: `ignored` (by those files), `secret` (base name, case-insensitive, matches `.env*`, `*.pem`, `id_*`, `credentials*`),
    `too_large` (D2), `symlink_outside` (D1b), `not_file` (not a regular file after following a file symlink), `reserved` (a root-level file
    named exactly `<packages>`, D18). Symlinked directories are skipped silently. Files are listed, not read; reading happens in D10 (a file
    with a NUL byte in its first 8,000 bytes or invalid UTF-8 is skipped `binary` there). The extraction set = included files whose
    `langOf(path)` is in `config.graph.languages` (others: counted in `walked`, kept in the resolution file list, never extracted or stored;
    `language` skip only for payload entries). FROM-SPEC (spec:282) YOUR-CHOICE (always-skipped directories, per-directory ignore files,
    `ignore` package, symlinks, no git subprocess)

D10 Content hash and the changed set. `contentHash(relPath, content)` = sha256 hex of UTF-8(`body`) followed by UTF-8(`relPath`), where `body` =
    `content` for every language except markdown; for markdown `body` = the text after the frontmatter's closing line (after its `\n`) when the file has
    frontmatter by T2.1 D16's rule (line 1 trimmed is `---`, closed by `---`/`...` within `limits.frontmatterMaxLines`), else `content`.
    A file in the extraction set is CHANGED when `force` is true, or it has no `graph_sources` row, or its row's `content_hash` differs, or its
    row's `extractor_version` differs from `EXTRACTOR_VERSION` (so a version change rebuilds every file). Unchanged files are not read again
    after hashing, not extracted and not written. Full mode (no `payload.files`, or more than `maxPayloadFiles`): the walk decides the set.
    Files mode: only the listed files. FROM-SPEC (spec:291-293) YOUR-CHOICE (exact byte order; `force` re-extracts too)

D11 Specifier resolution and import edges (pure, in `resolveGraph`; `files` = the resolution file list: full mode = every walked file, files
    mode = every `graph_sources` file plus the listed files).
    ts/tsx/js relative (`./`, `../`): join with the importing file's directory (POSIX, normalised; leaving the root = unresolved), then try in
    order: when it ends in `.js/.jsx/.mjs/.cjs`, the same path with `.ts/.tsx/.mts/.cts`; the path as written; the path plus `.ts .tsx .d.ts .js
    .jsx .mjs .cjs .mts .cts .json`; the path plus `/index` and the same extensions. First one in `files` wins.
    ts/tsx/js bare (`x`, `@s/x`, `@s/x/sub`, `node:fs`): package name = `@s/x` or the first segment (`node:fs` whole). When a parsed
    package.json (`input.packages`, `{dir, name, exports?, main?}`) has that name: subpath `.` or `./sub` is looked up in `exports` (a string,
    or an object whose `import` else `default` value is a string; keys matched exactly, then the single-`*` pattern keys with the `*` text
    substituted), else for `.` `main`, else `<dir>/index.*`, `<dir>/src/index.*` (extensions as above); the result must be in `files`. A name
    that matches no workspace package, or a workspace subpath that does not resolve, is the package node `code:pkg:<name>`. A specifier with
    `://` or starting with `/` resolves to nothing.
    python: leading dots = relative (`.` = the importing file's directory, each further dot one level up), then the dotted rest as path
    segments; absolute `a.b`: `<P>a/b.py` or `<P>a/b/__init__.py` in `files`, where the prefix `<P>` is `''` or a directory that has no
    `__init__.py` in `files`; shortest `<P>` wins, then code unit order. Relative with no match = nothing; absolute with no match =
    `code:pkg:<first segment>`. `from m import x` where `m` resolves to a package `__init__.py` without a top-level node `x` and `m/x.py`
    is in `files`: `x` binds that module file (D12) and an `imports_from` edge goes to it too.
    bash `source <word>`: relative to the script's directory, then to the root; no match = nothing (no package node).
    Edges, all `EXTRACTED`, score 1, src = the importing file node, `sourceLocation` = `L<line>`: one per raw import statement and resolved
    target; relation `imports_from` when the statement has at least one name whose `imported` is not `'*'`, else `imports`; type-only imports
    count. Package names that do not match `^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$` (ts/js, `node:` prefix allowed) or `^[A-Za-z_]\w*$`
    (python) give nothing. FROM-SPEC (spec:246 `package (external)`, spec:253 "imports, imports_from: file → file / package") YOUR-CHOICE
    (all probing orders, the workspace and python root rules, the `imports` vs `imports_from` split, `code:pkg:` ids)

D12 Bindings and the import proof (`EXTRACTED` calls). Per result file, each raw import creates bindings by local name: ts named
    `{imported: a, local: b}` → b = symbol `a` of the target file; `default` → symbol `<local name>` of the target; `*` with local `ns` →
    module (the target file); python `import a.b [as c]` → `a.b` (or `c`) = module; `from m import x as y` → y = symbol `x` of m (or the module
    file m/x.py, D11); `from m import *` and bash `source` → a star binding on the target. An import that resolved to a package node or to
    nothing binds the local name as EXTERNAL.
    A symbol `n` of file g is PROVEN when the node `code:` + makeId(fileStem(g), n) exists in the node universe with `sourceFile` g and an
    allowed type (D13), or, failing that, through g's re-exports: ts/js raw imports of kind `reexport`, python every raw import of g; a name
    with `local === n` continues as symbol `imported` of its target, `*`/`*` continues as symbol `n` of its target; at most
    `maxReexportHops` hops, never the same (file, name) twice. Re-exports of result files come from their raw imports; of context files from
    their file node's `meta.reexports` (written by D15 from `reexports[f]` = `{specifier, names}` list in raw order).
    A raw ref is EXTRACTED (score 1) to the proven node when: receiver null and its name is bound to a symbol (or a star binding proves it);
    receiver equals a module-bound local (`u.f()`, python `a.b.f()`) and the module proves `f`; receiver equals a local bound to a proven
    class `K` and the method `code:` + makeId(fileStem(file of K), K, name) exists. A ref whose name (receiver null) or receiver's first segment
    is bound EXTERNAL gives no edge at all (an imported package is not a repo symbol). Everything else goes to D13. Node universe = result
    nodes + context nodes whose `sourceFile` is not a result file (old rows of re-extracted files are never used). FROM-SPEC (spec:285
    "EXTRACTED only when an import edge proves the target", spec:292) YOUR-CHOICE (binding table, default-import rule, re-export hops, the
    EXTERNAL short cut)

D13 Unproven refs: tiers. Allowed target types: `call` → function, class; `new` → class; `jsx` → function, class; `extends` → class, interface,
    type; `implements` → interface, type, class; bash `call` → function nodes of bash files except the `__entry` node. Candidates are nodes of
    the same language family (ts/tsx/js | python | bash, by `langOf(sourceFile)`) whose NAME equals the ref name (name = label without a
    leading `.` and a trailing `()`). Tiers in order, the first tier with candidates decides: same file → same package (nearest ancestor
    directory of the file holding a `package.json` or `pyproject.toml` in `files`, `''` = the root) → name only (any file). In the deciding
    tier: 1 candidate → `INFERRED` with the tier's score (0.95 / 0.85 / 0.6); 2 to `maxAmbiguous` → one `AMBIGUOUS` edge (score 0.3) to each;
    more → no edge. Receiver `this`/`self`/`cls`: first the methods named so whose parent is the nearest enclosing class of `from` (by the
    result's `contains` edges), 1 → `INFERRED` 0.95; otherwise like any other receiver. Any other unproven receiver: type `method` only and
    only the same-file and same-package tiers (no name-only tier). Bash refs: same file, then nothing. Relation: `calls` for call/new/jsx,
    `inherits` for extends, `implements` for implements; `src` = `ref.from`; a ref whose target would be `ref.from` itself gives no edge.
    Several refs giving the same `(src, dst, relation)` keep the strongest (EXTRACTED > INFERRED by higher score > AMBIGUOUS), then the
    first line. FROM-SPEC (spec:285 scores and "with several candidates it is AMBIGUOUS") YOUR-CHOICE (tiers as an ordered cascade, type
    filters, receiver rules, the ambiguity cap, no self edges)

D14 Mentions (markdown results; relation `mentions`, src = `mention.from`). `link`: target with a leading `/` is root-relative, else relative to
    the markdown file's directory; normalised; percent-decoded when the raw form is not in `files`; resolved to the file/page node of that path
    (must exist in the node universe) → `EXTRACTED` 1. `path_symbol` `p::A::b`: `p` root-relative (then relative to the markdown directory);
    node `code:` + makeId(fileStem(p), A, b) exists → `EXTRACTED`; else the file node of `p` exists → `EXTRACTED` to it; else nothing.
    `symbol` `a.b.c`: candidates = code nodes of types function, method, class, interface, type, variable, table named `c` (any language);
    with a dotted form, narrowed to those whose id ends with `_` + makeId(a, b, c) when that leaves at least one; 1 → `INFERRED` 0.6;
    2 to `maxAmbiguous` → `AMBIGUOUS` 0.3 each; more → nothing. Dedup as D13. FROM-SPEC (spec:261 `mentions` doc → any; spec:283)
    FROM-CALLERS (packages/core/src/graph/types.ts:60-65) YOUR-CHOICE (all rules; T2.1 D20 left mentions to "T2.2/T2.3": done here)

D15 Write (`rebuildProject`). Per written file, in path order, one `repos.graph.replaceSource(ctx, {origin: 'ast', sourceFile, nodes, edges,
    source: {contentHash: <D10 hash>, extractorVersion: EXTRACTOR_VERSION, builtAtCommit: null}})`. Nodes = the extracted nodes (minus D15
    duplicates) with `contentHash` = sha256 hex of the node's embed text (D20) and `meta` = the extracted meta plus, on the file node only,
    `reexports` when `reexports[f]` is non-empty. Edges = the extracted `contains` edges plus `edges[f]` from `resolveGraph`, both filtered to
    `src` in this file's written nodes. Duplicate ids across files (T2.1 D7: `foo.ts` + `foo.py` give one file id): an id already stored for
    another file that is not rewritten or deleted in this run stays with that file; among files of this run the smaller path wins; the loser
    drops that node and the edges leaving it, keeps its other nodes, and the pair is listed in `files.duplicates`. The loser's
    `graph_sources` row is still written (so it is not re-extracted every run). FROM-SPEC (spec:288 "one transaction per (origin,
    source_file)") FROM-CALLERS (packages/shared/src/repositories/graph.ts:33-79) YOUR-CHOICE (ownership rule, per-node hash)

D16 Shrink guard, per file in the run (not for deletions, D17, nor `<packages>`, D18): `old` = the file's stored `ast` nodes, `new` = nodes
    D15 would write. Refused when `force` is not true AND `old - new >= graphLimits.shrinkMinLoss` AND `(old - new) / old >
    config.graph.shrink_guard` (strictly greater: exactly 20% loss is written). Count-based: renaming nodes without losing any is never
    refused. A refused file keeps all its rows and its `graph_sources` row (so the next run tries again), adds no dependents, is listed in
    `files.refused`, and makes the handler end with `dropped:shrink_guard: <files>` after the rest was written (D3). `force: true` (the Jobs
    page action, a resubmit with the same `files`) writes it. FROM-SPEC (spec:295, spec:343, spec:353) YOUR-CHOICE (count-based, the
    3-node floor, rest of the run proceeds)

D17 Deletions and dependents ("callers keep edges"). Deleted = (full mode, walk not truncated) every `graph_sources` file other than
    `<packages>` that is not in the extraction set, plus (both modes) every listed or walked file that has a `graph_sources` row and is now
    skipped or missing. Each is removed with `repos.graph.deleteSource(ctx, {origin: 'ast', sourceFile})` (D22), no shrink guard. Edges
    stored with OTHER files are left as they are, so an unchanged caller keeps its edge to every node that still exists. Removed ids = stored
    `ast` node ids of written and deleted files that are no longer written. Dependents = files not otherwise in this run that are still in the
    extraction set and store an `ast` edge whose `src` is their own node and whose `dst` is a removed id; they are read, extracted and written
    in the same run (one pass, no cascade) so no stored edge points at a removed id. A dependent that fails to read or extract keeps its rows.
    FROM-SPEC (spec:292, spec:365 "callers keep edges") YOUR-CHOICE (deleting rows of skipped/missing files, the dependents pass)

D18 Package nodes live in one synthetic source file `<packages>` (`PACKAGES_SOURCE`, never a walked path, D9). After the file writes, the
    needed set = package ids pointed at by stored `ast` edges of files not written/deleted in this run plus `resolveGraph(...).packages`. When
    it differs from the stored `<packages>` nodes: `replaceSource` with exactly those nodes (no edges, `contentHash` = sha256 of the sorted ids
    joined by `\n`); when it is empty and a stored source exists: `deleteSource`. Unchanged set → no write. `<packages>` is never listed in
    `files.*` nor counted in `counts` (it only counts for D19). YOUR-CHOICE (the whole mechanism;
    package nodes are shared by many files, so no real file can own them)

D19 Epoch and invalidation. Only when the run wrote or deleted at least one source (including `<packages>`), after all writes and also when
    the run stops on the abort signal after a write: `repos.projects.bumpEpoch(ctx, projectId, 'graph')` (Postgres token for the 60 s poll,
    spec:205; a throw is logged and ignored: T1.2's migrations do not create the column yet, agent/t1-34-OPEN.md A1), then
    `cache.epoch.rotate('graph', userId, projectId)` and `cache.publishInval({v: 1, event: 'graph.rebuild', userId, projectId})`; each failure
    is logged and ignored (the rows are already committed). `cache` is optional. A run that changed nothing calls none of them. FROM-SPEC
    (spec:182, spec:288) FROM-CALLERS (packages/shared/src/cache/index.ts:29-33, packages/shared/src/cache/inval.ts:9-16,
    packages/shared/src/repositories/projects.ts:60-68) YOUR-CHOICE (Postgres bump tolerated to fail)

D20 Embedding (`deps.embed?: (texts: string[]) => Promise<number[][]>`, optional). Node embed text = label, a newline, then the node's source
    lines `meta.lines` [start, end] of the file text (lines split on `\n`, joined by `\n`), cut to `embedTextChars` code points; package nodes
    and nodes whose file cannot be read: the label only. `replaceSource` keeps a replaced node's embedding when its new `contentHash` equals the
    stored one (D22), so unchanged nodes are never re-embedded. After the writes (also when nothing was written), when `embed` is given: page
    through `repos.graph.pendingEmbeddings(ctx, {limit: embedBatch, afterId})` (nodes of any origin with no embedding, id order), build the
    texts (reading the files from disk for nodes not in this run), call `embed` once per page, `setEmbedding(ctx, id, vector, sha256(text))`
    for every vector that has 1,024 finite numbers (others skipped and logged); stop at the end, on the abort signal, or on the first `embed`
    throw (logged; the nodes stay pending and embed on the next rebuild). An empty page ends the loop without an `embed` call. `counts.embedded` = vectors stored. FROM-SPEC (spec:287, spec:354)
    YOUR-CHOICE (paging, keep-on-equal-hash, embed nodes of any origin)

D21 Handler `graphHandlers(deps)['graph.rebuild']`, payload `{userId, projectId, force?, files?}` (packages/shared/src/queues/payloads.ts:14).
    Order D4. Debounce: when `payload.files` is given and `force` is not true, wait until `createdAt + config.graph.debounce_s` of the job row
    (`repos.jobs.get({userId}, ctx.jobId)`; no row → no wait), at most `debounce_s`, aborted by `ctx.signal`. A burst of edits therefore
    builds once the burst is 3 s old; the later jobs of the burst find unchanged hashes and write nothing. Then `rebuildProject` with
    `files` (deduplicated; more than `maxPayloadFiles` → full mode), `force`, `signal: ctx.signal`, `grammars` (`deps.grammars ??
    await loadGrammars()`), and returns its result, or throws per D3. `deps = {repos, config, cache?, embed?, log?, grammars?}`; `config` is
    read at call time. The handler never submits jobs. FROM-SPEC (spec:290 "debounced 3 s per project", spec:344) FROM-CALLERS
    (apps/worker/src/jobs/consumers.ts:9-12 Handler ctx, apps/web/src/spool/index.ts:144) YOUR-CHOICE (debounce by job age, not by
    coalescing jobs)

D22 Repository additions (packages/shared/src/repositories/graph.ts, the only SQL; each new function gets a tenancy case in
    packages/shared/src/repositories/tenancy.cases.ts so `tenancy` stays green):
    `replaceSource` keeps `embedding` of a node it deletes when the row it inserts for the same id has the same `content_hash` (same
    transaction; any other change of its behaviour is out of scope);
    `deleteSource(ctx, {origin, sourceFile}): Promise<{deleted: number}>` deletes the `origin` nodes of that file, the `origin` edges leaving
    them and the `graph_sources` row in one transaction; `deleted` counts nodes plus edges, like `replaceSource` (`review`/`session` origins:
    nothing deleted, `deleted: 0`, the `graph_sources` row stays; bad origin or empty file → `RepoError` with code `invalid`);
    `pendingEmbeddings(ctx, {limit?, afterId?}): Promise<{id, label, sourceFile, contentHash, meta}[]>` = the project's nodes with a null
    embedding and `id > afterId`, id order, `limit` clamped to [1, 500] (default 32).
    All need `ctx.projectId`. FROM-CALLERS (packages/shared/src/repositories/graph.ts, tenancy.cases.ts:144-161; T1.3 rule "the only module
    with SQL", spec:92) YOUR-CHOICE

D23 Gate tests (spec §7 F1). `packages/core/src/graph/graph.resolve.test.ts` with `describe('graph.resolve', …)` and the tests
    `a call becomes EXTRACTED only with an import edge` (the same call is INFERRED or AMBIGUOUS once the import is removed) and
    `ambiguous names become AMBIGUOUS` (2 candidates → 2 AMBIGUOUS edges; more than `maxAmbiguous` → none), on sources run through
    `extractFile`. `apps/worker/src/graph/graph.incremental.test.ts` with `describe('graph.incremental', …)` and the tests
    `edit 1 file → only its rows change` (every node and edge row of the other files deep-equal before and after, `updatedAt` included),
    `callers keep edges` (an unchanged caller's edges into the edited file are still there and still resolve), `guard trips above 20% loss`
    (exactly 20% is written, one node more is refused with old rows kept, `force` writes it), on a temp project and a scratch schema
    `ctc_t22_<random>` dropped in `afterAll`. FROM-SPEC (spec:364-365, spec:20 test names) YOUR-CHOICE (the exact cases)

D24 Files, dependencies, exports.
    `packages/core/src/graph/`: new `resolve.ts` (and helpers) for `resolveGraph`, `contentHash`, `resolveLimits`, `SCORES` and the types
    `ResolveInput`, `ResolveOutput`, `ResolvedEdge`, `ContextNode`, `PackageJson`, `PackageNode`, `Reexport`; `index.ts` adds exactly these
    exports. Pure: no `node:fs`, `node:child_process`, `node:net`, `node:http` import (sha256 via `node:crypto` is allowed).
    `apps/worker/src/graph/` (new): `index.ts` exports exactly `graphHandlers`, `rebuildProject`, `walkProject`, `graphLimits`,
    `PACKAGES_SOURCE` and the types `GraphDeps`, `GraphConfig`, `RebuildResult`, `Embed`. Tests may reuse `scratchRepos` from
    `apps/worker/src/library/testing.ts` (import only, no edit).
    Dependency: `pnpm --filter @ctc/worker add --save-exact ignore@7.0.14` (already in the local store); `apps/worker/package.json` and
    `pnpm-lock.yaml` change only by that. Repo TypeScript rules apply (strict, `erasableSyntaxOnly`, `.ts` import suffixes).
    FROM-SPEC (spec:94 core graph "resolve", spec:89 apps/worker `graph` queue) FROM-OWNER (O11 npm registry for `pnpm add`) YOUR-CHOICE
    (file split, `ignore`)
