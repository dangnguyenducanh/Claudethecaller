"""Abstain gate (PLAN.md "AI integration flow" step 4): P(a suggestion is right) from search-stage features.

K2 trains the model and saves `{"model": LogisticRegression, "threshold": float, "features": FEATURES}` with joblib
to cfg()["gate_path"]. No file (or a broken one) = no gate: search abstains only when it has nothing.

m8 candidates (judged by `evaluation.retrieval_eval tune`, not wired into search): `margin` (clear winner), `platt` and
`isotonic` (a calibrated P over the top first-stage score). The score is stages["fused"] under ranking.fusion: score,
else the dense cosine.
"""

from __future__ import annotations

import logging
import os
import re
from functools import lru_cache

import joblib
import numpy as np
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression

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


def first_scores(res) -> tuple[float, float]:
    """(top1, top2) first-stage score over the reranked hits, in [0, 1]: stages["fused"] when present, else the dense cosine."""
    vals = []
    for h in res.considered:
        v = h.stages.get("fused")
        vals.append(min(max(v if v is not None else (h.stages.get("dense") or 0.0), 0.0), 1.0))
    top = sorted(vals, reverse=True) + [0.0, 0.0]
    return top[0], top[1]


def margin(top1, top2, ratio: float):
    """Clear-winner gate: fire only if top1 >= ratio * top2 (and there is a top1). Scalars or arrays."""
    return (top1 > 0) & (top1 >= ratio * top2)


def _two_classes(scores, y) -> tuple[np.ndarray, np.ndarray]:
    s, y = np.clip(np.asarray(scores, dtype=np.float64), 0.0, 1.0), np.asarray(y).astype(int)
    if len(set(y.tolist())) < 2:
        raise ValueError("calibration needs both classes (positives and negatives); got a single label")
    return s, y


def fit_platt(scores, y) -> LogisticRegression:
    """Platt scaling: logistic on the score with Platt's smoothed targets (n+ + 1)/(n+ + 2) and 1/(n- + 2).
    sklearn takes hard labels, so each row is added twice (as 1 with weight t, as 0 with weight 1 - t); C is huge: no shrinkage.
    ponytail: unweighted classes, so P follows the labelled mix (not production's); the threshold is chosen on false-trigger, so only P's scale shifts."""
    s, y = _two_classes(scores, y)
    n1 = y.sum()
    t = np.where(y == 1, (n1 + 1) / (n1 + 2), 1 / (len(y) - n1 + 2))
    return LogisticRegression(C=1e6, max_iter=1000).fit(np.r_[s, s].reshape(-1, 1), np.r_[np.ones(len(s)), np.zeros(len(s))], sample_weight=np.r_[t, 1 - t])


def fit_isotonic(scores, y) -> IsotonicRegression:
    s, y = _two_classes(scores, y)
    return IsotonicRegression(out_of_bounds="clip").fit(s, y)  # a score past the fitted range gets the end value, never NaN


def calibrate(model, scores) -> np.ndarray:
    """P(positive) from a fit_platt / fit_isotonic model; scores are clipped to [0, 1] first."""
    s = np.clip(np.asarray(scores, dtype=np.float64), 0.0, 1.0)
    return model.predict_proba(s.reshape(-1, 1))[:, 1] if hasattr(model, "predict_proba") else model.predict(s)


def ece(p, y, bins: int = 10) -> float:
    """Expected calibration error: equal-width bins, |mean(y) - mean(p)| per bin weighted by the bin's share of rows."""
    p, y = np.clip(np.asarray(p, dtype=np.float64), 0.0, 1.0), np.asarray(y, dtype=np.float64)
    b = np.minimum((p * bins).astype(int), bins - 1)
    return float(sum(abs(y[b == i].mean() - p[b == i].mean()) * (b == i).sum() for i in range(bins) if (b == i).any()) / len(p))
