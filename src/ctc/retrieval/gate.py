"""Abstain gate (PLAN.md "AI integration flow" step 4): P(a suggestion is right) from search-stage features.

K2 trains the model and saves `{"model": LogisticRegression, "threshold": float, "features": FEATURES}` with joblib
to cfg()["gate_path"]. No file (or a broken one) = no gate: search abstains only when it has nothing.
"""

from __future__ import annotations

import logging
import os
import re
from functools import lru_cache

import joblib
import numpy as np

log = logging.getLogger(__name__)

FEATURES = ["top_rerank", "top_dense", "top_rrf", "rerank_gap", "dense_gap", "sparse_hits", "prompt_tokens"]


def _top2(vals: list[float]) -> tuple[float, float]:
    v = sorted(vals, reverse=True) + [0.0, 0.0]
    return v[0], v[0] - v[1] if len(vals) > 1 else 0.0


def features(res, q: str) -> np.ndarray:
    """One row in FEATURES order, from the reranked hits (`res.considered`)."""
    hs = [h.stages for h in res.considered]
    top_rerank, rerank_gap = _top2([s["rerank"] for s in hs if s.get("rerank") is not None])
    top_dense, dense_gap = _top2([s["dense"] for s in hs if s.get("dense") is not None])
    top_rrf = max((s.get("rrf") or 0.0 for s in hs), default=0.0)
    sparse_hits = sum(s.get("sparse_rank") is not None for s in hs)
    return np.array([top_rerank, top_dense, top_rrf, rerank_gap, dense_gap, sparse_hits, len(re.findall(r"\w+", q))], dtype=np.float64)


@lru_cache(maxsize=4)
def _load(path: str, mtime_ns: int) -> dict | None:
    try:
        g = joblib.load(path)
        if not isinstance(g, dict) or list(g.get("features") or []) != FEATURES or not hasattr(g.get("model"), "predict_proba"):
            raise ValueError(f"needs {{model, threshold, features={FEATURES}}}")
        g["threshold"] = float(g["threshold"])
        return g
    except Exception:  # fail-open: a bad file turns the gate off, it never breaks search
        log.exception("abstain gate %s unusable; gate off", path)
        return None


def load(path) -> dict | None:
    """The gate at `path`, reloaded when the file changes; None when there is none."""
    try:
        mtime = os.stat(path).st_mtime_ns
    except OSError:
        return None
    return _load(str(path), mtime)


def p(gate: dict, res, q: str) -> float:
    return float(gate["model"].predict_proba(features(res, q).reshape(1, -1))[0, 1])
