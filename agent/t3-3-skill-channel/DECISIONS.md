# Decisions for T3.3: SKILLRET dense + rerank skill channel (query side), TEI client, RAM skill matrix, `suggest.skills` gate

Tags: FROM-OWNER (O#, agent/OWNER.md), FROM-SPEC (specs/007-ctc/spec.md line), FROM-CALLERS (file:line), YOUR-CHOICE (owner reviews every one, O11).
"spec" = `specs/007-ctc/spec.md`. "repos" = `createRepositories(db)` (packages/shared/src/repositories/index.ts, T1.3). "core" = `packages/core/src/skills`,
"tei" = `packages/shared/src/tei`, "web" = `apps/web/src/skills`. "config" = the T1.1 `Config` (packages/shared/src/env/schema.ts:76-101), read at
call time. A tag at the end of a block of indented lines covers the whole block above it.

D0  Purpose and callers. Given a user's prompt, return the user's capabilities that best match it, in the order of today's tuned search
    (`dense 50 + keyword 50 → RRF k = 60 → rerank top 20 → top 5`, config/retrieval.yaml), from a RAM matrix of the served versions' vectors
    that T3.1's `library.changed` job writes to `cap_vectors`. Callers:
    (a) T5.1 `/v1/hook/prompt` and `/v1/suggest` call `channel.search(ctx, prompt, { signal })` as the skill seed channel (spec:307) and render
        the top skill name in the prompt line (spec:310, D5 of spec §9); `/v1/suggest` answers `503 model_unavailable` when `degraded` has `embed`
        (spec:160, spec:206);
    (b) the ctc-web bootstrap (later task) builds one channel per process, calls `channel.reload(ctx)` once at start, and passes `channel.onInval`
        to `cache.subscribeInval` so a `library.changed` message reloads the user's matrix (spec:182);
    (c) the worker main (later task) may bind `createTei(...).embed` as the T3.1 `Embed` of `libraryHandlers` (apps/worker/src/library/handlers.ts:14,
        `(texts: string[]) => Promise<number[][]>`): the same client embeds documents (no prefix) and queries (prefix added by the channel);
    (d) the gate test `suggest.skills` (D23) and the Python offline evals later (spec:73) measure it.
    Results are plain JSON-safe objects; nothing is written anywhere. FROM-SPEC (spec:307, spec:390, spec:400, spec:416, spec:746-749, spec:783)
    FROM-CALLERS (apps/worker/src/library/handlers.ts:59-77 what is embedded; packages/shared/src/repositories/library.ts:272-279 vectors;
    agent/t3-2-library-api/DECISIONS.md D0(d) T3.3 honours project overrides).

D1  Trust. Untrusted: `prompt` (user text, any length, any characters, may be a non-string at runtime), `opts`, every TEI reply (shape, length,
    numbers), every row read back from Postgres (names and descriptions may come from `ctc migrate --from-python`, vectors may be the wrong length).
    Trusted: `ctx` (from auth / the hook wiring, spec:140) and `deps.config`. Rules: the matrix and the override rows used for a search are the
    ones of `ctx.userId` only (one RAM entry per `userId`, D14); a TEI reply that does not match D11/D12 exactly is an error, never partly used;
    prompt text is never logged, cached under its own text (only the `emb:` sha1 key, D11) or put in an error message.
    Prevents: one user's skills in another user's prompt line; a bad or swapped model silently ranking with garbage. FROM-SPEC (spec:139-140)
    FROM-CALLERS (packages/shared/src/repositories/ctx.ts:2 `Ctx`). The reply validation and the no-log rule: YOUR-CHOICE.

D2  Limits. Exported, mutable objects read at call time (a test may change a field and restore it):
    web `skillLimits = { promptChars: 20000, maxK: 100, maxAgeMs: 60000, retryMs: 5000, maxUsers: 32 }`:
      `promptChars`: the prompt is cut to its first 20,000 UTF-16 code units before the prefix is added (a longer prompt is cut, never refused;
        exactly 20,000 is unchanged);
      `maxK`: `opts.k` above 100 is clamped to 100;
      `maxAgeMs`: a loaded matrix older than 60 s is refreshed in the background (D14);
      `retryMs`: after a failed load, no new load is tried for 5 s;
      `maxUsers`: at most 32 users' matrices in RAM; loading the 33rd drops the least recently searched one.
    tei `teiLimits = { batch: 32 }`: at most 32 inputs per `/embed` request and 32 texts per `/rerank` request (inclusive; 33 inputs → 2 requests).
    From config (not constants): `k` (5), `depth` (50), `rerank_top` (20), `rrf_k` (60), `ranking.*`, `embed.instruction`, `embedding_dim` (1024),
    `timeout_s` (2), `batch_timeout_s` (60), `embed_model`. FROM-SPEC (spec:213 prompt ≤ 20,000 chars truncated; spec:205 60 s poll; spec:307
    50/50/60/20/5) FROM-CALLERS (TEI `/info` on 127.0.0.1:18300 and :18301: `max_client_batch_size: 32`; config/models.yaml:6-8 `timeout_s` for the
    daemon, `batch_timeout_s` for batch jobs; packages/shared/src/env/schema.ts:76-101). `maxK`, `retryMs`, `maxUsers`: YOUR-CHOICE (chosen by judgment).

D3  Output and error format.
    `channel.search` resolves to `SkillSearch = { hits: SkillHit[]; degraded: Degraded[]; ms: { load: number; embed: number; rank: number;
      rerank: number; total: number } }` with `Degraded = 'store' | 'embed' | 'rerank'` (each at most once, in that order) and every `ms` value a
    finite number ≥ 0 rounded to 0.1.
    `SkillHit = { capId: string; namespace: string; kind: string; name: string; rank: number; cosine: number; rerank: number | null }` with exactly
    these keys: `rank` = 1-based position in `hits`; `cosine` = cosine of the prompt vector and the capability's vector (also for a hit that came
    only from the keyword leg); `rerank` = the reranker's score for this hit when the reranker ran and the hit was in the pool (`sigmoid(logit)`
    when `ranking.rerank_by = 'sigmoid'`, the raw logit when `'logit'`), else `null`.
    tei errors: `class TeiError extends Error { name = 'TeiError'; code: 'timeout' | 'aborted' | 'http' | 'unreachable' | 'bad_reply'; status?: number }`,
    `message` = `tei <embed|rerank> <code>` plus ` <status>` for `http` (no URL, no input text, no reply body).
    FROM-SPEC (spec:113 `/v1/suggest` "JSON with seeds, candidates, line, timings"; spec:160) The shapes, `cosine` as the seed score, `TeiError`: YOUR-CHOICE.

