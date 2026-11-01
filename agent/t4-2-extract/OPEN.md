# T4.2 planner notes: what the owner reviews in the final PR (O11, O12)

Drafted: `agent/t4-2-extract/` (17 decisions D0-D16, 17 checks). FROM-OWNER: O11 (silence rule, every default below is "A"), O12 (no `~/.claude`, no live daemon: transcripts live in a `mkdtemp` `claude_home`; tests and checks never call the shared TEI :18300 or llama-server :18302, they use fakes and a loopback `node:http` server).
Status: `node --import tsx agent/t4-2-extract/checks.mjs` → `CHECKS: 0 pass, 17 fail` (module not built); `python3 agent/t4-2-extract/selfcheck.py [--fast]` → `SELFCHECK: FAIL` at preflight (the 4 entry files missing). The checks have never run against an implementation: expect a few planner mistakes; triage after the first coder run (fix the check only when the decision says otherwise).
Checked by hand on the shared services (read-only requests): llama-server :18302 honours `response_format: {type: 'json_schema', ...}` on `/v1/chat/completions` (`n_ctx` 32768, 1 slot); TEI :18300 `POST /embed {inputs}` returns 1024-d vectors, `max_client_batch_size` 32.

## A. Cross-task points (ordered by blast radius)
1. **No "since the last extract" cursor** (D11, D7). Spec:519 asks for one, but no table holds it (T1.2 `sessions` has no offset column) and adding a migration is outside this task. Default: every `llm.extract` reads the whole transcript and sends the newest 12,000 chars of user words; facts already stored meet themselves as NOOP. Costs: one llama call per Stop on the whole window (bounded); a long session's oldest words are never re-read after they leave the window (they were read by earlier Stops); a statement repeated in the window on a later day adds that day to `reinforcement_dates` (inflates the recall boost); **T4.3 `memory.distill` of an old transcript only sees its newest 12,000 chars**. Alternative: migration `sessions.extracted_turns int` + `repos.sessions.setExtracted`, and extract only turns after it (T4.3 should decide before distill is built).
2. **Nobody owns the worker main yet.** `memoryHandlers` needs `repos`, `config`, `embed = createEmbedder({url: config.embed_url})`, `chat = createChat({llm: config.llm})` and `cache` bound into `startWorkers`. Same gap as T3.1 and T4.1 A1: if no later task builds `apps/worker` main, no `llm` job ever runs on the new stack.
3. **Who decides "same meaning" vs "contradicts"** (D12). The spec's band table does not say. Default: a second llama call with `RELATION_SCHEMA` only in the 0.85-0.95 band; a failed or invalid judge → ADD (keep both, hide nothing). Alternative: one combined call that gets the neighbour in the extract prompt (cheaper, but the neighbour is unknown before the fact is embedded); or always SUPERSEDE in the mid band (history kept, but every paraphrase hides the older row).
4. **`sanitize` lives in `packages/core/src/sanitize`** (D9, D10), not in `packages/core/graph` as spec:94 says (that folder is not built). T2.x must import `@ctc/core/sanitize` instead of writing its own, and pass `{maxChars: 256}` for labels. The `ctc: ` line rule assumes T5.1's prompt line keeps the `ctc: ` prefix (spec:230); T4.3's SessionStart block format is not known yet, so its lines are not stripped unless they start with `ctc: `: **T4.3 should prefix every injected line with `ctc: ` or extend `sanitize`**, or the next extract may learn ctc's own context block as user facts. [UNVERIFIED] how Claude Code stores SessionStart `additionalContext` in the transcript (a `<system-reminder>` in a user row would be stripped by D10; a meta row is skipped by D11); proof: one real transcript row, read by the owner.
5. **Model clients live in `packages/shared/src/models`** (D9, D15). T3.3 (SKILLRET dense channel), T4.3 (recall, `save_memory`) and T5.1 should reuse `createEmbedder`; T3.3 needs the skillret instruction prefix, which this client does not add (memories are embedded as plain text on both sides).
6. **Resumed sessions keep their first summary.** `session_summaries.session_id` is the primary key and `insertSummary` is `ON CONFLICT DO NOTHING` (T1.2/T1.3), so a session resumed after SessionEnd never gets a new summary; D14 step 2 even skips the model call. Alternative: a repository `upsertSummary` that replaces the row when the content hash differs (repository change).
7. **Doc-extractor sessions** (`claude -p --model haiku`, F1 doc extraction) still fire Stop/SessionEnd and are not filtered (D7): no marker exists. T2.3 should run them with a cwd under `/.ctc/wt/` or another marker that `isRunnerSession` can see.
8. **`mem_epoch` is per project** (D13 step 6): a new global memory does not rotate other projects' `ctx:` blocks; they refresh within the 10 min TTL (spec:178).
9. **"today"** for NOOP reinforcement is the UTC date in the worker (`deps.today`), while the repository's hash-conflict path uses Postgres `current_date`. On a non-UTC database the two can differ near midnight (two dates in one day). The scratch DB is UTC.
10. **The `bad_reply` text in `jobs.error` is `dropped:bad_reply`** (T1.4 `JobDropped` prefixes `dropped:`), not the bare `bad_reply` of spec:520. The dashboard should match on the suffix.

