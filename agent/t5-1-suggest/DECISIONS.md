# Decisions for T5.1: `/v1/hook/prompt` and `/v1/suggest` (three seed channels, walk, rank, render, `sug:` cache)

Tags: FROM-OWNER (O#, agent/OWNER.md), FROM-SPEC (specs/007-ctc/spec.md line), FROM-CALLERS (file:line), YOUR-CHOICE (owner reviews every one, O11).
"spec" = `specs/007-ctc/spec.md`. "push" = `packages/core/src/graph/push` (`@ctc/core/graph/push`, pure). "web" = `apps/web/src/suggest`.
"store" = the T2.4 RAM graph store (`createGraphStore`, apps/web/src/graph/store.ts:25). "channel" = the T3.3 skill channel (`createSkillChannel`,
apps/web/src/skills/index.ts:51). "query" = `@ctc/core/graph/query` (T2.4). "config" = the T1.1 `Config` (packages/shared/src/env/schema.ts), read at call
time. A tag at the end of a block of indented lines covers the whole block above it. Nothing here is copied from the Python hook; it is drafted from
the spec, the merged TypeScript callers and the T0.1/T0.2 baselines.

D0  Purpose and callers. Given a user prompt and the working directory, answer with ONE line that names the task, the file and symbol, the skill and the
    decision that apply (`ctc: T4.1 spool drain → apps/web/src/spool:drain · skill: tdd · decision: D3`), or with nothing. Two routes share one pipeline:
    (a) `POST /v1/hook/prompt` (Claude Code UserPromptSubmit, curl `-m 0.15`): `200` + the line as `text/plain`, or `204` empty; never an error;
    (b) `POST /v1/suggest {prompt, cwd}` (debug and offline evals, `evaluation/`): `200` JSON with the seeds, candidates, line and timings.
    Callers: the ctc-web bootstrap (built later) mounts `suggestRoutes(deps)` and passes the store and the channel it already built (T2.4 `onInval`, T3.3
    `onInval` stay wired there); T7.1 points `.claude/settings.json` at `/v1/hook/prompt`. T5.2 (`/v1/hook/pre`) will add `note`/`hint` to the same `push`
    directory later and must not need this task's files edited. The gates `suggest.latency` and `suggest.context` (D21, D22) measure it.
    FROM-SPEC (spec:105 hook, spec:109 suggest, spec:299-312 hot path, spec:367-368 gates, spec:787 T5.1) FROM-CALLERS (apps/web/src/memory/hook.ts:63-88 is the route pattern
    this task copies: plain `Route` objects, `reply.code(n).send(x)`, handler never throws).

D1  Trust. Untrusted: the whole request body (`prompt`, `cwd`, extra keys), every label, path, location and id read from the RAM graph, every skill name from
    the channel, every TEI reply, every cached value. Trusted: `ctx` from `deps.ctxOf(req)` (default `{userId: 'local'}`, spec:138), `deps.config`.
    Rules: the project, the graph and the skills are the ones of `ctx.userId` only (`projectOf` and the store take `ctx`; cache keys carry the user);
    every piece of text that enters the line passes `sanitize` (`@ctc/core/sanitize`), whitespace runs collapse to one space, trimmed, cut to 256 code points
    (D20); the finished line is NEVER passed through `sanitize` (it starts with `ctc: ` and would erase itself, sanitize.ts:12); a cached value is shape-checked
    before use (a bad one is a miss); the prompt is never logged, never an error message, never a cache key in clear (sha1 only, keys.ts:21).
    Prevents: prompt injection through a label (`<system-reminder>`, a newline plus `ctc: …`), one user's graph in another's line, stale poisoned cache.
    FROM-SPEC (spec:138-140, spec:215 sanitize) FROM-CALLERS (packages/core/src/sanitize/index.ts:12 `CTC_LINE`). The 256-point cut and the cache shape check: YOUR-CHOICE.

D2  Limits. Exported, mutable object read at call time (a test may change a field and restore it): web `suggestLimits = { hookBudgetMs: 140, embedDeadlineMs: 100,
    promptChars: 20000, lexicalChars: 500 }`:
      `hookBudgetMs`: the hook replies after at most 140 ms (D18); `promptChars`: the prompt is cut to its first 20,000 UTF-16 code units before anything else
      (exactly 20,000 is unchanged; a longer one is cut, never refused);
      `lexicalChars`: the lexical channel reads only the first 500 code units of the prompt (`queryLimits.queryMax`), because `lexicalSeeds` scans the whole
      label vocabulary once per query token and has no cut of its own (search.ts:21);
      `embedDeadlineMs`: the hook gives the TEI call 100 ms, then goes on without vectors (D17); `/v1/suggest` has no such deadline (TEI's own `timeout_s` applies).
    From config (not constants): `graph.query.seeds` (3), `graph.query.depth` (2), `graph.query.hub_min` (50, already inside the store's index), `graph_push.floor`
    (0.3, a seed must reach it: inclusive, `>=`), `graph_push.max_pointers` (3, candidates kept per slot), `graph_push.max_chars` (400, counted in code
    points, inclusive: 400 is valid, 401 is cut), `embed.instruction`, `embedding_dim`. From `query`: `queryLimits.denseSeeds` (10). The `sug:` TTL is `ttl.sug` (3600).
    FROM-SPEC (spec:299 140 ms, spec:213 and spec:310 20,000 and 400 chars, spec:305-306 3 seeds and 10 dense, spec:346 floor and max_chars) FROM-CALLERS
    (packages/core/src/graph/query/model.ts:14-41 `queryLimits`; packages/shared/src/cache/limits.ts:21 `ttl.sug`). `embedDeadlineMs` 100 and `lexicalChars` 500:
    YOUR-CHOICE (chosen by judgment: 40 ms are left for walk, rank and render).

D3  Output and error format.
    Hook: `200` with `string` body = the line (one line, starts with `ctc: `, no trailing newline, at most `max_chars` code points); `204` with no body for
    "nothing to say", a bad body, an over-budget answer or any failure.
    Suggest `200` JSON, exactly these keys:
      `{ line: string, cached: boolean, degraded: ('store'|'embed'|'rerank')[], seeds: { lexical: Seed[], embedding: Seed[], skill: SkillSeed[] },
         candidates: { task: Cand[], file: Cand[], skill: Cand[], decision: Cand[] },
         ms: { project, cache, embed, seeds, walk, rank, render, total } }`
      `Seed = { id, label, type, score }`, `SkillSeed = { kind, name, score }`, `Cand = { id, label, type, file: string|null, line: number|null, score, hop }`;
      scores rounded to 4 decimals, every `ms` value finite, ≥ 0, rounded to 0.1, all keys present on every reply (0 for a stage that did not run);
      `degraded` has each entry at most once, in the order store, embed, rerank.
    Suggest errors use the `{error:{code,message,...}}` body of spec:148: `invalid` 422 (with `path`, e.g. `['body','prompt']`), `model_unavailable` 503 when
    `degraded` contains `embed` (spec:160; message `embedding service unavailable`), `internal` 500 never (the handler catches everything: D6).
    FROM-SPEC (spec:109 "JSON with seeds, candidates, line, timings", spec:105, spec:148-165, spec:164 hooks never error) FROM-CALLERS (apps/web/src/library/http.ts:39-72
    `ApiError`, `errorBody`; D23 adds `model_unavailable`). Key names, rounding and the `ms` stage names: YOUR-CHOICE.

D4  Bad input (first problem wins, no error lists).
    Hook: body not an object, `prompt` not a string, `cwd` missing, not a string, longer than 4,096, or not an absolute POSIX path → `204`.
    Suggest: the same checks give `422 invalid` with `path` `['body','prompt']` or `['body','cwd']`. A blank prompt (empty or whitespace only after the D2 cut) is valid
    on both routes and answers an empty line (`''`) with no model call and no cache write. `ctx` without a string `userId` → treated as `{userId:'local'}`
    (judgment: the bootstrap owns auth, D7).
    FROM-SPEC (spec:164 hooks never error, spec:146 one Zod schema per route, spec:152 `invalid` 422) FROM-CALLERS (apps/web/src/memory/hook.ts:18-19 same cwd rule). The schema lives in
    `@ctc/shared/schemas/suggest` as `SuggestBody = z.looseObject({ prompt: string, cwd: string.min(1).max(4096) })` and `suggestApiLimits = { cwdMax: 4096 }`
    (4,096 = Linux PATH_MAX as in the memory schema). Messages and the rule "blank is valid": YOUR-CHOICE.

D5  Odd but harmless input stays valid: extra body keys (`session_id`, `transcript_path`, `hook_event_name`, `permission_mode`) are ignored; `cwd` with trailing
    slashes (`/p//` is project root `/p`, `rootOf` of memory/common.ts:40); emoji, NUL, RTL and 20,000-character prompts; a prompt that itself contains `ctc: `
    lines or `<private>` blocks (they only feed the embedder and the tokenizer, never the line); a cwd that is not a known project (D11); a project whose graph is
    empty (the line then comes from skill seeds only, or is empty); an empty skill library; two identical prompts in a row.
    judgment: tolerant by default (D8). YOUR-CHOICE.

D6  Must never:
    (a) throw or reject from a route handler or from `run` (every failure is `204` on the hook; on suggest only `422` for D4 and `503` for D17);
    (b) edit its arguments (`body`, `deps`, `config`, the RAM index, the channel's hit objects: inputs may be deep-frozen);
    (c) log or return the prompt, a cwd, a label, a skill name or a vector; `deps.log` gets class names and counts only;
    (d) write to Postgres, or to the cache other than the D16 `sug:` key and the `proj:` entry that `projectOf` stores; call any repository function other than `projects.byRoot` (through `projectOf`);
        call the reranker (`deps.tei` has no `rerank` here); start a model call for a blank prompt or on a `sug:` hit;
    (e) answer from another user's cache key, project or graph;
    (f) emit more than one line, a line longer than `max_chars` code points, or a line not starting with `ctc: `;
    (g) run `sanitize` over the finished line (D1);
    (h) cache a degraded answer (D16); cache under an unknown epoch;
    (i) make the hook wait past `hookBudgetMs` (D18) or hang (TEI has `timeout_s`, the embed deadline D2, no other wait without a bound);
    (j) walk past `graph.query.depth`, expand a hub node (degree ≥ the index's `hubCut`) or follow a `DROPPED` edge (the index already drops them);
    (k) write sessions, decisions, events or follow tracking (removed from the product, spec:35).
    FROM-SPEC (spec:164, spec:215, spec:35, spec:309, spec:299) for (a) (d) (f) (i) (j) (k); the rest YOUR-CHOICE.

D7  Non-goals (which code does that instead): Fastify, auth, rate limit, body size limit, the `ctc:inval` subscription and the 60 s epoch poll (the ctc-web bootstrap);
    building or embedding the graph (T2.x worker); the skill matrix, rerank, pins and `block` overrides (T3.3 channel); `/v1/hook/pre`, the file note, hints and their
    caps (T5.2); memories in the line (spec:312 "F3 injects them at session start"); the abstain gate and false-trigger tuning; single-flight of identical in-flight
    prompts; the `graph_search` text output (T2.4); the dashboard; the settings.json switch (T7.1). A `suggest` result is never written to Postgres.
    FROM-SPEC (spec:86-98, spec:312, spec:316-319, spec:793). The exact split: YOUR-CHOICE.

D8  Silence rule. Where this list says nothing, choose the more tolerant, less destructive behaviour (empty reply over an error, skip a cache over trusting it, drop
    the optional piece over cutting a piece in half) and put a comment starting `judgment:` on that line. FROM-SPEC (ORCHESTRATOR §3 D8).

D9  Public names and wiring.
    `@ctc/core/graph/push` (pure, no I/O; `packages/core/src/graph/push/index.ts`, new directory; do NOT edit `packages/core/src/graph/index.ts`):
      `SEED_TYPES: readonly string[]`, `slotOf(node: {kind: string; type: string}): 'task'|'file'|'skill'|'decision'|null`,
      `rankSlots(index: GraphIndex, o: { seeds: Seed[]; skills: SkillSeed[]; depth: number; perSlot: number }): Slots`,
      `renderLine(slots: Slots, o: { maxChars: number }): string`, types `SkillSeed`, `Cand`, `Slots`.
    `@ctc/shared/schemas/suggest` (`packages/shared/src/schemas/suggest/index.ts`): `SuggestBody`, `suggestApiLimits`.
    `apps/web/src/suggest/index.ts`: `createSuggest(deps: SuggestDeps): Suggest`, `suggestRoutes(deps: SuggestDeps): Route[]` (exactly two routes, in this order:
      `POST /v1/hook/prompt`, `POST /v1/suggest`), `suggestLimits`, types `Suggest`, `SuggestDeps`, `SuggestResult`.
      `Suggest = { run(ctx: Ctx, input: { prompt: unknown; cwd: unknown }, opts?: { signal?: AbortSignal; embedDeadlineMs?: number }): Promise<SuggestResult> }`
      (`SuggestResult` is the D3 body); `run` resolves, never rejects; blank prompt or bad `cwd` gives the empty result.
      `SuggestDeps = { repos: Pick<Repositories,'projects'>; tei: Pick<Tei,'embed'>; config: Pick<Config,'embed'|'embedding_dim'|'graph'|'graph_push'>;
        graph: Pick<GraphStore,'get'>; skills: Pick<SkillChannel,'search'>; cache?: { get<T>(k): Promise<T|undefined>; set(k, v, ttlSeconds): Promise<void>;
        epoch: { get(kind: 'graph', userId, projectId): Promise<string|null> } }; ctxOf?(req: unknown): Ctx; log?(message, fields?): void; now?(): number }`.
    Reuse, do not copy: `lexicalSeeds`, `denseSeeds`, `walkFrom`, `nodeRef`, `queryLimits` from query; `queryText` from `@ctc/core/skills`; `keys`, `ttl` from
    `@ctc/shared/cache`; `projectOf`, `rootOf`, `isAbs` from `apps/web/src/memory/common.ts` (D23); `Route`, `ApiError`, `errorBody`, `statusOf`, `toApiError` from
    `apps/web/src/library/http.ts`. Names and the file split: YOUR-CHOICE. Entry paths and the "pure core / apps wire it" split: FROM-SPEC (spec:94, spec:99).

D10 Order of work (observable through the fakes in the tests):
    1 parse the body (D4) → 2 resolve the project (D11) → 3 read the graph epoch, then `cache.get` the `sug:` key (D16); a hit replies at once with `cached: true` and calls
    no model, no store, no channel → 4 seeds (D12): lexical (sync), the prompt vector via `deps.tei.embed` and the dense seeds, the channel's `search`; the channel call and the
    embed run concurrently, and a failed leg does not stop the others (D17) → 5 walk (D13) → 6 rank into slots (D14) → 7 render (D15) → 8 start `cache.set` (D16) without
    waiting for it, then reply. Step 4's `deps.tei.embed` is called with exactly `[queryText(prompt, config.embed.instruction)]` (one text, the same string the channel embeds, so
    the shared `emb:` cache serves the second call); at most two `embed` calls per cold prompt and none on a `sug:` hit.
    FROM-SPEC (spec:300-311) FROM-CALLERS (apps/web/src/skills/index.ts:171 the channel embeds `queryText(cut, config.embed.instruction)`; packages/shared/src/tei/index.ts:80-97 `emb:` cache).
    Concurrency of step 4 and "send the same text": YOUR-CHOICE (spec step 3 says "embed the prompt" once; here the second embed is a cache hit when a cache is injected).

D11 Project resolution. `root = rootOf(cwd)`, `project = projectOf({repos, cache}, ctx, root)` (the `proj:` cache first, then `repos.projects.byRoot`; a found project is cached 24 h,
    a miss is not). No project (unknown cwd, or the lookup fails): there is no graph and no `sug:` key; the answer comes from the skill seeds alone (`ctx` without `projectId`), with
    `cached: false`. A `projects.byRoot` rejection is treated as "no project" and logged by class name.
    FROM-SPEC (spec:301 "resolve the project from cwd (proj: cache)") FROM-CALLERS (apps/web/src/memory/common.ts:46-63). Skill-only answer for an unknown project: YOUR-CHOICE
    (alternative: empty reply).

D12 Seeds, three channels (types and numbers):
    `SEED_TYPES` = `spec, requirement, task, decision, page, heading, file, module, class, function, method, interface, type, variable` (context and code nodes; not `package`,
    not capability nodes, not `workflow_step`);
    lexical: `lexicalSeeds(index, prompt.slice(0, lexicalChars), { types: SEED_TYPES, max: graph.query.seeds })`; scores are the query module's (best = 1);
    embedding: `denseSeeds(index, vector, { types: SEED_TYPES, floor: graph_push.floor, max: queryLimits.denseSeeds })`; the vector is the prefixed query text of D10;
    skill: `skills.search(ctx, prompt, { signal })` hits with `cosine >= graph_push.floor`, seed score = the hit's `cosine`, at most `config.k` hits (the channel's own k);
    a skill whose node `${kind}:${name}` is in the index also joins the walk as a seed; one that is not stays a standalone candidate (D14).
    A node that is a seed in several channels keeps its highest score. A seed below the floor is not a seed; no seed at all → empty line (spec:310 "Nothing above the floor").
    FROM-SPEC (spec:305-307, spec:310, spec:346) FROM-CALLERS (packages/core/src/graph/query/search.ts:21,54 signatures; apps/web/src/skills/index.ts:33 `search`, skills/index.ts:228 `cosine`
    on `SkillHit`; agent/t3-3-skill-channel/DECISIONS.md D15 "T5.1 owns the floor"). The type list and applying the floor to the lexical channel as "always passes" (its best score is 1):
    YOUR-CHOICE.

D13 Walk and score. `walkFrom(index, [...lexical, ...embedding, ...skillNodeSeeds], { depth: graph.query.depth })` over the RAM index: both edge directions, seeds always expanded,
    a non-seed node at or above `index.hubCut` is reported but not expanded, a node's score = seed score × 0.5^hop × the confidence weight of the edges on its best path
    (`CONFIRMED`/`EXTRACTED` 1.0, `INFERRED` 0.6, `AMBIGUOUS` 0.3, `DROPPED` 0), which is what `walkFrom` already computes: this task reuses it and does not reimplement it. `depth` outside
    0..3 is the query module's `invalid`; the hook never sees it (config Zod keeps depth ≥ 1; the pipeline clamps to 1..3 and uses 2 on anything else).
    FROM-SPEC (spec:266, spec:308-309) FROM-CALLERS (packages/core/src/graph/query/search.ts:114 `walkFrom`; model.ts:70-74 weights).

D14 Slots and candidates. `slotOf` maps a node to exactly one slot or none: `task` ← type `task`; `decision` ← type `decision`; `file` ← kind `code` and type in `file, module, class,
    function, method, interface, type, variable`; `skill` ← kind `capability` and type in `skill, agent, command, workflow`; everything else (spec, requirement, page, heading, package,
    workflow_step) is walked through but never shown. Per slot, candidates are the reached nodes of that slot ordered by score desc, hop asc, symbol before file (for the `file`
    slot), id ascending (code-unit order); `file` candidates are distinct by `file` path (the best node of each path); a standalone skill (D12) is a `skill` candidate with
    `id = ${kind}:${name}`, `hop 0`, `file`/`line` null. Each list keeps at most `graph_push.max_pointers` entries. The line uses the first candidate of each slot. A candidate
    is a plain `Cand` (D3) built with `nodeRef` cleaning (D20).
    FROM-SPEC (spec:310 "at most one each of task, file:symbol, skill and decision") FROM-CALLERS (packages/core/src/graph/query/model.ts:93 `nodeRef`; packages/core/src/context/parse.ts:56
    task/decision types; packages/core/src/context/capability.ts:82 capability types). `max_pointers` as the candidate count and the tie order: YOUR-CHOICE (the m6 line carried up to
    3 code pointers, config/retrieval.yaml `graph_push.max_pointers`; the spec line carries one, so the other two travel in `candidates` for evals).

D15 Render. `ctc: ` + pieces joined by ` · `, where the pieces are, in order, `head`, `<kind>: <name>` (the skill; `kind` is `skill`, `agent`, `command` or `workflow`), `decision: <local id>`;
    `head` = `<task text>` and/or `→ <pointer>` joined by one space; `task text` = `<local id> <label>` (`local id` = the text after the last `:` of the node id; when the cleaned label already
    starts with it, the label alone); `pointer` = `<file>:<symbol>` (`symbol` = label without one trailing `()` and one leading `.`) or just `<file>` for a `file` node. A missing slot drops its
    piece; no piece at all → `''`. Example: `ctc: T9.1 Build the widget runner → src/widget.ts:runWidget · skill: tdd · decision: D3`.
    Cut to `max_chars` code points by this ladder, never in the middle of a piece unless the last rung says so: 1 drop the decision, 2 drop the skill, 3 shorten the task label with a final `…`
    (keep the local id and at least one label character; if that cannot fit, drop the task text), 4 cut the pointer with a final `…`. `max_chars` below 8 → `''`.
    The line has no newline, no tab, no run of spaces (D20). Spec's `<task id> <task title> → <path>:<symbol> · skill: <name> · decision: <id>` is this with the optional parts dropped when missing.
    FROM-SPEC (spec:310 format and cut, spec:805 D5) FROM-CALLERS (packages/core/src/context/parse.ts:78 labels keep the title only, so the local id comes from the node id). The ladder (which piece
    goes first) and the `·` joining when pieces are missing: YOUR-CHOICE (ORCHESTRATOR lesson: a cut must not split a piece's structure).

D16 `sug:` cache (spec:171-182). Key `keys.sug(ctx.userId, project.id, prompt, epoch)` (`keys.ts:21`: the sha1 is over the prompt after the D2 cut), `epoch = cache.epoch.get('graph', userId, projectId)`;
    value = `{ line, seeds, candidates }` (the D3 fields without `cached`, `degraded`, `ms`), TTL `ttl.sug`. A hit is used only if it has those three keys with the right shapes (D1), returns
    `cached: true`, `degraded: []`. Written for every answer that is not degraded, including the empty line. NOT written, and not read: no cache dependency, no project, epoch `null` (Redis down),
    a blank prompt, a degraded answer (any entry in `degraded`). A rotated epoch is a miss. The write is started before the reply and never awaited by it; a failing `get` is a miss, a failing
    `set` is ignored (both logged by class name). Over-budget hook work still writes its answer when it finishes (D18).
    FROM-SPEC (spec:171-182, spec:302, spec:312) FROM-CALLERS (packages/shared/src/cache/keys.ts:21; apps/web/src/memory/hook.ts:29-60 same epoch-then-get pattern). "Do not cache degraded", the shape check
    and the not-awaited write: YOUR-CHOICE.

D17 Degradation (spec:206-208 "TEI down: lexical seeds only; `/v1/suggest` 503").
    TEI embed fails or passes the deadline → no embedding seeds, `degraded` gets `embed`, the skill channel (which embeds too) usually reports `embed` as well; lexical seeds and the walk still run.
    The store rejects (no RAM graph and Postgres down) → no graph seeds, `degraded` gets `store`, the answer is skill-only. The channel rejects or reports `store` → no skill seeds, `store`.
    A channel `rerank` degradation is passed through. A bad embed reply (wrong length, non-finite) counts as a failure. On the hook every degraded answer still replies with whatever line it has
    (200) or `204`; on `/v1/suggest` `embed` in `degraded` → `503 model_unavailable` (the body of D3), otherwise `200`.
    FROM-SPEC (spec:206, spec:160) FROM-CALLERS (apps/web/src/skills/index.ts:17 `Degraded`, :136 `done`). Passing `rerank` through and counting a deadline as `embed`: YOUR-CHOICE.

D18 Hook budget. The `/v1/hook/prompt` handler starts `run` with `{ embedDeadlineMs: suggestLimits.embedDeadlineMs }` and waits for it at most `suggestLimits.hookBudgetMs`. If the timer wins: `204`
    now; the work keeps running and still writes `sug:` (D16) for the next identical prompt. The timer is cleared when the work wins. No `AbortSignal` is passed to the late work. A reply produced in time:
    `200` + line, or `204` when the line is `''`.
    FROM-SPEC (spec:312 "Over budget: reply empty now, finish in the background and store the line in `sug:`", spec:299) FROM-CALLERS (apps/web/src/memory/hook.ts:68-86 same race and cleanup).

D19 Timings. `ms.total` is the wall time of `run` from body parse to reply (the not-awaited cache write excluded); `project`, `cache`, `embed`, `seeds`, `walk`, `rank`, `render` are the stage wall times
    (`embed` is the `tei.embed` call, `seeds` is lexical + dense + the channel's `search` wall time); finite, ≥ 0, rounded to 0.1; a stage that did not run is 0; `now?()` is only for cache expiry in tests,
    timings use `performance.now()`. FROM-SPEC (spec:109 "timings") FROM-CALLERS (apps/web/src/skills/index.ts:128-134 same rounding). Stage names: YOUR-CHOICE.

D20 Text safety. Every label, path, symbol, local id, skill name and kind put into a candidate or the line is `sanitize`d (blocks, control characters, `ctc: ` lines), then `\s+` → one space, trimmed, cut to
    256 code points; an item that is empty after that is skipped (a candidate with an empty label gets its local id or file as label; a skill with an empty name is skipped). `nodeRef` of the query module already
    does this for nodes; skill names get the same treatment here. FROM-SPEC (spec:215) FROM-CALLERS (packages/core/src/graph/query/model.ts:81-92 `clean`, :93 `nodeRef`). The 256-point cut for skill names: YOUR-CHOICE.

D21 Gate `suggest.latency` (spec:367, the spec's `latency.md` does not exist in this checkout, so the method is defined here). Test file `apps/web/src/suggest/suggest.latency.int.test.ts` with
    `describe('suggest.latency')` and exactly two tests: `'cold p95 of /v1/suggest over 100 SkillRet prompts is at most 150 ms'` and `'L1 hit p95 of /v1/suggest over the same prompts is at most 10 ms'`.
    It runs only when `CTC_GATE_SUGGEST=1` (skipped otherwise, so `pnpm -r test` stays quick and quiet); with the switch set, a missing prerequisite FAILS the test.
    Setup (outside the timing): scratch schema `ctc_t51_<random>` (dropped in `afterAll`); the graph = the `ctc` snapshot of D22 built by the real T2.x pipeline with the real TEI embedder; the skill library
    = the 6,006 SkillRet test skills (`.ctc-dev/eval/skillret-test.json`, written by `selfcheck.py --export`) inserted as T3.3's gate does and embedded through the same on-disk vector cache
    (`.ctc-dev/eval/vec-cache/`); real `createTei` with a real `createCache` on the scratch Redis (`CTC_SCRATCH_REDIS_URL`, `127.0.0.1:18395`, a private namespace); the store and the channel are warmed
    (`graph.get`, `skills.reload`) before timing, as the daemon has them in RAM. Measure: 100 SkillRet test queries (sorted by id, `Random(0)`-style seeded sample, blank and duplicate dropped), 3 warm-up
    prompts not in the 100; each pass calls `suggestRoutes(deps)[1].handler(...)` (in process, `/v1/suggest`) sequentially and times it with `performance.now()`; pass 1 = cold (fresh namespace, so `emb:` and
    `sug:` miss), pass 2 = the same 100 prompts (`sug:` served from L1). p95 = linear interpolation between order statistics (numpy default). Assertions: cold p95 ≤ 150 ms, hit p95 ≤ 10 ms, every reply
    `200`. Writes `.ctc-dev/eval/suggest.latency.json` = `{n, cold:{p50,p95,max}, hit:{p50,p95,max}, graph_nodes, skills, load_1m, recorded_at}`.
    FROM-SPEC (spec:367 "cold p95 ≤ 150 ms, L1 hit p95 ≤ 10 ms") FROM-CALLERS (agent/t3-3-skill-channel/DECISIONS.md D23 the skills gate pattern; agent/t0-2-baselines/DECISIONS.md D9 percentile).
    Everything else (graph and library sizes, in-process timing, 100 prompts, the strict switch, the file name): YOUR-CHOICE.

D22 Gate `suggest.context` (spec:368; the spec's `contextbench.md` / `mulocbench.md` do not exist in this checkout; today's m6 numbers are in PLAN.md "G7": test Recall@3 0.750 over tickets 09-16,
    dev 1.000, prompt_line p95 5.9 ms). Test file `apps/web/src/suggest/suggest.context.int.test.ts`, `describe('suggest.context')`, one test:
    `'n8n-parity test tickets 09-16: file recall@3 of the suggest candidates is at least the m6 number 0.750'`. Same strict switch as D21.
    Data: the snapshot = the tree of commit `a8ad531efdc4aebfd61d98f499ffe0a8dbaf68cb` (the last commit tagged `(n8n parity …)`, which still holds `.scratch/n8n-parity/issues/*.md`), extracted with `git archive`
    to `.ctc-dev/eval/ctx-snapshot-a8ad531/`; graph = real pipeline on that directory (`rebuildProject`, `contextPass`) with the real TEI embedder in a scratch schema; project root = the snapshot directory.
    Truth (as in `evaluation/graph_eval.py`, re-derived, not copied): for each ticket NN, the files changed by non-merge commits (any ref) whose subject ends with the literal `(n8n parity NN)`,
    restricted to files that are code nodes of that graph, minus paths under `tests/`, `specs/`, `.scratch/` and basenames starting `test_`; a ticket with no such file is dropped and listed.
    Prompt = the ticket title: first line `# NN — slug` of its issue file, dashes → spaces. Dev = tickets 01-08 (reported), test = 09-16 (asserted). Skills: an empty channel (the test measures files).
    Run each prompt through `createSuggest(...).run(ctx, {prompt, cwd: snapshotRoot})`, no cache. A ticket is a HIT when a truth file equals one of the first 3 distinct `candidates.file[].file`.
    Assert `hits / tickets >= 0.75` on test. Report (not asserted): dev recall, recall of the rendered line's own pointer (@1), the per-ticket table. Writes `.ctc-dev/eval/suggest.context.json` =
    `{snapshot, test: {tickets, hits, recall}, dev: {tickets, hits, recall}, line_at1: {test, dev}, per_ticket: [{id, split, truth, top3, hit}], graph_nodes, recorded_at}` (the self-check re-reads `test.recall`).
    FROM-SPEC (spec:368 "≥ today's m6 numbers") FROM-CALLERS (PLAN.md:851 test Recall@3 0.750 and dev/test split; evaluation/graph_eval.py:41-60,106-112 the truth and hit rules, read for the data shape only).
    The snapshot commit, "@3 over candidates" instead of "the one pointer of the line" (the m6 line had up to 3 pointers), the empty skill channel, false triggers not measured: YOUR-CHOICE.

D23 Edits outside the new directories (each additive, no behaviour change, existing tests stay green):
    `apps/web/src/library/http.ts`: `ErrorCode` and `STATUS` gain `model_unavailable` → 503 (nothing else);
    `apps/web/src/memory/common.ts`: `projectOf`'s first parameter type narrows to `{ repos: Pick<Repositories,'projects'>; cache?: { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown, ttlSeconds: number): Promise<void> } }`
    (the fields it reads; `MemoryApiDeps` still satisfies it, so `hook.ts`, `routes.ts`, `tools.ts` compile unchanged).
    No other existing file is edited: not the `index.ts` of `packages/core/src/graph`, of `apps/web/src/graph`, `skills`, `memory`, `library`; not the repositories; not the migrations; not `package.json` or the lockfile
    (`@ctc/core/graph/push` and `@ctc/shared/schemas/suggest` resolve through the existing `./*` export wildcards).
    FROM-CALLERS (apps/web/src/library/http.ts:39-47; apps/web/src/memory/common.ts:46; agent/t3-3-skill-channel/SPEC.md the same pattern for `overrideRows`). The narrowing instead of a cast or a copy: YOUR-CHOICE.
