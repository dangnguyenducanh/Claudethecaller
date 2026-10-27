# Feature Specification: claude-mem memory in the Memories feature (m7)

**Feature Branch**: `m7-memory` (stacked on `m6-graph`)

**Created**: 2026-10-26

**Status**: Draft

**Input**: User description: "Clone claude-mem 15.2.1 (Apache-2.0) into claudethecaller's dashboard Memories feature and its memory backend. Source of truth for scope, data model, pipeline, context-injection text, MCP/API surface, Memories page target, reusable assets and the 23 owner decisions (D1–D23, recommended defaults): .scratch/claude-mem-port/inventory.md. Default scope = the core memory loop. Out of scope: cloud sync, telemetry, other IDEs, Endless mode, language modes, my-work UI, work_state, corpora, smart_* file tools, near-dup dedup, ACT-R, SSE. ctc.memories (trusted memories) is unchanged; observations never become trusted memories. Raw prompts/tool output never stored in Supabase."

## Context

Today the Memories feature holds a small set of *trusted* memories: preferences, conventions and facts distilled from the owner's own typed words (B8, A3), plus skill outcomes (B9). It does not record what the agent actually did in a session. A new session therefore starts with no recollection of the bugs fixed, decisions taken or files explored last time unless the owner pastes it in. m6 only reads a separately running claude-mem tool over HTTP.

claude-mem solves this for Claude Code with a loop:
1. Record compact, typed **observations** of the work, plus a summary of each turn.
2. Show a short index of them at the start of every session.
3. Let the agent pull details on demand in three cheap steps.
4. Show it all in a viewer.

m7 brings that loop into claudethecaller. It reuses claude-mem's prompts, formats and UI where the Apache-2.0 licence allows, and keeps this project's rules: one cloud database, no raw transcripts, hooks that only suggest and fail open.

Every "how" choice is settled in `.scratch/claude-mem-port/inventory.md` and not repeated here: tables, job mechanics, the text template, the search query, tool shapes and component mapping. Requirements cite it as **[§n]** for sections, **[Dn]** for decisions, and feature ids such as **[A4]** / **[C8]** / **[V3]**.

## Clarifications

### Session 2026-10-26 (owner)

- Q: Where does claude-mem go? → A: Into the existing **Memories** feature: the dashboard Memories page and the memory backend behind it. It is not a separate tool or page.
- Q: May its code be reused? → A: Yes. Copy or translate claude-mem's prompts, logic and UI under Apache-2.0, with its LICENSE/NOTICE kept and a header on each derived file [§8]. This is recorded as a new Decision next to "built from scratch" [D22].
- Q: Which model writes observations? → A: `claude -p --model haiku` on the owner's own login, the same path m6's extractor uses. This is a recorded exception to the on-machine default [D3].
- Q: Scope? → A: The core memory loop. Out of scope: cloud sync, telemetry, other IDEs, Endless mode, language modes, the "my work" UI, work-state lists, knowledge corpora, smart file tools, near-duplicate dedup, reinforcement ranking and push streaming (SSE) [§2].
- Q: Owner decisions D1–D23? → A: Every recommended default in inventory §9 applies:
  - no raw prompts or tool output stored [D1, D2];
  - one observer call per turn [D4];
  - observations never become trusted memories [D5];
  - new tables beside memories [D6];
  - keep the m6 claude-mem reader and the claude-mem plugin until parity is shown [D7, D8];
  - importing the old claude-mem database is a later job [D9];
  - keep everything, soft delete [D10];
  - `memory_*` tool names [D11];
  - both summary kinds kept [D12];
  - `'simple'` text search [D13];
  - redaction on [D14];
  - polling, not SSE [D15];
  - SessionStart is allowed 1 s [D16];
  - short numeric ids [D17];
  - project exclusion through the existing skip list [D23].

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Each turn of work becomes typed observations and a turn summary (Priority: P1) 🎯 MVP

While the owner works with Claude Code in a tracked project, every finished turn that used tools is distilled into a few **observations**. Each one has a type (bugfix, feature, refactor, change, discovery, decision, security alert, security note, sensitive), a title, a subtitle, a narrative, facts, concepts, and the files read or modified. The turn also gets a short **summary**: request, investigated, learned, completed, next steps, notes. Nothing raw is kept: no prompts beyond today's rule, no tool output, no `<private>` text, no secrets.

**Why this priority**: Every other story reads these records. On its own it already gives the owner a searchable log of what each session actually did.

