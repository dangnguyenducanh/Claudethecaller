# Decisions for T5.2: `/v1/hook/pre` (file note, search hint, caps) and the gate `failopen`

Tags: FROM-OWNER (O#, agent/OWNER.md), FROM-SPEC (specs/007-ctc/spec.md line), FROM-CALLERS (file:line), YOUR-CHOICE (owner reviews every one, O11).
"spec" = `specs/007-ctc/spec.md`. "note" = `packages/core/src/graph/note` (`@ctc/core/graph/note`, pure). "web" = `apps/web/src/pre`. "store" = the T2.4 RAM graph store (`createGraphStore`,
apps/web/src/graph/store.ts:25). "query" = `@ctc/core/graph/query` (T2.4). "push" = `@ctc/core/graph/push` (T5.1). "suggest" = `apps/web/src/suggest` (T5.1). "config" = the T1.1 `Config`
(packages/shared/src/env/schema.ts), read at call time. A tag at the end of a block of indented lines covers the whole block above it. Nothing here is copied from the Python hook; it is drafted from the spec,
the merged TypeScript callers and the T5.1 contract (only the wire shape of the reply was read from src/ctc/server/hooks.py:206).

D0  Purpose and callers. Given the PreToolUse JSON of Claude Code, answer with a short `additionalContext` text from the RAM graph, or with nothing. One route, `POST /v1/hook/pre` (curl `-m 0.05`):
    (a) Read, Edit, Write, MultiEdit on a file: a NOTE naming the tasks that implement it, the decisions that decide it and its top callers (spec:317);
    (b) Bash `grep`/`rg`/`find`, Grep, Glob: a HINT naming up to `graph.hint.max_nodes` graph nodes that match the search terms as `path:symbol` (spec:318);
    (c) every other tool, a path outside the project, a quiet or capped session, an unknown project, any failure: nothing (`204`).
    Callers: the ctc-web bootstrap (built later) mounts `preRoutes(deps)` with the store it already holds and passes `caps.markGraphCall` as the `onToolCall` of the graph tools (apps/web/src/graph/common.ts:28);
    T7.1 points `.claude/settings.json` at the route. T5.1's prompt hook stays untouched. The gate `failopen` (D21) measures both hooks.
    FROM-SPEC (spec:106 route and reply, spec:315-319 behaviour and caps, spec:345 `graph.hint`, spec:369 gate, spec:788 T5.2) FROM-CALLERS (apps/web/src/memory/hook.ts:63-88 and apps/web/src/suggest/index.ts:273-307 are
    the route pattern this task copies: a plain `Route`, `reply.code(n).send(x)`, the handler never throws).

D1  Trust. Untrusted: the whole request body (`cwd`, `tool_name`, `tool_input` and every value in it, `session_id`, extra keys), every label, path, location and id read from the RAM graph. Trusted: `ctx` from
    `deps.ctxOf(req)` (default `{userId:'local'}`, spec:138), `deps.config`, `deps.caps`.
    Rules: the project, the graph and the session counters are the ones of `ctx.userId` only (the store and `projectOf` take `ctx`; the caps key carries the user); every piece of text that enters a note or a hint
    (path, label, id, symbol) passes `clean` (sanitize, whitespace runs to one space, trimmed, cut to 256 code points); the finished text is NEVER passed through `sanitize` (it starts with `ctc: ` and would erase itself,
    packages/core/src/sanitize/index.ts:12); a shell command is only tokenized, never executed, expanded or logged; a path from the tool input is only compared as a string, never opened.
    Prevents: prompt injection through a label or a path (`<system-reminder>`, a newline plus `ctc: …`), one user's graph in another's note, a command or path leaking into logs.
    FROM-SPEC (spec:138-140, spec:215 sanitize) FROM-CALLERS (packages/core/src/sanitize/index.ts:12; packages/core/src/graph/query/model.ts:80 `clean`). The 256-point cut for paths from the body: YOUR-CHOICE.

D2  Limits. Two exported, mutable objects read at call time (a test may change a field and restore it):
    web `preLimits = { hookBudgetMs: 40, projectMemoMs: 30000, projectMemoMax: 256, sessionMax: 1000, sessionIdleMs: 86400000 }`;
    note `noteLimits = { itemChars: 80, tokenMin: 3, tokenMax: 64, tokensMax: 4, commandChars: 4096 }`.
      `hookBudgetMs`: the hook replies after at most 40 ms (D18). `itemChars`: one note item (`T7.1 Post ledger entries`, a pointer, a hint pointer) is cut to 80 code points, the last kept one replaced by `…`
      (exactly 80 is unchanged; 81 gives 79 + `…`), so an item is never half shown by the budget cut (D14). `tokenMin`/`tokenMax`: a search token shorter than 3 or longer than 64 code points is dropped.
      `tokensMax`: at most the first 4 distinct tokens search (the lexical scan is once per token over the whole label vocabulary). `commandChars`: a shell command is read up to its first 4,096 UTF-16 code units.
      `projectMemoMs`/`projectMemoMax`: D12. `sessionMax`/`sessionIdleMs`: D17.
    From config (not constants): `graph.hint.per_session` (5), `graph.hint.quiet_s` (1800), `graph.hint.max_nodes` (5), `graph_push.max_chars` (400, counted in code points, inclusive: 400 is valid, 401 is cut),
    `graph_push.note_max` (3: the most items of each note section). A config value that is not a positive integer is replaced by the default above (D8).
    FROM-SPEC (spec:316 40 ms, spec:317 400 chars and top 3, spec:318 5 nodes, spec:319 5 per session and 30 minutes, spec:345 `graph.hint`) FROM-CALLERS (packages/shared/src/env/schema.ts:102-107 `graph_push`
    incl. `note_max`, :132-136 `graph.hint`). `itemChars`, `tokenMin`, `tokenMax`, `tokensMax`, `commandChars`, `projectMemo*`, `session*` and `note_max` as the cap of tasks and decisions too: YOUR-CHOICE (chosen by judgment).

D3  Output and error format.
    Route: `200` with an OBJECT body exactly `{ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: <text> } }` (no other key anywhere: never `permissionDecision`, `updatedInput`, `decision`);
    `204` with no body for "nothing to say", a bad body, an over-budget answer or any failure. There is no error body: a hook never errors.
    `run` result `PreResult = { text: string; kind: 'note' | 'hint' | 'none'; reason: 'ok' | 'tool' | 'input' | 'project' | 'outside' | 'quiet' | 'capped' | 'nomatch' | 'error'; commit(): boolean; ms: number }`
    with exactly those keys; `text` is `''` iff `kind` is `'none'`; `reason` is `'ok'` iff `kind` is not `'none'`; `ms` is finite, ≥ 0, rounded to 0.1.
    Note text (one line, starts with `ctc: `, no trailing newline, at most `graph_push.max_chars` code points): `ctc: <path>` followed, for each NON-EMPTY section in the order tasks, decisions, callers, by
    ` · <section>: <item>; <item>…` (section names `tasks`, `decisions`, `callers`; items joined by `; `). Task and decision item = `<local id> <label>` (local id = the text after the last `:` of the node id; the label alone
    when the cleaned label already starts with the local id followed by a non-alphanumeric character; the local id alone when the label is empty). Caller item = pointer (D13).
    Hint text: `ctc: graph nodes matching this search: <pointer>; <pointer>…`.
    Example note: `ctc: src/ledger.ts · tasks: T7.1 Post ledger entries; T7.2 Close the books monthly · decisions: D2 Entries are append only · callers: src/api.ts:handlePost`.
    FROM-SPEC (spec:106 "200 JSON additionalContext, or empty", spec:147 `204` empty hook reply, spec:164 hooks never error) FROM-CALLERS (src/ctc/server/hooks.py:206 the `hookSpecificOutput` wire shape; apps/web/src/suggest/index.ts:304
    `204` vs `200`). The text formats, section names, separators, `PreResult` keys and `reason` values: YOUR-CHOICE.

D4  Bad input (first problem wins, nothing is reported).
    The body must be an object with `cwd` (string, 1..4096, absolute POSIX path) and `tool_name` (string, 1..64); `tool_input`, when present, must be an object (absent means `{}`); anything else gives `204` / reason `input`.
    `session_id` is read separately: a string of 1..128 code units is used, anything else (absent, empty, a number, longer) means "no session id" and is not a rejection (D17). Extra keys are ignored.
    A file tool whose `tool_input.file_path` is missing, not a string, empty or contains a NUL gives reason `input`. A search tool with no usable input (D15) gives reason `nomatch`. `ctx` without a string `userId` is treated as `{userId:'local'}`.
    The schema lives in `@ctc/shared/schemas/pre` as `PreBody = z.looseObject({ cwd: string.min(1).max(4096), tool_name: string.min(1).max(64), tool_input: z.record(z.string(), z.unknown()).default({}) })` and
    `preApiLimits = { cwdMax: 4096, toolNameMax: 64, sessionIdMax: 128 }` (4,096 = Linux PATH_MAX as in the memory and suggest schemas).
    FROM-SPEC (spec:164, spec:146 one Zod schema per route) FROM-CALLERS (apps/web/src/suggest/index.ts:126,291 same cwd rule via `isAbs`; packages/shared/src/schemas/suggest/index.ts the schema pattern). `session_id` leniency and
    the `tool_name` bound: YOUR-CHOICE.

D5  Odd but harmless input stays valid: extra body keys (`transcript_path`, `permission_mode`, `hook_event_name`, `tool_use_id`) and extra `tool_input` keys (`old_string`, `new_string`, `edits`, `content`); `cwd` with trailing slashes
    (`/p//` is project root `/p`, `rootOf` of apps/web/src/memory/common.ts:40); a relative `file_path` (it is taken relative to the project root); a path with `.`/`..` segments that stays inside the project (`./src/../src/a.ts`);
    unicode and spaces in paths; a file with no graph nodes (reason `nomatch`); a file whose nodes have no task, decision or caller (reason `nomatch`); a graph with zero nodes; a `Bash` command that is not a search (reason `nomatch`);
    two identical notes in a row (no de-duplication, D7); a `session_id` shared by two projects.
    judgment: tolerant by default (D8). YOUR-CHOICE.

D6  Must never:
    (a) throw or reject from a route handler or from `run`, `commit`, `markGraphCall`, `blocked`, `charge`, or the pure functions of `note` (every failure is `204`);
    (b) edit its arguments (`body`, `deps`, `config`, the RAM index, the node and edge objects: inputs may be deep-frozen);
    (c) log or return a command, a path, a cwd, a label, a session id or a user id; `deps.log` gets class names and counts only;
    (d) call anything but `repos.projects.byRoot` (through `projectOf`), the `proj:` entry `projectOf` reads and writes, and `graph.get`; call TEI, the reranker, the skill channel, the filesystem, a child process, the network;
        write to Postgres; write any other cache key; start a model call;
    (e) answer from another user's cache entry, project, graph or counters;
    (f) emit more than one line, a text longer than `graph_push.max_chars` code points, a text not starting with `ctc: `, or a reply with a key other than `hookSpecificOutput` (never a `permissionDecision`: the hook cannot block a tool);
    (g) run `sanitize` over the finished text (D1);
    (h) make the hook wait past `hookBudgetMs` (D18) or hang (no wait without a bound: `graph.get` and the project lookup are raced, D18);
    (i) walk the graph (only the direct edges of D13 are read), expand a hub, or read a file's content;
    (j) charge the hint counter for a reply that was not sent (D18), or let a note change a counter (D17);
    (k) write sessions, decisions, events or follow tracking (removed from the product, spec:35).
    FROM-SPEC (spec:35, spec:164, spec:215, spec:316 "RAM only") for (a) (d) (f) (g) (h) (i) (k); the rest YOUR-CHOICE.

D7  Non-goals (which code does that instead): Fastify, auth, rate limit, body size limit (the ctc-web bootstrap); the `settings.json` matcher and curl line (T7.1); the `ctc:inval` subscription and the epoch poll (bootstrap and store);
    embedding, TEI, the skill channel and the prompt line (T5.1); de-duplicating a note already shown in the session; an ancestor walk from a sub-directory `cwd` to its project root; `NotebookEdit` and other tools; reading the file's
    content; a note for documentation files (their nodes are not `code`, D13); persisting or sharing counters across processes or restarts (each ctc-web process counts for itself); a quiet window for notes (D17);
    deciding that a command is dangerous or blocking a tool.
    FROM-SPEC (spec:86-98, spec:316-319). The exact split and "no de-duplication", "no ancestor walk": YOUR-CHOICE.

D8  Silence rule. Where this list says nothing, choose the more tolerant, less destructive behaviour (nothing over a guess, skip a source over trusting it, drop the optional item over cutting an item in half) and put a comment starting
    `judgment:` on that line. FROM-SPEC (ORCHESTRATOR §3 D8).

D9  Public names and wiring.
    `@ctc/core/graph/note` (pure, no I/O; `packages/core/src/graph/note/index.ts`, new directory; do NOT edit `packages/core/src/graph/index.ts` or `push/index.ts`):
      `noteLimits` (D2); `HINT_TYPES: readonly string[]` = `file, module, class, function, method, interface, type, variable` (a test pins that `slotOf` of push gives `file` for each of them with kind `code`);
      `relInside(root: string, p: string): string | null` (D12); `searchTerms(tool: string, input: unknown, o: { root: string }): { terms: string[]; outside: boolean }` (D15);
      `fileNote(index: GraphIndex, rel: string, o: { max: number; maxChars: number }): string` (D13, D14); `hintLine(index: GraphIndex, terms: string[], o: { maxNodes: number; maxChars: number }): string` (D16).
      All return `''`/`[]`/`null` on junk; none throws.
    `@ctc/shared/schemas/pre` (`packages/shared/src/schemas/pre/index.ts`): `PreBody`, `preApiLimits`.
    `apps/web/src/pre/index.ts`: `createPre(deps: PreDeps): Pre`, `preRoutes(deps: PreDeps): Route[]` (exactly one route: `POST /v1/hook/pre`), `createSessionCaps(o?: { now?(): number }): SessionCaps`, `preLimits`, types `Pre`, `PreDeps`, `PreResult`, `SessionCaps`.
      `Pre = { run(ctx: Ctx, input: { cwd: unknown; tool_name: unknown; tool_input?: unknown; session_id?: unknown }): Promise<PreResult> }` (`run` resolves, never rejects).
      `SessionCaps = { blocked(s: { userId: string; projectId: string; sessionId: string }, o: { perSession: number; quietS: number }): 'quiet' | 'capped' | null;
        charge(s: { userId: string; sessionId: string }, o: { perSession: number }): boolean;
        markGraphCall(info: { userId: string; projectId?: string | null; sessionId?: string | null; tool: string }): void; size(): number }` (D17).
      `PreDeps = { repos: Pick<Repositories,'projects'>; config: Pick<Config,'graph'|'graph_push'>; graph: Pick<GraphStore,'get'>; cache?: { get<T>(k): Promise<T|undefined>; set(k, v, ttlSeconds): Promise<void> };
        caps?: SessionCaps; ctxOf?(req: unknown): Ctx; log?(message, fields?): void; now?(): number }` (no `tei`, no `skills`: D6d). `deps.caps` defaults to one private `createSessionCaps({ now: deps.now })`.
    Reuse, do not copy: `slotOf` from push; `lexicalSeeds`, `nodeRef`, `GraphIndex` from query; `clean`, `keyOf`, `weightOf`, `byCode` from `../query/model.ts` (inside `packages/core/src/graph`); `projectOf`, `rootOf`, `isAbs`, `errClass` from
    `apps/web/src/memory/common.ts`; `Route`, `parse` from `apps/web/src/library/http.ts`. Names and the file split: YOUR-CHOICE. Entry paths and the "pure core / apps wire it" split: FROM-SPEC (spec:94, spec:99).

D10 Order of work (observable through the fakes in the tests):
    1 parse the body (D4) → 2 route the tool (D11; an unhandled tool stops here: no project lookup, no graph call) → 3 pure parse with `root = rootOf(cwd)`: the file path to a project-relative path (`relInside`) or the search terms (D15) and
    their `outside` flag; `outside` or no usable input stops here (no project lookup, no graph call) → 4 resolve the project (D12; none stops here) → 5 hints only: `caps.blocked` (D17; `quiet`/`capped` stop here: no graph call) →
    6 `graph.get` (D19) → 7 build the text (`fileNote`/`hintLine`; empty gives reason `nomatch`) → 8 return `{text, kind, reason, commit, ms}`.
    FROM-SPEC (spec:316-319) . The order (cheap pure checks and caps before any I/O): YOUR-CHOICE.

D11 Tool routing (names exact, case-sensitive): `Read`, `Edit`, `Write`, `MultiEdit` → note, path = `tool_input.file_path`. `Grep`, `Glob`, `Bash` → hint (Bash only for a search command, D15). Every other `tool_name`
    (`WebFetch`, `NotebookEdit`, `read`, `Task`, …) → kind `none`, reason `tool`, nothing else happens. The route does not decide which tools Claude Code sends (the `settings.json` matcher does, T7.1); sending more is harmless.
    FROM-SPEC (spec:317-318) FROM-CALLERS (src/ctc/server/hooks.py:202 the m6 hook covered `Read|Edit|Write|MultiEdit`; spec:318 adds the search tools). `MultiEdit` included and `NotebookEdit` excluded: YOUR-CHOICE.

D12 Project and path. `root = rootOf(cwd)`. The project is `projectOf(deps, ctx, root)` (the `proj:` cache first, then `repos.projects.byRoot`; a found project is cached 24 h, a miss is not), wrapped in a RAM memo so the hot path is RAM only after the
    first call: key = user + root; a settled lookup (a project or `null`) is remembered for `projectMemoMs` (30 s) on the clock `deps.now ?? Date.now`; concurrent lookups of one key share one promise; a rejected lookup is forgotten at once
    (not remembered), logged by class name, and counts as "no project"; at most `projectMemoMax` keys, oldest inserted evicted first. No project: kind `none`, reason `project`.
    `relInside(root, p)`: `p` absolute → `path.posix.normalize(p)`; `p` relative → `path.posix.normalize(path.posix.join(root, p))`; then `path.posix.relative(root, abs)`. The result is the project-relative path, or `null` when `p` is outside the root
    (`..` or `../…` first segment, empty result = the root itself, a NUL, a non-string, an empty string). Lexical only: symlinks are not resolved. File tools with `null` → kind `none`, reason `outside`. Search tools: see D15 (`outside`).
    FROM-SPEC (spec:301 "resolve the project from cwd (proj: cache)", spec:319 "nothing for paths outside the project", spec:316 RAM only) FROM-CALLERS (apps/web/src/memory/common.ts:46-63 `projectOf`; apps/web/src/suggest/index.ts D11 same
    "no project" rule). The memo (30 s, 256 keys, share in-flight), `relInside` details, `outside` as a separate reason: YOUR-CHOICE (alternative: no memo, ask `projectOf` every time).

D13 File note content (`fileNote`). The file's nodes = the nodes of the index with `kind === 'code'` and `sourceFile === rel` (the file node and its symbols); none → `''`. Over the INCOMING edges of those nodes (the index already dropped `DROPPED` edges):
    tasks: relation `implements` from a node of type `task`; decisions: relation `decides` from a node of type `decision`; callers: relation `calls` from a node with `slotOf` = `file` (a code node with a path) whose `sourceFile` is not `rel`.
    Each list is distinct by source node id (best edge weight kept), ordered by weight desc (`weightOf`: CONFIRMED and EXTRACTED 1, INFERRED 0.6, AMBIGUOUS 0.3), then node id ascending in code-unit order, and cut to `note_max` items.
    Pointer of a node = its `sourceFile` for a node of type `file`, else `<sourceFile>:<symbol>` with `symbol` = label without one trailing `()` and one leading `.`; a pointer is cleaned (D20).
    A node of any other kind (a doc page that mentions the file) never makes a note; a task that only `mentions` the file is not listed.
    FROM-SPEC (spec:317 "tasks that `implements` it, decisions that `decides` it and the top 3 callers") FROM-CALLERS (packages/core/src/context/types.ts:22 and extract.ts:93 `implements` from tasks, `decides` from decisions; packages/core/src/graph/resolve.ts:28,474
    `calls`; packages/core/src/graph/push/index.ts:29 `slotOf`; packages/core/src/graph/query/model.ts:74 `weightOf`). "Callers" as `calls` into any node of the file from another file, the weight order and `note_max` as the cap of all three lists: YOUR-CHOICE.

D14 Note rendering and cut (`fileNote`). Header `ctc: <path>` (path cleaned, D20). Sections in the order tasks, decisions, callers; an empty section is skipped. Each item text is cut by `itemChars` (D2). Fill greedily: for a section, add its items in
    order while the whole text so far (header, earlier sections, this section's label and the items added) stays within `maxChars` code points; the first item that does not fit ends THAT section (a later, shorter item is not taken in its place); a section
    with no item that fits is left out entirely (never its label alone); later sections are still tried. No section placed → `''` (a header alone is never a note). An item is never cut except by `itemChars`. `maxChars` below 8 → `''`.
    FROM-SPEC (spec:317 "at most 400 chars") FROM-CALLERS (ORCHESTRATOR §3 lesson: a cut must not split the structure callers rely on; packages/core/src/graph/push/index.ts renderLine ladder is the sibling rule). Greedy fill, section order and
    `itemChars`: YOUR-CHOICE (alternative: one ladder like `renderLine`).

D15 Search terms (`searchTerms(tool, input, { root })`, pure; returns `{ terms: [], outside: false }` for anything it does not understand).
    Grep: words come from `input.pattern`; its location is `input.path` if a string. Glob: words from `input.pattern`; location `input.path`. Bash: from `input.command` (a string, read up to `commandChars`), split into segments at unquoted `||`, `&&`,
    `|`, `;`, `&` and newlines; a segment is split into words by whitespace with single and double quotes grouping (an unmatched quote runs to the end of the segment; no expansion, no escapes). In a segment, leading `NAME=value` words and the wrappers
    `sudo`, `command`, `time`, `nohup`, `env`, `exec`, `xargs`, `nice` are skipped; the next word, by basename, is the command. Only `grep`, `egrep`, `fgrep`, `rg` and `find` count; any other command gives nothing for that segment.
    `grep`-family and `rg`: walk the words after the command. A word starting with `-` is an option; when it is exactly one of `-e --regexp -f --file -m --max-count -A -B -C --after-context --before-context --context -g --glob --iglob -t -T --type --type-not
    --include --exclude --exclude-dir -d -D --max-depth -j --threads -M --max-columns`, the NEXT word is its value: for `-e`/`--regexp` the value is a search word, for the others it is skipped. A lone `--` makes every later word a non-option.
    Of the non-option words, when no `-e`/`--regexp` was seen the FIRST is the search word and the others are LOCATIONS; when one was seen, all of them are locations. `find`: the location words are the words before the first word starting with `-`;
    the search words are the values that follow `-name`, `-iname`, `-path`, `-ipath`, `-wholename`, `-regex`, `-iregex`.
    Tokens: from all words, drop `\<letter>` escape pairs (`\b`, `\s`, `\w`…), then take lowercase runs of letters and digits (`[\p{L}\p{N}]+`), keep those with `tokenMin` ≤ length ≤ `tokenMax`, distinct, first-seen order, at most `tokensMax`. `terms` = those tokens.
    `outside` = any location (Grep/Glob `path`, Bash locations, whatever they look like) that starts with `~` or resolves (as in `relInside`, relative to `root`) outside the root; the root itself and paths inside are inside. When `outside` is true `terms` is still returned.
    FROM-SPEC (spec:318 "token-parse the search terms", spec:319 "nothing for paths outside the project") FROM-CALLERS (packages/core/src/graph/query/build.ts:36 `tokenize` is the same letters-and-digits rule; the Claude Code tool inputs `pattern`, `path`,
    `command` as in apps/web/src/spool/fixtures/post-edit.json for the PostToolUse shape). The command list, wrappers, the "non-option word" rule, the token limits and "location" rules: YOUR-CHOICE (a parser, not a shell: `grep -e foo` and `--type ts`
    are handled by dropping short tokens, not by knowing every flag).

D16 Hint nodes and text (`hintLine(index, terms, { maxNodes, maxChars })`). No terms → `''`. Candidates = `lexicalSeeds(index, terms.join(' '), { types: HINT_TYPES, max: 4 × maxNodes })` (query's tiers × IDF × coverage², best first, ties by id), kept only when the node has a
    `sourceFile` and at least one label token (lowercase letters-and-digits runs of its label) EQUAL to or STARTING WITH one of the terms (a substring-only match is not a hint). Pointers as in D13, distinct (first kept), at most `maxNodes`.
    Text `ctc: graph nodes matching this search: ` + pointers joined by `; `; each pointer cut by `itemChars`; fill greedily within `maxChars` as in D14 (the first pointer that does not fit ends the list); no pointer fits → `''`.
    A context node (task, decision, page, heading), a capability node and a package is never a hint.
    FROM-SPEC (spec:318 "at most 5 matching nodes as `path:symbol` hints") FROM-CALLERS (packages/core/src/graph/query/search.ts:21 `lexicalSeeds`; packages/core/src/graph/push/index.ts:29 `slotOf`). The exact-or-prefix filter, the `4 × maxNodes` pool, the text and
    code nodes only: YOUR-CHOICE.

D17 Session caps and quiet (`createSessionCaps`, RAM only, clock `now ?? Date.now`).
    A session = `userId` + `session_id` (the id `''` is one anonymous session per user). Counter: hints SENT in that session. `blocked(s, {perSession, quietS})`: `'quiet'` when a graph_* call mark applies and `now - markedAt < quietS × 1000` (strict: exactly `quietS`
    seconds later it is allowed again); else `'capped'` when the session's counter ≥ `perSession`; else `null`. `'quiet'` is checked first. The marks that apply: the session's own, the one of `(userId, projectId)`, the one of `userId`; the newest decides.
    `charge(s, {perSession})`: if the counter is already ≥ `perSession` returns `false` and changes nothing, else counts one and returns `true`.
    `markGraphCall(info)`: ignored unless `info.tool` is a string starting with `graph_` and `info.userId` is a non-empty string. A non-empty string `sessionId` marks that session; else a non-empty string `projectId` marks `(userId, projectId)`;
    else (`projectId` null, absent or empty: the call failed before a project was known, apps/web/src/graph/tools.ts:54) marks the whole user. Reason: the graph tools do not know Claude's `session_id`, so without one the quiet window is the project's.
    Only HINTS are counted and silenced; notes are neither counted nor silenced by quiet or cap. Memory: at most `sessionMax` sessions (least recently used evicted), a session idle for `sessionIdleMs` starts again from zero when touched; the mark maps are bounded by
    `sessionMax` entries each (oldest evicted). `size()` = number of session counters held; only `charge` creates one (`blocked` and `markGraphCall` never do). A restart forgets everything (non-goal, D7).
    FROM-SPEC (spec:319 "5 hints per session; quiet for 30 minutes after any `graph_*` MCP call in that session") FROM-CALLERS (apps/web/src/graph/common.ts:28 `onToolCall` carries `{userId, projectId, tool}` and no session id; tools.ts:51-56 it fires
    after every graph tool call, success or failure). "Count sent hint replies, not nodes", "quiet and cap apply to hints only", the project-level and user-level fallback marks, the bounds: YOUR-CHOICE (see OPEN.md A.2 and A.3).

D18 Hook budget and charge on send. The route calls `run` (not awaiting it past the budget) and waits at most `preLimits.hookBudgetMs` (40). If the timer wins: `204` now; the work keeps running (it warms the store and the project memo) and its result is dropped:
    its `commit` is NEVER called. If the work wins: the timer is cleared; for `kind` `note` the reply is `200`; for `kind` `hint` the route calls `commit()` once and replies `200` only when it returned `true` (`commit` = `caps.charge`, which re-checks the cap
    at that moment), else `204`; for `kind` `none` the reply is `204`. `commit` of a note or of `none` returns `true` and changes nothing. A timed-out hint therefore never uses up one of the 5.
    FROM-SPEC (spec:316 40 ms, spec:164) FROM-CALLERS (apps/web/src/suggest/index.ts:281-304 and apps/web/src/memory/hook.ts:68-86 same race and cleanup). Charging at send time: YOUR-CHOICE.

D19 Degradation and RAM only. `deps.graph.get({...ctx, projectId})` rejecting, a project lookup rejecting, a throwing `ctxOf`, a throwing `log`, a malformed index, any bug: kind `none`, reason `error` (logged by class name), `204`. `deps.cache` absent or failing is
    a miss. Redis down, TEI down or Postgres down change nothing about the contract: with the graph warm in the store and the project in the memo or the `proj:` L1, the note and the hint still come from RAM; with the store cold the hook replies
    empty within the budget while the load continues in the background. Nothing in this module reads or writes anything else (D6d).
    FROM-SPEC (spec:316 "RAM only", spec:369 `failopen`, spec:205 stale RAM heals by poll) FROM-CALLERS (apps/web/src/graph/store.ts:68-110 `get` keeps serving the stale index when a reload fails and shares one in-flight load). The reason value `error`: YOUR-CHOICE.

D20 Text safety. Every label, path, symbol, local id and pointer that enters a note or a hint is cleaned with `clean` (sanitize, `\s+` to one space, trimmed, cut to 256 code points) BEFORE the `itemChars` cut; an item that is empty after cleaning is skipped (a node with an
    empty label gets its local id, or its file, as label). The path in the note header comes from the tool input and is cleaned the same way. The finished text has no newline, no tab, no run of spaces. FROM-SPEC (spec:215) FROM-CALLERS (packages/core/src/graph/query/model.ts:80
    `clean`, :93 `nodeRef`).

D21 Gate `failopen` (spec:369; the method is defined here, no eval doc exists). Test file `apps/web/src/pre/failopen.int.test.ts`, `describe('failopen')`, exactly four tests:
      1 `'TEI down (refused and hanging): the prompt hook replies within 140 ms with the lexical line and the pre hook within 40 ms with the note'`
      2 `'Redis down (refused and hanging): the prompt hook replies within 140 ms and the pre hook within 40 ms with the note'`
      3 `'Postgres down (refused and hanging): both hooks reply within their budgets, from the warm RAM graph or empty when it is cold'`
      4 `'TEI, Redis and Postgres all down: both hooks reply within their budgets and never fail'`
    It always runs (no switch); a missing scratch service or TEI FAILS the test with that reason (never skips). Setup (outside the timing): scratch schema `ctc_t52_<random>` migrated, dropped in `afterAll` (generous timeout, pools with hanging connects must be closed);
    one project (root `/work/ledger`) and a small hand-made graph written through the repositories (the D13 shapes: a file with symbols, 2+ tasks, a decision, 2+ callers; no tree-sitter, no node embedding); REAL clients: `createTei` (live TEI `127.0.0.1:18300`),
    `createCache` on the scratch Redis with a private namespace, `createDb` + `createRepositories` on the scratch Postgres, the real `createGraphStore`, the real `createSkillChannel` (empty library), the real `suggestRoutes` (T5.1, unedited) and `preRoutes`.
    "Down" = the client's URL points at a dead endpoint, in two kinds, each run: `refused` (a 127.0.0.1 port nothing listens on) and `hang` (a `net` server that accepts and never answers; its sockets are `resume()`d so a client giving up closes them).
    The Postgres-down scenario runs twice: `warm` (the store loaded the graph and the project was looked up while Postgres was still live, then the repository facade the store and the routes hold is switched to the dead one) and `cold` (a fresh store on dead repositories).
    The TEI and Redis scenarios run `warm` only (graph loaded, `proj:` entry and project memo filled by one untimed warm-up call of each hook). Per scenario and hook: 5 timed sequential calls of the in-process handler (`suggestRoutes(deps)[0]`, `preRoutes(deps)[0]`) timed with
    `performance.now()`; the prompt hook gets 5 different prompts that each contain `postEntry` (so neither `sug:` nor `emb:` serves a timed call); the pre hook gets a `Read` of the ledger file.
    Assertions: every timed call replies `200` or `204` without throwing and within `budget + slack` (budget 140 ms prompt / 40 ms pre; slack 25 ms); content, `warm` only: with TEI down the prompt hook returns a line starting `ctc: ` on all 5 calls and the pre hook the note on all 5;
    with Redis down the pre hook returns the note on all 5; with Postgres down (warm) the pre hook returns the note on all 5. Cold and all-down scenarios assert timing and "no throw" only.
    Writes `.ctc-dev/eval/failopen.json` = `{ slack_ms, scenarios: [{ down: ('tei'|'redis'|'postgres')[], kind: 'refused'|'hang', graph: 'warm'|'cold', hook: 'prompt'|'pre', n, max_ms, budget_ms, codes: number[], texts: number }], recorded_at }`
    (`texts` = number of 200 replies); the self-check re-reads `max_ms ≤ budget_ms + slack_ms` for every row and requires the 4 down-sets above to be present.
    FROM-SPEC (spec:369 "TEI, Redis or Postgres down → prompt and pre hooks still reply within budget", spec:299 and :316 the budgets) FROM-CALLERS (apps/web/src/suggest/suggest.latency.int.test.ts the pattern for scratch schema, real `createCache`/`createTei`, strict missing-prerequisite
    failure; apps/web/src/suggest/testing.ts `scratchPgUrl`, `scratchRedisUrl` guards, importable; agent/t4-1-spool/CHANGES.md: a hanging `net` server must `resume()` its sockets). Everything else (the two down kinds, warm and cold, 5 calls, 25 ms slack, which scenario asserts content, no switch): YOUR-CHOICE.

D22 Edits outside the new directories: none. No existing file is edited, not `package.json`, the lockfile, any `index.ts`, `suggest/`, `graph/`, `memory/`, `library/`. Wiring contract (documented in the `apps/web/src/pre/index.ts` header, built later by the bootstrap):
    `const caps = createSessionCaps(); graphTools({ ..., onToolCall: (i) => caps.markGraphCall(i) }); preRoutes({ ..., caps })`. One new test file `apps/web/src/graph/graph.hint.wiring.test.ts` (pure, fakes only) proves it end to end: a `graph_search` call through `graphTools` with that
    `onToolCall` silences the next `Grep` hint of the same project, and a `Read` note still comes. FROM-CALLERS (apps/web/src/graph/tools.ts:51-56; apps/web/src/graph/common.ts:28). The wiring test: YOUR-CHOICE.
