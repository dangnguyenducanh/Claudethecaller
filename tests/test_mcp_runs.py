"""US4 (ticket 04): drive runs from the CLI and from Claude over MCP. The MCP run tools call server/runs.py's route
helpers (the dashboard's code path and owner scoping); DB cases use the tests/conftest.py seam and skip without a
scratch Postgres. The CLI case is DB-free: ctc.cli._api is recorded."""

import json
import re

import pytest
import yaml
from mcp.server.mcpserver.exceptions import ToolError
from typer.testing import CliRunner

import ctc.cli
from ctc.ingestion.scanner import _make_capability, project_namespace
from ctc.runner import engine, graph
from ctc.server import mcp

LONG = """
name: long
nodes:
- {id: start, type: trigger}
- {id: say, type: shell, command: "python3 -c \\"print('x'*5000)\\""}
edges:
- {from: start, to: say}
"""
GATE = """
name: gate
nodes:
- {id: start, type: trigger}
- {id: ok, type: approval, message: "Ship {{input}}?"}
- {id: after, type: shell, command: echo shipped}
edges:
- {from: start, to: ok}
- {from: ok, to: after}
"""
AGENT = """
name: ask
nodes:
- {id: start, type: trigger}
- {id: ask, type: agent, prompt: "Say {{input}}"}
edges:
- {from: start, to: ask}
"""


@pytest.fixture
def tool(in_store, monkeypatch):
    """tool(name, **args) -> the MCP tool's structured result, called as Claude would (no HTTP request: user local)."""
    def call(name, **args):
        async def go(st):
            monkeypatch.setattr(mcp, "state", st)
            return (await mcp.mcp.call_tool(name, args)).structured_content
        return in_store(go)
    return call


def test_workflow_status_reads_the_run_page_with_outputs_cut(run_yaml, tool):
    run, _ = run_yaml(LONG)
    r = tool("workflow_status", run_id=run["id"])
    assert (r["run_id"], r["workflow"], r["status"], r["error"]) == (run["id"], "test:long", "done", None)
    s = {x["node_id"]: x for x in r["steps"]}
    say = s["say"]
    assert (say["visit"], say["kind"], say["status"], say["error"]) == (1, "shell", "done", None)
    head, note = say["output"][:2000], say["output"][2000:]  # STEP_OUT_MAX = 2000
    assert head.startswith('{"exit_code": 0') and '"stdout_tail": "xxxx' in head
    assert re.fullmatch(r"\.\.\. \[2\d\d\d more chars: see the run page\]", note), note  # ~4100 chars of JSON
    assert s["start"]["output"] == '{"input": ""}'


def test_approve_run_walks_a_waiting_run_on(run_yaml, tool):
    run, _ = run_yaml(GATE, input="v2")
    assert run["status"] == "waiting"
    before = {x["node_id"]: x for x in tool("workflow_status", run_id=run["id"])["steps"]}
    assert (before["ok"]["status"], before["ok"]["input"]) == ("waiting", "Ship v2?")
    assert tool("approve_run", run_id=run["id"], note="lgtm") == {"run_id": run["id"], "status": "queued", "error": None}
    ok = {x["node_id"]: x for x in tool("workflow_status", run_id=run["id"])["steps"]}["ok"]
    assert (ok["status"], json.loads(ok["output"])) == ("done", {"approved": True, "note": "lgtm"})
    assert "input" not in ok


def test_reject_run_ends_a_waiting_run_and_neither_works_on_a_done_run(run_yaml, tool):
    run, _ = run_yaml(GATE)
    assert tool("reject_run", run_id=run["id"], note="no")["status"] == "cancelled"
    ok = {x["node_id"]: x for x in tool("workflow_status", run_id=run["id"])["steps"]}["ok"]
    assert ok["status"] == "cancelled"
    done, _ = run_yaml(LONG)
    for name in ("approve_run", "reject_run"):
        with pytest.raises(ToolError, match=f"run {done['id']} is not waiting for an approval"):
            tool(name, run_id=done["id"])


def test_cancel_run_stops_a_queued_run(seam, in_store, tool):
    async def submit(st):
        return await engine.submit(st, await engine.owner(), "test:long", graph.load(yaml.safe_load(LONG)), "sha", str(seam.repo))
    rid = in_store(submit)
    assert tool("cancel_run", run_id=rid) == {"run_id": rid, "status": "cancelled", "error": None}


def test_continue_run_now_requeues_a_quota_run_only(run_yaml, tool):
    run, _ = run_yaml(AGENT, claude_script="scripts/fake_claude_quota.sh")
    assert run["status"] == "quota"
    assert tool("continue_run", run_id=run["id"], when="now")["status"] == "queued"
    done, _ = run_yaml(LONG)
    with pytest.raises(ToolError, match="is not stopped at a usage limit"):
        tool("continue_run", run_id=done["id"], when="now")


