#!/usr/bin/env python3
"""Self-check for T0.2 (evaluation/record_baselines.py). Last line `SELFCHECK: DONE` only if every section passed.

    python agent/t0-2-baselines/selfcheck.py            # tests, project tests, checks, lint, scope  (the Done command)
    python agent/t0-2-baselines/selfcheck.py --fast     # own tests + checks only; never prints DONE
    python agent/t0-2-baselines/selfcheck.py --live     # also: `latency --limit 20` on the daemon and `skillret --limit 50` on the scratch DB, into a temp dir (orchestrator step; reads only)
    python agent/t0-2-baselines/selfcheck.py --freeze   # orchestrator: record sha256 of the agent/t0-2-baselines files; later runs fail if they change

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
MODULES = ["evaluation/record_baselines.py"]
TEST_GLOB = "tests/test_record_baselines*.py"  # new test files; the coder writes at least one
ALLOWED_EXTRA = []  # other paths the coder may touch (exact or fnmatch)
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
    extra = []
    problems = [*(f"outside scope: {p}" for p in bad), *([f"agent files {msg}"] if not ok_frozen else []), *extra]
    return section(f"scope (only {', '.join(allowed)})", not problems, "\n".join(problems))


def sec_preconditions() -> bool:
    url = os.environ.get("CTC_DATABASE_URL", "")
    return section("preconditions", True, "CTC_DATABASE_URL unset or Supabase: only the unit tests run; --live needs a scratch URL" if not url or "supabase" in url else "scratch database url set")


def sec_live() -> bool:
    url = os.environ.get("CTC_DATABASE_URL", "")
    if not url or "supabase" in url:
        return section("live smoke", False, "set CTC_DATABASE_URL to the scratch Postgres (not Supabase) for the skillret part")
    d = pathlib.Path(tempfile.mkdtemp(prefix="t02-live-"))
    c1, o1 = run([PY, "-m", "evaluation.record_baselines", "latency", "--limit", "20", "--out", str(d), "--repo", str(ROOT)], timeout=900)
    c2, o2 = run([PY, "-m", "evaluation.record_baselines", "skillret", "--limit", "50", "--out", str(d)], timeout=3600)
    need = ["latency.json", "skillret.json"]
    missing = [n for n in need if not (d / n).exists()]
    parts = [str(p) for p in d.rglob("*.part")]
    shutil.rmtree(d, ignore_errors=True)
    return section("live smoke (latency --limit 20; skillret --limit 50)", c1 == 0 and c2 == 0 and not missing and not parts, f"{o1[-800:]}\n{o2[-800:]}\nmissing={missing} parts={parts}")


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
