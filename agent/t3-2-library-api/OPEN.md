# T3.2 planner notes: what the owner reviews in the final PR

Drafted: `agent/t3-2-library-api/` (SPEC, DECISIONS D0-D22, PROCESS, checks.mjs, selfcheck.py). YOUR-CHOICE lines: 21 (every one is a default under O11).
Status: `checks.mjs` and `selfcheck.py` run and FAIL cleanly (module not built; with `CTC_SCRATCH_PG_URL` unset, every id fails with that reason).
The checks were never run against an implementation (none exists): expect a few planner mistakes; triage after the first coder run (fix the check,
not the code, when the check contradicts DECISIONS.md). One claim was verified by hand: the blob-cleanup race of D20 (below, A1).
Orchestrator before the coder starts: `python3 agent/t3-2-library-api/selfcheck.py --snapshot` (records HEAD and the dirty files).

## A. Highest risk (ordered by blast radius)
1. **D20 edits a T1.3 function to close a real race.** `repos.system.cleanup.deleteUnreferencedBlobs` can delete a blob that a concurrent, not yet
   committed `createVersion` re-references (`on conflict do nothing` takes no row lock; `cap_files.blob_hash` has no FK). Reproduced on the scratch
   DB at 9c944b0: with the current code the referenced blob is gone after both commit; with `lock table cap_blobs in share row exclusive mode`
   the delete waits for the writer and the blob survives. Default: add the lock (5 s `lock_timeout`, job retried). Alternative: leave it (orphans
   are rare today, since the scanner only stores referenced blobs) or add a grace column (needs a migration, collides with parallel tasks).
   Cost: the weekly delete briefly blocks every blob insert.
2. **Restore writes into the user's real skill folders (D18).** Guards: local mode and `userId = local` only (D1c); target must be under
   `claude_home` or a configured root (D1d; plugin `installPath`s outside `~/.claude` are refused); no dot-paths, no `..`, no symlink escape
   (D1e-f); a version imported from Python is refused because its blob is the body without frontmatter (from-python.ts:293-299) and writing it
   would strip the skill's header. Restore never deletes: files added after the restored version stay, so the next scan may create one more
   version (`scan`) that still contains them. Alternative: delete files that the latest version tracks but the restored one lacks (faithful
   "go back", destructive).
3. **No HTTP or MCP server exists yet (D7, D9).** Routes are Fastify-shaped plain objects and tools are `{ name, inputSchema (Zod), call(ctx, args) }`;
   nothing mounts them until the web bootstrap task, and no task in spec §8 names that task. `ctx` (user and project for MCP) is supplied by
   that wiring; until then `ctxOf` defaults to `local`. Same pattern T4.1 used for its spool routes.

