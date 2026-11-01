"""M8-5: abstain-gate candidates (margin, Platt, isotonic, ECE) and the eval wiring around them (tune, ranking --fusion score).

No DB, no GPU, no TEI: scores are synthetic, and the tune / ranking sweeps run with a fake search so only their wiring is tested
(what they write, what they must not write, which splits they read).
"""

import asyncio
import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

# ponytail: `uv run pytest` puts tests/, not the repo root, on sys.path (same note as test_eval_compare.py)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import evaluation.retrieval_eval as ev
from ctc.retrieval import gate

CONTRACT_KEYS = {"kind", "ece_before", "ece_after", "threshold", "false_trigger_dev", "suggest_rate_test", "false_trigger_test"}


def synthetic(n: int = 600, seed: int = 0):
    """Positives score higher than negatives, with overlap: (scores in [0, 1], labels)."""
    rng = np.random.default_rng(seed)
    y = rng.integers(0, 2, n)
    return np.clip(rng.normal(0.4 + 0.2 * y, 0.12), 0, 1), y


def test_margin_fires_only_when_top1_is_1_5x_top2():
    assert gate.margin(0.75, 0.5, 1.5)  # exactly on the line fires
    assert not gate.margin(0.7499, 0.5, 1.5)
    assert gate.margin(0.3, 0.0, 1.5)  # no runner-up: a clear winner
    assert not gate.margin(0.0, 0.0, 1.5)  # nothing retrieved: nothing fires
    assert gate.margin(np.array([0.9, 0.7, 0.6]), np.array([0.6, 0.6, 0.0]), 1.5).tolist() == [True, False, True]


@pytest.mark.parametrize("fit", [gate.fit_platt, gate.fit_isotonic])
def test_fit_refuses_single_class(fit):
    with pytest.raises(ValueError, match="both classes"):
        fit([0.2, 0.5, 0.9], [1, 1, 1])
    with pytest.raises(ValueError, match="both classes"):
        fit([0.2, 0.5, 0.9], [0, 0, 0])


def test_ece_perfect_and_worst():
    assert gate.ece([0.0, 0.0, 1.0, 1.0], [0, 0, 1, 1]) == 0.0
    assert gate.ece([1.0, 1.0, 0.0, 0.0], [0, 0, 1, 1]) == 1.0
    assert gate.ece([0.5] * 4, [0, 1, 0, 1]) == 0.0  # right on average, one bin


@pytest.mark.parametrize("fit", [gate.fit_platt, gate.fit_isotonic])
def test_calibration_does_not_raise_ece(fit):
    s, y = synthetic()
    raw = gate.ece(s, y)
    p = gate.calibrate(fit(s, y), s)
    assert 0.0 <= p.min() and p.max() <= 1.0
    assert gate.ece(p, y) <= raw
    assert p[y == 1].mean() > p[y == 0].mean()  # still ranks positives above negatives


def test_isotonic_clips_scores_outside_the_fitted_range():
    s = np.linspace(0.3, 0.7, 50)
    y = (s > 0.5).astype(int)
    m = gate.fit_isotonic(s, y)
    p = gate.calibrate(m, [-5.0, 0.0, 0.3, 0.7, 1.0, 9.0])
    assert not np.isnan(p).any()
    assert p[0] == p[1] == p[2] and p[3] == p[4] == p[5]  # below the range -> the low end, above -> the high end
    assert p[2] <= p[3]


def test_first_scores_reads_fused_else_dense():
    hit = lambda **st: SimpleNamespace(stages=st)
    fused = SimpleNamespace(considered=[hit(dense=0.9, fused=0.40), hit(dense=0.5, fused=0.62), hit(dense=0.7, fused=0.10)])
    assert gate.first_scores(fused) == (0.62, 0.40)  # fused wins over dense, and the order is by score, not by position
    dense = SimpleNamespace(considered=[hit(dense=0.5), hit(dense=0.9), hit(dense=None), hit(dense=-0.2)])
    assert gate.first_scores(dense) == (0.9, 0.5)  # negative cosine clipped to 0
    assert gate.first_scores(SimpleNamespace(considered=[])) == (0.0, 0.0)
    assert gate.first_scores(SimpleNamespace(considered=[hit(dense=0.7)])) == (0.7, 0.0)


