"""LLM client (llama-server or Anthropic) with secret redaction."""

from __future__ import annotations

import json
import os
import re

from pydantic import BaseModel

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