## B. YOUR-CHOICE items (D-id: default | alternative | why it matters)
| D | Default | Alternative | Why it matters |
|---|---|---|---|
| D1 | strict route bodies (unknown key, e.g. `userId`, is 422); restore guards (c)-(f) | strip unknown keys; trust DB paths | a typo fails loudly; DB rows from the Python import are not trusted as paths |
| D2 | `listDefault 50`, `labelsMax 20`, `qMax 200`, `cursorMax 512`, `nameMax 200`, `pathMax 1024`; cleanup lock wait 5 s; submit every 6 h | other numbers | input bounds only; 6 h keeps "weekly" within 6 h of the week start after restarts |
| D3 | JSON shapes (camelCase rows, ISO dates, no `userId`), 422 `path` prefixed with `params`/`query`/`body`; handlers never throw | Fastify error handler maps errors | the web bootstrap must not double-wrap errors |
| D4 | non-uuid ids → 404, never 422; first failing part only; MCP `label`+`version` both given → `invalid` | 422 for malformed ids; version wins | existence is never leaked; explicit failure over a silent pick |
| D5 | MCP args stripped not rejected; `"3"` accepted as a version; removed capability's versions still readable | strict MCP args | models add keys to frozen tools |
| D6 | restore keeps every file not in the version; temp files always cleaned | delete extra files | see A2 |
| D7 | no `enrich` route (no `llm.enrich` consumer: job would end `dead`), no dedup routes, no label-removal, no global-pin, no file-content route | build all of spec:431 | dashboard needs these once its spec exists; enrich needs a handler first |
| D9 | `@ctc/shared/schemas/library` (LABEL_RE repeated there), `apps/web/src/library`, `apps/worker/src/library/blobs.ts`; no Fastify/SDK dependency | add `zod`/`fastify`/SDK to apps/web | lockfile churn while parallel tasks run |
| D10 | `LibraryApiDeps` with injected `submit`, optional `cache`, `ctxOf` default `local` | a global context object | testability; shared-mode auth plugs into `ctxOf` |
| D11 | `ns:name` qualifier; `user` namespace first; else one namespace; else `ambiguous` (≤ 10); kind order skill > agent > command > workflow; new `repos.library.listByName` + tenancy case | require namespace and kind args (not in the frozen tool shape); `ambiguous` for kind ties | a skill and a command often share a name; the agent gets the skill silently |
| D12 | project override row beats the global row; cache value = all override rows of (user, project); `served_version` column ignored | column + overrides | T5.1/T3.3 must call `servedVersion` (or the same rule) for pins to matter |
| D13 | explicit `label`/`version` reads past a `block`; `body` = main file without frontmatter, `''` when absent; message `not served for this project` | block wins always | a blocked skill is still loadable on purpose |
| D14 | raw content, no JSON wrapper | JSON `{content}` | agents read it directly |
| D15 | versions unpaged; diff returns paths only | keyset versions; inline file diffs | a capability with thousands of versions; dashboard diff view needs file contents (no route yet) |
| D16 | labels are moved only, never removed; `library.changed` submitted with a random id; submit failure logged, reply 200 | PATCH sets the exact label set | removing `production` entirely is not possible from the API |
| D17 | `DELETE …/override` added (204); pin needs exactly one of label/version; block takes neither; rotate = `del ovr:` + publish `ovr.changed` | PUT with `action: clear` | the dashboard needs a way to unpin |
| D18 | restore creates the `restore v<n>` version itself (blobs reused), not the next scan; mode of existing files kept; one restore per capability per process; imported versions refused | scanner detects "manifest equals version k" | spec:426 says the next scan does it; the scanner commits `scan` (T3.1 OPEN B D14) |
| D20 | table lock (A1); ISO-week job id `cleanup.blobs:YYYY-Www`; `startBlobCleanup` timer (6 h) instead of a BullMQ repeatable job | repeatable job | repeatable jobs bypass the `jobs` row, so `runAttempt` would skip them |
| D21 | `mainPathOf`/`bodyOf` move into core; worker `handlers.ts` imports them | a second copy in apps/web | touches a T3.1 file (no behaviour change; its tests must stay green) |
| D22 | gate files `apps/web/src/library/library.{mcp,override}.int.test.ts`, schema `ctc_t32_<random>`, fake in-memory cache | real Redis | the gates need Postgres only |

## C. Places where two reasonable readers differ
- spec:426 "The next scan then creates version n+1 with commit message `restore v<version>`": here restore creates it (D18); a scan that wins the race
  records `scan` instead.
- spec:420 "The served version is recomputed and `ctc:inval` published": done by the T3.1 `library.changed` job this route submits, so it is
  asynchronous (seconds), not inside the PATCH transaction. `get_capability` computes the served version at read time, so MCP reads see the move at once.
- spec:421 "rotates `ovr:`": read as delete the per-project key plus an `ovr.changed` publish; there is no epoch for overrides in T1.4.
- spec:423 `get_capability {name}` has no namespace or kind: D11's resolution order is invented here.
- spec:431 lists `enrich` and `dedup*` routes under F2; spec:782 names only "versions/labels/restore/override API" for T3.2. Read narrowly (D7).
- spec:427 "weekly": the job is submitted every 6 h with an ISO-week id, so it runs in the first 6 h of each ISO week (UTC) or at the next worker start.
- spec:450 "no partial write (rename per file)": each file is atomic; a rename failure in the middle of a multi-file restore leaves earlier files
  restored (reported as 500). All temp files are written first, so the common failures (permissions, disk full) touch nothing.
- spec:390 served version is per project, but `capabilities.served_version`, the embedding and the graph node stay override-free (T3.1 D16): a pin
  changes MCP reads and (once T5.1 uses `servedVersion`) the prompt line, not the vectors.
- spec:166 `/api` is internal: the shapes in D3/D15 are this planner's; the dashboard rework (no spec, O12) may want others.