D4  Bad input (never a throw, never a rejection from `search`, `reload`, `invalidate`, `onInval`):
    `prompt` not a string, or empty / whitespace only after the D2 cut → `{ hits: [], degraded: [] }` and no TEI call and no load;
    `opts.k` not an integer ≥ 1 → `config.k`; above `maxK` → `maxK`; `opts` missing or not an object → defaults;
    `ctx` without a string `userId` → `{ hits: [], degraded: ['store'] }`, nothing loaded;
    a row from `loadSkillIndex` whose embedding length is not `config.embedding_dim` or whose norm is 0 or not finite → that row is skipped (judgment);
    `onInval` with any message it does not know → ignored.
    tei `embed`/`rerank` reject with a `TeiError` (D3) on any failure; `embed([])` → `[]` and `rerank(q, [])` → `[]` with no request.
    FROM-SPEC (spec:163 "Hooks never error") The rest: YOUR-CHOICE.

D5  Odd but harmless input stays valid: a prompt with NUL, control characters, emoji or 20,000+ chars (cut per D2, sent as is otherwise); a prompt
    that matches nothing (hits are still returned: there is no floor here, T5.1 applies its own); `opts.k` larger than the number of
    capabilities (all of them, ranked); a user with no vectors (`hits: []`, `degraded: []`); a capability with an empty description; several
    capabilities with the same name in different namespaces or kinds (all kept, told apart by `capId`); `opts.signal` already aborted
    (`degraded: ['embed']`, no request). judgment: tolerant by default (D8). YOUR-CHOICE.