**Independent Test**: In a scratch project, run a short session with a few file reads, an edit and a command, then end the turn. The capture job runs once. Observations and one summary appear for that session, with types and files matching the work. A scan of the stored rows finds no tool output text, no `<private>` content and no planted secret. Re-running the job on the same turn adds nothing.

**Acceptance Scenarios**:

1. **Given** a tracked project and a turn that used tools, **When** the turn ends, **Then** one capture job is queued and, within its run, stores 1–N observations and one turn summary tied to that session and turn number.
2. **Given** a turn whose typed prompt is wholly inside `<private>…</private>`, **When** it ends, **Then** nothing from that turn is captured, and the prompt text is not stored as a session title or prompt either.
3. **Given** the same turn is processed twice (retry, or the job is re-run), **When** the second run finishes, **Then** no duplicate observation or summary exists.
4. **Given** a turn with no tool use after the skip rules (a chat-only turn), **When** it ends, **Then** no model call is made and nothing is stored for it [D4].
5. **Given** the project is on the owner's skip list, **When** any turn ends, **Then** no capture job runs and no tool output leaves the machine [D23].
6. **Given** the model's usage limit is reached, **When** the capture job runs, **Then** it pauses and retries later the way m6's extractor does, and no turn is lost (the transcript position only advances after a successful store).
7. **Given** an edit tool changed `src/a.py`, **When** its observation is stored, **Then** "files modified" lists `src/a.py` (taken from the actual tool input, relative to the project) even if the model omitted it.

---

### User Story 2 - A new session starts with a compact index of past work (Priority: P1)

When the owner starts a session (startup, clear or compact) in a tracked project, the agent receives a short, budgeted **memory index**. It is grouped by day: one line per observation (id, time, type icon, title), one line per turn summary, the latest summary's sections, a stats line (what reading the index costs versus what the work cost), and instructions on how to fetch details. It is framed as retrieved data, not instructions. Resumed sessions get nothing new, so the prompt cache stays intact.

**Why this priority**: This is what changes the agent's behaviour: it starts with yesterday's decisions and fixes in view instead of re-reading the code.

**Independent Test**: With observations stored for a project, trigger a session start through the hook. Check that the returned text follows the template, stays at or under the size budget, lists the newest items in time order, and is served from the warm cache within the hook budget. Stop the daemon and confirm the session still starts, with no memory text.

**Acceptance Scenarios**:

1. **Given** a project with stored observations and summaries, **When** a session starts with source `startup`, `clear` or `compact`, **Then** the agent receives the index text inside a `<ctc-memory-context>` wrapper in the documented format [§5].
2. **Given** the rendered index would exceed 10,000 characters including its instructions, **When** it is rendered, **Then** content is dropped in the documented order (full rows, then the last summary, then sessions, then observations) until it fits [C4].
3. **Given** a session is resumed, **When** it starts, **Then** no memory index is added.
4. **Given** a project with no memory yet, **When** a session starts, **Then** a three-line welcome hint points to the Memories page.
5. **Given** the daemon is down or slow, **When** a session starts, **Then** the session starts normally within the hook timeout and without memory text (fail-open).
6. **Given** a capture job just stored new observations, **When** the next session starts, **Then** the index already includes them, because the job refreshed the cached index.

---

### User Story 3 - The agent pulls details on demand in three steps (Priority: P1)

The agent can search past work (`memory_search`) and get an index of matching ids. It can look around one result in time (`memory_timeline`) and fetch full records only for the ids it picked (`memory_get`). Each step returns compact text with a "Next:" hint, plus structured data. Searches combine word matching and meaning, filter by project, type, concept, file and date, and default to the last 90 days.

**Why this priority**: The index is deliberately thin. Without the pull path the agent cannot reach the details that make the memory useful.

**Independent Test**: With a few dozen observations stored, call the three tools in sequence from an MCP client. A search for a known past fix returns it in the top results. The timeline around it shows its neighbours. Fetching it returns the full record framed as evidence. An empty request is rejected with a clear message, and a search that omits the project while several projects have recent sessions asks the agent to name one.

**Acceptance Scenarios**:

