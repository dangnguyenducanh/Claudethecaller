"""Checks for T0.1 (evaluation/record_fixtures.py): one runnable example per decision id D0..D14.
Prints `PASS D3 ...` or `FAIL D3 <expected> <got>`; exit 1 if any FAIL. Stdlib only, runs with any python3.
Own fixture values. A fake daemon (stdlib http.server) stands in for the Python daemon where a check needs HTTP."""
from __future__ import annotations

import copy
import hashlib
import http.server
import importlib
import json
import os
import pathlib
import sys
import tempfile
import threading

ROOT = pathlib.Path(__file__).resolve().parents[2]
REPO = pathlib.Path(os.environ.get("CHECKS_REPO", ROOT))  # where the module and repo files are looked up (default: this repo)
sys.path[:0] = [str(REPO), str(REPO / "src")]
IDS = [f"D{i}" for i in range(15)]
CHECKS: dict = {}


class Fail(Exception):
    def __init__(self, expected, got):
        super().__init__(expected, got)
        self.expected, self.got = expected, got


def eq(expected, got):
    if expected != got:
        raise Fail(expected, got)


def check(did):
    def deco(fn):
        CHECKS[did] = fn
        return fn
    return deco


# ---- fake daemon -------------------------------------------------------------------------------------------------
class Daemon:
    """/v1/health (library_version vN, N = health calls when `drift`), /v1/search (ids from the query; 'flaky' alternates),
    /openapi.json, two /api GET routes. Counts calls in .calls."""

    def __init__(self, drift=False):
        self.drift, self.calls, self.health_n, self.search_n, self.qn = drift, [], 0, 0, {}
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
                    v = f"v{outer.health_n}" if outer.drift else "v1"
                    return self.send(200, {"db": "ok", "library_version": v, "mode": "local"})
                if self.path == "/openapi.json":
                    ops = {"get": {}}
                    return self.send(200, {"paths": {
                        "/api/projects": {"get": {}}, "/api/projects/{name}": {"get": {}, "delete": {}},
                        "/api/index": {"post": {}}, "/api/kpis": {"get": {}}, "/v1/health": {"get": ops},
                        "/v1/search": {"post": {}}, "/v1/hook/prompt": {"post": {}}}})
                if self.path == "/api/projects":
                    return self.send(200, [{"id": "p1", "name": "taobao proj", "sessions": 2}, {"id": "p2", "name": "x", "sessions": 0, "note": None}])
                if self.path == "/api/projects/taobao%20proj":
                    return self.send(200, {"id": "p1", "name": "taobao proj", "sessions": 2, "tags": []})
                self.send(404, {"error": "nope"})

            def do_POST(self):
                outer.calls.append(("POST", self.path))
                body = json.loads(self.rfile.read(int(self.headers["content-length"])) or b"{}")
                if self.path != "/v1/search":
                    return self.send(404, {"error": "nope"})
                outer.search_n += 1
                q = body["q"]
                ids = [f"cap:{hashlib.sha1(q.encode()).hexdigest()[:4]}:{i}" for i in range(7)]
                outer.qn[q] = outer.qn.get(q, 0) + 1
                if "flaky" in q and outer.qn[q] % 2 == 0:
                    ids.reverse()
                self.send(200, {"query": q, "abstained": False, "p": None, "ms": {}, "hits": [
                    {"id": h, "score": round(0.9 - i * 0.1, 4), "stages": {}} for i, h in enumerate(ids)]})

        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()


def sub(t, name):
    p = pathlib.Path(t) / name
    p.mkdir()
    return p


def jl(path, rows):
    pathlib.Path(path).write_text("".join(json.dumps(r) + "\n" for r in rows))


def search_run(mod, d, tmp, extra=(), sr=None, own=None, n=4, n_own=2):
    sr = sr or [{"id": f"q-{i}", "query": f"sr query {i}"} for i in range(6)] + [{"id": "q-flaky", "query": "a flaky one"}]
    own = own or [{"id": "o1", "query": "ünï own private one"}, {"id": "o2", "query": "own two", "gold": []}]
    jl(tmp / "sr.jsonl", sr)
    jl(tmp / "own.jsonl", own)
    mod.N_PROMPTS, mod.N_OWN = n, n_own
    out = tmp / "out"
    code = mod.main(["search", "--url", d.url, "--out", str(out), "--skillret", str(tmp / "sr.jsonl"), "--own", str(tmp / "own.jsonl"), *extra])
    return code, out


