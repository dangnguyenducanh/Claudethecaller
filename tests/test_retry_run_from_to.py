"""Retry a run, run from a node, run up to a node (ticket 11, spec User Story 1) at the engine seam (tests/conftest.py):
a parent run is walked with run_yaml, then engine.retry() queues a child that walk_run() walks. DB cases skip when
CTC_DATABASE_URL is unset or Supabase.
Run: `CTC_DATABASE_URL=<scratch> uv run pytest -q tests/test_retry_run_from_to.py`.
"""

from pathlib import Path

import httpx
import pytest
import yaml
from fastapi import FastAPI

from ctc.runner import engine, graph
from ctc.server import runs

LOOP = (Path(__file__).resolve().parents[1] / ".claude" / "ctc-workflows" / "loop-demo.yaml").read_text()

# d times out (shell timeouts fail a run; a non-zero exit is data), so a run of CHAIN fails at its 5th node
CHAIN = """
name: chain
nodes:
- {id: start, type: trigger}
- {id: a, type: shell, command: "echo a > a.txt"}
- {id: b, type: agent, prompt: "{{a.stdout_tail}}"}
- {id: c, type: shell, command: "echo c > c.txt"}
- {id: d, type: shell, command: "sleep 5", timeout_s: 1}
- {id: e, type: shell, command: "echo {{b.result}}"}
edges:
- {from: start, to: a}
- {from: a, to: b}
- {from: b, to: c}
- {from: c, to: d}
- {from: d, to: e}
"""
FIXED = CHAIN.replace('"sleep 5"', "'true'")  # the chain as saved after the fix
B = {"result": "from-b"}


def g_of(text: str) -> dict:
    return graph.load(yaml.safe_load(text))


def by_node(steps: list[dict]) -> dict[str, dict]:
    return {s["node_id"]: s for s in steps}


def test_retry_runs_only_the_failed_node_onward(run_yaml, in_store, walk_run):
    parent, psteps = run_yaml(CHAIN, claude_script=B)
    p = by_node(psteps)
    assert parent["status"] == "failed" and p["d"]["status"] == "timeout"

    rid = in_store(lambda st: engine.retry(st, parent["owner"], parent["id"], g_of(FIXED), "sha2"))
    child, csteps = walk_run(rid)
    c = by_node(csteps)
    assert child["status"] == "done", child["error"]
    assert (child["parent_run_id"], child["from_node"], child["to_node"]) == (parent["id"], "d", None)
    for n in ("start", "a", "b", "c"):
        assert (c[n]["marker"], c[n]["visit"], c[n]["status"]) == ("reused", 1, "done"), n
        assert c[n]["output"] == p[n]["output"], n
    for n in ("d", "e"):
        assert (c[n]["marker"], c[n]["status"]) == (None, "done"), n
    assert "from-b" in c["e"]["output"]["stdout_tail"]  # templates read the reused outputs
    assert child["tokens"] == 0 and c["b"]["usage"] is None
    assert child["base_sha"] == p["d"]["pre_sha"] == c["d"]["pre_sha"]


def test_run_from_a_middle_node_of_a_done_run(run_yaml, in_store, walk_run):
    parent, psteps = run_yaml(FIXED, claude_script=B)
    assert parent["status"] == "done"
    rid = in_store(lambda st: engine.retry(st, parent["owner"], parent["id"], g_of(FIXED), "sha", from_node="c"))
    child, csteps = walk_run(rid)
    c, p = by_node(csteps), by_node(psteps)
    assert child["status"] == "done", child["error"]
    assert [n for n in c if c[n]["marker"] == "reused"] == ["start", "a", "b"]
    assert all(c[n]["marker"] is None and c[n]["status"] == "done" for n in ("c", "d", "e"))
    assert c["c"]["pre_sha"] == p["c"]["pre_sha"] == child["base_sha"]


def test_run_to_stops_done_after_the_chosen_node(run_yaml, in_store, walk_run):
    parent, _ = run_yaml(FIXED, claude_script=B)
    rid = in_store(lambda st: engine.retry(st, parent["owner"], parent["id"], g_of(FIXED), "sha", "start", "b"))
    child, csteps = walk_run(rid)
    assert child["status"] == "done", child["error"]
    assert [(s["node_id"], s["marker"], s["status"]) for s in csteps] == [
        ("start", None, "done"), ("a", None, "done"), ("b", None, "done")]
    assert (child["base_sha"], child["from_node"], child["to_node"]) == (parent["base_sha"], "start", "b")

    rid = in_store(lambda st: engine.retry(st, parent["owner"], parent["id"], g_of(FIXED), "sha", "c", "d"))
    child, csteps = walk_run(rid)
    assert child["status"] == "done", child["error"]
    assert [s["node_id"] for s in csteps] == ["start", "a", "b", "c", "d"]  # no row for e