def split(n_pos: int, n_neg: int, seed: int) -> dict:
    rng = np.random.default_rng(seed)
    y = np.r_[np.ones(n_pos, int), np.zeros(n_neg, int)]
    top1 = np.clip(np.where(y == 1, rng.normal(0.75, 0.1, len(y)), rng.normal(0.5, 0.1, len(y))), 0, 1)
    top2 = np.clip(top1 - np.where(y == 1, rng.uniform(0.0, 0.3, len(y)), rng.uniform(0.0, 0.1, len(y))), 0, 1)
    x = np.c_[top1, top1, top1, top1 - top2, top1 - top2, rng.integers(0, 5, len(y)), rng.integers(3, 20, len(y))]
    return {"top1": top1, "top2": top2, "x": x, "y": y, "lang": np.where(rng.random(len(y)) < 0.25, "other", "ascii")}


def test_gate_candidates_shape_and_dev_cap():
    dev, test = split(300, 150, 1), split(400, 100, 2)
    rows, models = ev.gate_candidates(dev, test)
    assert [r["kind"] for r in rows] == ["off", "margin", "platt", "isotonic", "lr"]
    assert set(models) == {"platt", "isotonic", "lr"}
    for r in rows:
        assert CONTRACT_KEYS <= set(r)
        n_sk = sum(a for a, _ in r["by_lang_test"]["skillret"].values())
        assert n_sk == round(r["suggest_rate_test"] * 400)  # fired counts per language add up to the rate
        assert sum(b for _, b in r["by_lang_test"]["skillret"].values()) == 400
        assert sum(b for _, b in r["by_lang_test"]["metatool"].values()) == 100
    off = rows[0]
    assert (off["suggest_rate_test"], off["false_trigger_test"], off["threshold"], off["meets_sc003"]) == (1.0, 1.0, None, False)
    for r in rows[1:]:  # separable data: every fitted candidate finds a threshold within the cap and suggests on most positives
        assert r["threshold"] is not None and r["false_trigger_dev"] <= ev.MAX_FT
        assert r["suggest_rate_test"] > 0.5 and r["meets_sc003"] == (r["false_trigger_test"] <= ev.MAX_FT)
    assert rows[1]["ece_before"] is None and rows[2]["ece_before"] is not None and rows[2]["ece_after"] <= rows[2]["ece_before"]
    assert rows[1]["threshold"] in ev.MARGIN_RATIOS


def test_gate_candidates_with_no_signal_never_fire():
    """Positives and negatives share one score and no runner-up: no threshold keeps false-trigger <= 10%, so nothing may fire."""
    dev, test = split(200, 200, 3), split(200, 200, 4)
    for d in (dev, test):
        d["top1"] = np.full(len(d["y"]), 0.6)
        d["top2"] = np.zeros(len(d["y"]))
    rows, _ = ev.gate_candidates(dev, test)
    for r in (r for r in rows if r["kind"] in ("margin", "platt", "isotonic")):
        assert r["threshold"] is None and r["false_trigger_dev"] is None, r["kind"]
        assert (r["suggest_rate_test"], r["false_trigger_test"], r["meets_sc003"]) == (0.0, 0.0, False), r["kind"]
    assert ev.threshold_at_ft(np.ones(10), np.array([0] * 5 + [1] * 5)) is None
    assert ev.threshold_at_ft(np.array([0.1, 0.2, 0.8, 0.9]), np.array([0, 0, 1, 1])) == 0.8  # lowest p within the cap


