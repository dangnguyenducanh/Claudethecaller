"""m6 G7: truth from tagged commits, Recall@3 over the push line, floor tuning on dev, --write-floor. No DB, no embedder."""

import subprocess
import sys
from pathlib import Path

# ponytail: `uv run pytest` puts tests/, not the repo root, on sys.path; pytest `pythonpath = ["."]` in pyproject if more
# tests import evaluation/
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from evaluation import graph_eval

TAG = r"\(n8n parity (\d{2})\)$"


def git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


def commit(repo: Path, files: list[str], msg: str) -> None:
    for f in files:
        (repo / f).parent.mkdir(parents=True, exist_ok=True)
        (repo / f).write_text(msg)
    git(repo, "add", *files)
    git(repo, "commit", "-qm", msg)


def test_truth(tmp_path):
    git(tmp_path, "init", "-q", "-b", "main")
    for k, v in (("user.name", "t"), ("user.email", "t@x"), ("commit.gpgsign", "false"), ("core.hooksPath", "/dev/null")):
        git(tmp_path, "config", k, v)
    commit(tmp_path, ["src/a.py", "tests/test_a.py"], "feat: a (n8n parity 01)")
    commit(tmp_path, ["specs/x.md", "src/gone.py"], "feat: b (n8n parity 02)")
    commit(tmp_path, ["src/b.py"], "chore: untagged")
    code = {"src/a.py", "src/b.py", "tests/test_a.py", "specs/x.md"}  # tests/specs are dropped even when graphify has them
    assert graph_eval.truth(tmp_path, TAG, code) == {"01": {"src/a.py"}}  # 02 left empty: dropped (main lists it)


def test_recall_at3():
    truth = {"01": {"src/a.py"}, "02": {"src/b.py"}, "03": {"src/c.py"}, "04": {"src/d.py"}}
    lines = {
        "01": "ctc graph: T001 [US1] x → src/x.py:3 f(), src/y.py:9 g(), src/a.py:1 a.py · decision: keep",  # 3rd pointer
        "02": "ctc graph: T002 y → src/x.py:3 f(), src/y.py:9 g(), src/z.py:1 h(), src/b.py:4 b()",  # 4th: not counted
        "03": "",  # abstained: a miss
        "04": "ctc graph: src/d.py:1 named in the head → src/x.py:3 f()",  # a path in the head is not a pointer
    }
    assert graph_eval.recall_at3(lines, truth) == 0.25
    assert graph_eval.recall_at3({}, truth) == 0.0


def test_tune():
    on = "ctc graph: T → src/a.py:1 a()"
    rows = [({"src/a.py"}, {0.3: on, 0.5: on, 0.7: ""}),
            ({"src/a.py"}, {0.3: on, 0.5: "", 0.7: ""}),
            *[(None, {0.3: on, 0.5: on if i == 0 else "", 0.7: ""}) for i in range(10)]]
    # 0.3: recall 1.0 but 10/10 negatives fire; 0.5: recall 0.5, 1/10 = 10% fires (allowed); 0.7: recall 0
    assert graph_eval.tune([0.3, 0.5, 0.7], rows) == 0.5
    assert graph_eval.tune([0.3, 0.7], rows) == 0.7  # recall tie at 0 -> the higher floor
    assert graph_eval.score(rows, 0.5) == (0.5, 0.1)


def test_write_floor(tmp_path):
    p = tmp_path / "retrieval.yaml"
    p.write_text("depth: 50\nfloor: 0.9\ngraph_push:  # x\n  floor: 0.5                       # cosine; tuned\n  max_pointers: 3\n")
    graph_eval.write_floor(0.45, p)
    assert p.read_text() == "depth: 50\nfloor: 0.9\ngraph_push:  # x\n  floor: 0.45                      # cosine; tuned\n  max_pointers: 3\n"
