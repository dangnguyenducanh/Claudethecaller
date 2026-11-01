"""T0.2: record what the Python daemon does today, so the TypeScript port's gates (spec 007: suggest.latency, suggest.skills) have a number to be compared with.

Run by hand (or by the orchestrator); nothing imports it:
    python -m evaluation.record_baselines {latency|skillret|all} [--url U] [--out DIR] [--repo DIR] [--prompts FILE] [--limit N] [--force]
Writes `latency.json` (client wall time of POST /v1/search miss and warm, POST /v1/hook/pre) and `skillret.json` (SkillRet test scores of
`evaluation.retrieval_eval ranking-test`) under fixtures/py-baseline. Both use public prompts only, so both files are safe to commit.

Deliberately NOT done: no tuning of any knob; no pass or fail on the numbers (`gate.met` is data, the exit code stays 0); no comparison with the
TypeScript port; no throughput test; no /v1/hook/prompt (it writes session rows), /v1/route or /v1/suggest numbers; no Redis flush (cold is made
with a nonce); no paired significance tests (the child's `compare` block is dropped); never touches Supabase or any database itself.
Exit codes: 0 ok, 2 usage or database refusal, 3 daemon failure, 4 ranking-test child failure, 5 target file exists without --force.
"""

from __future__ import annotations

import argparse
import datetime
import json
import math
import os
import pathlib
import random
import re
import signal
import subprocess
import sys
import time
import uuid

import httpx

N_LATENCY = 100  # prompts per search pass: matches the size evaluation/graph_eval.py:13 and latency_eval.py use for timing; not tuned
N_PRE = 50  # files for the pre tier: matches evaluation/graph_eval.py:13 `50 prompt + 50 pre hooks`; not tuned
WARMUP = 3  # discarded search requests before the miss pass; chosen by judgment
SEED = 0  # chosen by judgment; fixed so a rerun samples the same prompts
TIMEOUT_S = 30.0  # per HTTP call; same as evaluation/latency_eval.py
SKILLRET_TIMEOUT_S = 7200  # the 6,006-skill index plus rerank of the whole test split; chosen by judgment
SETTLE_S = 3.0  # the daemon loads a project graph in the background on first sight (src/ctc/graph/core.py graph_for); chosen by judgment
DAEMON = "http://127.0.0.1:18310"
OUT = "fixtures/py-baseline"
METRICS = ["recall@1", "recall@5", "recall@10", "ndcg@10", "mrr"]
SKILLRET_GATE = 0.80  # specs/007-ctc/spec.md:460 NDCG@10 >= 0.80 on the SkillRet test split
RANKING_CMD = [sys.executable, "-m", "evaluation.retrieval_eval", "ranking-test"]  # a test may replace it

ROOT = pathlib.Path(__file__).resolve().parents[1]
GATES_FOR_TS = {"suggest_cold_p95_ms": 150, "suggest_l1_p95_ms": 10, "hook_pre_p95_ms": 40}
NOT_MEASURED = [
    {"what": "POST /v1/hook/prompt", "reason": "writes session and decision rows"},
    {"what": "POST /v1/suggest", "reason": "does not exist in the Python daemon"},
]
SEARCH_CWD = "/nonexistent/ctc-eval"
MODES = ("dense", "hybrid", "old", "full")
URL_PASSWORD = re.compile(r"(\b[a-z][a-z0-9+.-]*://[^:/\s@]*):\S*@", re.IGNORECASE)


class Fail(Exception):
    """A run failure carrying its exit code."""

    def __init__(self, code: int, msg: str):
        super().__init__(msg)
        self.code = code


def percentile(xs: list[float], p: float) -> float:
    """Linear interpolation between order statistics (numpy's default). Raises ValueError on an empty list. Does not modify `xs`."""
    if not xs:
        raise ValueError("percentile of an empty list")
    s = sorted(xs)
    k = (len(s) - 1) * p / 100
    f = math.floor(k)
    c = min(f + 1, len(s) - 1)
    return s[f] + (s[c] - s[f]) * (k - f)


