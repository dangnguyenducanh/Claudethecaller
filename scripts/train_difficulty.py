"""A2 (PLAN.md): label own-eval DEV prompts with llm.json -> {difficulty, model_tier}, embed them ("query"), fit two
LogisticRegression models, joblib.dump {"difficulty": clf, "model_tier": clf} -> models/difficulty.joblib, which
decision/bundle.py loads and predicts from with the prompt's query vector (unit-normalized first, so a raw or a
blended vector both work).

Dev rows only (split 0): the test rows stay held out. Labels are cached in data/processed/difficulty-labels.jsonl, one
row per prompt id, appended as they come, so an interrupted run resumes. A class with < 2 rows can't be learned or
cross-validated: it is folded into its neighbour toward the default (trivial -> standard, critical -> complex -> ...,
haiku/opus -> sonnet); if one class is left, that model is a constant DummyClassifier.
Labels come from the local 3B judge, not a human: noisy, like the K1 golds.

    uv run python scripts/train_difficulty.py
"""

from __future__ import annotations

import asyncio
import json
from collections import Counter
from typing import Literal

import joblib
import numpy as np
from pydantic import BaseModel
from sklearn.dummy import DummyClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold, cross_val_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import Normalizer

from ctc.config import ROOT, cfg
from ctc.decision.bundle import DIFFICULTY_PATH
from ctc.embedding.embedder import Embedder
from ctc.llm.client import Llm

EVAL, LABELS = ROOT / "data/processed/own-eval.jsonl", ROOT / "data/processed/difficulty-labels.jsonl"
ORDER = {"difficulty": ["trivial", "standard", "complex", "critical"], "model_tier": ["haiku", "sonnet", "opus"]}
DEFAULT = {"difficulty": "standard", "model_tier": "sonnet"}  # what bundle.py answers without a model

SYSTEM = """You triage one request a developer typed to a coding assistant (it may be in any language, or a short follow-up in a longer conversation). Answer with JSON:
- difficulty: "trivial" (chit-chat, thanks, a yes/no or one-line answer, a quick lookup), "standard" (one focused change, explain or review some code, run a known command), "complex" (a multi-file feature, debugging across components, architecture, design or planning), "critical" (touches production, security, credentials, data loss, migrations, or anything irreversible or costly).
- model_tier: the cheapest model that would handle it well: "haiku" (trivial or mechanical work), "sonnet" (most coding work), "opus" (hard reasoning, long multi-step work, high stakes)."""


class Label(BaseModel):
    difficulty: Literal["trivial", "standard", "complex", "critical"]
    model_tier: Literal["haiku", "sonnet", "opus"]


def label(rows: list[dict], llm: Llm) -> list[dict]:
    done: dict[str, dict] = {}
    for line in LABELS.read_text().splitlines() if LABELS.exists() else []:
        try:
            r = json.loads(line)
            done[r["id"]] = r
        except (ValueError, KeyError):  # a line cut short by a kill mid-write: that prompt gets labelled again
            pass
    with LABELS.open("a") as f:
        for i, r in enumerate(rows, 1):
            if r["id"] in done:
                continue
            y = llm.json(SYSTEM, r["query"][:4000], Label)  # sequential: llama-server has one slot
            done[r["id"]] = row = {"id": r["id"], "query": r["query"], **y.model_dump()}
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            f.flush()
            print(f"{i}/{len(rows)} {y.difficulty:8} {y.model_tier:6} {r['query'][:70]!r}")
    return [done[r["id"]] for r in rows]


def fold_rare(y: list[str], order: list[str], default: str) -> list[str]:
    while True:
        c = Counter(y)
        rare = [k for k in order if 0 < c[k] < 2]
        if not rare or len(c) == 1:
            return y
        k = rare[0]
        i, d = order.index(k), order.index(default)
        to = order[i + (d > i) - (d < i)] if i != d else max((x for x in c if x != k), key=c.get)
        print(f"  fold {k} ({c[k]} row) -> {to}")
        y = [to if v == k else v for v in y]


async def embed(texts: list[str]) -> np.ndarray:
    e = Embedder(cfg()["embed_url"], cfg()["batch_timeout_s"])
    try:
        return np.vstack([await e.embed(texts[i : i + 32], "query") for i in range(0, len(texts), 32)])  # TEI: <= 32 per call
    finally:
        await e.aclose()


def main() -> None:
    rows = [r for r in map(json.loads, EVAL.read_text().splitlines()) if r["split"] == 0]  # 0 = dev, 1 = test
    labels = label(rows, Llm(cfg()["llm"]))
    x = asyncio.run(embed([r["query"] for r in rows]))
    models = {}
    for key, order in ORDER.items():
        raw = [r[key] for r in labels]
        print(f"{key}: {dict(sorted(Counter(raw).items(), key=lambda kv: order.index(kv[0])))}")
        y = fold_rare(raw, order, DEFAULT[key])
        if len(set(y)) == 1:
            models[key] = DummyClassifier(strategy="constant", constant=y[0]).fit(x, y)
            print(f"  one class left ({y[0]}): constant model")
            continue
        clf = make_pipeline(Normalizer(), LogisticRegression(max_iter=2000, class_weight="balanced"))
        cv = cross_val_score(clf, x, y, cv=StratifiedKFold(5, shuffle=True, random_state=0))
        base = max(Counter(y).values()) / len(y)
        print(f"  5-fold CV accuracy {cv.mean():.3f} ± {cv.std():.3f} (majority class {base:.3f}, n={len(y)})")
        models[key] = clf.fit(x, y)
    DIFFICULTY_PATH.parent.mkdir(exist_ok=True)
    joblib.dump(models, DIFFICULTY_PATH)
    m = joblib.load(DIFFICULTY_PATH)
    assert set(m) == {"difficulty", "model_tier"}
    pred = [(str(m["difficulty"].predict(v[None])[0]), str(m["model_tier"].predict(v[None])[0])) for v in (x[0], x[0] * 3)]
    assert pred[0] == pred[1] and pred[0][0] in ORDER["difficulty"] and pred[0][1] in ORDER["model_tier"], pred  # scale-free
    print(f"wrote {DIFFICULTY_PATH}")


if __name__ == "__main__":
    main()
