"""TEI reranker client."""

from __future__ import annotations

import os

import httpx


class Reranker:
    def __init__(self, base_url: str | None = None):
        self.base_url = (base_url or os.environ.get("CTC_TEI_RERANK_URL", "http://127.0.0.1:18301")).rstrip("/")

    async def score(self, query: str, docs: list[str]) -> list[float]:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(f"{self.base_url}/rerank", json={"query": query, "texts": docs})
            resp.raise_for_status()
            ranked = resp.json()
        ranked.sort(key=lambda r: r["index"])
        return [r["score"] for r in ranked]
