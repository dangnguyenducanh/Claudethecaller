"""evaluation.record_fixtures (T0.1): pure helpers and the CLI against a fake daemon (stdlib http.server), no network beyond loopback."""

import copy
import hashlib
import http.server
import json
import threading

import pytest

from evaluation import record_fixtures as rf

OPENAPI = {"paths": {
    "/api/projects": {"get": {}}, "/api/projects/{name}": {"get": {}, "patch": {}, "delete": {}}, "/api/index": {"post": {}},
    "/api/decisions": {"get": {}}, "/api/kpis": {"get": {}}, "/api/runs/{rid}/steps/{sid}/log": {"get": {}},
    "/v1/health": {"get": {}}, "/v1/search": {"post": {}}, "/v1/hook/prompt": {"post": {}}, "/v1/route": {"post": {}}}}


class Fake:
    def __init__(self, drift=False):
        self.calls, self.health_n, self.seen, self.drift = [], 0, {}, drift
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def send(self, code, obj):
                b = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)

            def do_GET(self):
                outer.calls.append(("GET", self.path))
                if self.path == "/v1/health":
                    outer.health_n += 1
                    return self.send(200, {"library_version": f"v{outer.health_n}" if outer.drift else "v1"})
                if self.path == "/openapi.json":
                    return self.send(200, OPENAPI)
                if self.path == "/api/projects":
                    return self.send(200, [{"id": "p1", "name": "taobao proj"}, {"id": "p2", "name": "x", "note": None}])
                if self.path == "/api/projects/taobao%20proj":
                    return self.send(200, {"id": "p1", "tags": []})
                self.send(404, {"error": "nope"})

            def do_POST(self):
                outer.calls.append(("POST", self.path))
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                outer.seen[body["q"]] = outer.seen.get(body["q"], 0) + 1
                ids = [f"h{i}" for i in range(7)]
                if "flaky" in body["q"] and outer.seen[body["q"]] % 2 == 0:
                    ids.reverse()
                outer.last = body
                self.send(200, {"abstained": False, "hits": [{"id": h, "score": 0.9 - i / 10} for i, h in enumerate(ids)]})

        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


@pytest.fixture
def fake():
    d = Fake()
    yield d
    d.close()


def jl(path, rows):
    path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")


def run_search(tmp_path, url, extra=(), sr=None, own=None, n=4, n_own=2, monkeypatch=None):
    sr = sr or [{"id": f"q-{i}", "query": f"sr query {i}"} for i in range(5)] + [{"id": "q-flaky", "query": "a flaky one"}]
    own = own or [{"id": "o1", "query": "ünï own private one"}, {"id": "o2", "query": "own two", "gold": []}]
    jl(tmp_path / "sr.jsonl", sr)
    jl(tmp_path / "own.jsonl", own)
    monkeypatch.setattr(rf, "N_PROMPTS", n)
    monkeypatch.setattr(rf, "N_OWN", n_own)
    out = tmp_path / "out"
    code = rf.main(["search", "--url", url, "--out", str(out), "--skillret", str(tmp_path / "sr.jsonl"), "--own", str(tmp_path / "own.jsonl"), *extra])
    return code, out


# D2 defaults
def test_defaults():
    assert (rf.N_PROMPTS, rf.N_OWN, rf.K, rf.SEED, rf.TIMEOUT_S) == (200, 100, 5, 0, 30.0)
    assert (rf.DAEMON, rf.OUT, rf.PROJECT, rf.NEUTRAL_CWD) == ("http://127.0.0.1:18310", "fixtures/py-baseline", "claudethecaller", "/nonexistent/ctc-eval")


# D9 / D5 / D6 / D2 selection
SR = [{"id": f"q-{i:02d}", "query": f"sr {i}"} for i in range(10)] + [{"id": "q-99", "query": "shared"}, {"id": "q-98", "query": "  "}]
OWN = [{"id": "a", "query": "shared"}, {"id": "b", "query": "own b", "gold": []}, {"id": "c", "query": "own c"}]


