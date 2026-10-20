# claudethecaller

Local skill/workflow router for coding agents. **`PLAN.md` is the single source of truth** (product spec, stack, gates, rounds, tasks). Read the sections a task names; never edit `PLAN.md`. `eval/gates.toml` and `data/own-eval*` are written by round R6 and owner-edited after that; see gnhf rule 3 in `PLAN.md`.

## How work happens here

- Development runs as **gnhf rounds** (`PLAN.md` → "Rounds (run with gnhf)"), one milestone branch each (`m1-retrieval-core`, …), PR into `main` at the end of the milestone.
- Inside a round: follow the "gnhf rules" in `PLAN.md`. Small verified change per iteration, stay in the round's scope, never weaken a test.
- Tests are two tiers only: Tier 1 logic checks (`uv run pytest`) for our own branching/math, Tier 2 metric gates (`uv run eval/run.py --gate mN`, N = milestone). No test-first ceremony, no tests for glue or libraries.
- Code style: shortest working solution; stdlib and already-chosen deps first; no abstractions with one implementation; mark known corner-cuts with a `ponytail:` comment.

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
- Ports: TEI embedder `:18300`, TEI reranker `:18301`, llama-server `:18302`, daemon `:18310` + `~/.claudethecaller/ctc.sock`. State lives in `~/.claudethecaller/` (`state.db`, `*.usearch`).
- `ANTHROPIC_API_KEY` is not set on this host.
- Python 3.12 via `uv`; dashboard via `pnpm`; model servers via `docker compose`.

**Stack** (full table in `PLAN.md`): Python core (FastAPI daemon, typer CLI, ranx/scikit-learn eval), TypeScript only for the dashboard, native engines for speed (USearch C++, SQLite FTS5, TEI Rust, llama.cpp). Hook = `curl` one-liner, fail-open.

**Decisions**
- 2026-10-20 — Built from scratch: ratel, MCPGateway, metamcp and similar are references only, never dependencies (portfolio project).
- 2026-10-20 — Local models ≤ 3B params; embedder `ThakiCloud/SKILLRET-Embedding-0.6B` (baseline `BAAI/bge-m3`), reranker `BAAI/bge-reranker-v2-m3`, LLM `Qwen2.5-3B-Instruct` Q4 via llama.cpp.
- 2026-10-20 — Offline LLM default is the local llama-server (`CTC_LLM=openai:http://127.0.0.1:18302/v1:qwen2.5-3b`) because no Anthropic key is set; this also keeps transcripts on-machine. Set `CTC_LLM=anthropic:<model>` to switch.
- 2026-10-20 — Hook suggests, never blocks. Router abstains rather than returning a weak top-1.
- 2026-10-20 — Eval data: SkillRet (main), MetaTool (abstain), SRA-Bench, ToolRet, own transcripts (held-out truth; test queries never come from the enricher).
- 2026-10-20 — graphify is dev tooling only (navigation for agents), not part of the product; `graphify-out/` stays untracked.
