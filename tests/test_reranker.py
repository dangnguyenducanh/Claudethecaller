"""M8-2: Reranker asks TEI for raw logits and squashes them itself, so score() keeps its (0, 1) scale.

An httpx mock transport stands in for TEI; no service needed.
"""

import asyncio
import json

import httpx
import pytest

from ctc.reranking.reranker import Reranker, sigmoid

# (raw logit TEI returns with raw_scores, what the old server returned for the same pair: sigmoid applied server-side)
OLD_SERVER = [(-6.5, 0.0015011823), (-3.2, 0.0391657228), (-1.0, 0.2689414214), (0.0, 0.5), (0.5, 0.6224593312),
              (2.0, 0.8807970780), (10.0, 0.9999546021)]


def call(method: str, logits: list[float], docs: list[str] | None = None):
    """Run Reranker.<method>(q, docs) against a mock TEI that answers `logits` (listed in a shuffled order, with `index`)."""
    docs = docs or [f"doc {i}" for i in range(len(logits))]
    seen = []

    def tei(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.path, json.loads(request.content)))
        return httpx.Response(200, json=[{"index": i, "score": logits[i]} for i in reversed(range(len(logits)))])

    async def go():
        r = Reranker("http://tei.test")
        r._client, r._loop = httpx.AsyncClient(transport=httpx.MockTransport(tei)), asyncio.get_running_loop()
        try:
            return await getattr(r, method)("fix a flaky test", docs)
        finally:
            await r.aclose()

    return asyncio.run(go()), seen


def test_requests_raw_scores():
    _, seen = call("score", [1.0, 2.0], ["a", "b"])
    assert seen == [("/rerank", {"query": "fix a flaky test", "texts": ["a", "b"], "raw_scores": True})]


def test_score_is_the_old_sigmoid_scale():
    scores, _ = call("score", [x for x, _ in OLD_SERVER])
    assert len(scores) == len(OLD_SERVER)  # back in `docs` order although TEI answered in reverse
    for got, (_, old) in zip(scores, OLD_SERVER):
        assert got == pytest.approx(old, abs=1e-6)


def test_score_with_logits_returns_both():
    out, seen = call("score_with_logits", [x for x, _ in OLD_SERVER])
    assert [logit for _, logit in out] == [x for x, _ in OLD_SERVER]
    for (s, _), (_, old) in zip(out, OLD_SERVER):
        assert s == pytest.approx(old, abs=1e-6)
    assert seen[0][1]["raw_scores"] is True


@pytest.mark.parametrize("x", [-1000.0, -35.0, 35.0, 1000.0])
def test_large_logits_do_not_overflow(x):
    assert sigmoid(x) == pytest.approx(1.0 if x > 0 else 0.0, abs=1e-12)  # math.exp(1000) alone would raise OverflowError
    assert call("score", [x])[0] == [sigmoid(x)]
