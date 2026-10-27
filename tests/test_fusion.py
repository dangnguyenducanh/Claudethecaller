"""M8-3: score fusion beside RRF. `fusion: rrf` must reproduce the pre-m8 result exactly (golden), `score` is arithmetic.

No services: a fake store (candidates/overrides/get) and a fake reranker (fixed logits) drive the real hybrid.search().
"""

import asyncio
import math
from types import SimpleNamespace

import numpy as np
import pytest

from ctc.retrieval import hybrid
from ctc.retrieval.hybrid import Ctx, search

CAPS = {  # id -> (cluster, namespace)
    "user:a": (None, "user"), "user:b": ("c1", "user"), "user:c": ("c1", "user"), "user:d": (None, "user"),
    "project@zzzzzzzz:e": (None, "project@zzzzzzzz"), "user:f": (None, "user"), "user:g": (None, "user"),
    "user:h": (None, "user"), "user:i": (None, "user"), "user:j": (None, "user"),
}
DENSE = [("user:a", 0.81), ("user:b", 0.74), ("user:c", 0.73), ("project@zzzzzzzz:e", 0.70), ("user:f", 0.66),
         ("user:g", 0.62), ("user:d", 0.60), ("user:h", 0.55), ("user:ghost", 0.50)]  # ghost: not in the catalog
SPARSE = [("user:d", 0.9), ("user:i", 0.45), ("user:a", 0.30), ("user:j", 0.05), ("user:g", 0.02)]  # raw ts_rank_cd
OVERRIDES = {"user:f": "block", "user:g": "pin"}
LOGITS = {"a": -3.2, "b": -1.0, "c": 0.5, "d": 2.1, "g": -6.0, "h": -0.2, "i": -2.5, "j": -8.0}  # by cap name


def sigmoid(x: float) -> float:
    return 1 / (1 + math.exp(-x))


class FakeStore:
    def __init__(self, dense=DENSE, sparse=SPARSE, overrides=OVERRIDES):
        self.catalog = {i: {"id": i, "name": i.split(":")[-1], "description": "desc", "cluster_id": c, "namespace": ns}
                        for i, (c, ns) in CAPS.items()}
        self.dense, self.sparse, self.ovr = dense, sparse, overrides

    async def candidates(self, qv, q, k):
        return self.dense, self.sparse

    async def overrides(self, project_id, user_id="local"):
        return self.ovr

    def get(self, cap_id):
        return self.catalog[cap_id]


class FakeReranker:
    """Same contract as Reranker: score() = sigmoid, score_with_logits() = (sigmoid, logit)."""

    async def score_with_logits(self, q, docs):
        return [(sigmoid(x), x) for x in (LOGITS[d.split(":")[0]] for d in docs)]

    async def score(self, q, docs):
        return [s for s, _ in await self.score_with_logits(q, docs)]


@pytest.fixture(autouse=True)
def no_gate(monkeypatch):
    monkeypatch.setattr(hybrid, "gate", SimpleNamespace(load=lambda path: None))  # a models/abstain.joblib must not leak in


def run(ranking, store=None, rerank_top=6, k=5):
    ctx = Ctx(store or FakeStore(), None, FakeReranker(), "/tmp/ctc-fusion-test-project")
    return asyncio.run(search("fix a flaky test", ctx, qv=np.zeros(1), k=k, rerank_top=rerank_top, ranking=ranking))


def snap(res):
    """Everything the pre-m8 search() returned; rerank_logit is the only stage added by m8-2."""
    return {"hits": [(h.cap_id, h.score, {k: v for k, v in h.stages.items() if k != "rerank_logit"}) for h in res.hits],
            "considered": [h.cap_id for h in res.considered], "dropped": [(h.cap_id, why) for h, why in res.dropped],
            "abstained": res.abstained}


DROPPED = [("user:c", "duplicate of a better hit (cluster c1)"), ("project@zzzzzzzz:e", "belongs to another project"),
           ("user:f", "blocked in this project"), ("user:ghost", "not in this worker's catalog yet")]
