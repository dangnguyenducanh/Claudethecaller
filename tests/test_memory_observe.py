"""m7 O2: the `observe` capture job (transcript -> turns -> gates -> prompt -> reply parser -> files -> store) and the Stop hook
that queues it. No test runs the real `claude -p`: graph.extract._call and proc.preflight are replaced, vectors are fake."""

import hashlib
import json
import sys
import zlib
from datetime import UTC
from pathlib import Path
from types import SimpleNamespace

import numpy as np

from ctc.config import cfg
from ctc.graph import db, extract
from ctc.memory import observe
from ctc.server import hooks

FIX = Path(__file__).parent / "fixtures"
P = "/home/dev/proj"  # the fixture transcript's cwd
_SRC = next(json.loads(ln)["message"]["content"][0]["content"] for ln in (FIX / "transcript-m7.jsonl").read_text().splitlines()
            if '"tool_use_id": "r1"' in ln)
QUOTE = next(ln.strip() for ln in _SRC.splitlines() if "# NOTE" in ln)[:250]  # a line of the Read result the canned reply quotes
N = [0]


# ---- transcript builders (Claude Code's jsonl shape) ----
def row(kind, content, i=0, **kw):
    return {"type": kind, "sessionId": "s", "isSidechain": False, "timestamp": f"2026-10-26T10:00:{i:02d}.000Z",
            "message": {"role": kind, "content": content}, **kw}


def use(tid, name, inp, i=0, **kw):
    return row("assistant", [{"type": "tool_use", "id": tid, "name": name, "input": inp}], i, **kw)


def res(tid, out, i=0):
    return row("user", [{"type": "tool_result", "tool_use_id": tid, "content": out}], i)


def write(path, rows, partial=""):
    """(path, [byte offset after each row])."""
    lines = [json.dumps(r).encode() + b"\n" for r in rows]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"".join(lines) + partial.encode())
    ends, n = [], 0
    for ln in lines:
        n += len(ln)
        ends.append(n)
    return path, ends


def mode():
    return observe.load_mode()


# ---- read_turns ----
def test_read_turns_boundaries_offsets_and_private(tmp_path):
    rows = [row("user", "fix it", 1), row("user", "<command-name>/x</command-name>", 2, isMeta=True),
            use("r1", "Read", {"file_path": f"{P}/a.py"}, 3), use("sc", "Read", {"file_path": "/x"}, 4, isSidechain=True),
            res("r1", [{"type": "text", "text": "line1"}, {"type": "image", "source": {"data": "AAAA"}}], 5),
            row("user", "<local-command-stdout>ok</local-command-stdout>", 6),  # not a boundary: stays in turn 1
            row("assistant", [{"type": "text", "text": "done one"}], 7),
            row("user", "<private>secret plan</private>", 8), use("b1", "Bash", {"command": "ls"}, 9), res("b1", "out", 10),
            row("user", "third", 11), row("assistant", [{"type": "text", "text": "chat"}], 12)]
    p, ends = write(tmp_path / "t.jsonl", rows)
    size = ends[-1]
    turns, off, seen = observe.read_turns(str(p), 0, size)
    assert [t["prompt"] for t in turns] == ["fix it", "", "third"] and seen == 3 and off == size  # private turn counted, empty
    t = turns[0]
    assert t["text"] == "done one" and t["ts"] == "2026-10-26T10:00:07.000Z"
    assert [(e["tool"], e["input"], e["output"]) for e in t["events"]] == [("Read", {"file_path": f"{P}/a.py"}, "line1\n[non-text block]")]
    assert turns[1]["events"] == [] and turns[2]["events"] == []  # private turn: no events, and turn 1 did not absorb them
    # a mid-file offset reads only the new turns
    turns, off, seen = observe.read_turns(str(p), ends[9], size)
    assert [t["prompt"] for t in turns] == ["third"] and seen == 1 and off == size
    # a file shorter than the offset restarts at 0 with the counter at 0
    turns, off, seen = observe.read_turns(str(p), size + 100, size)
    assert len(turns) == 3 and seen == 3 and off == size
    # upto at the end of turn 2's last event: turn 3 is left for later
    turns, off, seen = observe.read_turns(str(p), 0, ends[9])
    assert [t["prompt"] for t in turns] == ["fix it", ""] and seen == 2 and off == ends[9]
    # a trailing partial line (no newline) is left for the next job
    p2, ends2 = write(tmp_path / "t2.jsonl", rows[:8], partial='{"type": "user", "message": {"con')
    turns, off, seen = observe.read_turns(str(p2), 0, p2.stat().st_size)
    assert off == ends2[-1] and seen == 2 and off < p2.stat().st_size