D6  Must never:
    (a) throw or reject out of `search`, `reload`, `invalidate`, `onInval` (D4);
    (b) write to Postgres, to Redis keys other than `emb:` (D11) and `ovr:` (D19), or to any file; call any `repos` function other than `library.loadSkillIndex` and
        `library.listOverrides` (via the T3.2 `overrideRows`, D19);
    (c) return a capability of another user, a removed capability, or one blocked for `ctx` (D19);
    (d) call the reranker when `ranking.rerank_weight` is 0, or compute the keyword leg when `ranking.keyword_rrf_weight` is 0 and `ranking.fusion`
        is `'rrf'` (their result cannot change the order);
    (e) edit its arguments, `deps.config`, or a row it loaded (inputs may be deep-frozen);
    (f) log or return prompt text, descriptions, vectors or URLs (D1);
    (g) block a search on a background reload once a matrix for that user exists (D14);
    (h) give two different orders for the same matrix, overrides, config, prompt vector and rerank scores (ties are broken by D15-D18 rules).
    FROM-SPEC (spec:163; spec:204 "prompt and pre hooks answer from RAM") (c) FROM-SPEC (spec:390); (d), (g), (h): YOUR-CHOICE.

D7  Non-goals (which code does that instead): embedding documents or writing `cap_vectors` (T3.1 `library.changed`); the HTTP routes, the hook,
    the 140 ms budget, the `sug:` cache, the floor and the prompt line (T5.1); the web and worker bootstraps that build the TEI client and the
    channel (later task); using a project's pinned version for ranking (vectors are of the override-free served version, T3.1 D16; a pin only
    changes what `get_capability` returns, T3.2 D12); HNSW / pgvector search (the RAM matrix is the index, spec:746); the abstain gate,
    `abstain_below`, `agent_min_rerank`, query blending, memory in the query (`LEGACY_KEYS`, packages/shared/src/env/schema.ts:11-26, Python only);
    `embed.text = 'current'` (T3.1 always embeds the SKILLRET text, apps/worker/src/library/handlers.ts:67); a kind filter; enrichment text.
    FROM-SPEC (spec:307, spec:390, spec:416, spec:783) FROM-CALLERS (as cited). The split: YOUR-CHOICE.

D8  Silence rule. Where this list says nothing, choose the more tolerant, less destructive behaviour (return fewer hits over failing; serve the
    old matrix over none; skip a bad row over dropping the whole matrix) and add a comment starting `judgment:`. FROM-OWNER (O11).

D9  Layout and public names (TypeScript strict, ESM, source run by Node type stripping, O11; no `enum`, no parameter properties; no new dependency:
    `fetch` and `AbortSignal.any`/`AbortSignal.timeout` are Node 22 globals):
    core `packages/core/src/skills/index.ts` (`@ctc/core/skills`; pure, no I/O, no `node:fs`, no `fetch`): `QUERY_INSTRUCTIONS`, `queryText`,
      `normalize`, `topCosine`, `buildKeywordIndex`, `keywordTop`, `tokenize`, `rrf`, `firstOrder`, `finalOrder`, `sigmoid`, `ndcgAt`, `recallAt`,
      types `Scored`, `KeywordIndex`, `Ranking`.
    tei `packages/shared/src/tei/index.ts` (`@ctc/shared/tei`): `createTei(deps: TeiDeps): Tei`, `teiLimits`, `TeiError`, types `Tei`, `TeiDeps`.
    web `apps/web/src/skills/index.ts`: `createSkillChannel(deps: SkillChannelDeps): SkillChannel`, `skillLimits`, types `SkillChannel`,
      `SkillChannelDeps`, `SkillSearch`, `SkillHit`, `Degraded`.
    repos `packages/shared/src/repositories/library.ts`: + `loadSkillIndex(ctx)` (D21).
    web library `apps/web/src/library/served.ts`: `overrideRows` becomes exported and takes `deps: Pick<LibraryApiDeps, 'repos' | 'cache' | 'log'>`
      (no behaviour change); `apps/web/src/library/index.ts` re-exports it (one line).
    Shapes the checks use: `Scored = { index: number; score: number }`; `normalize(v: ArrayLike<number>): Float32Array | null` (null for a zero or
      non-finite vector); `topCosine(matrix: Float32Array, dim: number, query: ArrayLike<number>, n: number): Scored[]`; `tokenize(s: string): string[]`;
      `buildKeywordIndex(docs: string[]): KeywordIndex`; `keywordTop(index, query: string, n): Scored[]`; `rrf(lists: string[][], weights: number[],
      k: number): Map<string, number>`; `sigmoid(x: number): number`; `firstOrder` / `finalOrder` shapes are free.
    More files may sit in core, tei and web skills directories. FROM-SPEC (spec:93-99 shared holds I/O helpers, core is pure; spec:88 apps/web
    holds the skill vectors) FROM-CALLERS (packages/core/package.json and packages/shared/package.json export `./*` → `./src/*/index.ts`;
    apps/web/src/library/served.ts:15 `overrideRows`). Folder names, TEI client in shared, `overrideRows` export: YOUR-CHOICE.

