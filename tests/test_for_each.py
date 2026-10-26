"""For-each at the engine seam (US14 / ticket 13, FR-032): a shell prints a JSON list, the foreach runs the (fake)
agent body once per item with {{item}} and {{index}}, and its done output lists the body outputs. Uses the
tests/conftest.py fixtures; skips when CTC_DATABASE_URL is unset or Supabase.
Run: `CTC_DATABASE_URL=<scratch> uv run pytest -q tests/test_for_each.py`.
"""

import json

from ctc.runner import engine

QUOTA = {"is_error": True, "api_error_status": 429, "result": "You've hit your session limit · resets 3pm"}


def wf(names: str = '["ann","bob","cy"]', each: str = "", fix: str = "") -> str:
    """trigger -> names (prints `names`) -> each (foreach); body -> fix (agent) -> each; done -> report."""
    return f"""name: fe
nodes:
- {{id: start, type: trigger}}
- {{id: names, type: shell, command: {json.dumps(f"printf '%s' '{names}'")}}}
- {{id: each, type: foreach, items: names.stdout_tail{each}}}
- {{id: fix, type: agent, prompt: 'fix {{{{item}}}} #{{{{index}}}}'{fix}}}
- {{id: report, type: shell, command: 'echo {{{{each.items}}}}'}}
edges:
- {{from: start, to: names}}
- {{from: names, to: each}}
- {{from: each, to: fix, handle: body}}
- {{from: fix, to: each}}
- {{from: each, to: report, handle: done}}
"""


def of(steps, nid: str, status: str = "done") -> list:
    return [s for s in steps if s["node_id"] == nid and s["status"] == status]


def last_each(steps) -> dict:
    return [s for s in steps if s["node_id"] == "each"][-1]


def test_one_fixer_per_item(run_yaml):
    run, steps = run_yaml(wf(), claude_script=[{"result": "r1"}, {"result": "r2"}, {"result": "r3"}])
    assert run["status"] == "done", run["error"]
    fixes = of(steps, "fix")
    assert [s["input"] for s in fixes] == ["fix ann #0", "fix bob #1", "fix cy #2"]
    assert last_each(steps)["output"] == {"items": [s["output"] for s in fixes]}
    assert [s["output"]["result"] for s in fixes] == ["r1", "r2", "r3"]
    assert len(of(steps, "report")) == 1


def test_max_items_truncates(run_yaml):
    run, steps = run_yaml(wf(each=", max_items: 2"))
    assert run["status"] == "done" and len(of(steps, "fix")) == 2
    out = last_each(steps)["output"]
    assert len(out["items"]) == 2 and out["truncated_from"] == 3


def test_empty_list_runs_no_body(run_yaml):
    run, steps = run_yaml(wf(names="[]"))
    assert run["status"] == "done"
    assert not of(steps, "fix") and of(steps, "fix", "skipped")
    assert last_each(steps)["output"] == {"items": []} and len(of(steps, "report")) == 1


def test_items_not_a_json_array_fail_the_run(run_yaml):
    run, steps = run_yaml(wf(names="oops"))
    assert run["status"] == "failed"
    each = last_each(steps)
    assert each["status"] == "failed" and "JSON array" in each["error"]


def test_failed_body_item_stops_the_run_by_default(run_yaml):
    run, steps = run_yaml(wf(), claude_script=[{"result": "r1"}, {"is_error": True, "result": "boom"}, {"result": "r3"}])
    assert run["status"] == "failed"
    assert [s["output"]["result"] for s in of(steps, "fix")] == ["r1"]
    assert of(steps, "fix", "failed")[0]["input"] == "fix bob #1"


def test_failed_body_item_continues_with_on_error_continue(run_yaml):
    run, steps = run_yaml(wf(fix=", on_error: continue"),
                          claude_script=[{"result": "r1"}, {"is_error": True, "result": "boom"}, {"result": "r3"}])
    assert run["status"] == "done", run["error"]
    items = last_each(steps)["output"]["items"]
    assert [i["result"] for i in items] == ["r1", "boom", "r3"] and items[1]["is_error"] is True


def test_resume_mid_body_keeps_item_and_index(run_yaml, walk_run, in_store):
    run, steps = run_yaml(wf(), claude_script=[{"result": "r1"}, QUOTA, {"result": "r2"}, {"result": "r3"}])
    assert run["status"] == "quota", run["error"]

    async def go(st):
        return await engine.resume(st, run["id"], run["owner"], now=True)
    assert in_store(go)
    run, steps = walk_run(run["id"])
    assert run["status"] == "done", run["error"]
    fixes = of(steps, "fix")
    assert [s["input"] for s in fixes] == ["fix ann #0", "fix bob #1", "fix cy #2"]  # item/index from the saved state
    assert [i["result"] for i in last_each(steps)["output"]["items"]] == ["r1", "r2", "r3"]


def test_retry_after_a_failed_item_rebuilds_the_foreach_state(run_yaml, walk_run, in_store):
    run, _ = run_yaml(wf(), claude_script=[{"result": "r1"}, {"is_error": True, "result": "boom"}, {"result": "r2"},
                                           {"result": "r3"}])
    assert run["status"] == "failed"

    async def go(st):
        return await engine.retry(st, run["owner"], run["id"], run["graph"], run["file_sha"])
    run, steps = walk_run(in_store(go))
    assert run["status"] == "done", run["error"]
    assert [s["input"] for s in of(steps, "fix")] == ["fix ann #0", "fix bob #1", "fix cy #2"]
    assert [i["result"] for i in last_each(steps)["output"]["items"]] == ["r1", "r2", "r3"]
