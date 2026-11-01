"""Per-worker daemon state: one Store pool, one Cache, keep-alive model clients, the offline LLM (PLAN.md B5)."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from ctc.config import cfg
from ctc.embedding.embedder import Embedder
from ctc.llm.client import Llm
from ctc.reranking.reranker import Reranker
from ctc.retrieval.hybrid import Ctx
from ctc.storage.cache import Cache
from ctc.storage.store import Store


@dataclass
class State:
    cfg: dict
    store: Store
    cache: Cache
    embedder: Embedder
    reranker: Reranker
    llm: Llm
    names: dict[tuple[str, str], str] = field(default_factory=dict)  # (user_id, project_id) -> project name
    tasks: list[asyncio.Task] = field(default_factory=list)  # writer, job worker, invalidation subscriber
    graphs: dict = field(default_factory=dict)  # (user_id, project_id) -> ctc.graph.core.Graph (m6)

    def ctx(self, cwd: str, user_id: str = "local") -> Ctx:
        return Ctx(self.store, self.embedder, self.reranker, cwd, user_id)


async def open_state(c: dict | None = None) -> State:
    c = c or cfg()
    if not c["database_url"]:
        raise RuntimeError("CTC_DATABASE_URL is not set: put the Supabase session-pooler URL in .env (PLAN.md H0)")
    store = await Store.open(c["database_url"], pool_min=c["db_pool"]["min"], pool_max=c["db_pool"]["max"])
    cache = Cache(c["redis_url"], c["cache"])
    await cache.start()
    return State(c, store, cache, Embedder(c["embed_url"], c["timeout_s"]), Reranker(c["rerank_url"], c["timeout_s"]), Llm(c["llm"]))


async def close_state(st: State) -> None:
    for t in st.tasks:
        t.cancel()
    await asyncio.gather(*st.tasks, return_exceptions=True)
    await st.cache.close()
    await st.store.close()
    await st.embedder.aclose()
    await st.reranker.aclose()
