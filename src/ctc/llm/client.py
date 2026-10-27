"""LLM client (llama-server or Anthropic) with secret redaction."""

from __future__ import annotations

import json
import os
import re

from pydantic import BaseModel

_Q = r"""(?:\\{0,3}["'])?"""  # an optional quote, possibly JSON-escaped
_V = r"(?=[A-Za-z0-9_.\-+/=~@#$%^*!?]{8})[A-Za-z0-9_.\-+/=~@#$%^*!?]*[A-Za-z][A-Za-z0-9_.\-+/=~@#$%^*!?]*"  # >= 8 value chars, one a letter
# Patterns of claude-mem 15.2.1 src/utils/redaction.ts (Apache-2.0, © 2026 Alex Newman), generic ones on (cloud store); re has no variable-width lookbehind, so a keyed value keeps its key in group `k`.
_SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_-]{16,}"),
    re.compile(r"hf_[A-Za-z0-9]{16,}"),
    re.compile(r"(?i)bearer\s+[A-Za-z0-9\-_.]{10,}"),
    re.compile(r"://[^/\s:@]+:[^/\s@]+@"),  # user:pass@ credential URLs
    re.compile(r"(?:AKIA|ASIA)[0-9A-Z]{16}"),
    re.compile(r"(?i)(?P<k>AWS_SECRET_ACCESS_KEY\s{0,8}[=:]\s{0,8}['\"]?)[A-Za-z0-9/+=]{40}"),
    re.compile(rf"(?i)(?P<k>\b(?:aws_session_token|SessionToken){_Q}\s{{0,8}}[=:]\s{{0,8}}{_Q})[A-Za-z0-9/+=]{{100,}}"),
    re.compile(r"\bgh[oprsu]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{82}\b"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}(?!\w)"),
    re.compile(r"\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?!\w)"),
    # a PEM key, also one with no END line (cut off or still being written): redacted to the end of the text
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY[^-]*-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY[^-]*-----|\Z)"),
    re.compile(r"\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b"),
    re.compile(r"\bAIza[0-9A-Za-z_-]{35}(?!\w)"),
    re.compile(r"\bcmem_[A-Za-z0-9_-]{32,}|\bcm_pro_[A-Za-z0-9_-]{8,}"),
    re.compile(rf"(?i)(?P<k>\b(?:\w*_?(?:password|passwd)|\w+_pwd){_Q}\s{{0,8}}[=:]\s{{0,8}}{_Q}){_V}"),
    re.compile(rf"(?i)(?P<k>\b\w*_(?:token|secret|api_key){_Q}\s{{0,8}}[=:]\s{{0,8}}{_Q}){_V}"),
    re.compile(rf"(?i)(?P<k>\bAuthorization{_Q}\s{{0,8}}:\s{{0,8}}{_Q}Bearer\s{{0,8}}){_V}"),
]


def _redact(text: str) -> str:
    for pat in _SECRET_PATTERNS:
        text = pat.sub(lambda m: (m.groupdict().get("k") or "") + "[REDACTED]", text)
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
