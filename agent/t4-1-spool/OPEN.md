# T4.1 planner notes: what the owner reviews in the final PR (O11, O12)

Drafted: `agent/t4-1-spool/` (16 decisions D0-D15, 23 YOUR-CHOICE lines, 16 checks). No FROM-OWNER line was needed beyond O11 (silence rule) and O12 (never touch `~/.claudethecaller` of the live install: every test and check uses a `mkdtemp` spool dir and `HOME=<tmp>`).
Status: `node --import tsx agent/t4-1-spool/checks.mjs` and `python3 agent/t4-1-spool/selfcheck.py [--fast]` run and FAIL cleanly (module not built: `hooks/spool`, `apps/web/src/spool/index.ts`, `packages/shared/src/spool/index.ts` missing). The checks have never run against an implementation: expect a few planner mistakes; triage after the first coder run (fix the check only when the decision says otherwise).

## A. Cross-task points (ordered by blast radius)
1. **Nobody owns the ctc-web bootstrap yet.** `apps/web` has no Fastify and no `main`. T4.1 exports `createSpoolDrain` + a Fastify-shaped `nudgeRoute` and adds no dependency (D7, D9), so the first task that builds the Fastify app (T2.4, T3.2 or T5.1) must also call `start()` at boot, mount the route, `close()` at shutdown, and pass `config.spool.dir`/`keep_days`. If none does, the spool is never drained on the real stack. Alternative: T4.1 adds `fastify@5` and a minimal `apps/web/src/app.ts` now (lockfile change; merge conflicts with the parallel T2.x/T3.x runs).
2. **Two sources for the spool dir.** The script reads env `CTC_SPOOL_DIR` (default `~/.claudethecaller/spool`); the drain reads `config.spool.dir`. A YAML change without the env var splits them. T7.1 must set `CTC_SPOOL_DIR` in the hook command when `spool.dir` is not the default. Dev runs (`CTC_HOME=$PWD/.ctc-dev` convention) must set `CTC_SPOOL_DIR=$PWD/.ctc-dev/spool`; `CTC_HOME` is not read by anything in the TS stack.
3. **Nudge port default 18310 = the live Python daemon's port** (config `port` default). A nudge to it during the build is a harmless 404, but T7.1 should keep `CTC_PORT`/`CTC_NUDGE_URL` consistent with the web's bind.
4. **graph.rebuild debounce** (spec:290 "debounced 3 s per project") is left to T2.2: the drain makes one `graph.rebuild` per edit event (D7). T2.2's planner must know it receives bursts.
5. **T7.1 hook wiring**: give PostToolUse a `matcher: "Edit|Write|MultiEdit"` so Read/Bash/Grep events do not create spool files only to be dropped; pass the event name as `$1`.
6. **Runner / doc-extractor sessions** also fire Stop and SessionEnd (they inherit the user's hooks). The drain makes `llm.extract` jobs for them (D7 non-goal). T4.2 or T6.2 must filter them (Python did this in the hook route), or memory fills with agent chatter.
7. **Shared mode** is not supported by the spool (a remote web cannot read the client's directory). Spec §1.3 routes these hooks only through the spool; shared mode needs an HTTP fallback the spec does not describe.

## B. YOUR-CHOICE items (D-id: default | alternative | why it matters)
| D | Default | Alternative | Why it matters |
|---|---|---|---|
| D2 | keep_days counted from file mtime, exactly 7 days still kept | `received_at` in the body; inclusive | a corrupt body has no `received_at`; boundary tests |
| D2 | field caps event 32, session 256, tool 128, paths 4096 | no caps | bounds what reaches job payloads |
| D2 | the script has no size cap; the drain moves > 1 MB to `corrupt/` | script drops/truncates big stdin | a `Write` of a > 1 MB file is lost from the graph (see C3) |
| D3 | file-name sanitizing (`[A-Za-z0-9_-]`, 64, `nosession`), `.json.tmp`, `date +%N` fallback | reject odd ids | path traversal via `session_id` |
| D3 | `received_at` second precision UTC `Z` | ms precision | `z.iso.datetime()` accepts both |
| D3 | `CTC_SPOOL_DIR` env, dirs 0700, corrupt name collision → `.<ms>` suffix | config read by the script; overwrite | A2; privacy of payloads |
| D3 | `CTC_NUDGE_URL` env override, default `127.0.0.1:${CTC_PORT:-18310}` | unix socket `ctc.sock` | A3 |
| D3 | nudge reply `204` | `202` | none for the script (it never reads the reply) |
| D3 | job id `spool:<basename>`, one job per file | content hash; one job per session | this is the whole "processed once" guarantee |
| D3 | `DrainReport` with 5 counters | void | tests and a future health line |
| D4 | field-level rule: required field wrong → corrupt; optional wrong → absent; envelope loose | strict envelope; everything corrupt | how many events are lost to `corrupt/` |
| D5 | empty stdin → no file, no nudge | file with `payload: null` | noise |
| D6 | script stdout/stderr always silent; drain skips non-regular files; logs never carry payload text | — | a Stop hook's stdout JSON is a decision; FIFO hang; privacy |
| D7 | ownership split (bootstrap, debounce, runner filter, `ctc hook spool`, corrupt pruning) | T4.1 does some of them | A1, A4, A6; `corrupt/` grows forever |
| D9 | schema in `packages/shared/src/spool` (own folder) | `packages/shared/src/schemas/spool.ts`; add `zod` to `apps/web` | avoids lockfile + `schemas/index.ts` conflicts with parallel tasks |
| D9 | narrow structural `repos` port + Fastify-shaped route object | take full `Repositories`; real Fastify plugin | testability without Fastify |
| D10 | argv event first, payload `hook_event_name` second, else `unknown` | payload first | a nested `"hook_event_name"` inside `tool_input` could win a sed match |
| D10 | ≤ 500 ms script budget for 10 KB | none | hook latency in every session |
| D11 | strip exactly 3 tags; unclosed tag cuts to end (file then corrupt) | keep the text after an unclosed tag; drop the event | privacy vs losing one event |
| D12 | project upserted from `cwd` (creates it) | only existing projects (`byRoot`) | stray `/tmp` cwds become projects |
| D12 | lexical `..` check, no `realpath` | resolve symlinks | a symlinked dir inside the repo pointing out of it |
| D12 | sessions.upsert `RepoError`/`ConflictError` logged and ignored; summarize still queued | file kept | a session id reused across projects never blocks the summary |
| D13 | stop delivering after the first failure in a pass; expire only undeliverable files | try every file; expire by age before delivery | Redis-down pass time; data kept as long as deliverable |
| D13 | old `.tmp` deleted after keep_days | delete after 1 h | private leftovers of killed scripts |
| D14 | coalesced passes, `drainOnce` waits for a fresh pass, nudge ignored before `start`/after `close` | queue every trigger | load under bursts |
| D15 | gate adds "re-placed copy = no new row" and "nudge within 2 s" | spec wording only | stricter than the spec line |

## C. Places two reasonable readers would differ
1. **"strips harness tags"** (spec:503): which tags. Here = the `<system-reminder>`, `<persisted-output>` of spec:215 plus `<private>`; ctc's own injected lines are left to T4.2's `sanitize`.
2. **"Delete the file after the BullMQ add"** when Redis is down but the Postgres row was written: delete (the row is the truth, the poller runs it) or keep (spec:196 "spool files wait"). Default keep; the job id makes the later re-add harmless.
3. **> 1 MB events** (spec:213): corrupt per the spec, but that drops every PostToolUse `Write` of a large file and every Stop with a huge payload. An alternative is to let the script cut `tool_response`/`content` fields, which sh cannot do safely.
4. **"kept 7 days"**: age from mtime vs `received_at` vs file-name `epoch_ns`; and whether a deliverable 8-day-old file is delivered (here: yes).
5. **Corrupt vs dropped**: a `Stop` without `session_id` is corrupt here; another reader would drop it as "not routable".
6. **SessionEnd `startedAt`**: a session first seen at SessionEnd gets `started_at = now()` (repo default); T4.3/history import may own the real start time.
7. **`ctc hook spool`** (spec:90 code map): read as a later CLI helper, not the hook command; another reader would build it here as a Node fallback of the script.