def test_read_turns_gates(tmp_path, monkeypatch):
    monkeypatch.setitem(cfg()["memory"]["observe"], "skip_bash_patterns", [r"^ls\b"])
    rows = [row("user", "go", 1), use("t1", "TodoWrite", {"todos": []}, 2), res("t1", "ok", 3), use("t2", "Skill", {"skill": "x"}, 4),
            use("t3", "mcp__claudethecaller__memory_search", {"query": "a"}, 5), res("t3", "hits", 6),
            use("t4", "mcp__plugin_claude-mem_mcp-search__search", {"query": "a"}, 7),
            use("t5", "Read", {"file_path": "/h/.claude/session-memory/n.md"}, 8), use("t6", "Bash", {"command": "ls -la"}, 9),
            use("t7", "Bash", {"command": "pytest -q"}, 10), res("t7", "1 passed", 11),
            row("user", "chat only", 12), use("t8", "TodoWrite", {}, 13)]
    p, _ = write(tmp_path / "g.jsonl", rows)
    turns, _, _ = observe.read_turns(str(p), 0, p.stat().st_size)
    assert [e["tool"] for e in turns[0]["events"]] == ["Bash"] and turns[0]["events"][0]["output"] == "1 passed"
    assert turns[1]["events"] == []  # only skipped events: nothing to send


# ---- build_prompt / parse_reply / content_hash ----
def test_build_prompt_layout_elision_and_redaction():
    token = "ghp_" + "0123456789abcdefghijklmnopqrstuvwxyz"[:36]
    turn = {"prompt": "fix the parser <private>hunter2</private> bug", "text": "All done.", "ts": "2026-10-26T10:00:00.000Z"}
    ev = [{"tool": "Read", "input": {"file_path": "/a"}, "output": "x" * 40_000 + f" {token}", "ts": ""},
          {"tool": "Bash", "input": {"command": f"echo {token}"}, "output": "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----", "ts": ""}]
    m = mode()
    a = observe.build_prompt(m, turn, ["Earlier title"], ev, False)
    assert a.startswith(m["prompts"]["system_identity"].strip()) and "<user_request>fix the parser" in a and "hunter2" not in a
    assert "Earlier title" in a and a.count("</observed_from_primary_session>") == 3  # the request + one per tool event
    assert '<elided chars="' in a and 'reason="oversize"' in a and "ghp_" not in a and "BEGIN RSA" not in a
    assert "PROGRESS SUMMARY" not in a and "<summary>" not in a
    b = observe.build_prompt(m, turn, [], ev, True)
    assert b.startswith(a.split("<session_start_context>")[0].rstrip()[:200]) and "PROGRESS SUMMARY" in b and "<summary>" in b and "All done." in b


def test_parse_reply():
    m = mode()
    r = """Sure.
<observation><type>discovery</type><title>Title: Foo &amp; Bar</title><subtitle>s</subtitle><facts><fact>a &lt; b</fact><fact> </fact></facts>
<narrative>n</narrative><concepts><concept>gotcha: a quirk</concept><concept>nonsense</concept><concept>discovery</concept></concepts>
<files_read><file>a.py</file></files_read><files_modified><file>b.py</file></files_modified></observation>
<observation><type>bugfix</type><title>Second</title></observation>
<observation><type>weird</type><title>Dropped</title></observation>
<summary><request>r</request><investigated>i</investigated><learned>l</learned><completed>c</completed><next_steps>n</next_steps><notes></notes></summary>"""
    obs, summ, ok = observe.parse_reply(r, m)
    assert ok and [o["title"] for o in obs] == ["Foo & Bar", "Second"] and [o["type"] for o in obs] == ["discovery", "bugfix"]
    assert obs[0]["facts"] == ["a < b"] and obs[0]["concepts"] == ["gotcha"]  # unknown concepts and the type itself dropped
    assert (obs[0]["files_read"], obs[0]["files_modified"]) == (["a.py"], ["b.py"]) and obs[1]["facts"] == []
    assert summ == {"request": "r", "investigated": "i", "learned": "l", "completed": "c", "next_steps": "n", "notes": ""}
    obs, summ, ok = observe.parse_reply('<observation><type>bugfix</type><title>T</title></observation><skip_summary reason="x"/>', m)
    assert ok and len(obs) == 1 and summ is None
    assert observe.parse_reply('<skip_summary reason="noise" />', m) == ([], None, True)
    assert observe.parse_reply("Skipping: nothing to record.", m) == ([], None, False)
    assert observe.parse_reply("", m) == ([], None, False)


