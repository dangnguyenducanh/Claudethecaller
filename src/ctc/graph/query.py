"""Pull queries over a loaded RAM graph (m6 G5, contracts/mcp.md): search by meaning, explain a node, what a change
affects, the path between two nodes. Pure: server/mcp.py resolves the project, loads the graph and embeds the question.

Each returns a dict with the structured result, `truncated` (rows cut to keep `text` ≤ ~1,500 tokens) and `text`.
"""

from __future__ import annotations

from collections import deque

from ctc.graph.core import RANK

BRIDGE = {"implemented_in", "tested_by"}                                       # context -> code
CODE_REL = {"calls", "imports", "imports_from", "uses", "inherits", "references"}  # walked backwards by affected()
CHARS = 6000       # text budget, ~1,500 tokens
LINKS = 3          # bridge neighbours per search hit
NEIGHBOURS = 20    # explain()
MAX_DEPTH = 3      # affected()
MAX_HOPS = 6       # path()


def _node(g, i: str) -> dict:
    n = g.nodes[i]
    return {"id": i, "label": n["label"], "type": n["type"], "file": n["source_file"], "line": n["source_line"]}


def _ref(g, i: str) -> str:
    """One line per node: label [type] file:line (id)."""
    n = g.nodes[i]
    where = f" {n['source_file']}:{n['source_line'] or 1}" if n["source_file"] else ""
    return f"{n['label'][:120]} [{n['type']}]{where} ({i})"


def _arrow(relation: str, out: bool) -> str:
    return f"-{relation}->" if out else f"<-{relation}-"


def _cap(head: str, blocks: list[str], more: int = 0) -> tuple[str, int, int]:
    """head + whole blocks while the text stays ≤ CHARS; (text, blocks kept, truncated). Ends `(truncated: n more)` when
    blocks were cut or `more` rows were left out before."""
    text, n = head, 0
    for b in blocks:
        if len(text) + len(b) + 1 > CHARS - 24:  # room for the truncated line
            break
        text, n = f"{text}\n{b}" if text else b, n + 1
    cut = len(blocks) - n + more
    return (f"{text}\n(truncated: {cut} more)" if cut else text), n, cut


def resolve(g, x: str) -> str:
    """Node id for x: exact id, then exact label, then label without `()` (and a method's leading `.`), then a path's file
    node, then any node of that source_file. LookupError when nothing matches or a step matches several."""
    if x in g.nodes:
        return x
    base = x.rsplit("/", 1)[-1]
    for match in (lambda n: n["label"] == x,
                  lambda n: n["label"].removesuffix("()").lstrip(".") == x,
                  lambda n: n["source_file"] == x and n["label"] == base,
                  lambda n: n["source_file"] == x):
        hits = [i for i, n in g.nodes.items() if match(n)]
        if len(hits) == 1:
            return hits[0]
        if hits:
            raise LookupError(f"{x!r} matches {len(hits)} nodes, pass one id: {', '.join(hits[:5])}")
    raise LookupError(f"no node matching {x!r}")


def search(g, qv, graph: str = "both", k: int = 8) -> dict:
    """Top-k nodes by cosine, each with ≤ 3 neighbours across the bridge (context -> code via implemented_in/tested_by, code
    -> context reverse), CONFIRMED > EXTRACTED > INFERRED, then score. graph="context"|"coding" stays in that graph."""
    kind = None if graph == "both" else graph
    hits = []
    for i, cos in g.nearest(qv, k, kind=kind):
        links: dict[str, dict] = {}
        for o, r, c, s in sorted(g.neighbours(i, BRIDGE) if kind is None else (), key=lambda e: (RANK.get(e[2], 3), -e[3])):
            links.setdefault(o, {**_node(g, o), "relation": r, "confidence": c, "score": round(s, 3)})
        hits.append({**_node(g, i), "cos": round(cos, 3), "links": list(links.values())[:LINKS]})
    blocks = ["\n".join([f"{h['cos']:.2f} {_ref(g, h['id'])}", *(f"  {x['relation']} {x['confidence']} {_ref(g, x['id'])}"
                                                                  for x in h["links"])]) for h in hits]
    text, n, cut = _cap("", blocks)
    return {"hits": hits[:n], "truncated": cut, "text": text or "no node has an embedding yet: run `ctc graph build`"}


