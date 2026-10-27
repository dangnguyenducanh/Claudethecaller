"""Parse the project's docs into context-graph nodes and edges (m6 G2): no model, no DB, no network.

Sources (repo-relative): specs/*/{spec,plan,tasks}.md, .scratch/*/spec.md and issues/NN-*.md, PLAN.md step ids,
.claude/prds/*.md and the **Decisions** list of CLAUDE.md. Ids follow specs/002-context-coding-graph/data-model.md.
File paths named in tasks and tickets become EXTRACTED edges to `file:<path>` placeholders that build resolves.
"""

from __future__ import annotations

import re
from pathlib import Path

STORY = re.compile(r"^### User Story (\d+)\s*[-–—]\s*(.+?)\s*\(Priority: (P\d)\)")
REQ = re.compile(r"^\s*- \*\*((FR|SC)-\d+)\*\*:?\s*(.*)")
GROUP = re.compile(r"^\*\*[^*]+\*\*\s*$")  # "**Failure and iteration (US1–US2, US7–US9)**" over a block of FRs
US = re.compile(r"US(\d+)(?:\s*[-–—]\s*US(\d+))?")
TASK = re.compile(r"^- \[( |x|X)\] (T\d{3})( \[P\])?( \[US\d+\])? (.*)")
PHASE_TICKET = re.compile(r"\bticket (\d{2})\b")
PATH = re.compile(r"(?<![\w./-])((?:src|tests|scripts|evaluation|dashboard|config|docker)/[\w./-]+(?:::\w+)?)")
STEP = re.compile(r"^(\s*)- \[( |x|X)\] \*\*([A-Z]{1,3}\d{1,2}[a-z]?)\b(.*)")
MILESTONE = re.compile(r"^#### ([A-Z]{1,3}\d{1,2}[a-z]?):\s*(.*)")
DECISION = re.compile(r"^- (\d{4}-\d{2}-\d{2}) — (.*)")
FIELD = re.compile(r"^(Status|Blocked by|Touches):\s*(.*)")
KEYS = {"story": "stories", "requirement": "requirements", "criterion": "criteria", "task": "tasks", "ticket": "tickets",
        "decision": "decisions", "plan_step": "plan_steps", "feature": "features"}


def _node(id: str, type: str, label: str, text: str, file: str, line: int, **meta) -> dict:
    return {"id": id, "kind": "context", "type": type, "label": label.strip()[:200], "text": text.strip()[:2000],
            "source_file": file, "source_line": line, "origin": "parser", "meta": meta}


def _edge(src: str, dst: str, relation: str) -> dict:
    return {"src": src, "dst": dst, "relation": relation, "confidence": "EXTRACTED", "score": 1.0, "origin": "parser"}


def _section(lines: list[str], i: int) -> str:
    """Body under the heading at lines[i], up to the next heading of the same or a higher level."""
    # ponytail: a "#" line inside a ``` fence reads as a heading; none of the parsed docs has one today
    level = len(lines[i]) - len(lines[i].lstrip("#"))
    for j in range(i + 1, len(lines)):
        h = len(lines[j]) - len(lines[j].lstrip("#"))
        if 0 < h <= level and lines[j][h:h + 1] == " ":
            return "\n".join(lines[i + 1:j]).strip()
    return "\n".join(lines[i + 1:]).strip()


def _title(lines: list[str]) -> tuple[str, int]:
    for i, ln in enumerate(lines):
        if ln.startswith("# "):
            return re.sub(r"^(Feature Specification|Implementation Plan|Spec):\s*", "", ln[2:].strip()), i
    return "", 0


def _stories(text: str, d: str) -> list[str]:
    """Story ids named in text: "US3", "US1–US4" (a range)."""
    out = []
    for a, b in US.findall(text):
        out += [f"ctx:{d}:US{n}" for n in range(int(a), int(b or a) + 1)]
    return out


def _paths(src: str, text: str) -> list[dict]:
    paths = dict.fromkeys(p.rstrip(".") for p in PATH.findall(text))
    return [_edge(src, f"file:{p}", "tested_by" if p.startswith("tests/") else "implemented_in") for p in paths]


