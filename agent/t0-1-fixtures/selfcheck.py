#!/usr/bin/env python3
"""Self-check for T0.1 (evaluation/record_fixtures.py). Last line `SELFCHECK: DONE` only if every section passed.

    python agent/t0-1-fixtures/selfcheck.py            # tests, project tests, checks, lint, scope  (the Done command)
    python agent/t0-1-fixtures/selfcheck.py --fast     # own tests + checks only; never prints DONE
    python agent/t0-1-fixtures/selfcheck.py --live     # also: `all --limit 3` against the running daemon into a temp dir, then check no own prompt text sits outside local/ (orchestrator step; reads only)
    python agent/t0-1-fixtures/selfcheck.py --freeze   # orchestrator: record sha256 of the agent/t0-1-fixtures files; later runs fail if they change

Run it with the project's python (the one that has pytest, ruff and the project dependencies). The branch base for the scope check is
HEAD (override: SELFCHECK_BASE=<rev>)."""
from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PY = sys.executable
MODULES = ["evaluation/record_fixtures.py"]
TEST_GLOB = "tests/test_record_fixtures*.py"  # new test files; the coder writes at least one
ALLOWED_EXTRA = [".gitignore", "fixtures/py-baseline/graph-questions.json"]  # other paths the coder may touch (exact or fnmatch)
IGNORED = ("agent/", "specs/", ".claude/agents/", ".claude/journal/", "SPEC.md", "data", ".venv", "fixtures/py-baseline/local/")  # not the coder's
FROZEN = HERE / ".frozen.json"
FILES = ["SPEC.md", "DECISIONS.md", "PROCESS.md", "checks.py", "selfcheck.py"]
results: list[tuple[str, bool, str]] = []


def run(cmd: list[str], timeout: int = 900, env: dict | None = None) -> tuple[int, str]:
    try:
        p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=timeout, env={**os.environ, **(env or {})})
        return p.returncode, (p.stdout + p.stderr)
    except subprocess.TimeoutExpired as e:
        return 124, f"timeout after {timeout}s: {cmd}\n{e.stdout or ''}"


def section(name: str, ok: bool, detail: str = "") -> bool:
    results.append((name, ok, detail))
    print(f"{'OK  ' if ok else 'FAIL'} {name}" + (f"\n{detail.rstrip()[-3000:]}" if detail and not ok else ""))
    return ok


def test_files() -> list[str]:
    return sorted(str(p.relative_to(ROOT)) for p in ROOT.glob(TEST_GLOB))


def frozen_ok() -> tuple[bool, str]:
    if not FROZEN.exists():
        return True, "no .frozen.json (orchestrator has not frozen the agent files)"
    want = json.loads(FROZEN.read_text())
    got = {f: hashlib.sha256((HERE / f).read_bytes()).hexdigest() for f in FILES if f != "selfcheck.py"}
    bad = [f for f in got if want.get(f) != got[f]]
    return not bad, f"changed: {bad}" if bad else "unchanged"


def sec_own_tests() -> bool:
    tf = test_files()
    if not tf:
        return section("own tests", False, f"no test file matches {TEST_GLOB}")
    code, out = run([PY, "-m", "pytest", "-q", "-x", "-p", "no:cacheprovider", *tf], timeout=600)
    return section("own tests", code == 0, out)


def sec_project_tests() -> bool:
    code, out = run([PY, "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests"], timeout=1200)
    return section("project tests (tests/, DB tests skip without a scratch CTC_DATABASE_URL)", code == 0, out)


def sec_checks() -> bool:
    code, out = run([PY, str(HERE / "checks.py")], timeout=300)
    return section("checks (one per decision id)", code == 0 and "FAIL" not in out, "" if code == 0 else out)


def sec_lint() -> bool:
    targets = [m for m in MODULES if (ROOT / m).exists()] + test_files()
    if not targets:
        return section("lint", False, "nothing to lint: module and tests missing")
    cmd = [PY, "-m", "ruff", "check", *targets]
    code, out = run(cmd)
    if code != 0 and "No module named ruff" in out and shutil.which("ruff"):
        code, out = run(["ruff", "check", *targets])
    return section("lint (ruff check, repo config)", code == 0, out)