def test_run_from_inside_a_loop_keeps_the_visits(run_yaml, in_store, walk_run):
    parent, psteps = run_yaml(LOOP)
    assert parent["status"] == "done", parent["error"]
    rid = in_store(lambda st: engine.retry(st, parent["owner"], parent["id"], g_of(LOOP), "sha", "check"))
    child, csteps = walk_run(rid)
    assert child["status"] == "done", child["error"]
    assert [(s["node_id"], s["visit"]) for s in csteps if s["marker"] == "reused"] == [("start", 1), ("count", 1)]
    ran = [(s["node_id"], s["visit"]) for s in csteps if s["marker"] is None and s["status"] == "done"]
    assert {("check", 1), ("check", 2), ("check", 3), ("count", 2), ("count", 3)} <= set(ran)
    assert sorted((s["node_id"], s["visit"], s["status"]) for s in csteps) == sorted(
        (s["node_id"], s["visit"], s["status"]) for s in psteps)
    assert "counted to 3" in by_node(csteps)["finish"]["output"]["stdout_tail"]


def test_retry_refusals_say_why(run_yaml, in_store, seam):
    g = g_of(FIXED)

    async def queued(st):  # submitted, never walked
        o = await engine.owner()
        return await engine.retry(st, o, await engine.submit(st, o, "test:chain", g, "sha", str(seam.repo)), g, "sha")
    with pytest.raises(ValueError, match="is queued"):
        in_store(queued)

    parent, _ = run_yaml(CHAIN, claude_script=B)
    o, pid = parent["owner"], parent["id"]

    def retry(*a):
        return in_store(lambda st: engine.retry(st, o, pid, g, "sha", *a))
    with pytest.raises(ValueError, match="nope is not a node of test:chain"):
        retry("nope")
    with pytest.raises(ValueError, match="a does not come after c"):
        retry("c", "a")
    in_store(lambda st: st.store.execute("update wf_steps set pre_sha = repeat('0', 40) where run_id = %s and node_id = 'd'", (pid,)))
    with pytest.raises(ValueError, match="commit 000000000000 is gone"):
        retry()
    in_store(lambda st: st.store.execute("delete from wf_steps where run_id = %s", (pid,)))
    with pytest.raises(ValueError, match="c never ran in run .*; its steps were pruned"):
        retry("c")


def test_retry_api(run_yaml, in_store, seam):
    parent, _ = run_yaml(CHAIN, claude_script=B)
    wf = seam.tmp / "chain.yaml"
    wf.write_text(FIXED)

    async def go(st):  # the route loads the workflow file as saved now, found through the catalog
        st.store.catalog[parent["workflow"]] = {"kind": "workflow", "name": "chain", "namespace": "user", "path": str(wf),
                                                "description": ""}
        app = FastAPI()
        app.include_router(runs.router)
        app.state.st = st
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://ctc") as h:
            ok = await h.post(f"/api/runs/{parent['id']}/retry", json={})
            bad = await h.post(f"/api/runs/{parent['id']}/retry", json={"from_node": "nope"})
            missing = await h.post("/api/runs/1/retry", json={})
            child = await h.get(f"/api/runs/{ok.json()['run_id']}") if ok.status_code == 202 else ok
        return ok, bad, missing, child
    ok, bad, missing, child = in_store(go)
    assert ok.status_code == 202 and set(ok.json()) == {"run_id"}, ok.text
    assert bad.status_code == 422 and bad.json()["detail"]["code"] == "not_retryable", bad.text
    assert missing.status_code == 404 and missing.json()["detail"]["code"] == "not_found", missing.text
    d = child.json()
    assert (d["parent_run_id"], d["from_node"], d["to_node"]) == (parent["id"], "d", None), d
    assert [(s["node_id"], s["marker"]) for s in d["steps"]] == [("start", "reused"), ("a", "reused"), ("b", "reused"),
                                                                ("c", "reused")]