def test_content_hash():
    assert observe.content_hash("s", "t", "n") == hashlib.sha256(b"s\0t\0n").hexdigest()[:16] and len(observe.content_hash("s", "t", "n")) == 16


# ---- run_job (scratch Postgres) ----
CANNED = f"""<observation><type>bugfix</type><title>Splitter now keeps the last line</title><subtitle>Parser fix</subtitle>
<facts><fact>split() no longer drops the final element</fact></facts><narrative>The splitter dropped its final element. It now returns every line.</narrative>
<concepts><concept>problem-solution</concept></concepts><files_read><file>src/p.py</file></files_read><files_modified><file>x.py</file></files_modified></observation>
<observation><type>discovery</type><title>Joiner depends on the trailing newline</title><subtitle>Coupling</subtitle>
<facts><fact>The joiner flushes on the final newline</fact><fact>{QUOTE}</fact></facts>
<narrative>The splitter feeds a joiner. {QUOTE}</narrative><concepts><concept>gotcha</concept></concepts></observation>
<summary><request>Repair the splitter that lost its last element</request><investigated>The splitter</investigated><learned>The joiner needs the newline</learned>
<completed>It keeps every line</completed><next_steps>Check callers</next_steps><notes></notes></summary>"""


class Emb:
    async def embed(self, texts, kind):
        out = np.zeros((len(texts), 1024), dtype="float32")
        for i, t in enumerate(texts):
            out[i, zlib.crc32(t.encode()) % 1024] = 1
        return out


class Cache:
    def __init__(self):
        self.deleted = []

    async def delete(self, *keys):
        self.deleted += keys

    async def enqueue_job(self, job_id):
        return False


def _st(s, tmp_path, mode_="local", skip=(), enabled=True, **obs):
    c = {**cfg(), "mode": mode_, "claude_home": str(tmp_path), "graph_extract": {"dir": str(tmp_path / "extract"), "timeout_s": 5},
         "history": {**cfg()["history"], "skip_projects": list(skip)},
         "memory": {**cfg()["memory"], "enabled": enabled, "observe": {**cfg()["memory"]["observe"], **obs}}}
    return SimpleNamespace(store=s, cfg=c, embedder=Emb(), cache=Cache(), names={})


def _fake(monkeypatch, replies=(CANNED,), status="done", usage=None):
    """Replace claude: reply i (the last repeats) per call; returns the list of prompts sent."""
    sent = []

    async def call(argv, prompt, log_path, timeout_s=120):
        sent.append(prompt)
        if status == "quota":
            return {"status": "quota", "output": None, "usage": None, "resets_at": "2999-01-01T00:00:00+00:00"}
        if status != "done":
            return {"status": status, "output": None, "usage": None, "resets_at": None, "error": "SECRET reply text"}
        return {"status": "done", "output": {"result": replies[min(len(sent) - 1, len(replies) - 1)]}, "resets_at": None,
                "usage": usage or {"input_tokens": 1200, "output_tokens": 300}}

    async def pre(container=False):
        return {"ok": True, "error": None}

    monkeypatch.setattr(extract, "_call", call)
    monkeypatch.setattr(extract.proc, "preflight", pre)
    refreshed = []

    async def refresh(st, user_id, project_id):
        refreshed.append((user_id, project_id))
        return ""

    monkeypatch.setitem(sys.modules, "ctc.memory.observations", SimpleNamespace(refresh_context=refresh))
    return sent, refreshed