def test_run_tools_never_touch_another_logins_run(in_store, tool):
    rid = in_store(lambda st: st.store.fetchval(
        "insert into wf_runs (owner, workflow, file_sha, graph, trigger, status)"
        " values ('someone@else', 'w', 'x', '{}', 'cli', 'waiting') returning id"))
    for name, args in [("workflow_status", {}), ("approve_run", {}), ("reject_run", {}), ("continue_run", {"when": "now"}),
                       ("cancel_run", {})]:
        with pytest.raises(ToolError, match=f"no run {rid}"):
            tool(name, run_id=rid, **args)
    assert in_store(lambda st: st.store.fetchval("select status from wf_runs where id = %s", (rid,))) == "waiting"


def _register(st, seam, *items):
    """Index workflow files like `ctc index`: (scope, name) with scope user | project (seam.repo) | a plugin namespace."""
    caps, nss = [], set()
    for scope, name in items:
        if scope == "user":
            d, ns = seam.tmp / "home" / "ctc-workflows", "user"
        elif scope == "project":
            d, ns = seam.repo / ".claude" / "ctc-workflows", project_namespace(seam.repo)
        else:
            d, ns = seam.tmp / scope / "ctc-workflows", scope
        d.mkdir(parents=True, exist_ok=True)
        (f := d / f"{name}.yaml").write_text(LONG.replace("name: long", f"name: {name}\ndescription: {name} desc"))
        caps.append(_make_capability(f, "workflow", ns, name))
        nss.add(ns)
    return st.store.upsert(caps, sorted(nss))


def test_list_workflows_names_scope_project_and_schedule(seam, in_store, tool):
    async def go(st):
        await _register(st, seam, ("user", "uw"), ("project", "pw"), ("plug", "gw"))
        await st.store.ensure_project(str(seam.repo))
        o = await engine.owner()
        pw = f"{project_namespace(seam.repo)}:pw"
        await st.store.execute("insert into wf_schedules (owner, workflow, cron, enabled) values (%s, %s, '0 9 * * *', true),"
                               " (%s, 'user:uw', '0 9 * * *', false), ('someone@else', 'plug:gw', '0 9 * * *', true)", (o, pw, o))
        return pw
    pw = in_store(go)
    got = {w["id"]: w for w in tool("list_workflows")["workflows"]}
    assert got["user:uw"] == {"id": "user:uw", "name": "uw", "scope": "user", "project": None, "description": "uw desc",
                              "has_schedule": False}
    assert got[pw] == {"id": pw, "name": "pw", "scope": "project", "project": "repo", "description": "pw desc",
                       "has_schedule": True}
    assert (got["plug:gw"]["scope"], got["plug:gw"]["project"], got["plug:gw"]["has_schedule"]) == ("plugin", None, False)


def test_run_workflow_runs_a_user_workflow_in_the_latest_prompts_project(seam, in_store, tool):
    other = seam.tmp / "other"
    other.mkdir()

    async def setup(st):
        await st.store.execute("truncate decisions, sessions, projects cascade")
        await _register(st, seam, ("user", "uw"))
    in_store(setup)
    with pytest.raises(ToolError, match="needs a project to run in"):
        tool("run_workflow", workflow="uw")

    async def prompts(st):  # a hooked prompt in seam.repo: the newest decisions row names its project
        await st.store.ensure_project(str(other))
        name = await st.store.ensure_project(str(seam.repo))
        p = await st.store.fetchrow("select id, path from projects where name = %s", (name,))
        await st.store.execute("insert into sessions (id, project_id) values ('s1', %s)", (p["id"],))
        await st.store.execute("insert into decisions (session_id, project_id, ref, prompt, abstained, bundle)"
                               " values ('s1', %s, 'r1', 'p', false, '{}')", (p["id"],))
        return p, await st.store.fetchrow("select id, name, path from projects where name <> %s", (name,))
    p, q = in_store(prompts)
    rid = tool("run_workflow", workflow="uw")["run_id"]
    named = tool("run_workflow", workflow="user:uw", project=q["name"])["run_id"]
    rows = in_store(lambda st: st.store.fetch("select id, project_id, repo, trigger from wf_runs where id = any(%s) order by id",
                                              ([rid, named],)))
    assert rows == [{"id": rid, "project_id": p["id"], "repo": p["path"], "trigger": "mcp"},
                    {"id": named, "project_id": q["id"], "repo": q["path"], "trigger": "mcp"}]


def test_cli_approve_and_reject_post_the_approve_route(monkeypatch):
    calls = []

    def api(method, path, **kw):
        calls.append((method, path, kw.get("json")))
        return {"id": 5, "workflow": "w", "status": "queued"}
    monkeypatch.setattr(ctc.cli, "_api", api)
    ok = CliRunner().invoke(ctc.cli.app, ["approve", "5", "--note", "lgtm"])
    no = CliRunner().invoke(ctc.cli.app, ["reject", "5"])
    assert (ok.exit_code, no.exit_code) == (0, 0), ok.output + no.output
    assert calls == [("POST", "/runs/5/approve", {"approve": True, "note": "lgtm"}),
                     ("POST", "/runs/5/approve", {"approve": False, "note": None})]
    assert "run #5 · w" in ok.output
