# Feature Specification: Context + coding graph (m6)

**Feature Branch**: `m6-graph`

**Created**: 2026-10-26

**Status**: Draft

**Input**: User description: "Context + coding graph for claudethecaller (milestone m6). Feature directory must be specs/002-context-coding-graph (it already exists and holds design.md, the owner-approved design: read it in full; it is the single input for this spec, do not re-ask what it settles). Write spec.md from design.md: user stories with priorities, functional requirements, success criteria, edge cases, assumptions. No git branch creation (we are already on m6-graph)."

## Context

The coding agent working in this repo does not see which spec, task or decision it is working under, or which code already implements a requirement, unless someone pastes it in. m6 builds two graphs and puts the relevant slice of them in front of the agent:

- **Context graph**: what should be built and why: features, user stories, requirements, success criteria, tasks, tickets, decisions, constraints, PLAN.md steps and claude-mem observations.
- **Coding graph**: what exists: graphify's code graph of the repo, plus links from context to the code that implements or tests it.

All "how" decisions (storage, node ids, link kinds, hook routes, extractor mechanics, eval method) are settled in `design.md` in this folder and are not repeated here. Every requirement below traces to a design section.

## Clarifications

### Session 2026-10-26 (owner grilling, rounds 1–5, carried over)

- Q: What do the two graphs hold? → A: Context = spec docs, tickets, PLAN.md, PRDs, CLAUDE.md Decisions, claude-mem observations; coding = graphify's code + rationale nodes plus context→code links. graphify's markdown-heading nodes are not imported.
- Q: How is graphify reused? → A: Run unchanged (its extraction and hooks); claudethecaller reads its output file. graphify and claude-mem are external tools, never code dependencies.
- Q: How is context generated? → A: A parser for structured ids, plus a claude-mem-style background extractor on the owner's subscription (small model, changed chunks only), triggered by speckit step hooks and doc saves.
- Q: How do agents follow the graph? → A: Both pushed (a note per prompt, a note per file before reading or editing) and pulled (on-demand graph questions).
- Q: Which projects? → A: This repo first.
- Q: How is it judged? → A: On n8n-parity history: truth = files each ticket's commits changed; tickets 01–08 tune, 09–16 test (ticket 17 has no commits).
- Q: Dashboard graph view? → A: Not in m6; exporting to graphify's viewer covers viewing.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Build both graphs for this repo and see their state (Priority: P1) 🎯 MVP

