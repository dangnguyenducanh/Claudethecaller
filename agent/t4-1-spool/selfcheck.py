#!/usr/bin/env python3
"""Self-check for T4.1 (hooks/spool, apps/web/src/spool, packages/shared/src/spool). Run from anywhere:
    python3 agent/t4-1-spool/selfcheck.py [--fast] [--snapshot]

Sections: preflight, contract hashes, shell (sh -n, dash -n, exec bit, shellcheck if installed), own tests (Vitest),
the gate test `memory.spool`, the checks (checks.mjs), lint (ESLint on the module), project suites (pnpm -r lint,
typecheck, test; pytest when Python files changed), scope (only the module paths and their tests changed since the
snapshot), scratch leftovers (Postgres schemas `ctc_t41_*`, Redis keys `t41*`, tmp dirs `ctc-t41-*`, the real spool dir).
Last line is `SELFCHECK: DONE` only when a FULL run found nothing wrong. `--fast` skips the service-backed tests, the gate
test and the project suites and can only end with `SELFCHECK: FAST OK`. `--snapshot` (orchestrator, before the coder
starts) records the dirty files already present so the scope check ignores them, and records HEAD.
Env (defaults = the scratch services; anything else is refused): CTC_SCRATCH_PG_URL (127.0.0.1:18304),
CTC_SCRATCH_REDIS_URL (127.0.0.1:18395). stdlib only.
"""
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
TASK = "T4.1"
MODULE_DIRS = ["apps/web/src/spool", "packages/shared/src/spool"]
MODULE_FILES = ["hooks/spool"]
ENTRY_FILES = ["hooks/spool", "apps/web/src/spool/index.ts", "packages/shared/src/spool/index.ts"]
GATE_TEST = "apps/web/src/spool/memory.spool.int.test.ts"
REQUIRED_TESTS = [GATE_TEST]
SLOW_TEST_GLOBS = ["**/*.int.test.ts"]          # skipped by --fast
IGNORED = ["agent/", "specs/", ".claude/agents/", ".ctc-dev/"]
DECISION_IDS = [f"D{i}" for i in range(16)]
MIN_TESTS = 16                                   # at least one test per decision id
BASELINE = HERE / ".baseline.json"
CONTRACT = HERE / ".contract.sha256"
REAL_SPOOL = Path.home() / ".claudethecaller" / "spool"

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
        p = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True, timeout=timeout, check=False)
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except subprocess.TimeoutExpired as e:
        return 124, f"timeout after {timeout}s: {' '.join(cmd)}\n{(e.stdout or b'')[-2000:]!r}"
    except FileNotFoundError as e:
        return 127, f"command not found: {e}"


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=False).stdout


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


def _guard(env: str, default: str, host_port: str) -> str | None:
    url = os.environ.get(env) or default
    m = re.match(r"^[a-z]+://(?:[^@/]*@)?([^/:]+):(\d+)(?:/|$)", url)
    return url if m and f"{m.group(1)}:{m.group(2)}" == host_port else None


PG_URL = _guard("CTC_SCRATCH_PG_URL", "postgresql://postgres:ctcdev@127.0.0.1:18304/postgres", "127.0.0.1:18304")
REDIS_URL = _guard("CTC_SCRATCH_REDIS_URL", "redis://127.0.0.1:18395", "127.0.0.1:18395")
ENV_FOR_CHILDREN = {"CTC_SCRATCH_PG_URL": PG_URL or "", "CTC_TEST_DATABASE_URL": PG_URL or "",
                    "CTC_TEST_ADMIN_URL": PG_URL or "", "CTC_SCRATCH_REDIS_URL": REDIS_URL or ""}


