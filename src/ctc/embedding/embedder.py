"""TEI embedder client."""

from __future__ import annotations

import asyncio
import os
from typing import Literal

import httpx
import numpy as np

# Qwen3-Embedding-style instruction prefix (SKILLRET-Embedding-0.6B is fine-tuned from it); docs get no prefix.
QUERY_INSTRUCTION = (
    "Instruct: Given a coding task or question, retrieve capabilities "
    "(skills, agents, commands, workflows) that help accomplish it\nQuery: "
)


class Embedder:
    def __init__(self, base_url: str | None = None, timeout: float = 30):
        self.base_url = (base_url or os.environ.get("CTC_TEI_EMBED_URL", "http://127.0.0.1:18300")).rstrip("/")
        self.timeout = timeout
        self.model_version: str = ""
        self.dim: int = 0
        self._client: httpx.AsyncClient | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    def client(self) -> httpx.AsyncClient:
        """One keep-alive client per event loop (the CLI runs several `asyncio.run`s; the daemon runs one loop)."""
        loop = asyncio.get_running_loop()
        if self._client is None or self._loop is not loop:
            self._client, self._loop = httpx.AsyncClient(timeout=self.timeout), loop
        return self._client

    async def embed(self, texts: list[str], kind: Literal["query", "doc"]) -> np.ndarray:
        inputs = [QUERY_INSTRUCTION + t for t in texts] if kind == "query" else texts
        client = self.client()
        if not self.model_version:
            info = await client.get(f"{self.base_url}/info")
            info.raise_for_status()
            self.model_version = info.json().get("model_id", self.base_url)
        resp = await client.post(f"{self.base_url}/embed", json={"inputs": inputs})
        resp.raise_for_status()
        vecs = np.array(resp.json(), dtype="float32")
        self.dim = vecs.shape[1]
        return vecs

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