D10 Dependencies.
    `TeiDeps = { config: { embed_url: string; rerank_url: string; embed_model: string; embedding_dim: number; timeout_s: number; batch_timeout_s: number };
      cache?: { getVec(key: string): Promise<Float32Array | undefined>; setVec(key: string, vec: ArrayLike<number>, ttlSeconds: number): Promise<void> };
      fetch?: typeof fetch; log?(message: string, fields?: Record<string, unknown>): void }`.
    `Tei = { embed(texts: string[], opts?: { signal?: AbortSignal }): Promise<number[][]>; rerank(query: string, texts: string[], opts?: { signal?: AbortSignal }): Promise<number[]> }`
      (`embed` alone is assignable to the T3.1 `Embed` type).
    `SkillChannelDeps = { repos: Repositories; tei: Pick<Tei, 'embed' | 'rerank'>; config: Pick<Config, 'k' | 'depth' | 'rerank_top' | 'rrf_k' |
      'ranking' | 'embed' | 'embedding_dim'>; cache?: <the T1.4 Cache's get/set>; log?; now?: () => number }`.
    `SkillChannel = { search(ctx: Ctx, prompt: unknown, opts?: { k?: number; signal?: AbortSignal }): Promise<SkillSearch>;
      reload(ctx: Ctx): Promise<{ ok: boolean; size: number }>; invalidate(userId?: string): void; onInval(msg: unknown): void }`.
    `deps.config` is read at every call. A cache call never fails a request (errors are logged by class name and ignored).
    FROM-CALLERS (packages/shared/src/cache/index.ts:18-36 `Cache`, `getVec`/`setVec`; apps/worker/src/library/handlers.ts:14 `Embed`;
    packages/shared/src/env/index.ts:16 `Config`). The deps shapes: YOUR-CHOICE.

D11 TEI embed (`tei.embed(texts, opts)`):
    (1) inputs are sent as given (no prefix: documents get none, the channel adds the query prefix itself, D13), in order, in requests of at most
        `teiLimits.batch`, one request at a time;
    (2) request `POST <embed_url without trailing slash>/embed`, header `content-type: application/json`, body `{ "inputs": [...], "truncate": true }`;
    (3) timeout per request: `timeout_s` when the request has 1 input, `batch_timeout_s` when it has more; combined with `opts.signal`
        (`AbortSignal.any`); caller abort → `TeiError('aborted')`, own timeout → `TeiError('timeout')`, connection refused / DNS / reset →
        `TeiError('unreachable')`, non-2xx → `TeiError('http', status)`;
    (4) reply must be a JSON array with exactly one array per input, each of exactly `embedding_dim` finite numbers, else `TeiError('bad_reply')`;
        the vectors are returned as plain `number[]` in input order;
    (5) cache (when `deps.cache`): key `keys.emb(embed_model + '\u0000' + text)` (packages/shared/src/cache/keys.ts:20); all keys are read first
        (`getVec`), only misses are sent, each new vector is stored with `setVec(key, vec, ttl.emb)` (604,800 s); a cached vector whose length is not
        `embedding_dim` is a miss; duplicate texts in one call are sent once.
    FROM-SPEC (spec:174 `emb:{sha1(text)}` 7 d; spec:290 batch 32) FROM-CALLERS (TEI 1.8.2 `/info` `auto_truncate: false`, `max_client_batch_size: 32`;
    reply `[[...1024 floats]]` checked on :18300). The model in the hashed text, `truncate: true`, the 1-input timeout rule: YOUR-CHOICE.

D12 TEI rerank (`tei.rerank(query, texts, opts)`): `POST <rerank_url>/rerank` body `{ "query", "texts", "raw_scores": true, "truncate": true }`
    in requests of at most `teiLimits.batch` texts (same query); timeout `timeout_s` per request, errors as D11(3). Reply: an array of
    `{ index, score }` covering every index `0..n-1` of that request exactly once with a finite `score`, else `TeiError('bad_reply')`.
    Returns the logits in input order. No cache. FROM-CALLERS (TEI rerank reply `[{"index":0,"score":-2.79},...]` checked on :18301).
    `raw_scores` (logits, the sigmoid is computed here when wanted, D3) and no cache: YOUR-CHOICE.

