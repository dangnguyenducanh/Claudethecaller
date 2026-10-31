# Decisions for T2.3: context id parsers, doc extract, capability nodes (packages/core/src/context, apps/worker/src/context)

Tags: FROM-OWNER (O#, agent/OWNER.md), FROM-SPEC (specs/007-ctc/spec.md line), FROM-CALLERS (file:line), YOUR-CHOICE (owner reviews every one in the
final PR; O11 accepted planner defaults, listed again in agent/t2-3-parsers/OPEN.md). "spec" = `specs/007-ctc/spec.md`. "repos" = `createRepositories(db)`
(packages/shared/src/repositories/index.ts). "T2.1" = `packages/core/src/graph` extractor, "T2.2" = resolver + `apps/worker/src/graph`, "T3.1" = `apps/worker/src/library`.
A tag at the end of an indented block covers the whole block. "Code-unit order" = JavaScript `<` on strings.

D0  Purpose and callers. Gives the project graph its plan and capability layer: (a) pure parsers turn documents into `ctx:` nodes (spec, requirement,
    task, decision) with `part_of` edges and raw code references; (b) the worker resolves those references into `implements` / `decides` edges against
    the stored `ast` nodes and writes them with origin `parser`; (c) the `graph.extract` job asks `claude -p --model haiku` for the `implements` /
    `decides` edges the parsers cannot see and stores them `INFERRED` with origin `claude`; (d) F2 library capabilities become `skill:` / `agent:` /
    `command:` / `workflow:` / `workflow:<name>:<node>` nodes with `uses` / `invokes` / `contains` edges (origin `parser`) in every project graph of the user.
    Callers: the worker main (not built yet) binds `withContextPass(graphHandlers(..)['graph.rebuild'], deps)`, `extractHandler(deps)['graph.extract']`
    and `withCapabilityLinks(libraryHandlers(..)['library.changed'], deps)` into `startWorkers({handlers})` (apps/worker/src/jobs/index.ts:22-27). Producers of
    `graph.extract` jobs: `contextPass` (via the injected `submit`). Readers of the rows: T2.4 query tools, T5.1 hot paths (`repos.graph.loadGraph`).
    FROM-SPEC (spec:284 "Parse context", spec:286 "Link capabilities", spec:779 T2.3, spec:355) FROM-CALLERS (packages/shared/src/queues/payloads.ts:15,
    packages/shared/src/queues/defs.ts:24, apps/worker/src/library/handlers.ts:47-80, apps/worker/src/graph/handler.ts:46-83)

D1  Trust. Untrusted: every document byte (repo text can be hostile), every library file / YAML / frontmatter, every model reply, `payload.files`
    entries, the stored rows. Rules: (a) a path is valid iff it is a non-empty string, relative, `/`-separated, with no empty, `.` or `..` segment, no
    backslash, no NUL (`safeRel` of apps/worker/src/graph/walk.ts:26 is the worker-side test; the core test is the same rule) — else `error.code =
    'bad_path'`; (b) the worker reads files only through T2.2's `readText` (regular file, real path inside the root, size limit, valid UTF-8, no NUL), never
    follows a symlinked directory, never writes under the root; (c) every label passes `cleanLabel` (packages/core/src/graph/ids.ts: control characters
    to a space, 256 code points) and the text sent to the model passes `sanitize` (packages/core/src/sanitize/index.ts:94) — so `<private>`,
    `<system-reminder>`, `<persisted-output>` blocks and `ctc: ` lines never reach the model; (d) YAML is read only through the existing frontmatter
    result of the library (`Version.frontmatter`), never parsed again here; (e) the context-pass wrapper and the extract job read the host file system, so they run only in local mode
    for user `local` (same rule as apps/worker/src/graph/handler.ts:50); capability linking reads library rows only and has no such rule; (f) a model reply is data: only validated `from`/`relation`/`to` strings are used, a
    resolved id always comes from a stored node, never from the reply. FROM-SPEC (spec:215, spec:282) FROM-CALLERS (apps/worker/src/graph/rebuild.ts:62) YOUR-CHOICE (a, e, f)

D2  Limits. Module constants, mutable objects read at call time (a test assigns to a field and restores it). Core `contextLimits`
    (packages/core/src/context): `maxFileChars = 1_048_576` (JavaScript string length of `content`; more → `error.code = 'too_large'`, no nodes; equal is valid),
    `maxNodesPerFile = 2000` (the first 2000 nodes in line order are kept, `truncated = true`; the spec node is not counted),
    `maxRefsPerNode = 20` (extra refs of one node are dropped, in appearance order), `maxCapabilityRefs = 50` (distinct targets per capability or step),
    `maxWorkflowNodes = 200` (steps beyond the 200th valid one are ignored), `maxDescription = 300` (code points kept in `meta.description`),
    `maxEmbedText = 2000`, `maxModelEdges = 100`, `maxPromptChars = 40_000` (code points of document text in the prompt).
    Worker `contextWorkerLimits` (apps/worker/src/context/limits.ts): `maxPayloadFiles = 1000` (more `files` entries → a full walk, as T2.2 D2),
    `maxProjects = 50` (graph projects one capability is linked into), `maxSyncCaps = 500`, `maxExtractFiles = 10` (files one `graph.extract` job reads),
    `maxExtractSubmit = 20` (extract jobs one pass submits), `extractTimeoutMs = 120_000`, `extractMaxReplyChars = 200_000`, `resultListMax = 100`
    (entries per list in a result; counts stay exact). Reused, not redefined: `graphLimits.maxFileBytes` (1 MiB, read size), `graphLimits.embedBatch`
    (32), `graphLimits.embedTextChars` (2000). `maxFileChars`, `embedBatch`, `embedTextChars` FROM-SPEC (spec:282, spec:287); the rest chosen by judgment
    (comment `chosen by judgment` at each constant). YOUR-CHOICE

