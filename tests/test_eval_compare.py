"""M8-4: compare_runs = paired Student's t via ranx.compare. No DB, no embedder."""

import sys
from pathlib import Path

# ponytail: `uv run pytest` puts tests/, not the repo root, on sys.path (same note as test_graph_eval.py)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from evaluation.retrieval_eval import compare_runs, compare_table

N = 60
QRELS = {f"q{i}": {f"d{i}": 1} for i in range(N)}


def run(rank_of) -> dict:
    """Query i's relevant doc d{i} sits at rank_of(i) among eight filler docs."""
    out = {}
    for i in range(N):
        docs = [f"x{j}" for j in range(8)]
        docs.insert(rank_of(i) - 1, f"d{i}")
        out[f"q{i}"] = {d: 1 / k for k, d in enumerate(docs, 1)}
    return out


def test_clear_winner_is_significant():
    rows = compare_runs(QRELS, {"A": run(lambda i: 1), "B": run(lambda i: 1 + i % 8)})
    assert len(rows) == 2 and {r["metric"] for r in rows} == {"ndcg@10", "recall@5"}
    for r in rows:
        assert (r["a"], r["b"], r["split"]) == ("A", "B", "test") and r["delta"] > 0
        assert r["p"] < 0.01 and r["sig_0.01"] and r["sig_0.05"]
    assert "| A | B | ndcg@10 | test |" in "\n".join(compare_table(rows))


def test_identical_runs_are_not_significant():
    same = run(lambda i: 1 + i % 8)
    for r in compare_runs(QRELS, {"A": same, "B": dict(same)}, split="dev"):
        assert r["delta"] == 0 and r["split"] == "dev"
        assert r["p"] == 1.0 and not r["sig_0.01"] and not r["sig_0.05"]
