"""T0.2: evaluation/record_baselines.py against a fake daemon (stdlib http.server) and a fake ranking-test script. No database, no network."""

import copy
import http.server
import json
import subprocess
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from evaluation import record_baselines as rb

IMPORT_TIME = (rb.WARMUP, rb.SETTLE_S)
SCRATCH = "postgresql://u:secret@127.0.0.1:18304/scratch"
REPORT = {"n": 50, "header": {"text_mode": "skillret", "git_sha": "abc"}, "ranking": {"keyword_rrf_weight": 0, "rerank_weight": 0},
          "scores": {m: {"recall@1": 0.56789, "recall@5": 0.8243, "recall@10": 0.9, "ndcg@10": 0.81151, "mrr": 0.85} for m in rb.MODES},
          "compare": {"x": []}}
STDOUT = "loading...\nINFO {not json}\n" + json.dumps(REPORT, indent=1) + "\n\nPaired significance:\n| a | b |\n"


class Daemon:
    def __init__(self, status=200):
        self.calls, self.qs, self.status, self.pre_n = [], [], status, 0
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def reply(self, code, body):
                self.send_response(code)
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                outer.calls.append(("GET", self.path))
                self.reply(200, json.dumps({"library_version": "v1", "mode": "local"}).encode())

            def do_POST(self):
                outer.calls.append(("POST", self.path))
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                if outer.status != 200:
                    return self.reply(outer.status, b"{}")
                if self.path == "/v1/search":
                    outer.qs.append(body["q"])
                    return self.reply(200, b'{"hits": []}')
                outer.pre_n += 1
                self.reply(200, b"" if outer.pre_n == 1 else b'{"note": 1}')

        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()


@pytest.fixture
def daemon():
    d = Daemon()
    yield d
    d.srv.shutdown()


@pytest.fixture(autouse=True)
def fast(monkeypatch):
    monkeypatch.setattr(rb, "SETTLE_S", 0.0)
    monkeypatch.setattr(rb, "WARMUP", 1)
    monkeypatch.delenv("CTC_DATABASE_URL", raising=False)


