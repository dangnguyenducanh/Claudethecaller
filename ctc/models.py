"""Clients for the local model servers: TEI embedder, TEI reranker, llama-server/Anthropic LLM."""

from __future__ import annotations

import json
import os
import re
from typing import Literal

import httpx
import numpy as np
from pydantic import BaseModel

# Qwen3-Embedding-style instruction prefix (SKILLRET-Embedding-0.6B is fine-tuned from it); docs get no prefix.
QUERY_INSTRUCTION = (
    "Instruct: Given a coding task or question, retrieve capabilities "
    "(skills, agents, commands, workflows) that help accomplish it\nQuery: "
)

_SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_-]{16,}"),
    re.compile(r"hf_[A-Za-z0-9]{16,}"),
    re.compile(r"(?i)bearer\s+[A-Za-z0-9\-_.]{10,}"),
    re.compile(r"://[^/\s:@]+:[^/\s@]+@"),  # user:pass@ credential URLs
]


def _redact(text: str) -> str:
    for pat in _SECRET_PATTERNS:
        text = pat.sub("[REDACTED]", text)
    return text


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


class Llm:
    def __init__(self, spec: str):
        self.spec = spec

    def json(self, system: str, user: str, schema: type[BaseModel]) -> BaseModel:
        system, user = _redact(system), _redact(user)
        provider, rest = self.spec.split(":", 1)
        if provider == "anthropic":
            return _anthropic_json(rest, system, user, schema)
        if provider == "openai":
            base_url, model = rest.rsplit(":", 1)
            return _openai_json(base_url, model, system, user, schema)
        raise ValueError(f"unknown LLM provider: {provider}")


def _anthropic_json(model: str, system: str, user: str, schema: type[BaseModel]) -> BaseModel:
    import anthropic

    client = anthropic.Anthropic()
    resp = client.messages.create(
        model=model,
        max_tokens=2048,
        system=system,
        messages=[{"role": "user", "content": user}],
        tools=[{"name": "emit", "description": "Return the result.", "input_schema": schema.model_json_schema()}],
        tool_choice={"type": "tool", "name": "emit"},
    )
    for block in resp.content:
        if block.type == "tool_use":
            return schema.model_validate(block.input)
    raise ValueError("no tool_use block in Anthropic response")


def _openai_json(base_url: str, model: str, system: str, user: str, schema: type[BaseModel]) -> BaseModel:
    import openai

    client = openai.OpenAI(base_url=base_url, api_key=os.environ.get("OPENAI_API_KEY", "none"))
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        response_format={
            "type": "json_schema",
            "json_schema": {"name": schema.__name__, "schema": schema.model_json_schema(), "strict": True},
        },
    )
    return schema.model_validate(json.loads(resp.choices[0].message.content))


def llm_from_env() -> Llm:
    spec = os.environ.get("CTC_LLM")
    if not spec:
        if os.environ.get("ANTHROPIC_API_KEY"):
            spec = "anthropic:claude-haiku-5-5"
        else:
            spec = "openai:http://127.0.0.1:18302/v1:qwen2.5-3b"
    return Llm(spec)


async def _demo() -> None:
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
    import asyncio

    asyncio.run(_demo())
