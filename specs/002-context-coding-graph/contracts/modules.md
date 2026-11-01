# Contract: module interfaces between tickets

Tickets in the same wave code against these signatures; the owner of each module may add private helpers but not change these. Node/edge dicts use the column names of [data-model.md](../data-model.md).

```python
# graph/db.py (T01)
Node = dict  # {id, kind, type, label, text, source_file, source_line, origin, meta}  (content_hash filled by db)
Edge = dict  # {src, dst, relation, confidence, score, origin}
async def replace_origin(store, user_id: str, project_id: str, origin: str, nodes: list[Node], edges: list[Edge],
                         files: list[str] | None = None) -> None
    # delete this origin's nodes (limited to source_file in files when given) and edges whose src is one of them,
    # then insert; never touches origin review/session rows; then deletes dangling edges
async def upsert_edges(store, user_id, project_id, edges: list[Edge]) -> None      # review/session rows win
async def set_confidence(store, user_id, project_id, src, dst, relation, confidence: str, origin: str) -> bool
async def need_embedding(store, user_id, project_id) -> list[tuple[str, str]]     # (id, label + "\n" + text)
async def set_embeddings(store, user_id, project_id, rows: list[tuple[str, np.ndarray]]) -> None
async def get_source(store, user_id, project_id, source) -> dict | None           # {version, info, updated_at}
async def set_source(store, user_id, project_id, source, version: str, info: dict | None = None) -> None
async def counts(store, user_id, project_id) -> dict  # {nodes: {kind: {type: n}}, edges: {confidence: n}, tasks_linked: float | None}
async def load_rows(store, user_id, project_id) -> tuple[list[dict], list[dict], list[tuple[str, np.ndarray]]]

# graph/core.py (T01)
@dataclass
class Graph: version, nodes, out, inc, by_file, ids, vecs   # see data-model "RAM graph"
    def nearest(self, qv: np.ndarray, k: int, kind: str | None = None, types: set[str] | None = None) -> list[tuple[str, float]]
    def neighbours(self, node_id: str, relations: set[str] | None = None, direction: str = "both") -> list[tuple[str, str, str, float]]
    def code_for(self, ctx_id: str, k: int = 3) -> list[tuple[str, str, float]]   # (code id, confidence, score) ranked
    def context_for_file(self, path: str) -> list[str]                            # ctx ids linked to any node of path
async def load(store, user_id, project_id) -> Graph
async def graph_for(st, cwd: str, user_id: str = "local") -> Graph | None  # RAM cache in st.graphs; None if no rows
def invalidate(st, user_id: str, project_id: str) -> None

# graph/importer.py (T01)
def read_graphify(path: Path) -> tuple[list[Node], list[Edge], str]   # (nodes, edges, built_at_commit); pure
async def import_graphify(store, user_id, project_id, repo: Path, force: bool = False) -> dict  # {nodes, edges, built_at, skipped}
def graphify_stale(repo: Path, known: str | None) -> bool               # stat + read built_at_commit only

# graph/parse.py (T02) — pure, no DB, no network
def parse_repo(repo: Path, files: list[str] | None = None) -> tuple[list[Node], list[Edge]]
    # all context sources (or only these repo-relative files); origin "parser"; ids per data-model
    # EXTRACTED bridge edges for file paths named in tasks/tickets: dst "file:<path>" placeholders are resolved by T03
def summary(nodes) -> dict  # {stories, requirements, criteria, tasks, tickets, decisions, plan_steps, prds, features}

# graph/build.py (T03) — job kind "graph_build"
async def run_job(st, payload: dict, progress) -> dict
    # payload {cwd, files?: [rel], tick?: {session_id, file, tasks: [T###]}, commits?: bool = True, embed?: bool = True}
    # returns {"summary": parse.summary(...), "links": {...}, "tasks_linked": p}
async def build(store, embedder, repo: Path, user_id="local", files=None, commits=True, embed=True) -> dict  # CLI + eval entry

# graph/extract.py (T04) — job kind "graph_extract"
async def run_job(st, payload: dict, progress) -> dict   # payload {cwd, files?: [rel]}; {chunks, sent, skipped, tokens, quota_until}

# graph/push.py (T06)
def prompt_line(g: Graph, qv: np.ndarray, cfg: dict) -> str     # "" when below floor / no code link
def file_note(g: Graph, path: str, cfg: dict) -> str            # "" when nothing links

# graph/query.py (T05)
def search(g, qv, graph="both", k=8) -> dict ; def explain(g, node) -> dict ; def affected(g, node) -> dict ; def path(g, a, b) -> dict
```

**Placeholder resolution** (T02 → T03): the parser cannot see the code graph, so a path named in a task becomes an edge to `file:<repo-relative path>`; `build` rewrites it to the graphify file node for that path (the code node with that `source_file`, `label` = the basename and `source_line` 1, e.g. `code:src_ctc_server_hooks` for `src/ctc/server/hooks.py`) or, with a `::symbol` suffix, to the code node in that file whose label is `symbol()` or `symbol`; unresolved targets are counted (`unresolved`) and dropped.