1. **Given** stored observations, **When** the agent calls `memory_search` with a query, **Then** it gets a day-grouped index of observations and summaries (id, time, type, title, read cost) and a hint naming the next two tools.
2. **Given** an observation id or `S<n>` summary id, **When** the agent calls `memory_timeline` with it as anchor, **Then** it gets the items before and after it (default 3 each, at most 20), with the anchor marked.
3. **Given** a list of up to 100 ids, **When** the agent calls `memory_get`, **Then** it gets each full record in the requested order, framed as "retrieved data; evaluate it as evidence", within a total size cap, and ids that were omitted are listed.
4. **Given** a call with no query and no filter, **When** it is made, **Then** it fails with a message saying what is needed.
6. **Given** sessions in more than one project started in the last 12 hours, **When** the agent calls a memory tool without naming a project, **Then** it is asked to pass the project name (shown in the index header) instead of silently getting another project's memory.
5. **Given** two projects with memory, **When** the agent searches without naming a project, **Then** results come from the current project only.

---

### User Story 4 - The owner browses the work timeline in the Memories page (Priority: P2)

The Memories page gets a **Timeline** tab as its default, while today's trusted-memory page stays as the **Long-term** tab. The Timeline shows a single feed, newest first, of:
- **Observation cards**: type badge, title, subtitle, a facts/narrative toggle, concepts, files, id and date.
- **Summary cards**: request headline and five sections.
- **Prompt cards**: clamped, with "show more".

Above the feed: type chips with live counts, a text search, the global date range and project filter, and a session filter. The feed scrolls without end, new items appear while the page is visible, and an "extracting…" pill shows capture jobs in progress. Observations and summaries can be deleted with Undo.

**Why this priority**: It is the owner's window into what was captured and the place to correct it. The loop works without it, so it is P2.

**Independent Test**: With mixed items stored, open the Memories page. Toggle chips and check the counts match the shown items. Search for a title word. Scroll past the first page. Delete a card and undo. Store a new observation and see it appear within a few seconds without reloading. Switch to Long-term and see today's page unchanged.

**Acceptance Scenarios**:

1. **Given** observations, summaries and prompts in range, **When** the owner opens Memories, **Then** the Timeline tab lists them newest first, as their three card kinds.
2. **Given** type chips with counts, **When** the owner selects "decision" and "bugfix", **Then** only those items show and each chip's count matches the filtered total for the current project, range and search.
3. **Given** more items than one page, **When** the owner scrolls to the end, **Then** the next page loads with no duplicates or gaps, and "No more items to load" shows at the true end.
4. **Given** the page is visible, **When** a capture job stores new items, **Then** they appear at the top within 5 seconds.
5. **Given** an observation card, **When** the owner deletes it, **Then** it disappears with an Undo option. It no longer appears in search or the next session index, and Undo restores it.
6. **Given** the Long-term tab, **When** the owner opens it, **Then** the existing memory list, filters and actions work exactly as before.

---

### User Story 5 - The owner sees exactly what the agent will be told, and jumps from a session to its memory (Priority: P2)

From the Memories page the owner opens a **context preview** showing the exact text the next session in this project would receive, with the settings that shape it (read-only). From a session in the Sessions page the owner sees that session's observations and summaries and can open the Timeline filtered to it.

**Why this priority**: It builds trust in what is injected and connects the existing Sessions view to the new memory. It is useful, but not required for the loop.

**Independent Test**: Open the preview and compare it byte for byte with what the session-start hook returns for the same project. Open a session's drawer, check its observation count and cards, and follow "Open in Memories".

**Acceptance Scenarios**:

1. **Given** a project with memory, **When** the owner opens the context preview, **Then** it shows the same text the session-start hook would return now.
2. **Given** a session with captured turns, **When** the owner opens it in Sessions, **Then** it lists that session's observations and summaries, and the session list shows an observation count.
3. **Given** a session drawer, **When** the owner clicks "Open in Memories", **Then** the Timeline opens filtered to that session.

---

### User Story 6 - Private, secret and excluded content never reaches the model or the database (Priority: P1)

Anything the owner wraps in `<private>…</private>` and anything that looks like a secret is removed before capture, before routing and before storage. So are this project's own injected memory text and system reminders. Projects on the skip list are never captured. Raw tool input and output and raw prompts are never stored in the cloud database, beyond today's existing rule for routing decisions.

**Why this priority**: Capture sends tool output to a hosted model and stores derived text in a cloud database. Without these guarantees the feature cannot be switched on.

**Independent Test**: In a scratch project, run a turn whose prompt and tool outputs contain `<private>` blocks, a planted API key and a planted PEM block. After capture, search every stored field and the model call log: none of them contains the private text or the secrets. Add the project to the skip list and confirm no capture job runs.

**Acceptance Scenarios**:

