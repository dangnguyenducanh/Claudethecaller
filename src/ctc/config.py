"""Config: config/*.yaml merged into one dict, `.env` loaded, env vars override (PLAN.md B3)."""

from __future__ import annotations

import os
from functools import cache
from pathlib import Path

import yaml
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]

# env var -> (top-level key, cast)
_ENV = {
    "CTC_DATABASE_URL": ("database_url", str),
    "CTC_REDIS_URL": ("redis_url", str),
    "CTC_TEI_EMBED_URL": ("embed_url", str),
    "CTC_TEI_RERANK_URL": ("rerank_url", str),
    "CTC_LLM": ("llm", str),
    "CTC_MODE": ("mode", str),
    "CTC_PORT": ("port", int),
    "CTC_SOCKET": ("socket", str),
    "CTC_CLAUDE_HOME": ("claude_home", str),
}


@cache
def cfg() -> dict:
    """models.yaml + retrieval.yaml + server.yaml as one flat-at-the-top dict; paths under `~` expanded."""
    load_dotenv(ROOT / ".env")
    out: dict = {"database_url": None}
    for name in ("models", "retrieval", "server"):
        out.update(yaml.safe_load((ROOT / "config" / f"{name}.yaml").read_text()) or {})
    for env, (key, cast) in _ENV.items():
        if os.environ.get(env):
            out[key] = cast(os.environ[env])
    if not os.environ.get("CTC_LLM") and os.environ.get("ANTHROPIC_API_KEY"):
        out["llm"] = "anthropic:claude-haiku-5-5"
    for key in ("socket", "claude_home", "trash_dir"):
        out[key] = str(Path(out[key]).expanduser())
    out["gate_path"] = str(ROOT / out["gate_path"])
    return out