def summarize(ms: list[float]) -> dict:
    """{n, min, p50, p95, p99, max} in ms, rounded to 1 decimal. Raises ValueError on an empty list."""
    return {"n": len(ms), "min": round(min(ms), 1), "p50": round(percentile(ms, 50), 1), "p95": round(percentile(ms, 95), 1),
            "p99": round(percentile(ms, 99), 1), "max": round(max(ms), 1)}


def nonce_prompt(prompt: str, run_id: str, i: int) -> str:
    """The prompt with a unique tail, so the daemon's embedding cache has never seen the text and the embedder runs."""
    return f"{prompt}\n\nctc-baseline-{run_id}-{i}"


def sample_prompts(queries: list[dict], n: int | None = None, seed: int | None = None) -> list[str]:
    """Query strings from `{id, query}` rows (extra keys ignored): blank and duplicate queries dropped, sorted by id, `n` sampled with `seed`
    (defaults N_LATENCY and SEED, read now). Fewer rows than `n` gives all of them. `queries` is not modified."""
    n = N_LATENCY if n is None else n
    seed = SEED if seed is None else seed
    seen, rows = set(), []
    for r in sorted((r for r in queries if isinstance(r, dict)), key=lambda r: str(r.get("id", ""))):  # judgment: non-dict rows are skipped, not an error
        q = r.get("query")
        if isinstance(q, str) and q.strip() and q not in seen:  # judgment: rows without a usable query are skipped, not an error
            seen.add(q)
            rows.append(q)
    return random.Random(seed).sample(rows, min(n, len(rows)))


def pre_body(repo: str, relpath: str) -> dict:
    """Body of a PreToolUse Read hook for `repo/relpath` (src/ctc/server/hooks.py /v1/hook/pre)."""
    return {"hook_event_name": "PreToolUse", "tool_name": "Read", "tool_input": {"file_path": f"{repo}/{relpath}"}, "cwd": repo,
            "session_id": "ctc-baseline"}


def parse_ranking(stdout: str) -> dict:
    """The one JSON object ranking-test prints (starts at the first line that is exactly `{`); text before and after is ignored.
    Raises ValueError when there is none or it is not a dict."""
    lines = stdout.splitlines(keepends=True)
    for i, line in enumerate(lines):
        if line.rstrip("\r\n") == "{":
            obj, _ = json.JSONDecoder().raw_decode("".join(lines[i:]))
            if not isinstance(obj, dict):
                raise ValueError("ranking-test output is not a JSON object")
            return obj
    raise ValueError("no JSON object in ranking-test output")


def _round_metrics(m: dict) -> dict:
    return {k: round(m[k], 4) for k in METRICS}


def skillret_baseline(report: dict, limit: int | None = None) -> dict:
    """skillret.json from a parsed ranking-test object (not modified). Raises KeyError or ValueError if a key or mode is missing.
    `compare` is dropped. `gate.met` is data."""
    scores = {m: _round_metrics(report["scores"][m]) for m in MODES}
    value = scores["full"]["ndcg@10"]
    return {"recorded_at": _now(), "git_sha": _git_sha(), "source": "evaluation.retrieval_eval ranking-test", "limited": limit,
            "n": report["n"], "header": report["header"], "ranking": report["ranking"], "scores": scores,
            "gate": {"metric": "ndcg@10", "split": "test", "min": SKILLRET_GATE, "value": value, "met": value >= SKILLRET_GATE}}


def scratch_url(env: dict | None = None) -> str | None:
    """CTC_DATABASE_URL when set and not Supabase (same rule as scripts/check.sh:15), else None."""
    url = (os.environ if env is None else env).get("CTC_DATABASE_URL", "")
    return url if url and "supabase" not in url.lower() else None


def mask_urls(text: str) -> str:
    """`scheme://user:password@host` becomes `scheme://user:***@host`."""
    return URL_PASSWORD.sub(r"\1:***@", text)


def _now() -> str:
    return datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds")


