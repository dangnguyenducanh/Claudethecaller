"""m6 G1: graphify import, graph store write rules, RAM graph. DB cases run on the scratch Postgres only (conftest)."""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from ctc.graph import core, db, importer
from ctc.ingestion.scanner import project_id

CODE = {"code:src_x", "code:src_x_foo", "code:src_x_bar"}


def write_graph(repo: Path, built: str = "abc1234") -> Path:
    def node(id_, label, line, ft="code"):
        return {"id": id_, "label": label, "file_type": ft, "source_file": "src/x.py", "source_location": f"L{line}",
                "community": 0, "community_name": "X"}

    g = {"directed": False, "multigraph": False, "graph": {}, "nodes": [
        node("src_x", "x.py", 1), node("src_x_foo", "foo()", 10), node("src_x_bar", "bar()", 30),
        node("src_x_rationale_11", "Why foo retries twice", 11, "rationale"),
        {"id": "readme", "label": "README", "file_type": "document", "source_file": "README.md", "source_location": "L1"},
        {"id": "retry", "label": "retry", "file_type": "concept"},
    ], "links": [
        {"source": "src_x", "target": "src_x_foo", "relation": "contains", "confidence": "EXTRACTED", "confidence_score": 1.0},
        {"source": "src_x_foo", "target": "src_x_bar", "relation": "calls"},  # no confidence fields: EXTRACTED, 1.0
        {"source": "src_x_rationale_11", "target": "src_x_foo", "relation": "rationale_for", "confidence": "EXTRACTED"},
        {"source": "readme", "target": "src_x", "relation": "references", "confidence": "INFERRED", "confidence_score": 0.6},
    ], "hyperedges": [], "built_at_commit": built}
    p = repo / "graphify-out" / "graph.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(g))
    return p


def test_read_graphify(tmp_path):
    nodes, edges, built = importer.read_graphify(write_graph(tmp_path))
    by = {n["id"]: n for n in nodes}
    assert built == "abc1234"
    assert set(by) == CODE | {"code:src_x_rationale_11"}  # document/concept nodes dropped
    assert {n["kind"] for n in nodes} == {"coding"} and {n["origin"] for n in nodes} == {"graphify"}
    assert {i: (n["type"], n["source_line"]) for i, n in by.items()} == {
        "code:src_x": ("code", 1), "code:src_x_foo": ("code", 10), "code:src_x_bar": ("code", 30),
        "code:src_x_rationale_11": ("rationale", 11)}
    assert "Why foo retries twice" in by["code:src_x_foo"]["text"] and "src/x.py" in by["code:src_x_foo"]["text"]
    assert by["code:src_x"]["source_file"] == "src/x.py" and by["code:src_x"]["meta"] == {"community": "X"}
    assert {(e["src"], e["dst"], e["relation"]) for e in edges} == {
        ("code:src_x", "code:src_x_foo", "contains"), ("code:src_x_foo", "code:src_x_bar", "calls"),
        ("code:src_x_rationale_11", "code:src_x_foo", "rationale_for")}  # the link touching the document is dropped
    assert all((e["confidence"], e["score"], e["origin"]) == ("EXTRACTED", 1.0, "graphify") for e in edges)


def test_graphify_stale_and_bad_files(tmp_path):
    write_graph(tmp_path)
    assert not importer.graphify_stale(tmp_path, "abc1234")
    assert importer.graphify_stale(tmp_path, "zzz") and importer.graphify_stale(tmp_path, None)
    assert importer.graphify_stale(tmp_path / "missing", "abc1234")
    with pytest.raises(FileNotFoundError):
        importer.read_graphify(tmp_path / "missing.json")
    (bad := tmp_path / "bad.json").write_text("{nope")
    with pytest.raises(ValueError):
        importer.read_graphify(bad)


def test_import_skips_unchanged_and_force_reimports(tmp_path, in_store):
    write_graph(tmp_path)
    P = ("local", "p_import")

    async def go(s):
        a = await importer.import_graphify(s, *P, tmp_path)
        b = await importer.import_graphify(s, *P, tmp_path)
        c = await importer.import_graphify(s, *P, tmp_path, force=True)
        return a, b, c, await db.counts(s, *P), await db.get_source(s, *P, "graphify")

    a, b, c, counts, src = in_store(go)
    assert a == {"nodes": 4, "edges": 3, "built_at": "abc1234", "skipped": False}
    assert b["skipped"] and not c["skipped"]
    assert counts == {"nodes": {"coding": {"code": 3, "rationale": 1}}, "edges": {"EXTRACTED": 3}, "tasks_linked": None}
    assert (src["version"], src["info"]) == ("abc1234", {"nodes": 4, "edges": 3})


TASK = {"id": "ctx:specs/x:T001", "kind": "context", "type": "task", "label": "T001 build foo", "text": "in src/x.py",
        "source_file": "specs/x/tasks.md", "source_line": 5, "origin": "parser", "meta": {"status": "[ ]"}}
LINK = {"src": TASK["id"], "dst": "code:src_x_foo", "relation": "implemented_in", "confidence": "EXTRACTED", "score": 1.0,
        "origin": "parser"}


