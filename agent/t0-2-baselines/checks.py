"""Checks for T0.2 (evaluation/record_baselines.py): one runnable example per decision id D0..D14.
Prints `PASS D3 ...` or `FAIL D3 <expected> <got>`; exit 1 if any FAIL. Stdlib only, runs with any python3 (git must exist for D11).
Own fixture values. A fake daemon (stdlib http.server) stands in for the Python daemon; a tiny script stands in for ranking-test."""
from __future__ import annotations

import copy
import http.server
import importlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading

ROOT = pathlib.Path(__file__).resolve().parents[2]
REPO = pathlib.Path(os.environ.get("CHECKS_REPO", ROOT))  # where the module is looked up (default: this repo)
sys.path[:0] = [str(REPO), str(REPO / "src")]
IDS = [f"D{i}" for i in range(15)]
CHECKS: dict = {}
SCRATCH = "postgresql://u:secret@127.0.0.1:18304/scratch"


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


class Daemon:
    """/v1/health, POST /v1/search (records q), POST /v1/hook/pre (first reply empty, then JSON). .calls = [(method, path)], .qs = search texts."""

    def __init__(self, status=200):
        self.calls, self.qs, self.status, self.pre_n = [], [], status, 0
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def reply(self, code, body: bytes, ctype="application/json"):
                self.send_response(code)
                self.send_header("content-type", ctype)
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                outer.calls.append(("GET", self.path))
                self.reply(200, json.dumps({"db": "ok", "library_version": "v1", "mode": "local"}).encode())

            def do_POST(self):
                outer.calls.append(("POST", self.path))
                body = json.loads(self.rfile.read(int(self.headers["content-length"])) or b"{}")
                if outer.status != 200:
                    return self.reply(outer.status, b"{}")
                if self.path == "/v1/search":
                    outer.qs.append(body["q"])
                    return self.reply(200, json.dumps({"query": body["q"], "abstained": False, "hits": []}).encode())
                if self.path == "/v1/hook/pre":
                    outer.pre_n += 1
                    return self.reply(200, b"" if outer.pre_n == 1 else json.dumps({"hookSpecificOutput": {"additionalContext": "x"}}).encode())
                self.reply(404, b"{}")

        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()


def jl(path, rows):
    pathlib.Path(path).write_text("".join(json.dumps(r) + "\n" for r in rows))


def git_repo(t, n=6):
    r = pathlib.Path(t) / "repo"
    r.mkdir()
    for i in range(n):
        (r / f"f{i}.txt").write_text(str(i))
    subprocess.run(["git", "init", "-q"], cwd=r, check=True)
    subprocess.run(["git", "add", "."], cwd=r, check=True)
    return r


def prompts_file(t, n=8):
    p = pathlib.Path(t) / "prompts.jsonl"
    jl(p, [{"id": f"q-{i:02d}", "query": f"prompt number {i}", "extra": 1} for i in range(n)])
    return p


def fast(mod):
    mod.SETTLE_S, mod.WARMUP = 0.0, 1


REPORT = {"n": 50, "header": {"text_mode": "skillret", "git_sha": "abc"}, "ranking": {"keyword_rrf_weight": 0, "rerank_weight": 0},
          "scores": {m: {"recall@1": 0.56789, "recall@5": 0.8243, "recall@10": 0.9, "ndcg@10": 0.81151, "mrr": 0.85} for m in ("dense", "hybrid", "old", "full")},
          "compare": {"x": []}}
STDOUT = "loading...\nINFO something {not json}\n" + json.dumps(REPORT, indent=1) + "\n\nPaired significance (full = configured ranking):\n| a | b |\n"


@check("D0")
def d0(mod):
    doc = mod.__doc__ or ""
    eq(True, callable(mod.main) and "fixtures/py-baseline" in doc)
    eq(True, "NOT" in doc.upper())


@check("D1")
def d1(mod):
    eq(None, mod.scratch_url({}))
    eq(None, mod.scratch_url({"CTC_DATABASE_URL": "postgresql://x:y@db.supabase.co:5432/postgres"}))
    eq(SCRATCH, mod.scratch_url({"CTC_DATABASE_URL": SCRATCH}))
    eq("postgresql://u:***@127.0.0.1:18304/scratch failed", mod.mask_urls(f"{SCRATCH} failed"))
    old = os.environ.pop("CTC_DATABASE_URL", None)
    try:  # the database refusal comes before anything else starts: exit 2
        eq(2, mod.main(["skillret", "--out", tempfile.mkdtemp()]))
    finally:
        if old is not None:
            os.environ["CTC_DATABASE_URL"] = old
    d = Daemon()
    try:
        with tempfile.TemporaryDirectory() as t:
            fast(mod)
            code = mod.main(["latency", "--url", d.url, "--out", t + "/o", "--repo", str(git_repo(t)), "--prompts", str(prompts_file(t)), "--limit", "3"])
            eq(0, code)
        allowed = {("GET", "/v1/health"), ("POST", "/v1/search"), ("POST", "/v1/hook/pre")}
        eq(set(), set(d.calls) - allowed)
    finally:
        d.close()


