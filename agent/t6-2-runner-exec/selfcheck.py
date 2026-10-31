#!/usr/bin/env python3
"""Self-check for T6.2 (runner cold path: worktree recipe, setup hook, agent registry, stream, report token, restart sweep). Run from anywhere: python3 agent/t6-2-runner-exec/selfcheck.py [--fast] [--snapshot]

Sections: contract hashes, preflight, own tests + integration tests (Vitest), the gate test names, the checks (checks.mjs),
lint (ESLint + tsc), project suites (pnpm -r lint/typecheck/test; pytest only when Python files changed), scope (only the
allowed paths changed since the snapshot, T6.1 files under the module dirs untouched except `index.ts` export-from lines; files hidden by
.gitignore under the allowed paths are listed and fail, since a merge would drop them), scratch-schema and process leftovers.
Last line is `SELFCHECK: DONE` only when a FULL run found nothing wrong. `--fast` skips the Postgres-backed tests, tsc and the
project suites and can only end with `SELFCHECK: FAST OK`. `--snapshot` (orchestrator, before the coder starts) records the dirty
files already present (installed dependencies, lockfile) so the scope check ignores them, and records HEAD.
stdlib only. Never touches anything but the scratch Postgres (guards below); never reads ~/.claude.
"""
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
TASK = "T6.2"
MODULE_DIRS = ["packages/core/src/runner", "apps/worker/src/runner"]                  # whole directories the coder owns
ENTRY_FILES = ["apps/worker/src/runner/index.ts", "packages/core/src/runner/index.ts"]   # each must exist before anything else runs
CORE_INDEX = "packages/core/src/runner/index.ts"                                      # T6.1 file: only added `export ... from` lines allowed
EXTRA_FILES: list[str] = []                                                           # SPEC.md allows no file outside the module dirs
NEW_TEST_DIRS: list[str] = []                                                         # new *.test.ts files only inside the module dirs
IGNORED = ["agent/", "specs/", ".claude/agents/", ".ctc-dev/"]                       # never counted by the scope check
GATES = {   # file -> (describe name, test names)   DECISIONS.md D21
    "apps/worker/src/runner/runner.crash.int.test.ts": ("runner.crash", [
        "reattaches to a live agent after the worker is killed mid-step",
        "marks the step start_unknown when the agent died with the worker",
        "fails an attempt interrupted in the worktree or setup stage"]),
}
TEST_DIRS = [*MODULE_DIRS]
INTEGRATION: list[str] = []
SLOW_TEST_GLOBS = ["**/*.int.test.ts"]                                                # skipped by --fast
TSC_PROJECTS = ["apps/worker/tsconfig.json", "packages/core/tsconfig.json"]
SCHEMA_PREFIXES = ["ctc_t62_", "ctc_t62chk_"]                                        # this task's scratch schemas only
PROC_MARKER = "/ctc-t62"                                                              # temp dirs and fake agents of this task (checks.mjs: ctc-t62chk-*)
DECISION_IDS = [f"D{i}" for i in range(22)]
MIN_TESTS = 22              # at least one test per decision id
CONTRACT = HERE / ".contract.sha256"
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
        p = subprocess.Popen(cmd, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
    except FileNotFoundError as e:
        return 127, f"command not found: {e}"
    try:
        out, _ = p.communicate(timeout=timeout)
        return p.returncode, out or ""
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)   # our own new session only; never pkill -f
        except ProcessLookupError:
            pass
        out, _ = p.communicate()
        return 124, f"timeout after {timeout}s: {' '.join(cmd)}\n{(out or '')[-2000:]}"


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True).stdout


def allowed_prefixes() -> tuple[str, ...]:
    return tuple(p.rstrip("/") + "/" for p in [*MODULE_DIRS, *NEW_TEST_DIRS]) + tuple(EXTRA_FILES)


def hidden() -> list[str]:
    """Files under the allowed paths that .gitignore hides (git status --ignored): a merge would silently drop them."""
    out = []
    for line in git("status", "--porcelain", "--untracked-files=all", "--ignored").splitlines():
        if not line.startswith("!! "):
            continue
        path = line[3:].strip('"')
        if not path.startswith(allowed_prefixes()) or "/node_modules/" in f"/{path}":
            continue
        p = ROOT / path
        files = [p] if p.is_file() else [f for f in p.rglob("*") if f.is_file() and "node_modules" not in f.parts]
        out += [str(f.relative_to(ROOT)) for f in files]
    return sorted(out)