def _git(*args: str, cwd: pathlib.Path | str = ROOT) -> str:
    p = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=30, check=False)
    if p.returncode:
        raise Fail(2, f"git {' '.join(args)} failed in {cwd}: {p.stderr.strip()}")
    return p.stdout


def _git_sha() -> str:
    try:
        return _git("rev-parse", "--short", "HEAD").strip()
    except (Fail, OSError, subprocess.SubprocessError):
        return ""  # judgment: a missing sha does not stop a recording


def _timed(c: httpx.Client, path: str, body: dict) -> tuple[float, httpx.Response]:
    t = time.perf_counter()
    r = c.post(path, json=body)
    ms = (time.perf_counter() - t) * 1000
    if r.status_code != 200:
        raise Fail(3, f"POST {path} answered {r.status_code}")
    return ms, r


def _search(c: httpx.Client, text: str) -> float:
    return _timed(c, "/v1/search", {"q": text, "cwd": SEARCH_CWD, "k": 5, "explain": False})[0]


def _load_rows(path: str | None) -> list[dict]:
    if path is None:
        from evaluation.loaders import skillret  # lazy: pulls in `datasets`

        return skillret("test")[1]
    try:
        with open(path, encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]
    except (OSError, ValueError) as e:
        raise Fail(2, f"cannot read prompts {path}: {e}") from e


def _repo_files(repo: str | None) -> tuple[str, list[str]]:
    if repo and not os.path.isdir(repo):
        raise Fail(2, f"--repo {repo} is not a directory")
    root = os.path.realpath(repo) if repo else _git("rev-parse", "--show-toplevel", cwd=".").strip()
    files = sorted(p for p in _git("ls-files", "-z", cwd=root).split("\0") if p)
    if not files:
        raise Fail(2, f"no tracked files in {root}")
    return root, files


def record_latency(a: argparse.Namespace) -> dict:
    n_prompt, n_pre = a.limit or N_LATENCY, a.limit or N_PRE
    root, files = _repo_files(a.repo)
    prompts = sample_prompts(_load_rows(a.prompts), n_prompt)
    if not prompts:
        raise Fail(2, "no usable prompts")
    paths = random.Random(SEED).sample(files, min(n_pre, len(files)))
    load_1m = os.getloadavg()[0]
    run_id = uuid.uuid4().hex[:6]
    try:
        with httpx.Client(base_url=a.url, timeout=TIMEOUT_S) as c:
            r = c.get("/v1/health")
            if r.status_code != 200:
                raise Fail(3, f"GET /v1/health answered {r.status_code}")
            health = r.json()
            for k in range(1, WARMUP + 1):  # discarded; the --limit < WARMUP case still sends all of them
                _search(c, nonce_prompt(prompts[0], run_id, -k))
            texts = [nonce_prompt(p, run_id, i) for i, p in enumerate(prompts)]
            miss = [_search(c, t) for t in texts]
            warm = [_search(c, t) for t in texts]  # the same texts: the embedding is cached now
            _timed(c, "/v1/hook/pre", pre_body(root, paths[0]))  # discarded: the daemon answers empty until its graph is loaded
            time.sleep(SETTLE_S)
            pre, notes = [], 0
            for p in paths:
                ms, r = _timed(c, "/v1/hook/pre", pre_body(root, p))
                pre.append(ms)
                notes += bool(r.content.strip())
    except (httpx.HTTPError, ValueError) as e:
        raise Fail(3, f"daemon {a.url}: {type(e).__name__}: {e}") from e
    note_rate = round(notes / len(pre), 4)
    if note_rate == 0:
        print("warning: no pre reply carried a note; the repo has no graph in the daemon, so the pre numbers are the empty-reply latency", file=sys.stderr)
    return {"recorded_at": _now(), "git_sha": _git_sha(), "daemon_url": a.url, "health": health,
            "host": {"cpus": os.cpu_count(), "load_1m": load_1m}, "limited": a.limit, "prompts": len(prompts),
            "tiers": {"search_miss": summarize(miss), "search_warm": summarize(warm), "pre": {**summarize(pre), "note_rate": note_rate}},
            "gates_for_ts": GATES_FOR_TS, "not_measured": NOT_MEASURED}


