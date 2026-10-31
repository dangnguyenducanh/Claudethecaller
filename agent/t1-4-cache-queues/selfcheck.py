#!/usr/bin/env python3
"""Self-check for T1.4 (cache, epochs, ctc:inval, queues, dlq-retry, systemd units). Run from anywhere: python3 agent/t1-4-cache-queues/selfcheck.py [--fast] [--snapshot]

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
TASK = "T1.4"
MODULE_DIRS = ["packages/shared/cache", "packages/shared/queues", "apps/worker/jobs", "deploy/systemd"]          # change here if T1.1 puts sources under src/
ENTRY_FILES = ["packages/shared/cache/index.ts", "packages/shared/queues/index.ts", "apps/worker/jobs/index.ts"]          # each must exist before anything else runs
REQUIRED_TESTS = []    # test files that must exist (gate tests)
SLOW_TEST_GLOBS = ["**/*.int.test.ts"]       # skipped by --fast
EXTRA_ALLOWED = []      # non-module paths this task may also create (prefixes)
DECISION_IDS = [f"D{i}" for i in range(24)]
MIN_TESTS = 24              # at least one test per decision id
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


def _redis_url() -> str | None:
    url = os.environ.get("CTC_SCRATCH_REDIS_URL", "")
    return url if re.match(r"^redis://127\.0\.0\.1:18395(/\d+)?$", url) else None


REDIS_URL = _redis_url()  # only the scratch Redis on :18395; never the host's other Redis instances
ENV_FOR_CHILDREN = {"CTC_SCRATCH_REDIS_URL": REDIS_URL or ""}


def resp(*parts: str) -> object:
    """Minimal RESP2 round trip to the scratch Redis (no redis-cli on this host)."""
    s = socket.create_connection(("127.0.0.1", 18395), timeout=3)
    try:
        s.sendall(f"*{len(parts)}\r\n".encode() + b"".join(f"${len(p.encode())}\r\n{p}\r\n".encode() for p in parts))
        f = s.makefile("rb")

        def read() -> object:
            line = f.readline().rstrip(b"\r\n")
            t, rest = line[:1], line[1:]
            if t in (b"+", b"-"):
                return rest.decode()
            if t == b":":
                return int(rest)
            if t == b"$":
                n = int(rest)
                return None if n < 0 else f.read(n + 2)[:-2].decode()
            if t == b"*":
                return [read() for _ in range(int(rest))]
            raise ValueError(line)

        return read()
    finally:
        s.close()

UNIT_FILES = ["deploy/systemd/ctc-web.service", "deploy/systemd/ctc-worker.service"]



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
    if not REDIS_URL:
        fail("env CTC_SCRATCH_REDIS_URL missing or not redis://127.0.0.1:18395 (scratch Redis only)")
        ok = False
    else:
        try:
            if resp("PING") != "PONG":
                raise OSError("no PONG")
        except OSError as e:
            fail(f"scratch Redis not reachable on 127.0.0.1:18395 ({e}); orchestrator: docker run -d --name ctc-scratch-redis -p 127.0.0.1:18395:6379 redis:8.2")
            ok = False
    for rel in UNIT_FILES:
        if not (ROOT / rel).is_file():
            fail(f"unit file missing: {rel}")
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
    section("scratch leftovers (keys of the t14chk namespaces)")
    if not REDIS_URL:
        print("skipped (no scratch Redis)")
        return
    try:
        cursor, found = "0", []
        while True:
            cursor, keys = resp("SCAN", cursor, "MATCH", "t14chk*", "COUNT", "1000")
            found += keys
            if cursor == "0":
                break
        if found:
            resp("DEL", *found)
            fail(f"{len(found)} key(s) leaked in the scratch Redis (deleted now), first: {found[:3]}")
    except (OSError, ValueError) as e:
        print(f"skipped: {e}")



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
