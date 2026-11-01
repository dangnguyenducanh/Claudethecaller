# Data model: Flagship-repo adoption (m8)

No Postgres schema change and no new table. State is config, scratch eval artifacts and one Redis key. Field details of the config and the report are in [contracts/knobs-and-eval.md](contracts/knobs-and-eval.md).

## Config (in `config/retrieval.yaml`, defaults = today's behaviour)

| Key | Type | Default | Used by |
|---|---|---|---|
| `embed.text` | `current` \| `skillret` | `current` | `indexer.texts()`, part of `text_hash` |
| `embed.instruction` | `coding` \| `skillret` | `coding` | `Embedder` query prefix |
| `embed.skillret_body_chars` | int | `8000` | `skillret` text length cap |
| `ranking.fusion` | `rrf` \| `score` | `rrf` | `hybrid.search` |
| `ranking.score_w` | float 0–1 | `0.7` (starting point; set by the dev sweep) | `score` fusion |
| `gate.kind` | `lr` \| `margin` \| `platt` \| `isotonic` \| `off` | `off` (today: abstain off) | `gate.py`, K2 |
| `gate.margin_ratio` | float | `1.5` | `margin` |
| `gate.min_p` | float | from K2 | calibrated gates (reuses `gate_min_p`) |

## Entities

- **Text mode** = (`embed.text`, `embed.instruction`, cap). `text_hash = sha256(model + text)` already includes the text, so changing the mode re-embeds exactly the rows whose text changed.
- **Search hit stages** (in-memory, per request): existing `dense`, `keyword`, `rrf`, `rerank` stay; new `rerank_logit` (raw TEI score) and `fused` (score fusion value in [0, 1]; absent under `rrf`).
- **Gate candidate** (artifact `models/gate-<kind>-<date>.joblib` plus a row in the report): `kind`, fitted parameters, ECE, threshold, dev and test rates. At most one is referenced by `gate_path`.
- **Eval record** (one row per comparison in `data/reports/*.json`): `a`, `b`, `metric`, `split`, `delta`, `p`, `significant_at_0.01`, `significant_at_0.05`, plus the text mode, instruction and fusion used.
- **Rate-limit window**: Redis sorted set `rl:{user}`; score = Redis `TIME` in ms, member = `<ms>-<seq>`; TTL 60 s. Replaces the integer key `rl:{user}:{minute}`; the two never coexist for one user after deploy beyond 60 s (the old key expires on its own).
- **Third-party notice**: one entry in `THIRD_PARTY_NOTICES.md` = `{file, source repo, pinned permalink, license, what changed}`.

## State transitions

- Text mode: `current` → `skillret` only by an owner-approved config change after SC-001; the next `ctc index` re-embeds (a Supabase write, owner's yes).
- Gate: `off` → one candidate only if SC-003 holds on test; otherwise stays `off` and a Decisions line says why.
