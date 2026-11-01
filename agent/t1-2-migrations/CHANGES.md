# Changes to the T1.2 contract files

## Round 1 verifier (checks.mjs only; DECISIONS.md unchanged)

1. D10 vectors: the `embedding` dimension query also listed the HNSW index columns (`ctc.*_hnsw.embedding`) that D11 requires. Added `c.relkind='r'` so only table columns count.
   Reproducer: `node agent/t1-2-migrations/checks.mjs D10` (before: got 7 entries incl. `ctc.cap_vectors_hnsw.embedding=1024`).
2. D11 label rule: version ids `${U}v1`/`${U}v2` are not valid uuids, so the "reject" case passed on `invalid input syntax for type uuid` and the "move" case failed on it. Ids changed to `a1`/`a2`; the reject case now requires the error to mention `label`.
   Reproducer: `node agent/t1-2-migrations/checks.mjs D11` (before: got `[true,false]`).
3. D13 capabilities: `v.version||'|'||v.labels||'|'` resolves `text || text[]` to an array op and fails with `malformed array literal: "|"`. Cast `v.labels::text`. The first value is psql's boolean text, so expected `true` -> `'t'`.
   Reproducer: `node agent/t1-2-migrations/checks.mjs D13`.
4. D13 workflow runs: `q()` returns psql text, a boolean prints `t`; expected `true` -> `'t'`.
   Reproducer: `node agent/t1-2-migrations/checks.mjs D13` (before: got `["t",...]`).

## Round 1 verifier, review findings (contract made consistent / executable)

5. D10 `memories.embedding`: the D11 checks insert memories without an embedding, so the column must be nullable; D10 now says so (the coder's `judgment:` already does this).
6. D13.7 + new check `D8 a memory whose scope and project_id disagree is skipped as orphan`: Python allows `global` rows with a `project_id` and `project` rows without one (no CHECK in src/ctc/storage/schema.sql); the target's `check ((scope = 'global') = (project_id is null))` made one such row abort the whole import (`import_failed: memories: ... violates check constraint "memories_check"`), against D8. Now: skipped, reason `orphan`.
   Reproducer: `node agent/t1-2-migrations/checks.mjs D8` (before the coder's fix: got `[1,0,0]`).

## Round 2 verifier

7. D13.7 "chains stay valid" now says valid = acyclic, and new check `D13 memories: merging duplicates never makes a superseded_by cycle`. Fuzzing found that duplicate merging turns `b supersedes a` + `A supersedes B` (a/A and b/B are duplicates) into kept rows pointing at each other, so both live memories look superseded. No earlier check covered it.
   Reproducer: `node agent/t1-2-migrations/checks.mjs D13` (got `[0,"50"]`, want `[0,"0"]`).
