"""m6 G4: background extractor (chunks, prompt, XML parse, cache, quota), PostToolUse graph triggers, tick detection.
No test runs the real `claude -p`: extract._call and proc.preflight are monkeypatched. DB cases: scratch Postgres (conftest)."""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from ctc.config import cfg
from ctc.graph import db, extract, parse
from ctc.ingestion.scanner import project_id
from ctc.server import hooks

SPEC = """# Feature Specification: Demo

Intro line.

### User Story 1 - Do a (Priority: P1)

Story one body.

## Assumptions

The cache lives in Redis only.
"""


def test_chunks_pack_sections_and_split_long_ones():
    assert extract.chunks("# A\none\n\n## B\ntwo\n", 100) == [(1, "# A\none\n\n## B\ntwo")]  # small sections packed
    assert extract.chunks("# A\none\n## B\ntwo\n", 8) == [(1, "# A\none"), (3, "## B\ntwo")]  # too big together
    text = "intro\n\n# A\n\none\n\n## B\n" + "\n\n".join(f"para {i} " + "x" * 30 for i in range(6)) + "\n"
    cs = extract.chunks(text, 100)
    assert cs[0][1].startswith("intro\n\n# A\n\none") and len(cs) > 1  # packed head, the long section split ...
    assert all(len(t) <= 100 for _, t in cs) and all(t.startswith("para") for _, t in cs[1:])  # ... at blank lines
    lines = text.splitlines()
    assert all(lines[s - 1] == t.splitlines()[0] for s, t in cs)  # each start line is the chunk's first line
    kept = [ln for _, t in cs for ln in t.splitlines() if ln.strip()]
    assert kept == [ln for ln in lines if ln.strip()]  # every line once, in order
    assert extract.chunks("one long line " * 20, 50) == [(1, ("one long line " * 20).rstrip())]  # never cuts inside a line
    assert "specs/x/tasks.md" not in extract.sources(Path(".")) and not extract.prose("specs/x/tasks.md")


def test_prompt_has_mode_parts_known_nodes_and_numbered_lines():
    mode, _ = extract.load_mode()
    p = extract.prompt(mode, {"ctx:specs/x:FR-001": "The system MUST do a."}, (7, "## Assumptions\n\nRedis only."))
    assert all(part.strip() in p for part in mode["prompts"].values())
    assert "ctx:specs/x:FR-001" in p and "The system MUST do a." in p
    assert "7: ## Assumptions" in p and "9: Redis only." in p


def test_parse_xml_keeps_known_types_relations_and_ends():
    out = """Here you go:
<node type="decision" slug="redis-cache" line="11"><title>Cache in Redis</title><text>p95 < 150 ms & no disk.</text></node>
<node type="story" slug="bad-type"><title>Not allowed</title><text>x</text></node>
<node type="constraint" slug="redis-cache"><title>Same slug again</title><text>y</text></node>
<edge from="redis-cache" to="ctx:specs/x:FR-001" relation="constrains"/>
<edge from="redis-cache" to="ctx:specs/x:FR-999" relation="constrains"/>
<edge from="redis-cache" to="ctx:specs/x:FR-001" relation="blocks"/>
<edge from="bad-type" to="ctx:specs/x:FR-001" relation="needs"/>"""
    nodes, edges = extract.parse_xml(out, {"ctx:specs/x:FR-001"}, "specs/x/spec.md")
    assert [(n["id"], n["type"], n["source_line"]) for n in nodes] == [
        ("ctx:specs/x/spec.md:x-redis-cache", "decision", 11), ("ctx:specs/x/spec.md:x-redis-cache-2", "constraint", None)]
    assert nodes[0]["text"] == "p95 < 150 ms & no disk." and {n["origin"] for n in nodes} == {"claude"}
    assert {(n["kind"], n["source_file"]) for n in nodes} == {("context", "specs/x/spec.md")}
    assert edges == [{"src": "ctx:specs/x/spec.md:x-redis-cache", "dst": "ctx:specs/x:FR-001", "relation": "constrains",
                      "confidence": "INFERRED", "score": 1.0, "origin": "claude"}]
    assert extract.parse_xml('<skip reason="nothing new"/>', set(), "f.md") == ([], [])
    assert extract.parse_xml("<node><title>x</node>", set(), "f.md") is None


def test_argv_haiku_one_turn_no_tools_no_hooks():
    a = extract.argv()
    assert a[a.index("--model") + 1] == "haiku" and a[a.index("--max-turns") + 1] == "1"
    assert json.loads(a[a.index("--settings") + 1]) == {"disableAllHooks": True}
    assert "--allowedTools" not in a and "-p" in a


def _repo(tmp_path: Path) -> Path:
    (tmp_path / "specs/009-demo").mkdir(parents=True)
    (tmp_path / "specs/009-demo/spec.md").write_text(SPEC)
    return tmp_path


