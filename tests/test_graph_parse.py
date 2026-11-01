"""Context parser (m6 G2): a mini repo of docs in tmp_path -> nodes and edges with data-model.md ids. DB-free."""

from pathlib import Path

from ctc.graph.parse import parse_repo, summary

FILES = {
    "specs/009-demo/spec.md": """# Feature Specification: Demo feature

**Input**: demo

### User Story 1 - Do a (Priority: P1) 🎯 MVP

Story one body.

### User Story 2 - Do b (Priority: P2)

Story two body.

## Requirements

- **FR-001**: The system MUST do a.

**Grouped (US1–US2)**
- **FR-002**: The system MUST do b.

## Success Criteria

- **SC-001**: a takes under 1 s.
- **SC-002**: US2 is measured.
""",
    "specs/009-demo/plan.md": "# Implementation Plan: Demo\n\n## Summary\n\nDemo summary text.\n\n## Technical Context\n\nx\n",
    "specs/009-demo/tasks.md": """# Tasks: Demo

## Phase 2: Foundational — ticket 01 demo seam

- [ ] T001 [P] [US1] Change src/a.py and `src/b.py::run`

## Phase 3: User Story 2

- [X] T002 [US2] Fix tests/test_b.py.
- [ ] T003 """ + "x" * 300 + """
""",
    "specs/010-other/spec.md": "# Feature Specification: Other\n\n## Requirements\n\n- **FR-001**: Other MUST be other.\n",
    ".scratch/demo/spec.md": "# Spec: demo scratch\n\nStatus: ready-for-agent\n",
    ".scratch/demo/issues/01-seam.md": """# 01 — seam

Status: ready-for-agent
Blocked by: none
Touches: src/a.py, tests/test_a.py

## What to build

Build the seam.

## Acceptance criteria

- [ ] works
""",
    ".scratch/demo/issues/02-next.md": "# 02 — next\n\nStatus: ready-for-agent\nBlocked by: 01\nTouches: src/c.py\n\n## What to build\n\nNext.\n",
    "PLAN.md": """# Plan

### Backend

- [ ] **H0** — owner does a thing.

#### M1: Run a chain (`m5-runner-core`)
- [x] **WB2 — walker** (`src/ctc/runner/graph.py`, pure functions)
  - `load`, `validate`.
  - Done when: `uv run python -m ctc.runner.graph` passes.
- [ ] **WB3 — next**

### Other

text
""",
    "CLAUDE.md": """# x

**Decisions**
- 2026-10-21 — First.
- 2026-10-21 — Second.
- 2026-10-22 — Third.

## After

- 2026-10-23 — not a decision
""",
    ".claude/prds/p.md": "# P product\n\nIntro.\n\n## Problem\n\nIt hurts.\n\n## Scope\n\nSmall.\n",
}


def _repo(tmp_path: Path) -> Path:
    for rel, text in FILES.items():
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / rel).write_text(text, encoding="utf-8")
    return tmp_path


