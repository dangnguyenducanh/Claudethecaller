# Contract: module signatures (m7)

Only these cross-ticket signatures may be relied on within a wave. Everything else is private to its ticket.

## `ctc.memory.tags` (O1)

```python
TAG_NAMES: tuple[str, ...]          # private, claude-mem-context, ctc-memory-context, system_instruction, system-instruction,
                                    # persisted-output, system-reminder
def strip_tags(text: str) -> str    # balanced, linear; > 100 tags only logs (every tag still stripped); an unbalanced opener
                                    # strips to the end (deliberate divergence from claude-mem, which leaves it); result .strip()ed
```

Used by `hooks._prompt` (O1), `ai/extract.py` (O1), `ingestion/history.py` (O1) and `memory/observe.py` (O2).

## `ctc.llm.client` (O1)

```python
def _redact(text: str) -> str       # existing name; gains every claude-mem builtin (aws, github_pat, slack, jwt, stripe, google, PEM
                                    # incl. an unterminated PEM) and the generic *_PASSWORD/_TOKEN/_SECRET/_API_KEY patterns
```

## `ctc.memory.observations` (O3, read side)

```python
OBS_TYPES: tuple[str, ...]          # the 9 types, mode order
async def search(st, user_id: str, project_ids: list[str], *, query: str | None, kind: str = "all", obs_type: list[str] | None = None,
                 concepts: list[str] | None = None, files: list[str] | None = None, date_start=None, date_end=None,
                 limit: int = 20, order_by: str | None = None) -> dict            # {"observations": [...], "summaries": [...]}
async def timeline(st, user_id: str, project_ids: list[str], anchor: int | str | None = None, query: str | None = None,
                   depth_before: int = 3, depth_after: int = 3) -> list[dict]      # FeedItem dicts, anchor flagged
async def get_many(st, user_id: str, project_ids: list[str], ids: list[int | str]) -> dict  # ordered; {"observations","summaries","omitted"}
async def feed(st, user_id: str, project_ids: list[str], *, session_id=None, types=None, q=None, range_: str | None = None,
               before: str | None = None, after: str | None = None, limit: int = 50) -> list[dict]
async def feed_counts(st, user_id: str, project_ids: list[str], *, session_id=None, range_=None, q=None) -> dict[str, int]
async def refresh_context(st, user_id: str, project_id: str) -> str   # render + set ctx: key; returns the body (no header)
async def context_text(st, user_id: str, project_id: str, project_name: str) -> str  # header + body (cache first), wrapped
def render_index_text(...) / render_get_text(...) / render_timeline_text(...)      # MCP text formats (pure, tested)
def ctx_key(user_id: str, project_id: str) -> str                      # "ctx:{user}:{project_id}"
async def soft_delete(st, user_id: str, table: Literal["observations", "session_summaries"], id: int, restore: bool = False) -> dict | None
                                                                       # also drops ctx: key; table asserted against a whitelist
# order_by, range_, kind and table pick SQL fragments: map them through fixed dicts (range_ → a bound %s::interval) and raise
# ValueError on anything else; never interpolate caller input into SQL
```

Used by O2 (`refresh_context`, imported lazily), O4 (`context_text`), O5 (`search`, `timeline`, `get_many`, `render_*`) and O6 (all of it).

## `ctc.memory.observe` (O2, write side)

```python
async def run_job(st, payload: dict, progress) -> dict   # jobs handler "observe"; payload {session_id, project_id, user_id, transcript_path, final, upto}
def read_turns(path: str, start: int, upto: int) -> tuple[list[dict], int, int]   # turns, new byte offset, typed prompts seen (pure, tested);
                                                                                   # reads through the last \n at or before upto
def build_prompt(mode: dict, turn: dict, prior_titles: list[str], chunk: list[dict], with_summary: bool) -> str
def parse_reply(text: str, mode: dict) -> tuple[list[dict], dict | None, bool]  # observations, summary, parsed_ok
def content_hash(session_id: str, title: str, narrative: str) -> str
```

`jobs.py`: `HANDLERS["observe"] = "ctc.memory.observe:run_job"`, and `observe` is added to `UNTIMED` (each call has its own 120 s timeout).

## Tests replace

- `ctc.graph.extract._call` (a fake claude reply, as in `tests/test_graph_extract.py`);
- `st.embedder.embed` (deterministic vectors);
- `observations.refresh_context`, within O2's tests, through `monkeypatch.setitem(sys.modules, 'ctc.memory.observations', SimpleNamespace(refresh_context=fake))`: O3 writes that module in the same wave, so it may not import yet.

`observations.py` must not import `ctc.server.*` at module level (`hooks.py` imports it in O4: circular). `observations.ctx_key(user_id, project_id)` is also used by `api.py` (O6) to drop the key when a session or project is deleted.