@pytest.fixture
def env(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    for i in range(8):
        (repo / f"f{i}.txt").write_text(str(i))
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    prompts = tmp_path / "p.jsonl"
    prompts.write_text("".join(json.dumps({"id": f"q{i:02d}", "query": f"prompt {i}", "x": 1}) + "\n" for i in range(8)))
    return ["--repo", str(repo), "--prompts", str(prompts), "--out", str(tmp_path / "o")], tmp_path / "o"


def fake_ranking(tmp_path, body):
    f = tmp_path / "rank.py"
    f.write_text(body)
    return [sys.executable, str(f)]


def test_defaults_pinned():
    assert (rb.N_LATENCY, rb.N_PRE, rb.SEED, rb.TIMEOUT_S, rb.SKILLRET_TIMEOUT_S) == (100, 50, 0, 30.0, 7200)
    assert IMPORT_TIME == (3, 3.0)
    assert (rb.DAEMON, rb.OUT, rb.SKILLRET_GATE) == ("http://127.0.0.1:18310", "fixtures/py-baseline", 0.80)
    assert rb.METRICS == ["recall@1", "recall@5", "recall@10", "ndcg@10", "mrr"]
    assert rb.RANKING_CMD[1:] == ["-m", "evaluation.retrieval_eval", "ranking-test"]
    assert "NOT" in rb.__doc__


def test_percentile_and_summarize():
    xs = [1.0, 2.0, 3.0, 4.0, 10.0]
    assert (rb.percentile(xs, 50), rb.percentile(xs, 100), rb.percentile(xs[::-1], 0)) == (3.0, 10.0, 1.0)
    assert round(rb.percentile(xs, 95), 6) == 8.8
    assert rb.percentile([5.0], 99) == 5.0
    assert rb.summarize(xs) == {"n": 5, "min": 1.0, "p50": 3.0, "p95": 8.8, "p99": 9.8, "max": 10.0}
    with pytest.raises(ValueError):
        rb.percentile([], 50)


def test_nonce_and_sampling(monkeypatch):
    assert rb.nonce_prompt("hello", "ab12cd", 7) == "hello\n\nctc-baseline-ab12cd-7"
    q = [{"id": f"q{i:02d}", "query": f"s{i}"} for i in range(20)]
    before = copy.deepcopy(q)
    a = rb.sample_prompts(q, n=5, seed=0)
    assert a == rb.sample_prompts(q, n=5, seed=0) and len(set(a)) == 5 and q == before
    monkeypatch.setattr(rb, "N_LATENCY", 2)
    assert len(rb.sample_prompts(q)) == 2


def test_sampling_odd_input():
    long = "ünï\nlong " + "x" * 3900
    rows = [{"id": "b", "query": "dup"}, {"id": "a", "query": "dup"}, {"id": "c", "query": "  "}, {"id": "d", "query": long, "k": 1}]
    assert sorted(rb.sample_prompts(rows, n=10, seed=0)) == sorted(["dup", long])
    assert rb.sample_prompts([{"id": "a", "query": "x"}], n=100, seed=1) == ["x"]


def test_pre_body():
    assert rb.pre_body("/r/a", "b.py") == {"hook_event_name": "PreToolUse", "tool_name": "Read", "tool_input": {"file_path": "/r/a/b.py"},
                                          "cwd": "/r/a", "session_id": "ctc-baseline"}


def test_parse_ranking():
    assert rb.parse_ranking(STDOUT) == REPORT
    for bad in ("", "no braces", "[1, 2]\n"):
        with pytest.raises(ValueError):
            rb.parse_ranking(bad)


def test_skillret_baseline():
    before = copy.deepcopy(REPORT)
    sk = rb.skillret_baseline(REPORT, 50)
    assert before == REPORT and "compare" not in sk
    assert set(sk) == {"recorded_at", "git_sha", "source", "limited", "n", "header", "ranking", "scores", "gate"}
    assert sk["scores"]["full"] == {"recall@1": 0.5679, "recall@5": 0.8243, "recall@10": 0.9, "ndcg@10": 0.8115, "mrr": 0.85}
    assert sk["gate"] == {"metric": "ndcg@10", "split": "test", "min": 0.80, "value": 0.8115, "met": True}
    low = copy.deepcopy(REPORT)
    low["scores"]["full"]["ndcg@10"] = 0.5
    assert rb.skillret_baseline(low)["gate"]["met"] is False
    del low["scores"]["old"]
    with pytest.raises(KeyError):
        rb.skillret_baseline(low)


def test_scratch_url_and_mask():
    assert rb.scratch_url({}) is None
    assert rb.scratch_url({"CTC_DATABASE_URL": "postgresql://x:y@db.supabase.co:5432/postgres"}) is None
    assert rb.scratch_url({"CTC_DATABASE_URL": SCRATCH}) == SCRATCH
    assert rb.mask_urls(f"{SCRATCH} failed") == "postgresql://u:***@127.0.0.1:18304/scratch failed"


def test_latency_file(daemon, env):
    args, out = env
    assert rb.main(["latency", "--url", daemon.url, *args, "--limit", "4"]) == 0
    raw = (out / "latency.json").read_text()
    doc = json.loads(raw)
    assert raw.endswith("\n") and not list(out.glob("*.part"))
    assert set(doc) == {"recorded_at", "git_sha", "daemon_url", "health", "host", "limited", "prompts", "tiers", "gates_for_ts", "not_measured"}
    assert doc["tiers"]["search_miss"].keys() == {"n", "min", "p50", "p95", "p99", "max"}
    assert doc["tiers"]["pre"].keys() == {"n", "min", "p50", "p95", "p99", "max", "note_rate"}
    assert (doc["limited"], doc["tiers"]["search_miss"]["n"], doc["tiers"]["pre"]["n"], doc["tiers"]["pre"]["note_rate"]) == (4, 4, 4, 1.0)
    assert doc["gates_for_ts"] == {"suggest_cold_p95_ms": 150, "suggest_l1_p95_ms": 10, "hook_pre_p95_ms": 40}
    assert (doc["health"]["mode"], doc["host"].keys()) == ("local", {"cpus", "load_1m"})


def test_latency_sends_nonce_miss_then_identical_warm(daemon, env):
    args, _ = env
    assert rb.main(["latency", "--url", daemon.url, *args, "--limit", "3"]) == 0
    qs = daemon.qs
    assert len(qs) == 1 + 2 * 3 and qs[0].endswith("-1")  # one warm-up, miss pass, warm pass
    assert qs[1:4] == qs[4:7] and len(set(qs[1:4])) == 3 and all("\n\nctc-baseline-" in q for q in qs)


def test_limit_below_warmup_still_measures(daemon, env, monkeypatch):
    monkeypatch.setattr(rb, "WARMUP", 3)
    args, out = env
    assert rb.main(["latency", "--url", daemon.url, *args, "--limit", "2"]) == 0
    assert json.loads((out / "latency.json").read_text())["tiers"]["search_warm"]["n"] == 2
    assert len(daemon.qs) == 3 + 2 * 2


def test_daemon_routes_are_read_only(daemon, env):
    args, _ = env
    rb.main(["latency", "--url", daemon.url, *args, "--limit", "2"])
    assert set(daemon.calls) == {("GET", "/v1/health"), ("POST", "/v1/search"), ("POST", "/v1/hook/pre")}


def test_exit_codes(daemon, env):
    args, out = env
    assert rb.main(["bogus"]) == 2
    assert rb.main(["latency", "--limit", "0"]) == 2
    assert rb.main(["latency", "--nope"]) == 2
    assert rb.main(["latency", "--url", "http://127.0.0.1:9", *args, "--limit", "2"]) == 3
    assert not out.exists() or not any(out.iterdir())
    bad = Daemon(status=500)
    try:
        assert rb.main(["latency", "--url", bad.url, *args, "--limit", "2"]) == 3
    finally:
        bad.srv.shutdown()
    assert rb.main(["latency", "--url", daemon.url, *args, "--limit", "2"]) == 0
    assert rb.main(["latency", "--url", daemon.url, *args, "--limit", "2"]) == 5
    assert rb.main(["latency", "--url", daemon.url, *args, "--limit", "2", "--force"]) == 0
    assert rb.main(["latency", "--url", daemon.url, "--repo", str(out), "--prompts", args[3], "--out", str(out / "z")]) == 2


def test_skillret_refuses_without_scratch_url(env, monkeypatch):
    args, out = env
    assert rb.main(["skillret", "--out", str(out)]) == 2
    monkeypatch.setenv("CTC_DATABASE_URL", "postgresql://a:b@db.supabase.co/x")
    assert rb.main(["all", *args]) == 2 and not out.exists()


def test_skillret_child(tmp_path, monkeypatch):
    monkeypatch.setenv("CTC_DATABASE_URL", SCRATCH)
    monkeypatch.setattr(rb, "RANKING_CMD", fake_ranking(tmp_path, f"print({STDOUT!r})\n"))
    assert rb.main(["skillret", "--out", str(tmp_path / "o"), "--limit", "50"]) == 0
    sk = json.loads((tmp_path / "o" / "skillret.json").read_text())
    assert (sk["n"], sk["limited"], sk["gate"]["met"]) == (50, 50, True)
    monkeypatch.setattr(rb, "RANKING_CMD", fake_ranking(tmp_path, "print('no json')\n"))
    assert rb.main(["skillret", "--out", str(tmp_path / "f")]) == 4
    monkeypatch.setattr(rb, "RANKING_CMD", fake_ranking(tmp_path, "import sys\nsys.exit(3)\n"))
    assert rb.main(["skillret", "--out", str(tmp_path / "g")]) == 4
    assert not (tmp_path / "f").exists() or not any((tmp_path / "f").iterdir())


def test_child_cannot_start_and_output_write_failure(tmp_path, monkeypatch):
    monkeypatch.setenv("CTC_DATABASE_URL", SCRATCH)
    monkeypatch.setattr(rb, "RANKING_CMD", ["/nonexistent/bin"])
    assert rb.main(["skillret", "--out", str(tmp_path / "o"), "--limit", "1"]) == 4
    monkeypatch.setattr(rb, "RANKING_CMD", fake_ranking(tmp_path, f"print({STDOUT!r})\n"))
    f = tmp_path / "afile"
    f.write_text("x")
    assert rb.main(["skillret", "--out", str(f)]) == 3


def test_skillret_child_timeout_and_masked_output(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("CTC_DATABASE_URL", SCRATCH)
    monkeypatch.setattr(rb, "SKILLRET_TIMEOUT_S", 1)
    monkeypatch.setattr(rb, "RANKING_CMD", fake_ranking(tmp_path, f"import time\nprint({SCRATCH!r}, flush=True)\ntime.sleep(60)\n"))
    assert rb.main(["skillret", "--out", str(tmp_path / "o")]) == 4
    err = capsys.readouterr().err
    assert "secret" not in err and "u:***@" in err


def test_all_writes_both(daemon, env, tmp_path, monkeypatch):
    args, out = env
    monkeypatch.setenv("CTC_DATABASE_URL", SCRATCH)
    monkeypatch.setattr(rb, "RANKING_CMD", fake_ranking(tmp_path, f"print({STDOUT!r})\n"))
    assert rb.main(["all", "--url", daemon.url, *args, "--limit", "2"]) == 0
    assert sorted(p.name for p in out.iterdir()) == ["latency.json", "skillret.json"]