def _st(store, tmp_path, cap=40, mode="local"):
    c = {**cfg(), "mode": mode, "graph_extract": {"dir": str(tmp_path / "extract"), "max_chunks_per_run": cap, "timeout_s": 5}}
    return SimpleNamespace(store=store, cfg=c, graphs={})


def _fake(monkeypatch, status="done"):
    calls = []

    async def call(argv, prompt, log_path, timeout_s=120):
        calls.append(prompt)
        line = next(ln.split(":")[0] for ln in prompt.splitlines()[::-1] if ln.split(":")[0].isdigit())
        out = (f'<node type="decision" slug="d{line}" line="{line}"><title>Decision {line}</title><text>Fact {line}.</text></node>'
               f'<edge from="d{line}" to="ctx:specs/009-demo:US1" relation="constrains"/>')
        return {"status": status, "output": {"result": out}, "usage": {"input_tokens": 100, "output_tokens": 20},
                "resets_at": "2999-01-01T00:00:00+00:00" if status == "quota" else None}

    async def pre(container=False):
        return {"ok": True, "error": None}

    monkeypatch.setattr(extract, "_call", call)
    monkeypatch.setattr(extract.proc, "preflight", pre)
    return calls


async def _prog(_):
    pass


def test_run_job_sends_changed_chunks_once(tmp_path, monkeypatch, in_store):
    repo, calls = _repo(tmp_path), _fake(monkeypatch)
    P, file = ("local", project_id(tmp_path)), "specs/009-demo/spec.md"
    payload = {"cwd": str(repo), "files": [file]}
    n = len(extract.chunks(SPEC, 6000))

    async def go(s):
        pnodes, _ = parse.parse_repo(repo, [file])
        await db.replace_origin(s, *P, "parser", pnodes, [])  # what graph_build wrote: the edges' known ends exist
        st = _st(s, tmp_path)
        a = await extract.run_job(st, payload, _prog)
        rows = await s.fetch("select id, type, origin from graph_nodes where project_id = %s and origin = 'claude'", (P[1],))
        e = await s.fetch("select src, dst, confidence from graph_edges where project_id = %s and origin = 'claude'", (P[1],))
        src = await db.get_source(s, *P, f"extract:{file}#0")
        b = await extract.run_job(st, payload, _prog)  # unchanged: no call
        (repo / file).write_text(SPEC.replace("Redis only.", "Redis and RAM."))
        c = await extract.run_job(st, payload, _prog)  # one section changed: one call
        rows2 = await s.fetchval("select count(*) from graph_nodes where project_id = %s and origin = 'claude'", (P[1],))
        return a, rows, e, src, b, c, rows2

    a, rows, e, src, b, c, rows2 = in_store(go)
    assert (a["chunks"], a["sent"], a["skipped"]) == (n, n, 0) and len(calls) == n + 1
    assert a["tokens"] == {"input_tokens": 100 * n, "output_tokens": 20 * n} and a["quota_until"] is None
    assert len(rows) == n and {(r["type"], r["origin"]) for r in rows} == {("decision", "claude")}
    assert len(e) == n and {r["confidence"] for r in e} == {"INFERRED"} and {r["dst"] for r in e} == {"ctx:specs/009-demo:US1"}
    assert len(src["version"]) == 32 and src["info"]["nodes"][0]["id"].startswith(f"ctx:{file}:x-")
    assert (b["sent"], b["skipped"]) == (0, n)
    assert (c["sent"], c["skipped"]) == (1, n - 1) and rows2 == n  # the changed section's node replaced, the others kept


def test_run_job_quota_stops_and_pauses(tmp_path, monkeypatch, in_store):
    repo, calls = _repo(tmp_path), _fake(monkeypatch, "quota")
    payload = {"cwd": str(repo), "files": ["specs/009-demo/spec.md"]}

    async def go(s):
        st = _st(s, tmp_path)
        return await extract.run_job(st, payload, _prog), await extract.run_job(st, payload, _prog)

    a, b = in_store(go)
    assert len(calls) == 1 and a["sent"] == 1 and a["quota_until"] == "2999-01-01T00:00:00+00:00" and a["remaining"] >= 1
    assert b["sent"] == 0 and b["quota_until"] == a["quota_until"]  # paused until the reset: no call at all


def test_run_job_cap_and_refusals(tmp_path, monkeypatch, in_store):
    repo, calls = _repo(tmp_path), _fake(monkeypatch)
    payload = {"cwd": str(repo), "files": ["specs/009-demo/spec.md"]}
    a = in_store(lambda s: extract.run_job(_st(s, tmp_path, cap=1), payload, _prog))
    assert a["sent"] == 1 and a["remaining"] == len(extract.chunks(SPEC, 6000)) - 1
    shared = asyncio.run(extract.run_job(_st(None, tmp_path, mode="shared"), payload, _prog))
    assert "error" in shared and len(calls) == 1

    async def bad(container=False):
        return {"ok": False, "error": "claude is not logged in"}

    monkeypatch.setattr(extract.proc, "preflight", bad)
    assert in_store(lambda s: extract.run_job(_st(s, tmp_path), payload, _prog)) == {"error": "claude is not logged in"}
    assert len(calls) == 1