async def _seed(s, tmp_path, rows=None, name=None, pid=None):
    """A project (unless pid names one) + session row and a transcript under <claude_home>/projects; (payload, size)."""
    N[0] += 1
    for tbl in ("observations", "session_summaries"):  # another test file seeds explicit ids into this shared schema: stay clear of them
        await s.execute(f"select setval(pg_get_serial_sequence('{tbl}', 'id'), greatest((select max(id) from {tbl}), 1000))")
    sid = f"sess-{N[0]}-{id(s) % 997}"
    if not pid:
        pid, name = f"p{N[0]}x{id(s) % 997}", name or f"proj{N[0]}"
        await s.execute("insert into projects (user_id, id, name, path) values ('local', %s, %s, %s)", (pid, name, P))
    await s.execute("insert into sessions (id, user_id, project_id) values (%s, 'local', %s)", (sid, pid))
    tp = tmp_path / "projects" / "-home-dev-proj" / f"{sid}.jsonl"
    tp.parent.mkdir(parents=True, exist_ok=True)
    if rows is None:
        tp.write_bytes((FIX / "transcript-m7.jsonl").read_bytes())
    else:
        write(tp, rows)
    size = tp.stat().st_size
    return {"session_id": sid, "project_id": pid, "user_id": "local", "transcript_path": str(tp), "final": False, "upto": size}, size


async def _prog(_):
    pass


def test_run_job_stores_observations_and_one_summary(tmp_path, monkeypatch, in_store):
    assert QUOTE in (FIX / "transcript-m7.jsonl").read_text() and len(QUOTE) == 250
    sent, refreshed = _fake(monkeypatch)

    async def go(s):
        payload, size = await _seed(s, tmp_path)
        st = _st(s, tmp_path)
        a = await observe.run_job(st, payload, _prog)
        obs = await s.fetch("select * from observations where session_id = %s order by id", (payload["session_id"],))
        summ = await s.fetch("select * from session_summaries where session_id = %s", (payload["session_id"],))
        sess = await s.fetchrow("select observed_bytes, observed_prompts from sessions where id = %s", (payload["session_id"],))
        b = await observe.run_job(st, payload, _prog)
        return a, obs, summ, sess, size, b, payload

    a, obs, summ, sess, size, b, payload = in_store(go)
    assert (a["turns"], a["calls"], a["observations"], a["summaries"], a["dropped_chunks"], a["failed_chunks"]) == (3, 1, 2, 1, 0, 0)
    assert [o["type"] for o in obs] == ["bugfix", "discovery"] and {o["model"] for o in obs} == {"haiku"}
    assert [o["files_modified"] for o in obs] == [["src/p.py"], ["src/p.py"]]  # the Edit input, relative; not the model's "x.py"
    assert obs[0]["files_read"] == ["src/p.py"] and obs[0]["prompt_number"] == 1 and obs[0]["discovery_tokens"] == 750
    assert obs[0]["created_at"].astimezone(UTC).isoformat().startswith("2026-10-26T10:00:10")  # the turn's last transcript timestamp
    assert obs[1]["narrative"] == "The splitter feeds a joiner." and obs[1]["facts"] == ["The joiner flushes on the final newline"]  # the quote is cut
    assert len(summ) == 1 and summ[0]["prompt_number"] == 1 and summ[0]["files_edited"] == ["src/p.py"] and summ[0]["request"].startswith("Repair")
    assert sess == {"observed_bytes": size, "observed_prompts": 3}
    assert len(sent) == 1 and "fix the parser bug" in sent[0] and "PROGRESS SUMMARY" in sent[0]
    for secret in ("ghp_", "hunter2", "BEGIN RSA", "secret plan", "cat .env"):  # turn 3 was private: none of it was sent
        assert secret not in sent[0]
    assert refreshed == [("local", payload["project_id"])]
    assert (b["observations"], b["summaries"], b["calls"]) == (0, 0, 0) and len(sent) == 1
    assert all(isinstance(v, (int, str, type(None))) for v in a.values())  # counts only


def test_run_job_refusals_and_skips(tmp_path, monkeypatch, in_store):
    sent, _ = _fake(monkeypatch)

    async def go(s):
        payload, _ = await _seed(s, tmp_path, name="secret-repo")
        skipped = await observe.run_job(_st(s, tmp_path, skip=["secret-repo"]), payload, _prog)
        by_base = await observe.run_job(_st(s, tmp_path, skip=["proj"]), payload, _prog)  # the folder basename of P
        shared = await observe.run_job(_st(s, tmp_path, mode_="shared"), payload, _prog)
        ghost = await observe.run_job(_st(s, tmp_path), {**payload, "session_id": "no-such-session"}, _prog)
        outside = tmp_path / "other.jsonl"
        outside.write_text("")
        try:
            await observe.run_job(_st(s, tmp_path), {**payload, "transcript_path": str(outside)}, _prog)
            bad = None
        except ValueError as e:
            bad = str(e)
        sess = await s.fetchrow("select observed_bytes, observed_prompts from sessions where id = %s", (payload["session_id"],))
        return skipped, by_base, shared, ghost, bad, sess

    skipped, by_base, shared, ghost, bad, sess = in_store(go)
    assert skipped == {"skipped": "project"} and by_base == {"skipped": "project"} and "skipped" in shared
    assert ghost == {"skipped": "no session"} and bad and "not a Claude Code transcript" in bad
    assert sent == [] and sess == {"observed_bytes": 0, "observed_prompts": 0}