# Captured from the UNMODIFIED search() (before m8-2/m8-3) on the pool above: (cap_id, score, stages) per returned hit.
GOLDEN = {
    "tuned": {"ranking": {"keyword_rrf_weight": 0.25, "rerank_weight": 1},  # config/retrieval.yaml today
              "hits": [("user:g", 0.03102, {"dense": 0.62, "dense_rank": 6, "sparse_rank": 5, "rrf": 0.019, "rerank": 0.0025, "final": 0.03102}),
                       ("user:d", 0.03202, {"dense": 0.6, "dense_rank": 7, "sparse_rank": 1, "rrf": 0.01902, "rerank": 0.8909, "final": 0.03202}),
                       ("user:b", 0.032, {"dense": 0.74, "dense_rank": 2, "sparse_rank": None, "rrf": 0.01613, "rerank": 0.2689, "final": 0.032}),
                       ("user:a", 0.03178, {"dense": 0.81, "dense_rank": 1, "sparse_rank": 3, "rrf": 0.02036, "rerank": 0.0392, "final": 0.03178}),
                       ("user:h", 0.03151, {"dense": 0.55, "dense_rank": 8, "sparse_rank": None, "rrf": 0.01471, "rerank": 0.4502, "final": 0.03151})],
              "considered": ["user:g", "user:d", "user:b", "user:a", "user:h", "user:i"]},
    "old": {"ranking": {"keyword_rrf_weight": 1, "rerank_weight": 1},  # the pre-2026-10-21 order
            "hits": [("user:g", 0.03126, {"dense": 0.62, "dense_rank": 6, "sparse_rank": 5, "rrf": 0.03054, "rerank": 0.0025, "final": 0.03126}),
                     ("user:b", 0.03226, {"dense": 0.74, "dense_rank": 2, "sparse_rank": None, "rrf": 0.01613, "rerank": 0.2689, "final": 0.03226}),
                     ("user:a", 0.03202, {"dense": 0.81, "dense_rank": 1, "sparse_rank": 3, "rrf": 0.03227, "rerank": 0.0392, "final": 0.03202}),
                     ("user:d", 0.03202, {"dense": 0.6, "dense_rank": 7, "sparse_rank": 1, "rrf": 0.03132, "rerank": 0.8909, "final": 0.03202}),
                     ("user:i", 0.03126, {"dense": None, "dense_rank": None, "sparse_rank": 2, "rrf": 0.01613, "rerank": 0.0759, "final": 0.03126})],
            "considered": ["user:g", "user:b", "user:a", "user:d", "user:i", "user:j"]},
    "dense": {"ranking": {"keyword_rrf_weight": 0, "rerank_weight": 0},  # dense order
              "hits": [("user:g", 0.01587, {"dense": 0.62, "dense_rank": 6, "sparse_rank": 5, "rrf": 0.01515, "rerank": 0.0025, "final": 0.01587}),
                       ("user:a", 0.01639, {"dense": 0.81, "dense_rank": 1, "sparse_rank": 3, "rrf": 0.01639, "rerank": 0.0392, "final": 0.01639}),
                       ("user:b", 0.01613, {"dense": 0.74, "dense_rank": 2, "sparse_rank": None, "rrf": 0.01613, "rerank": 0.2689, "final": 0.01613}),
                       ("user:d", 0.01562, {"dense": 0.6, "dense_rank": 7, "sparse_rank": 1, "rrf": 0.01493, "rerank": 0.8909, "final": 0.01562}),
                       ("user:h", 0.01538, {"dense": 0.55, "dense_rank": 8, "sparse_rank": None, "rrf": 0.01471, "rerank": 0.4502, "final": 0.01538})],
              "considered": ["user:g", "user:a", "user:b", "user:d", "user:h", "user:i"]},
}


@pytest.mark.parametrize("name", GOLDEN)
@pytest.mark.parametrize("explicit", [False, True])
def test_rrf_is_unchanged(name, explicit):
    """`fusion: rrf` (the default, spelled out or left out) returns the frozen pre-m8 hits, stages and drops."""
    g = GOLDEN[name]
    res = snap(run({**g["ranking"], "fusion": "rrf", "score_w": 0.7} if explicit else g["ranking"]))
    assert res == {"hits": g["hits"], "considered": g["considered"], "dropped": DROPPED, "abstained": False}
    assert all("fused" not in h.stages for h in run(g["ranking"]).considered)  # absent under rrf


SCORE = {"keyword_rrf_weight": 0.25, "rerank_weight": 0, "fusion": "score"}  # rerank_weight 0: the final order is the fused order


def stages_of(res):
    return {h.cap_id: h.stages for h in [*res.considered, *(h for h, _ in res.dropped)]}