1. **Given** a prompt with a `<private>` section, **When** it is routed, stored as a decision, used as a session title or captured, **Then** the private section is absent everywhere.
2. **Given** tool output containing a token matching a known secret pattern, **When** the capture prompt is built, **Then** the token is replaced by a redaction marker before the model sees it.
3. **Given** the injected `<ctc-memory-context>` block appears in a later transcript, **When** that turn is captured, **Then** the block is stripped, so memory is not re-recorded as new work.
4. **Given** the agent called `memory_search`, **When** that turn is captured, **Then** the memory tool calls themselves are not observed (no recursion).

---

### Edge Cases

- **Transcript shrank or was replaced:** reading restarts from the beginning (position and prompt counter both reset), and duplicates are suppressed by content identity [§4 step 2].
- **A turn is still being written when the job runs:** the job reads only up to where the transcript stood when the turn ended, and leaves a half-written line or turn for the next job, so no turn is captured half-finished.
- **A prompt that is wholly private and is followed by tool use:** the tool use is dropped with it. It is never attached to the previous turn.
- **Very long turns (more than 8 chunks of about 32,000 characters):** only the first 8 chunks are observed. The cap is logged, not silent.
- **Oversized single tool outputs:** each field is cut to 16,000 characters (head and tail kept, with an elision marker), and images are elided [A11].
- **The model returns no valid observation markup:** one retry with a schema reminder, then that chunk is dropped, the job still succeeds, and the drop is logged.
- **Two turns end while a capture job is already queued for the session:** no second job is queued. A running job does not suppress a new one [§4 Stop row].
- **Session end:** one final capture runs in addition to the per-turn ones.
- **The observer's own `claude -p` sessions, and the runner's sessions:** never captured (hidden by location).
- **Subagent transcripts:** not captured in m7 (main transcript only).
- **Deleting a project or session:** its observations and summaries are removed with it. The "Forget project" confirmation says so.
- **The claude-mem plugin is still installed:** both systems capture, and claude-mem's lookup bridge also fires on `memory_search`. Capture, the session-start hook and the `memory_*` tools stay inert (`memory.enabled` false) until the owner has turned claude-mem's hooks off and switches memory on [D8, D11].
- **Two daemon workers in shared mode:** capture runs in local mode only. In shared mode the session-start hook and tools still serve what exists.
- **Range "all" with no search:** paging stays keyset-based and stable while new items arrive.

## Requirements *(mandatory)*

### Functional Requirements

**Capture**

- **FR-001**: System MUST queue one capture job per finished turn of a tracked local session, plus one at session end. It must not queue another while one is already waiting for that session [§4].
- **FR-002**: The capture job MUST read the session's transcript from disk, starting after the last processed position and stopping at the position the Stop hook recorded, and group it into turns (prompt, tool calls with their results, final assistant text). A prompt starts a turn even when it is wholly private. It skips meta and sidechain lines [§4 steps 1–2].
- **FR-003**: The capture job MUST apply these skip rules before any model call:
  - the skip tool list, the bash patterns and the skip-project list;
  - memory tool recursion;
  - session-memory paths;
  - fully private turns;
  - turns with no tool use left [A3, D4, D23].
- **FR-004**: System MUST strip `<private>`, injected memory context, system reminders and similar tags (balanced, linear-time, at most 100 tags), then redact known secret patterns. This applies to every text sent to the observer model and to every prompt before routing, decision storage or session-title storage [A4, A5, D14].
- **FR-005**: The capture job MUST call the observer model (`claude -p --model haiku` on the owner's login, no tools, no MCP, no hooks, no saved session) at most once per chunk and at most 8 times per job. It uses claude-mem's observer instructions, the code-mode type and concept vocabulary, and payload truncation [A9–A11, A13, D3].
- **FR-006**: System MUST parse the observer's observation and summary markup independently, accept the "skip summary" sentinel, and unwrap label-wrapped titles. It retries once on unparseable output [A12, A14].
- **FR-007**: Files modified MUST come from the actual edit/write tool inputs, and files read MUST merge read-tool inputs with the model's list, all relative to the project [A14].
- **FR-008**: Storing a job's results MUST be idempotent:
  - observations are unique per session and content identity;
  - summaries are unique per session and turn number;
  - the transcript position and prompt counter advance in the same transaction as the inserts [B14, §3].
- **FR-009**: Each stored observation MUST carry its share of the model call's token usage (usage divided evenly across that call's observations) [D20].
- **FR-010**: The capture job MUST pause on usage-limit errors the way the m6 extractor does, and the paused session MUST be re-queued by the first capture job that runs after the limit resets, so a session that already ended is not lost. A failed or timed-out model call is retried once, then that chunk is dropped and counted; job results and error text hold counts only. It must run in local mode only, only for transcripts under the Claude home `projects` folder, and only for a session that already has a session row [§4 steps 1, 6].

