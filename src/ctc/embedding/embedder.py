"""TEI embedder client."""

from __future__ import annotations

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
    def __init__(self, base_url: str | None = None):
        self.base_url = (base_url or os.environ.get("CTC_TEI_EMBED_URL", "http://127.0.0.1:18300")).rstrip("/")
        self.model_version: str = ""
        self.dim: int = 0

    async def embed(self, texts: list[str], kind: Literal["query", "doc"]) -> np.ndarray:
        inputs = [QUERY_INSTRUCTION + t for t in texts] if kind == "query" else texts
        async with httpx.AsyncClient(timeout=30) as client:
            if not self.model_version:
                info = await client.get(f"{self.base_url}/info")
                info.raise_for_status()
                self.model_version = info.json().get("model_id", self.base_url)
            resp = await client.post(f"{self.base_url}/embed", json={"inputs": inputs})
            resp.raise_for_status()
            vecs = np.array(resp.json(), dtype="float32")
        self.dim = vecs.shape[1]
        return vecs
