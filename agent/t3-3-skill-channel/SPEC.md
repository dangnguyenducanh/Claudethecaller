# Task: build the F2 skill seed channel: a TEI client (embed + rerank), a RAM matrix of each user's served capability vectors, the dense + keyword → RRF → rerank search over it with today's tuned knobs, and the `suggest.skills` gate (SkillRet test NDCG@10 ≥ 0.80).

Callers (built later): T5.1 `/v1/hook/prompt` and `/v1/suggest` call `channel.search(ctx, prompt, { signal })` for skill seeds; the ctc-web bootstrap builds
the channel, warms it with `reload` and wires `onInval` to `cache.subscribeInval`; the worker main may bind `createTei(...).embed` as T3.1's `Embed`.
Vectors come from `cap_vectors`, written by T3.1's `library.changed` job; SQL goes through `repos.library` only (T1.3). Untrusted: the prompt, every TEI
reply, every row read back from Postgres. The gate is the Vitest test `suggest.skills`.

Public names (TypeScript strict; exact shapes in DECISIONS.md D3, D9-D23):

    packages/core/src/skills/index.ts   (`@ctc/core/skills`, pure, no I/O):
      QUERY_INSTRUCTIONS, queryText(prompt, instruction), normalize(vec), topCosine(matrix, dim, query, n), tokenize(s),
      buildKeywordIndex(docs), keywordTop(index, query, n), rrf(lists, weights, k), firstOrder(...), finalOrder(...), sigmoid(x),
      ndcgAt(ranked, rel, k?), recallAt(ranked, rel, k); types Scored, KeywordIndex, Ranking
    packages/shared/src/tei/index.ts    (`@ctc/shared/tei`):
      createTei(deps: TeiDeps): Tei   (Tei = { embed(texts, opts?): Promise<number[][]>; rerank(query, texts, opts?): Promise<number[]> })
      teiLimits, TeiError; types Tei, TeiDeps
    apps/web/src/skills/index.ts:
      createSkillChannel(deps: SkillChannelDeps): SkillChannel
        (SkillChannel = { search(ctx, prompt, opts?): Promise<SkillSearch>; reload(ctx); invalidate(userId?); onInval(msg) })
      skillLimits; types SkillChannel, SkillChannelDeps, SkillSearch, SkillHit, Degraded
    packages/shared/src/repositories/library.ts:  + loadSkillIndex(ctx)   (D21, with its tenancy case)
    apps/web/src/library/served.ts:               overrideRows exported, deps narrowed to { repos, cache?, log? }   (D9, D19; no behaviour change)

## How to work
1. `agent/t3-3-skill-channel/DECISIONS.md` is the behaviour contract. Implement exactly that.
2. `agent/t3-3-skill-channel/PROCESS.md` is the order of work.
3. Change only:
   - `packages/core/src/skills/` (source and `*.test.ts`),
   - `packages/shared/src/tei/` (source and `*.test.ts`),
   - `apps/web/src/skills/` (source, `*.test.ts`, and test fixtures in `apps/web/src/skills/fixtures/`),
   - `packages/shared/src/repositories/library.ts` (only `loadSkillIndex`), `packages/shared/src/repositories/tenancy.cases.ts` (only its case);
     new `*.test.ts` files in `packages/shared/src/repositories/`,
   - `apps/web/src/library/served.ts` (only: `export` on `overrideRows` and its narrowed deps type), `apps/web/src/library/index.ts` (one export line).
   No new dependency, no `package.json` or lockfile change, no Python change: `fetch` and `AbortSignal` are Node globals; the cache comes through
   `@ctc/shared/cache`, config types through `@ctc/shared/env`, SQL through `@ctc/shared/repositories` (never import `pg`/`kysely` outside
   `packages/shared/src/repositories`; ESLint bans it).
   Preconditions the orchestrator provides, because you have no network: dependencies installed; the scratch Postgres `127.0.0.1:18304`
   (env `CTC_SCRATCH_PG_URL`) running; the TEI embedder `127.0.0.1:18300` and reranker `127.0.0.1:18301` up (shared: use, never restart);
   `.ctc-dev/eval/skillret-test.json` written by `python3 agent/t3-3-skill-channel/selfcheck.py --export` (the full self-check writes it when
   missing). Unit tests use a fake `fetch` or a local fake HTTP server, never the real TEI; only `*.int.test.ts` files may call the real TEI.
   Never read or write the real `~/.claude`, `~/.claudethecaller`, port 18310, Redis, or any other service.

Test naming (the self-check's `--fast` skips slow files by name): tests that need the scratch Postgres or the real TEI are `*.int.test.ts` (and
`tenancy.test.ts`); pure tests are `*.test.ts`. Scratch schemas are named `ctc_t33_<random>` and dropped in `afterAll`.

## Done
The gate test file exists with exactly these names (DECISIONS.md D23):
- `apps/web/src/skills/suggest.skills.int.test.ts`: `describe('suggest.skills')` with
  `it('SkillRet test split: NDCG@10 of the skill channel is at least 0.80')`, and it PASSES (not skipped) under `CTC_GATE_SUGGEST_SKILLS=1`.

`python3 agent/t3-3-skill-channel/selfcheck.py` prints `SELFCHECK: DONE`.