**Storage and search**

- **FR-011**: System MUST store observations and turn summaries in their own tables beside the trusted-memory table, scoped by user, project and session. Both have soft delete, full-text indexing (simple configuration, accent-insensitive), and for observations a 1024-dimension embedding [§3, D6, D13].
- **FR-012**: Observations MUST never be written into trusted memories, recalled into routing bundles or treated as instructions. A user can still save their own memory by hand as today [D5].
- **FR-013**: Search MUST combine keyword rank and vector rank by reciprocal-rank fusion in one database round trip, widen from all-terms to any-term when results are short, and support filters by:
  - project, observation type, concepts, files;
  - date range (default last 90 days, configurable; an explicit range wins);
  - item kind (observations, summaries or both) [B4, B6–B8].
- **FR-014**: System MUST return a time-ordered window around an anchor (observation id, summary id or timestamp) with configurable depth (default 3, max 20), and fetch by up to 100 ids in the requested order [B10, B11].

**Session-start context**

- **FR-015**: System MUST add a session-start hook, matching startup, clear and compact but not resume, with a timeout of at most 1 second, that fails open and returns the memory index as additional context [C1, D16].
- **FR-016**: The memory index MUST reproduce claude-mem's agent-facing template with this project's tool names:
  - newest 50 observations and newest 11 summaries, merged in time order and grouped by day;
  - the latest summary's sections;
  - stats and savings lines;
  - the progressive-disclosure instructions;
  - an empty-project welcome hint;
  - all wrapped in `<ctc-memory-context>` [§5, C2, C3, C5–C7].
- **FR-017**: The index MUST fit within 10,000 characters including the instructions, dropping content in the documented order [C4].
- **FR-018**: The index body MUST be cached per user and project for 10 minutes. The capture job re-renders it, and deletes or restores invalidate it [C8].

**Agent tools**

- **FR-019**: The daemon's MCP server MUST expose `memory_search`, `memory_timeline` and `memory_get`. They take the inputs, return the text and structured outputs, and enforce the clamps and "Next:" hints documented in [§6]. They resolve the project the way the graph tools do, except that an ambiguous project is an error, not a guess [M1–M3, M12, M13].
- **FR-020**: The MCP server's instructions MUST include the three-step workflow text and the untrusted-data framing [C6, M18].

**API and dashboard**

- **FR-021**: The API MUST provide:
  - a merged feed of observations, summaries and prompts with a stable cursor;
  - per-type counts;
  - the timeline;
  - the context preview text;
  - get, delete and restore for observations, and delete and restore for summaries.

  It MUST also add observation counts and lists to the session endpoints. The three documented deviations from the API conventions (composite cursor, hybrid `q`, range values) are recorded in PLAN [§6, D21].
- **FR-022**: The Memories page MUST default to a Timeline tab with:
  - observation, summary and prompt cards;
  - type chips with server counts;
  - search, plus the global range and project;
  - a session filter;
  - infinite scroll with loading, error, empty and end states;
  - 3-second polling while visible;
  - an "extracting N…" pill;
  - soft delete with Undo;
  - a context preview drawer.

  The existing page stays as the Long-term tab [§7, V1–V8, V10, V11, V13, V14, V16, D15].
- **FR-023**: The Sessions page MUST show each session's observation count, and its drawer MUST list the session's observations and summaries with an "Open in Memories" link [V12, V13].
- **FR-024**: The Jobs page MUST list the new capture job kind. The "Forget project" confirmation MUST mention observations and summaries [§7 critic notes].
- **FR-025**: The UI MUST not use claude-mem's name, logo or wordmark. Attribution lives in `third_party/claude-mem/` and in file headers [§8].

**Process and records**