The owner runs one command and gets the coding graph (from graphify's latest output) and the context graph (from specs, tickets, PLAN.md, PRDs and decisions) for this repo, with counts per kind and a freshness report.

**Why this priority**: Everything else reads these graphs. On its own it already answers "what does the project say it is building, and is the graph current?"

**Independent Test**: Run the build and status commands on this repo; compare the counts with the source files and graphify's output.

**Acceptance Scenarios**:

1. **Given** graphify has produced its graph for the current commit, **When** the owner imports it, **Then** the coding graph holds exactly graphify's code and rationale nodes and the edges among them, and the command prints node and edge counts.
2. **Given** `specs/001-n8n-parity` exists, **When** the owner builds the context graph, **Then** it reports 16 user stories for that feature plus its requirement, success-criterion and task counts, the 17 tickets, the PLAN.md steps and the CLAUDE.md decisions.
3. **Given** graphify's output was built at an older commit than HEAD, **When** the owner asks for status, **Then** it shows both commits and marks the coding graph as stale; it also shows when each context source was last read.
4. **Given** a requirement id such as FR-001 appears in two different features, **When** the context graph is built, **Then** the two stay separate nodes, each tied to its own feature.

---

### User Story 2 - Context is linked to the code that implements it (Priority: P1)

For any task, story or requirement, the owner or agent can see which files and functions implement or test it; for any file, which tasks and requirements touch it. Links say how they were found (named in a doc, found in a commit, found by meaning, confirmed by Claude) and how sure they are.

**Why this priority**: The links are what turn two separate graphs into "follow the spec to the code". Without them, pushes have nothing to point at.

**Independent Test**: Build links on this repo; check that tasks which name files link to those files and that the build reports the share of tasks with at least one code link.

**Acceptance Scenarios**:

1. **Given** a task text names a file or a function, **When** links are built, **Then** the task links to that file or function with the highest confidence.
2. **Given** commits whose message names a ticket (e.g. `(n8n parity 09)`), **When** links are built, **Then** the ticket links to the functions those commits changed, and these commit-derived links can be switched off.
3. **Given** a requirement whose text matches code by meaning only, **When** links are built, **Then** it gets lower-confidence links to its closest code, limited to the best few above a cut-off.
4. **Given** claude-mem has observations for this repo with files read or modified, **When** links are built, **Then** each such observation becomes a context node linked to those files; when claude-mem is not running the build still succeeds without them.

---

### User Story 3 - The agent sees a code map with each prompt (Priority: P1)

When the owner types a prompt in a Claude session in this repo, the agent receives one short extra line naming the best-matching task, story or requirement, the code it lives in (file, function, line) and any decision that constrains it. When the prompt does not relate to any context, no line appears.

**Why this priority**: The product's thesis is that agents rarely pull tools on their own; a push is what makes the agent actually follow the spec.

**Independent Test**: With the graphs built, send a ticket-like prompt and an unrelated prompt through the prompt hook; the first returns one line pointing at the right file, the second returns nothing.

**Acceptance Scenarios**:

1. **Given** the graphs are built, **When** the prompt is "retry a failed run from a node", **Then** the line names the matching n8n-parity story or task and at least one runner engine file with function and line.
2. **Given** an unrelated prompt (e.g. a general knowledge question), **When** it is submitted, **Then** no graph line is added.
3. **Given** the service is down or slow, **When** a prompt is submitted, **Then** the prompt goes through unchanged and is not delayed beyond the existing hook budget.
4. **Given** a line is shown, **When** the owner later reviews routing history, **Then** the shown line is recorded with that prompt's decision.

---

### User Story 4 - The agent sees file notes before reading or editing a file (Priority: P2)

Right before the agent reads, edits or writes a file, it receives a short note naming up to three tasks or requirements tied to that file and one decision or constraint that applies, when any exist.

**Why this priority**: The prompt line catches intent; the file note catches the moment the agent is about to change code that a spec or decision governs. It needs US2's links.

**Independent Test**: Simulate a read of a file that implements a known task and of a file with no links; the first returns a note, the second returns nothing, both within the budget.

**Acceptance Scenarios**:

1. **Given** a file linked to tasks and a decision, **When** the agent is about to read or edit it, **Then** it receives a note naming at most 3 tasks/requirements and 1 decision/constraint.
2. **Given** a file with no links, **When** the agent is about to read it, **Then** nothing is added.
3. **Given** the service is down, **When** the agent reads a file, **Then** the read proceeds unchanged with no visible error.

---

### User Story 5 - The agent can ask the graphs on demand (Priority: P2)

The agent can search either graph or both by a question, explain a node and its neighbours, find what is affected by changing a node (code callers plus the tasks and requirements linked to it), and find the path between two nodes. The owner can export either graph in graphify's file format to use graphify's own query and viewer.

**Why this priority**: Pushes are short by design; pulls give the full answer when the agent needs more. Export reuses graphify's viewer instead of building one.

**Independent Test**: Ask "retry a failed run from a node" against both graphs and check the answer includes runner engine functions and the matching story; export and open the file with graphify's query command.

**Acceptance Scenarios**:

1. **Given** the graphs, **When** the agent searches with a question, **Then** it gets the closest nodes found by meaning plus their near neighbours, within a fixed size budget, and is told when the answer was cut.
2. **Given** a function node, **When** the agent asks what is affected, **Then** it gets its callers and the tasks and requirements linked to it.
3. **Given** two node names, **When** the agent asks for a path, **Then** it gets the shortest connection or a clear "no path".
4. **Given** an export of the context graph, **When** the owner runs graphify's query on that file, **Then** graphify loads and answers it.

---

### User Story 6 - Context stays fresh without manual steps (Priority: P2)

When specs, tickets, PLAN.md, PRDs or CLAUDE.md change, or a speckit step finishes, the context graph updates by itself. Prose without structured ids (decisions, constraints, implied requirements) is turned into nodes and links by a background Claude pass that follows a written mode file, processes only changed sections, skips repeats, and never spends quota on unchanged text. When graphify rebuilds its graph, the coding graph re-imports on its next use.

**Why this priority**: A stale graph misleads the agent; manual rebuilds get forgotten. Builds on US1–US2.

**Independent Test**: Edit one section of a spec file and confirm the graph changes with no command typed; re-run with no changes and confirm zero Claude calls.

**Acceptance Scenarios**:

1. **Given** a saved edit to a spec section, **When** the agent or owner writes the file, **Then** the parsed nodes for that file are rebuilt in the background, and only the changed section is sent to the Claude pass.
2. **Given** no doc changed, **When** the extractor runs, **Then** it makes no Claude calls.
3. **Given** a speckit step (specify, plan, tasks) completes, **When** its after-step hook fires, **Then** the context graph is rebuilt for that feature automatically.
4. **Given** the subscription's usage limit is hit, **When** the extractor runs, **Then** it pauses until the reset time and resumes, without retry loops.
5. **Given** the extractor's own Claude sessions, **When** they run, **Then** they never trigger claudethecaller's prompt or file hooks or new extraction.
6. **Given** graphify rebuilt its graph at a new commit, **When** the next hook call or graph command runs, **Then** the coding graph re-imports once.

---

### User Story 7 - Links get confirmed from Claude's own work (Priority: P3)

When the agent finishes a task (ticks it in tasks.md), the files it edited for that task become confirmed links. After an implement step, Claude reviews the feature's by-meaning links and keeps or drops each.

**Why this priority**: Raises link quality over time; n8n-parity's history never ticked its task boxes, so this helps future work rather than the m6 proof.

**Independent Test**: In a session, edit two files, tick one task, and check the task now has confirmed links to exactly those two files; run the review and check kept/dropped links change confidence accordingly.

**Acceptance Scenarios**:

1. **Given** a session edited files since the last ticked task, **When** a task box is ticked, **Then** those files become confirmed links of that task.
2. **Given** by-meaning links for a feature, **When** Claude keeps or drops one, **Then** a kept link becomes confirmed and a dropped one stops appearing in pushes and searches.

---

### User Story 8 - The owner can prove it works on real history (Priority: P2)

The owner runs one evaluation that replays n8n-parity's ticket titles as prompts against a graph built without commit-derived links, and scores whether the prompt line names files those tickets really changed, how often the line appears for unrelated prompts, and how long the hooks take.

**Why this priority**: The milestone is only done when this passes; it also sets the line's cut-off on the dev tickets.

**Independent Test**: Run the evaluation; it prints dev and test scores, the false-trigger rate and hook timings against the pass bar.

**Acceptance Scenarios**:

1. **Given** tickets 01–08, **When** the evaluation tunes the cut-off, **Then** tickets 09–16 are only scored, never used for tuning.
2. **Given** the evaluation run, **When** it finishes, **Then** it prints test recall, false-trigger rate on unrelated prompts, and hook timings, each marked pass or fail.

---

### Edge Cases

- graphify is not installed or its output is missing: the coding graph is empty, status says why, context features still work, hooks stay silent about code.
- graphify's output is being rewritten during import (partial file): the import fails cleanly and keeps the previous graph.
- graphify skipped commits made in worktrees: status shows the coding graph's commit vs HEAD so staleness is visible.
- A task names a file that no longer exists: no link is created for it; the build counts these as unresolved.
- A commit touches many files (merges, renames): merge commits are not used for links; renamed files follow their new path when graphify has it.
- A context node disappears from its doc: the node and its links are removed on the next build.
- Duplicate ids across features (FR-001 in two specs): kept apart by feature.
- claude-mem is not running or has no observations for this repo: build succeeds without them and status says so.
- The extractor returns malformed output: that chunk is skipped and logged; the rest of the build stands.
- Prompts in other languages: matching is by meaning, so they still match.
- The service or its database is unreachable: every hook fails open (no note, no delay beyond budget, no error to the agent).
- A file linked to dozens of tasks: the file note shows at most 3 tasks/requirements and 1 decision.
- A workflow run's own Claude (m5 runner) or the extractor's sessions: no notes and no extraction triggered.

## Requirements *(mandatory)*

### Functional Requirements

**Graphs (design §4–§6)**

- **FR-001**: The system MUST import graphify's code and rationale nodes and the edges among them for this repo as the coding graph, and MUST NOT import graphify's document, concept or hyperedge entries.
- **FR-002**: The system MUST build a context graph with node types feature, story, requirement, criterion, task, ticket, decision, constraint, plan step and observation, from `specs/*/{spec,plan,tasks}.md`, `.scratch/*/spec.md` and `issues/*.md`, `PLAN.md`, `.claude/prds/*.md` and the CLAUDE.md Decisions list.
- **FR-003**: Node identities MUST be stable across rebuilds and namespaced by source, so equal local ids in different features stay distinct.
- **FR-004**: Context edges MUST cover: feature has story, story needs requirement, criterion measures story/feature, task serves story, task part of ticket, task/ticket blocks task/ticket, decision/constraint constrains requirement/task/plan step, requirement refines requirement.
- **FR-005**: Context→code links MUST be one of implemented-in, tested-by (targets under `tests/`) or mentions, and every link MUST carry a confidence (extracted, inferred, confirmed), a score and its origin.
- **FR-006**: The system MUST store both graphs durably in the project's single source of truth and keep a fast in-memory copy per service worker, reloaded after any import or build.
- **FR-007**: The system MUST export either graph (or both) in graphify's file format on request, and MUST NOT commit generated graph files.

**Building and freshness (design §5)**

- **FR-008**: The system MUST parse structured ids without any model: user stories, FR/SC ids, tasks with their story tags and named file paths, ticket files and their blocking refs, PLAN.md step ids and Done-when lines, dated Decisions.
- **FR-009**: The system MUST run a background extraction pass over prose, driven by a written mode file (node and edge types, field rules, skip rules, dedup by content), using the owner's subscription and a small model, sending only sections whose content changed and caching results by section content and mode-file version.
- **FR-010**: The extraction pass MUST pause on a usage limit until its reset time, MUST NOT retry in a loop, and MUST log its token totals per pass.
- **FR-011**: The extraction pass's own sessions MUST NOT trigger claudethecaller's prompt or file hooks or further extraction.
- **FR-012**: The system MUST rebuild the parsed context for a file when the agent writes under `specs/`, `.scratch/`, `PLAN.md`, `.claude/prds/` or `CLAUDE.md`, in the background and within the existing tool-hook budget.
- **FR-013**: The project MUST register speckit after-specify, after-plan and after-tasks hooks that rebuild the context graph, a before-implement hook that shows task→code matches, and an after-implement hook that runs the link review.
- **FR-014**: The system MUST re-import graphify's output once when its recorded build commit changes, checked cheaply on the next hook call or graph command, and on an explicit import command.
- **FR-015**: A status command MUST show graphify's build commit vs HEAD, per-source last-read times, node and edge counts per kind, and the share of tasks with at least one code link.
- **FR-016**: The system MUST import claude-mem observations of type decision, bugfix, feature, refactor and discovery for this repo, read-only and incrementally, and MUST NOT write to claude-mem's store.

**Linking (design §5.5)**

- **FR-017**: The system MUST create extracted links from file paths and function names named in tasks and tickets, from commits whose message or branch names a ticket (to the functions their changes touched; merge commits excluded), and from claude-mem observations' files read and modified.
- **FR-018**: The system MUST create inferred links by meaning between context text and code text, keeping only the best few per context node above a cut-off.
- **FR-019**: Commit-derived links MUST be switchable off for evaluation.
- **FR-020**: When a task box is ticked in tasks.md, the files edited in that session since the previous tick MUST become confirmed links of that task.
- **FR-021**: Claude MUST be able to keep or drop an inferred link by a command; kept becomes confirmed, dropped is excluded from pushes and searches.

**What the agent gets (design §7)**

- **FR-022**: On each prompt in this repo, the system MUST add at most one line (about 80 tokens) naming the best-matching context node, up to 3 code pointers (file, function, line; confirmed before extracted before inferred) and at most one constraining decision, and MUST add nothing when the best match is under the tuned cut-off.
- **FR-023**: The prompt line MUST be recorded with that prompt's routing decision.
- **FR-024**: Before the agent reads, edits or writes a file, the system MUST add a note (about 60 tokens) naming at most 3 tasks/requirements and 1 decision/constraint tied to that file, and nothing when none exist.
- **FR-025**: All hooks MUST fail open: on any error, timeout or unreachable service the agent proceeds unchanged and unblocked.
- **FR-026**: The agent MUST be able to search the graphs by question (context, coding or both), explain a node, list what a node affects, and find a path between two nodes, each answer within a fixed size budget that reports truncation.
- **FR-027**: The owner MUST have commands to import, build, show status, export and confirm/drop links.
- **FR-028**: Installing claudethecaller's hooks MUST add the new file hook, and MUST support a dry run against a temporary home; writes to the real Claude settings need the owner's go-ahead.

**Evaluation (design §8)**

- **FR-029**: An evaluation MUST use n8n-parity tickets with commits: truth = non-test source files changed by each ticket's commits; prompt = the ticket title; commit-derived links off; tickets 01–08 for tuning, 09–16 for scoring only.
- **FR-030**: The evaluation MUST report recall of truth files among the line's first 3 code pointers, the false-trigger rate on unrelated prompts (MetaTool's no-tool set), and hook timings, each against the pass bar in SC-001–SC-004.

