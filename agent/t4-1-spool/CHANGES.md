# Changes to the T4.1 contract after the coder run

## round 1 (verifier): checks.mjs D6 hang server now reads its socket
What: `checks.mjs` D6 `net.createServer((s) => { s.resume(); ... })` (added `s.resume()`).
Why: a paused Node socket never sees the peer's FIN, so `close` never fires even after curl gives up at 250 ms; D6 then
failed ("curl gave up on the hanging nudge") and the cleanup `hang.close()` waited forever on that connection. The server
still never answers, which is what D10's "accepts and never answers" asks for. Planner mistake, not a module defect.
Reproducer: a server without `s.resume()` + `LC_ALL=C curl -s -m 0.25 -X POST --data '' http://127.0.0.1:<port>/` →
curl exits 28 at ~257 ms, `close` never fires; with `s.resume()` → `close` at ~259 ms.

## round 2 (verifier): selfcheck.py suites() tolerates the known pre-existing red test
What: `pnpm -r test` exiting non-zero is not counted when the only failed test is
`packages/shared/src/repositories/schema-assumptions.test.ts > … > every column the repositories use exists` (new `KNOWN_RED`,
`known_red_only()`, same rule as the T3.1 harness): only when that file is unchanged since HEAD, the summed `Tests N failed` equals
the matched failures and no file-level FAIL is present. `pnpm -r test` now runs with `--no-bail` so web/cli/worker still run after
`@ctc/shared` fails. Any other failure still fails the run.
Why: red on the base branch before T4.1 (T1.2 migrations lack `projects.graph_epoch`/`mem_epoch`, T1.3 D10; T3.1 CHANGES.md records
the same). Fixing it needs a migration, which SPEC.md forbids; the check could never reach DONE. Planner mistake, not a module defect.
Reproducer: `CTC_SCRATCH_PG_URL=postgresql://postgres:ctcdev@127.0.0.1:18304/postgres CTC_TEST_DATABASE_URL=$CTC_SCRATCH_PG_URL
CTC_TEST_ADMIN_URL=$CTC_SCRATCH_PG_URL pnpm --filter @ctc/shared exec vitest run src/repositories/schema-assumptions.test.ts`
→ `expected [ 'projects.graph_epoch', …(1) ] to deeply equal []`, no T4.1 file involved. Remove `KNOWN_RED` once the integration
branch has the migration.

## round 2 (verifier): D12 "unusable roots" + a second D12 check in checks.mjs
What: DECISIONS.md D12 gains one rule: a root longer than 2048 UTF-8 bytes, or one whose `projects.upsert` throws a `RepoError`,
is not a project (`PostToolUse` → `dropped`/`outside`; `Stop`/`SessionEnd` → no `projectId`, no sessions upsert). checks.mjs gets a
second `check('D12', …)` for it (2205-byte root, a 2048-byte root that still works, a `ConflictError` fake on `projects.upsert`).
Why: planner gap. D2 allows a 4096-char `cwd`, D12 upserts it as `projects.name` (T1.2 `unique (user_id, name)`, btree entries max
2704 bytes), and D13 stops the pass on the first throw. One legal-on-Linux file (PATH_MAX 4096) therefore blocked delivery of every
later spool file on every pass for `keepDays`. Same for a deterministic `ConflictError` (8-hex project id collision).
Reproducer (round-2 module, real scratch repos, fake queues): an Edit file with `cwd = '/' + 3000 hex chars` (oldest mtime) plus a
valid Stop file → every `drainOnce()` returns `{kept: 2}`, log `spool delivery failed … DatabaseError`; `projects.upsert` alone →
`DatabaseError 54000 index row size 3024 exceeds btree version 4 maximum 2704 for index "projects_user_id_name_…"`.
Expected after the fix: `{queued: 1, dropped: 1}`.

## round 3 (verifier): checks.mjs second D12 check uses its own file names in dir2
What: the `ConflictError` part of `check('D12', 'unusable roots: …')` writes `c1-PostToolUse-1-00000001.json` and
`c2-Stop-1-00000002.json` (was `1-PostToolUse-…`, `2-Stop-1-00000002.json`).
Why: D3 makes the job id `spool:<basename>` and job ids are global: T1.3 `jobs.create` throws `ConflictError` for an id owned by
another user (`packages/shared/src/repositories/jobs.ts:19-29`). The first part of the same check already queued
`spool:2-Stop-1-00000002.json` for its user, so the second user's Stop correctly hit D13 (`ConflictError` → `kept`). Real spool
names carry `<epoch_ns>-<rand>` and never collide like this. Planner mistake, not a module defect.
Reproducer: round-3 module, unchanged checks.mjs → `FAIL D12 expected={"queued":1,"dropped":1,…} got={"queued":0,"dropped":1,…,"kept":1}`;
with the renamed files → `PASS D12 unusable roots …`.
