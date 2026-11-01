#!/usr/bin/env python3
"""Self-check for T1.3 (packages/shared/src/repositories). Run from anywhere: python3 agent/t1-3-repos/selfcheck.py [--fast] [--snapshot]

Sections: preflight, own tests + integration tests (Vitest), the checks (checks.mjs), lint (ESLint + tsc), scope
(only the module and its test files changed since the snapshot), scratch-service leftovers.
Last line is `SELFCHECK: DONE` only when a FULL run found nothing wrong. `--fast` skips the slow, service-backed tests and
tsc and can only end with `SELFCHECK: FAST OK`. `--snapshot` (orchestrator, before the coder starts) records the dirty
files already present (installed dependencies, lockfile) so the scope check ignores them, and records HEAD.
stdlib only. Never touches anything but scratch services (guards below).
"""
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
TASK = "T1.3"
MODULE_DIRS = ["packages/shared/src/repositories"]          # T1.1 D3b puts sources under src/
ENTRY_FILES = ["packages/shared/src/repositories/index.ts"]          # each must exist before anything else runs
REQUIRED_TESTS = ["packages/shared/src/repositories/tenancy.test.ts", "packages/shared/src/repositories/tenancy.cases.ts",
                  "packages/shared/src/repositories/schema-assumptions.test.ts"]    # test files that must exist (gate tests)
SLOW_TEST_GLOBS = ["**/tenancy.test.ts", "**/*.int.test.ts"]       # skipped by --fast
EXTRA_ALLOWED = []      # non-module paths this task may also create (prefixes)
DECISION_IDS = [f"D{i}" for i in range(17)]
MIN_TESTS = 17              # at least one test per decision id
TSC_PROJECT = "packages/shared/tsconfig.json"
BASELINE = HERE / ".baseline.json"

FAST = "--fast" in sys.argv
failures: list[str] = []


def section(name: str) -> None:
    print(f"\n== {name}", flush=True)


def fail(msg: str) -> None:
    failures.append(msg)
    print(f"FAIL {msg}", flush=True)


def run(cmd: list[str], timeout: int, env_extra: dict | None = None) -> tuple[int, str]:
    env = {**os.environ, **(env_extra or {})}
    try:
        p = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except subprocess.TimeoutExpired as e:
        return 124, f"timeout after {timeout}s: {' '.join(cmd)}\n{(e.stdout or b'')[-2000:]!r}"
    except FileNotFoundError as e:
        return 127, f"command not found: {e}"


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True).stdout


def dirty() -> dict[str, str]:
    """path -> sha1 of content ('' for a deleted file) for every changed or untracked file."""
    out = {}
    for line in git("status", "--porcelain", "--untracked-files=all").splitlines():
        path = line[3:].split(" -> ")[-1].strip('"')
        f = ROOT / path
        out[path] = hashlib.sha1(f.read_bytes()).hexdigest() if f.is_file() else ""
    return out


if "--snapshot" in sys.argv:
    BASELINE.write_text(json.dumps({"head": git("rev-parse", "HEAD").strip(), "dirty": dirty()}, indent=1))
    print(f"snapshot written: {BASELINE}")
    sys.exit(0)


def _pg_url() -> str | None:
    url = os.environ.get("CTC_SCRATCH_PG_URL", "")
    return url if re.match(r"^postgres(?:ql)?://[^@]*@127\.0\.0\.1:18304/", url) else None


PG_URL = _pg_url()  # only the scratch Postgres (ctc-dev-pg); never Supabase
ENV_FOR_CHILDREN = {"CTC_TEST_DATABASE_URL": PG_URL or "", "CTC_SCRATCH_PG_URL": PG_URL or ""}



def preflight() -> bool:
    section("preflight")
    ok = True
    for rel in ENTRY_FILES:
        if not (ROOT / rel).is_file():
            fail(f"module not built: {rel} is missing")
            ok = False
    if not shutil.which("pnpm"):
        fail("pnpm not on PATH")
        ok = False
    if not PG_URL:
        fail("env CTC_SCRATCH_PG_URL missing or not postgres://...@127.0.0.1:18304/<db> (scratch container ctc-dev-pg only)")
        ok = False
    return ok