## B. YOUR-CHOICE items (D-id: default | alternative | why it matters)
| D | Default | Alternative | Why it matters |
|---|---|---|---|
| D1 | threat list; `transcriptPath` must resolve inside `<claude_home>/projects/` | trust the drain's path | a spool file could make the worker read any file and store it as memories |
| D2 | `maxFacts` 20, `maxMemoryChars` 300 (skip, not cut), `maxUserChars` 12000, `maxTurnChars` 2000, session head 6000 + tail 18000, summary field 2000, transcript 32 MiB tail | other sizes; cut long facts | model cost per Stop; a cut sentence is a wrong fact |
| D2 | `modelLimits` embed 10 s, chat 50 s, `max_tokens` 1024 | longer chat timeout | two chat calls + embeds must fit the 120 s `llm` timeout |
| D3 | result shapes, drop codes, `source = {type:'session', sessionId, transcriptPath}` | no result | Jobs page, tests, provenance on the Memories page |
| D3 | summary `content_hash` = sha256 of `summary-v1\n<session>\n<input text>` | hash of the model reply | same session → same hash even when the wording changes; two sessions never collide |
| D4 | bad item skipped, reply invalid only when the top-level shape is wrong; confidence clamped, default 0.5; project facts without a project skipped | whole reply invalid on one bad item; store project facts as global | how many facts survive a sloppy 3B reply; global pollution |
| D5 | odd inputs listed stay valid | — | — |
| D6 | no file writes, no text in logs, no double reinforcement, never a fact from assistant text | — | privacy; prompt injection from READMEs and tool output |
| D7 | ownership split (worker main, T4.3, T2.x, T2.3) | do more here | see A2, A4, A7 |
| D9 | `@ctc/core/sanitize`, `@ctc/core/memory` (pure, ports injected), `@ctc/shared/models`, `apps/worker/src/memory` | clients inside the worker | reuse by T3.3/T4.3/T5.1 |
| D10 | sanitize order, `ctc: ` line rule, surrogate-safe cut, no trim, unclosed tag → to the end | keep text after an unclosed tag | privacy wins; see A4 |
| D11 | user turn rules, Claude Code harness tags removed, `<command-args>` kept, `[Request interrupted` dropped, newest-window, `Tool:` lines in the summary input, runner sessions by `/.ctc/wt/` in any `cwd` | include assistant text for facts; no tool lines | injection safety; summary quality ("investigated"); A1 |
| D12 | judge = second llama call in the mid band only; judge failure → ADD; rewrite conflict/null → ADD; supersede null → ADD | see A3 | which rows get hidden |
| D13 | path check order; retry = fresh request with the reason, temperature 0.2 (first call 0); rotate only after a write, per project; rotate errors ignored | resend the bad reply; temperature 0 twice | at temperature 0 the same prompt gives the same bad reply |
| D14 | the `sessions` row is the truth for project and path; a stored summary skips the model call | trust `payload.projectId` | A6; spool payloads are untrusted |
| D15 | TEI `/embed` with `normalize`/`truncate` true, no instruction prefix; OpenAI-style chat with `response_format.json_schema`; error codes `unavailable`/`bad_response`/`timeout`; no retry in the client | llama `/completion` with `grammar` | A5; retries are the handler's job |
| D16 | gate fixtures: fake hash-seeded embedder, vectors with exact cosine `s`, pairs ≥ 0.002 from the band edges; summary twice → `skipped: 'exists'` | the real TEI + llama in the gate | real models make the gate flaky and touch shared services |

## C. Places where two reasonable readers would differ
1. "Read the user's own words **since the last extract**" (spec:519): a stored cursor vs. re-reading a window (A1).
2. "0.85–0.95, **same meaning**" vs "**contradicts**" (spec:484-485): who judges, and what a failed judgment means (A3).
3. "An invalid reply" (spec:520): the whole reply, or one item in it (D4 says: the top-level shape only).
4. "Retried once **with a fresh prompt**" (spec:520): a new request with the same text (useless at temperature 0), or a request that states the reason (D13 picks the second).
5. "`jobs.error = bad_reply`" vs the T1.4 `dropped:` prefix (A10).
6. "Insert `ON CONFLICT (content_hash) DO NOTHING`" (spec:523): which content is hashed, the session input or the model reply (D3 picks the input).
7. "The whole session" for summaries (spec:523, spec:744): user and assistant text only, or tool calls too (D11 adds one `Tool:` line per call, never tool results).
8. "Sanitize … ctc's own injected lines" (spec:215): which lines are ctc's (D10: lines starting `ctc: `; A4).
9. Whether a NOOP should also refresh `confidence` or `source` (D12: no, only `reinforcement_dates`).
10. Whether `memory.idempotent` counts the first extraction's reinforcement: D16 expects `reinforcement_dates = [today]` after run 2 and unchanged after run 3 (the first insert leaves it empty).