# ---- checks ------------------------------------------------------------------------------------------------------
@check("D0")
def d0(mod):
    doc = mod.__doc__ or ""
    eq(True, callable(mod.main))
    eq(True, "fixtures/py-baseline" in doc and "NOT" in doc.upper())  # header names the output and what it does not do


@check("D1")
def d1(mod):
    rows = [{"id": "own:a", "source": "own", "query": "mine"}, {"id": "skillret:q-1", "source": "skillret", "query": "pub"}]
    before = copy.deepcopy(rows)
    pub, loc = mod.split_rows(rows)
    eq(([rows[1]], [rows[0]]), (pub, loc))
    eq(before, rows)  # arguments untouched
    gi = (REPO / ".gitignore").read_text().splitlines()
    eq(True, "fixtures/py-baseline/local/" in [x.strip() for x in gi])


@check("D2")
def d2(mod):
    eq((200, 100, 5, 0, 30.0), (mod.N_PROMPTS, mod.N_OWN, mod.K, mod.SEED, mod.TIMEOUT_S))
    eq(("http://127.0.0.1:18310", "fixtures/py-baseline", "claudethecaller", "/nonexistent/ctc-eval"), (mod.DAEMON, mod.OUT, mod.PROJECT, mod.NEUTRAL_CWD))
    old = (mod.N_PROMPTS, mod.N_OWN)
    mod.N_PROMPTS, mod.N_OWN = 3, 1  # read at call time
    try:
        got = mod.select_prompts([{"id": f"q{i}", "query": f"s{i}"} for i in range(5)], [{"id": "a", "query": "o1"}, {"id": "b", "query": "o2"}])
    finally:
        mod.N_PROMPTS, mod.N_OWN = old
    eq((3, 1), (len(got), sum(r["source"] == "own" for r in got)))


@check("D3")
def d3(mod):
    p = {"id": "skillret:q-1", "source": "skillret", "query": "héllo\nworld"}
    reply = {"query": "héllo", "abstained": False, "p": None, "hits": [{"id": f"h{i}", "score": 0.9 - i / 10, "stages": {}} for i in range(7)]}
    row = mod.search_row(p, reply)
    eq({"id": "skillret:q-1", "source": "skillret", "query": "héllo\nworld", "abstained": False,
        "top5": ["h0", "h1", "h2", "h3", "h4"], "scores": [0.9, 0.8, 0.7, 0.6, 0.5], "stable": True},
       {**row, "scores": [round(x, 4) for x in row["scores"]]})
    g = mod.graph_row({"id": "g01", "tool": "graph_search", "args": {"question": "x"}}, False, "txt", {"hits": []})
    eq({"id", "tool", "args", "project", "is_error", "text", "structured"}, set(g))
    eq(("claudethecaller", False, "txt"), (g["project"], g["is_error"], g["text"]))
    with tempfile.TemporaryDirectory() as t:  # file layout of a search run
        t = pathlib.Path(t)
        d = Daemon()
        try:
            code, out = search_run(mod, d, t)
        finally:
            d.close()
        eq(0, code)
        pub = [json.loads(x) for x in (out / "search.public.jsonl").read_text().splitlines()]
        loc = [json.loads(x) for x in (out / "local" / "search.own.jsonl").read_text().splitlines()]
        eq((2, 2), (len(pub), len(loc)))
        eq(True, (out / "search.public.jsonl").read_text().endswith("\n"))
        eq(True, [r["id"] for r in loc] == sorted(r["id"] for r in loc))
        eq(True, "ünï" in (out / "local" / "search.own.jsonl").read_text())  # ensure_ascii False
        eq([], sorted(x.name for x in out.rglob("*.part")))


