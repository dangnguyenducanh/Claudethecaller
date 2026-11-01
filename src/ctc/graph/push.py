"""What the hooks push from the RAM graph (m6 G6, contracts/hooks.md): one line per prompt, one note before Read/Edit/Write.
Pure functions over core.Graph: no DB, no embedder; "" when there is nothing worth saying.
"""

from __future__ import annotations

import numpy as np

from ctc.graph.core import Graph

PROMPT_TYPES = {"task", "story", "requirement", "ticket", "plan_step"}
NOTE_RANK = {"task": 0, "requirement": 1, "ticket": 2, "plan_step": 3, "story": 4, "criterion": 5}  # tasks/requirements first
DECISION = {"decision", "constraint"}


def _cut(s: str, n: int) -> str:
    s = " ".join(s.split())
    return s if len(s) <= n else s[:n - 1] + "…"


def _name(n: dict) -> str:
    """Parser ids carry the name people use (T012 [US1], FR-012, ticket-03, G3); other origins have only their label."""
    if n["origin"] != "parser":
        return _cut(n["label"], 60)
    tag = n["meta"].get("story") or (n["meta"].get("ticket") and f"ticket {n['meta']['ticket']}")
    return n["id"].rsplit(":", 1)[-1] + (f" [{tag}]" if tag else "")


def _decision(g: Graph, ids: list[str]) -> str:
    """` · decision: …` for the first decision/constraint among ids, else the first one constraining any of them."""
    d = next((i for i in ids if g.nodes[i]["type"] in DECISION), None) or next(
        (s for i in ids for s, *_ in g.neighbours(i, {"constrains"}, "in")), None)
    return f" · decision: {_cut(g.nodes[d]['label'], 60)}" if d else ""


def prompt_line(g: Graph, qv: np.ndarray, cfg: dict) -> str:
    """Best context match at or above the floor that has code: its name, up to max_pointers code pointers, a decision."""
    c = cfg["graph_push"]
    for i, cos in g.nearest(qv, 10, kind="context", types=PROMPT_TYPES):
        if cos < c["floor"]:
            break
        if hits := g.code_for(i, c["max_pointers"]):
            n = g.nodes[i]
            ptrs = ", ".join(f"{g.nodes[d]['source_file']}:{g.nodes[d]['source_line']} {g.nodes[d]['label']}" for d, _, _ in hits)
            head = _name(n) + (f" {_cut(n['label'], 60)}" if n["origin"] == "parser" else "")
            stories = [s for s, *_ in g.neighbours(i, {"serves"}, "out")]
            return _cut(f"ctc graph: {head} → {ptrs}{_decision(g, [i, *stories])}", c["max_chars"])
    return ""


def file_note(g: Graph, path: str, cfg: dict) -> str:
    """Up to note_max tasks/requirements (then tickets, plan steps, stories) linked to path's code, and one decision."""
    ids = g.context_for_file(path)
    items = sorted((i for i in ids if g.nodes[i]["type"] in NOTE_RANK), key=lambda i: NOTE_RANK[g.nodes[i]["type"]])
    items = items[:cfg["graph_push"]["note_max"]]
    groups: dict[str, list[str]] = {}
    for i in items:
        groups.setdefault(g.nodes[i]["type"], []).append(_name(g.nodes[i]))
    dec = _decision(g, [i for i in ids if g.nodes[i]["type"] in DECISION] + items)
    if not (groups or dec):
        return ""
    return f"ctc graph: {path}" + (" implements " + "; ".join(", ".join(v) for v in groups.values()) if groups else "") + dec