def test_run_job_caps_calls_and_drops_overflow(tmp_path, monkeypatch, in_store):
    sent, _ = _fake(monkeypatch, replies=[f"<observation><type>change</type><title>Change {i}</title></observation>" for i in range(20)])
    rows = [row("user", "do many things", 1)]
    for i in range(10):
        rows += [use(f"t{i}", "Read", {"file_path": f"{P}/f{i}.py"}, 2), res(f"t{i}", f"{i}" * 20_000, 3)]  # one 16k block per chunk
    rows.append(row("assistant", [{"type": "text", "text": "ok"}], 4))

    async def go(s):
        payload, _ = await _seed(s, tmp_path, rows)
        return await observe.run_job(_st(s, tmp_path, chunk_chars=20_000), payload, _prog)

    a = in_store(go)
    assert a["calls"] == 8 and len(sent) == 8 and a["dropped_chunks"] == 2 and a["observations"] == 8
    assert "PROGRESS SUMMARY" in sent[-1] and not any("PROGRESS SUMMARY" in p for p in sent[:-1])  # the turn's last kept chunk asks for it


def _turns(n):
    rows = []
    for i in range(n):
        rows += [row("user", f"turn {i}", 1), use(f"t{i}", "Read", {"file_path": f"{P}/f{i}.py"}, 2), res(f"t{i}", "small", 3),
                 row("assistant", [{"type": "text", "text": "ok"}], 4)]
    return rows


def _replies(tag, n=20):
    return [f"<observation><type>change</type><title>{tag} {i}</title></observation>" for i in range(n)]


def test_run_job_stalls_at_the_first_unplanned_turn_and_the_next_job_continues(tmp_path, monkeypatch, in_store):
    rows = _turns(5)
    _, ends = write(tmp_path / "ref.jsonl", rows)
    sent, _ = _fake(monkeypatch, replies=_replies("First"))
    packed, real = [], observe._pack
    monkeypatch.setattr(observe, "_pack", lambda *a: packed.append(1) or real(*a))

    async def go(s):
        payload, size = await _seed(s, tmp_path, rows)
        st = _st(s, tmp_path, max_calls_per_job=3)
        a = await observe.run_job(st, payload, _prog)
        packs = len(packed)
        q = "select observed_bytes, observed_prompts from sessions where id = %s"
        mid = await s.fetchrow(q, (payload["session_id"],))
        sent2, _ = _fake(monkeypatch, replies=_replies("Second"))
        b = await observe.run_job(st, payload, _prog)
        nums = [r["prompt_number"] for r in await s.fetch("select prompt_number from observations where session_id = %s order by id", (payload["session_id"],))]
        return a, packs, mid, b, sent2, await s.fetchrow(q, (payload["session_id"],)), nums, size

    a, packs, mid, b, sent2, end, nums, size = in_store(go)
    assert (a["calls"], a["observations"], a["dropped_chunks"]) == (3, 3, 0) and len(sent) == 3 and packs == 3  # no _pack past the cap
    assert mid == {"observed_bytes": ends[4 * 3 - 1], "observed_prompts": 3}  # at the start of turn 4, not past the whole file
    assert (b["calls"], b["observations"]) == (2, 2) and "turn 3" in sent2[0] and "turn 4" in sent2[1] and not any("turn 2" in p for p in sent2)
    assert end == {"observed_bytes": size, "observed_prompts": 5} and nums == [1, 2, 3, 4, 5]


