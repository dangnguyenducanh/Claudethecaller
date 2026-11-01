# Memory eval set (F3 recall)

Gate `memory.recall` (spec 007 §4.8, §7 F3): RRF Recall@5 ≥ vector-only Recall@5 on this set.

| File | What |
|---|---|
| `corpus.jsonl` | 120 memories `{id, kind, scope, text}`, one sentence each, about this project (from the committed spec and agent harness files; no private transcripts or memories, owner decision O2) |
| `queries.jsonl` | 50 queries `{id, style, query, relevant}`, hand-labelled with 1-2 relevant memory ids; styles: 24 keyword, 23 paraphrase, 3 session-start (`<project> <next steps>`) |
| `vectors.jsonl` | `{id, sha1, v}` per memory and per query: SKILLRET-Embedding-0.6B via TEI `/embed` (`normalize`, `truncate`, plain text, no instruction prefix), `v` = base64 of 1024 little-endian float32, `sha1` = sha1 of the embedded text |
| `embed.mjs` | rebuilds `vectors.jsonl` from TEI (`CTC_EMBED_URL`, default `http://127.0.0.1:18300`, loopback only) |

Metric: per query, `|relevant ∩ top 5| / |relevant|`, averaged over the 50 queries. Legs: `repos.memory.recallLegs` (full-text `plainto_tsquery('simple')` and pgvector cosine, 100 each) for user `eval` and one project; RRF with k = 60.

Rules: the labels were written before any retrieval run and are not tuned to an implementation. Change `corpus.jsonl` or `queries.jsonl` only together with new labels and `node embed.mjs`; the gate test refuses vectors whose `sha1` does not match the text.

Planner measurement (2026-10-31, scratch Postgres, 4 runs, identical): RRF@5 = 0.920, vector-only@5 = 0.900. With OR semantics in the full-text leg RRF@5 fell to 0.79-0.85 (the `simple` configuration has no stop words).