@check("D4")
def d4(mod):
    eq(2, mod.main(["bogus"]))
    eq(2, mod.main(["search", "--limit", "0"]))
    with tempfile.TemporaryDirectory() as t:
        t = pathlib.Path(t)
        a = sub(t, "a")
        jl(a / "sr.jsonl", [{"id": "q", "query": "a"}])
        jl(a / "own.jsonl", [])
        old = (mod.N_PROMPTS, mod.N_OWN)
        mod.N_PROMPTS, mod.N_OWN = 1, 0
        try:
            code = mod.main(["search", "--url", "http://127.0.0.1:9", "--out", str(a / "o"), "--skillret", str(a / "sr.jsonl"), "--own", str(a / "own.jsonl")])
        finally:
            mod.N_PROMPTS, mod.N_OWN = old
        eq(3, code)  # nothing listens on port 9
        eq([], [x.name for x in (a / "o").rglob("*") if x.is_file()] if (a / "o").exists() else [])
        d = Daemon()
        try:
            b = sub(t, "b")
            code, out = search_run(mod, d, b)
            eq(0, code)
            args = ["search", "--url", d.url, "--out", str(out), "--skillret", str(b / "sr.jsonl"), "--own", str(b / "own.jsonl")]
            eq(5, mod.main(args))  # target exists, no --force
            eq(0, mod.main([*args, "--force"]))
        finally:
            d.close()


@check("D5")
def d5(mod):
    sr = [{"id": "q-1", "query": "same text"}, {"id": "q-2", "query": "   "}, {"id": "q-3", "query": "über\nlong " + "x" * 3900}]
    own = [{"id": "o1", "query": "same text", "gold": []}]
    got = mod.select_prompts(sr, own, n=2, n_own=1, seed=0)
    eq(["own:o1", "skillret:q-3"], [r["id"] for r in got])  # dup goes to own, blank dropped
    eq(True, got[1]["query"] == sr[2]["query"])  # verbatim
    eq("/api/projects/taobao%20proj", mod.fill_path("/api/projects/{name}", {"name": "taobao proj"}))
    eq([], mod.shape([]))


@check("D6")
def d6(mod):
    openapi = {"paths": {"/api/index": {"post": {}}, "/api/capabilities": {"get": {}, "post": {}}, "/api/jobs/{job_id}": {"get": {}, "delete": {}}}}
    rec, skipped = mod.plan_routes(copy.deepcopy(openapi))
    eq(["/api/capabilities", "/api/jobs/{job_id}"], rec)
    eq({"POST /api/index", "POST /api/capabilities", "DELETE /api/jobs/{job_id}"}, {s["route"] for s in skipped})
    sr = [{"id": "q-1", "query": "a"}, {"id": "q-2", "query": "b"}]
    own = [{"id": "o", "query": "c"}]
    a, b = copy.deepcopy(sr), copy.deepcopy(own)
    mod.select_prompts(sr, own, n=2, n_own=1)
    eq((a, b), (sr, own))
    d = Daemon()  # only allowed routes are called by `api`
    try:
        with tempfile.TemporaryDirectory() as t:
            eq(0, mod.main(["api", "--url", d.url, "--out", t]))
        bad = [c for c in d.calls if c[0] != "GET"]
        eq([], bad)
    finally:
        d.close()


@check("D7")
def d7(mod):
    openapi = {"paths": {"/api/decisions": {"get": {}}, "/api/kpis": {"get": {}}, "/api/timeline": {"get": {}}, "/api/activity": {"get": {}},
                         "/v1/route": {"post": {}}, "/v1/bundle/{ref}": {"get": {}}, "/api/projects": {"get": {}}}}
    rec, skipped = mod.plan_routes(openapi)
    eq(["/api/projects"], rec)
    eq({"removed"}, {s["reason"] for s in skipped})
    eq(6, len(skipped))


@check("D8")
def d8(mod):
    eq(None, mod.fill_path("/api/runs/{rid}/steps/{sid}/log", {"rid": 3}))  # missing id: tolerant None, no raise
    eq("/api/runs/3/steps/9/log", mod.fill_path("/api/runs/{rid}/steps/{sid}/log", {"rid": 3, "sid": 9}))


