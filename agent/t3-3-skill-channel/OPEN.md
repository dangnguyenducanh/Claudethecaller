# T3.3 planner notes: what the owner reviews in the final PR

Drafted: `agent/t3-3-skill-channel/` (SPEC, DECISIONS D0-D23, PROCESS, checks.mjs, selfcheck.py). YOUR-CHOICE lines: 22 (every one is a default under O11).
Status: `checks.mjs` and `selfcheck.py` run and FAIL cleanly (module not built: 24/24 ids fail with that reason; with `CTC_SCRATCH_PG_URL` unset, with that reason).
The checks were never run against an implementation (none exists): expect a few planner mistakes; triage after the first coder run (fix the check,
not the code, when the check contradicts DECISIONS.md).
Verified by hand: TEI `/info` on :18300 / :18301 (`max_client_batch_size 32`, `auto_truncate false`, reply shapes); one 32 × 8,000-char `/embed`
batch takes 0.63 s (so the gate's first run embeds 6,006 documents in about 2 min); the SkillRet export runs offline in 2.5 s and writes
6,006 skills, 4,392 queries, 4,392 qrels (62 MB, `.ctc-dev/eval/skillret-test.json`, gitignored); pgvector accepts a zero vector in the
HNSW cosine index (the D4 zero-row check depends on it); `schema-assumptions.test.ts` is still red at 7b5098f (KNOWN_RED kept).
Orchestrator before the coder starts: `python3 agent/t3-3-skill-channel/selfcheck.py --snapshot`, and keep TEI :18300/:18301 up (never restart them).

## A. Highest risk (ordered by blast radius)
1. **The gate method is defined here, not by the spec's eval doc.** spec:460 points at `.claude/metric/eval/skillret.md`, which does not exist in
   this checkout. D22-D23 define it: SkillRet test split (6,006 skills, 4,392 queries), docs embedded by the TS client with the core
   `skillretText`, mean NDCG@10 (linear gain, binary qrels) over the channel's top 10. The Python baseline (0.811 test, T0.2 live run on 50 queries
   0.860) used its own pipeline; a TS result below 0.80 may come from a doc-text or truncation difference (UTF-16 cut vs Python code points,
   12 descriptions over 1,024 chars kept whole here), not from the channel.
2. **Rerank is skipped at `rerank_weight 0` (D6d, D18).** Today's tuned config has both weights at 0, so the shipped order is the dense order and
   the reranker is never called on the hot path. This saves a TEI round trip inside the 140 ms prompt budget but means the reranker path
   (and its `name | description` text, D18) is only covered by unit checks with a fake TEI, never measured. Alternative: always rerank the top 20
   like the Python code, and report its scores.
3. **The channel filters `block` overrides but ignores pins (D7, D19).** Vectors are of the override-free served version (T3.1 D16), so a project
   that pins `tdd@3` still ranks with the default version's vector. Filtering `block` reads override rows once per search (cache-aside `ovr:`);
   if that read fails the search fails open (no filter).

