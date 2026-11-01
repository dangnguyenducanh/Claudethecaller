#!/usr/bin/env python3
"""Self-check for T2.2 (resolver in packages/core/src/graph, rebuild job in apps/worker/src/graph). Run from anywhere:
    python3 agent/t2-2-resolve/selfcheck.py [--fast] [--snapshot]

Sections: contract hashes, preflight, own tests + integration tests (Vitest), the gate test names (graph.resolve,
graph.incremental), the checks (checks.mjs), lint (ESLint + tsc), project suites (pnpm -r lint/typecheck/test; pytest only
when Python files changed), dependency (apps/worker/package.json gains exactly ignore@7.0.14), scope (only the allowed paths
changed since the snapshot, files hidden by .gitignore under those paths included; T2.1's files untouched), scratch leftovers.
Last line is `SELFCHECK: DONE` only when a FULL run found nothing wrong. `--fast` skips the Postgres-backed tests, tsc and the
project suites and can only end with `SELFCHECK: FAST OK`. `--snapshot` (orchestrator, before the coder starts) records the dirty
files already present so the scope check ignores them, and records HEAD.
Env: CTC_SCRATCH_PG_URL (default and only allowed host: the scratch Postgres 127.0.0.1:18304). stdlib only; never reads ~/.claude.
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
TASK = "T2.2"
MODULE_DIRS = ["packages/core/src/graph", "apps/worker/src/graph"]
ENTRY_FILES = ["apps/worker/src/graph/index.ts"]                                   # must exist before anything else runs
CORE_INDEX = "packages/core/src/graph/index.ts"                                     # the only T2.1 file the coder may edit
FROZEN_DIRS = ["packages/core/src/graph/__fixtures__/"]                             # T2.1 fixtures: no change, no new file
T21_EXPORT_TEST = "packages/core/src/graph/graph.test.ts"                            # its D7/D22 export pins must admit the D24 exports
T21_EXPORT_LINES = ("unexpected export ${name}", "it('D22 exports exactly", "const want = [")  # the only HEAD lines that may change
EXTRA_FILES = ["packages/shared/src/repositories/graph.ts", "packages/shared/src/repositories/tenancy.cases.ts",
               "apps/worker/package.json", "pnpm-lock.yaml"]                         # SPEC.md "Change only" (D22, D24)
NEW_TEST_DIRS = ["packages/shared/src/repositories/"]                               # new *.test.ts files allowed here too
IGNORED = ["agent/", "specs/", ".claude/agents/", ".ctc-dev/"]                       # never counted by the scope check
GATES = {
    "packages/core/src/graph/graph.resolve.test.ts": ("graph.resolve", [
        "a call becomes EXTRACTED only with an import edge", "ambiguous names become AMBIGUOUS"]),
    "apps/worker/src/graph/graph.incremental.test.ts": ("graph.incremental", [
        "edit 1 file → only its rows change", "callers keep edges", "guard trips above 20% loss"]),
}
INTEGRATION = ["packages/shared/src/repositories/tenancy.test.ts",                  # D22 must keep the tenancy gate green
               "packages/shared/src/repositories/graph-library.int.test.ts"]
SLOW_TEST_GLOBS = ["**/graph.incremental.test.ts", "**/*.int.test.ts", "**/tenancy.test.ts"]   # skipped by --fast
TSC_PROJECTS = ["packages/core/tsconfig.json", "apps/worker/tsconfig.json", "packages/shared/tsconfig.json"]
SCHEMA_PREFIXES = ["ctc_t22_", "ctc_t22chk_"]                                        # this task's scratch schemas only
DECISION_IDS = [f"D{i}" for i in range(25)]
MIN_TESTS = 25              # at least one test per decision id
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
        p = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True, timeout=timeout, check=False)
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except subprocess.TimeoutExpired as e:
        return 124, f"timeout after {timeout}s: {' '.join(cmd)}\n{(e.stdout or b'')[-2000:]!r}"
    except FileNotFoundError as e:
        return 127, f"command not found: {e}"


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=False).stdout


def _sha1(f: Path) -> str:
    return hashlib.sha1(f.read_bytes()).hexdigest() if f.is_file() else ""


def dirty() -> dict[str, str]:
    """path -> sha1 of content ('' for a deleted file) for every changed or untracked file, plus files hidden by .gitignore
    under the allowed module paths (so an ignored name cannot slip a change past the scope check)."""
    out = {}
    for line in git("status", "--porcelain", "--untracked-files=all").splitlines():
        path = line[3:].split(" -> ")[-1].strip('"')
        out[path] = _sha1(ROOT / path)
    for line in git("status", "--porcelain", "--untracked-files=all", "--ignored", "--", *MODULE_DIRS).splitlines():
        if not line.startswith("!! "):
            continue
        path = line[3:].strip('"')
        base = ROOT / path
        for f in ([p for p in base.rglob("*") if p.is_file()] if base.is_dir() else [base]):
            rel = f.relative_to(ROOT).as_posix()
            if "/node_modules/" not in f"/{rel}":
                out[rel] = _sha1(f)
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
REDIS_URL = _guard("CTC_SCRATCH_REDIS_URL", "redis://127.0.0.1:18395", "127.0.0.1:18395")   # apps/web suites (T4.1) need it
ENV_FOR_CHILDREN = {"CTC_SCRATCH_PG_URL": PG_URL or "", "CTC_TEST_DATABASE_URL": PG_URL or "", "CTC_TEST_ADMIN_URL": PG_URL or "",
                    "CTC_SCRATCH_REDIS_URL": REDIS_URL or ""}


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
    for tool in ("pnpm", "node"):
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
    cmd = ["pnpm", "exec", "vitest", "run", *MODULE_DIRS, *([] if FAST else INTEGRATION), "--reporter=dot"]
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
    rc, out = run([*node, str(HERE / "checks.mjs")], 900, ENV_FOR_CHILDREN)
    print(out[-4000:])
    passed = set(re.findall(r"^PASS (D\d+)\b", out, re.M))
    failed = re.findall(r"^FAIL (D\d+)\b", out, re.M)
    if failed:
        fail(f"checks failed: {sorted(set(failed), key=lambda d: int(d[1:]))}")
    missing = [d for d in DECISION_IDS if d not in passed]
    if missing and not failed:
        fail(f"checks did not PASS: {missing} (exit {rc})")


def lint() -> None:
    section("lint (repo config)")
    extra_ts = [p for p in EXTRA_FILES if p.endswith(".ts") and (ROOT / p).is_file()]
    dirs = [d for d in MODULE_DIRS if (ROOT / d).is_dir()]
    rc, out = run(["pnpm", "exec", "eslint", "--max-warnings", "0", *dirs, *extra_ts], 600)
    print(out[-2000:])
    if rc != 0:
        fail(f"eslint exited {rc}")
    if FAST:
        print("tsc skipped (--fast)")
        return
    for proj in TSC_PROJECTS:
        if not (ROOT / proj).is_file():
            fail(f"no tsconfig at {proj}: cannot typecheck")
            continue
        rc, out = run(["pnpm", "exec", "tsc", "--noEmit", "-p", proj], 600)
        print(f"tsc {proj}: exit {rc}\n{out[-1500:]}")
        if rc != 0:
            fail(f"tsc --noEmit -p {proj} exited {rc}")


def changed_paths() -> list[str]:
    base = json.loads(BASELINE.read_text()) if BASELINE.exists() else {"dirty": {}}
    return [p for p, h in dirty().items() if base["dirty"].get(p) != h]


# Red on the base branch before T2.2: T1.2's migrations lack projects.graph_epoch/mem_epoch (T1.3 D10; agent/t3-1-scanner/CHANGES.md).
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
    rc, out = run(["timeout", "1200", "uv", "run", "pytest", "-q", "tests"], 1260)
    print(f"uv run pytest -q tests: exit {rc}\n{out[-1500:]}")
    if rc != 0:
        fail(f"pytest exited {rc} (changed Python files: {py[:5]})")


def dependency() -> None:
    section("dependency (apps/worker/package.json: only ignore@7.0.14 added)")
    rel = "apps/worker/package.json"
    try:
        old = json.loads(git("show", f"HEAD:{rel}") or "{}")
        new = json.loads((ROOT / rel).read_text())
    except (OSError, json.JSONDecodeError) as e:
        fail(f"{rel} unreadable: {e}")
        return
    want = {**old, "dependencies": {**old.get("dependencies", {}), "ignore": "7.0.14"}}
    if new != want:
        fail(f"{rel} must equal HEAD plus dependencies.ignore = '7.0.14' (D24)")


def t21_export_edit_only() -> bool:
    """True when T2.1's graph.test.ts differs from HEAD only in its two export pins (D7 forbidden names, D22 export list)."""
    diff = git("diff", "-U0", "HEAD", "--", T21_EXPORT_TEST).splitlines()
    removed = [l[1:] for l in diff if l.startswith("-") and not l.startswith("---")]
    added = [l[1:] for l in diff if l.startswith("+") and not l.startswith("+++")]
    return (0 < len(removed) <= len(T21_EXPORT_LINES) and len(added) <= len(T21_EXPORT_LINES) + 1
            and all(any(k in l for k in T21_EXPORT_LINES) for l in removed))


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
    frozen = []
    for path, h in dirty().items():
        if base["dirty"].get(path) == h or path.startswith(tuple(IGNORED)):
            continue
        if path == T21_EXPORT_TEST and t21_export_edit_only():
            continue
        if path.startswith(tuple(FROZEN_DIRS)) or (path.startswith("packages/core/src/graph/") and path in tracked and path != CORE_INDEX):
            frozen.append(path)
            continue
        if path.startswith(dirs) or path in EXTRA_FILES:
            continue
        if path.startswith(tuple(NEW_TEST_DIRS)) and path.endswith(".test.ts") and path not in tracked:
            continue
        bad.append(path)
    if frozen:
        fail(f"T2.1 files or fixtures changed (only {CORE_INDEX} may change there): {frozen[:12]}")
    if bad:
        fail(f"{len(bad)} file(s) changed outside the allowed paths: {bad[:12]}{' ...' if len(bad) > 12 else ''}")
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


def main() -> None:
    print(f"selfcheck {TASK}{' --fast' if FAST else ''}")
    contract()
    if preflight():
        tests(); checks(); lint(); suites(); dependency(); scope(); leftovers()
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