def test_margin_ratio_is_the_lowest_one_within_the_cap():
    dev, test = split(300, 150, 1), split(100, 100, 2)
    dev["top2"] = dev["top1"] / 2  # every dev row sits at ratio exactly 2: it fires up to 2.0 and nowhere past it
    margin = next(r for r in ev.gate_candidates(dev, test)[0] if r["kind"] == "margin")
    assert margin["threshold"] == 2.05 and margin["false_trigger_dev"] == 0.0


def test_lang_is_a_script_test():
    assert ev.lang("fix the flaky test") == "ascii"
    assert ev.lang("sửa lỗi test không ổn định") == "other"
    assert ev.lang("12345 !?") == "ascii"


def test_header_records_the_reranker_tag_and_commit():
    h = ev.header()
    assert {"fusion", "score_w", "tei_reranker_tag", "git_sha"} <= set(h)
    compose = (ev.ROOT / "docker-compose.yml").read_text()
    assert h["tei_reranker_tag"] and f":{h['tei_reranker_tag']}" in compose
    assert re.fullmatch(r"[0-9a-f]*", h["git_sha"])  # '' outside a checkout


# ---- tune / ranking --fusion score with a fake search -------------------------------------------------------------------

NEUTRAL_STORE = SimpleNamespace(catalog={"x": 1})


def fake_services(monkeypatch, tmp_path: Path, calls: list) -> Path:
    """Everything tune / tune_ranking reach for (stores, TEI, datasets, the search) replaced; reports and config go to tmp_path."""
    (tmp_path / "config").mkdir()
    yaml = tmp_path / "config" / "retrieval.yaml"
    yaml.write_text("depth: 50\nranking: {keyword_rrf_weight: 0.25, rerank_weight: 1, fusion: rrf, score_w: 0.7}   # before\n")
    monkeypatch.setattr(ev, "ROOT", tmp_path)
    monkeypatch.setattr(ev, "REPORTS", tmp_path / "data" / "reports")  # does not exist yet: the writers must create it

    async def opened(*schemas):
        calls.append(("opened", schemas))
        return SimpleNamespace(), SimpleNamespace(), [SimpleNamespace(catalog={"x": 1}, candidates=None) for _ in schemas]

    async def closed(*a):
        pass

    async def embed_all(embedder, queries):
        return np.zeros((len(queries), 4)), 0.0

    async def run_set(ctx, items, qvs, depth, rerank_top, modes=True, ranking=None):
        calls.append(("run_set", ranking))
        rng = np.random.default_rng(len(items))
        rows = []
        for qid, q, gold in items:
            neg = not gold
            top1 = float(rng.uniform(0.4, 0.75) if neg else rng.uniform(0.6, 0.9))
            top2 = top1 - float(rng.uniform(0, 0.1) if neg else rng.uniform(0, 0.3))
            win = (ranking or {}).get("score_w") == 0.8  # the fake search is best at score_w 0.8
            full = ["a", "b", "c", "d", "e", *gold] if not win else [*gold, "a", "b", "c", "d", "e"]
            rows.append({"id": qid, "gold": gold, "full": full, "dense": ["a", *gold], "hybrid": ["a", *gold], "abstained": False,
                         "x": np.array([top1, top1, top1, top1 - top2, top1 - top2, 3.0, 5.0]), "s": (top1, top2)})
        return rows

    monkeypatch.setattr(ev, "opened", opened)
    monkeypatch.setattr(ev, "closed", closed)
    monkeypatch.setattr(ev, "embed_all", embed_all)
    monkeypatch.setattr(ev, "run_set", run_set)
    monkeypatch.setattr(ev, "sr_dev", lambda: [(f"d{i}", f"dev query {i}", {f"s{i}": 1}) for i in range(60)])
    monkeypatch.setattr(ev, "own_sets", lambda test: ([(f"o{i}", f"own {i}", {f"s{i}": 1}) for i in range(10)], []))
    monkeypatch.setattr(ev, "metatool", lambda: [{"id": f"metatool:{i}", "query": f"no tool {i}" if i % 5 else "không cần công cụ", "gold": []} for i in range(240)])
    monkeypatch.setattr(ev, "skillret", lambda split="test": (None, [{"id": f"t{i}", "query": f"test query {i}"} for i in range(80)],
                                                              {f"t{i}": {f"s{i}": 1} for i in range(80)}))
    return yaml


