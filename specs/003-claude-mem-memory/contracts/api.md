# Contract: HTTP API and dashboard types (m7, O6 / O7)

The routes go in `src/ctc/server/library.py`, next to `/api/memories*`, and in `api.py` for sessions. Pydantic models go in `schemas.py`, next to `Memory`. The routes follow PLAN "API design" (orjson, bare arrays newest first, `project` = name, `{error:{code,message}}`), with three recorded deviations (D21, inventory §6):
1. The feed cursor is `before=<iso>,<kind>,<id>`, ordered by `(created_at, kind rank, id)` with kind rank observation 2 / summary 1 / prompt 0, because three id spaces (separate sequences, all starting at 1) are merged and a bare id cannot order them.
2. `q` is hybrid search, not `ilike`.
3. `range=7d|30d|90d|all`, as the dashboard's global Range already sends.

## Routes

| Route | Query / body | Response |
|---|---|---|
| `GET /api/memories/feed` | `project?`, `session_id?`, `types?` (CSV of obs types + `summary` + `prompt`), `q?`, `range?`, `before?` (`<iso>,<kind>,<id>`), `after?` (same form, for polling), `limit=50` (1–200) | `FeedItem[]`, newest first. With `q`: one page of hybrid-ranked rows, no cursor (the UI shows `hasMore = false` and pauses polling); prompt items match by `ilike` on `decisions.prompt`; `range` is passed to search as an explicit date window (`all` = none, so the 90-day default does not apply). |
| `GET /api/memories/feed/counts` | `project?`, `session_id?`, `range?`, `q?` | `{bugfix: n, …, summary: n, prompt: n}` (one `GROUP BY` per table; with `q`, the kind counts of that same result set) |
| `GET /api/memories/timeline` | `anchor` (int \| `S<n>` \| ISO), `depth_before=3`, `depth_after=3`, `project?` | `FeedItem[]` (shared with `memory_timeline`) |
| `GET /api/memories/context` | `project` (required; omitted → 400 `bad_request`, the dashboard disables Preview when no project is selected) | `{text: string}` (JSON, because the dashboard's `req()` parses only JSON): the exact SessionStart text |
| `GET /api/observations/{id}` | | `Observation` |
| `DELETE /api/observations/{id}` | | `{ok: true}`. Soft delete; drops the `ctx:` key. |
| `POST /api/observations/{id}/restore` | | `Observation`; drops the `ctx:` key |
| `DELETE /api/summaries/{id}` · `POST /api/summaries/{id}/restore` | | `{ok: true}` / `Summary` |
| `GET /api/sessions` (existing) | | each `Session` gains `observations: number` |
| `GET /api/sessions/{id}` (existing) | | adds `observations: Observation[]` and `summaries: Summary[]` |
| `GET /api/jobs?kind=observe` (existing) | | used by the "extracting N…" pill |

Errors: an unknown id → 404 `{error:{code:"not_found"}}`; a bad cursor or anchor → 400 `{error:{code:"bad_request"}}`.

## TypeScript (`dashboard/src/types.ts`)

```ts
export type ObsType = 'bugfix'|'feature'|'refactor'|'change'|'discovery'|'decision'|'security_alert'|'security_note'|'sensitive'
export interface Observation { id: number; project: string; session_id: string; prompt_number: number; type: ObsType; title: string;
  subtitle: string; narrative: string; facts: string[]; concepts: string[]; files_read: string[]; files_modified: string[];
  discovery_tokens: number; created_at: string; deleted_at: string | null }
export interface Summary { id: number; project: string; session_id: string; prompt_number: number; request: string; investigated: string;
  learned: string; completed: string; next_steps: string; notes: string; files_read: string[]; files_edited: string[];
  created_at: string; deleted_at: string | null }
export interface PromptItem { id: number; session_id: string; prompt_number: number; text: string; created_at: string }
export type FeedItem = ({ item_type: 'observation' } & Observation) | ({ item_type: 'summary' } & Summary) | ({ item_type: 'prompt' } & PromptItem)
export type FeedCounts = Partial<Record<ObsType | 'summary' | 'prompt', number>>
```

`api.ts` gains `memFeed`, `memFeedCounts`, `memTimeline`, `memContext`, `obsDelete`, `obsRestore`, `sumDelete` and `sumRestore`, with mock fallbacks in `mock.ts` (the existing pattern).

## Memories page (O7)

The layout, cards, chips, states, polling and preview are in inventory §7. The checks are `pnpm -C dashboard build` and the page working against `mock.ts` until O6 lands.
