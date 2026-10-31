#!/usr/bin/env python3
"""Self-check for T2.1 (packages/core/src/graph: ids, web-tree-sitter extract, markdown).
Run from anywhere: python3 agent/t2-1-extract/selfcheck.py [--fast] [--snapshot]

Sections: contract files intact, preflight, own tests incl. the gate `graph.ids` (Vitest), the checks (checks.mjs), the
project suites (pnpm -r lint / typecheck / test; uv run pytest -q tests only when a .py file changed), scope (only the
module, new test files and the D22 dependency lines changed vs HEAD).
Last line is `SELFCHECK: DONE` only when a FULL run found nothing wrong. `--fast` runs the module's own tests, the checks,
the core lint and the scope, and can only end with `SELFCHECK: FAST OK`. `--snapshot` (orchestrator, before the coder
starts) records HEAD and the files already dirty so the scope check ignores them.
stdlib only. Uses only the scratch Postgres 127.0.0.1:18304 and the scratch Redis 127.0.0.1:18395 (guards below).
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
TASK = "T2.1"
MODULE_DIRS = ["packages/core/src/graph"]                          # T1.1 D3b puts sources under src/
ENTRY_FILES = ["packages/core/src/graph/index.ts"]                 # must exist before anything else runs
REQUIRED_TESTS = ["packages/core/src/graph/graph.ids.test.ts"]     # the spec §7 gate (DECISIONS D21)
GATE = "graph.ids"
GATE_MIN = 21                                                      # 20 fixture files + the make_id vectors
EXTRA_ALLOWED_FILES = ["packages/core/package.json", "pnpm-lock.yaml"]   # D22: dependency lines only (checks D22)
IGNORED_PREFIXES = ("agent/", "specs/", ".claude/agents/", ".ctc-dev/", "node_modules/")
DECISION_IDS = [f"D{i}" for i in range(23)]
MIN_TESTS = 23 + GATE_MIN       # at least one test per decision id, plus the gate cases
GOLDEN_MANIFEST_SHA256 = "7e99ee1da63bcbfe6a838551c109e0f1f14cde5e3570bc8ef2bdbf982e41b75a"
# Fails on HEAD before T2.1 (T1.3 schema-assumptions: projects.graph_epoch/mem_epoch not in the T1.2 migrations); not counted.
KNOWN_BASE_FAILURES = {"src/repositories/schema-assumptions.test.ts > schema assumptions (D10) > every column the repositories use exists"}
BASELINE = HERE / ".baseline.json"
SCRATCH_ENV = {
    "CTC_SCRATCH_PG_URL": "postgresql://postgres:ctcdev@127.0.0.1:18304/postgres",
    "CTC_TEST_ADMIN_URL": "postgresql://postgres:ctcdev@127.0.0.1:18304/postgres",
    "CTC_SCRATCH_REDIS_URL": "redis://127.0.0.1:18395",
}
SCRATCH_RE = {"CTC_SCRATCH_PG_URL": r"^postgres(?:ql)?://[^@]*@127\.0\.0\.1:18304/", "CTC_TEST_ADMIN_URL": r"^postgres(?:ql)?://[^@]*@127\.0\.0\.1:18304/",
              "CTC_SCRATCH_REDIS_URL": r"^redis://127\.0\.0\.1:18395(/\d+)?$"}

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
        out = e.stdout.decode(errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
        return 124, f"timeout after {timeout}s: {' '.join(cmd)}\n{out[-2000:]}"
    except FileNotFoundError as e:
        return 127, f"command not found: {e}"


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True).stdout


def dirty() -> dict[str, str]:
    """path -> sha1 of content ('' for a deleted file) for every changed or untracked file vs HEAD."""
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


def scratch_env() -> dict:
    env = {}
    for k, default in SCRATCH_ENV.items():
        v = os.environ.get(k) or default
        if not re.match(SCRATCH_RE[k], v):
            fail(f"env {k} is not a scratch service URL (only 127.0.0.1:18304 Postgres / 127.0.0.1:18395 Redis); refusing to run project tests")
            return {}
        env[k] = v
    return env


def contract_intact() -> None:
    section("contract files")
    manifest = HERE / ".contract.sha256"
    if not manifest.exists():
        print("NOTE no .contract.sha256: the orchestrator writes one before the coder starts")
    else:
        bad = []
        for line in manifest.read_text().splitlines():
            if not line.strip():
                continue
            digest, name = line.split(maxsplit=1)
            f = HERE / name.strip().lstrip("*")
            if not f.exists() or hashlib.sha256(f.read_bytes()).hexdigest() != digest:
                bad.append(name.strip())
        if bad:
            fail(f"contract files changed: {bad}")
        else:
            print("contract files unchanged")
    m = HERE / "golden" / "MANIFEST.sha256"
    if not m.exists() or hashlib.sha256(m.read_bytes()).hexdigest() != GOLDEN_MANIFEST_SHA256:
        fail("golden/MANIFEST.sha256 changed or missing (the golden graphify output is read only)")


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
    if not (ROOT / "packages/core/node_modules/web-tree-sitter").exists():
        fail("web-tree-sitter not installed in packages/core (SPEC.md step 4: pnpm --filter @ctc/core add --save-exact ...)")
        ok = False
    return ok


def own_tests() -> None:
    section("own tests + gate graph.ids (vitest, packages/core/src/graph)")
    for rel in REQUIRED_TESTS:
        if not (ROOT / rel).is_file():
            fail(f"required test file missing: {rel}")
    rc, out = run(["pnpm", "--filter", "@ctc/core", "exec", "vitest", "run", "src/graph", "--reporter=verbose"], 600)
    print(out[-4000:])
    m = re.search(r"Tests\s+(?:\d+ failed \| )?(\d+) passed", out)
    n = int(m.group(1)) if m else 0
    gate = len(re.findall(rf"✓ .*graph\.ids\.test\.ts > {re.escape(GATE)} > ", out))
    if rc != 0:
        fail(f"vitest exited {rc}")
    elif n < MIN_TESTS:
        fail(f"only {n} tests passed, expected at least {MIN_TESTS}: every decision id needs a test, plus the gate cases")
    if gate < GATE_MIN:
        fail(f"gate `{GATE}`: {gate} passing cases in graph.ids.test.ts, expected at least {GATE_MIN} (20 fixture files + make_id)")


def checks() -> None:
    section("checks.mjs")
    rc, out = run(["node", str(HERE / "checks.mjs")], 900)
    print(out[-5000:])
    passed = set(re.findall(r"^PASS (D\d+)\b", out, re.M))
    failed = sorted(set(re.findall(r"^FAIL (D\d+)\b", out, re.M)), key=lambda d: int(d[1:]))
    if failed:
        fail(f"checks failed: {failed}")
    missing = [d for d in DECISION_IDS if d not in passed and d not in failed]
    if missing:
        fail(f"checks did not PASS: {missing} (exit {rc})")


def project_suites(env: dict) -> None:
    section("project suites")
    if FAST:
        rc, out = run(["pnpm", "--filter", "@ctc/core", "lint"], 600)
        print(out[-2000:])
        if rc != 0:
            fail(f"pnpm --filter @ctc/core lint exited {rc}")
        print("pnpm -r typecheck / test and pytest skipped (--fast)")
        return
    for name, cmd in (("lint", ["pnpm", "-r", "lint"]), ("typecheck", ["pnpm", "-r", "typecheck"])):
        rc, out = run(cmd, 900)
        print(out[-2000:])
        if rc != 0:
            fail(f"pnpm -r {name} exited {rc}")
    if not env:
        fail("project tests not run: no scratch env")
        return
    rc, out = run(["pnpm", "-r", "--no-bail", "test"], 1800, env)
    print(out[-3000:])
    failing = {f"{a} > {b.strip()}" for a, b in re.findall(r"FAIL\s+(\S+\.test\.ts) > (.+?)\s*$", out, re.M)}
    broken_files = re.findall(r"FAIL\s+(\S+\.test\.ts) \[", out)
    unknown = sorted(failing - KNOWN_BASE_FAILURES)
    if broken_files:
        fail(f"test files failed to load: {sorted(set(broken_files))}")
    if unknown:
        fail(f"pnpm -r test: {len(unknown)} new failing test(s): {unknown[:8]}")
    elif rc != 0 and not failing:
        fail(f"pnpm -r test exited {rc} with no parsable failing test")
    known_seen = sorted(failing & KNOWN_BASE_FAILURES)
    if known_seen:
        print(f"NOTE pre-existing failure(s) on HEAD, not counted: {known_seen}")
    changed_py = [p for p in dirty() if p.endswith(".py") and not p.startswith(IGNORED_PREFIXES)]
    if changed_py:
        rc, out = run(["uv", "run", "pytest", "-q", "tests"], 1800)
        print(out[-2000:])
        if rc != 0:
            fail(f"uv run pytest -q tests exited {rc}")
    else:
        print("pytest skipped: no .py file changed")


def scope() -> None:
    section("scope (module, its tests, D22 dependency lines)")
    base = json.loads(BASELINE.read_text()) if BASELINE.exists() else {"head": None, "dirty": {}}
    head = git("rev-parse", "HEAD").strip()
    if base["head"] and head != base["head"]:
        fail(f"HEAD moved ({base['head'][:8]} -> {head[:8]}): the coder must not commit")
    allowed = tuple(p.rstrip("/") + "/" for p in MODULE_DIRS)
    bad = []
    for path, h in dirty().items():
        if path.startswith(allowed) or path in EXTRA_ALLOWED_FILES or path.startswith(IGNORED_PREFIXES) or base["dirty"].get(path) == h:
            continue
        bad.append(path)
    if bad:
        fail(f"{len(bad)} file(s) changed outside the allowed paths: {bad[:12]}{' ...' if len(bad) > 12 else ''}")
    else:
        print("scope ok")


def main() -> None:
    print(f"selfcheck {TASK}{' --fast' if FAST else ''}")
    contract_intact()
    env = scratch_env()
    if preflight():
        own_tests(); checks(); project_suites(env); scope()
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