def dirty() -> dict[str, str]:
    """path -> sha1 of content ('' for a deleted file) for every changed or untracked file, plus the hidden() ones."""
    out = {}
    for line in git("status", "--porcelain", "--untracked-files=all").splitlines():
        path = line[3:].split(" -> ")[-1].strip('"')
        f = ROOT / path
        out[path] = hashlib.sha1(f.read_bytes()).hexdigest() if f.is_file() else ""
    for path in hidden():
        out[path] = hashlib.sha1((ROOT / path).read_bytes()).hexdigest()
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


def contract() -> None:
    section("contract hashes (.contract.sha256)")
    if not CONTRACT.exists():
        print("no .contract.sha256: skipped")
        return
    for line in CONTRACT.read_text().splitlines():
        m = re.match(r"^([0-9a-f]{64})\s+\*?(.+)$", line.strip())
        if not m:
            continue
        f = HERE / m.group(2)
        got = hashlib.sha256(f.read_bytes()).hexdigest() if f.is_file() else "missing"
        if got != m.group(1):
            fail(f"contract file changed: agent/{HERE.name}/{m.group(2)} ({got[:12]} != {m.group(1)[:12]})")


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
    for rel, (describe, names) in GATES.items():
        gate = ROOT / rel
        if not gate.is_file():
            fail(f"gate test file missing: {rel}")
            continue
        src = gate.read_text(encoding="utf-8")
        if not re.search(r"describe\(\s*['\"`]" + re.escape(describe) + r"['\"`]", src):
            fail(f"{rel}: no describe('{describe}')")
        for name in names:
            if not re.search(r"\b(it|test)\(\s*['\"`]" + re.escape(name) + r"['\"`]", src):
                fail(f"{rel}: gate test missing: {name!r}")
    cmd = ["pnpm", "exec", "vitest", "run", *TEST_DIRS, *([] if FAST else INTEGRATION), "--reporter=dot"]
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
    rc, out = run([*node, str(HERE / "checks.mjs")], 1500, ENV_FOR_CHILDREN)
    print(out[-4000:])
    passed = set(re.findall(r"^PASS (D\d+)\b", out, re.M))
    failed = re.findall(r"^FAIL (D\d+)\b", out, re.M)
    if failed:
        fail(f"checks failed: {sorted(set(failed), key=lambda d: int(d[1:]))}")
    elif rc != 0 and "CHECKS:" not in out:
        fail(f"checks.mjs crashed (exit {rc}) before printing its summary")
    missing = [d for d in DECISION_IDS if d not in passed]
    if missing and not failed:
        fail(f"checks did not PASS: {missing} (exit {rc})")


def lint() -> None:
    section("lint (repo config)")
    extra_ts = [p for p in EXTRA_FILES if p.endswith(".ts") and (ROOT / p).is_file()]
    rc, out = run(["pnpm", "exec", "eslint", "--max-warnings", "0", *MODULE_DIRS, *extra_ts], 600)
    print(out[-2000:])
    if rc != 0:
        fail(f"eslint exited {rc}")
    if FAST:
        print("tsc skipped (--fast)")
        return
    for proj in TSC_PROJECTS:
        if not (ROOT / proj).is_file():
            fail(f"no tsconfig at {proj}: cannot typecheck (T1.1 provides it)")
            continue
        rc, out = run(["pnpm", "exec", "tsc", "--noEmit", "-p", proj], 600)
        print(f"tsc {proj}: exit {rc}\n{out[-1500:]}")
        if rc != 0:
            fail(f"tsc --noEmit -p {proj} exited {rc}")


def changed_paths() -> list[str]:
    base = json.loads(BASELINE.read_text()) if BASELINE.exists() else {"dirty": {}}
    return [p for p, h in dirty().items() if base["dirty"].get(p) != h]


# Red on the base branch before T3.1 (still red at the T6.1 base, 7b5098f): T1.2's migrations lack projects.graph_epoch/mem_epoch (T1.3 D10; see repositories/scratch.ts).
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
    section("project suites (pnpm -r lint, typecheck, test; pytest when Python changed)")
    if FAST:
        print("skipped (--fast)")
        return
    for script in ["lint", "typecheck", "test"]:
        rc, out = run(["pnpm", "-r", *(["--no-bail"] if script == "test" else []), script], 1200, ENV_FOR_CHILDREN)
        print(f"pnpm -r {script}: exit {rc}\n{out[-1500:]}")
        if rc != 0 and script == "test" and known_red_only(out):
            print(f"note: only the known pre-existing red tests failed ({list(KNOWN_RED)}, unchanged since HEAD): not counted")
            continue
        if rc != 0:
            fail(f"pnpm -r {script} exited {rc}")
    py = [p for p in changed_paths() if p.endswith(".py") and not p.startswith(tuple(IGNORED))]
    if not py:
        print("pytest skipped (no Python file changed)")
        return
    rc, out = run(["uv", "run", "pytest", "-q", "tests"], 1200)
    print(f"uv run pytest -q tests: exit {rc}\n{out[-1500:]}")
    if rc != 0:
        fail(f"pytest exited {rc} (changed Python files: {py[:5]})")


