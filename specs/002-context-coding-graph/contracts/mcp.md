# Contract: MCP pull tools (`/mcp`, `src/ctc/server/mcp.py`, T05)

All four are read-only, resolve the project from the request (`ctx` cwd is not sent over MCP, so they take an optional `project` = project name or path; default: the project of the most recent session of this user **[call]**), and return `CallToolResult` with a text body ≤ ~1,500 tokens plus `structured_content`. Text ends with `(truncated: <n> more)` when cut. Unknown node → `ToolError("no node matching '<x>'")`; several matches → the error lists up to 5 ids.

| Tool | Args | Returns |
|---|---|---|
| `graph_search` | `question: str, graph: 'context'\|'coding'\|'both' = 'both', k: int = 8, project: str \| None` | top-k nodes by cosine (prompt embedded with kind="query"), each with 1-hop neighbours across the bridge (context→code via implemented_in/tested_by, code→context reverse), ranked CONFIRMED > EXTRACTED > INFERRED |
| `graph_explain` | `node: str` (id, or label/path match), `project` | the node, its text, and up to 20 neighbours grouped by relation |
| `graph_affected` | `node: str`, `project` | reverse traversal on code edges (`calls, imports, imports_from, uses, inherits, references`, depth ≤ 3) plus every context node linked to any hit |
| `graph_path` | `a: str, b: str`, `project` | shortest undirected path (BFS, ≤ 6 hops) as `a -rel-> x -rel-> b`, or `no path within 6 hops` |
