"""TEI reranker client."""

from __future__ import annotations

import asyncio
import os

import httpx


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

    async def score(self, query: str, docs: list[str]) -> list[float]:
        resp = await self.client().post(f"{self.base_url}/rerank", json={"query": query, "texts": docs})
        resp.raise_for_status()
        ranked = resp.json()
        ranked.sort(key=lambda r: r["index"])
        return [r["score"] for r in ranked]

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