def resp(*parts: str) -> object:
    """One RESP command to the scratch Redis (stdlib only)."""
    with socket.create_connection(("127.0.0.1", 18395), timeout=3) as s:
        s.sendall(f"*{len(parts)}\r\n".encode() + b"".join(f"${len(p.encode())}\r\n{p}\r\n".encode() for p in parts))
        f = s.makefile("rb")

        def read() -> object:
            line = f.readline().rstrip(b"\r\n")
            t, rest = line[:1], line[1:].decode()
            if t in (b"+", b"-"):
                if t == b"-":
                    raise ValueError(rest)
                return rest
            if t == b":":
                return int(rest)
            if t == b"$":
                n = int(rest)
                if n < 0:
                    return None
                data = f.read(n + 2)[:-2]
                return data.decode()
            if t == b"*":
                return [read() for _ in range(int(rest))]
            raise ValueError(f"bad reply {line!r}")
        return read()


def spool_listing() -> list[str]:
    return sorted(p.name for p in REAL_SPOOL.iterdir()) if REAL_SPOOL.is_dir() else []


REAL_SPOOL_BEFORE = spool_listing()


def preflight() -> bool:
    section("preflight")
    ok = True
    for rel in ENTRY_FILES:
        if not (ROOT / rel).is_file():
            fail(f"module not built: {rel} is missing")
            ok = False
    for tool in ("pnpm", "node", "dash", "curl", "mkfifo"):
        if not shutil.which(tool):
            fail(f"{tool} not on PATH")
            ok = False
    if not PG_URL:
        fail("CTC_SCRATCH_PG_URL is not postgres://...@127.0.0.1:18304/<db> (scratch container ctc-dev-pg only)")
        ok = False
    elif shutil.which("psql"):
        rc, out = run(["psql", PG_URL, "-Atc", "select 1"], 15)
        if rc != 0:
            fail(f"scratch Postgres not reachable on 127.0.0.1:18304: {out.strip()[:200]}")
            ok = False
    if not REDIS_URL:
        fail("CTC_SCRATCH_REDIS_URL is not redis://127.0.0.1:18395 (scratch Redis only)")
        ok = False
    else:
        try:
            if resp("PING") != "PONG":
                raise OSError("no PONG")
        except (OSError, ValueError) as e:
            fail(f"scratch Redis not reachable on 127.0.0.1:18395 ({e})")
            ok = False
    return ok


def contract() -> None:
    section("contract hashes")
    if not CONTRACT.is_file():
        print("no .contract.sha256 (planner has not frozen the contract)")
        return
    for line in CONTRACT.read_text().splitlines():
        if not line.strip():
            continue
        want, name = line.split(maxsplit=1)
        name = name.lstrip("*")
        f = HERE / name
        got = hashlib.sha256(f.read_bytes()).hexdigest() if f.is_file() else "missing"
        if got != want:
            fail(f"contract file changed: agent/{HERE.name}/{name}")
    print("checked")


def shell() -> None:
    section("shell (hooks/spool)")
    script = ROOT / "hooks/spool"
    if not script.is_file():
        fail("hooks/spool missing")
        return
    if not os.access(script, os.X_OK):
        fail("hooks/spool is not executable (chmod 755)")
    if script.read_text(errors="replace").split("\n", 1)[0] != "#!/bin/sh":
        fail("hooks/spool first line must be #!/bin/sh")
    for sh in ("sh", "dash"):
        rc, out = run([sh, "-n", str(script)], 10)
        if rc != 0:
            fail(f"{sh} -n hooks/spool: {out.strip()[:300]}")
    if shutil.which("shellcheck"):
        rc, out = run(["shellcheck", "-s", "sh", str(script)], 30)
        print(out[-2000:])
        if rc != 0:
            fail("shellcheck -s sh hooks/spool reported problems")
    else:
        print("shellcheck not installed: skipped")


def vitest_passed(out: str) -> int:
    m = re.search(r"Tests\s+(?:\d+ failed \| )?(\d+) passed", out)
    return int(m.group(1)) if m else 0