def test_run_job_first_read_skips_what_is_older_than_the_window(tmp_path, monkeypatch, in_store):
    rows = [row("user", "old turn", 1), use("o", "Read", {"file_path": f"{P}/o.py"}, 2), res("o", "x" * 2_100_000, 3),
            row("assistant", [{"type": "text", "text": "ok"}], 4), *_turns(1)]
    sent, _ = _fake(monkeypatch, replies=_replies("Window"))

    async def go(s):
        payload, size = await _seed(s, tmp_path, rows)
        a = await observe.run_job(_st(s, tmp_path), payload, _prog)
        return a, await s.fetchrow("select observed_bytes, observed_prompts from sessions where id = %s", (payload["session_id"],)), size

    a, sess, size = in_store(go)
    assert a["turns"] == 1 and len(sent) == 1 and "turn 0" in sent[0] and "old turn" not in sent[0]  # the cut falls inside the big result row
    assert sess == {"observed_bytes": size, "observed_prompts": 1}


def test_run_job_embeds_in_slices_of_32_after_one_ping(tmp_path, monkeypatch, in_store):
    class Tei:
        def __init__(self):
            self.sizes = []

        async def embed(self, texts, kind):
            assert len(texts) <= 32, "TEI max_client_batch_size"
            self.sizes.append(len(texts))
            return np.zeros((len(texts), 1024), dtype="float32")

    _fake(monkeypatch, replies=["".join(f"<observation><type>change</type><title>Finding {i}</title></observation>" for i in range(40))])

    async def go(s):
        payload, _ = await _seed(s, tmp_path, _turns(1))
        st = _st(s, tmp_path)
        st.embedder = Tei()
        a = await observe.run_job(st, payload, _prog)
        return a, st.embedder.sizes

    a, sizes = in_store(go)
    assert a["observations"] == 40 and sizes == [1, 32, 8]  # one ping, then 40 rows in slices


def test_run_job_skips_before_any_claude_call_when_the_embedder_is_down(tmp_path, monkeypatch, in_store):
    class Down:
        async def embed(self, texts, kind):
            raise ConnectionError("TEI is down")

    sent, _ = _fake(monkeypatch)

    async def go(s):
        payload, _ = await _seed(s, tmp_path)
        st = _st(s, tmp_path)
        st.embedder = Down()
        a = await observe.run_job(st, payload, _prog)
        return a, await s.fetchrow("select observed_bytes, observed_prompts from sessions where id = %s", (payload["session_id"],)), \
            await db.get_source(s, "local", payload["project_id"], extract.QUOTA), await s.fetchval("select count(*) from observations where session_id = %s", (payload["session_id"],))

    a, sess, quota, n = in_store(go)
    assert a["skipped"] == "embedder down" and sent == [] and a["calls"] == 0  # no claude call: no quota spent
    assert sess == {"observed_bytes": 0, "observed_prompts": 0} and not quota and n == 0


def test_run_job_is_a_no_op_when_memory_is_off(tmp_path, monkeypatch, in_store):
    sent, _ = _fake(monkeypatch)

    async def go(s):
        payload, _ = await _seed(s, tmp_path)
        a = await observe.run_job(_st(s, tmp_path, enabled=False), payload, _prog)
        return a, await s.fetchrow("select observed_bytes, observed_prompts from sessions where id = %s", (payload["session_id"],)), \
            await s.fetchval("select count(*) from observations where session_id = %s", (payload["session_id"],))

    a, sess, n = in_store(go)
    assert a == {"skipped": "off"} and sent == [] and sess == {"observed_bytes": 0, "observed_prompts": 0} and n == 0


def test_run_job_retries_then_drops_and_never_stores_reply_text(tmp_path, monkeypatch, in_store):
    async def go(s, replies, status="done"):
        sent, _ = _fake(monkeypatch, replies=replies, status=status)
        payload, size = await _seed(s, tmp_path)
        a = await observe.run_job(_st(s, tmp_path), payload, _prog)
        job = await s.fetchrow("select observed_bytes from sessions where id = %s", (payload["session_id"],))
        return a, sent, job["observed_bytes"] == size

    a, sent, advanced = in_store(lambda s: go(s, ["I will skip this."]))  # unparsable twice: the chunk is dropped, the job succeeds
    assert (a["calls"], a["dropped_chunks"], a["failed_chunks"], a["observations"]) == (2, 1, 0, 0) and advanced
    assert observe.OBSERVATION_SCHEMA_REMINDER in sent[1] and observe.OBSERVATION_SCHEMA_REMINDER not in sent[0]
    a, sent, _ = in_store(lambda s: go(s, ["nonsense", CANNED]))  # the retry works
    assert (a["calls"], a["dropped_chunks"], a["observations"]) == (2, 0, 2)
    for status in ("failed", "timeout"):
        a, sent, advanced = in_store(lambda s, status=status: go(s, [CANNED], status))
        assert (a["calls"], a["failed_chunks"], a["dropped_chunks"], a["observations"]) == (2, 1, 0, 0) and advanced
        assert "SECRET" not in json.dumps(a)