def test_select_all_own_when_fewer_than_n_own_and_dup_goes_to_own():
    got = rf.select_prompts(SR, OWN, n=6, n_own=5, seed=0)
    ids = [r["id"] for r in got]
    assert ids[:3] == ["own:a", "own:b", "own:c"]
    assert all(i.startswith("skillret:") for i in ids[3:]) and "skillret:q-99" not in ids and "skillret:q-98" not in ids
    assert ids[3:] == sorted(ids[3:]) and len(ids) == 6
    assert set(got[0]) == {"id", "source", "query"}
    assert ids == [r["id"] for r in rf.select_prompts(SR, OWN, n=6, n_own=5, seed=0)]


def test_select_samples_own_when_more_than_n_own():
    got = rf.select_prompts(SR, OWN, n=4, n_own=2, seed=0)
    assert sum(r["source"] == "own" for r in got) == 2 and len(got) == 4


def test_select_exact_n_ok_one_more_raises():
    unique = len(rf.select_prompts(SR, OWN, n=10, n_own=3))
    assert unique == 10
    with pytest.raises(ValueError):
        rf.select_prompts(SR[:2], OWN[:1], n=4, n_own=1)


def test_select_reads_constants_at_call_time(monkeypatch):
    monkeypatch.setattr(rf, "N_PROMPTS", 3)
    monkeypatch.setattr(rf, "N_OWN", 1)
    got = rf.select_prompts(SR, OWN)
    assert (len(got), sum(r["source"] == "own" for r in got)) == (3, 1)


def test_select_verbatim_and_does_not_edit_arguments():
    long = "über\nlong " + "x" * 3900
    sr, own = [{"id": "q-1", "query": long}], [{"id": "o", "query": "mine", "gold": []}]
    before = copy.deepcopy((sr, own))
    got = rf.select_prompts(sr, own, n=2, n_own=1)
    assert got[1]["query"] == long and (sr, own) == before


# D1
def test_split_rows_public_and_local():
    rows = [{"id": "own:a", "source": "own", "query": "m"}, {"id": "skillret:q", "source": "skillret", "query": "p"}]
    before = copy.deepcopy(rows)
    assert rf.split_rows(rows) == ([rows[1]], [rows[0]]) and rows == before


# D3
def test_search_row_keeps_k_ids_and_scores():
    reply = {"abstained": True, "hits": [{"id": f"h{i}", "score": 0.9 - i / 10} for i in range(7)]}
    row = rf.search_row({"id": "skillret:q", "source": "skillret", "query": "héllo\nx"}, reply)
    assert row["top5"] == ["h0", "h1", "h2", "h3", "h4"] and len(row["scores"]) == 5 and row["abstained"] is True and row["stable"] is True
    assert rf.search_row({"id": "o", "source": "own", "query": "q"}, {"hits": []}, stable=False)["stable"] is False


def test_graph_row_fields():
    g = rf.graph_row({"id": "g01", "tool": "graph_search", "args": {"question": "x"}}, True, "txt", None)
    assert g == {"id": "g01", "tool": "graph_search", "args": {"question": "x"}, "project": "claudethecaller", "is_error": True, "text": "txt", "structured": None}


# D11
def test_shape_rules():
    v = {"a": 1, "b": [{"x": 1, "y": None}, {"x": 2.5, "y": "s", "z": True}], "c": [], "d": None, "e": "t", "f": False}
    assert rf.shape(v) == {"a": "number", "b": [{"x": "number", "y": "null|str", "z?": "bool"}], "c": [], "d": "null", "e": "str", "f": "bool"}
    assert rf.shape([[1], "x"]) == ["array|str"] and rf.shape([{"a": 1}, "x"]) == ["object|str"]
    assert rf.shape([]) == [] and rf.shape([[], [1]]) == [["number"]]
    assert rf.shape([{"a": 1}, {"b": 1}, {"a": 2}]) == [{"a?": "number", "b?": "number"}]