D3  Core shapes (packages/core/src/context/types.ts, exported from index.ts; strict TypeScript, no `any`).
      type CtxNode = { id: string; kind: 'context' | 'capability'; type: 'spec' | 'requirement' | 'task' | 'decision' | 'skill' | 'agent' | 'command'
                       | 'workflow' | 'workflow_step'; label: string; sourceLocation: string | null; contentHash: string; meta: Record<string, unknown> }
      type CtxEdge = { src: string; dst: string; relation: 'part_of' | 'uses' | 'invokes' | 'contains'; confidence: 'EXTRACTED'; score: 1; sourceLocation: string | null }
      type CtxRef  = { from: string; relation: 'implements' | 'decides' | 'part_of'; kind: 'path' | 'path_symbol' | 'node'; target: string; line: number }
      type ContextParse = { file: string; nodes: CtxNode[]; edges: CtxEdge[]; refs: CtxRef[]; truncated: boolean;
                            error: null | { code: 'bad_path' | 'too_large' | 'internal'; message: string } }
    `parseContext(input: { path: string; content: string }): ContextParse` never throws (a bug becomes `error.code = 'internal'` with empty arrays), never edits its
    argument, is deterministic (same input → deep-equal output), and returns `{nodes:[], edges:[], refs:[], truncated:false, error:null}` for a valid path that
    `isContextPath` rejects. `file` echoes the input path. `sourceLocation` is `L<line>` (1-based) for context nodes, `null` for capability nodes.
    `contentHash` = lowercase hex sha256 of `${CONTEXT_VERSION}\0${id}\0${type}\0${label}\0${sourceText}` where `sourceText` is the node's source line(s) joined by `\n`
    (spec node: the title line; capability nodes: D12). `CONTEXT_VERSION = 'ctc-ctx-1'` (bump on any change to ids, labels, rules). Output order: `nodes` in
    line order with the spec node first; `edges` sorted by `src`, `dst`, `relation` (code-unit order); `refs` in node order, then appearance order.
    FROM-SPEC (spec:243-246, spec:262-264, spec:268) FROM-CALLERS (packages/core/src/graph/types.ts:19-31) YOUR-CHOICE (names, `CONTEXT_VERSION`, hash recipe, ordering)

D4  Sources. `isContextPath(path: string): boolean` is true exactly for: `CLAUDE.md` (repo root only); `specs/**/*.md`; `.scratch/**/*.md`; `.claude/prds/**/*.md`;
    `.claude/plans/**/*.md` (case-sensitive; `**` = one or more directories). Dispatch, first match wins: (1) `CLAUDE.md` → D6b; (2) `.scratch/<feature>/issues/<NN>-<slug>.md`
    (regex `^\.scratch/(.+)/issues/(\d{1,4})-[^/]*\.md$`) → D6a; (3) every other context path → the document rules D5. `.claude/skills|agents|commands|workflows` are NOT parsed
    here: capability nodes come only from the F2 library (D12, D13). The id file part is `fileStem(path)` (extension removed, `/` kept): `ctx:` + stem + `:` + local id.
    FROM-SPEC (spec:284 "specs, .scratch/*, CLAUDE.md decisions and .claude/**", spec:244) YOUR-CHOICE (the exact globs; `.claude/**` reduced to prds/plans because
    skills/agents/commands/workflows are F2 capabilities with one owner for each `skill:<name>` id)