def _spec(repo: Path, d: str) -> tuple[list[dict], list[dict]]:
    file = f"{d}/spec.md"
    lines = (repo / file).read_text(encoding="utf-8").splitlines()
    title, _ = _title(lines)
    plan = repo / d / "plan.md"
    text = "\n".join(lines)
    if plan.exists():  # plan.md gives the feature's text only
        pl = plan.read_text(encoding="utf-8").splitlines()
        text = next((_section(pl, i) for i, ln in enumerate(pl) if ln.strip() == "## Summary"), text)
    fid = f"ctx:{d}"
    nodes, edges = [_node(fid, "feature", title or d, text, file, 1)], []
    group: list[str] = []
    for i, ln in enumerate(lines):
        if m := STORY.match(ln):
            sid = f"{fid}:US{m[1]}"
            nodes.append(_node(sid, "story", m[2], _section(lines, i), file, i + 1, priority=m[3], feature=d))
            edges.append(_edge(fid, sid, "has_story"))
        elif ln.startswith("#"):
            group = []
        elif GROUP.match(ln):
            group = _stories(ln, d)
        elif m := REQ.match(ln):
            rid = f"{fid}:{m[1]}"
            if m[2] == "FR":
                nodes.append(_node(rid, "requirement", m[3], m[3], file, i + 1, feature=d))
                edges += [_edge(s, rid, "needs") for s in group or [fid]]  # [call] no story named -> the feature
            else:
                nodes.append(_node(rid, "criterion", m[3], m[3], file, i + 1, feature=d))
                edges += [_edge(rid, s, "measures") for s in _stories(m[3], d) or [fid]]
    return nodes, edges


def _tasks(repo: Path, d: str) -> tuple[list[dict], list[dict]]:
    file = f"{d}/tasks.md"
    scratch = ".scratch/" + re.sub(r"^\d+-", "", d.split("/", 1)[1])  # specs/001-n8n-parity -> .scratch/n8n-parity
    nodes, edges, ticket = [], [], None
    for i, ln in enumerate((repo / file).read_text(encoding="utf-8").splitlines()):
        if ln.startswith("## "):
            m = PHASE_TICKET.search(ln)
            ticket = m and m[1]
        elif m := TASK.match(ln):
            tid, story = f"ctx:{d}:{m[2]}", (m[4] or "").strip(" []") or None
            nodes.append(_node(tid, "task", m[5], m[5], file, i + 1, status=f"[{m[1].lower()}]", parallel=bool(m[3]),
                               story=story, ticket=ticket, feature=d))
            edges += [_edge(tid, f"ctx:{d}:{story}", "serves")] if story else []
            edges += [_edge(tid, f"ctx:{scratch}:ticket-{ticket}", "part_of")] if ticket else []
            edges += _paths(tid, m[5])
    return nodes, edges


def _scratch(repo: Path, d: str) -> tuple[list[dict], list[dict]]:
    fid, nodes, edges = f"ctx:{d}", [], []
    if (repo / d / "spec.md").exists():
        lines = (repo / d / "spec.md").read_text(encoding="utf-8").splitlines()
        title, t = _title(lines)
        nodes.append(_node(fid, "feature", title or d, "\n".join(lines[t + 1:]), f"{d}/spec.md", t + 1))
    for p in sorted((repo / d / "issues").glob("[0-9][0-9]-*.md")):
        file, nn = f"{d}/issues/{p.name}", p.name[:2]
        lines = p.read_text(encoding="utf-8").splitlines()
        title, _ = _title(lines)
        fields = {m[1]: m[2].strip() for ln in lines if (m := FIELD.match(ln))}
        body = next((_section(lines, i) for i, ln in enumerate(lines) if ln.strip() == "## What to build"), "\n".join(lines))
        tid = f"{fid}:ticket-{nn}"
        nodes.append(_node(tid, "ticket", title or p.stem, body, file, 1, status=fields.get("Status"), feature=d))
        edges.append(_edge(tid, fid, "part_of"))
        # ponytail: a blocks edge's src is the blocker, so re-parsing only this file can leave a removed one until a full build
        edges += [_edge(f"{fid}:ticket-{b}", tid, "blocks") for b in re.findall(r"\b\d{2}\b", fields.get("Blocked by", ""))]
        edges += _paths(tid, fields.get("Touches", ""))
    return nodes, edges


def _plan(repo: Path) -> tuple[list[dict], list[dict]]:
    lines = (repo / "PLAN.md").read_text(encoding="utf-8").splitlines()
    nodes, edges, milestone = [], [], None
    for i, ln in enumerate(lines):
        if m := MILESTONE.match(ln):
            milestone = f"ctx:PLAN:{m[1]}"
            nodes.append(_node(milestone, "plan_step", f"{m[1]}: {m[2]}", ln[5:], "PLAN.md", i + 1))
        elif ln.startswith("#"):
            milestone = None
        elif m := STEP.match(ln):
            block, ind = [ln], len(m[1])
            for nxt in lines[i + 1:]:  # the bullet plus its indented lines (sub-bullets, "Done when: …")
                if not nxt.strip() or len(nxt) - len(nxt.lstrip()) <= ind:
                    break
                block.append(nxt)
            sid = f"ctx:PLAN:{m[3]}"
            label = (m[3] + m[4]).replace("**", "")
            nodes.append(_node(sid, "plan_step", label, "\n".join(block).replace("**", ""), "PLAN.md", i + 1,
                               status=f"[{m[2].lower()}]"))
            edges += [_edge(sid, milestone, "part_of")] if milestone else []
    return nodes, edges