# D12 / D7 / D6
def test_plan_routes():
    before = copy.deepcopy(OPENAPI)
    record, skipped = rf.plan_routes(OPENAPI)
    assert OPENAPI == before
    assert record == ["/api/projects", "/api/projects/{name}", "/api/runs/{rid}/steps/{sid}/log", "/v1/health"]
    assert skipped == [{"route": "DELETE /api/projects/{name}", "reason": "mutating"}, {"route": "GET /api/decisions", "reason": "removed"},
                       {"route": "GET /api/kpis", "reason": "removed"}, {"route": "PATCH /api/projects/{name}", "reason": "mutating"},
                       {"route": "POST /api/index", "reason": "mutating"}, {"route": "POST /v1/hook/prompt", "reason": "hook"},
                       {"route": "POST /v1/route", "reason": "removed"}]


def test_fill_path():
    assert rf.fill_path("/api/projects/{name}", {"name": "taobao proj"}) == "/api/projects/taobao%20proj"
    assert rf.fill_path("/api/runs/{rid}/steps/{sid}/log", {"rid": 3}) is None
    assert rf.fill_path("/api/runs/{rid}/steps/{sid}/log", {"rid": 3, "sid": 9}) == "/api/runs/3/steps/9/log"
    assert rf.fill_path("/api/capabilities/{cap_id}", {"cap_id": "a@b:c"}) == "/api/capabilities/a%40b%3Ac"
    assert rf.fill_path("/api/projects", {}) == "/api/projects"


def test_file_sha256(tmp_path):
    (tmp_path / "f").write_bytes(b"abc")
    assert rf.file_sha256(tmp_path / "f") == hashlib.sha256(b"abc").hexdigest()


# search subcommand: D3 layout, D1 privacy, D10 stability, D14 manifest, D6 must-nots
def test_search_files_privacy_and_manifest(tmp_path, fake, monkeypatch):
    code, out = run_search(tmp_path, fake.url, monkeypatch=monkeypatch)
    assert code == 0
    pub = [json.loads(x) for x in (out / "search.public.jsonl").read_text(encoding="utf-8").splitlines()]
    loc_text = (out / "local" / "search.own.jsonl").read_text(encoding="utf-8")
    loc = [json.loads(x) for x in loc_text.splitlines()]
    assert (len(pub), len(loc)) == (2, 2) and "ünï" in loc_text and loc_text.endswith("\n")
    assert [r["id"] for r in loc] == sorted(r["id"] for r in loc) and all(r["source"] == "own" for r in loc)
    assert fake.last == {"q": fake.last["q"], "cwd": rf.NEUTRAL_CWD, "k": 5, "explain": False}
    m = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert m["local"] == {"file": "local/search.own.jsonl", "rows": 2, "sha256": rf.file_sha256(out / "local" / "search.own.jsonl")}
    assert m["prompts"]["total"] == 4 and m["library_version"] == "v1" and m["limited"] is None
    public_text = "".join(p.read_text(encoding="utf-8") for p in out.rglob("*") if p.is_file() and "local" not in p.relative_to(out).parts)
    assert "own private one" not in public_text and "own two" not in public_text
    assert not list(out.rglob("*.part"))
    assert {c[0] for c in fake.calls} == {"GET", "POST"} and all(c[1] in ("/v1/health", "/v1/search") for c in fake.calls)
    assert sum(1 for c in fake.calls if c[1] == "/v1/search") == 8  # two passes