## B. YOUR-CHOICE items (D-id: default | alternative | why it matters)
| D | Default | Alternative | Why it matters |
|---|---|---|---|
| D1 | a TEI reply that is off in any way is an error, never partly used; prompt never logged | use the valid part | a swapped model or dim fails loudly instead of ranking garbage |
| D2 | `maxK 100`, `retryMs 5 s`, `maxUsers 32`; prompt cut at 20,000 UTF-16 units | other numbers; code points | memory in shared mode; reload storms when Postgres is down |
| D3 | `cosine` is the hit's seed score; `rerank` sigmoid or logit per `rerank_by`; `TeiError` codes | RRF score as seed score | T5.1 multiplies the seed score by hop decay; cosine is comparable with the graph embedding channel's 0.3 floor |
| D4 | bad prompt/ctx/k never throws: empty result or defaults; bad vector rows skipped | throw / 422 | hooks must never error (spec:163) |
| D5 | tolerant odd inputs (NUL, emoji, no vectors, aborted signal) | reject | — |
| D6 | no keyword work at weight 0 with `rrf`; no reranker at weight 0; deterministic ties | compute every leg always | latency vs. timings that show every stage |
| D7 | non-goals: pins in ranking, HNSW, abstain gate, blending, `embed.text: current`, kind filter | port them | `LEGACY_KEYS` stay Python-only; T5.1 owns floors |
| D9 | `@ctc/core/skills` (pure maths), `@ctc/shared/tei` (HTTP client), `apps/web/src/skills` (RAM + search); `overrideRows` exported from T3.2 | client inside apps/web; a second copy of the override read | the worker and F3 reuse the TEI client; touches a T3.2 file (no behaviour change) |
| D10 | deps injected (`tei`, `cache`, `now`); config read at call time | a global config | testability |
| D11 | `emb:` key hashes `embed_model + NUL + text`; `truncate: true`; 1 input → `timeout_s`, more → `batch_timeout_s`; duplicates sent once | key = text only (spec:174 literally) | a model swap would serve old vectors for 7 days with the literal key |
| D12 | `raw_scores: true`, no rerank cache | sigmoid scores from TEI | logits keep `rerank_by: logit` possible |
| D13 | unknown instruction → `skillret` | error | config Zod already restricts it to two values |
| D14 | stale-while-reload; first load awaited; failed load keeps the old matrix; 60 s max age | block on reload; drop on failure | hot path never waits on Postgres once warm (spec:204) |
| D15 | ties by lower row index (capId order); no floor | random / floor here | determinism; T5.1 owns the floor |
| D16 | BM25 (1.2, 0.75) over `name + description`, NFKC lower, unique query tokens | Postgres `tsvector`; include the body | only used when `keyword_rrf_weight > 0` or `fusion: score`; the body would need ~48 MB RAM for SkillRet |
| D17 | `score` fusion normalises BM25 by the leg's max; tie order dense, keyword, capId | z-score or raw BM25 | changes `fusion: score` results only |
| D18 | rerank text `name | description`, query without prefix; rerank failure → first order + `degraded: rerank` | skillret text with body | the body is not in RAM |
| D19 | `block` (project row over global row) filters; pins ignored; override read failure → no filter | ignore overrides; fail closed | a blocked skill could appear in the line while Postgres is down |
| D20 | step order: store → embed → overrides → legs; `ms` per stage | — | `/v1/suggest` timings |
| D21 | new `loadSkillIndex` (one join, served description, lowest `text_hash` on duplicates) + tenancy case | `loadVectors` + one `get` per capability | N+1 on every reload; touches T1.3's module (same pattern as T3.2 `listByName`) |
| D22 | linear gain NDCG; repeats count once | exponential gain | identical for SkillRet's 0/1 qrels |
| D23 | export written by the selfcheck (`--export`) to `.ctc-dev/eval/`; one namespace per SkillRet skill (`sr-<id>`, names repeat 205×); disk vector cache allowed, Redis not; 30 min budget; strict switch `CTC_GATE_SUGGEST_SKILLS=1` | a committed fixture; real namespaces | the test needs the cached HF dataset (`data/` symlink) and TEI; in CI it skips |

## C. Places where two reasonable readers differ
- spec:307 "rerank top 20 → top 5": read as the knobs' order, with the rerank call skipped when its weight is 0 (D18). A reader who wants the
  reranker always called (for timings or future `agent_min_rerank`) would call it anyway.
- spec:307 "keyword 50": the keyword source is not named; here BM25 in RAM over name + description (D16). Python used Postgres full text; the
  hot path must answer from RAM when Postgres is down (spec:204).
- spec:390 "Only the served version is embedded": the vector belongs to the override-free served version, so project pins do not reach ranking (D7).
- spec:174 `emb:{sha1(text)}`: the hashed text here includes the model id (D11).
- spec:460 "on the skill seed channel": measured on `channel.search` itself (not `/v1/suggest`, which T5.1 builds), with `k = 10` so NDCG@10 is
  defined; production uses `k = 5`.
- SkillRet data violates the scanner's rules (505 names fail `NAME_RE`, 12 descriptions over 1,024 chars, 205 repeated names): the gate inserts
  rows through `repos.library.createVersion` directly, not through the scanner, and keeps them whole so the number is comparable with Python's.
- `.ctc-dev/eval/skillret-test.json` holds public SkillRet data only; it stays gitignored because of its size (62 MB).
- Not covered by checks.mjs: the real TEI (only the gate uses it), Redis (`emb:` caching is checked with an in-memory fake), the web bootstrap wiring.