def _run_child(cmd: list[str]) -> str:
    try:
        p = subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
    except OSError as e:
        raise Fail(4, f"ranking-test could not start: {type(e).__name__}: {e}") from e
    try:
        out, _ = p.communicate(timeout=SKILLRET_TIMEOUT_S)
    except subprocess.TimeoutExpired as e:
        os.killpg(p.pid, signal.SIGKILL)
        out, _ = p.communicate()
        raise Fail(4, f"ranking-test timed out after {SKILLRET_TIMEOUT_S}s\n{_tail(out or '')}") from e
    if p.returncode:
        raise Fail(4, f"ranking-test exited {p.returncode}\n{_tail(out)}")
    return out


def _tail(text: str) -> str:
    return mask_urls("\n".join(text.splitlines()[-20:]))


def record_skillret(a: argparse.Namespace) -> dict:
    out = _run_child([*RANKING_CMD, *([str(a.limit)] if a.limit else [])])
    try:
        return skillret_baseline(parse_ranking(out), a.limit)
    except (ValueError, KeyError, TypeError) as e:
        raise Fail(4, f"ranking-test output unusable: {type(e).__name__}: {e}\n{_tail(out)}") from e


def _write_all(out: pathlib.Path, docs: dict[str, dict]) -> None:
    """Writes every `<name>.part`, then renames them all; a failure leaves no `.part` and no half-replaced set."""
    out.mkdir(parents=True, exist_ok=True)
    parts = {out / f"{n}.part": out / n for n in docs}
    try:
        for (part, _), doc in zip(parts.items(), docs.values()):
            part.write_text(json.dumps(doc, sort_keys=True, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        for part, final in parts.items():
            part.rename(final)
    finally:
        for part in parts:
            part.unlink(missing_ok=True)


def _parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="record_baselines", description="Record the Python daemon's latency and the SkillRet scores.")
    ap.add_argument("cmd", choices=["latency", "skillret", "all"])
    ap.add_argument("--url", default=None, help=f"daemon base URL (default {DAEMON})")
    ap.add_argument("--out", default=None, help=f"output directory (default {OUT})")
    ap.add_argument("--repo", default=None, help="git repo whose files feed the pre tier (default: the repo of the current directory)")
    ap.add_argument("--prompts", default=None, help="JSONL of {id, query} rows (default: SkillRet test queries)")
    ap.add_argument("--limit", type=int, default=None, help="replaces N_LATENCY and N_PRE; passed to ranking-test")
    ap.add_argument("--force", action="store_true", help="overwrite existing output files")
    return ap


def main(argv: list[str] | None = None) -> int:
    try:
        a = _parser().parse_args(argv)
    except SystemExit as e:
        return e.code if isinstance(e.code, int) else 2
    steps = {"latency": [("latency.json", record_latency)], "skillret": [("skillret.json", record_skillret)]}
    steps["all"] = steps["latency"] + steps["skillret"]
    a.url, out = a.url or DAEMON, pathlib.Path(a.out or OUT)
    try:
        if a.limit is not None and a.limit < 1:
            raise Fail(2, "--limit must be at least 1")
        if a.cmd != "latency" and scratch_url() is None:
            raise Fail(2, "skillret needs CTC_DATABASE_URL set to the scratch Postgres (not Supabase)")
        exists = [n for n, _ in steps[a.cmd] if (out / n).exists()]
        if exists and not a.force:
            raise Fail(5, f"{', '.join(exists)} exist in {out}; pass --force to overwrite")
        docs = {name: fn(a) for name, fn in steps[a.cmd]}
        _write_all(out, docs)
        for name in docs:
            print(f"wrote {out / name}")
    except Fail as e:
        print(mask_urls(str(e)), file=sys.stderr)
        return e.code
    except (httpx.HTTPError, OSError, subprocess.SubprocessError) as e:  # judgment: D4 has no code for an output write failure, so it shares 3 (the message names the OSError type)
        print(mask_urls(f"{type(e).__name__}: {e}"), file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