D5  Document rules (dispatch 3). Text split on `\n`, one trailing `\r` per line removed, a leading BOM removed, a final empty element dropped; `total` = number of lines.
    Lines inside a fence (a line matching `^ {0,3}(```|~~~)` toggles; the fence lines themselves are not scanned) are ignored. Each remaining line yields at most one node,
    tested in this order. `ID_SEP` = `[\s:.—–-]*`; `TASK_ID` = `T\d+(?:\.\d+)*`; `REQ_ID` = `(?:FR|SC|NFR)-\d+`; `W` = zero or more `*` or backtick characters (an id in a table cell may be wrapped in `*` or backticks, e.g. `**T1.1**`; labels are always taken from the raw text).
    (a) checklist task `^\s*[-*+]\s+\[([ xX])\]\s+(TASK_ID)\b ID_SEP (.*)$` → task; label = the rest with leading `[P]` / `[US<n>]` markers (optionally in backticks) removed and trimmed;
        `meta.done` = true for x/X, false for a space; `meta.parallel` = true when a `[P]` marker was removed.
    (b) table row (a line whose trimmed text starts with `|`; cells = the text between the outer pipes split on unescaped `|`, each trimmed): first cell `^W(D\d+)W$` → decision, label = second cell,
        `meta.value` = third cell when present; first cell `^W(REQ_ID)W$` → requirement, label = second cell; else the first of cells 0 and 1 that matches `^W(TASK_ID)W(?:[ \t:]+(.+))?$` → task, label = that
        remainder, or the next cell when there is none; an empty label becomes the id. Separator rows (`---`) and header rows match nothing.
    (c) heading `^(#{2,6})\s+(.+)$` whose text matches `^(TASK_ID)\b ID_SEP (.*)$` → task; `^(D\d+)\b ID_SEP (.*)$` → decision; `^(REQ_ID)\b ID_SEP (.*)$` → requirement;
        `^User Story (\d+)\s*[-–—:]\s*(.+?)(?:\s*\(Priority:\s*(P\d)\))?\s*$` → requirement with id `US<n>`, `meta.priority` = the P-value when present.
    (d) bullet requirement `^\s*[-*+]\s+\*\*(REQ_ID)\*\*[:.]?\s*(.*)$` → requirement; bullet decision `^\s*[-*+]\s+\**(D\d+)\**[:.]?\s+(.+)$` → decision.
    Label = `cleanLabel` of the captured text (an empty label becomes the id). `meta.lines = [n, n]` (the line number). The first occurrence of an id in a file wins; later ones are
    ignored (no node, no ref). A spec node exists iff the file yielded at least one task or requirement: id `spec`, type `spec`, label = the first `# ` heading with a leading
    `Feature Specification:` / `Implementation Plan:` / `Tasks:` / `Spec:` prefix removed (fallback: the file name without extension), `meta = { lines: [1, total], title: label }`;
    it gets a `part_of` edge from every task and requirement node (EXTRACTED, score 1, `sourceLocation` of the child). Decisions get no `part_of`.
    FROM-SPEC (spec:243-246, spec:250 "part_of: task → spec, requirement → spec", spec:284) FROM-CALLERS (specs/007-ctc/spec.md §8 and §9 tables, specs/006-merged-core/spec.md:393-410 checklists,
    specs/002-context-coding-graph/{spec,tasks}.md) YOUR-CHOICE (all regexes, label/meta rules, first-wins, fence skipping; no story/ticket/plan-step types because spec:246 lists only four)

D6  Issue files and CLAUDE.md. (a) `.scratch/<feature>/issues/<NN>-<slug>.md`: one task node, id `issue-<NN>` (digits as written, `03` stays `03`), label = the first `# ` heading with a leading
    `^\d+\s*[—–-]\s*` removed (fallback: the file name without extension), `meta = { lines: [1, total], status?, blockedBy? }` from the first `Status:` / `Blocked by:` line (text after the colon,
    trimmed, kept when non-empty). No spec node, no edges. Refs: first one `{from: <task id>, relation: 'part_of', kind: 'node', target: 'ctx:.scratch/<feature>/spec:spec', line: 1}`, then every code
    reference of D9 found in the file outside fences, relation `implements`. The document rules D5 do NOT run on issue files.
    (b) `CLAUDE.md`: every line outside fences matching `^- (\d{4}-\d{2}-\d{2}) [—–-] (.+)$` is a decision with id `D<date>` (second and later on the same date: `D<date>-2`, `-3`, ...), label = text up to the
    first `. ` (period + space) or the whole text, one trailing `.` removed, `cleanLabel`; `meta = { lines: [a, b], date }` where `b` extends over the following non-empty lines that start with neither
    `- ` nor `#` (at most 40 lines); refs of D9 are searched in all those lines (relation `decides`). The rules D5 do NOT run on `CLAUDE.md`; no spec node.
    FROM-SPEC (spec:284 "CLAUDE.md decisions") FROM-CALLERS (CLAUDE.md:95-117 dated decision bullets, .scratch/context-coding-graph/issues/03-links-build-claudemem.md) YOUR-CHOICE (ids, label cut, part_of target, ticket = task)

D7  Node and edge writes (worker). Rows are written with origin `parser`: nodes `{ id, kind, type, label, sourceLocation, contentHash, meta }` exactly as parsed; edges `{ src, dst, relation, confidence, score, sourceLocation }`
    from the parse (`part_of`, EXTRACTED, 1) plus the resolved refs (D9). `sourceFile` = the document path. One `replaceSource` call per document, `source` omitted (D17), so `graph_sources` is never touched by the
    context layer. Confidence and score: EXTRACTED 1, INFERRED 0.6, AMBIGUOUS 0.3 (T2.2 `SCORES`, packages/core/src/graph/resolve.ts:19 — import `SCORES`, do not copy the numbers). Rows of other origins are never touched.
    FROM-SPEC (spec:266, spec:268) FROM-CALLERS (packages/shared/src/repositories/graph.ts:34-88) YOUR-CHOICE

D8  Silence rule. Where this list says nothing, choose the more tolerant, less destructive behaviour (keep old rows rather than delete, emit no edge rather than a wrong `EXTRACTED` one, skip one file or one
    capability rather than fail the job) and write a `judgment:` comment at that spot naming the choice. FROM-OWNER (O11)

D9  References. `parseContext` extracts raw code references from task and decision source text (checklist item, table row, heading line, dated decision lines, issue file lines — NOT from requirements, not from prose
    below the node's line). Token regex (global): `(?<![\w./@:-])(?:\.\/)?((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]*[A-Za-z0-9_-]\.[A-Za-z0-9]{1,8})(?:::([A-Za-z_]\w*))?` (a repo-relative path with at least one `/` and an extension,
    optionally `::symbol`; URLs and `a.b.c` names do not match). A token with a symbol gives `kind: 'path_symbol'`, `target: '<path>::<symbol>'`; without: `kind: 'path'`, `target: '<path>'` (no leading `./`). Relation: `implements`
    for tasks, `decides` for decisions. Deduplicated per `(from, kind, target)`, at most `maxRefsPerNode`. `line` = the line the token is on.
    `resolveRefs(refs: CtxRef[], nodes: RefNode[], opts?: { inferred?: boolean }): ResolvedRef[]` (pure; `RefNode = { id: string; type: string; label: string; sourceFile: string | null }` — a `GraphNode` row is assignable;
    `ResolvedRef = { src: string; dst: string; relation: string; confidence: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS'; score: number; sourceLocation: string }`, `sourceLocation = 'L' + line`):
      `path`: the node with `type` `file` or `page` (a markdown page) and `sourceFile === target` → EXTRACTED 1; none → no edge.
      `path_symbol`: candidates = nodes with `sourceFile === path`, `type !== 'file'` and a label equal to the symbol, or to `symbol + '()'`, or whose text after the last `.` equals the symbol. Exactly 1 → EXTRACTED 1; 2 or 3 → one AMBIGUOUS
      0.3 edge per candidate; more than 3 → no edge; 0 candidates but the file node exists → one INFERRED 0.6 edge to the file node; otherwise no edge.
      `node`: a node whose `id === target` → EXTRACTED 1 (used for `part_of`); none → no edge.
      With `opts.inferred` every EXTRACTED result becomes INFERRED 0.6 (model-proposed edges, D15); AMBIGUOUS stays 0.3.
      Result deduplicated per `(src, dst, relation)` keeping the highest score, sorted by `src`, `dst`, `relation` (code-unit order); never edits its arguments; never throws; nodes with `sourceFile === null` or a synthetic
      `<...>` source file are never targets.
    FROM-SPEC (spec:263 "implements: task → code", spec:264, spec:266, spec:284) FROM-CALLERS (packages/core/src/graph/resolve.ts:19-21, packages/core/src/graph/types.ts:52-58) YOUR-CHOICE (regex, tiers, candidate cap 3, fallback to the file node)

D10 Context pass (apps/worker/src/context/pass.ts). `contextPass(o: { repos: Repositories; ctx: { userId: string; projectId: string }; root: string; files?: string[]; force?: boolean; cache?: PassCache; embed?: Embed; submit?: Submit;
    log?: Log; signal?: AbortSignal }): Promise<ContextPassResult>`; `PassCache` = T2.2's `RebuildCache`; `Embed`, `Log` as T2.2; `Submit = (input: SubmitInput) => Promise<unknown>` (`SubmitInput` of apps/worker/src/library/scan.ts:24).
    (a) Scope: `files` undefined or more than `maxPayloadFiles` entries → full mode (`walkProject`); else files mode (`checkPaths`). Candidates = included files for which `isContextPath` is true. Non-context entries of `files` are ignored
    silently (counted in `counts.ignored`). (b) Each candidate is read with `readText`; an unreadable one is `failed` (code `read_failed`) and keeps its rows. (c) Change detection compares the NEW rows (parsed nodes + part_of edges + resolved ref edges)
    with the stored `origin === 'parser'` rows of the same `sourceFile` (nodes by `id|type|label|contentHash|sourceLocation`, edges by `src|dst|relation|confidence|score`); equal → unchanged, nothing written; `force` writes anyway. Resolution input =
    `repos.graph.loadGraph(ctx)` nodes (all origins; `resolveRefs` applies its own filters). (d) Deletions: a stored parser source file (not starting with `<`) that is no longer a readable candidate loses its `claude` rows first, then its
    `parser` rows (`deleteSource` with `keepSource: true`, D17); full mode deletes nothing when the walk was truncated; files mode deletes only for listed files. A file that parses to zero nodes loses its parser rows the same way.
    (e) When anything was written or deleted: `repos.projects.bumpEpoch(ctx, projectId, 'graph')` (failure logged, ignored), `cache.epoch.rotate('graph', ...)` and `cache.publishInval({v:1, event:'graph.rebuild', ...})` (failures logged, ignored), as T2.2 D19.
    (f) Extract jobs: for each written file with at least one task or decision node and a `submit`, submit `{ queue: 'graph', kind: 'extract', payload: { userId, projectId, files: [file] }, id: 'graph.extract:' + projectId + ':' + <first 16 hex of
    sha256(file + "\0" + the file's node contentHashes joined by "\n")> }`, at most `maxExtractSubmit` per pass; a submit error is logged and ignored. (g) The `signal` is checked between files; an abort stops after the file in progress, still runs (e),
    then rethrows the abort reason.
    Result: `{ mode: 'full' | 'files'; counts: { candidates; changed; unchanged; written; deleted; failed; ignored; edges; embedded; submitted }; files: { written: string[]; deleted: string[]; failed: { file: string; code: string }[] }; truncated: boolean; epoch: string | null }`,
    lists sorted in code-unit order and cut to `resultListMax`, JSON-safe. Throws only for repository errors and the abort reason. One bad file never stops the others.
    FROM-SPEC (spec:284, spec:290 incremental, spec:295) FROM-CALLERS (apps/worker/src/graph/rebuild.ts:62-77, :268-275, :386-405; apps/worker/src/graph/walk.ts:90,155; apps/worker/src/library/scan.ts:24)
    YOUR-CHOICE (output-compare change detection because `graph_sources` has one row per file and no origin; edges to code are only recomputed when their document is processed)

D11 Embeddings of context and capability nodes. On every pass (also one that wrote nothing), when `embed` is given, `contextPass` embeds nodes that have no embedding the way T2.2 D20 does: pages of `repos.graph.pendingEmbeddings(ctx, { limit: graphLimits.embedBatch, afterId })`
    (any origin), text = `embedText(label, meta, lines)` of apps/worker/src/graph/rebuild.ts, one `embed(texts)` call per page, `setEmbedding(ctx, id, vector, sha(text))`; an embed error ends the loop (logged), a bad vector is skipped (logged). Two edits to rebuild.ts make this possible and
    nothing else may change there: `export` on `embedText`, `readText`, `sha`; and, inside `embedText`, a node whose `meta.embedText` is a string uses that string (cut to `graphLimits.embedTextChars` code points) instead of the label + source lines. Capability nodes carry
    `meta.embedText = name + "\n" + description` (cut to `maxEmbedText`). `linkCapability` (D13) does not embed; the next `contextPass` (also one with `files: []`) or `graph.rebuild` (T2.2's loop sees `meta.embedText` too) embeds them.
    FROM-SPEC (spec:287 "Embed: each node's text via TEI, only when content_hash changed") FROM-CALLERS (apps/worker/src/graph/rebuild.ts:84-93, :376-414) YOUR-CHOICE

D12 Capability parse (pure). `parseCapability(input: CapabilityInput): CapabilityParse`; `CapabilityInput = { kind: 'skill' | 'agent' | 'command' | 'workflow'; name: string; description: string; frontmatter: unknown; body: string;
    servedVersion: number | null; bodyHash: string }` (the F2 version row + main file: `Version.frontmatter`, `Version.description`, `Version.bodyHash`, `bodyOf(kind, mainPath, content)` of @ctc/core/library); `CapabilityParse = { nodes: CtxNode[]; edges: CtxEdge[]; hash: string }`.
    Never throws, never edits `input`, deterministic. An invalid `name` (not matching `NAME_RE` of packages/core/src/library/index.ts:30) returns `{ nodes: [], edges: [], hash: '' }`.
    Capability node: id `<kind>:<name>`, `kind: 'capability'`, type = the kind, label = name, `sourceLocation: null`, `meta = { description (cut to maxDescription), servedVersion, embedText }`, `contentHash = hash` where
    `hash` = sha256 hex of `${CONTEXT_VERSION}\0${kind}\0${name}\0${servedVersion ?? ''}\0${description}\0${bodyHash}\0${stableJson(frontmatter)}` (`stableJson` = JSON with object keys sorted recursively; non-JSON input → `null`).
    References inside a text: regex (global) `(?<![\w:./-])(skill|agent|command):([a-z0-9]+(?:-[a-z0-9]+)*)(?![\w-])`; target id `<kind>:<name>`, name at most 64 characters; `workflow:` is not a target kind; no bare names and no `/name` form.
    `uses` edges (skill, agent and command capabilities only; EXTRACTED 1): from the references in `body` and from the frontmatter keys `skills`, `agents`, `commands` (an array of strings or one string split on commas / whitespace; each item must match `NAME_RE`, invalid items
    are ignored) to the target kinds `skill`, `agent`, `command`; no self edge; distinct targets, at most `maxCapabilityRefs`. A target need not exist (a forward reference is kept; readers ignore edges with a missing end).
    Workflows: `frontmatter.nodes` (the whole YAML/JSON mapping is the frontmatter of a workflow, packages/core/src/library/index.ts:98) is read when it is an array; an item is a step when it is an object whose `id` is a string matching
    `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`; the first item with an id wins, at most `maxWorkflowNodes` steps. Step node: id `workflow:<name>:<id>`, type `workflow_step`, label = the id, `meta = { nodeType (the item's string `type` or 'unknown'), embedText: <name> + " " + <id> }`, `contentHash` =
    sha256 hex of `${hash}\0${id}`. Edges: `contains` workflow → each step (EXTRACTED 1); `invokes` step → target for every reference found in the item's string fields `prompt`, `run`, `question` (EXTRACTED 1, same caps). A workflow gets no `uses` edge from its body.
    `edges` sorted by `src`, `dst`, `relation` (code-unit order); `nodes` = the capability node, then steps in file order.
    FROM-SPEC (spec:244 "capability ids", spec:246 node types, spec:262-264 relations, spec:286, spec:591 workflow file shape) FROM-CALLERS (apps/worker/src/library/handlers.ts:47-69, packages/core/src/library/index.ts:77-100, :156-165)
    YOUR-CHOICE (explicit `kind:name` references and frontmatter lists only; `contains` reused for workflow → step; agents may use skills; forward references kept)

D13 Capability linking (worker). `linkCapability(o: { repos: Repositories; userId: string; projectId: string; capId: string; cache?: PassCache; log?: Log }): Promise<LinkResult>` with `LinkResult = { capId: string; projectId: string; status: 'linked' | 'unchanged' | 'removed' |
    'skipped'; reason?: string; nodes?: number; edges?: number }`. Source file of the rows: `<cap:<kind>:<name>>` (synthetic; never a real path; origin `parser`; `graph_sources` untouched). Steps: `repos.library.get({userId}, capId)`; missing → `skipped`/`not_found` (nothing deleted);
    `removedAt` set → `deleteSource({ origin: 'parser', sourceFile, keepSource: true })`, status `removed`; no served version → `skipped`/`no_served_version`; another live capability of the same kind and name wins when its `(namespace, id)` is smaller in code-unit order →
    `skipped`/`duplicate_name`; the served version's manifest, `mainPathOf`, `getBlob`, `bodyOf` → `parseCapability`; a missing main file or blob → `skipped`/`no_main_file` / `blob_missing`; empty parse → `skipped`/`bad_capability`. If the stored node `<kind>:<name>` of the project
    (`repos.graph.getNode`) has `contentHash === hash` → `unchanged` (nothing written). Otherwise one `replaceSource({ origin: 'parser', sourceFile, nodes, edges })` (`source` omitted) → `linked`, then epoch bump + `ctc:inval` as D10(e). Idempotent; never reads another user's rows.
    `syncCapabilities(o: { repos; ctx: { userId: string; projectId: string }; cache?; log?; signal? }): Promise<{ linked: number; unchanged: number; skipped: number }>` links every LIVE capability of the user (`repos.library.listCapabilities` returns live ones only; pages of 200 through `page.next`, at most `maxSyncCaps`); rows of a capability removed later go when `library.changed` runs for it.
    `withCapabilityLinks(handler: Handler, deps: { repos: Repositories; cache?: PassCache; log?: Log }): Handler` runs the inner `library.changed` handler first (its error propagates and nothing is linked), then links `payload.capId` into every project of `payload.userId`
    (`repos.projects.list`, at most `maxProjects`); a link error for one project is logged and counted, never thrown; returns `{ ...innerResult, graph: { projects: number; linked: number; removed: number; unchanged: number; skipped: number; failed: number } }` (an inner result that is not an object is wrapped as `{ result, graph }`).
    The context-pass wrapper (D16) calls `syncCapabilities` only when the project graph has no node of type skill, agent, command or workflow (`repos.graph.stats`).
    FROM-SPEC (spec:286 "after F2 library.changed, upsert the capability node and its uses / invokes edges", spec:217 "one graph per project", spec:396) FROM-CALLERS (apps/worker/src/library/handlers.ts:47-99, packages/shared/src/repositories/library.ts:31-64, :130-170, packages/shared/src/repositories/projects.ts:45)
    YOUR-CHOICE (a user's capabilities are copied into every project graph; duplicate-name tie-break; sync only into an empty capability layer; swallow per-project link errors because the library work already succeeded)

D14 Doc extract prompt and reply (pure). `buildExtractPrompt(o: { file: string; text: string; nodes: { id: string; type: string; label: string }[] }): string`: deterministic; lists every node as a line `<localId> | <type> | <label>` (`localId` = the id after `ctx:<stem>:`), then the document text between a line `<<<DOC` and a line `DOC>>>`, `sanitize`d and cut to `maxPromptChars` code points; the
    LAST line is exactly `Reply with JSON only: {"edges":[{"from":"<id>","relation":"implements|decides","to":"<path>[::symbol]"}]}`. The prompt also tells the model to use no tools and to name only paths written in the document or listed in it.
    `parseExtractReply(reply: string, o: { file: string; nodes: { id: string; type: string }[] }): ExtractReply` with `ExtractReply = { ok: true; edges: { src: string; relation: 'implements' | 'decides'; kind: 'path' | 'path_symbol'; target: string }[]; dropped: number } | { ok: false; code: 'bad_reply'; message: string }`.
    JSON is taken from, in order: the trimmed reply; the first fenced block (```json or ```); the substring from the first `{` to the last `}`; none parses to an object with an array `edges` → `{ ok: false, code: 'bad_reply' }`. An item is kept iff it is an object, `from` is the local id of a node of `o.nodes` (id with the prefix `ctx:<stem>:`),
    `relation` is `implements` with a `task` node or `decides` with a `decision` node, and `to` (trimmed, one leading `./` removed) is exactly one D9 token; `src` = the full node id. Duplicates by `(src, relation, target)` count as dropped; items beyond `maxModelEdges` are dropped; `dropped` counts every discarded item. Order = reply order.
    Never throws; the message of a failure never contains reply text.
    FROM-SPEC (spec:284 "Doc extraction (`claude -p --model haiku`, job `extract`) adds implements / decides edges … marked INFERRED") FROM-CALLERS (packages/shared/src/queues/payloads.ts:15) YOUR-CHOICE (prompt layout, reply format, strict validation; JSON repair beyond the three forms is not attempted)

D15 Extract job (apps/worker/src/context/extract.ts). `type RunClaude = (o: { prompt: string; signal: AbortSignal }) => Promise<string>`; `extractHandler(deps: { repos: Repositories; config: { mode: string }; runClaude: RunClaude; cache?: PassCache; log?: Log }): { 'graph.extract': Handler }`.
    Payload `{ userId, projectId, files: string[] }` (already Zod-validated by runAttempt). Order: `mode !== 'local'` or `userId !== 'local'` → `JobDropped('extract_not_local')`; no project → `JobDropped('project_not_found')`; root missing → `JobDropped('root_missing')`. Files = unique, sorted, first `maxExtractFiles`; the rest are `skipped` with
    `over_limit`. Per file: not `isContextPath` or unsafe → skipped `not_context`; unreadable → skipped with the reason of `readText`; no task/decision node in `parseContext` → skipped `no_context_nodes`; else `runClaude({ prompt, signal })`; an error with `code === 'ENOENT'` → `JobDropped('claude_not_found')` (rows written for earlier files stay); any other error or a
    `bad_reply` → that file is `failed` (`runner_error` / `bad_reply`). Edges: `resolveRefs` of the validated edges as refs (`line` 0 → `sourceLocation: 'L0'`) against the stored graph with `{ inferred: true }`; an edge whose `(src, dst, relation)` already exists in the stored graph with an origin other than `claude` is dropped (the parser's EXTRACTED edge is never downgraded). Written with
    `replaceSource({ origin: 'claude', sourceFile: file, nodes: [], edges })` (`source` omitted), replacing the previous `claude` edges of that file; nothing is written when there are no edges and no previous `claude` edges. After the loop: epoch bump + `ctc:inval` when anything was written (D10(e)); if any file `failed`, throw `Error('extract_failed: <first 10 "file (code)"> (+N more)')` (queue retry; successes stay, a retry is idempotent);
    otherwise return `{ counts: { requested; extracted; edges; skipped; failed }, files: { extracted: { file: string; edges: number }[]; skipped: { file: string; reason: string }[]; failed: { file: string; code: string }[] } }`.
    `spawnClaude(o?: { bin?: string; model?: string; timeoutMs?: number; maxChars?: number }): RunClaude` runs `<bin> -p --model <model>` (defaults `claude`, `haiku`, `extractTimeoutMs`, `extractMaxReplyChars`) with the prompt on stdin, in a fresh empty temp directory (removed afterwards), stdout collected as UTF-8; exit code ≠ 0, a timeout (process killed), an abort
    (process killed) or a reply over `maxChars` (process killed) rejects; a missing binary rejects with `code: 'ENOENT'`; stderr is never put into an error message. Tests use a fake `runClaude` or a fake shell script as `bin`; the real `claude` binary is never started.
    FROM-SPEC (spec:284, spec:355 "doc extract fails: INFERRED doc edges missing; parser edges still there", spec:196 job `extract` has no timer) FROM-CALLERS (packages/shared/src/queues/defs.ts:24, apps/worker/src/jobs/consumers.ts:15-17 `Handler`, `JobDropped` packages/shared/src/queues/submit.ts)
    YOUR-CHOICE (stdin prompt, empty cwd, no extra CLI flags because none is verified for the installed claude, 10 files per job, INFERRED score 0.6, failure = retry via the queue)

D16 Handler composition (apps/worker/src/context/handlers.ts). `withContextPass(handler: Handler, deps: { repos: Repositories; config: GraphConfig; cache?: PassCache; embed?: Embed; submit?: Submit; log?: Log }): Handler` returns a handler that (1) runs `handler(payload, hctx)`; if that throws, the error propagates and no context
    pass runs; (2) if `config.mode !== 'local'` or `payload.userId !== 'local'` returns the inner result unchanged; (3) loads the project (a missing project or root returns the inner result unchanged), runs `contextPass({ ..., files: payload.files, force: payload.force, signal: hctx.signal })`, then `syncCapabilities` when the capability layer is empty (D13);
    (4) returns `{ ...innerResult, context: <ContextPassResult>, capabilities?: <SyncResult> }` (a non-object inner result is wrapped as `{ result, context }`). A throw in (3) propagates (the job is retried; T2.2's own work is hash-gated and cheap the second time). Neither wrapper changes `graphHandlers` or `libraryHandlers`
    (their key lists are pinned by tests); `extractHandler` is a separate map. `apps/worker/src/context/index.ts` exports exactly: `contextPass`, `withContextPass`, `extractHandler`, `spawnClaude`, `linkCapability`, `syncCapabilities`, `withCapabilityLinks`, `contextWorkerLimits`, and the types `ContextPassResult`, `LinkResult`, `SyncResult`, `RunClaude`, `ContextDeps`, `ExtractDeps`, `LinkDeps`.
    FROM-CALLERS (apps/worker/src/graph/handler.ts:46-83, apps/worker/src/graph/handler.int.test.ts:27 pins `Object.keys(graphHandlers(..)) = ['graph.rebuild']`, apps/worker/src/library/handlers.ts:99) YOUR-CHOICE

D17 Repository changes (packages/shared/src/repositories/graph.ts; each with a case or test, and `tenancy.test.ts` stays green). R1: `replaceSource` input `source` becomes optional; when it is `undefined` the `graph_sources` row is neither inserted nor updated. A node without `contentHash` then gets `''` (today it would read `source.contentHash`). R2: `deleteSource` input gains `keepSource?: boolean`; when true the
    `graph_sources` row is kept. R3: in `replaceSource` and `deleteSource` the edge delete removes the edges of origin `origin` whose `src` is ANY node of that `sourceFile` (the condition `n.origin = origin` is dropped from the edge subquery only; the node delete keeps its origin condition), so origin `claude` edges leaving `parser` nodes are replaced and removed with their file. Nothing else in the
    module changes: no new function (a new function would need a tenancy case, D12 of T1.3), the existing signatures stay assignable, `KEPT` origins (`review`, `session`) behave as before. Tests (`graph-context.int.test.ts`, scratch schema): `source` omitted leaves `graph_sources` unchanged; `keepSource` keeps it; a `claude` replace with `nodes: []` replaces earlier `claude` edges from parser nodes and leaves `parser` and `ast` edges alone;
    `deleteSource` of origin `claude` removes only `claude` edges; user B's ctx can do none of it to user A.
    FROM-CALLERS (packages/shared/src/repositories/graph.ts:34-88, packages/shared/src/repositories/tenancy.cases.ts:148-167, agent/t2-2-resolve/OPEN.md "graph_sources has no origin column") YOUR-CHOICE

D18 Must never. Write, rename or delete anything under the project root; read outside the root; start the real `claude` binary in a test; touch rows whose origin is not `parser` (context pass, capability link) or not `claude` (extract job); delete `ast` rows or `graph_sources` rows; touch another user's or another project's rows;
    store an edge whose `src` is not a node written by the same call, except `claude` edges whose `src` is a stored parser node of the same file, and `part_of` / `uses` / `invokes` / `contains` targets that are forward references (D12, D9 `node` refs are written only when the target exists); store two nodes with one id in one call; downgrade an existing non-`claude` edge (D15); modify the arguments of `parseContext`,
    `resolveRefs`, `parseCapability` (inputs may be deep-frozen); hang (every wait is bounded by the `AbortSignal` and the child-process timeout); read env vars other than through the injected `bin` option, `~/.claude`, or the network; throw from `parseContext`, `resolveRefs`, `parseCapability`, `parseExtractReply`, `buildExtractPrompt`, `isContextPath`. YOUR-CHOICE

D19 Non-goals (and who does them instead): query, explain, path, affected, neighbors, MCP, `/api/graph` and the RAM-graph reload (T2.4, T5.1); ignoring edges whose end node is missing (T2.4 readers do that); the worker main and Redis/TEI/`submit` wiring; a `graph.extract` trigger from anywhere but `contextPass`; parsing `.claude/skills|agents|commands|workflows`
    files of a project directly (F2 versions them; D4); `serves` edges (learned from F2 enrichment, later); story, ticket, plan-step, feature or criterion nodes; PLAN.md step ids; cross-file `part_of` between `tasks.md` and `spec.md` of one feature directory (only the issue → feature spec link of D6a); re-resolving code edges of an unchanged document when only the code changed (D10);
    cleaning `claude` edges whose parser node disappeared (they dangle until that file's next extract); changing T2.1/T2.2 code beyond D11; the Jobs-page "force" action; any frontend. FROM-SPEC (spec:779-780) YOUR-CHOICE

D20 Failure modes. A document that does not parse → the rest of the pass continues, the file is listed in `files.failed` with its code and keeps its old rows. TEI down → rows are written, nodes embed later (D11). Redis down → epoch/inval failures are logged and ignored (rows are committed). `claude` missing → extract job dropped `claude_not_found`; parser rows unaffected. `claude` fails or
    answers garbage → the file is `failed`, the job throws `extract_failed` and is retried by the queue; parser rows unaffected. A hostile label (control characters, 10,000 characters) is cleaned and cut by `cleanLabel`. A capability whose YAML was rejected by F2 has no served version and is skipped. FROM-SPEC (spec:355, spec:449, spec:215) YOUR-CHOICE

D21 Gate test and fixtures. `packages/core/src/context/parser.fixtures.test.ts`: `describe('parser fixtures')` with the `it` names listed in SPEC.md. Fixtures are real excerpts under `packages/core/src/context/__fixtures__/` (suffix `.txt` so no tool indexes them), each with `<name>.expected.json` next to it (`spec007.md.txt` → `spec007.expected.json`), written by hand from DECISIONS (not generated from the code under test), and every non-empty fixture line copied verbatim from the real file:
    `spec007.md.txt` = the `## 8. Tasks` and `## 9. Decisions` sections of specs/007-ctc/spec.md (expects exactly 24 task ids `T0.1 … T7.2` and 10 decision ids `D1 … D10`, no requirement); `spec006.md.txt` = the `**Phase 2` … `**Phase 3` checklist lines of specs/006-merged-core/spec.md plus the full phase list (24 checklist tasks in the whole file);
    `tasks002.md.txt` = the first 40 lines of specs/002-context-coding-graph/tasks.md (`T001 …` ids, `done` flags, `[P]`, `[US<n>]` stripped); `spec002.md.txt` = lines containing `User Story` headings and `**FR-` / `**SC-` bullets of specs/002-context-coding-graph/spec.md (the whole file has 30 `FR-`, 7 `SC-` and 8 `US` requirements);
    `issue03.md.txt` = .scratch/context-coding-graph/issues/03-links-build-claudemem.md; `claude-decisions.md.txt` = five consecutive dated bullets of CLAUDE.md including one with a continuation line. Capability cases (`capability nodes`) use inline objects (a skill, an agent, a command, a workflow). Also tested: every limit (shrink by assigning to `contextLimits`, equal is valid, one more
    is `too_large` / dropped, pin the default), hostile input (a 10,000-character label, control characters, `__proto__` / `constructor` ids, a 1 MB line), deep-frozen input, determinism, and a must-NOT test for every non-goal of D19 that is observable. FROM-SPEC (spec:779 "parser fixtures") FROM-CALLERS (packages/core/src/graph/graph.ids.test.ts, the T2.1 golden style) YOUR-CHOICE (test names, excerpt boundaries)

D22 Layout, exports, scope. New: `packages/core/src/context/{index,types,limits,parse,refs,capability,extract}.ts` (+ tests, fixtures) — `index.ts` exports exactly `parseContext`, `isContextPath`, `resolveRefs`, `parseCapability`, `buildExtractPrompt`, `parseExtractReply`, `contextLimits`, `CONTEXT_VERSION` and the types `CtxNode`, `CtxEdge`, `CtxRef`, `ContextParse`, `RefNode`, `ResolvedRef`, `CapabilityInput`, `CapabilityParse`, `ExtractReply`;
    `apps/worker/src/context/{index,limits,pass,capability,extract,handlers,epoch}.ts` (+ tests, `testing.ts`). The core module imports only `node:crypto`, `../graph/ids.ts`, `../sanitize/index.ts` and `../library/index.ts` (for `NAME_RE`), nothing from `apps/*`, no I/O. The worker imports `@ctc/core/context`, `@ctc/core/graph`, `@ctc/core/library`, `@ctc/shared/{queues,repositories}` and, by relative path, `../graph/{rebuild,walk,limits}.ts`
    and `../library/scan.ts` (types) and `../jobs/index.ts` (type `Handler`). No new dependency. `packages/core/src/graph/` and `packages/core/src/index.ts` are not touched (their tests pin them). YOUR-CHOICE (a new core directory instead of `graph/` because T2.1's `graph.test.ts` pins the exact export list of `graph/index.ts`; spec:1.2 names `core/graph` as the home of "push, sanitize", and the OPEN.md entry lets the owner move it)