def test_ids_meta_and_edges(tmp_path):
    nodes, edges = parse_repo(_repo(tmp_path))
    by_id = {n["id"]: n for n in nodes}
    d = "ctx:specs/009-demo"
    for i in [d, f"{d}:US1", f"{d}:US2", f"{d}:FR-001", f"{d}:FR-002", f"{d}:SC-001", f"{d}:T001", f"{d}:T002",
              "ctx:specs/010-other:FR-001", "ctx:.scratch/demo", "ctx:.scratch/demo:ticket-01", "ctx:.scratch/demo:ticket-02",
              "ctx:PLAN:M1", "ctx:PLAN:WB2", "ctx:PLAN:WB3", "ctx:PLAN:H0", "ctx:CLAUDE:decision:2026-10-21:1",
              "ctx:CLAUDE:decision:2026-10-21:2", "ctx:CLAUDE:decision:2026-10-22:1", "ctx:prd:p", "ctx:prd:p:problem",
              "ctx:prd:p:scope"]:
        assert i in by_id, i
    assert "ctx:CLAUDE:decision:2026-10-23:1" not in by_id
    assert all(n["kind"] == "context" and n["origin"] == "parser" for n in nodes)
    assert all(len(n["label"]) <= 200 and len(n["text"]) <= 2000 for n in nodes)

    feat, us1, t1, t2 = by_id[d], by_id[f"{d}:US1"], by_id[f"{d}:T001"], by_id[f"{d}:T002"]
    assert (feat["type"], feat["label"], feat["source_file"], feat["source_line"]) == ("feature", "Demo feature", "specs/009-demo/spec.md", 1)
    assert "Demo summary text." in feat["text"]
    assert (us1["type"], us1["label"], us1["source_line"], us1["meta"]["priority"]) == ("story", "Do a", 5, "P1")
    assert us1["text"] == "Story one body."
    assert by_id[f"{d}:FR-001"]["type"] == "requirement" and by_id[f"{d}:SC-001"]["type"] == "criterion"
    assert by_id[f"{d}:FR-001"]["meta"]["feature"] == "specs/009-demo"
    assert t1["meta"].items() >= {"story": "US1", "status": "[ ]", "parallel": True, "ticket": "01"}.items()
    assert t2["meta"].items() >= {"story": "US2", "status": "[x]", "parallel": False}.items()
    assert (t1["type"], t1["source_file"], t1["source_line"]) == ("task", "specs/009-demo/tasks.md", 5)
    tk = by_id["ctx:.scratch/demo:ticket-01"]
    assert (tk["type"], tk["label"], tk["meta"]["status"]) == ("ticket", "01 — seam", "ready-for-agent")
    assert tk["text"] == "Build the seam."
    wb2 = by_id["ctx:PLAN:WB2"]
    assert wb2["type"] == "plan_step" and wb2["meta"]["status"] == "[x]" and "Done when" in wb2["text"]
    assert by_id["ctx:PLAN:H0"]["meta"]["status"] == "[ ]"
    assert by_id["ctx:CLAUDE:decision:2026-10-21:2"]["text"] == "Second."
    assert by_id["ctx:CLAUDE:decision:2026-10-22:1"]["type"] == "decision"
    assert by_id["ctx:prd:p:problem"]["text"] == "It hurts."

    got = {(e["src"], e["dst"], e["relation"]) for e in edges}
    want = {
        (d, f"{d}:US1", "has_story"), (d, f"{d}:US2", "has_story"),
        (d, f"{d}:FR-001", "needs"), (f"{d}:US1", f"{d}:FR-002", "needs"), (f"{d}:US2", f"{d}:FR-002", "needs"),
        ("ctx:specs/010-other", "ctx:specs/010-other:FR-001", "needs"),
        (f"{d}:SC-001", d, "measures"), (f"{d}:SC-002", f"{d}:US2", "measures"),
        (f"{d}:T001", f"{d}:US1", "serves"), (f"{d}:T002", f"{d}:US2", "serves"),
        (f"{d}:T001", "ctx:.scratch/demo:ticket-01", "part_of"),
        ("ctx:.scratch/demo:ticket-01", "ctx:.scratch/demo:ticket-02", "blocks"),
        (f"{d}:T001", "file:src/a.py", "implemented_in"), (f"{d}:T001", "file:src/b.py::run", "implemented_in"),
        (f"{d}:T002", "file:tests/test_b.py", "tested_by"),
        ("ctx:.scratch/demo:ticket-01", "file:src/a.py", "implemented_in"),
        ("ctx:.scratch/demo:ticket-01", "file:tests/test_a.py", "tested_by"),
        ("ctx:PLAN:WB2", "ctx:PLAN:M1", "part_of"),
        ("ctx:prd:p", "ctx:prd:p:problem", "needs"),
    }
    assert want <= got, want - got
    assert (d, f"{d}:FR-002", "needs") not in got  # grouped under stories, not the feature
    assert not any(s == f"{d}:T002" and r == "part_of" for s, _, r in got)  # phase 3 names no ticket
    assert len(got) == len(edges)  # no duplicates
    assert all(e["confidence"] == "EXTRACTED" and e["origin"] == "parser" and e["score"] == 1.0 for e in edges)


def test_files_filter_and_summary(tmp_path):
    repo = _repo(tmp_path)
    nodes, edges = parse_repo(repo, files=["PLAN.md"])
    assert {n["source_file"] for n in nodes} == {"PLAN.md"}
    assert {n["id"] for n in nodes} == {"ctx:PLAN:H0", "ctx:PLAN:M1", "ctx:PLAN:WB2", "ctx:PLAN:WB3"}
    assert {(e["src"], e["dst"]) for e in edges} == {("ctx:PLAN:WB2", "ctx:PLAN:M1"), ("ctx:PLAN:WB3", "ctx:PLAN:M1")}

    s = summary(parse_repo(repo)[0])
    assert {k: s[k] for k in ["stories", "requirements", "criteria", "tasks", "tickets", "decisions", "plan_steps", "prds", "features"]} == {
        "stories": 2, "requirements": 5, "criteria": 2, "tasks": 3, "tickets": 2, "decisions": 3, "plan_steps": 4, "prds": 1, "features": 3}
    assert s["by_feature"]["specs/009-demo"]["stories"] == 2
    assert s["by_feature"][".scratch/demo"]["tickets"] == 2