def tests() -> None:
    section("own tests (vitest)")
    for rel in REQUIRED_TESTS:
        if not (ROOT / rel).is_file():
            fail(f"required test file missing: {rel}")
    cmd = ["pnpm", "exec", "vitest", "run", *MODULE_DIRS, "--reporter=dot"]
    if FAST:
        for g in SLOW_TEST_GLOBS:
            cmd += ["--exclude", g]
    rc, out = run(cmd, 600, ENV_FOR_CHILDREN)
    print(out[-3000:])
    n = vitest_passed(out)
    if rc != 0:
        fail(f"vitest exited {rc}")
    elif n < (MIN_TESTS if not FAST else 1):
        fail(f"only {n} tests passed, expected at least {MIN_TESTS}: every decision id needs a test")


def gate() -> None:
    section("gate test memory.spool")
    if FAST:
        print("skipped (--fast)")
        return
    rc, out = run(["pnpm", "exec", "vitest", "run", GATE_TEST, "-t", "memory.spool", "--reporter=verbose"], 300, ENV_FOR_CHILDREN)
    print(out[-3000:])
    if rc != 0 or vitest_passed(out) < 1:
        fail(f"gate test memory.spool did not pass (exit {rc})")


def checks() -> None:
    section("checks.mjs")
    node = ["node"]
    if (ROOT / "node_modules" / "tsx").exists():
        node += ["--import", "tsx"]
    rc, out = run([*node, str(HERE / "checks.mjs")], 600, ENV_FOR_CHILDREN)
    print(out[-5000:])
    passed = set(re.findall(r"^PASS (D\d+)\b", out, re.MULTILINE))
    failed = re.findall(r"^FAIL (D\d+)\b", out, re.MULTILINE)
    if failed:
        fail(f"checks failed: {sorted(set(failed), key=lambda d: int(d[1:]))}")
    missing = [d for d in DECISION_IDS if d not in passed]
    if missing and not failed:
        fail(f"checks did not PASS: {missing} (exit {rc})")


def lint() -> None:
    section("lint (module, repo config)")
    rc, out = run(["pnpm", "exec", "eslint", "--max-warnings", "0", *MODULE_DIRS], 600)
    print(out[-2000:])
    if rc != 0:
        fail(f"eslint exited {rc}")


# Red on the base branch before T4.1: T1.2's migrations lack projects.graph_epoch/mem_epoch (T1.3 D10; see repositories/scratch.ts).
KNOWN_RED = {"packages/shared/src/repositories/schema-assumptions.test.ts": "every column the repositories use exists"}


def known_red_only(out: str) -> bool:
    """True when the only failed tests of a `pnpm -r test` run are KNOWN_RED tests whose files are unchanged since HEAD."""
    failed = set(re.findall(r"FAIL\s+(\S+\.test\.ts)\s+>.*>\s+(.+?)\s*$", out, re.M))
    total = sum(int(n) for n in re.findall(r"Tests\s+(\d+) failed", out))
    file_level = re.search(r"FAIL\s+\S+\.test\.ts\s*(\[.*\])?\s*$", out, re.M)
    if not failed or file_level or total != len(failed) or git("status", "--porcelain", "--", *KNOWN_RED).strip():
        return False
    return all(any(k.endswith(f) and n == name for k, n in KNOWN_RED.items()) for f, name in failed)


