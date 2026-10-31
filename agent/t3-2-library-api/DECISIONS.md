# Decisions for T3.2: library MCP tools, `/api` capability routes, project overrides, restore, blob cleanup

Tags: FROM-OWNER (O#, agent/OWNER.md), FROM-SPEC (specs/007-ctc/spec.md line), FROM-CALLERS (file:line), YOUR-CHOICE (owner reviews every one, O11).
"spec" = `specs/007-ctc/spec.md`. "repos" = `createRepositories(db)` from `packages/shared/src/repositories/index.ts` (T1.3). "web" =
`apps/web/src/library`, "schemas" = `packages/shared/src/schemas/library`. A tag at the end of a block of indented lines covers the whole block above it.

D0  Purpose and callers. Gives agents and the dashboard version-pinned reads of the skill library and the few writes the spec allows on it
    (move labels, pin or block per project, restore files, rescan), and deletes unreferenced blobs weekly. Callers:
    (a) the ctc-web bootstrap (not built yet; T4.1 builds its spool routes the same way) mounts every `Route` of `libraryRoutes(deps)` with
        `app.route({ method, url, handler })` and registers every `McpTool` of `libraryTools(deps)` on the MCP server, passing the caller's `ctx`;
    (b) Claude Code agents call `get_capability` then `load_capability_resource` (spec:422-425 user story 3, spec:381);
    (c) the dashboard Library page calls the routes (spec:431; `/api` is internal to the dashboard, spec:166);
    (d) T5.1 (prompt line) and T3.3 (skill channel) call `servedVersion` to honour project pins (spec:390, spec:380 user story 2);
    (e) the worker main binds `blobCleanupHandlers` into `startWorkers({ handlers })` and calls `startBlobCleanup` once (spec:427, spec:193).
    Results are plain JSON; the truth stays in Postgres through repos only. FROM-SPEC (spec:111, spec:408-431, spec:782) FROM-CALLERS
    (apps/worker/src/jobs/index.ts:23-27 handlers keyed `'<queue>.<kind>'`; agent/t4-1-spool/DECISIONS.md D9 route-object shape;
    packages/shared/src/repositories/library.ts:31-243).

D1  Trust. Untrusted: route `params`, `query`, `body`; MCP `args`; every `root_path` and manifest `path` read from the database (rows may come
    from `ctc migrate --from-python`, packages/shared/src/repositories/admin/from-python.ts:281,299, which copies Python paths as they were);
    blob contents (written back byte-for-byte, never executed or parsed except D13 frontmatter split). Trusted: `ctx` from `deps.ctxOf(req)` (routes)
    or from the MCP wiring (tools), and `deps.config`. Rules:
    (a) `userId` is never read from a params/query/body/args field; route bodies are strict objects (an unknown key, e.g. `userId`, is `422 invalid`);
    (b) a project route's `:pid` must be a project of `ctx.userId` (`repos.projects.get`), else `404 not_found`; the project ctx is `{ ...ctx, projectId: pid }`;
    (c) restore writes only when `deps.config.mode === 'local'` and `ctx.userId === 'local'` (the host file system belongs to the local user only);
    (d) restore writes only inside an allowed root: the real path of the capability's `rootPath` (or of its nearest existing ancestor) must be
        equal to or under the real path of `config.claude_home` or of an entry of `config.library.roots`;
    (e) restore refuses a version whose manifest has an unsafe path: absolute, empty segment, a segment `.` or `..`, a segment starting with `.`,
        or a NUL character (the scanner never stores dot-entries, agent/t3-1-scanner/DECISIONS.md D1e, so such a path is foreign);
    (f) restore never follows a symlink out of the root: the real path of every target's parent directory must stay under the real path of
        `rootPath`; a target that is itself a symlink is replaced by the renamed regular file (rename does not follow it).
    Prevents: cross-user reads and writes, host-file writes for remote users, path traversal through database rows, planting dot-files
    (`.git/hooks`, `.env`). FROM-SPEC (spec:140 "`userId` comes from the verified key, never from a body"; spec:154 "another user's id" is 404);
    (c)-(f) and the strict bodies: YOUR-CHOICE.

D2  Limits. One exported object `libraryApiLimits` in schemas; the schemas are built from it at module load (tests check each bound at its
    default: equal is valid, one more is `invalid`):
    `listDefault = 50`, `listMax = 500` (query `limit`, inclusive; 501 → 422);
    `labelsMax = 20` labels per PATCH body (inclusive; 21 → 422); `qMax = 200` chars of `q`; `cursorMax = 512` chars of `cursor`;
    `nameMax = 200` chars of the MCP `name` (it may carry a `namespace:` prefix); `pathMax = 1024` chars of an MCP `path`;
    `candidatesMax = 10` candidates in an `ambiguous` error.
    Other numbers: `ovr:` TTL = `ttl.ovr` (300 s, packages/shared/src/cache/limits.ts:21); blob-cleanup lock wait `5 s` (D20); blob-cleanup
    submit interval `everyMs = 21_600_000` (6 h, D20). FROM-SPEC (spec:146 "limit ≤ 500"; spec:158 "up to 10 candidates"; spec:177 ovr 5 min)
    FROM-CALLERS (packages/shared/src/repositories/limits.ts clamps page size at 500). `listDefault`, `labelsMax`, `qMax`, `cursorMax`, `nameMax`,
    `pathMax`, 5 s, 6 h: YOUR-CHOICE (chosen by judgment).

D3  Output and error format.
    Route reply: `reply.code(status).send(body)`; every body is JSON-safe (a `Date` becomes its ISO string; no `undefined` value anywhere; `userId` never in a body).
    `CapabilityJson = { id, namespace, kind, name, rootPath, servedVersion: number | null, removedAt: string | null, enrichment }`
    `VersionJson = { id, capId, version, bodyHash, description, frontmatter, labels: string[], commitMessage: string | null, createdAt: string }`
    Error body `{ error: { code, message, ...extra } }` with HTTP status by code: `invalid` 422 (extra `path: (string | number)[]`, first element
    `'params' | 'query' | 'body'`, then the Zod issue path; `message` = the first Zod issue message), `not_found` 404, `conflict` 409,
    `ambiguous` 409 (extra `candidates`), `store_timeout` 504, `internal` 500 (`message` = the error's class name only, e.g. `TypeError`).
    Mapping: a `RepoError` (packages/shared/src/repositories/errors.ts) maps by its `code` (`invalid`, `not_found`, `conflict`, `store_timeout`);
    anything else is `internal`. A handler never throws and never rejects: every failure becomes a reply.
    MCP result `McpResult = { content: [{ type: 'text', text: string }], isError?: true }`; success text per D13/D14; an error is `isError: true`
    with `text = JSON.stringify({ error: { code, message, ...extra } })`, same codes as above. FROM-SPEC (spec:147-162 codes and error body;
    spec:111 MCP "text or JSON"; spec:423-424 tool replies) FROM-CALLERS (packages/shared/src/repositories/errors.ts:127-154). JSON shapes,
    `path` prefix, never-throw handlers: YOUR-CHOICE.

D4  Bad input. Validation runs before any repos call, in the order params → query → body; the FIRST failing part is reported (its first Zod issue).
    `:id` / `:pid` / `version_id` that is not a uuid or not the caller's → `404 not_found` (never 422: repos return `null` for non-uuids,
    packages/shared/src/repositories/ctx.ts:123-124). `:v`, `against` and `RestoreBody.version` must be digit strings / integers `1..999999999`
    (`parseVersionNumber`), else 422. A bad `cursor` → 422 (repos throw `RepoError('invalid')`). MCP: args that fail the schema → `invalid`;
    `label` and `version` both given → `invalid` (message `give label or version, not both`). FROM-SPEC (spec:152, spec:154);
    order, first-only, and the both-given rule: YOUR-CHOICE.

D5  Odd but harmless input stays valid: no query at all (defaults); `q` empty (no filter); a route body on a GET or on `POST /api/index`
    (ignored); MCP args with extra keys (stripped, not rejected: a model may add keys to a frozen tool, spec:166); MCP `version` as a digit string
    (`"3"`); `name` with surrounding whitespace (trimmed); the label `latest` on reads and pins (only moving it is refused); a removed capability's
    `version_id` in `load_capability_resource` (versions are immutable, the read still works); `GET /api/capabilities/:id` for a removed capability
    (returned, `removedAt` set); a label PATCH whose labels already sit on that version (200, no change); restore of the version that is already
    latest (files written, `created: false`); an override PUT equal to the existing one (200). judgment: tolerant by default (D8). YOUR-CHOICE.

D6  Must never:
    (a) write outside an allowed root (D1d-f), or write anything for a non-local user or in shared mode (D1c);
    (b) delete, truncate or chmod-down a file: restore only creates or replaces the version's own files; files on disk that are not in the version
        (newer files, binaries, dot-files, `node_modules`) are left as they are; temp files it made are removed on every failure path;
    (c) hard-delete a capability, version, label row or blob other than through D20;
    (d) mix versions inside a pinned read: `load_capability_resource` reads only the given `version_id`'s manifest (never the served or latest one);
    (e) return or log another user's rows, blob contents, file contents, frontmatter values, the database URL, or an error message other than the class name for `internal`;
    (f) edit its argument objects (requests and args may be deep-frozen);
    (g) throw out of a route handler or an MCP `call` (D3);
    (h) move or remove `latest`, or move `production` as a side effect (restore and pins move no label; only `createVersion` moves `latest`).
    FROM-SPEC (spec:377 "Edits are never lost"; spec:425 "never mixes versions"; spec:389 `latest` system-managed; spec:450 "no partial write")
    for (b) partly, (d), (h); the rest YOUR-CHOICE.

D7  Non-goals (which code does that instead): the Fastify app, its bootstrap, auth, rate limit, `Idempotency-Key` (F4 routes only, spec:165) and
    the MCP SDK server/transport (the web bootstrap task; this task exports plain objects and adds no dependency); `POST /api/capabilities/:id/enrich`
    and `GET|PATCH /api/dedup*` (spec:431 lists them, but `llm.enrich` has no consumer yet, so a submitted job ends `dead`, agent/t3-1-scanner/
    DECISIONS.md D7; dedup review belongs with the dashboard rework, spec:819); a route that removes a label without moving it; a route for global
    (project-less) overrides; a route that returns one file's content by version (the diff returns paths); restore deleting files not in the
    version; recomputing `served_version`, embedding and publishing after a label move (the T3.1 `library.changed` handler does it, this task
    submits the job); the capability graph node (T2.3); the skill channel and RAM matrix (T3.3, T5.1); scheduling with BullMQ repeatable jobs
    (they bypass the `jobs` row); the dashboard pages (no frontend spec, O12). FROM-SPEC (spec:408-431, spec:782 task split) FROM-OWNER (O12
    dashboard). The exact split (enrich, dedup, label removal, global pins, file route): YOUR-CHOICE.

D8  Silence rule. Where this list says nothing, choose the more tolerant, less destructive behaviour (refuse a write over guessing; keep a file
    over deleting it; return `not_found` over leaking existence) and add a comment starting `judgment:`. FROM-OWNER (O11).

D9  Layout and public names (TypeScript strict, ESM, source run by Node type stripping, O11; no `enum`, no parameter properties):
    schemas `packages/shared/src/schemas/library/index.ts` (`@ctc/shared/schemas/library`; imports only `zod`): `libraryApiLimits` (D2);
    `parseVersionNumber(v: unknown): number | null` (an integer or a digit string, `1..999999999`, else `null`); `LABEL_RE` is repeated here as the same literal as core's (spec:389; `@ctc/shared` cannot import `@ctc/core`, which depends on it); Zod schemas `CapabilityListQuery`
    `{kind?, label?, q?, limit?, cursor?}`, `VersionParams` `{id, v}`, `DiffQuery` `{against}`, `LabelsBody` `{labels}`, `RestoreBody` `{version}`,
    `OverrideParams` `{pid, id}`, `OverrideBody` (`{action:'pin', label}` | `{action:'pin', version}` | `{action:'block'}`), `GetCapabilityArgs`
    `{name, label?, version?}`, `LoadResourceArgs` `{version_id, path}`; their inferred types are exported too (apps/web has no `zod` dependency).
    web `apps/web/src/library/index.ts`: `libraryRoutes`, `libraryTools`, `servedVersion`, types `LibraryApiDeps`, `Route`, `McpTool`, `McpResult`.
    `Route = { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: string; handler(req: { params?: unknown; query?: unknown; body?: unknown },
      reply: { code(n: number): { send(body?: unknown): unknown } }): Promise<unknown> }` (Fastify-compatible).
    `McpTool = { name: string; description: string; inputSchema: <the Zod object>; call(ctx: Ctx, args: unknown): Promise<McpResult> }`.
    `libraryRoutes` returns exactly these 10 routes (Fastify `:param` syntax):
      `GET /api/capabilities`, `GET /api/capabilities/:id`, `GET /api/capabilities/:id/versions`, `GET /api/capabilities/:id/versions/:v`,
      `GET /api/capabilities/:id/versions/:v/diff`, `PATCH /api/capabilities/:id/versions/:v/labels`, `POST /api/capabilities/:id/restore`,
      `PUT /api/projects/:pid/capabilities/:id/override`, `DELETE /api/projects/:pid/capabilities/:id/override`, `POST /api/index`.
    `libraryTools` returns exactly `get_capability` and `load_capability_resource` (names frozen, spec:166).
    worker `apps/worker/src/library/blobs.ts`, re-exported from `apps/worker/src/library/index.ts`: `blobCleanupHandlers`, `blobCleanupJobId`,
    `startBlobCleanup` (D20). More files may sit in web and schemas. No `node:fs` in schemas or in packages/core (core stays pure, spec:99).
    FROM-SPEC (spec:93 Zod schemas in packages/shared; spec:88 apps/web owns `/api` and `/mcp`; spec:99) FROM-CALLERS (packages/shared/package.json
    exports `./*` → `./src/*/index.ts`; apps/web/package.json has no zod; agent/t4-1-spool/DECISIONS.md D9 same choice for spool). Folder names,
    plain objects instead of Fastify/SDK, the `Route`/`McpTool` shapes: YOUR-CHOICE.

D10 Dependencies and context. `LibraryApiDeps = { repos: Repositories; config: { mode: 'local' | 'shared' | string; claude_home: string;
    library: { roots: string[]; default_label: string } }; submit(input: { queue: string; kind: string; payload: unknown; id?: string }):
    Promise<{ id: string }>; cache?: { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown, ttlSeconds: number):
    Promise<void>; del(...keys: string[]): Promise<void>; publishInval(msg: unknown): Promise<void> }; ctxOf?(req: unknown): Ctx;
    log?(message: string, fields?: Record<string, unknown>): void }`. `ctxOf` defaults to `() => ({ userId: 'local' })` (local mode, spec:138).
    `deps.config` is read at call time. `submit` has the input shape of `submitJob` (packages/shared/src/queues/submit.ts:85); the bootstrap binds
    it to `submitJob({ queues, create })`. `cache` is the T1.4 `Cache` (packages/shared/src/cache/index.ts:18-36); without it nothing is cached
    and nothing is published. A cache call never fails a request (the T1.4 cache is fail-open; a `TypeError` from `keys.ovr` means "do not cache").
    FROM-SPEC (spec:138 local `userId = local`; spec:170 cache-aside) FROM-CALLERS (packages/shared/src/queues/submit.ts:79-86;
    packages/shared/src/cache/keys.ts:24; packages/shared/src/env/schema.ts:109,114,138). The deps shape and the `ctxOf` default: YOUR-CHOICE.

D11 Name lookup (MCP `get_capability`). New repo function `repos.library.listByName(ctx, name): Promise<Capability[]>`: live capabilities
    (`removed_at is null`) of `ctx.userId` with exactly that `name`, ordered by namespace (collate "C") then kind; `tenancy.cases.ts` gets the case
    `listByName: { expect: 'zero', … }` (user B gets `[]` for A's name). Resolution of `args.name` (trimmed):
    (1) `ns:bare` when it contains `:` (split at the first `:`; Claude Code names plugin skills `plugin:skill`), else bare with no namespace;
    (2) `bare` that fails `isName` (core) → `not_found` (never `invalid`); candidates = `listByName(bare)`, filtered to `ns` when given;
    (3) none → `not_found`; namespace `user` among them → keep only `user`; else exactly one namespace → keep it; else → `ambiguous` with
        `candidates` = up to `candidatesMax` `{ name: '<namespace>:<name>', kind }`, sorted by name then kind;
    (4) within the kept namespace, kind order `skill`, `agent`, `command`, `workflow`: the first kind present wins.
    FROM-SPEC (spec:423 `{name, …}`; spec:158 `ambiguous` with up to 10 `candidates`; spec:387 one name per user and namespace) FROM-CALLERS
    (packages/shared/src/repositories/library.ts:47-52 `byName` needs namespace and kind; agent/t3-1-scanner/DECISIONS.md D10 namespaces;
    agent/t1-3-repos/DECISIONS.md D14 later tasks add functions with a tenancy case). Qualified names, `user` first, kind order: YOUR-CHOICE.

D12 Served version for a project. `servedVersion(deps, ctx, capId): Promise<number | null>` = `resolveServed(listVersions(ctx, capId),
    { override, defaultLabel: config.library.default_label })` (core, agent/t3-1-scanner/DECISIONS.md D16) where `override` = the override row of
    `capId` for `ctx.projectId` when one exists, else the global row (`projectId: null`) for `capId`, else `null`. It never uses the
    `capabilities.served_version` column (override-free, T3.1 D16). Override rows are read cache-aside: with `deps.cache` and `ctx.projectId`,
    key `keys.ovr(ctx.userId, ctx.projectId)` holds the JSON array of `repos.library.listOverrides(ctx)` rows for `ttl.ovr` seconds (a hit is
    used as is; a miss reads Postgres and sets the key); without a cache or a project, Postgres is read every call. A foreign or unknown
    `capId` → `null`. FROM-SPEC (spec:390 "project override (version, or label) → production → latest"; spec:177 `ovr:{user}:{project}` 5 min;
    spec:438) FROM-CALLERS (packages/core/src/library/index.ts:182-203; packages/shared/src/repositories/library.ts:237-243 globals plus the
    project's). Project row over global row, cache value = the row array: YOUR-CHOICE.

D13 `get_capability {name, label?, version?}` (`GetCapabilityArgs`: `name` string 1..`nameMax`; `label` matching `LABEL_RE`; `version` per D4/D5).
    Pick the capability (D11), then the version: `version` given → that version, else `not_found`; `label` given → the version carrying it
    (`latest` allowed), else `not_found`; neither → `servedVersion(deps, ctx, capId)`; `null` (a `block` override, or no versions) → `not_found`
    with message `not served for this project`. An explicit `label`/`version` reads past a `block` (a deliberate read).
    Success text = `JSON.stringify({ version_id, version, labels, frontmatter, body, files })` with exactly these keys: `version_id` = the version
    row id; `labels` and `frontmatter` from the row; `files` = the manifest as `[{ path, size }]` sorted by path (code-unit order); `body` =
    `bodyOf(kind, mainPath, content)` of the main file (`mainPathOf(manifest paths)`, D21), or `''` when there is no main file or its blob is
    missing. FROM-SPEC (spec:423 reply shape; spec:390; spec:416 body definition) FROM-CALLERS (apps/worker/src/library/handlers.ts:34-38,
    70-73 main file and body). Block bypass on explicit reads, `''` body fallback, the `not served` message: YOUR-CHOICE.

D14 `load_capability_resource {version_id, path}` (`LoadResourceArgs`: `version_id` string 1..64; `path` string 1..`pathMax`). Success text = the
    file's content exactly as stored (`repos.library.getBlob(ctx, version_id, path)`; the main file includes its frontmatter); `null` (unknown,
    foreign or non-uuid version, or a path not in that version's manifest) → `not_found`. It reads that version only, so a version that lands
    between `get_capability` and this call changes nothing (versions and their `cap_files` are immutable; D20 never deletes a referenced blob).
    FROM-SPEC (spec:424-425) FROM-CALLERS (packages/shared/src/repositories/library.ts:155-166). YOUR-CHOICE: raw text, no JSON wrapper.

D15 Read routes (all `200` on success):
    `GET /api/capabilities` (`CapabilityListQuery`: `kind` ∈ skill/agent/command/workflow, `label` `LABEL_RE`, `q` ≤ `qMax`, `limit` an integer or digit string
      1..`listMax` (query values arrive as strings), default `listDefault`, `cursor` ≤ `cursorMax`) → `{ items: CapabilityJson[], next: string | null }` from `repos.library.listCapabilities`
      (live only, keyset newest first);
    `GET /api/capabilities/:id` → `CapabilityJson` (removed ones included), unknown → 404;
    `GET /api/capabilities/:id/versions` → `{ items: VersionJson[] }` newest first (all versions, no paging), unknown capability → 404;
    `GET /api/capabilities/:id/versions/:v` → `VersionJson & { files: { path, size: number | null, blobHash }[], body: string }` (manifest + body,
      body as in D13), unknown → 404;
    `GET /api/capabilities/:id/versions/:v/diff?against=:w` → `{ from: w, to: v, added, removed, changed }` = `diffManifests(manifest(w),
      manifest(v))` (core); either version unknown → 404; `against` missing → 422.
    FROM-SPEC (spec:431 route list; spec:146 limit and keyset) FROM-CALLERS (packages/shared/src/repositories/library.ts:31-42, 122-154;
    packages/core/src/library/index.ts:166). Body shapes, unpaged versions: YOUR-CHOICE.

D16 Label move: `PATCH /api/capabilities/:id/versions/:v/labels` (`LabelsBody` strict: `labels` array of 1..`labelsMax` strings matching
    `LABEL_RE`) → `repos.library.moveLabels(ctx, { capId, version, labels })` (one transaction, target `FOR UPDATE NOWAIT`, labels removed
    from the other versions). Results: `200 VersionJson` (the target after the move); `null` → 404; `latest` in the body → 422 `invalid`
    (the repo's `RepoError('invalid')`); a held lock → 409 `conflict` (the repo's `ConflictError`). After a 200, `submit({ queue: 'library',
    kind: 'changed', payload: { userId: ctx.userId, capId, version } })` (no fixed id: every move recomputes); a `submit` throw is logged and
    the reply stays 200 (the move is committed). Labels not in the body are never removed from the target. FROM-SPEC (spec:420; spec:448
    loser gets 409) FROM-CALLERS (packages/shared/src/repositories/library.ts:167-199; apps/worker/src/library/handlers.ts:54-87 the
    `library.changed` handler recomputes the served version and publishes `ctc:inval`). Move-only semantics, log-and-200: YOUR-CHOICE.

D17 Project override. `PUT /api/projects/:pid/capabilities/:id/override` (`OverrideParams`; `OverrideBody` strict: `{ action: 'pin', label }`,
    `{ action: 'pin', version }` or `{ action: 'block' }`; pin with both or neither, block with either → 422): `:pid` checked per D1b; then
    `repos.library.upsertOverride({ ...ctx, projectId: pid }, { capId, action, label?, version? })` (the version or label must exist now,
    else the repo's `not_found` → 404) → `200 { projectId, capId, action, label: string | null, version: number | null }`.
    `DELETE /api/projects/:pid/capabilities/:id/override` → `clearOverride` → `204` with no body (also when there was none; unknown project → 404).
    "Rotate `ovr:`" after either succeeds: `cache.del(keys.ovr(ctx.userId, pid))`, then `cache.publishInval({ v: 1, event: 'ovr.changed',
    userId: ctx.userId, projectId: pid })` (other web processes clear their L1, packages/shared/src/cache/inval.ts:64-68). A label pin
    follows the label when it moves; a pin whose label or version later disappears falls through (T3.1 D16). FROM-SPEC (spec:421 "the version
    must exist; rotates `ovr:`") FROM-CALLERS (packages/shared/src/repositories/library.ts:213-236; packages/shared/src/cache/inval.ts:12
    `ovr.changed`). The DELETE route, strict body variants, rotate = del + publish: YOUR-CHOICE.

D18 Restore: `POST /api/capabilities/:id/restore` (`RestoreBody` strict `{ version }`). Steps, all before any write unless stated:
    (1) D1c check, else `409 conflict` (`restore needs local mode`); capability (removed ones included) and version must exist, else 404;
        a version whose `commitMessage` is `imported from python` → `409 conflict` (its blob is the Python body without frontmatter,
        packages/shared/src/repositories/admin/from-python.ts:293-299; writing it would strip the skill's header);
    (2) D1d and D1e checks, else `409 conflict`; one restore per capability at a time in this process (an in-memory set), a second → `409 conflict`;
    (3) read every manifest file's content (`getBlob`); any `null` → `500 internal`, nothing written;
    (4) create missing directories (`mkdir -p`, under the root only), D1f check per target; then write each file to a temp file in the target's own
        directory named `.<basename>.ctc-restore-<random hex>` (a dot-name: the scanner never reads it), mode = the existing target's mode
        when it exists, else default; a D1f violation → remove every temp file made so far → `409 conflict`; any other failure → remove
        every temp file made so far → `500 internal`; in both cases no target is touched (directories made in this step may stay);
    (5) rename every temp file onto its target (per-file atomic, spec:450); a rename failure → remove the remaining temp files → `500 internal`;
    (6) `repos.library.createVersion(ctx, { namespace, kind, name, rootPath, description, frontmatter, bodyHash } of the restored version,
        commitMessage: 'restore v<version>', blobs: [], files: its manifest `{path, blobHash}` })` (the blobs are already stored: they are
        referenced by that version); when `created`, `submit` `library.changed` for the new version (a throw is logged);
    (7) reply `200 { version: <the new or existing latest version number>, created: boolean, written: string[] }` (`written` = manifest paths, sorted).
    Labels other than `latest` do not move (`production` stays where it was). A scan that runs between (5) and (6) may version the files first
    with commit message `scan`; (6) then reports `created: false`. FROM-SPEC (spec:426 temp file + rename per file, commit message
    `restore v<version>`; spec:450 unwritable → 500, no partial write; spec:383 user story 4) FROM-CALLERS (packages/shared/src/repositories/
    library.ts:57-121 createVersion re-checks the manifest under the lock; agent/t3-1-scanner/OPEN.md B row D14 "T3.2 must pass it").
    Restore creating the version itself (not the next scan), no deletes, the imported-version refusal, mode copy, one-at-a-time: YOUR-CHOICE.

D19 Rescan: `POST /api/index` (body ignored) → `submit({ queue: 'library', kind: 'scan', payload: { userId: ctx.userId } })` → `202 { job_id }`
    (the T3.1 handler drops it for non-local users, T3.1 D1a). A `submit` throw → the D3 mapping (`internal` unless a `RepoError`).
    FROM-SPEC (spec:410 trigger `POST /api/index`; spec:147 `202 {job_id}`; spec:431 `→ 202`) FROM-CALLERS (packages/shared/src/queues/payloads.ts:16).

D20 Blob cleanup.
    (a) `blobCleanupHandlers({ repos, log? })` → `{ 'cleanup.blobs': handler }`; the handler (payload `{}`) calls
        `repos.system.cleanup.deleteUnreferencedBlobs(createSystemCtx('cleanup.blobs'))` and returns `{ deleted: number }`; errors propagate
        (the job framework retries, 3 attempts, spec:193).
    (b) `deleteUnreferencedBlobs` (packages/shared/src/repositories/system.ts:72-81) keeps its signature and its delete, and runs inside one
        transaction that first does `set local lock_timeout = '5s'` and `lock table cap_blobs in share row exclusive mode`. Why: `createVersion`
        inserts blobs with `on conflict do nothing` (no row lock on an existing blob) and `cap_files.blob_hash` has no foreign key
        (packages/shared/migrations/0003_library.sql:48-61), so without the lock a delete can remove an unreferenced blob that a concurrent,
        not yet committed `createVersion` is about to reference. The table lock conflicts with the `ROW EXCLUSIVE` lock every `createVersion`
        insert holds until commit, so the delete waits for open writers and sees their `cap_files`. A lock wait over 5 s fails the attempt (retried).
    (c) `blobCleanupJobId(now: Date): string` = `cleanup.blobs:<ISO week-year>-W<ISO week, 2 digits>` computed in UTC
        (`2026-10-31T12:00:00Z` → `cleanup.blobs:2026-W44`; `2027-01-01T12:00:00Z` → `cleanup.blobs:2026-W53`).
    (d) `startBlobCleanup({ submit, everyMs = 21_600_000, now = () => new Date(), log? })` calls `submit({ queue: 'cleanup', kind: 'blobs',
        payload: {}, id: blobCleanupJobId(now()) })` at once and every `everyMs` (timer `unref`'d); the fixed weekly id makes it run at most once
        per ISO week (an existing `done` row is not claimed again, apps/worker/src/jobs/consumers.ts:65); a `submit` throw or rejection is
        logged, never thrown; `close()` stops the timer and is idempotent.
    FROM-SPEC (spec:427 "weekly `cleanup.blobs`: deletes `cap_blobs` that no `cap_files` row references"; spec:193) FROM-CALLERS
    (packages/shared/src/repositories/system.ts:72-81; packages/shared/src/queues/payloads.ts:25; packages/shared/src/queues/submit.ts:92-94
    a known id re-adds without a new row). The lock, ISO-week ids, a 6 h timer instead of a BullMQ repeatable job: YOUR-CHOICE.

D21 Shared main-file rules move to core (no behaviour change): `packages/core/src/library/index.ts` exports
    `mainPathOf(paths: readonly string[]): string | null` (`'SKILL.md'` when present, else the only path when there is exactly one, else `null`)
    and `bodyOf(kind: string, mainPath: string, content: string): string` (for a `workflow` whose main path ends in `.yaml`/`.yml`/`.json`
    (case-insensitive): the whole content; else `parseFrontmatter(content).body` when it parses, else the whole content).
    `apps/worker/src/library/handlers.ts` imports both and drops its private `bodyOf` and its inline main-path expression; every T3.1 test stays green.
    FROM-CALLERS (apps/worker/src/library/handlers.ts:34-38, 70). YOUR-CHOICE: moving them (the alternative is a second copy in apps/web).

D22 Gate tests (Vitest, real scratch Postgres, temp dirs only):
    `apps/web/src/library/library.mcp.int.test.ts`, `describe('library.mcp')`,
      `it('get_capability and load_capability_resource stay on the returned version after a new version lands')`: a two-file skill at v1
      (`SKILL.md` + `ref.md`), `get_capability` → v1's `version_id`; `createVersion` lands v2 changing both files and moves `production` to v2
      (`moveLabels`); `load_capability_resource(v1 id, 'ref.md')` and `(v1 id, 'SKILL.md')` return v1's contents byte-for-byte; a second
      `get_capability` returns v2, and one with `version: 1` returns the first `version_id` again.
    `apps/web/src/library/library.override.int.test.ts`, `describe('library.override')`, two projects P1, P2 of one user, a capability with v1
      (`production`), v2 (label `beta`), v3 (`latest`), and an in-memory fake cache (Map) as `deps.cache`:
      `it('pin by label changes the served version for that project only')`: before, `get_capability` (no args but `name`) serves v1 for P1 and P2;
        `PUT …/override {action:'pin', label:'beta'}` for P1 → P1 serves v2, P2 and the project-less ctx still v1, and the P1 read made before
        the PUT (cached under `ovr:`) does not survive it;
      `it('pin by version changes the served version for that project only')`: `{action:'pin', version: 3}` for P1 → P1 serves v3, P2 v1;
        `servedVersion` agrees with `get_capability` for each ctx; `DELETE` → P1 back to v1.
    Scratch rules: a fresh schema `ctc_t32_<random>` migrated with `migrate({ url, schema })` from `@ctc/shared/repositories/admin`, dropped in
    `afterAll`; refuse any URL that is not `127.0.0.1:18304`; never the schemas `ctc`, `ctc_eval`, `ctc_own`; temp files under `os.tmpdir()`, removed after.
    FROM-SPEC (spec:458-459, spec:759, spec:782) FROM-OWNER (O7, O8 scratch DB only). Fixture values, file names: YOUR-CHOICE.