def test_score_arithmetic():
    """fused = (1 - w) * ts_rank_cd / max(ts_rank_cd) + w * cosine, by hand on the pool above (best keyword hit: user:d, 0.9)."""
    res = run({**SCORE, "score_w": 0.7})
    st = stages_of(res)
    assert {c: st[c]["fused"] for c in ("user:d", "user:a", "user:b", "user:g", "user:h", "user:i", "user:ghost")} == {
        "user:d": 0.72,  # 0.3 * 0.9/0.9 + 0.7 * 0.60
        "user:a": 0.667,  # 0.3 * 0.30/0.9 + 0.7 * 0.81
        "user:b": 0.518,  # no keyword hit: 0.7 * 0.74
        "user:g": 0.4407,  # 0.3 * 0.02/0.9 + 0.7 * 0.62
        "user:h": 0.385,
        "user:i": 0.15,  # keyword-only, no cosine: 0.3 * 0.45/0.9
        "user:ghost": 0.35}  # dropped hits carry their fused value too
    # the pool is ordered by fused; the pin comes first, then the rest in fused order (reranker weight 0)
    assert [h.cap_id for h in res.considered] == ["user:g", "user:d", "user:a", "user:b", "user:h", "user:i"]
    assert [h.cap_id for h in res.hits] == ["user:g", "user:d", "user:a", "user:b", "user:h"]
    assert [why for _, why in res.dropped] == [why for _, why in DROPPED]  # same filters as rrf
    assert all(0.0 <= s["fused"] <= 1.0 and "rrf" in s for s in st.values())  # rrf stays: gate features and stage rows read it
    assert stages_of(run(SCORE))["user:d"]["fused"] == 0.72  # score_w defaults to 0.7
    assert stages_of(run({**SCORE, "score_w": 0.5}))["user:d"]["fused"] == 0.8  # 0.5 * 1 + 0.5 * 0.60
    scaled = run({**SCORE, "score_w": 0.7}, FakeStore(sparse=[(c, s * 7) for c, s in SPARSE]))  # only the ratio matters
    assert stages_of(scaled) == st


def test_empty_keyword_arm():
    """No keyword hit: lex_norm is 0, fused = w * cosine, and the order is the dense order."""
    block_f = {"user:f": "block"}  # no pin: nothing moves g
    res = run({**SCORE, "score_w": 0.7}, FakeStore(sparse=[], overrides=block_f))
    assert [(h.cap_id, h.stages["fused"]) for h in res.considered] == [
        ("user:a", 0.567), ("user:b", 0.518), ("user:g", 0.434), ("user:d", 0.42), ("user:h", 0.385)]
    assert all(h.stages["sparse_rank"] is None for h in res.considered)
    res = run({**SCORE, "score_w": 0.7}, FakeStore(sparse=[("user:d", 0.0)], overrides=block_f))  # a zero best score must not divide by 0
    assert stages_of(res)["user:d"]["fused"] == 0.42


def test_w_one_is_dense_order():
    res = run({**SCORE, "score_w": 1.0}, FakeStore(overrides={"user:f": "block"}))  # no pin: nothing moves g
    kept = [c for c, _ in DENSE if c in ("user:a", "user:b", "user:g", "user:d", "user:h")]
    assert [h.cap_id for h in res.hits] == kept
    assert [h.stages["fused"] for h in res.hits] == [0.81, 0.74, 0.62, 0.6, 0.55]  # = the cosines
    assert [h.cap_id for h in res.considered][len(kept):] == ["user:i"]  # keyword-only hits come after every dense hit


@pytest.mark.parametrize("w", [0.0, 0.5, 0.9, 1.0])
def test_fused_in_unit_interval(w):
    dense = [("user:a", 1.3), ("user:b", -0.2), ("user:d", 0.6)]  # a cosine outside [0, 1] is clamped
    st = stages_of(run({**SCORE, "score_w": w}, FakeStore(dense=dense, overrides={})))
    assert st and all(0.0 <= s["fused"] <= 1.0 for s in st.values()), st
    assert st["user:a"]["fused"] == round((1 - w) * (0.3 / 0.9) + w, 4)
    assert st["user:b"]["fused"] == 0.0


def test_rerank_stages():
    """rerank stays the sigmoid every consumer reads (agent_min_rerank, abstain_below); rerank_logit is the raw score."""
    for ranking in (GOLDEN["tuned"]["ranking"], {**SCORE, "score_w": 0.7}):
        for h in run(ranking).considered:
            logit = LOGITS[h.cap_id.split(":")[-1]]
            assert h.stages["rerank"] == round(sigmoid(logit), 4) and h.stages["rerank_logit"] == logit


def test_rerank_by_logit_breaks_the_rounding_ties(monkeypatch):
    """stages['rerank'] is the sigmoid rounded to 4 decimals: logits -12 and -13 both read 0.0 and keep the first-stage order;
    rerank_by: logit orders them by the logit. Default (sigmoid) is the pre-m8 behaviour."""
    monkeypatch.setitem(LOGITS, "a", -13.0)
    monkeypatch.setitem(LOGITS, "b", -12.0)
    heavy = {"keyword_rrf_weight": 0, "rerank_weight": 1000}  # the rerank order decides
    pos = lambda res, c: [h.cap_id for h in res.considered].index(c)
    default, by_logit = run(heavy, rerank_top=9), run({**heavy, "rerank_by": "logit"}, rerank_top=9)
    assert pos(default, "user:a") < pos(default, "user:b")  # tie at 0.0: dense order wins (a is dense rank 1)
    assert pos(by_logit, "user:b") < pos(by_logit, "user:a")  # the logit separates them
