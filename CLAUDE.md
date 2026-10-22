# claudethecaller

Local skill/workflow router for coding agents. **`PLAN.md` is the single source of truth** (product spec, stack, build order, how to code each step). Read the sections a task names. Benchmark labels in `data/own-eval*` are written by step K1 and hand-checked by the owner (H1).

## How work happens here

- Development follows the **build order** in `PLAN.md`: four tracks (Backend, Benchmark, Frontend, AI later), one Done-when command per step, one branch per phase or step (`m1-retrieval-core`, `b9-history-import`, …), PR into `staging`; `staging` → `main` is the release (PLAN.md "Git workflow and CI/CD").
- Follow the rules under "Constraints" in `PLAN.md`: stay in the current step's scope.
- No tests for now: the owner will guide testing later. Each step in `PLAN.md` says how to code it.
- Code style: shortest working solution; stdlib and already-chosen deps first; no abstractions with one implementation; mark known corner-cuts with a `ponytail:` comment.

## Working agreement: propose first, work only after approval

The owner decides what happens. The agent proposes, waits, then executes exactly what was approved.

1. **Propose before acting.** For anything beyond reading, post a short proposal and stop. Format (≤ 15 lines): **Goal** · **Plan** (numbered steps) · **Touches** (files, branch/worktree, DB, GitHub, `~/.claude`, daemon) · **Cost** (agents, tokens, minutes) · **Risks / rollback** · **Decisions needed** (recommend one default for each). No open-ended questions where a sensible default exists.
2. **Approval = an explicit message from the owner** about that proposal ("approved", "yes", "go", "do it", or edits to the plan). Not approval: silence, background-task or CI notifications, an earlier approval for a different scope, "continue" after a status report, or the agent's own earlier statements. Approval covers only the scope stated; when scope grows (new files, a bigger blast radius, a different approach after a failure) stop and re-propose.
3. **Needs approval every time** (include it in the proposal; approving the proposal approves it): editing files, commits, pushes, PRs and merges, branch or repo settings, deleting anything (branches, worktrees, files, rows), writes to Supabase, starting or stopping the daemon or containers, `ctc install` or any write to the real `~/.claude`, starting a Workflow or subagents, long LLM or GPU jobs.
4. **Allowed without approval:** reading and searching files, `git status/log/diff`, read-only API or SQL queries, health checks, lint and self-checks that only write to scratch space or throwaway schemas, drafting in the scratchpad, and answering questions.
5. **Standing approvals** (the owner edits this list; empty means none): _none_.
6. **Execute the plan as approved, no extras.** Report what ran with its real output; list anything skipped. Anything the agent notices along the way becomes a new proposal, not a side effect. Subagents and workflows inherit this: they never commit or push, and the lead acts only within the approved scope.
7. **Blocked on the owner** (H steps, credentials, a choice only they can make): say so in one line and stop.
8. **Git flow:** one feature branch per PLAN step, PR into `staging`, never push to `staging` or `main` directly; commit messages and PR titles follow Conventional Commits. See PLAN.md "Git workflow and CI/CD".

## Modes: `/1` and `/2`

The owner picks how much machinery a task gets by starting the message with `/1` or `/2` (then the task). Without either, propose per the working agreement and recommend one: `/1` for one concern or ≤ 3 files, `/2` for multi-module work, schema or Supabase changes, or ≥ 4 files.

| | `/1 <task>` simplest flow | `/2 <task>` structured workflow |
|---|---|---|
| Agents | **One agent does everything** (the main session itself): no subagents, no Workflow | A Workflow of parallel builders on **disjoint files** (each owns its files, none commits) |
| Proposal | None: the command is the approval for the task's local work (edits, scratch runs, a commit on the feature branch) | Required, then wait for approval (it states phases, agent count, tokens, minutes); typing `/2` is the owner's explicit opt-in to the Workflow tool |
| Review | **None** | **One** simple reviewer for the whole wave (critical/high defects only), then one fixer only if it found something |
| Verify | Run the one relevant check once (ruff, a self-check, a build) and show its output | A test step at the end: ruff, pytest, the touched self-checks, a live smoke where a daemon is involved |
| Report | ≤ 5 lines: what changed, check result, anything left | Per phase: result, check output, findings and fixes, what is still open |

