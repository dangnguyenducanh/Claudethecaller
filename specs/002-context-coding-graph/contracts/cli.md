# Contract: `ctc graph` CLI

Sub-app `graph = typer.Typer(no_args_is_help=True, help="Context + coding graph (m6).")`, `app.add_typer(graph, name="graph")`. Every command runs in the current repo (`cwd` = `Path.cwd()`), one `asyncio.run` per command, opens `Store` with `pool_max=1` like `ctc history`, and honours `CTC_DATABASE_URL` (tests and Done-when checks point it at the scratch DB).

| Command | Owner | Does | Prints (exit 0) |
|---|---|---|---|
| `ctc graph import` | T01 | read `graphify-out/graph.json`, replace origin `graphify`, set source `graphify` = built_at_commit | `coding: <n> nodes, <m> edges · built_at <sha8> · HEAD <sha8>`; exit 1 with a one-line reason if graph.json is missing/unreadable |
| `ctc graph status` | T01 | read counts + sources | per kind node/edge counts, graphify built_at vs HEAD (`stale` when different), each source's age, share of tasks with ≥ 1 code link (`n/a` before T03) |
| `ctc graph build [--no-commits] [--no-embed]` | T03 | import (if stale) → parse all context sources → claude-mem → embed changed nodes → links | the T02 counts (stories, requirements, criteria, tasks, tickets, decisions, plan steps, prds) + `links: <n> extracted, <m> inferred` + `tasks linked: <p>%` |
| `ctc graph confirm <src> <dst> <relation> keep\|drop` | T03 | set CONFIRMED / DROPPED, origin `review` | `kept` / `dropped`; exit 1 if the edge does not exist |
| `ctc graph extract [--file PATH]` | lead (calls T04) | run the extractor job inline for changed chunks | `chunks: <n> changed, <k> sent, <s> skipped · tokens <in>/<out>` or `quota until <time>` |
| `ctc graph export --kind context\|coding\|both [--out PATH]` | lead (calls T05) | write graphify `graph.json` shape | the output path (default `graphify-out/ctc-<kind>.json`, untracked) |
| `ctc install [--dry-run]` | T06 | also adds PreToolUse `Read\|Edit\|Write\|MultiEdit` → `/v1/hook/pre` | existing output |
