---
name: ctc-context
description: "claudethecaller's context graph (specs, tickets, PLAN.md, decisions linked to code): rebuild it, show task-to-code matches, review inferred links. Run by the speckit hooks in .specify/extensions.yml (after_specify/after_plan/after_tasks: build, before_implement: matches, after_implement: review) or by hand as /ctc-context build|matches|review|status."
---

# /ctc-context

The sub-command is the first word of the arguments (none: `status`). Run from the repo root and report each command's real output.

- **build**: `uv run ctc graph extract` (the Claude pass over changed doc sections; `quota until <time>` means the usage limit is hit: say so and go on), then `uv run ctc graph build` (embeds and links what extract added). Report the counts.
- **status**: `uv run ctc graph status`.
- **matches** (before implement): `uv run ctc graph status`, then the links query below with `open`; print each open task with its code matches (`file:line symbol`, confidence). Where the MCP tool `graph_explain` is available, it can show one task's neighbours instead.
- **review** (after implement): the links query with `review` lists the feature's INFERRED `implemented_in` links whose task is ticked. For each one, read the task text and the code it points at and decide whether that code really implements the task; then run `uv run ctc graph confirm <src> <dst> implemented_in keep` (or `drop`). Report `kept <n>, dropped <m>`.

Links query (the active feature comes from `.specify/feature.json`; `open` = unticked tasks with all their live code links, `review` = ticked tasks with their INFERRED `implemented_in` links only):

```bash
uv run python - open <<'EOF'
import asyncio, json, sys
from pathlib import Path
from ctc.config import cfg
from ctc.ingestion.scanner import project_id
from ctc.storage.store import Store

feature = json.loads(Path(".specify/feature.json").read_text())["feature_directory"]
review = sys.argv[1] == "review"
SQL = """select e.src, e.dst, e.relation, e.confidence, e.score, t.label as task, c.source_file, c.source_line, c.label as code
from graph_edges e join graph_nodes t on t.user_id = e.user_id and t.project_id = e.project_id and t.id = e.src
join graph_nodes c on c.user_id = e.user_id and c.project_id = e.project_id and c.id = e.dst
where e.user_id = 'local' and e.project_id = %s and t.type = 'task' and t.meta->>'feature' = %s and c.kind = 'coding'
  and e.confidence <> 'DROPPED' and t.meta->>'status' = %s
  and (not %s or (e.relation = 'implemented_in' and e.confidence = 'INFERRED'))
order by e.src, array_position(array['CONFIRMED', 'EXTRACTED', 'INFERRED'], e.confidence), e.score desc"""

async def main():
    s = await Store.open(cfg()["database_url"], pool_min=1, pool_max=1)
    try:
        rows = await s.fetch(SQL, (project_id(Path.cwd()), feature, "[x]" if review else "[ ]", review))
        for r in rows:
            print(f"{r['src']} -> {r['dst']} {r['relation']} {r['confidence']} {r['score']:.2f} | "
                  f"{r['source_file']}:{r['source_line']} {r['code']} | {r['task'][:80]}")
        print(f"{len(rows)} links")
    finally:
        await s.close()

asyncio.run(main())
EOF
```