- **Still needs an explicit yes, in both modes:** push, PR, merge, repo or branch settings, deleting anything, writes to Supabase, writes to the real `~/.claude`, starting or stopping the daemon or containers. In `/1` ask in one line at the end instead of proposing up front.
- **`/1` stays simple:** if the task turns out to need subagents, a review or more than the stated scope, stop and offer `/2`; do not grow it silently.
- **Cost:** every `/2` proposal states it; prefer the smaller option.

## graphify

Code knowledge graph at `graphify-out/graph.json`: a local AST graph of this repo (tree-sitter, no LLM, no API key, nothing leaves the machine). It is gitignored and rebuilt in the background by the git post-commit hook, so it exists once code has been committed.

**When to use it** (only when `graphify-out/graph.json` exists):
- Before your first grep, search or source-file read for a codebase question ("where is X", "what calls Y", "how does A reach B").
- Before changing a function or type that others may depend on: check impact first.
- In every subagent prompt that explores code, include: "Use `graphify query` before grep/read."

**When not to use it:** reading `PLAN.md` or other docs (read them directly); a file you already located and are about to edit; before any code exists.

**How:**

| Need | Command |
|---|---|
| Find code for a question | `graphify query "how does search fuse dense and keyword results"` |
| Explain one concept and its neighbors | `graphify explain "Store"` (add `--all` for every edge) |
| How two things connect | `graphify path "search" "rrf"` |
| What breaks if I change X | `graphify affected "Store.upsert"` |
| Architectural hubs | `graphify god-nodes` |
| Refresh after editing code (don't wait for the commit hook) | `graphify update .` |
| Broad architecture review | read `graphify-out/GRAPH_REPORT.md` |

Exit code 3 means the name is ambiguous: retry with a more specific name or file path. Read raw files only for lines the graph already located. The PreToolUse hook in `.claude/settings.json` nudges toward the graph; it never blocks. `/graphify` runs the full skill (`.claude/skills/graphify/SKILL.md`).

## Project memory

Durable facts and decisions. Append new decisions under **Decisions** with the date; delete entries that become wrong.

**Environment**
- Shared GPU host: RTX 5880 Ada 49 GB, ~21 GB held by other services. Our budget is ≤ 7 GB total. Never stop or touch other containers (`crm_*`, `mass_chatbot_*`, `khoahoctutien-*`, `de-tai-hoc-vien-*`).
- Database: Supabase project `claudethecaller` (`iecwnlyqjbigeiobmurn`, ap-southeast-1, free tier), tables in schema `ctc`. This host has no IPv6, so connect through the IPv4 session pooler; the connection string (with password) lives only in `.env` as `CTC_DATABASE_URL`. Round trip ~65 ms.
- Ports: TEI embedder `:18300`, TEI reranker `:18301`, llama-server `:18302`, Redis `:18303`, daemon `:18310` + `~/.claudethecaller/ctc.sock`. Local state: `~/.claudethecaller/ctc.sock` only; Redis holds cache only (TTL'd, rebuildable); everything durable is in Supabase.
- `ANTHROPIC_API_KEY` is not set on this host.
- Python 3.12 via `uv`; dashboard via `pnpm`; model servers via `docker compose`.
- Before pushing: `scripts/check.sh` (the CI checks; DB self-checks only when `CTC_DATABASE_URL`/`CTC_REDIS_URL` point at scratch services). Deploy to this host: `scripts/deploy_local.sh` (pull, build, restart the daemon).
- CLI: `uv run ctc status | caps | index | search "<prompt>" | explain "<prompt>"`. Daemon: `uv run ctc daemon start|stop|status` (socket + `:18310` serving `/v1`, `/api`, `/mcp` and the built dashboard; set `CTC_DASHBOARD_DIST=<main checkout>/dashboard/dist` before `start` when running from a worktree). Hooks + MCP: `uv run ctc install|uninstall` (`--dry-run` prints the diff; `CTC_CLAUDE_HOME=<tmp dir>` points it away from the real `~/.claude`). Dashboard dev server: `pnpm -C dashboard dev` → `:18320`.

**Stack** (full table in `PLAN.md`): Python core (FastAPI daemon, typer CLI, ranx/scikit-learn eval), TypeScript only for the dashboard, native engines for speed (TEI Rust, llama.cpp); one database: Supabase Postgres + pgvector. Hook = `curl` one-liner, fail-open.

**Decisions**
- 2026-10-20 — Built from scratch: ratel, MCPGateway, metamcp and similar are references only, never dependencies (portfolio project).
- 2026-10-20 — Local models ≤ 3B params; embedder `ThakiCloud/SKILLRET-Embedding-0.6B` (baseline `BAAI/bge-m3`), reranker `BAAI/bge-reranker-v2-m3`, LLM `Qwen2.5-3B-Instruct` Q4 via llama.cpp.
- 2026-10-20 — Offline LLM default is the local llama-server (`CTC_LLM=openai:http://127.0.0.1:18302/v1:qwen2.5-3b`) because no Anthropic key is set; this also keeps transcripts on-machine. Set `CTC_LLM=anthropic:<model>` to switch.
- 2026-10-20 — Hook suggests, never blocks. Router abstains rather than returning a weak top-1.
- 2026-10-20 — Eval data: SkillRet (main), MetaTool (abstain), SRA-Bench, ToolRet, own transcripts (held-out truth; test queries never come from the enricher).
- 2026-10-20 — graphify is dev tooling only (navigation for agents), not part of the product; `graphify-out/` stays untracked.
- 2026-10-21 — TEI image pinned to `ghcr.io/huggingface/text-embeddings-inference:89-1.8.2`: the newer `89-1.9.0` hits `CUDA_ERROR_SYSTEM_DRIVER_MISMATCH` on this host's driver (580.178.04) and silently falls back to CPU. 1.8.2 loads on GPU fine (`Starting Flash... on Cuda(...)` in logs). Don't bump the TEI tag without checking the container logs show CUDA, not CPU.
- 2026-10-21 — `ThakiCloud/SKILLRET-Embedding-0.6B`'s cached `config.json`/`sentence_bert_config.json` needed hand patches for TEI 1.8.2's Candle Qwen3 backend to load: `pad_token_id` null→`151643`, a top-level `rope_theta` mirroring `rope_parameters.rope_theta`, and `max_seq_length: 32768` added to `sentence_bert_config.json` (that file otherwise has no `max_seq_length` field at all). Files are root-owned under `~/.cache/huggingface/.../blobs/`; edit via a throwaway `docker run --rm -v ~/.cache/huggingface:/data alpine sh -c "sed -i ... /data/..."` since the host user can't write them directly. Reapply if that model's cache is ever cleared/re-downloaded.
- 2026-10-21 — R3 done: `uv run python -m ctc.models` embeds/reranks/`Llm.json`'s against the live `docker compose` stack; our 3 containers use ~6.4 GB GPU (embedder 1538 MiB + reranker 1506 MiB + llama-server 3486 MiB), under the 7 GB budget.
- 2026-10-21 — One database: Supabase (Postgres + pgvector + full-text search) replaces SQLite and USearch; owner's choice. Cold routing target relaxed to p95 ≤ 150 ms for the ~65 ms network hop; C++/USearch hot path dropped.
- 2026-10-21 — `bge-reranker-v2-m3` scores are not usable as absolute relevance for tool matching (0.001–0.04 for correct matches); search orders by RRF(dense rank, rerank rank), keywords only add candidates, abstain is off until K2 calibrates it.
- 2026-10-21 — Redis 8 added as the cache layer (owner's choice: the project targets coders everywhere, so daemons must scale to N workers / a shared team mode). L1 in-process → L2 Redis → Supabase; Redis is never a source of truth and fails open (20 ms timeout). Semantic cache uses Redis 8's built-in Query Engine (`FT.SEARCH` KNN), decisions/events go through a Redis stream writer. Design: PLAN.md "Cache design" and "API design"; step B4b.
- 2026-10-21 — No dedicated vector DB (Qdrant, Milvus, Weaviate, Pinecone): pgvector holds our scale (~10k capability vectors, ~200k with SkillRet) and lets one SQL round trip join dense + full-text + overrides + namespaces + memory recency; a second store would add a sync job and a second ~65 ms hop. Revisit past ~10M vectors or for multi-vector (ColBERT) retrieval; `Store.candidates()` is the one function to swap.
- 2026-10-21 — The API matches `dashboard/src/types.ts` field for field (PLAN.md "API design"); projects are keyed by unique name in the API because the dashboard keys and colours by name.
- 2026-10-21 — Abstain gate disabled: the K2 gate trained on 77 LLM-labelled dev rows scored CV AUC 0.55 (no signal) and, at the threshold meeting false-trigger ≤ 10%, suggested on only 7–13% of prompts (SkillRet Recall@5 0.79 → 0.07). File kept as `models/abstain-2026-10-21-auc055.rejected.joblib`; abstain is off (every prompt gets a suggestion) until K2 is re-run on the owner's H1 labels. SkillRet full run also showed dense-only NDCG@10 0.787 > hybrid+rerank 0.771 (keyword RRF hurts, bge-reranker adds nothing there); revisit ranking with H1 labels and `Qwen3-Reranker-0.6B`.
- 2026-10-21 — Final ranking is a config knob, `ranking: {keyword_rrf_weight, rerank_weight}` in `config/retrieval.yaml` (read by `hybrid.search`): the keyword rank's weight in the RRF that fills the top-20 rerank pool, and the rerank rank's weight next to dense rank (weight 1) in the final order; keywords never vote in the final order. `{1, 1}` = the old order, `{0, 0}` = dense order. Tuned on dev only to `{0.25, 1}` (SkillRet dev NDCG@10 0.605 vs old 0.600, dense-only 0.580). SkillRet test disagrees: 0.773 vs old 0.770, but dense-only 0.787 still wins, so rerank helps on dev (+0.025) and hurts on test (-0.014). Kept the dev pick (choosing from test numbers would be tuning on test); re-decide on H1 labels or with `Qwen3-Reranker-0.6B`.
- 2026-10-21 — H0 done without the admin password: a least-privilege login role `ctc_app` (created through the Supabase MCP from a locally generated SCRAM verifier; plaintext only in `.env`) owns schema `ctc`; it connects as `ctc_app.iecwnlyqjbigeiobmurn` through the session pooler `aws-0-ap-southeast-1.pooler.supabase.com:5432`. Measured round trip 38 ms. Dev state (A1 enrichment, projects, memories, dedup queue) was copied over; the dev container `ctc-dev-pg` stays as a scratch DB (its URL is commented in `.env`).
- 2026-10-21 — Dense search moved into RAM per worker (Store loads every capability vector, 6.3k x 1024, binary + chunked, ~2 s at start and after index changes; exact, top-10 identical to pgvector HNSW on 5 probes). Only keywords, overrides and recall go to Supabase, in one parallel hop. Hook budget raised from 120 to the PLAN constraint of 150 ms (`curl -m 0.15`, daemon waits 140 ms). K3 on Supabase: cold p50 96 / p95 156 ms, Redis hit p95 4.1 ms, L1 p95 0.8 ms; 8/10 cold hooks answer in time. Next lever if needed: keyword channel in RAM too (no DB hop on the cold path).
- 2026-10-22 — Owner: judge and tune on the clean, large benchmarks first — SkillRet (4,392 test queries; its train split for tuning) for ranking, MetaTool (520 no-tool negatives) for the abstain gate. Own-transcript rows (~372 prompts, H1) are a secondary in-domain check, not the gate for K2.