def tests() -> None:
    section("own tests + integration tests (vitest)")
    for rel in REQUIRED_TESTS:
        if not (ROOT / rel).is_file():
            fail(f"required test file missing: {rel}")
    cmd = ["pnpm", "exec", "vitest", "run", *MODULE_DIRS, "--reporter=dot"]
    if FAST:
        for g in SLOW_TEST_GLOBS:
            cmd += ["--exclude", g]
    rc, out = run(cmd, 900, ENV_FOR_CHILDREN)
    print(out[-3000:])
    m = re.search(r"Tests\s+(?:\d+ failed \| )?(\d+) passed", out)
    n = int(m.group(1)) if m else 0
    if rc != 0:
        fail(f"vitest exited {rc}")
    elif n < (MIN_TESTS if not FAST else 1):
        fail(f"only {n} tests passed, expected at least {MIN_TESTS}: every decision id needs a test")


def checks() -> None:
    section("checks.mjs")
    node = ["node"]
    if (ROOT / "node_modules" / "tsx").exists():
        node += ["--import", "tsx"]
    rc, out = run([*node, str(HERE / "checks.mjs")], 600, ENV_FOR_CHILDREN)
    print(out[-4000:])
    passed = set(re.findall(r"^PASS (D\d+)\b", out, re.M))
    failed = re.findall(r"^FAIL (D\d+)\b", out, re.M)
    if failed:
        fail(f"checks failed: {sorted(set(failed))}")
    missing = [d for d in DECISION_IDS if d not in passed]
    if missing and not failed:
        fail(f"checks did not PASS: {missing} (exit {rc})")


def lint() -> None:
    section("lint (repo config)")
    rc, out = run(["pnpm", "exec", "eslint", *MODULE_DIRS], 600)
    print(out[-2000:])
    if rc != 0:
        fail(f"eslint exited {rc}")
    if FAST:
        print("tsc skipped (--fast)")
        return
    if TSC_PROJECT and (ROOT / TSC_PROJECT).is_file():
        rc, out = run(["pnpm", "exec", "tsc", "--noEmit", "-p", TSC_PROJECT], 600)
        print(out[-2000:])
        if rc != 0:
            fail(f"tsc --noEmit exited {rc}")
    else:
        fail(f"no tsconfig at {TSC_PROJECT}: cannot typecheck (T1.1 provides it)")


def scope() -> None:
    section("scope (module and its tests only)")
    base = json.loads(BASELINE.read_text()) if BASELINE.exists() else {"head": None, "dirty": {}}
    if not BASELINE.exists():
        print("note: no .baseline.json; every dirty file outside the allowed paths counts (orchestrator: run --snapshot first)")
    head = git("rev-parse", "HEAD").strip()
    if base["head"] and head != base["head"]:
        fail(f"HEAD moved ({base['head'][:8]} -> {head[:8]}): the coder must not commit")
    allowed = [p.rstrip("/") + "/" for p in MODULE_DIRS + EXTRA_ALLOWED] + ["agent/"]
    bad = []
    for path, h in dirty().items():
        if path.startswith(tuple(allowed)) or base["dirty"].get(path) == h:
            continue
        bad.append(path)
    if bad:
        fail(f"{len(bad)} file(s) changed outside the module: {bad[:12]}{' ...' if len(bad) > 12 else ''}")
    changed_agent = [p for p, h in dirty().items() if p.startswith(f"agent/{HERE.name}/") and base["dirty"].get(p) != h
                     and not p.endswith(".baseline.json")]
    if base["dirty"] and changed_agent:
        fail(f"agent/{HERE.name}/ was edited after the snapshot: {changed_agent}")


def leftovers() -> None:
    section("scratch leftovers")
    if not PG_URL or not shutil.which("psql"):
        print("skipped (no scratch URL or no psql)")
        return
    rc, out = run(["psql", PG_URL, "-Atc", "select nspname from pg_namespace where nspname like 'ctc\\_t13\\_%'"], 30)
    left = [s for s in out.split() if s.startswith("ctc_t13_")]
    for s in left:
        run(["psql", PG_URL, "-Atc", f'drop schema if exists "{s}" cascade'], 60)
    if left:
        fail(f"scratch schemas leaked (dropped now): {left}")



def main() -> None:
    print(f"selfcheck {TASK}{' --fast' if FAST else ''}")
    if preflight():
        tests(); checks(); lint(); scope(); leftovers()
    else:
        scope()
    if failures:
        print(f"\n{len(failures)} problem(s):")
        for f in failures:
            print(f"  - {f}")
        print("SELFCHECK: FAIL")
        sys.exit(1)
    if FAST:
        print("\nSELFCHECK: FAST OK (not done: run without --fast)")
        sys.exit(0)
    print("\nSELFCHECK: DONE")


main()