@check("D2")
def d2(mod):
    eq((100, 50, 3, 0, 30.0, 7200, 3.0), (mod.N_LATENCY, mod.N_PRE, mod.WARMUP, mod.SEED, mod.TIMEOUT_S, mod.SKILLRET_TIMEOUT_S, mod.SETTLE_S))
    eq(("http://127.0.0.1:18310", "fixtures/py-baseline", 0.80), (mod.DAEMON, mod.OUT, mod.SKILLRET_GATE))
    eq(["recall@1", "recall@5", "recall@10", "ndcg@10", "mrr"], mod.METRICS)
    eq(["-m", "evaluation.retrieval_eval", "ranking-test"], list(mod.RANKING_CMD[1:]))
    old = mod.N_LATENCY
    mod.N_LATENCY = 2  # read at call time
    try:
        eq(2, len(mod.sample_prompts([{"id": f"q{i}", "query": f"s{i}"} for i in range(5)])))
    finally:
        mod.N_LATENCY = old


@check("D3")
def d3(mod):
    d = Daemon()
    try:
        with tempfile.TemporaryDirectory() as t:
            fast(mod)
            out = pathlib.Path(t) / "o"
            eq(0, mod.main(["latency", "--url", d.url, "--out", str(out), "--repo", str(git_repo(t)), "--prompts", str(prompts_file(t)), "--limit", "4"]))
            raw = (out / "latency.json").read_text()
            doc = json.loads(raw)
    finally:
        d.close()
    eq(True, raw.endswith("\n"))
    eq({"recorded_at", "git_sha", "daemon_url", "health", "host", "limited", "prompts", "tiers", "gates_for_ts", "not_measured"}, set(doc))
    eq({"search_miss", "search_warm", "pre"}, set(doc["tiers"]))
    eq({"n", "min", "p50", "p95", "p99", "max"}, set(doc["tiers"]["search_miss"]))
    eq({"n", "min", "p50", "p95", "p99", "max", "note_rate"}, set(doc["tiers"]["pre"]))
    eq({"suggest_cold_p95_ms": 150, "suggest_l1_p95_ms": 10, "hook_pre_p95_ms": 40}, doc["gates_for_ts"])
    eq((4, 4), (doc["limited"], doc["tiers"]["search_miss"]["n"]))
    eq({"cpus", "load_1m"}, set(doc["host"]))
    sk = mod.skillret_baseline(REPORT, 50)
    eq({"recorded_at", "git_sha", "source", "limited", "n", "header", "ranking", "scores", "gate"}, set(sk))
    eq({"metric": "ndcg@10", "split": "test", "min": 0.80, "value": 0.8115, "met": True}, sk["gate"])


@check("D4")
def d4(mod):
    eq(2, mod.main(["bogus"]))
    eq(2, mod.main(["latency", "--limit", "0"]))
    eq(2, mod.main(["latency", "--nope"]))
    with tempfile.TemporaryDirectory() as t:
        fast(mod)
        base = ["latency", "--prompts", str(prompts_file(t)), "--repo", str(git_repo(t)), "--limit", "2"]
        eq(3, mod.main([*base, "--url", "http://127.0.0.1:9", "--out", t + "/a"]))
        eq([], [p for p in pathlib.Path(t, "a").rglob("*") if p.is_file()] if pathlib.Path(t, "a").exists() else [])
        d = Daemon(status=500)
        try:
            eq(3, mod.main([*base, "--url", d.url, "--out", t + "/b"]))  # a measured call answered 500
        finally:
            d.close()
        d = Daemon()
        try:
            eq(0, mod.main([*base, "--url", d.url, "--out", t + "/c"]))
            eq(5, mod.main([*base, "--url", d.url, "--out", t + "/c"]))
            eq(0, mod.main([*base, "--url", d.url, "--out", t + "/c", "--force"]))
            eq(2, mod.main([*base[:-4], "--repo", t, "--limit", "2", "--url", d.url, "--out", t + "/e"]))  # --repo is not a git repo
        finally:
            d.close()
        fake = pathlib.Path(t) / "bad_ranking.py"  # D4 exit 4: child prints no JSON object
        fake.write_text("print('no json here')\n")
        mod.RANKING_CMD = [sys.executable, str(fake)]
        os.environ["CTC_DATABASE_URL"] = SCRATCH
        try:
            eq(4, mod.main(["skillret", "--out", t + "/f"]))
        finally:
            del os.environ["CTC_DATABASE_URL"]
    try:
        mod.percentile([], 50)
        raise Fail("ValueError", "no error")
    except ValueError:
        pass