def scope() -> None:
    section("scope (allowed paths only)")
    base = json.loads(BASELINE.read_text()) if BASELINE.exists() else {"head": None, "dirty": {}}
    if not BASELINE.exists():
        print("note: no .baseline.json; every dirty file outside the allowed paths counts (orchestrator: run --snapshot first)")
    head = git("rev-parse", "HEAD").strip()
    if base["head"] and head != base["head"]:
        fail(f"HEAD moved ({base['head'][:8]} -> {head[:8]}): the coder must not commit")
    tracked = set(git("ls-files").splitlines())
    dirs = tuple(p.rstrip("/") + "/" for p in MODULE_DIRS)
    bad = []
    for path, h in dirty().items():
        if path.startswith(dirs + tuple(IGNORED)) or path in EXTRA_FILES or base["dirty"].get(path) == h:
            continue
        if path.startswith(tuple(NEW_TEST_DIRS)) and path.endswith(".test.ts") and path not in tracked:
            continue
        bad.append(path)
    if bad:
        fail(f"{len(bad)} file(s) changed outside the allowed paths: {bad[:12]}{' ...' if len(bad) > 12 else ''}")
    for path in git("diff", "--name-only", "HEAD", "--", *MODULE_DIRS).split():
        if path != CORE_INDEX:
            fail(f"T6.1 file changed: {path} (new files only; index.ts may only gain `export ... from` lines)")
    diff = [l for l in git("diff", "-U0", "HEAD", "--", CORE_INDEX).splitlines() if l and not l.startswith(("diff ", "index ", "--- ", "+++ ", "@@"))]
    removed = [l for l in diff if l.startswith("-")]
    added = "\n".join(l[1:] for l in diff if l.startswith("+"))
    added = re.sub(r"export\s+(type\s+)?\{[^}]*\}\s*from\s*['\"][^'\"]+['\"];?", "", added)
    added = re.sub(r"export\s+\*\s+(as\s+\w+\s+)?from\s*['\"][^'\"]+['\"];?", "", added)
    added = re.sub(r"//[^\n]*", "", added).strip()
    if removed or added:
        fail(f"{CORE_INDEX}: only added `export ... from` lines are allowed (removed {len(removed)} line(s), other added text: {added[:80]!r})")
    now = dirty()
    gone = [p for p in hidden() if base["dirty"].get(p) != now.get(p)]
    if gone:
        fail(f"{len(gone)} file(s) under the allowed paths are hidden by .gitignore and would be lost on merge: {gone[:12]}")
    changed_agent = [p for p, h in dirty().items() if p.startswith(f"agent/{HERE.name}/") and base["dirty"].get(p) != h
                     and not p.endswith(".baseline.json")]
    if base["dirty"] and changed_agent:
        fail(f"agent/{HERE.name}/ was edited after the snapshot: {changed_agent}")


def leftovers() -> None:
    section("scratch leftovers")
    if not PG_URL or not shutil.which("psql"):
        print("skipped (no scratch URL or no psql)")
        return
    like = " or ".join(f"nspname like '{p.replace('_', chr(92) + '_')}%'" for p in SCHEMA_PREFIXES)
    rc, out = run(["psql", PG_URL, "-Atc", f"select nspname from pg_namespace where {like}"], 30)
    left = [s for s in out.split() if s.startswith(tuple(SCHEMA_PREFIXES)) and re.fullmatch(r"[a-z0-9_]+", s)]
    for s in left:
        run(["psql", PG_URL, "-Atc", f'drop schema if exists "{s}" cascade'], 60)
    if left:
        fail(f"scratch schemas leaked (dropped now): {left}")


def stray_processes() -> None:
    section("process leftovers")
    rc, out = run(["ps", "-eo", "pid,args"], 30)
    me = {os.getpid(), os.getppid()}
    left = []
    for line in out.splitlines()[1:]:
        pid, _, args = line.strip().partition(" ")
        if pid.isdigit() and int(pid) not in me and PROC_MARKER in args and "selfcheck.py" not in args and not args.startswith(("ps ", "grep ")):
            left.append(f"{pid} {args[:100]}")
    if left:
        fail(f"{len(left)} process(es) of this task still running (tests must kill what they start): {left[:5]}")


def main() -> None:
    print(f"selfcheck {TASK}{' --fast' if FAST else ''}")
    contract()
    if preflight():
        tests(); checks(); lint(); suites(); scope(); leftovers(); stray_processes()
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
