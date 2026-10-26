# Data Model: claude-mem memory (m7)

All changes are additive to `src/ctc/storage/schema.sql`, in the file's own style: `{schema}` placeholder, idempotent `create … if not exists`, and RLS lines in the block at L295-312. The authoritative DDL is in inventory §3; this file states the entities, rules and state transitions the tickets rely on.

## Entities

### Observation (`ctc.observations`, new)

| Field | Type | Rule |
|---|---|---|
| `id` | bigserial PK | Short, because it is printed on every index row. |
| `user_id`, `project_id` | text | FK `(user_id, project_id)` → `projects`, on delete cascade. |
| `session_id` | text | FK → `sessions(id)`, on delete cascade. |
| `prompt_number` | int | Turn ordinal from `sessions.observed_prompts` + the position inside the job. |
| `type` | text | CHECK ∈ `bugfix, feature, refactor, change, discovery, decision, security_alert, security_note, sensitive` (the mode file's 9). Anything else → that observation is dropped. |
| `title` | text not null | Required (claude-mem `hasStorableTitle`). An empty title is dropped. |
| `subtitle`, `narrative` | text default `''` | |
| `facts`, `concepts` | text[] | Concepts are limited to the mode's 7 ids; unknown ones are dropped. |
| `files_read`, `files_modified` | text[] | Project-relative. `files_modified` comes from Edit/MultiEdit/Write/NotebookEdit inputs. `files_read` is Read inputs ∪ the model's list. |
| `content_hash` | text | `sha256(session_id \0 title \0 narrative)[:16]`. |
| `discovery_tokens` | int | Call usage ÷ number of observations from that call (D20). |
| `model` | text | The `--model` alias passed to `claude -p` (`haiku`). `proc.run_agent` returns no exact model id (`ponytail:` keep the init line's `model` if it matters). |
| `created_at` | timestamptz | The turn's last transcript timestamp (fallback `clock_timestamp()`), not the job's `now()`: a job that ran late still dates its observations correctly. |
| `deleted_at` | timestamptz null | Soft delete. |
| `embedding` | vector(1024) not null | TEI `doc` embedding of title + subtitle + narrative + facts. |
| `tsv` | tsvector, generated | `'simple'` over `obs_text(title, subtitle, narrative, facts, concepts)` (unaccent_i). |

Constraints and indexes:
- `unique (session_id, content_hash)`;
- `observations_recent (user_id, project_id, created_at desc, id desc) where deleted_at is null`;
- GIN on `tsv`;
- HNSW on `embedding` (cosine).

### Turn summary (`ctc.session_summaries`, new)

| Field | Type | Rule |
|---|---|---|
| `id` | bigserial PK | Displayed as `S<id>`. |
| `user_id`, `project_id`, `session_id` | text | As for observations. |
| `prompt_number` | int | `unique (session_id, prompt_number)`; inserts upsert. |
| `request`, `investigated`, `learned`, `completed`, `next_steps`, `notes` | text default `''` | Parsed from `<summary>`. A `<skip_summary reason=…/>` reply → no row. |
| `files_read`, `files_edited` | text[] | Rolled up from that job's observations. |
| `discovery_tokens`, `model`, `created_at`, `deleted_at` | | As for observations. |
| `tsv` | tsvector, generated | `'simple'` over the six text fields. |

Indexes: `summaries_recent (user_id, project_id, created_at desc, id desc) where deleted_at is null`, GIN on `tsv`. There is no vector (`ponytail:` add one if summary recall is weak).

### Session (`ctc.sessions`, existing: two new columns)

- `observed_bytes bigint not null default 0`: byte offset in `transcript_path` already processed.
- `observed_prompts int not null default 0`: typed prompts seen so far. This is the prompt_number source; it is not the `decisions` count, because repeats collapse there.

### Prompt item (existing `ctc.decisions`, read-only here)

A feed `prompt` card is `{id, session_id, prompt_number, text = decisions.prompt, created_at = decisions.at}`. Its prompt_number is the row's ordinal among the session's decisions. That is display only, and repeats are collapsed (`ponytail:`). No new table (D1). Tags are stripped before the write (O1).

### Memory index (Redis only)

- Key `ctx:{user}:{project_id}`: the rendered body without the header line, TTL `memory.context.ttl_s` (600).
- Written by `observations.refresh_context()` at the end of each `observe` job, and on a miss in `/v1/hook/start`.
- Deleted by observation and summary delete or restore.
- Never a source of truth.

### Capture job (existing `ctc.jobs`, new kind `observe`)

- Payload: `{session_id, project_id, user_id, transcript_path, final: bool, upto: bigint}`. `upto` is the transcript size at Stop time: the job reads only through the last `\n` at or before it, so a turn still being written is left for the next job (`final` jobs pass the file size). A second Stop while a job is `queued` raises that job's `upto` (`greatest`) instead of queuing another.
- It never contains the prompt or `last_assistant_message`; the job reads the transcript instead.
- Result: `{turns, calls, observations, summaries, dropped_chunks, failed_chunks, skipped: <reason>?, quota_until?}`. Counts and status codes only: never reply text, `r['error']` or any prompt text, because `jobs.result` and `jobs.error` live in Supabase.
- A session with no `sessions` row → `skipped: 'no session'` (the FKs need it; the next prompt hook creates it).

## State transitions

**Turn capture** (per session):

```text
Stop hook ──► observe job queued (skip if one is already queued for the session)
          └─► job runs: read from observed_bytes ─► turns ─► gates
                ├─ no tool events / private / skipped project ─► advance watermark, no call
                └─ chunks ─► claude -p (≤ 8) ─► parse (1 retry) ─► embed ─► ONE transaction:
                       insert observations (on conflict do nothing), upsert summary,
                       set observed_bytes + observed_prompts
                   ─► refresh ctx: key (delete it if rendering fails)
quota error ─► watermark not advanced; session added to source row `observe:pending`; the first observe job
               after quota_until (any session) re-submits every pending session and clears the list
```

**Observation and summary lifecycle**: `live` → (DELETE) `deleted` (`deleted_at` set; hidden from search, feed, timeline, index; `ctx:` key dropped) → (restore) `live`. Cascade: deleting the session or project removes the row.

## Validation rules (from the FRs)

- **Text sent to the model or stored as a prompt or title:** `strip_tags`, then `_redact` (FR-004). On a tool field the order is `strip_tags` → `_redact` → truncate, on the full field (truncating first could cut a PEM block's END line away and leak the key).
- **Turns:** a boundary is a main-chain user row with text and no tool result, where `history.typed_prompt` is non-empty **or** the text starts with a `TAG_NAMES` opener (so a `<private>`-only prompt still opens a turn). `isMeta` and sidechain lines are skipped. A turn whose stripped prompt is empty is fully private: its events are dropped, but it still counts in `observed_prompts`.
- **Echo filter (SC-002, PLAN privacy rule):** `request` and `title` are blanked when they echo the turn's stripped prompt (whole prompt ≥ 15 chars, or any 40-char span); a fact is dropped, and a narrative/subtitle cut, when it shares a 200-char window with the chunk's tool text.
- **Defusing:** after parsing, `strip_tags` over each field, and any remaining `<ctc-memory-context` / `</ctc-memory-context` becomes `‹ctc-memory-context`, so a stored title cannot close the injected wrapper.
- **Tool-event gate:** skip tools `ListMcpResourcesTool, SlashCommand, Skill, TodoWrite, AskUserQuestion`, our `mcp__claudethecaller__memory_*`, claude-mem's retrieval tools, `*session-memory*` paths, and bash commands matching `memory.observe.skip_bash_patterns`.
- **Project gate:** `history.skip_projects` (names or folder basenames) gates both `observe` and `/v1/hook/start`.
- **Field shaping:** each tool input or result is cut to 16,000 chars (60% head + 30% tail + `<elided chars=… original_size_chars=… reason="oversize"/>`), and base64 images are elided.
- **Chunk shaping:** chunks are packed to ≤ 32,000 chars, at most 8 per job; the overflow is logged in the job result.

## Size

About 10–11 KB per observation including the vector and HNSW. At about 43 a day that is about 170 MB a year against the 500 MB free tier; revisit at 100 MB (D10).