### Key Entities

- **Graph node**: one item in either graph; has a stable id, kind (context or coding), type, label, text, source file and line, content fingerprint, a meaning vector and its origin (parser, Claude, graphify, claude-mem).
- **Graph link**: a directed relation between two nodes with relation name, confidence, score and origin; context→code links are the bridge between the graphs.
- **Graph source**: one input (graphify output, a doc file, claude-mem) with the version last read (build commit, content fingerprint, last observation id).
- **Mode file**: the written rules the extraction pass follows: node and edge types, field rules, skip and dedup rules, output shape.
- **Prompt line / file note**: the short texts pushed to the agent, recorded with the decision they were shown for.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On held-out n8n-parity tickets 09–16, the prompt line names at least one file the ticket really changed among its first three code pointers for at least 80% of tickets (an absent line counts as a miss).
- **SC-002**: The prompt line appears for at most 10% of unrelated requests (MetaTool no-tool prompts).
- **SC-003**: Prompts are not slowed: 95% of prompt hooks still answer within 150 ms, and 95% of file notes within 50 ms, with both graphs loaded.
- **SC-004**: A rebuild with no doc changes makes zero model calls; a one-section edit sends only that section.
- **SC-005**: The build of this repo reports 16 user stories for n8n-parity, all 17 tickets, every dated decision, and the share of tasks with at least one code link.
- **SC-006**: The coding graph's staleness is always visible: status shows its build commit next to HEAD.
- **SC-007**: With the service or database down, 100% of prompts and file reads proceed unchanged.

## Assumptions

- graphify (installed as a tool, with its post-commit hook) and claude-mem (worker on its local port) are installed by the owner; m6 reads their outputs and never changes their code or data.
- This repo only, local mode only; other projects, team mode and the m5 runner's agent nodes come later.
- The extraction pass uses the owner's Claude subscription login and a small model; no API key exists on this host.
- Matching by meaning uses the embedder already running for routing; no new model and no extra GPU memory.
- MetaTool's no-tool prompts (already loaded by the benchmark code) stand in for unrelated requests.
- Ticket 17 has no commits and is excluded from scoring.
- No dashboard graph view in m6; graphify's viewer on an exported file covers viewing.
- Tests run against a scratch database; applying the schema to the live database needs the owner's go-ahead at that time.
- graphify's known limits (unnamed communities, label-match noise, structural-only doc nodes, worktree commits skipped) are accepted and listed in design.md §11.