@check("D9")
def d9(mod):
    sr = [{"id": f"q-{i:02d}", "query": f"sr {i}"} for i in range(10)] + [{"id": "q-99", "query": "shared"}]
    own = [{"id": "a", "query": "shared"}, {"id": "b", "query": "own b"}, {"id": "c", "query": "own c"}]
    got = mod.select_prompts(sr, own, n=6, n_own=5, seed=0)
    ids = [r["id"] for r in got]
    eq(6, len(ids))
    eq(["own:a", "own:b", "own:c"], ids[:3])  # all own rows (fewer than n_own), sorted by id, own first
    eq(True, all(i.startswith("skillret:") for i in ids[3:]) and "skillret:q-99" not in ids)  # duplicate query went to own
    eq(ids[3:], sorted(ids[3:]))
    eq(ids, [r["id"] for r in mod.select_prompts(sr, own, n=6, n_own=5, seed=0)])  # deterministic
    eq({"id", "source", "query"}, set(got[0]))
    try:
        mod.select_prompts(sr[:2], own[:1], n=4, n_own=1)
        raise Fail("ValueError", "no error")
    except ValueError:
        pass


@check("D10")
def d10(mod):
    eq(False, mod.search_row({"id": "own:x", "source": "own", "query": "q"}, {"abstained": False, "hits": []}, stable=False)["stable"])
    with tempfile.TemporaryDirectory() as t:
        t = pathlib.Path(t)
        d2 = Daemon(drift=True)  # library_version changes between the two health reads
        try:
            code, out = search_run(mod, d2, sub(t, "drift"))
            eq(4, code)
            eq([], [x.name for x in out.rglob("*") if x.is_file()] if out.exists() else [])
        finally:
            d2.close()
        d = Daemon()  # a flaky prompt: its second pass comes back reversed -> stable False
        try:
            sr = [{"id": "q-flaky", "query": "a flaky one"}, {"id": "q-ok", "query": "fine"}]
            code, out = search_run(mod, d, sub(t, "flaky"), sr=sr, own=[{"id": "o1", "query": "own"}], n=2, n_own=0)
            eq(0, code)
            got = {json.loads(x)["id"]: json.loads(x)["stable"] for x in (out / "search.public.jsonl").read_text().splitlines()}
            eq({"skillret:q-flaky": False, "skillret:q-ok": True}, got)
            eq(["skillret:q-flaky"], json.loads((out / "manifest.json").read_text())["prompts"]["unstable_skillret"])
        finally:
            d.close()


@check("D11")
def d11(mod):
    v = {"a": 1, "b": [{"x": 1, "y": None}, {"x": 2.5, "y": "s", "z": True}], "c": [], "d": None, "e": "t", "f": False}
    eq({"a": "number", "b": [{"x": "number", "y": "null|str", "z?": "bool"}], "c": [], "d": "null", "e": "str", "f": "bool"}, mod.shape(v))
    eq(["array|str"], mod.shape([[1], "x"]))
    eq(["object|str"], mod.shape([{"a": 1}, "x"]))
    eq({"k": []}, mod.shape({"k": []}))  # empty list = element type unknown


@check("D12")
def d12(mod):
    openapi = {"paths": {
        "/api/projects": {"get": {}}, "/api/projects/{name}": {"get": {}, "patch": {}, "delete": {}}, "/api/index": {"post": {}},
        "/api/decisions": {"get": {}}, "/api/decisions/{did}": {"get": {}, "delete": {}}, "/v1/health": {"get": {}}, "/v1/search": {"post": {}},
        "/v1/hook/prompt": {"post": {}}, "/v1/route": {"post": {}}, "/v1/bundle/{ref}": {"get": {}}, "/api/runs/compare": {"get": {}}}}
    rec, skipped = mod.plan_routes(openapi)
    eq(["/api/projects", "/api/projects/{name}", "/api/runs/compare", "/v1/health"], rec)
    eq([{"route": "DELETE /api/decisions/{did}", "reason": "removed"}, {"route": "DELETE /api/projects/{name}", "reason": "mutating"},
        {"route": "GET /api/decisions", "reason": "removed"}, {"route": "GET /api/decisions/{did}", "reason": "removed"},
        {"route": "GET /v1/bundle/{ref}", "reason": "removed"}, {"route": "PATCH /api/projects/{name}", "reason": "mutating"},
        {"route": "POST /api/index", "reason": "mutating"}, {"route": "POST /v1/hook/prompt", "reason": "hook"},
        {"route": "POST /v1/route", "reason": "removed"}], skipped)
    d = Daemon()
    try:
        with tempfile.TemporaryDirectory() as t:
            eq(0, mod.main(["api", "--url", d.url, "--out", t]))
            doc = json.loads((pathlib.Path(t) / "api-shapes.json").read_text())
    finally:
        d.close()
    by = {r["route"]: r for r in doc["routes"]}
    eq([{"id": "str", "name": "str", "note?": "null", "sessions": "number"}], by["GET /api/projects"]["shape"])
    eq(("/api/projects/taobao%20proj", 200), (by["GET /api/projects/{name}"]["path"], by["GET /api/projects/{name}"]["status"]))
    eq(True, "GET /v1/health" in by and all(r["route"].startswith("GET ") for r in doc["routes"]))
    eq(True, {"route": "POST /api/index", "reason": "mutating"} in doc["skipped"])