@check("D5")
def d5(mod):
    eq(5.0, mod.percentile([5.0], 99))
    q = [{"id": "b", "query": "dup"}, {"id": "a", "query": "dup"}, {"id": "c", "query": "  "}, {"id": "d", "query": "ünï\nlong " + "x" * 3900, "k": 1}]
    got = mod.sample_prompts(q, n=10, seed=0)
    eq(sorted(["dup", "ünï\nlong " + "x" * 3900]), sorted(got))  # blank and duplicate dropped, fewer than n -> all
    d = Daemon()
    try:
        with tempfile.TemporaryDirectory() as t:
            mod.SETTLE_S, mod.WARMUP = 0.0, 3
            eq(0, mod.main(["latency", "--url", d.url, "--out", t + "/o", "--repo", str(git_repo(t)), "--prompts", str(prompts_file(t)), "--limit", "2"]))
            doc = json.loads((pathlib.Path(t) / "o" / "latency.json").read_text())
    finally:
        d.close()
    eq(2, doc["tiers"]["search_warm"]["n"])  # --limit 2 < WARMUP 3: still measured


@check("D6")
def d6(mod):
    d = Daemon()
    try:
        with tempfile.TemporaryDirectory() as t:
            fast(mod)
            rows = [{"id": "q-1", "query": "a"}, {"id": "q-2", "query": "b"}]
            before = copy.deepcopy(rows)
            mod.sample_prompts(rows, n=1)
            eq(before, rows)
            mod.main(["latency", "--url", d.url, "--out", t + "/o", "--repo", str(git_repo(t)), "--prompts", str(prompts_file(t)), "--limit", "2"])
            eq([], sorted(p.name for p in pathlib.Path(t, "o").rglob("*.part")))
        eq(False, any(p in ("/v1/hook/prompt", "/v1/route", "/v1/hook/tool", "/v1/hook/stop") for _, p in d.calls))
    finally:
        d.close()
    eq(False, "secret" in mod.mask_urls(f"error: could not connect {SCRATCH} (secret)").replace("(secret)", ""))


@check("D7")
def d7(mod):
    sk = mod.skillret_baseline(REPORT)
    eq(False, "compare" in sk)  # significance tests are dropped
    low = copy.deepcopy(REPORT)
    low["scores"]["full"]["ndcg@10"] = 0.5
    g = mod.skillret_baseline(low)["gate"]
    eq((0.5, False), (g["value"], g["met"]))  # data, not an exit code
    fake = pathlib.Path(tempfile.mkdtemp()) / "ok_ranking.py"
    fake.write_text(f"import sys\nprint({STDOUT!r})\n")
    mod.RANKING_CMD = [sys.executable, str(fake)]
    os.environ["CTC_DATABASE_URL"] = SCRATCH
    try:
        with tempfile.TemporaryDirectory() as t:
            eq(0, mod.main(["skillret", "--out", t + "/o"]))  # a below-gate score would still be exit 0 (checked above on the helper)
    finally:
        del os.environ["CTC_DATABASE_URL"]


@check("D8")
def d8(mod):
    got = mod.sample_prompts([{"id": "a", "query": "x"}], n=100, seed=1)
    eq(["x"], got)  # fewer prompts than asked: tolerant, no error


@check("D9")
def d9(mod):
    xs = [1.0, 2.0, 3.0, 4.0, 10.0]
    eq(3.0, mod.percentile(xs, 50))
    eq(8.8, round(mod.percentile(xs, 95), 6))  # k = 3.8 -> 4 + 6 * 0.8
    eq(10.0, mod.percentile(xs, 100))
    eq(1.0, mod.percentile(list(reversed(xs)), 0))  # unsorted input is fine
    eq({"n": 5, "min": 1.0, "p50": 3.0, "p95": 8.8, "p99": 9.8, "max": 10.0}, mod.summarize(xs))


@check("D10")
def d10(mod):
    eq("hello\n\nctc-baseline-ab12cd-7", mod.nonce_prompt("hello", "ab12cd", 7))
    q = [{"id": f"q-{i:02d}", "query": f"s{i}"} for i in range(20)]
    a = mod.sample_prompts(q, n=5, seed=0)
    eq(a, mod.sample_prompts(q, n=5, seed=0))
    eq(5, len(set(a)))
    d = Daemon()
    try:
        with tempfile.TemporaryDirectory() as t:
            fast(mod)
            eq(0, mod.main(["latency", "--url", d.url, "--out", t + "/o", "--repo", str(git_repo(t)), "--prompts", str(prompts_file(t)), "--limit", "3"]))
        suffix = [x.rsplit("ctc-baseline-", 1)[1] for x in d.qs]
        eq(True, all("\n\nctc-baseline-" in x for x in d.qs))
        n = 3
        miss, warm = d.qs[1:1 + n], d.qs[1 + n:1 + 2 * n]  # WARMUP = 1 discarded request first, then the miss pass, then the warm pass
        eq(miss, warm)  # warm repeats the miss texts exactly
        eq(1 + 2 * n, len(d.qs))
        eq(True, d.qs[0].endswith('-1') and len(set(d.qs[1:1 + n])) == n)
    finally:
        d.close()