def changed_paths() -> list[str]:
    base = os.environ.get("SELFCHECK_BASE", "HEAD")
    a = run(["git", "diff", "--name-only", base])[1].split()
    b = run(["git", "ls-files", "--others", "--exclude-standard"])[1].split()
    return sorted({p for p in a + b if not any(p == i or p.startswith(i if i.endswith("/") else i + "/") for i in IGNORED) and "__pycache__" not in p and not p.endswith(".pyc")})


def sec_scope() -> bool:
    allowed = [*MODULES, TEST_GLOB, *ALLOWED_EXTRA]
    bad = [p for p in changed_paths() if not any(fnmatch.fnmatch(p, a) for a in allowed)]
    ok_frozen, msg = frozen_ok()
    extra = [*(["fixtures/py-baseline/graph-questions.json differs from agent/t0-1-fixtures/graph_questions.json"]
        if (ROOT / "fixtures/py-baseline/graph-questions.json").exists() and (ROOT / "fixtures/py-baseline/graph-questions.json").read_bytes() != (HERE / "graph_questions.json").read_bytes() else []),
             *(["tracked .gitignore lost lines (only additions allowed)"] if any(l.startswith("-") and not l.startswith("---") for l in run(["git", "diff", "HEAD", "--", ".gitignore"])[1].splitlines()) else [])]
    problems = [*(f"outside scope: {p}" for p in bad), *([f"agent files {msg}"] if not ok_frozen else []), *extra]
    return section(f"scope (only {', '.join(allowed)})", not problems, "\n".join(problems))


def sec_preconditions() -> bool:
    return section("preconditions", True, "none: unit tests use a fake daemon")


def sec_live() -> bool:
    d = pathlib.Path(tempfile.mkdtemp(prefix="t01-live-"))
    code, out = run([PY, "-m", "evaluation.record_fixtures", "all", "--limit", "3", "--out", str(d)], timeout=600)
    if code != 0:
        return section("live smoke (all --limit 3)", False, out)
    own = ROOT / "data" / "processed" / "own-eval.jsonl"
    secrets = [json.loads(x)["query"] for x in own.read_text().splitlines() if x.strip()] if own.exists() else []
    leaks = []
    for f in d.rglob("*"):
        if f.is_file() and "local" not in f.relative_to(d).parts:
            t = f.read_text(errors="replace")
            leaks += [f"{f.name} holds an own prompt" for q in secrets if q.strip() and len(q) > 12 and q in t][:1]
    need = ["manifest.json", "api-shapes.json", "graph.jsonl"]
    missing = [n for n in need if not (d / n).exists()]
    leftovers = [str(p) for p in d.rglob("*.part")]
    shutil.rmtree(d, ignore_errors=True)
    return section("live smoke (all --limit 3 on the daemon, privacy grep)", not (leaks or missing or leftovers), f"leaks={leaks} missing={missing} parts={leftovers}")


def main() -> int:
    a = set(sys.argv[1:])
    if "--freeze" in a:
        FROZEN.write_text(json.dumps({f: hashlib.sha256((HERE / f).read_bytes()).hexdigest() for f in FILES if f != "selfcheck.py"}, indent=1))
        print("frozen", FROZEN)
        return 0
    fast = "--fast" in a
    sec_own_tests()
    sec_checks()
    if not fast:
        sec_preconditions()
        sec_project_tests()
        sec_lint()
        sec_scope()
        if "--live" in a:
            sec_live()
    bad = [n for n, ok, _ in results if not ok]
    if bad:
        print(f"SELFCHECK: FAILED ({len(bad)}): " + "; ".join(bad))
        return 1
    print("SELFCHECK: FAST PASS (not done: run without --fast)" if fast else "SELFCHECK: DONE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