@check("D13")
def d13(mod):
    qs = json.loads((ROOT / "agent" / "t0-1-fixtures" / "graph_questions.json").read_text())
    eq(30, len(qs))
    eq([f"g{i:02d}" for i in range(1, 31)], [q["id"] for q in qs])
    kinds = {}
    for q in qs:
        kinds[q["tool"]] = kinds.get(q["tool"], 0) + 1
    eq({"graph_search": 12, "graph_explain": 7, "graph_path": 5, "graph_affected": 6}, kinds)
    need = {"graph_search": {"question"}, "graph_explain": {"node"}, "graph_path": {"a", "b"}, "graph_affected": {"node"}}
    eq([], [q["id"] for q in qs if not need[q["tool"]] <= set(q["args"]) or "project" in q["args"]])
    copy_ = REPO / "fixtures" / "py-baseline" / "graph-questions.json"
    if not copy_.exists():
        raise Fail(f"{copy_} copied from agent/t0-1-fixtures/graph_questions.json", "missing")
    eq(hashlib.sha256((ROOT / "agent/t0-1-fixtures/graph_questions.json").read_bytes()).hexdigest(), mod.file_sha256(copy_))


@check("D14")
def d14(mod):
    with tempfile.TemporaryDirectory() as t:
        t = pathlib.Path(t)
        d = Daemon()
        try:
            code, out = search_run(mod, d, t, n=4, n_own=2)
            eq(0, code)
            m = json.loads((out / "manifest.json").read_text())
        finally:
            d.close()
        need = {"recorded_at", "daemon_url", "git_sha", "library_version", "health", "prompts", "local", "limited"}
        eq(set(), need - set(m))
        eq(("v1", None), (m["library_version"], m["limited"]))
        eq({"total": 4, "own": 2, "skillret": 2}, {k: m["prompts"][k] for k in ("total", "own", "skillret")})
        eq({"file": "local/search.own.jsonl", "rows": 2, "sha256": mod.file_sha256(out / "local" / "search.own.jsonl")}, m["local"])
        txt = (out / "manifest.json").read_text() + (out / "search.public.jsonl").read_text()
        eq(False, "ünï own private one" in txt or "own two" in txt)  # no private prompt text in public files


def main() -> int:
    try:
        mod = importlib.import_module("evaluation.record_fixtures")
        err = None
    except BaseException as e:  # noqa: BLE001 - module not built yet is the expected state before the coder runs
        mod, err = None, f"{type(e).__name__}: {e}"
    bad = 0
    snap = {k: copy.copy(v) for k, v in vars(mod).items() if k.isupper()} if mod else {}  # constants a check changes are restored after it
    for did in IDS:
        if mod is None:
            print(f"FAIL {did} evaluation/record_fixtures.py importable | {err}")
            bad += 1
            continue
        try:
            CHECKS[did](mod)
            print(f"PASS {did}")
        except Fail as f:
            print(f"FAIL {did} expected={f.expected!r:.300} got={f.got!r:.300}")
            bad += 1
        except BaseException as e:  # noqa: BLE001 - a crash is a FAIL, not a crash of the checker
            print(f"FAIL {did} no exception | {type(e).__name__}: {str(e)[:300]}")
            bad += 1
        finally:
            vars(mod).update(snap)
    print(f"checks: {len(IDS) - bad}/{len(IDS)} pass")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