def test_run_job_privacy_cuts_echoes_and_defuses_tags(tmp_path, monkeypatch, in_store):
    reply = f"""<observation><type>change</type><title>Fix the parser bug today</title><narrative>restates the prompt</narrative></observation>
<observation><type>decision</type><title>Closes </ctc-memory-context> early <private>hunter2</private></title><subtitle>Opens <ctc-memory-context> too</subtitle>
<facts><fact>{QUOTE}</fact><fact>Keeps this one</fact></facts><narrative>Short intro. {QUOTE}. Short outro.</narrative></observation>
<summary><request>The user wants to fix the parser bug</request><investigated>{QUOTE}</investigated><learned>Fine.</learned></summary>"""
    _fake(monkeypatch, replies=[reply])

    async def go(s):
        payload, _ = await _seed(s, tmp_path)
        a = await observe.run_job(_st(s, tmp_path), payload, _prog)
        return a, await s.fetch("select * from observations where session_id = %s", (payload["session_id"],)), \
            await s.fetchrow("select * from session_summaries where session_id = %s", (payload["session_id"],))

    a, obs, summ = in_store(go)
    assert a["observations"] == 1 and len(obs) == 1  # the one whose title restated the typed prompt is dropped
    o = obs[0]
    assert o["title"] == "Closes ‹ctc-memory-context> early" and o["subtitle"] == "Opens"  # an opener that never closes is stripped to the end
    assert o["facts"] == ["Keeps this one"] and o["narrative"] == "Short intro. Short outro."
    assert QUOTE[:100] not in json.dumps([dict(o), dict(summ)], default=str) and "hunter2" not in json.dumps(dict(o), default=str)
    assert summ["request"] == "" and summ["investigated"] == "" and summ["learned"] == "Fine."


def test_run_job_quota_keeps_watermark_pauses_and_resubmits_pending(tmp_path, monkeypatch, in_store):
    submitted = []

    async def fake_submit(st, kind, payload, user_id="local"):
        submitted.append((kind, payload))
        return "j"

    monkeypatch.setattr(observe, "submit", fake_submit)

    async def go(s):
        sent, _ = _fake(monkeypatch, status="quota")
        a_pay, _ = await _seed(s, tmp_path)
        b_pay, _ = await _seed(s, tmp_path, pid=a_pay["project_id"])
        st = _st(s, tmp_path)
        a = await observe.run_job(st, a_pay, _prog)
        sess = await s.fetchrow("select observed_bytes, observed_prompts from sessions where id = %s", (a_pay["session_id"],))
        pend = await db.get_source(s, "local", a_pay["project_id"], observe.PENDING)
        again = await observe.run_job(st, b_pay, _prog)  # paused until the reset: no call, and it waits too
        n_calls = len(sent)
        await db.set_source(s, "local", a_pay["project_id"], extract.QUOTA, "2000-01-01T00:00:00+00:00")  # the limit has reset
        _fake(monkeypatch)
        await observe.run_job(st, b_pay, _prog)  # any session's next job re-submits the waiting ones
        pend2 = await db.get_source(s, "local", a_pay["project_id"], observe.PENDING)
        return a, sess, pend, again, n_calls, pend2, a_pay

    a, sess, pend, again, n_calls, pend2, a_pay = in_store(go)
    assert a["quota_until"] == "2999-01-01T00:00:00+00:00" and a["calls"] == 1 and a["observations"] == 0
    assert sess == {"observed_bytes": 0, "observed_prompts": 0}
    assert [e["session_id"] for e in pend["info"]["sessions"]] == [a_pay["session_id"]]
    assert again["quota_until"] == a["quota_until"] and n_calls == 1  # the second job made no call
    resub = [p for k, p in submitted if k == "observe"]
    assert [p["session_id"] for p in resub] == [a_pay["session_id"]] and resub[0]["transcript_path"] == a_pay["transcript_path"]
    assert not (pend2 and [e for e in pend2["info"]["sessions"] if e["session_id"] == a_pay["session_id"]])


