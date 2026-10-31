#!/usr/bin/env python3
"""Self-check for T7.1 (switch over: settings.json hooks, ctc-web and ctc-worker mains, migration 0006, the gate runner). Run from anywhere: python3 agent/t7-1-switch/selfcheck.py [--fast] [--snapshot]

Sections: contract hashes, preflight, own tests (Vitest) and the gate test names, the real gate run (.claude/metric/eval/switch/run.mjs: every spec §7 gate on
the dev instance environment, dashboard-e2e reported as not run, O12), the checks (checks.mjs), lint (ESLint + tsc), project suites (pnpm -r lint/typecheck/test;
pytest only when Python files changed), scope (only the allowed paths changed since the snapshot; package.json files only gain dependencies and bin; no earlier task
file touched; files hidden by .gitignore under the allowed paths are listed and fail, since a merge would drop them), scratch-schema, process and port leftovers.
Last line is `SELFCHECK: DONE` only when a FULL run found nothing wrong. `--fast` skips the Postgres-backed tests, the gate run, tsc and the project suites and can only
end with `SELFCHECK: FAST OK`. `--snapshot` (orchestrator, before the coder starts) records the dirty files already present (installed dependencies) so the scope check
ignores them, and records HEAD.
stdlib only. Never touches anything but the scratch services (guards below) and ports 18410-18419; never reads ~/.claude; never stops the live daemon.
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
TASK = "T7.1"
CODE_DIRS = ["apps/web/src/server", "apps/worker/src/boot"]                          # whole directories the coder owns (sources and tests)
EVAL_DIR = ".claude/metric/eval/switch"                                              # the gate runner (D19)
MODULE_DIRS = [*CODE_DIRS, EVAL_DIR]
WEB_MAIN = "apps/web/src/server/main.ts"
WORKER_MAIN = "apps/worker/src/boot/main.ts"
RUN_MJS = f"{EVAL_DIR}/run.mjs"
ENTRY_FILES = [WEB_MAIN, WORKER_MAIN, RUN_MJS]                                        # each must exist before anything else runs
PKG_FILES = {"apps/web/package.json": {"dependencies", "bin"}, "apps/worker/package.json": {"bin", "dependencies"}}   # keys that may change
PIN_TESTS = ["packages/shared/src/repositories/admin/migrate.test.ts", "apps/cli/src/migrate.test.ts"]               # D2: only the pins that count migrations
SCRATCH_FILE = "packages/shared/src/repositories/scratch.ts"                          # D2: only if the helper becomes redundant
EXTRA_FILES = [".claude/settings.json", "packages/shared/migrations/0006_epochs.sql", ".claude/metric/eval/ci.md", ".claude/metric/eval/switch.md",
               "pnpm-lock.yaml", "packages/shared/src/repositories/fixtures/schema-columns.json", *PKG_FILES, *PIN_TESTS, SCRATCH_FILE]                # exact files outside the module dirs that SPEC.md allows
IGNORED = ["agent/", "specs/", ".claude/agents/", ".ctc-dev/"]                       # never counted by the scope check
GATES = {   # file -> (describe name, test names)   SPEC.md Done
    "apps/web/src/server/switch.settings.test.ts": ("switch.settings", [
        "keeps the two graphify groups and adds exactly the six hook groups",
        "runs each hook command against a fake server and fails open"]),
    "apps/web/src/server/switch.web.int.test.ts": ("switch.web", [
        "mounts the expected route table and refuses a duplicate",
        "answers a bad hook body with an empty 204",
        "lists exactly the 13 MCP tools"]),
    "apps/worker/src/boot/switch.worker.int.test.ts": ("switch.worker", ["registers exactly the 12 handler keys"]),
    "apps/web/src/server/switch.live.int.test.ts": ("switch.live", [
        "runs hooks, spool, MCP and fail-open against a real dev instance on port 18410"]),
}
LEDGER_GATES = ["tenancy", "failopen", "ci", "graph.ids", "graph.resolve", "graph.incremental", "graph.query", "suggest.latency", "suggest.context", "library.version",
                "library.mcp", "library.override", "suggest.skills", "memory.spool", "memory.idempotent", "memory.bands", "memory.context", "memory.recall",
                "runner.lifecycle", "runner.crash", "runner.fanout", "runner.idempotent", "runner.md", "dashboard-e2e", "dev-instance"]
GATES_TEST = "apps/web/src/server/switch.gates.test.ts"                               # one `it('<gate> is green')` per gate (SPEC.md Done)
TEST_DIRS = [*CODE_DIRS, *PIN_TESTS, "packages/shared/src/repositories/schema-assumptions.test.ts"]
SLOW_TEST_GLOBS = ["**/*.int.test.ts", "**/schema-assumptions.test.ts", "**/migrate.test.ts", "**/switch.gates.test.ts"]   # skipped by --fast
TSC_PROJECTS = ["apps/web/tsconfig.json", "apps/worker/tsconfig.json", "packages/shared/tsconfig.json", "apps/cli/tsconfig.json"]
SCHEMA_PREFIXES = ["ctc_t71_", "ctc_t71chk_"]                                        # this task's scratch schemas only
PROC_MARKERS = ["/ctc-t71", "/apps/web/src/server/main.ts", "/apps/worker/src/boot/main.ts"]   # temp dirs and the two mains started by tests
PORTS = range(18410, 18420)                                                          # dev-instance ports (O12): nothing may still listen here
DECISION_IDS = [f"D{i}" for i in range(25)]
MIN_TESTS = 20              # the switch.* tests above plus the unit tests of the composition
SCRATCH_REDIS = "redis://127.0.0.1:18395"
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
    return tuple(p.rstrip("/") + "/" for p in MODULE_DIRS) + tuple(EXTRA_FILES)


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
ENV_FOR_CHILDREN = {"CTC_TEST_DATABASE_URL": PG_URL or "", "CTC_TEST_ADMIN_URL": PG_URL or "", "CTC_SCRATCH_PG_URL": PG_URL or "", "CTC_SCRATCH_REDIS_URL": SCRATCH_REDIS}


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
    for tool in ["pnpm", "node", "curl", "psql", "git"]:
        if not shutil.which(tool):
            fail(f"{tool} not on PATH")
            ok = False
    if not PG_URL:
        fail("env CTC_SCRATCH_PG_URL missing or not postgres://...@127.0.0.1:18304/<db> (scratch container ctc-dev-pg only)")
        ok = False
    return ok


def test_names() -> None:
    section("gate test names (SPEC.md Done)")
    for rel, (describe, names) in {**GATES, GATES_TEST: ("switch.gates", [f"{g} is green" for g in LEDGER_GATES if g not in ("dashboard-e2e",)] + ["dashboard-e2e is reported as not run"])}.items():
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


def tests() -> None:
    section("own tests + integration tests (vitest; the switch.gates tests read the ledger written by gates())")
    cmd = ["pnpm", "exec", "vitest", "run", *TEST_DIRS, *([] if FAST else [GATES_TEST]), "--reporter=dot"]
    if FAST:
        for g in SLOW_TEST_GLOBS:
            cmd += ["--exclude", g]
    rc, out = run(cmd, 1800, ENV_FOR_CHILDREN)
    print(out[-3000:])
    m = re.search(r"Tests\s+(?:\d+ failed \| )?(\d+) passed", out)
    n = int(m.group(1)) if m else 0
    if rc != 0:
        fail(f"vitest exited {rc}")
    elif n < (MIN_TESTS if not FAST else 1):
        fail(f"only {n} tests passed, expected at least {MIN_TESTS}: every decision id needs a test")


def gates() -> None:
    section("gates: node .claude/metric/eval/switch/run.mjs (every spec §7 gate; can take over an hour)")
    if FAST:
        print("skipped (--fast)")
        return
    rc, out = run(["node", RUN_MJS], 7200, ENV_FOR_CHILDREN)
    print(out[-3500:])
    if rc != 0:
        fail(f"run.mjs exited {rc} (a gate is red; its row says which and why)")
    led = ROOT / ".ctc-dev/eval/switch.json"
    try:
        rows = json.loads(led.read_text())["rows"]
    except (OSError, ValueError, KeyError):
        fail(f"{led} missing or unreadable after run.mjs")
        return
    names = [r.get("gate") for r in rows]
    if names != LEDGER_GATES:
        fail(f"ledger rows are {names}, expected {LEDGER_GATES}")
    for r in rows:
        want = "not_run" if r.get("gate") == "dashboard-e2e" else "pass"
        if r.get("status") != want:
            fail(f"gate {r.get('gate')}: {r.get('status')} (want {want}) {r.get('reason', '')}")


def checks() -> None:
    section("checks.mjs")
    node = ["node"]
    if (ROOT / "node_modules" / "tsx").exists():
        node += ["--import", "tsx"]
    rc, out = run([*node, str(HERE / "checks.mjs")], 2400, {**ENV_FOR_CHILDREN, **({"CTC_CHECKS_FAST": "1"} if FAST else {})})
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
    targets = [d for d in CODE_DIRS if (ROOT / d).is_dir()]
    if targets:
        rc, out = run(["pnpm", "exec", "eslint", "--max-warnings", "0", *targets], 600)
        print(out[-2000:])
        if rc != 0:
            fail(f"eslint exited {rc}")
    else:
        fail("no code directory to lint")
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


def suites() -> None:
    section("project suites (pnpm -r lint, typecheck, test; pytest when Python changed)")
    if FAST:
        print("skipped (--fast)")
        return
    for script in ["lint", "typecheck", "test"]:
        rc, out = run(["pnpm", "-r", *(["--no-bail"] if script == "test" else []), script], 1800, ENV_FOR_CHILDREN)
        print(f"pnpm -r {script}: exit {rc}\n{out[-1500:]}")
        if rc != 0:
            fail(f"pnpm -r {script} exited {rc} (schema-assumptions.test.ts is no longer tolerated: migration 0006 must make it green)")
    py = [p for p in changed_paths() if p.endswith(".py") and not p.startswith(tuple(IGNORED))]
    if not py:
        print("pytest skipped (no Python file changed)")
        return
    rc, out = run(["uv", "run", "pytest", "-q", "tests"], 1800)
    print(f"uv run pytest -q tests: exit {rc}\n{out[-1500:]}")
    if rc != 0:
        fail(f"pytest exited {rc} (changed Python files: {py[:5]})")


def json_at_head(rel: str) -> dict:
    try:
        return json.loads(git("show", f"HEAD:{rel}"))
    except ValueError:
        return {}


def diff_lines(rel: str) -> list[str]:
    return [l for l in git("diff", "-U0", "HEAD", "--", rel).splitlines() if l and not l.startswith(("diff ", "index ", "--- ", "+++ ", "@@"))]


def scope() -> None:
    section("scope (allowed paths only)")
    base = json.loads(BASELINE.read_text()) if BASELINE.exists() else {"head": None, "dirty": {}}
    if not BASELINE.exists():
        print("note: no .baseline.json; every dirty file outside the allowed paths counts (orchestrator: run --snapshot first)")
    head = git("rev-parse", "HEAD").strip()
    if base["head"] and head != base["head"]:
        fail(f"HEAD moved ({base['head'][:8]} -> {head[:8]}): the coder must not commit")
    dirs = tuple(p.rstrip("/") + "/" for p in MODULE_DIRS)
    bad = []
    for path, h in dirty().items():
        if path.startswith(dirs + tuple(IGNORED)) or path in EXTRA_FILES or base["dirty"].get(path) == h:
            continue
        bad.append(path)
    if bad:
        fail(f"{len(bad)} file(s) changed outside the allowed paths: {bad[:12]}{' ...' if len(bad) > 12 else ''}")
    for rel, may_change in PKG_FILES.items():
        before, after = json_at_head(rel), {}
        try:
            after = json.loads((ROOT / rel).read_text())
        except (OSError, ValueError):
            fail(f"{rel} unreadable")
            continue
        for key in set(before) | set(after):
            if key in may_change:
                continue
            if before.get(key) != after.get(key):
                fail(f"{rel}: key {key!r} changed (only {sorted(may_change)} may)")
        lost = [d for d in before.get("dependencies", {}) if d not in after.get("dependencies", {}) or before["dependencies"][d] != after["dependencies"][d]]
        if lost:
            fail(f"{rel}: existing dependencies changed or removed: {lost}")
    for rel in PIN_TESTS:
        d = diff_lines(rel)
        if len(d) > 32:
            fail(f"{rel}: {len(d)} changed lines; D2 allows only the pins that count migrations")
    if len(diff_lines(SCRATCH_FILE)) > 20:
        fail(f"{SCRATCH_FILE}: D2 allows it to become a no-op only")
    for rel in ["packages/shared/migrations/0001_base.sql", "packages/shared/migrations/0002_graph.sql", "packages/shared/migrations/0003_library.sql",
                "packages/shared/migrations/0004_memory.sql", "packages/shared/migrations/0005_runner.sql", "hooks/spool"]:
        if git("status", "--porcelain", "--", rel).strip():
            fail(f"{rel} changed (stamped migrations and hooks/spool are frozen)")
    sj = json_at_head(".claude/settings.json")
    try:
        cur = json.loads((ROOT / ".claude/settings.json").read_text())
        if set(cur) != set(sj):
            fail(f".claude/settings.json: top-level keys {sorted(cur)} != HEAD {sorted(sj)}")
    except (OSError, ValueError):
        fail(".claude/settings.json missing or not valid JSON")
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
    rc, out = run(["psql", "-q", PG_URL, "-Atc", f"select nspname from pg_namespace where {like}"], 30)
    left = [s for s in out.split() if s.startswith(tuple(SCHEMA_PREFIXES)) and re.fullmatch(r"[a-z0-9_]+", s)]
    for s in left:
        run(["psql", "-q", PG_URL, "-Atc", f'drop schema if exists "{s}" cascade'], 60, {"PGOPTIONS": "-c client_min_messages=warning"})
    if left:
        fail(f"scratch schemas leaked (dropped now): {left}")


def stray_processes() -> None:
    section("process and port leftovers")
    rc, out = run(["ps", "-eo", "pid,args"], 30)
    me = {os.getpid(), os.getppid()}
    left = []
    for line in out.splitlines()[1:]:
        pid, _, args = line.strip().partition(" ")
        if pid.isdigit() and int(pid) not in me and any(m in args for m in PROC_MARKERS) and "selfcheck.py" not in args and not args.startswith(("ps ", "grep ")):
            left.append(f"{pid} {args[:100]}")
    if left:
        fail(f"{len(left)} process(es) of this task still running (tests must kill what they start): {left[:5]}")
    if shutil.which("ss"):
        rc, out = run(["ss", "-ltnH"], 30)
        busy = sorted({int(m) for m in re.findall(r":(\d{5})\s", out) if int(m) in PORTS})
        if busy:
            fail(f"dev-instance ports still listening: {busy}")


def main() -> None:
    print(f"selfcheck {TASK}{' --fast' if FAST else ''}")
    contract()
    if preflight():
        test_names(); gates(); tests(); checks(); lint(); suites(); scope(); leftovers(); stray_processes()
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