@check("D11")
def d11(mod):
    eq({"hook_event_name": "PreToolUse", "tool_name": "Read", "tool_input": {"file_path": "/r/a/b.py"}, "cwd": "/r/a", "session_id": "ctc-baseline"}, mod.pre_body("/r/a", "b.py"))
    d = Daemon()
    try:
        with tempfile.TemporaryDirectory() as t:
            fast(mod)
            eq(0, mod.main(["latency", "--url", d.url, "--out", t + "/o", "--repo", str(git_repo(t, 8)), "--prompts", str(prompts_file(t)), "--limit", "5"]))
            doc = json.loads((pathlib.Path(t) / "o" / "latency.json").read_text())
    finally:
        d.close()
    eq(5, doc["tiers"]["pre"]["n"])
    eq(1.0, doc["tiers"]["pre"]["note_rate"])  # the first (empty) reply was the discarded warm-up


@check("D12")
def d12(mod):
    eq(REPORT, mod.parse_ranking(STDOUT))
    for bad in ("", "no braces", "[1, 2]\n"):
        try:
            mod.parse_ranking(bad)
            raise Fail("ValueError", "no error for " + repr(bad))
        except ValueError:
            pass
    before = copy.deepcopy(REPORT)
    sk = mod.skillret_baseline(REPORT, 50)
    eq(before, REPORT)
    eq((50, 50, {"keyword_rrf_weight": 0, "rerank_weight": 0}), (sk["n"], sk["limited"], sk["ranking"]))
    eq({"dense", "hybrid", "old", "full"}, set(sk["scores"]))
    eq({"recall@1": 0.5679, "recall@5": 0.8243, "recall@10": 0.9, "ndcg@10": 0.8115, "mrr": 0.85}, sk["scores"]["full"])
    short = copy.deepcopy(REPORT)
    del short["scores"]["old"]
    try:
        mod.skillret_baseline(short)
        raise Fail("error for a missing mode", "no error")
    except (KeyError, ValueError):
        pass


@check("D13")
def d13(mod):
    d = Daemon()
    try:
        with tempfile.TemporaryDirectory() as t:
            fast(mod)
            eq(0, mod.main(["latency", "--url", d.url, "--out", t + "/o", "--repo", str(git_repo(t)), "--prompts", str(prompts_file(t)), "--limit", "2"]))
            doc = json.loads((pathlib.Path(t) / "o" / "latency.json").read_text())
    finally:
        d.close()
    eq(("v1", "local"), (doc["health"]["library_version"], doc["health"]["mode"]))
    eq(True, doc["host"]["cpus"] == os.cpu_count() and isinstance(doc["host"]["load_1m"], float))


@check("D14")
def d14(mod):
    fake = pathlib.Path(tempfile.mkdtemp()) / "ok_ranking.py"
    fake.write_text(f"import sys\nprint({STDOUT!r}, file=sys.stdout)\n")
    mod.RANKING_CMD = [sys.executable, str(fake)]
    d = Daemon()
    os.environ["CTC_DATABASE_URL"] = SCRATCH
    try:
        with tempfile.TemporaryDirectory() as t:
            fast(mod)
            eq(0, mod.main(["all", "--url", d.url, "--out", t + "/o", "--repo", str(git_repo(t)), "--prompts", str(prompts_file(t)), "--limit", "2"]))
            eq(["latency.json", "skillret.json"], sorted(p.name for p in pathlib.Path(t, "o").iterdir()))
            sk = json.loads((pathlib.Path(t) / "o" / "skillret.json").read_text())
            eq((50, True), (sk["n"], sk["gate"]["met"]))
    finally:
        del os.environ["CTC_DATABASE_URL"]
        d.close()


def main() -> int:
    try:
        mod = importlib.import_module("evaluation.record_baselines")
        err = None
    except BaseException as e:  # noqa: BLE001 - module not built yet is the expected state before the coder runs
        mod, err = None, f"{type(e).__name__}: {e}"
    bad = 0
    snap = {k: copy.copy(v) for k, v in vars(mod).items() if k.isupper()} if mod else {}  # constants a check changes are restored after it
    for did in IDS:
        if mod is None:
            print(f"FAIL {did} evaluation/record_baselines.py importable | {err}")
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