def _prd(repo: Path, p: Path) -> tuple[list[dict], list[dict]]:
    file, fid = p.relative_to(repo).as_posix(), f"ctx:prd:{p.stem}"
    lines = p.read_text(encoding="utf-8").splitlines()
    title, t = _title(lines)
    nodes, edges, seen = [_node(fid, "feature", title or p.stem, _section(lines, t), file, t + 1)], [], {}
    for i, ln in enumerate(lines):
        if ln.startswith("## "):
            slug = re.sub(r"[^a-z0-9]+", "-", ln[3:].lower()).strip("-")
            seen[slug] = seen.get(slug, 0) + 1
            rid = f"{fid}:{slug}" + (f"-{seen[slug]}" if seen[slug] > 1 else "")
            nodes.append(_node(rid, "requirement", ln[3:], _section(lines, i), file, i + 1, feature=f"prd:{p.stem}"))
            edges.append(_edge(fid, rid, "needs"))
    return nodes, edges


def _decisions(repo: Path) -> list[dict]:
    nodes, n, on = [], {}, False
    for i, ln in enumerate((repo / "CLAUDE.md").read_text(encoding="utf-8").splitlines()):
        if ln.strip() == "**Decisions**":
            on = True
        elif on and (ln.startswith("#") or GROUP.match(ln)):  # the list ends at the next heading or bold section
            break
        elif on and (m := DECISION.match(ln)):
            n[m[1]] = n.get(m[1], 0) + 1
            nodes.append(_node(f"ctx:CLAUDE:decision:{m[1]}:{n[m[1]]}", "decision", m[2], m[2], "CLAUDE.md", i + 1, date=m[1]))
    return nodes


def parse_repo(repo: Path, files: list[str] | None = None) -> tuple[list[dict], list[dict]]:
    """All context nodes and edges of repo, or only those from these repo-relative files (plus edges into them)."""
    repo = Path(repo)
    parts: list[tuple[list[dict], list[dict]]] = []
    for p in sorted(repo.glob("specs/*/spec.md")):
        parts.append(_spec(repo, p.parent.relative_to(repo).as_posix()))
    for p in sorted(repo.glob("specs/*/tasks.md")):
        parts.append(_tasks(repo, p.parent.relative_to(repo).as_posix()))
    for d in sorted({p.parent for p in [*repo.glob(".scratch/*/spec.md"), *repo.glob(".scratch/*/issues")]}):
        parts.append(_scratch(repo, d.relative_to(repo).as_posix()))
    parts += [_prd(repo, p) for p in sorted(repo.glob(".claude/prds/*.md"))]
    if (repo / "PLAN.md").exists():
        parts.append(_plan(repo))
    if (repo / "CLAUDE.md").exists():
        parts.append((_decisions(repo), []))
    nodes: dict[str, dict] = {}
    for ns, _ in parts:
        for n in ns:
            nodes.setdefault(n["id"], n)  # first one wins on a repeated id
    edges = {(e["src"], e["dst"], e["relation"]): e for _, es in parts for e in es}
    if files is not None:
        # ponytail: parses every source then filters (a few hundred KB of markdown); read only `files` if it gets slow
        keep = {f.replace("/plan.md", "/spec.md") if f.startswith("specs/") else f for f in files}
        nodes = {k: n for k, n in nodes.items() if n["source_file"] in keep}
        edges = {k: e for k, e in edges.items() if e["src"] in nodes or e["dst"] in nodes}
    return list(nodes.values()), list(edges.values())


def summary(nodes: list[dict]) -> dict:
    """Counts per node type, and per feature under "by_feature" (e.g. by_feature["specs/001-n8n-parity"]["stories"])."""
    out: dict = dict.fromkeys([*KEYS.values(), "prds"], 0) | {"by_feature": {}}
    for n in nodes:
        if not (k := KEYS.get(n["type"])):
            continue
        k = "prds" if k == "features" and n["id"].startswith("ctx:prd:") else k
        out[k] += 1
        if f := n["meta"].get("feature"):
            out["by_feature"].setdefault(f, {}).setdefault(k, 0)
            out["by_feature"][f][k] += 1
    return out


if __name__ == "__main__":
    import json
    from collections import Counter

    repo = Path.cwd()
    nodes, edges = parse_repo(repo)
    s = summary(nodes)
    if (repo / "specs/001-n8n-parity/spec.md").exists():
        assert s["by_feature"]["specs/001-n8n-parity"]["stories"] == 16, s["by_feature"]["specs/001-n8n-parity"]
    if (repo / ".scratch/n8n-parity/issues").is_dir():
        assert s["by_feature"][".scratch/n8n-parity"]["tickets"] == 17, s["by_feature"][".scratch/n8n-parity"]
    assert s["decisions"] >= 20, s
    print(json.dumps(s | {"edges": dict(Counter(e["relation"] for e in edges))}, indent=1, ensure_ascii=False))