def suites() -> None:
    section("project suites (pnpm -r lint, typecheck, test; pytest if Python changed)")
    if FAST:
        print("skipped (--fast)")
        return
    for name, cmd, t in (("lint", ["pnpm", "-r", "lint"], 900), ("typecheck", ["pnpm", "-r", "typecheck"], 900),
                         ("test", ["pnpm", "-r", "--no-bail", "test"], 1800)):
        rc, out = run(cmd, t, ENV_FOR_CHILDREN)
        print(f"-- pnpm -r {name}: exit {rc}")
        if rc != 0 and name == "test" and known_red_only(out):
            print(f"note: only the known pre-existing red tests failed ({list(KNOWN_RED)}, unchanged since HEAD): not counted")
            continue
        if rc != 0:
            print(out[-3000:])
            fail(f"pnpm -r {name} exited {rc}")
    py = [p for p in dirty() if p.endswith(".py") and not p.startswith(tuple(IGNORED))]
    if py:
        rc, out = run(["uv", "run", "pytest", "-q", "tests"], 1800)
        print(out[-2000:])
        if rc != 0:
            fail(f"pytest exited {rc} (Python files changed: {py[:5]})")
    else:
        print("no Python file changed: pytest skipped")


def scope() -> None:
    section("scope (module paths and their tests only)")
    base = json.loads(BASELINE.read_text()) if BASELINE.exists() else {"head": None, "dirty": {}}
    if not BASELINE.exists():
        print("note: no .baseline.json; every dirty file outside the allowed paths counts (orchestrator: run --snapshot first)")
    head = git("rev-parse", "HEAD").strip()
    if base["head"] and head != base["head"]:
        fail(f"HEAD moved ({base['head'][:8]} -> {head[:8]}): the coder must not commit")
    allowed_dirs = tuple(p.rstrip("/") + "/" for p in MODULE_DIRS)
    bad = []
    for path, h in dirty().items():
        if path.startswith(allowed_dirs) or path in MODULE_FILES or path.startswith(tuple(IGNORED)):
            continue
        if base["dirty"].get(path) == h:
            continue
        bad.append(path)
    if bad:
        fail(f"{len(bad)} file(s) changed outside the module: {bad[:12]}{' ...' if len(bad) > 12 else ''}")
    changed_agent = [p for p, h in dirty().items() if p.startswith(f"agent/{HERE.name}/") and base["dirty"].get(p) != h
                     and not p.endswith((".baseline.json", ".contract.sha256"))]
    if base["dirty"] and changed_agent:
        fail(f"agent/{HERE.name}/ was edited after the snapshot: {changed_agent}")


def leftovers() -> None:
    section("scratch leftovers")
    if PG_URL and shutil.which("psql"):
        _rc, out = run(["psql", PG_URL, "-Atc", "select nspname from pg_namespace where nspname like 'ctc\\_t41\\_%'"], 30)
        left = [s for s in out.split() if s.startswith("ctc_t41_")]
        for s in left:
            run(["psql", PG_URL, "-Atc", f'drop schema if exists "{s}" cascade'], 60)
        if left:
            fail(f"scratch schemas leaked (dropped now): {left}")
    else:
        print("postgres: skipped (no scratch URL or no psql)")
    if REDIS_URL:
        try:
            cursor, found = "0", []
            while True:
                cursor, keys = resp("SCAN", cursor, "MATCH", "t41*", "COUNT", "1000")
                found += keys
                if cursor == "0":
                    break
            if found:
                for i in range(0, len(found), 500):
                    resp("DEL", *found[i:i + 500])
                fail(f"{len(found)} key(s) leaked in the scratch Redis (deleted now), first: {found[:3]}")
        except (OSError, ValueError) as e:
            print(f"redis: skipped ({e})")
    tmp = [p for p in Path(tempfile.gettempdir()).glob("ctc-t41-*")]
    if tmp:
        for p in tmp:
            shutil.rmtree(p, ignore_errors=True)
        fail(f"{len(tmp)} tmp dir(s) ctc-t41-* leaked (removed now)")
    if spool_listing() != REAL_SPOOL_BEFORE:
        fail(f"{REAL_SPOOL} changed during the run: tests must use their own CTC_SPOOL_DIR")


def main() -> None:
    print(f"selfcheck {TASK}{' --fast' if FAST else ''}")
    contract()
    if preflight():
        shell(); tests(); gate(); checks(); lint(); suites(); scope(); leftovers()
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
