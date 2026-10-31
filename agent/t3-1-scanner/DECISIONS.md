# Decisions for the T3.1 library scanner and `library` queue (packages/core/src/library, apps/worker/src/library)

Tags: FROM-OWNER (O#, agent/OWNER.md), FROM-SPEC (specs/007-ctc/spec.md line), FROM-CALLERS (file:line), YOUR-CHOICE (owner reviews every one, O11).
"spec" = `specs/007-ctc/spec.md`. "repos" = `createRepositories(db)` from `packages/shared/src/repositories/index.ts` (T1.3). A tag at the end of a block of
indented lines covers the whole block above it.

D0  Purpose and callers. Turns the capability files under the library roots (skills, agents, commands, workflows) into immutable versions with labels,
    a file manifest and content-addressed blobs, and runs the `library` queue (`scan`, `changed`). Callers: apps/worker main (worker start, file watch;
    binds `libraryHandlers` into `startWorkers({handlers})`, apps/worker/src/jobs/index.ts:23-27), `POST /api/index` (T3.2, submits `library.scan`),
    T3.2 label/pin routes (submit `library.changed` to recompute the served version), T3.2 restore (writes files back; the next scan versions them),
    T3.3/T5.1 (read `cap_vectors` and use `resolveServed` for project overrides), T2.3 (capability graph nodes). They get plain JSON results; the
    truth is in Postgres through repos only. FROM-SPEC (spec:95 code map "scan, frontmatter, manifest, version diff, resolve served version";
    spec:410-419 scan and changed flows; spec:781 T3.1) FROM-CALLERS (apps/worker/src/jobs/index.ts:22-27, packages/shared/src/queues/payloads.ts:16-17,
    packages/shared/src/repositories/library.ts:53-121).

D1  Trust. Untrusted: every file under a root (content, names, YAML, symlinks, sizes), the job payload (Redis contents; re-validated by
    runAttempt, apps/worker/src/jobs/consumers.ts), `installed_plugins.json`. Trusted: `config` (validated by Zod at start) and `payload.userId` only
    after the check below. Rules:
    (a) the `library.scan` handler reads the host file system only for `payload.userId === 'local'` and `config.mode === 'local'`; anything else
        throws `JobDropped('scan_not_local')` before any file is read (in shared mode user B must never get the host's `~/.claude` copied into B's
        library). `scanLibrary()` itself has no such check: its caller chooses `ctx` and `roots`;
    (b) `payload.roots` is ignored: the roots are always `discoverRoots(config)` (a payload can never point the scanner at `/etc`);
    (c) YAML is parsed with `maxAliasCount: 0` (no alias expansion), duplicate keys are an error;
    (d) a symlinked FILE inside a capability directory is read only when its real path is inside the capability directory's real path; otherwise
        it is left out with warning `symlink_outside`; symlinked DIRECTORIES inside a capability are not followed (no warning). The capability
        entry itself (`skills/<x>` dir or `agents/<x>.md` file) may be a symlink and is followed;
    (e) dot-entries (any path segment starting with `.`, e.g. `.env`, `.git`) and the directories `node_modules` and `__pycache__` are never read
        or stored (secrets such as `.env` must not reach Postgres or an MCP reply).
    Prevents: host-file leak across users, path traversal through payloads or symlinks, YAML bombs, secrets in blobs.
    FROM-SPEC (spec:140 userId from the key; spec:404 YAML `maxAliasCount: 0`); (a), (b), (d), (e): YOUR-CHOICE.

D2  Limits. One exported object `libraryLimits` in packages/core/src/library, read at call time (a test may assign to it):
    `maxFiles = 200` files per capability version, inclusive (200 valid, 201 → skip `too_many_files`);
    `maxBytes = 1048576` total bytes of those files, inclusive (sum of sizes; 1048576 valid, 1048577 → skip `too_large`);
    `maxNameLen = 64` (UTF-16 length, like Zod `.max`; 64 valid, 65 → `bad_name`);
    `maxDescription = 1024` (UTF-16 length; 1024 valid, 1025 → `description_too_long`);
    `bodyChars = 8000` (SKILLRET text body cut, D17).
    Counted over every non-ignored regular file of the capability (D1e), binary files included; counted from `stat` sizes BEFORE any content is read.
    The worker passes `config.library.max_files`/`max_bytes` and `config.embed.skillret_body_chars` as overrides (`{...libraryLimits, ...}`); the
    pure functions default to `libraryLimits`. FROM-SPEC (spec:404 "≤ 200 files and ≤ 1 MB per version; name … ≤ 64 chars; description ≤ 1,024";
    spec:416 body 8,000; spec:440 config keys) FROM-CALLERS (packages/shared/src/env/schema.ts:93,138-144). Inclusive bounds, stat-before-read: YOUR-CHOICE.

D3  Output and error format (all results are JSON-safe: no `Date`, no `Map`, no `undefined` values in arrays).
    `Skip = { path: string; code: SkipCode; message: string }`; `path` is the absolute path of the capability's main file (skills: the `SKILL.md`)
    or, for a warning, of the file concerned. Capability-level codes (the capability is not versioned): `unreadable`, `too_many_files`, `too_large`,
    `bad_yaml`, `bad_name`, `description_too_long`, `duplicate_name`. File-level warning codes (the capability is versioned without that file):
    `binary_file`, `symlink_outside`. `message` is free text, never file content.
    `ScanResult = { roots: {path, namespace, walked: boolean}[]; created: {capId, namespace, kind, name, version}[]; unchanged: number;
      removed: {capId, namespace, kind, name}[]; skipped: Skip[]; warnings: Skip[] }`.
    `library.scan` handler returns the ScanResult (it becomes `jobs.result`). `library.changed` handler returns
    `{ capId, servedVersion: number | null, embedded: boolean, dedup: number }`, or `{ capId, skipped: 'not_found' | 'removed' }`.
    Errors: Postgres errors from repos (`RepoError`, `StoreTimeoutError`, pg errors) and embedder errors propagate unchanged (the job framework
    retries them, spec:189); `JobDropped('scan_not_local')` per D1a. FROM-SPEC (spec:449 "that capability is skipped with `jobs.error`; the previous
    version stays served") FROM-CALLERS (packages/shared/src/queues/submit.ts:44-52 JobDropped). Shapes, codes, and "skipped list in `jobs.result`
    while the job is `done`" instead of a failed job: YOUR-CHOICE.

D4  Bad input. One bad capability never stops the scan: it is reported in `skipped`, the others are versioned, nothing of the bad one is written
    (its previous version stays latest/served). Checks run in this order and the FIRST failing one is the only reported code:
    `unreadable` (stat/read/realpath error, vanished mid-scan) → `too_many_files` → `too_large` → `bad_yaml` → `bad_name` → `description_too_long`
    → `duplicate_name`. `bad_yaml` = header opened by a first line `---` and never closed by a line `---`, YAML syntax error, an alias, a duplicate
    key, or a header that is not a mapping (a list or a scalar); for `.yaml`/`.yml`/`.json` workflow files the whole file must be a mapping.
    FROM-SPEC (spec:449) for skip-and-continue; order and the exact `bad_yaml` cases: YOUR-CHOICE.

D5  Odd but harmless input stays valid: no frontmatter at all (frontmatter `{}`, body = whole text, description `''`); an empty header
    (`---` then `---`) = `{}`; CRLF line endings; a UTF-8 BOM before `---`; a missing or non-string `description` (stored `''`); a non-string or
    empty `name` (the default name is used); an empty roots list (empty result); a root that does not exist or is not a directory
    (`walked: false`, no throw, nothing removed for it); `installed_plugins.json` missing, unreadable or malformed (no plugin roots); a skill
    directory with only `SKILL.md`; the same tree scanned twice (second run: `created: []`). judgment: tolerant by default (D8). YOUR-CHOICE.

D6  Must never:
    (a) write, rename or delete any file under a root (restore is T3.2);
    (b) hard-delete a capability or version: a capability whose files disappeared is soft-removed with `repos.library.markRemoved` (versions kept);
    (c) remove a capability of a namespace that was not fully walked in this scan (D14 removal rule), or one that was found but skipped;
    (d) hang: no symlinked directory is followed inside a capability (no loop), at most `maxFiles + 1` entries are collected per capability before
        `too_many_files` stops the walk, no file over the byte budget is read;
    (e) edit its argument objects (inputs may be deep-frozen);
    (f) log or put in a result: file contents, frontmatter values, embeddings, the database URL;
    (g) create a second version for an unchanged manifest, or two versions for one change under parallel scans (D15);
    (h) touch a capability of another user (every repos call gets the job's `ctx`; D19 adds one ctx-scoped repo function).
    FROM-SPEC (spec:377 "Edits are never lost"; spec:414 "versions kept"; spec:457 gate) for (b), (g); the rest YOUR-CHOICE.

D7  Non-goals (which code does that instead): HTTP routes, MCP `get_capability`/`load_capability_resource`, restore and its `restore v<n>` commit
    message, override routes, blob cleanup (T3.2); the query-side SKILLRET dense + rerank channel and the RAM skill matrix (T3.3, T5.1); `llm.enrich`
    (not submitted by T3.1; its consumer does not exist yet, so a submitted job would end `dead`); graph nodes for capabilities (T2.3); the worker
    main/daemon that calls `startWorkers` (later task; T3.1 only exports handlers and the watcher); a TEI client (the embedder is injected, D17);
    project-level `.claude` roots and plugin-manifest (`.claude-plugin/plugin.json`) declared paths; nested `commands/<dir>/<x>.md`; storing binary
    files; SQL outside `packages/shared/src/repositories` (ESLint ban, spec:99). FROM-SPEC (spec:410-427, spec:781-783 task split); the exact
    split (enrich, graph node, roots kinds): YOUR-CHOICE.

D8  Silence rule. Where this list says nothing, choose the more tolerant, less destructive behaviour (skip one capability over failing the job;
    keep a capability live over removing it; soft-remove over delete) and add a comment starting `judgment:`. FROM-OWNER (O11).

D9  Layout and public names (TypeScript strict, ESM, source run by Node type stripping, O11):
    packages/core/src/library/index.ts (pure: no `node:fs`, `node:net`, `node:child_process`, `pg`, `kysely`, `ioredis`, `bullmq` imports; `node:crypto`
    is allowed): `libraryLimits`, `NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/`, `LABEL_RE = /^[a-z0-9_\-.]{1,36}$/`, `isName(s)`, `isLabel(s)`,
    `sha256Hex(data: string | Uint8Array): string`, `parseFrontmatter(text)`, `buildVersion(input, limits?)`, `sameManifest(a, b)`, `diffManifests(a, b)`,
    `resolveServed(versions, opts?)`, `skillretText(cap, bodyChars?)`, `cosine(a, b)`, types `Kind`, `Skip`, `SkipCode`, `FileInput`, `BuildInput`, `BuildResult`.
    apps/worker/src/library/index.ts (I/O): `discoverRoots`, `scanLibrary`, `libraryHandlers`, `watchLibrary`, types `Root`, `ScanResult`,
    `LibraryDeps`, `Embed`. More files may sit in those two directories. `packages/core/package.json` gains the dependency `yaml` 2.9.1 (the version
    `@ctc/shared` already pins). FROM-SPEC (spec:95, spec:99 "`packages/core` is pure (no I/O)") FROM-CALLERS (packages/core/package.json:7 exports
    `./*` → `@ctc/core/library`; packages/shared/package.json yaml 2.9.1). File split I/O in apps/worker, names: YOUR-CHOICE.

D10 Roots and namespaces. `discoverRoots({ claudeHome, roots }): Promise<Root[]>`, `Root = { path, namespace }`, every path `path.resolve`d:
    (1) each configured root in order: namespace `user` when its real path equals the real path of `claudeHome` (or both resolve to the same
        string when either does not exist), else `root@` + the first 8 hex of `sha256Hex(path.resolve(root))`;
    (2) then plugin roots from `<claudeHome>/plugins/installed_plugins.json`, shape `{ plugins: { "<name>@<marketplace>": entry | entry[] } }`,
        `entry.installPath` a non-empty string; namespace = the key before the first `@`; sorted by key, then by installPath; entries without
        `installPath` are ignored;
    (3) duplicates by real path (or resolved path when missing) are dropped, first wins.
    Roots that do not exist are still returned (the scan reports `walked: false`). FROM-SPEC (spec:437 `library.roots` default "~/.claude, plugin
    roots from ~/.claude/plugins") FROM-CALLERS (packages/shared/src/env/index.ts:206-208 expands `~`; file shape of Claude Code's
    installed_plugins.json as read by src/ctc/ingestion/scanner.py:242-252). Namespace strings: YOUR-CHOICE.

D11 Capability layout per kind, under one root (only these; sorted by path within a kind; kinds visited in this order):
    `skill`:    every directory entry `skills/<dir>` (dir or symlink to a dir) that contains a regular file `SKILL.md`; the capability's files are
                every non-ignored regular file under it, recursively; rootPath = `<root>/skills/<dir>` as found (not resolved); default name `<dir>`;
                main file `SKILL.md`;
    `agent`:    `agents/<x>.md` (top level only); one file; rootPath = `<root>/agents`; manifest path `<x>.md`; default name `<x>`;
    `command`:  `commands/<x>.md` likewise (rootPath `<root>/commands`);
    `workflow`: `ctc-workflows/<x>.{yaml,yml,json}` first, then `workflows/<x>.{yaml,yml,json,md}`; one file; rootPath = its directory;
                default name `<x>`; yaml/yml/json files are one YAML mapping (no frontmatter), `.md` files have frontmatter.
    Manifest paths are relative to rootPath, POSIX `/`, no leading `./`. Name = frontmatter (or workflow mapping) `name` when it is a non-empty
    string (trimmed), else the default name. Identity = `(namespace, kind, name)` (the unique key of `capabilities`). A second capability with an
    identity already seen in this scan is skipped `duplicate_name` (first by root order, then kind/glob order, then path).
    FROM-SPEC (spec:387 kinds; spec:411 "hash every file"; spec:591 workflow file "YAML or JSON"; spec:113 file reads) FROM-CALLERS (layout of
    the user's files: src/ctc/ingestion/scanner.py:18-25). Globs, rootPath and name rules: YOUR-CHOICE.

D12 Frontmatter. `parseFrontmatter(text): { ok: true; frontmatter: Record<string, unknown>; body: string } | { ok: false; code: 'bad_yaml'; message: string }`.
    A leading U+FEFF is ignored for detection. The header exists when the first line is exactly `---` (optional trailing spaces, `\n` or `\r\n`);
    it ends at the next line that is exactly `---`; `body` = everything after that closing line's line break (or `''`). No header → `{}` and the
    whole text (BOM removed) as body. YAML via the `yaml` package `parse(header, { maxAliasCount: 0, uniqueKeys: true })`; `null` (empty header) → `{}`;
    any thrown error or a non-mapping → `bad_yaml`. Description = the mapping's `description` when it is a string (trimmed), else `''`.
    FROM-SPEC (spec:404 `maxAliasCount: 0`; spec:449 bad YAML is skipped). Detection details: YOUR-CHOICE.

D13 Hashing, blobs, manifest. `buildVersion(input: BuildInput, limits = libraryLimits): BuildResult`.
    `BuildInput = { kind, namespace, defaultName, rootPath, mainPath, files: { path: string; bytes: Uint8Array }[] }` (files include the main file).
    `BuildResult = { ok: true; input: CreateVersionInput; warnings: Skip[] } | { ok: false; skip: Skip }` where `CreateVersionInput` is the type of
    packages/shared/src/repositories/library.ts:17-20; a skip has `path = rootPath + '/' + mainPath`, a warning `path = rootPath + '/' + <file path>`.
    blob `hash` = `sha256Hex(bytes)`; `size` = `bytes.length`; `content` = UTF-8 decode with BOM kept, so `sha256Hex(Buffer.from(content, 'utf8')) === hash`;
    a file that is not valid UTF-8 or contains U+0000 is left out (warning `binary_file`); blobs are unique by hash; `files = [{ path, blobHash }]`;
    `bodyHash = sha256Hex(body)` (body per D12; for yaml/json workflows the whole decoded text); `frontmatter` = the parsed mapping; `description`
    per D12. A main file that is binary → skip `unreadable`.
    `sameManifest(a, b)`: true when both have the same set of `(path, blobHash)` (order-insensitive). `diffManifests(old, next) → { added, removed,
    changed }`: path arrays, each sorted by code unit. FROM-SPEC (spec:399 `cap_blobs` "hash (sha256 hex)"; spec:411 "compare with the latest
    version's manifest"; spec:95 "version diff") FROM-CALLERS (packages/shared/src/repositories/library.ts:17-20, 82-84). Binary exclusion,
    bodyHash input: YOUR-CHOICE.

D14 Scan algorithm. `scanLibrary(deps: { repos, ctx, roots: Root[], limits?, submit?, cache?, log?, signal? }): Promise<ScanResult>`:
    (1) per root in order: not a directory → `walked: false`, skip it; else walk it per D11 (a walk error on one capability = `unreadable` for it);
    (2) per capability: check `signal` (aborted → reject with `signal.reason`, nothing more written); `buildVersion`; on skip record it;
    (3) unchanged = `repos.library.byName` finds it AND `removedAt` is null AND `rootPath` equals AND `sameManifest` with the manifest of its
        `latest`-labelled version (`listVersions` + `manifest`): count it, write nothing;
    (4) otherwise `repos.library.createVersion(ctx, { ...input, commitMessage: 'scan' })`; `created: true` → push to `created`;
        `created: false` → count as unchanged;
    (5) for every created version, and for a capability that was removed and came back with no new version (createVersion clears `removed_at`),
        call `submit({ queue: 'library', kind: 'changed', payload: { userId: ctx.userId, capId, version }, id: 'library.changed:<capId>:<version>' })`
        when `submit` is given (a throw from `submit` is logged and ignored: the version is already committed);
    (6) removal, after all roots: a namespace is "fully walked" when every root carrying that namespace was walked; every live capability of the
        user (`listCapabilities`, all pages) in a fully walked namespace whose identity was not seen (seen = identities of versioned, unchanged AND
        skipped capabilities; for a skipped capability both its default-name identity and its parsed-name identity when known; a skipped skill also
        protects every live skill of that namespace with the same rootPath) → `repos.library.markRemoved` → `removed`;
    (7) when `removed` is not empty and `cache` is given: `cache.publishInval({ v: 1, event: 'library.changed', userId })` once.
    FROM-SPEC (spec:410-414 steps 1-4; spec:447 "the second sees no change") FROM-CALLERS (packages/shared/src/repositories/library.ts:57-121
    createVersion re-checks under the lock and un-removes; :209-212 markRemoved; packages/shared/src/queues/submit.ts:79-95 submitJob input shape;
    packages/shared/src/cache/inval.ts:10-17 message). Commit message `scan`, deterministic job id, seen/protect rules: YOUR-CHOICE.

D15 Concurrency. Two or more `scanLibrary` calls on the same tree at the same time (one worker plus a CLI, or two processes) create each new
    version exactly once: version numbers have no gap or duplicate, the sum of `created` across the results equals the number of changed
    capabilities, and every other call reports them unchanged. This relies on `createVersion` (advisory lock + manifest re-check inside the lock);
    the scanner adds no lock of its own and no in-process mutex. FROM-SPEC (spec:412, spec:447, spec:457 "parallel scans make no duplicate
    version"). No own lock: YOUR-CHOICE.

D16 Served version. `resolveServed(versions: { version: number; labels: string[] }[], opts?: { override?: { action: 'pin' | 'block'; label?: string | null;
    version?: number | null } | null; defaultLabel?: string }): number | null` (`defaultLabel` default `'production'`), first match wins:
    override `block` → `null`; override pin `version` that exists → it; override pin `label` on some version → that version; a version carrying
    `defaultLabel` → it; a version carrying `latest` → it; the highest version; no versions → `null`. A pin whose version or label does not exist
    falls through to the next rule. `capabilities.served_version` holds the result WITHOUT any override (project overrides are resolved at read
    time by T3.2/T5.1 with the same function). FROM-SPEC (spec:390 "project override (version, or label) → `production` → `latest`"; spec:438
    `default_label` "production, falling back to latest"). Fall-through of a dangling pin, highest-version fallback, override-free column: YOUR-CHOICE.

D17 `library.changed` handler, payload `{ userId, capId, version }`, ctx `{ userId }`:
    (1) `repos.library.get`; `null` → `{ capId, skipped: 'not_found' }`; `removedAt` set → `{ capId, skipped: 'removed' }` (job `done`);
    (2) served = `resolveServed(listVersions(...), { defaultLabel: config.library.default_label })`; different from `servedVersion` → `setServed`;
        `payload.version` is not used for the decision (a label move enqueues `changed` for any version);
    (3) when `deps.embed` is given and served is not null: text = `skillretText({ name, description, body }, config.embed.skillret_body_chars)` =
        `` `${name} | ${description} | ${body.slice(0, bodyChars)}` `` with description from the served version row and body from its main file
        (`getBlob(versionId, 'SKILL.md')` for skills, the only manifest path otherwise; body per D12/D13); `textHash = sha256Hex(text)`; when the
        capability has no vector with that `textHash` (`loadVectors`): `[embedding] = await embed([text])`, `upsertVector({ capId, textHash,
        embedding, model: config.embed_model })`; then always `pruneVectors(ctx, capId, textHash)` (served version only, spec:400);
    (4) dedup, when the capability has a vector: for every other live capability's vector with `cosine > config.library.dedup_cosine` (strict) →
        `repos.dedup.upsertPair(ctx, { pair: [capId, otherCapId], similarity })`; `dedup` = number of pairs written;
    (5) `cache?.publishInval({ v: 1, event: 'library.changed', userId })` once per run (also when nothing changed: the run means labels may have moved).
    An `embed` throw propagates (job retried; the old vector keeps serving, spec:451). FROM-SPEC (spec:415-419 changed steps 1, 3, 4 and "publish
    `ctc:inval`"; spec:390 only the served version is embedded; spec:416 text) FROM-CALLERS (packages/shared/src/repositories/library.ts:244-262,
    packages/shared/src/repositories/dedup.ts:23-31). Omitting enrich and the graph node (D7), optional embed, strict `>`: YOUR-CHOICE.

D18 Handlers. `libraryHandlers(deps: LibraryDeps): { 'library.scan': Handler; 'library.changed': Handler }` (Handler of
    apps/worker/src/jobs/consumers.ts:164-167). `LibraryDeps = { repos: Repositories; config: { mode, claude_home, embed_model, embed: {
    skillret_body_chars }, library: { roots, default_label, dedup_cosine, max_files, max_bytes } }; submit?; cache?: { publishInval(msg): Promise<void> };
    embed?: Embed; log? }` where `Embed = (texts: string[]) => Promise<number[][]>` and `submit` has the input shape of `submitJob`
    (packages/shared/src/queues/submit.ts:86). `library.scan`: D1a check, `roots = await discoverRoots({ claudeHome: config.claude_home, roots:
    config.library.roots })`, limits from config (D2), `signal` from the job ctx, returns the ScanResult. Both handlers read `config` at call time.
    FROM-CALLERS (apps/worker/src/jobs/index.ts:27 handlers keyed `'<queue>.<kind>'`; consumers.ts:164-167; payloads.ts:16-17). Deps shape: YOUR-CHOICE.

D19 One repository function added (T1.3 D14 allows later tasks to add functions with a tenancy case): `repos.library.pruneVectors(ctx, capId,
    keepTextHash) → number` deletes the `cap_vectors` rows of that capability whose `text_hash <> keepTextHash`, reaching the owner through
    `capabilities.user_id = ctx.userId` in the same statement; a non-uuid or foreign `capId` → `0`. `tenancy.cases.ts` gets the case
    `pruneVectors: { expect: 'zero', … }`; `tenancy.test.ts` stays green. Nothing else in packages/shared/src/repositories changes.
    FROM-CALLERS (agent/t1-3-repos/DECISIONS.md D6a, D11, D12.3, D14 "later tasks may ADD functions … each with a tenancy case";
    packages/shared/src/repositories/tenancy.cases.ts:185) FROM-SPEC (spec:400 `cap_vectors` "served version only"). YOUR-CHOICE: the function.

D20 Watch trigger. `watchLibrary({ roots: string[]; onChange: () => void | Promise<void>; debounceMs?: number; log? }): { close(): void }`:
    `fs.watch(root, { recursive: true })` per root that exists (a missing root or a watch error is logged and ignored, never thrown); events whose
    file name has a dot-segment, `node_modules` or `__pycache__` are ignored; `onChange` runs once, `debounceMs` (default 3000) after the LAST event
    of a burst (trailing debounce); a throw or rejection of `onChange` is logged; `close()` stops every watcher and the pending timer, and is
    idempotent. The worker main binds `onChange` to submitting `library.scan` for `local`. FROM-SPEC (spec:410 trigger "file watch on `~/.claude` and
    plugin roots"). Debounce value and ignore list: YOUR-CHOICE.

D21 The gate test `library.version` (Vitest, file `apps/worker/src/library/library.version.test.ts`, `describe('library.version', …)` with exactly
    these three tests, real Postgres, real files in a temp dir):
    `it('file hash change → version n+1 with latest')`: scan v1 (labels `latest`+`production`), edit one file → v2 with `latest`, v1 keeps
      `production` and loses `latest`, manifests differ only in that path, an unchanged rescan creates nothing;
    `it('label moves are exclusive')`: `repos.library.moveLabels` of `production` and of a custom label to v2 leaves each label on exactly one
      version; `latest` is refused (`RepoError` code `invalid`); after the move the `library.changed` handler sets `servedVersion` 2;
    `it('parallel scans make no duplicate version')`: 4 concurrent `scanLibrary` calls after one edit → exactly one new version, versions `1..n+1`
      with no gap, one `created` entry in total.
    Scratch rules: a fresh schema `ctc_t31_<random>` migrated with `migrate({ url, schema })` from `@ctc/shared/repositories/admin`, dropped in
    `afterAll`; refuses any URL that is not `127.0.0.1:18304`; never the schemas `ctc`, `ctc_eval`, `ctc_own`; temp files under `os.tmpdir()`, removed after.
    FROM-SPEC (spec:457, spec:759, spec:781) FROM-OWNER (O7, O8 scratch DB only). Test split and schema prefix: YOUR-CHOICE.