def explain(g, node: str) -> dict:
    """The node, its text and ≤ 20 neighbours (best confidence first), grouped by relation and direction."""
    i = resolve(g, node)
    every = [(o, r, d, c, s) for d, side in (("out", g.out), ("in", g.inc)) for o, r, c, s in side.get(i, ())]
    top = sorted(sorted(every, key=lambda e: (RANK.get(e[3], 3), -e[4]))[:NEIGHBOURS], key=lambda e: (e[1], e[2]))
    rows = [{**_node(g, o), "relation": r, "direction": d, "confidence": c, "score": round(s, 3)} for o, r, d, c, s in top]
    blocks, prev = [], None
    for x in rows:
        arrow = _arrow(x["relation"], x["direction"] == "out")
        line = f"  {x['confidence']} {_ref(g, x['id'])}"
        blocks.append(line if arrow == prev else f"{arrow}\n{line}")
        prev = arrow
    n = g.nodes[i]
    text, kept, cut = _cap("\n".join(filter(None, (_ref(g, i), n["text"]))), blocks, len(every) - len(top))
    return {"node": {**_node(g, i), "kind": n["kind"], "text": n["text"]}, "neighbours": rows[:kept], "truncated": cut, "text": text}


def affected(g, node: str) -> dict:
    """What a change to node can break: code reached backwards over calls/imports/uses/inherits/references (depth ≤ 3),
    then context: nodes linked to it or to any hit, nodes linked to its file, and their story/ticket."""
    i = resolve(g, node)
    via: dict[str, tuple[int, str]] = {i: (0, "")}
    q = deque([i])
    while q:
        u = q.popleft()
        for o, r, _, _ in g.inc.get(u, ()):
            if r in CODE_REL and o not in via and via[u][0] < MAX_DEPTH:
                via[o] = (via[u][0] + 1, r)
                q.append(o)
    ctx = {o: r for u in via for o, r, _, _ in g.neighbours(u) if g.nodes[o]["kind"] == "context"}
    for o in g.context_for_file(g.nodes[i]["source_file"] or ""):
        ctx.setdefault(o, "file")
    for o in list(ctx):
        for p, r, _, _ in g.neighbours(o, {"serves", "part_of"}, "out"):
            ctx.setdefault(p, r)
    ctx.pop(i, None)
    context = [{**_node(g, o), "relation": r} for o, r in ctx.items()]
    code = [{**_node(g, o), "depth": d, "relation": r} for o, (d, r) in via.items() if o != i]
    blocks = [f"  {x['depth']} {x['relation']} {_ref(g, x['id'])}" for x in code] + [f"  {x['relation']} {_ref(g, x['id'])}" for x in context]
    text, n, cut = _cap(f"a change to {_ref(g, i)} affects {len(code)} code and {len(context)} context nodes:", blocks)
    return {"node": _node(g, i), "code": code[:n], "context": context[:max(0, n - len(code))], "truncated": cut, "text": text}


def path(g, a: str, b: str) -> dict | None:
    """Shortest path a .. b ignoring edge direction (BFS, ≤ 6 hops) as hops {from, relation, to, forward}; None if none."""
    s, t = resolve(g, a), resolve(g, b)
    prev: dict[str, tuple[str, str, bool] | None] = {s: None}
    q = deque([(s, 0)])
    while q and t not in prev:
        u, d = q.popleft()
        for side, fwd in ((g.out, True), (g.inc, False)):
            for o, r, _, _ in side.get(u, ()) if d < MAX_HOPS else ():
                if o not in prev:
                    prev[o] = (u, r, fwd)
                    q.append((o, d + 1))
    if t not in prev:
        return None
    hops, v = [], t
    while prev[v]:
        u, r, fwd = prev[v]
        hops.append({"from": u, "relation": r, "to": v, "forward": fwd})
        v = u
    hops.reverse()
    lines = [f"  {_arrow(h['relation'], h['forward'])} {_ref(g, h['to'])}" for h in hops]
    return {"hops": hops, "truncated": 0, "text": "\n".join([_ref(g, s), *lines])}