- **FR-026**: `PLAN.md` MUST gain an m7 section listing the steps and their done-when checks. It MUST amend the "models run locally" constraint, the 150 ms hook budget (session start: 1 s), the API conventions and the in-scope list [D21].
- **FR-027**: `CLAUDE.md` Decisions MUST record that claude-mem is a translated source under Apache-2.0, never a runtime dependency, and that observation capture is an exception to the on-machine default [D3, D22].
- **FR-028**: Every file translated or copied from claude-mem MUST carry an attribution header naming the source path and the changes. claude-mem's LICENSE and NOTICE MUST be copied verbatim [§8].
- **FR-029**: The observer and context settings MUST live in one `memory:` configuration block with claude-mem's defaults [§5 config]. The block has an `enabled` switch that is **off by default**: while it is off, no capture job is queued, the session-start hook answers empty and the `memory_*` tools answer "memory is off". The owner turns it on at go-live, after claude-mem's hooks are disabled [D8, D21].

### Key Entities

- **Observation**: one typed note about work done in a turn: type, title, subtitle, narrative, facts, concepts, files read and modified, turn number, token share, model, timestamps, soft-delete marker. It belongs to one session and project. It is derived from tool activity, so it is untrusted.
- **Turn summary**: per turn of a session: request, investigated, learned, completed, next steps, notes, and files read or edited. Separate from the session-level summary that history distill writes [D12].
- **Session** (existing): gains a transcript position and a typed-prompt counter used by capture.
- **Prompt item** (existing decisions): the per-prompt record already kept for routing, shown as prompt cards. It is not a new store [D1].
- **Memory index**: the rendered session-start text per user and project. Cached, never stored as a record.
- **Capture job** (existing jobs table): one per finished turn, with retry and pause state.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For at least 95% of finished turns that used tools, the turn's observations are visible in the Memories page within 2 minutes of the turn ending.
- **SC-002**: A scan of all stored observations, summaries, sessions, decisions and jobs after a planted-data session finds:
  - zero planted secrets;
  - zero `<private>` contents;
  - no stored field containing 200 or more consecutive characters of any tool output.
- **SC-003**: Session start with memory adds at most 150 ms when the index is cached and at most 1 s when it is not. A stopped daemon never blocks or delays a session start beyond the hook timeout.
- **SC-004**: The memory index never exceeds 10,000 characters in tests across empty, small and 500-observation projects.
- **SC-005**: On the same recorded session, capture makes at least 10× fewer model calls than one call per tool use (baseline on this host: 79 calls for 45 observations).
- **SC-006**: Re-running capture over an already processed session creates zero new observations or summaries.
- **SC-007**: Reaching the full record of a known past fix takes at most 3 tool calls (search, timeline, get). On a hand-written set of 20 questions about this repo's recent work, the right item is in the first 5 search results for at least 16.
- **SC-008**: The Timeline's first page shows within 1 second on this host. Scrolling reaches the end of a 500-item project with no duplicate or missing card.
- **SC-009**: After deleting an observation, it is absent from search, the timeline and the next session index right away, and Undo brings it back in all three.
- **SC-010**: The existing Long-term memories, routing recall, history import and m6 graph behave exactly as before. Their self-checks and tests still pass.

## Assumptions

- **Model access:** the owner's Claude Code login works for `claude -p --model haiku` (preflight as in m6, claude 2.1.306 pinned). Haiku usage counts against the owner's subscription.
- **Shared infrastructure:** capture uses the existing single serial job worker, the TEI embedder and the Redis cache. If the queue lags, a second worker is a later change.
- **Where development runs:** all development and live tests run against the scratch database, a scratch Redis (`:18395`, never the real daemon's) and an isolated daemon (`:18311`, scratch HOME, fake or real `claude` as stated per test), from a separate git worktree so the live daemon's checkout and dashboard build are untouched. Applying the schema to the production Supabase, restarting the real daemon and installing the session-start hook into the real `~/.claude` each need the owner's explicit yes.
- **Capacity:** storage fits the free tier for over a year at the measured rate (about 43 observations a day, about 10–11 KB each including the vector) [D10].
- **The claude-mem plugin** stays installed during development for side-by-side comparison. Disabling its hooks is the owner's own step [D8].
- **The m6 reader** of claude-mem stays as it is in m7. Pointing it at the new observations, and importing the existing claude-mem database, are follow-ups [D7, D9].
- **Sessions that started before m7** are not back-captured in m7. A backfill over the history import's transcript list is a follow-up.

## Out of Scope

Cloud sync, telemetry, other IDEs and agents, Endless mode, language and other modes, the "my work" UI, work-state lists and tools, knowledge corpora, smart file tools, near-duplicate dedup, reinforcement ranking, per-prompt semantic injection, file-context injection before reads, folder memory-file generation, a save-memory MCP tool, push streaming (SSE), subagent capture, the claude-mem database import, and repointing the m6 reader.
