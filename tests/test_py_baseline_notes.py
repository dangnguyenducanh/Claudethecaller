import json
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent / "fixtures" / "py-baseline"


def _readme() -> str:
    return (BASE / "README.md").read_text()


def test_missing_skillret_baseline_is_documented():
    if not (BASE / "skillret.json").exists():
        assert "`skillret.json` is not recorded" in _readme()


def test_graph_error_rows_are_documented():
    rows = [json.loads(line) for line in (BASE / "graph.jsonl").read_text().splitlines()]
    errors = [r["id"] for r in rows if r["is_error"]]
    assert len(errors) == json.loads((BASE / "manifest.json").read_text())["graph"]["errors"]
    assert all(i in _readme() for i in errors)
