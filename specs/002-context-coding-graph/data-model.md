# Data model: Context + coding graph (m6)

All tables live in `src/ctc/storage/schema.sql` (idempotent, `{schema}` templated, `user_id text not null default 'local'` like the other tables). Additive only.

## graph_nodes

| Column | Type | Notes |
|---|---|---|
| user_id | text not null default 'local' | |
| project_id | text not null | `scanner.project_id(cwd)` (sha256 of the resolved path, 8 hex) |
| id | text not null | see "Node ids" |
| kind | text not null check (kind in ('context','coding')) | |
| type | text not null | coding: `code`, `rationale`; context: `feature, story, requirement, criterion, task, ticket, decision, constraint, plan_step, observation` |
| label | text not null | short title (≤ 200 chars) |
| text | text not null default '' | body used for embedding and notes (≤ 2,000 chars) |
| source_file | text | repo-relative path |
| source_line | int | 1-based start line |
| content_hash | text not null | sha256(label + text)[:16]; re-embed only when it changes |
| embedding | extensions.vector(1024) | null until embedded |
| origin | text not null | `graphify`, `parser`, `claude`, `claude-mem` |
| meta | jsonb not null default '{}' | e.g. `{priority:"P1", status:"[ ]", story:"US1", feature:"specs/001-n8n-parity", community:"Store"}` |
| updated_at | timestamptz not null default now() | |

Primary key `(user_id, project_id, id)`. Index `(user_id, project_id, source_file)`.

## graph_edges

| Column | Type | Notes |
|---|---|---|
| user_id, project_id | text | as above |
| src, dst | text not null | node ids |
| relation | text not null | context: `has_story, needs, measures, serves, part_of, blocks, constrains, refines`; bridge: `implemented_in, tested_by, mentions`; coding: graphify's own (`calls, contains, imports, references, imports_from, rationale_for, uses, method, indirect_call, inherits, defines`) |
| confidence | text not null check in ('EXTRACTED','INFERRED','CONFIRMED','DROPPED') | |
| score | real not null default 1 | 1.0 for EXTRACTED/CONFIRMED, cosine for INFERRED |
| origin | text not null | `graphify, parser, claude, claude-mem, commit, embed, session, review` |
| updated_at | timestamptz not null default now() | |

Primary key `(user_id, project_id, src, dst, relation)`. Index `(user_id, project_id, dst)`.

**Write rules** (enforced in `graph/db.py`):
- A rebuild replaces rows **by origin** (and optionally by source file): `replace_origin(origin, nodes, edges, files=None)` deletes that origin's rows (for those files) then inserts. This is what removes nodes that vanished from a doc and their links.
- Rows with origin `review` or `session` are never deleted or overwritten by a rebuild. An insert from another origin on the same `(src, dst, relation)` is `on conflict do nothing` when the existing row's origin is `review`/`session`, else `do update`.
- Edges whose `src` or `dst` no longer exists are deleted at the end of a build (one `delete … where not exists` per end).

**Confidence transitions**:
- `EXTRACTED` (parser, graphify, commit, claude-mem) and `INFERRED` (embed, claude) are written by builds.
- `ctc graph confirm … keep` → `CONFIRMED`, origin `review`. `… drop` → `DROPPED`, origin `review`; `DROPPED` rows are ignored by RAM load, pushes and queries.
- Task tick (FR-020) → new `implemented_in` rows `CONFIRMED`, origin `session`.
- Push ranking of code pointers: `CONFIRMED > EXTRACTED > INFERRED`, then score.

## graph_sources

| Column | Type | Notes |
|---|---|---|
| user_id, project_id | text | |
| source | text not null | `graphify`, `parse:<file>`, `extract:<file>#<chunk>`, `claude-mem` |
| version | text not null | graphify `built_at_commit`; file/chunk content sha (+ mode-file hash for `extract:`); last observation id |
| info | jsonb not null default '{}' | counts, tokens spent, errors |
| updated_at | timestamptz not null default now() | |

Primary key `(user_id, project_id, source)`.

## decisions (existing)

`alter table {schema}.decisions add column if not exists graph_line text;` — the prompt line shown for that decision (FR-023), null when none.

## Node ids (stable, namespaced)

| Source | Id |
|---|---|
| graphify | `code:<graphify id>` |
| spec feature | `ctx:specs/<dir>` |
| story / requirement / criterion / task | `ctx:specs/<dir>:US<n>` · `…:FR-###` · `…:SC-###` · `…:T###` |
| `.scratch` feature / ticket | `ctx:.scratch/<feature>` · `ctx:.scratch/<feature>:ticket-<NN>` |
| PLAN.md step | `ctx:PLAN:<step>` (e.g. `ctx:PLAN:WB2`, `ctx:PLAN:M1`, `ctx:PLAN:G3`) |
| PRD | `ctx:prd:<file stem>` and `ctx:prd:<file stem>:<slug>` per requirement heading |
| CLAUDE.md decision | `ctx:CLAUDE:decision:<YYYY-MM-DD>:<n>` (n = order within that date) |
| Claude-extracted | `ctx:<file>:x-<slug>` (slug from the title, deduped with `-2`, `-3`) |
| claude-mem | `ctx:claude-mem:obs-<id>` |

## RAM graph (`graph/core.py`)

```text
Graph
  version: str                         # max(graph_sources.updated_at) when loaded
  nodes:   dict[id, NodeRow]           # all non-DROPPED nodes, without embeddings
  out:     dict[id, list[(dst, relation, confidence, score)]]
  inc:     dict[id, list[(src, relation, confidence, score)]]
  by_file: dict[source_file, list[id]] # coding nodes and context nodes that point at a file
  ids:     np.ndarray[object]          # rows of vecs
  vecs:    np.ndarray[float32, (n, 1024)] normalised; nodes without an embedding are left out
```

`State.graphs: dict[(user_id, project_id), Graph]`. Loaded lazily by `graph_for(st, cwd, user_id)`; a background refresh runs when the cached copy is older than 30 s and `graph_sources` changed (never on the hook's critical path). Builds call `invalidate(st, user_id, project_id)` in the worker that ran them.
