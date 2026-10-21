"""Smoke-run the three model servers: embed, rerank, one Llm.json call."""

import asyncio

from pydantic import BaseModel

from ctc.embedding.embedder import Embedder
from ctc.llm.client import llm_from_env
from ctc.reranking.reranker import Reranker


async def main() -> None:
    class _Ping(BaseModel):
        ok: bool

    embedder, reranker, llm = Embedder(), Reranker(), llm_from_env()
    vecs = await embedder.embed(["fix a flaky test", "write a changelog"], kind="query")
    print(f"embedded {vecs.shape[0]} texts, dim={vecs.shape[1]}, model={embedder.model_version}")
    scores = await reranker.score("fix a flaky test", ["retry logic for CI", "a cooking recipe"])
    print(f"reranked {len(scores)} docs: {scores}")
    result = llm.json(
        "Reply with ok=true.", "Confirm you are working.", _Ping
    )
    print(f"Llm.json ({llm.spec}): {result.model_dump_json()}")


if __name__ == "__main__":
    asyncio.run(main())