def test_ranking_score_sweep_is_dev_only_and_never_writes_the_yaml(monkeypatch, tmp_path):
    calls: list = []
    yaml = fake_services(monkeypatch, tmp_path, calls)
    before = yaml.read_text()
    asyncio.run(ev.tune_ranking("score", True))  # write=True must still be ignored for score
    assert yaml.read_text() == before
    assert [c[1] for c in calls if c[0] == "opened"] == [("ctc", ev.sr_schema("train"))]  # the test schema is never opened
    out = json.loads((ev.REPORTS / f"ranking-score-{ev.TODAY}.json").read_text())
    assert [s["ranking"].get("score_w") for s in out["sweep"]] == [None, *ev.SCORE_WS]
    assert out["sweep"][0]["ranking"]["fusion"] == "rrf" and all(s["ranking"]["fusion"] == "score" for s in out["sweep"][1:])
    assert out["winner"]["fusion"] == "score" and out["winner"]["score_w"] == 0.8
    assert {"tei_reranker_tag", "git_sha"} <= set(out["header"])
    assert all("ndcg@10" in s["skillret_dev"] and "recall@5" in s["skillret_dev"] for s in out["sweep"])
    assert not (ev.REPORTS / f"ranking-{ev.TODAY}.json").exists()


@pytest.mark.parametrize("write", [True, False])
def test_ranking_rrf_sweep_writes_the_yaml_only_when_asked(monkeypatch, tmp_path, write):
    yaml = fake_services(monkeypatch, tmp_path, [])
    before = yaml.read_text()
    asyncio.run(ev.tune_ranking("rrf", write))
    assert (yaml.read_text() != before) == write
    assert (ev.REPORTS / f"ranking-{ev.TODAY}.json").exists()  # creates data/reports when missing


def test_tune_writes_the_gate_report_and_leaves_abstain_joblib_alone(monkeypatch, tmp_path):
    calls: list = []
    yaml = fake_services(monkeypatch, tmp_path, calls)
    before = yaml.read_text()
    (tmp_path / "models").mkdir()
    (tmp_path / "models" / "abstain.joblib").write_bytes(b"keep me")
    asyncio.run(ev.tune())
    assert (tmp_path / "models" / "abstain.joblib").read_bytes() == b"keep me" and yaml.read_text() == before
    assert [c[1] for c in calls if c[0] == "opened"] == [(ev.sr_schema("train"), ev.sr_schema("test"))]
    out = json.loads((ev.REPORTS / f"gate-{ev.TODAY}.json").read_text())
    assert [r["kind"] for r in out["candidates"]] == ["off", "margin", "platt", "isotonic", "lr"]
    assert all(CONTRACT_KEYS <= set(r) for r in out["candidates"]) and out["score"] == "dense"
    assert {"tei_reranker_tag", "git_sha", "fusion"} <= set(out["header"])
    assert out["sizes"]["skillret_test"] == {"n": 80, "ascii": 80, "other": 0}  # no non-ASCII letters in the fake SkillRet queries
    mt_dev, mt_test = out["sizes"]["metatool_dev"], out["sizes"]["metatool_test"]
    assert mt_dev["n"] + mt_test["n"] == 240 and mt_dev["other"] + mt_test["other"] == 48  # every 5th prompt is Vietnamese
    assert (tmp_path / "models" / f"gate-lr-{ev.TODAY}.joblib").exists()
    assert all(p.name.startswith("gate-") or p.name == "abstain.joblib" for p in (tmp_path / "models").iterdir())


def test_tune_smoke_run_writes_nothing(monkeypatch, tmp_path):
    fake_services(monkeypatch, tmp_path, [])
    asyncio.run(ev.tune(50))
    assert not (tmp_path / "data").exists() and not (tmp_path / "models").exists()
