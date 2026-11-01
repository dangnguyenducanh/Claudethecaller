"""TEI reranker client."""

from __future__ import annotations

import asyncio
import math
import os

import httpx


def sigmoid(x: float) -> float:
    """1 / (1 + e^-x) without OverflowError for large |x| (exp of a positive argument is the only thing that can overflow)."""
    if x >= 0:
        return 1 / (1 + math.exp(-x))
    e = math.exp(x)
    return e / (1 + e)


class Reranker:
    def __init__(self, base_url: str | None = None, timeout: float = 30):
        self.base_url = (base_url or os.environ.get("CTC_TEI_RERANK_URL", "http://127.0.0.1:18301")).rstrip("/")
        self.timeout = timeout
        self._client: httpx.AsyncClient | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    def client(self) -> httpx.AsyncClient:
        """One keep-alive client per event loop, like Embedder."""
        loop = asyncio.get_running_loop()
        if self._client is None or self._loop is not loop:
            self._client, self._loop = httpx.AsyncClient(timeout=self.timeout), loop
        return self._client

    async def score_with_logits(self, query: str, docs: list[str]) -> list[tuple[float, float]]:
        """(sigmoid, logit) per doc, in `docs` order. TEI applies the sigmoid itself unless raw_scores is set; asking for
        the raw logit and squashing here keeps the (0, 1) scale every consumer reads and keeps the logit's spacing."""
        resp = await self.client().post(f"{self.base_url}/rerank", json={"query": query, "texts": docs, "raw_scores": True})
        resp.raise_for_status()
        ranked = resp.json()
        ranked.sort(key=lambda r: r["index"])
        return [(sigmoid(r["score"]), r["score"]) for r in ranked]

    async def score(self, query: str, docs: list[str]) -> list[float]:
        return [s for s, _ in await self.score_with_logits(query, docs)]

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