def test_search_unstable_prompt_is_flagged(tmp_path, fake, monkeypatch):
    sr = [{"id": "q-flaky", "query": "a flaky one"}, {"id": "q-ok", "query": "fine"}]
    code, out = run_search(tmp_path, fake.url, sr=sr, own=[{"id": "o", "query": "own"}], n=2, n_own=0, monkeypatch=monkeypatch)
    assert code == 0
    got = {json.loads(x)["id"]: json.loads(x)["stable"] for x in (out / "search.public.jsonl").read_text(encoding="utf-8").splitlines()}
    assert got == {"skillret:q-flaky": False, "skillret:q-ok": True}
    assert json.loads((out / "manifest.json").read_text(encoding="utf-8"))["prompts"]["unstable_skillret"] == ["skillret:q-flaky"]


def test_search_limit_sets_manifest_and_keeps_first_rows(tmp_path, fake, monkeypatch):
    code, out = run_search(tmp_path, fake.url, extra=["--limit", "3"], monkeypatch=monkeypatch)
    m = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert code == 0 and m["limited"] == 3 and m["prompts"]["total"] == 3


# D4
def test_exit_codes(tmp_path, fake, monkeypatch):
    assert rf.main(["bogus"]) == 2
    assert rf.main(["search", "--limit", "0"]) == 2
    blocker = tmp_path / "file"
    blocker.write_text("x")
    assert rf.main(["api", "--out", str(blocker / "sub")]) == 2
    code, out = run_search(tmp_path, "http://127.0.0.1:9", monkeypatch=monkeypatch)
    assert code == 3 and not [p for p in out.rglob("*") if p.is_file()]
    code, out = run_search(tmp_path, fake.url, monkeypatch=monkeypatch)
    assert code == 0
    args = ["search", "--url", fake.url, "--out", str(out), "--skillret", str(tmp_path / "sr.jsonl"), "--own", str(tmp_path / "own.jsonl")]
    assert rf.main(args) == 5
    assert rf.main([*args, "--force"]) == 0


def test_not_enough_prompts_is_usage_error(tmp_path, fake, monkeypatch):
    code, _ = run_search(tmp_path, fake.url, sr=[{"id": "q", "query": "one"}], own=[], n=3, n_own=0, monkeypatch=monkeypatch)
    assert code == 2


def test_library_change_exits_4_and_writes_nothing(tmp_path, monkeypatch):
    d = Fake(drift=True)
    try:
        code, out = run_search(tmp_path, d.url, monkeypatch=monkeypatch)
    finally:
        d.close()
    assert code == 4 and not [p for p in out.rglob("*") if p.is_file()]


# api subcommand: D12, D6
def test_api_records_shapes_and_skips(tmp_path, fake):
    out = tmp_path / "o"
    assert rf.main(["api", "--url", fake.url, "--out", str(out)]) == 0
    doc = json.loads((out / "api-shapes.json").read_text(encoding="utf-8"))
    by = {r["route"]: r for r in doc["routes"]}
    assert by["GET /api/projects"]["shape"] == [{"id": "str", "name": "str", "note?": "null"}]
    assert (by["GET /api/projects/{name}"]["path"], by["GET /api/projects/{name}"]["status"]) == ("/api/projects/taobao%20proj", 200)
    assert by["GET /v1/health"]["status"] == 200
    assert {"route": "GET /api/runs/{rid}/steps/{sid}/log", "reason": "no-sample"} in doc["skipped"]
    assert {"route": "POST /api/index", "reason": "mutating"} in doc["skipped"]
    assert all(r["route"].startswith("GET ") for r in doc["routes"])
    assert all(c[0] == "GET" for c in fake.calls)
    assert not any(c[1].startswith(("/api/decisions", "/api/kpis")) for c in fake.calls)


def test_manifest_merges_subcommands(tmp_path, fake, monkeypatch):
    code, out = run_search(tmp_path, fake.url, monkeypatch=monkeypatch)
    assert code == 0 and rf.main(["api", "--url", fake.url, "--out", str(out)]) == 0
    m = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert m["prompts"]["total"] == 4 and m["api"]["recorded"] >= 1