D13 Query text. `QUERY_INSTRUCTIONS` (core) holds exactly these two strings (they must match the model's training prompts):
      `coding`:   `'Instruct: Given a coding task or question, retrieve capabilities (skills, agents, commands, workflows) that help accomplish it\nQuery: '`
      `skillret`: `'Instruct: Given a skill search query, retrieve relevant skills that match the query\nQuery: '`
    `queryText(prompt, instruction) = QUERY_INSTRUCTIONS[instruction] + prompt`; an unknown instruction uses `skillret`. The channel embeds
    `queryText(prompt cut per D2, config.embed.instruction)` with one `tei.embed([text], { signal })` call; documents are never prefixed.
    FROM-SPEC (spec:746 "skillret instruction prefix") FROM-CALLERS (config/retrieval.yaml:6 `instruction: skillret`; packages/shared/src/env/schema.ts:90-94;
    src/ctc/embedding/embedder.py:14-21 the two strings, read as data only). Unknown → skillret: YOUR-CHOICE.

D14 RAM matrix per user (web).
    (1) Load = `repos.library.loadSkillIndex({ userId })` (D21) → rows in capId order; rows failing D4 are skipped; the rest become one
        `Float32Array` of `n × embedding_dim` L2-normalised rows plus a parallel `meta` array `{ capId, namespace, kind, name, description }`;
        the keyword index (D16) is built from the same rows when first needed and kept with the entry.
    (2) The first `search` (or `reload`) for a user awaits its load. Concurrent loads of one user are one load (single flight).
    (3) An entry that was invalidated (`invalidate(userId)`, `invalidate()` = every user, `onInval` with `{ event: 'library.changed', userId }`) or is
        older than `skillLimits.maxAgeMs` (`deps.now`, default `Date.now`) stays in use; the next `search` starts one background reload and does not
        wait for it (D6g); the new matrix replaces the old one when the load finishes.
    (4) A failed load keeps the old entry (if any); `search` with no entry after a failed load returns `{ hits: [], degraded: ['store'] }`; no new
        load is started within `skillLimits.retryMs` of the failure (measured with `deps.now`).
    (5) `reload(ctx)` loads now and awaits it: `{ ok: true, size }` (rows kept) or `{ ok: false, size }` (size of the entry still in use, 0 if none).
    (6) More than `maxUsers` entries → the least recently searched one is dropped.
    FROM-SPEC (spec:182 reload after `library.changed`; spec:204 Postgres down: answer from RAM; spec:205 60 s poll; spec:212 RSS budget)
    FROM-CALLERS (packages/shared/src/cache/inval.ts:12 the `library.changed` event with `userId`). Stale-while-reload, the retry pause, the user cap: YOUR-CHOICE.

D15 Dense leg. `topCosine(matrix, dim, queryVec, n)`: the query vector is L2-normalised (a zero or non-finite query → empty leg); score of row i =
    dot product with the normalised row (= cosine); returns the `n = config.depth` best rows as `{ index, score }` sorted by score desc, ties by
    lower row index. No floor. FROM-SPEC (spec:307 dense top 50; spec:746 cosine) Ties, no floor: YOUR-CHOICE.

D16 Keyword leg (computed only when D6d allows). Document text of a row = `name + ' ' + description`. `tokenize(s)` = `s.normalize('NFKC')
    .toLowerCase()` split on every run of characters that are not Unicode letters or digits (`/[^\p{L}\p{N}]+/u`), empty tokens dropped.
    Okapi BM25 with `k1 = 1.2`, `b = 0.75`, `idf(t) = ln(1 + (N - df + 0.5) / (df + 0.5))`, over the unique query tokens. `keywordTop` returns the
    `config.depth` best rows with score > 0, sorted by score desc, ties by lower row index. FROM-SPEC (spec:307 keyword 50)
    The fields, tokenizer and BM25 constants: YOUR-CHOICE.

D17 First order (`firstOrder`), over the union of both legs after the D19 filter:
    `ranking.fusion = 'rrf'`: `score(id) = Σ w_l / (rrf_k + rank_l(id))` over the legs where the id appears (1-based rank), `w_dense = 1`,
      `w_keyword = ranking.keyword_rrf_weight`;
    `ranking.fusion = 'score'`: `score(id) = (1 - score_w) * kw(id) + score_w * cos(id)`, where `cos` is the id's cosine (D3) and `kw` = its BM25
      score divided by the largest BM25 score of the keyword leg (0 when absent or when that maximum is 0).
    Sorted by score desc; ties by dense rank asc (absent = after all present), then keyword rank asc, then `capId` in code-unit order.
    FROM-CALLERS (config/retrieval.yaml:7 "`keyword_rrf_weight` … `fusion: rrf | score (score: (1 - score_w) * keyword + score_w * cosine)`";
    src/ctc/retrieval/hybrid.py:63-66 the knob meanings, read as the config contract only) FROM-SPEC (spec:307 RRF k = 60).
    The BM25 max-normalisation and the tie order: YOUR-CHOICE.

D18 Rerank and final order (`finalOrder`). `pool` = the first `config.rerank_top` of the first order, `rest` = the remainder.
    `ranking.rerank_weight = 0` → final = first order, every `rerank` null, no reranker call.
    Otherwise `tei.rerank(prompt cut per D2 (no prefix), pool texts)` where a pool text = `name + ' | ' + description`; `rerankOrder` = pool sorted
    by logit desc, ties by first-order position; the pool is re-sorted by `rrf([pool, rerankOrder], [1, rerank_weight], rrf_k)` desc, ties by
    first-order position; final = that pool followed by `rest`. A rerank failure → final = first order, `rerank` null, `degraded` gets `rerank`.
    `hits` = the first `k` of the final order (k per D4). `rerank_by` changes only the reported `rerank` value (D3; the sigmoid is monotone).
    FROM-SPEC (spec:307 rerank top 20 → top 5; spec:747 `rerank_weight 0`) FROM-CALLERS (config/retrieval.yaml:7 `rerank_by: sigmoid`;
    src/ctc/retrieval/hybrid.py:63-64 "rerank_weight = rerank rank's weight next to dense rank (weight 1) in the final order").
    Skipping the call at weight 0, the `name | description` rerank text, rerank failure fallback: YOUR-CHOICE.

D19 Project overrides. Before the first order, every capability whose applicable override for `ctx` is `block` is removed from both legs; the
    applicable override = `ctx.projectId`'s row for that `capId`, else the global row (`projectId: null`) (T3.2 D12), read with the exported T3.2
    `overrideRows({ repos, cache, log }, ctx)` once per search (cache-aside under `ovr:` when there is a cache and a project). `pin` rows change
    nothing here (D7). An `overrideRows` failure → no filter for this search (judgment: fail open like the hooks; logged by class name).
    FROM-SPEC (spec:390; spec:404 overrides pin / block) FROM-CALLERS (apps/web/src/library/served.ts:15-50). Applying `block` in the channel, fail open: YOUR-CHOICE.

D20 `search` steps and degradation, in order: (1) D4 checks; (2) matrix for `ctx.userId` (D14; none → `degraded: ['store']`, `hits: []`, no TEI call);
    (3) `tei.embed` of the D13 text (failure or a vector that fails D4 → `degraded` gets `embed`, `hits: []`); (4) overrides (D19); (5) dense and
    keyword legs, first order, final order (D15-D18); (6) hits. `ms` measures each stage with `performance.now()` (`load` = time waiting for a
    load in this call, 0 when none). FROM-SPEC (spec:206 TEI down → lexical seeds only, `/v1/suggest` 503) Order and fields: YOUR-CHOICE.

D21 New repo function `repos.library.loadSkillIndex(ctx): Promise<{ capId: string; namespace: string; kind: string; name: string; description: string;
    embedding: number[] }[]>`: one SQL statement; live capabilities (`removed_at is null`) of `ctx.userId` that have a `cap_vectors` row; one row per
    capability (`distinct on (cap_id)`, the lowest `text_hash` when T3.1 pruning lags); `description` = the description of the version numbered
    `capabilities.served_version`, `''` when that is null or missing; ordered by `cap_id`. `tenancy.cases.ts` gets
    `loadSkillIndex: { expect: 'no-a', run: ({ r, ctx }) => r.library.loadSkillIndex(ctx) }`. FROM-CALLERS (packages/shared/src/repositories/library.ts:272-279
    `loadVectors` pattern; packages/shared/src/repositories/tenancy.cases.ts:1-6 every function needs a case; agent/t1-3-repos/DECISIONS.md D14).
    One join instead of `loadVectors` + one `get` per capability (N+1): YOUR-CHOICE.

D22 Metrics (core, pure). `ndcgAt(ranked: string[], rel: Record<string, number>, k = 10)`: `DCG = Σ_{i=1..min(k,|ranked|)} rel(ranked_i) / log2(i + 1)`
    (unknown id = 0; a repeated id counts once, at its first position), `IDCG` = the same over the relevance values sorted desc, cut at k; `0` when
    `IDCG = 0`. `recallAt(ranked, rel, k)` = |relevant (rel > 0) ids in the first k| / |relevant ids|, `0` when none is relevant.
    The gate is the plain mean over every query of the split. FROM-SPEC (spec:460 NDCG@10; spec:749 Recall@5) Linear gain (equal to the
    exponential gain for SkillRet's 0/1 qrels): YOUR-CHOICE.

D23 Gate test `suggest.skills` (Vitest, real scratch Postgres and the real TEI embedder on 127.0.0.1:18300):
    file `apps/web/src/skills/suggest.skills.int.test.ts`, `describe('suggest.skills')`,
    `it('SkillRet test split: NDCG@10 of the skill channel is at least 0.80')`:
    (1) data: `.ctc-dev/eval/skillret-test.json` = `{ source, skills: [{ id, name, description, body }], queries: [{ id, query }],
        qrels: { [queryId]: { [skillId]: number } } }` (6,006 skills, 4,392 queries), written by `python3 agent/t3-3-skill-channel/selfcheck.py --export`
        from the pinned SkillRet revision (evaluation/loaders.py `skillret('test')`, NUL characters removed from every string; the test never downloads anything). Path overridable with env `CTC_SKILLRET_FILE`.
    (2) skip (`describe.skipIf`) when the file or `CTC_SCRATCH_PG_URL` is missing, unless env `CTC_GATE_SUGGEST_SKILLS=1`: then a missing
        prerequisite fails the test with a message naming it.
    (3) config = `loadConfig({ dir: <repo>/config, env: {}, home: <a temp dir> })` (the repo's tuned values; TEI URLs from config/models.yaml);
        scratch schema `ctc_t33_<random>` migrated with `migrate({ url, schema })`, dropped in `afterAll`; URL must be `127.0.0.1:18304`.
    (4) per skill, user `{ userId: 'eval' }`: `createVersion({ namespace: 'sr-' + id, kind: 'skill', name, description, rootPath: 'skillret://' + id,
        bodyHash: sha256Hex(body), blobs: [], files: [] })`, `setServed(…, 1)`, text = `skillretText({ name, description, body },
        config.embed.skillret_body_chars)` (core library), vector = `createTei(...).embed` (documents, no prefix), `upsertVector({ capId, textHash:
        sha256Hex(text), embedding, model: config.embed_model })`.
    (5) `createSkillChannel({ repos, tei, config })`, for every query `search({ userId: 'eval' }, query, { k: 10 })` with no `degraded`; hits mapped back to
        SkillRet ids; mean `ndcgAt(…, 10)` over all queries ≥ 0.80. Recall@5, Recall@10, n and p50/p95 of `ms.total` are written to
        `.ctc-dev/eval/suggest.skills.json` and printed.
    (6) vectors may be cached on disk under `.ctc-dev/eval/` (through `TeiDeps.cache`); never in Redis (6,006 × 1,024 floats would crowd the
        256 MB `maxmemory`, spec:212). The test may take up to 30 min (first run embeds ~6,000 documents); it is a `*.int.test.ts` file.
    FROM-SPEC (spec:460 "NDCG@10 ≥ 0.80 test (today 0.811)"; spec:759; spec:783) FROM-OWNER (O7, O8 scratch DB only; O1 SkillRet test split)
    FROM-CALLERS (evaluation/loaders.py:33-56 SkillRet test = 6,006 skills scored against 4,392 queries, NUL stripped from bodies;
    agent/t0-2-baselines/SPEC.md the Python baseline method). `.claude/metric/eval/skillret.md` (spec:460) does not exist in this checkout, so this
    list defines the method. Data file path, namespaces per skill, disk cache, timing: YOUR-CHOICE.