def test_run_job_restarts_counters_when_the_file_shrank(tmp_path, monkeypatch, in_store):
    _fake(monkeypatch)

    async def go(s):
        payload, size = await _seed(s, tmp_path)
        await s.execute("update sessions set observed_bytes = 10000000, observed_prompts = 7 where id = %s", (payload["session_id"],))
        a = await observe.run_job(_st(s, tmp_path), payload, _prog)
        await s.execute("update sessions set observed_bytes = 10000000, observed_prompts = 7 where id = %s", (payload["session_id"],))
        await observe.run_job(_st(s, tmp_path), payload, _prog)  # re-read from 0: the same summary row, not a second one
        return a, await s.fetchval("select count(*) from session_summaries where session_id = %s", (payload["session_id"],)), \
            await s.fetchrow("select observed_bytes, observed_prompts from sessions where id = %s", (payload["session_id"],)), size

    a, n, sess, size = in_store(go)
    assert a["turns"] == 3 and n == 1 and sess == {"observed_bytes": size, "observed_prompts": 3}


def test_run_job_deletes_ctx_key_when_refresh_fails(tmp_path, monkeypatch, in_store):
    _fake(monkeypatch)

    async def boom(st, user_id, project_id):
        raise RuntimeError("render failed")

    monkeypatch.setitem(sys.modules, "ctc.memory.observations", SimpleNamespace(refresh_context=boom))

    async def go(s):
        payload, _ = await _seed(s, tmp_path)
        st = _st(s, tmp_path)
        return await observe.run_job(st, payload, _prog), st.cache.deleted, payload["project_id"]

    a, deleted, pid = in_store(go)
    assert a["observations"] == 2 and deleted == [f"ctx:local:{pid}"]


# ---- the Stop hook queues the job ----
def test_stop_queues_observe_and_raises_a_queued_jobs_upto(tmp_path, monkeypatch, in_store):
    async def nothing(*a, **k):
        return False

    monkeypatch.setattr(hooks, "write", nothing)
    monkeypatch.setattr(hooks, "_want_extract", nothing)

    async def go(s):
        payload, size = await _seed(s, tmp_path, [row("user", "hi", 1), row("assistant", [{"type": "text", "text": "yo"}], 2)])
        sid, tp = payload["session_id"], Path(payload["transcript_path"])
        body = {"session_id": sid, "cwd": P, "transcript_path": str(tp), "hook_event_name": "Stop", "last_assistant_message": "RAW TEXT"}
        jobs = lambda: s.fetch("select payload, status from jobs where kind = 'observe' and payload->>'session_id' = %s order by created_at", (sid,))
        await hooks._stop(_st(s, tmp_path, enabled=False), body, "local")
        off = await jobs()
        st = _st(s, tmp_path)
        await hooks._stop(st, body, "local")
        first = await jobs()
        tp.write_bytes(tp.read_bytes() + b'{"type": "user"}\n')
        grown = tp.stat().st_size
        await hooks._stop(st, body, "local")  # a job is still queued: its upto goes up, no second job
        raised = await jobs()
        await s.execute("update jobs set status = 'running' where kind = 'observe' and payload->>'session_id' = %s", (sid,))
        await hooks._stop(st, {**body, "hook_event_name": "SessionEnd"}, "local")  # a running job does not count
        ended = await jobs()
        skip = await hooks._stop(_st(s, tmp_path, skip=["proj"]), body, "local")
        in_run = await hooks._stop(st, {**body, "cwd": str(Path(cfg()["graph_extract"]["dir"]).expanduser() / "x")}, "local")
        return off, first, raised, ended, size, grown, await jobs(), skip, in_run

    off, first, raised, ended, size, grown, last, *_ = in_store(go)
    assert off == [] and len(first) == 1 and first[0]["payload"]["upto"] == size and first[0]["payload"]["final"] is False
    assert set(first[0]["payload"]) == {"session_id", "project_id", "user_id", "transcript_path", "final", "upto"}  # no raw text
    assert len(raised) == 1 and raised[0]["payload"]["upto"] == grown
    assert len(ended) == 2 and ended[1]["payload"]["final"] is True and ended[1]["payload"]["upto"] == grown and len(last) == 2
