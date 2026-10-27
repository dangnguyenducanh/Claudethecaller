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

# m8 knobs: the defaults are the behaviour before they existed, so an older config file still loads
_DEFAULTS = {"embed": {"text": "current", "instruction": "coding", "skillret_body_chars": 8000},
             "ranking": {"fusion": "rrf", "score_w": 0.7, "rerank_by": "sigmoid"},
             "gate": {"kind": "off", "margin_ratio": 1.5, "min_p": 0.5}}
_ALLOWED = {("embed", "text"): ("current", "skillret"), ("embed", "instruction"): ("coding", "skillret"),
            ("ranking", "fusion"): ("rrf", "score"), ("ranking", "rerank_by"): ("sigmoid", "logit"),
            ("gate", "kind"): ("off", "margin", "platt", "isotonic", "lr")}


@cache
def cfg() -> dict:
    """models.yaml + retrieval.yaml + server.yaml as one flat-at-the-top dict; paths under `~` expanded."""
    load_dotenv(ROOT / ".env")
    out: dict = {"database_url": None}
    for name in ("models", "retrieval", "server"):
        out.update(yaml.safe_load((ROOT / "config" / f"{name}.yaml").read_text()) or {})
    for sec, defaults in _DEFAULTS.items():
        out[sec] = out.get(sec) or {}
        for key, val in defaults.items():
            out[sec].setdefault(key, val)
    if out["gate"]["kind"] is False:  # YAML 1.1 reads a bare `off` as False
        out["gate"]["kind"] = "off"
    for (sec, key), allowed in _ALLOWED.items():  # a typo fails at load, not at the first query
        if out[sec][key] not in allowed:
            raise ValueError(f"{sec}.{key}: {out[sec][key]!r} is not one of {', '.join(allowed)}")
    for env, (key, cast) in _ENV.items():
        if os.environ.get(env):
            out[key] = cast(os.environ[env])
    if not os.environ.get("CTC_LLM") and os.environ.get("ANTHROPIC_API_KEY"):
        out["llm"] = "anthropic:claude-haiku-5-5"
    for key in ("socket", "claude_home", "trash_dir"):
        out[key] = str(Path(out[key]).expanduser())
    out["gate_path"] = str(ROOT / out["gate_path"])
    return out