# ---- PostToolUse triggers (hooks.hook_tool) ----------------------------------------------------------------------

def _client(monkeypatch, queued=None):
    subs, events = [], []

    async def submit(st, kind, payload, user_id="local"):
        subs.append((kind, payload))
        return "job"

    async def write(st, kind, row):
        events.append((kind, row))

    async def fetchval(sql, args):
        return queued

    async def get_json(key):
        return None

    monkeypatch.setattr(hooks, "submit", submit)
    monkeypatch.setattr(hooks, "write", write)
    app = FastAPI()
    app.include_router(hooks.router)
    app.state.ctc = SimpleNamespace(cfg={"mode": "local"}, store=SimpleNamespace(fetchval=fetchval),
                                    cache=SimpleNamespace(get_json=get_json))
    return TestClient(app), subs, events


def _post(c, cwd, tool, tin):
    r = c.post("/v1/hook/tool", content=json.dumps({"session_id": "s1", "cwd": cwd, "tool_name": tool, "tool_input": tin}))
    assert r.status_code == 204


def test_hook_write_of_spec_queues_build_and_extract(monkeypatch, tmp_path):
    c, subs, events = _client(monkeypatch)
    _post(c, str(tmp_path), "Write", {"file_path": f"{tmp_path}/specs/x/spec.md", "content": "# x"})
    p = {"cwd": str(tmp_path), "files": ["specs/x/spec.md"]}
    assert subs == [("graph_extract", p), ("graph_build", p)]  # extract first: the build embeds its nodes
    assert events[0][1]["payload"] == {"tool": "Write", "file_path": "specs/x/spec.md"}
    subs.clear()
    _post(c, str(tmp_path), "Write", {"file_path": f"{tmp_path}/specs/x/tasks.md", "content": "- [ ] T001 a"})
    assert [k for k, _ in subs] == ["graph_build"]  # tasks.md is parsed only, never sent to Claude


def test_hook_skips_queued_and_code_files(monkeypatch, tmp_path):
    c, subs, events = _client(monkeypatch, queued=1)
    _post(c, str(tmp_path), "Edit", {"file_path": f"{tmp_path}/PLAN.md", "old_string": "a", "new_string": "b"})
    assert subs == []  # a job of each kind for this file is already queued
    c, subs, events = _client(monkeypatch)
    _post(c, str(tmp_path), "Edit", {"file_path": f"{tmp_path}/src/a.py", "old_string": "a", "new_string": "b"})
    assert subs == [] and events[0][1]["payload"] == {"tool": "Edit", "file_path": "src/a.py"}
    _post(c, str(tmp_path), "Read", {"file_path": f"{tmp_path}/specs/x/spec.md"})
    assert subs == [] and events[1][1]["payload"] == {"tool": "Read"}


def test_hook_tick_in_tasks_md(monkeypatch, tmp_path):
    c, subs, _ = _client(monkeypatch)
    f = f"{tmp_path}/specs/x/tasks.md"
    _post(c, str(tmp_path), "Edit", {"file_path": f, "old_string": "- [ ] T012 [US1] do a\n- [ ] T013 b",
                                     "new_string": "- [X] T012 [US1] do a\n- [ ] T013 b"})
    ticks = [p["tick"] for k, p in subs if k == "graph_build" and "tick" in p]
    assert ticks == [{"session_id": "s1", "file": "specs/x/tasks.md", "tasks": ["T012"]}]
    subs.clear()
    _post(c, str(tmp_path), "MultiEdit", {"file_path": f, "edits": [
        {"old_string": "- [ ] T013 b", "new_string": "- [x] T013 b"}, {"old_string": "- [X] T014 c", "new_string": "- [x] T014 c"}]})
    assert [p["tick"]["tasks"] for k, p in subs if "tick" in p] == [["T013"]]  # T014 was already ticked
    subs.clear()
    _post(c, str(tmp_path), "Write", {"file_path": f, "content": "- [X] T015 d"})
    assert [p for _, p in subs if "tick" in p] == []  # a Write compares against nothing


def test_in_run_covers_extract_dir():
    assert hooks._in_run({"cwd": str(Path.home() / ".claudethecaller/extract/x")})
    assert hooks._in_run({"cwd": str(Path.home() / ".claudethecaller/extract")})
    assert not hooks._in_run({"cwd": "/tmp/project"})