def test_replace_origin_rules(tmp_path, in_store):
    write_graph(tmp_path)
    P = ("local", "p_origin")
    task2 = {**TASK, "id": "ctx:specs/y:T001", "source_file": "specs/y/tasks.md"}

    async def need(s):
        return {i for i, _ in await db.need_embedding(s, *P)}

    async def go(s):
        r = {}
        await importer.import_graphify(s, *P, tmp_path)
        await db.replace_origin(s, *P, "parser", [TASK], [LINK])
        r["first"] = await db.counts(s, *P)
        await db.set_embeddings(s, *P, [(TASK["id"], np.ones(1024, np.float32))])
        r["review"] = await db.set_confidence(s, *P, TASK["id"], "code:src_x_foo", "implemented_in", "CONFIRMED", "review")
        r["missing"] = await db.set_confidence(s, *P, TASK["id"], "code:nope", "implemented_in", "CONFIRMED", "review")
        await db.replace_origin(s, *P, "parser", [TASK], [LINK])  # a rebuild re-emits the EXTRACTED link: review wins
        r["kept"] = await s.fetchrow("select confidence, origin from graph_edges where project_id = %s and src = %s", (P[1], TASK["id"]))
        r["need_same"] = await need(s)  # unchanged content keeps its embedding
        await db.replace_origin(s, *P, "parser", [{**TASK, "label": "T001 build foo, v2"}], [])
        r["need_changed"] = await need(s)
        r["after_no_edges"] = await db.counts(s, *P)  # the review edge outlives its origin's rebuild
        await db.replace_origin(s, *P, "parser", [task2], [], files=["specs/y/tasks.md"])  # other files untouched
        r["files"] = await db.counts(s, *P)
        await db.replace_origin(s, *P, "parser", [], [])  # both tasks gone: the review edge dangles and goes
        r["gone"] = await db.counts(s, *P)
        return r

    r = in_store(go)
    coding = {"coding": {"code": 3, "rationale": 1}}
    assert r["first"] == {"nodes": {**coding, "context": {"task": 1}}, "edges": {"EXTRACTED": 4}, "tasks_linked": 1.0}
    assert r["review"] and not r["missing"]
    assert r["kept"] == {"confidence": "CONFIRMED", "origin": "review"}
    assert TASK["id"] not in r["need_same"] and TASK["id"] in r["need_changed"]
    assert r["after_no_edges"]["edges"] == {"EXTRACTED": 3, "CONFIRMED": 1}
    assert r["files"]["nodes"]["context"] == {"task": 2} and r["files"]["tasks_linked"] == 0.5
    assert r["gone"] == {"nodes": coding, "edges": {"EXTRACTED": 3}, "tasks_linked": None}


def test_ram_graph(tmp_path, in_store):
    write_graph(tmp_path)
    P = ("local", project_id(tmp_path))
    rng = np.random.default_rng(0)
    links = [LINK, {**LINK, "dst": "code:src_x_bar", "relation": "tested_by", "confidence": "INFERRED", "score": 0.7, "origin": "embed"}]

    async def go(s):
        await importer.import_graphify(s, *P, tmp_path)
        texts = dict(await db.need_embedding(s, *P))
        vecs = {i: rng.normal(size=1024).astype(np.float32) for i in texts}
        await db.set_embeddings(s, *P, list(vecs.items()))
        await s.execute("update graph_edges set confidence = 'DROPPED' where project_id = %s and relation = 'calls'", (P[1],))
        await s.execute("insert into graph_edges (project_id, src, dst, relation, confidence, origin)"
                        " values (%s, 'code:src_x', 'code:gone', 'calls', 'EXTRACTED', 'graphify')", (P[1],))
        await db.replace_origin(s, *P, "parser", [TASK], links)
        await db.upsert_edges(s, *P, [{**LINK, "dst": "code:src_x", "confidence": "CONFIRMED", "origin": "session"}])
        dangling = await s.fetchval("select count(*) from graph_edges where project_id = %s and dst = 'code:gone'", (P[1],))

        st = SimpleNamespace(store=s, graphs={})
        first = await core.graph_for(st, str(tmp_path))  # cache empty: schedules a load, never waits for it
        await asyncio.gather(*list(core._LOADING.values()))
        g = await core.graph_for(st, str(tmp_path))
        core.invalidate(st, *P)
        return texts, vecs, dangling, first, g, st.graphs

    texts, vecs, dangling, first, g, left = in_store(go)
    assert set(texts) == CODE | {"code:src_x_rationale_11"} and texts["code:src_x_foo"].startswith("foo()\n")
    assert dangling == 0 and first is None and left == {}
    v = vecs["code:src_x_bar"]
    top = g.nearest(v * 3, 2)  # stored vectors are unit length, the query is normalised
    assert len(top) == 2 and top[0][0] == "code:src_x_bar" and abs(top[0][1] - 1) < 1e-5
    assert [i for i, _ in g.nearest(v, 5, types={"rationale"})] == ["code:src_x_rationale_11"]
    assert g.nearest(v, 5, kind="context") == []  # the task has no embedding yet
    assert "code:src_x_bar" not in [d for d, *_ in g.out.get("code:src_x_foo", [])]  # DROPPED edge left out
    assert ("code:src_x_foo", "calls", "EXTRACTED", 1.0) not in g.inc["code:src_x_bar"]
    assert ("code:src_x_foo", "contains", "EXTRACTED", 1.0) in g.out["code:src_x"]
    assert CODE <= set(g.by_file["src/x.py"]) and TASK["id"] in g.by_file["src/x.py"]
    assert [i for i, *_ in g.code_for(TASK["id"])] == ["code:src_x", "code:src_x_foo", "code:src_x_bar"]
    assert g.context_for_file("src/x.py") == [TASK["id"]] and g.context_for_file("specs/x/tasks.md") == []
    assert g.neighbours("code:src_x_foo", {"implemented_in"}, "in") == [(TASK["id"], "implemented_in", "EXTRACTED", 1.0)]
