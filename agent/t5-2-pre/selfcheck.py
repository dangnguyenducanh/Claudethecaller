#!/usr/bin/env python3
"""Self-check for T5.2 (pre-tool hook: file note, search hint, session caps; gate failopen).
Run from anywhere: python3 agent/t5-2-pre/selfcheck.py [--fast] [--snapshot]

Sections: contract hashes, preflight, own tests (Vitest, the gate excluded), the gate test names, the checks (checks.mjs), lint (ESLint + tsc), the gate
`failopen` (real TEI :18300, scratch Postgres, scratch Redis; it always runs, no switch) and its result file re-read independently, project suites
(pnpm -r lint/typecheck/test; pytest only when Python files changed), scope (only the allowed paths changed, git-ignored files under the allowed paths included),
scratch-schema leftovers.
Last line is `SELFCHECK: DONE` only when a FULL run found nothing wrong. `--fast` skips the Postgres/Redis/TEI tests, the gate, tsc and the project
suites and can only end with `SELFCHECK: FAST OK`. `--snapshot` (orchestrator, before the coder starts) records the dirty files already present and HEAD.
stdlib only. Never touches anything but the scratch Postgres and scratch Redis (guards below) and reads from TEI :18300; never reads ~/.claude.
"""
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
TASK = "T5.2"
MODULE_DIRS = ["packages/core/src/graph/note", "packages/shared/src/schemas/pre", "apps/web/src/pre"]        # whole directories the coder owns
ENTRY_FILES = [f"{d}/index.ts" for d in MODULE_DIRS]                                                          # each must exist before anything else runs
EXTRA_FILES: list[str] = []                                                                                   # SPEC.md "Change only": no existing file is edited (D22)
NEW_TEST_DIRS = ["apps/web/src/graph/"]                                                                       # new *.test.ts files allowed (the wiring test, D22)
WIRING = "apps/web/src/graph/graph.hint.wiring.test.ts"
IGNORED = ["agent/", "specs/", ".claude/agents/", ".ctc-dev/"]                                                # never counted by the scope check
GATE = "apps/web/src/pre/failopen.int.test.ts"
GATE_NAMES = [                                                                                                # DECISIONS.md D21
    "TEI down (refused and hanging): the prompt hook replies within 140 ms with the lexical line and the pre hook within 40 ms with the note",
    "Redis down (refused and hanging): the prompt hook replies within 140 ms and the pre hook within 40 ms with the note",
    "Postgres down (refused and hanging): both hooks reply within their budgets, from the warm RAM graph or empty when it is cold",
    "TEI, Redis and Postgres all down: both hooks reply within their budgets and never fail",
]
TEST_FILES = [*MODULE_DIRS, WIRING]                                                                           # own tests (the wiring file is added when it exists)
SLOW_TEST_GLOBS = ["**/*.int.test.ts", "**/tenancy.test.ts"]                                                  # skipped by --fast
TSC_PROJECTS = ["apps/web/tsconfig.json", "packages/core/tsconfig.json", "packages/shared/tsconfig.json"]
SCHEMA_PREFIXES = ["ctc_t52_", "ctc_t52chk_"]                                                                 # this task's scratch schemas only
DECISION_IDS = [f"D{i}" for i in range(23)]
MIN_TESTS = 23              # at least one test per decision id
CONTRACT = HERE / ".contract.sha256"
BASELINE = HERE / ".baseline.json"
EVAL = ROOT / ".ctc-dev" / "eval"
RES_FO = EVAL / "failopen.json"
TEI_EMBED = "http://127.0.0.1:18300"
GATE_TIMEOUT_S = 900
SLACK_MAX_MS = 25.0         # DECISIONS.md D21: the test may not inflate its own slack
BUDGET_PROMPT_MS, BUDGET_PRE_MS = 140.0, 40.0

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


def allowed_paths() -> list[str]:
    return [*MODULE_DIRS, *EXTRA_FILES, *NEW_TEST_DIRS]


def dirty() -> dict[str, str]:
    """path -> sha1 of content ('' for a deleted file) for every changed or untracked file, plus git-ignored files under the allowed
    paths (prefixed '!! ' in the key) so a file the merge would silently drop is seen."""
    out = {}
    for line in git("status", "--porcelain", "--untracked-files=all").splitlines():
        path = line[3:].split(" -> ")[-1].strip('"')
        f = ROOT / path
        out[path] = hashlib.sha1(f.read_bytes()).hexdigest() if f.is_file() else ""
    for line in git("status", "--porcelain", "--untracked-files=all", "--ignored=matching", "--", *allowed_paths()).splitlines():
        if line.startswith("!! "):
            path = line[3:].strip('"')
            f = ROOT / path
            out["!! " + path] = hashlib.sha1(f.read_bytes()).hexdigest() if f.is_file() else ""
    return out


if "--snapshot" in sys.argv:
    BASELINE.write_text(json.dumps({"head": git("rev-parse", "HEAD").strip(), "dirty": dirty()}, indent=1))
    print(f"snapshot written: {BASELINE}")
    sys.exit(0)


def _scratch(env_name: str, pattern: str) -> str | None:
    url = os.environ.get(env_name, "")
    return url if re.match(pattern, url) else None


PG_URL = _scratch("CTC_SCRATCH_PG_URL", r"^postgres(?:ql)?://[^@]*@127\.0\.0\.1:18304/")        # only the scratch Postgres (ctc-dev-pg); never Supabase
REDIS_URL = _scratch("CTC_SCRATCH_REDIS_URL", r"^redis://127\.0\.0\.1:18395(?:/\d+)?$") or "redis://127.0.0.1:18395"   # only the scratch Redis
ENV_FOR_CHILDREN = {"CTC_TEST_DATABASE_URL": PG_URL or "", "CTC_SCRATCH_PG_URL": PG_URL or "", "CTC_SCRATCH_REDIS_URL": REDIS_URL}

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
    for tool in ("pnpm", "git"):
        if not shutil.which(tool):
            fail(f"{tool} not on PATH")
            ok = False
    if not PG_URL:
        fail("env CTC_SCRATCH_PG_URL missing or not postgres://...@127.0.0.1:18304/<db> (scratch container ctc-dev-pg only)")
        ok = False
    return ok


def gate_names() -> None:
    gate = ROOT / GATE
    if not gate.is_file():
        fail(f"gate test file missing: {GATE}")
    else:
        text = gate.read_text(encoding="utf-8")
        if not re.search(r"describe\(\s*['\"`]failopen['\"`]", text):
            fail(f"{GATE}: no describe('failopen')")
        for name in GATE_NAMES:
            if not re.search(r"\b(it|test)\(\s*['\"`]" + re.escape(name) + r"['\"`]", text):
                fail(f"{GATE}: gate test missing: {name!r}")
        if re.search(r"\b(it|describe)\.(skip|skipIf|runIf)\b", text):
            fail(f"{GATE}: the gate must always run (no skip, skipIf, runIf)")
    if not (ROOT / WIRING).is_file():
        fail(f"wiring test missing: {WIRING} (DECISIONS.md D22)")


def tests() -> None:
    section("own tests (vitest, the gate excluded)")
    gate_names()
    cmd = ["pnpm", "exec", "vitest", "run", *[t for t in TEST_FILES if (ROOT / t).exists()], "--reporter=dot", "--exclude", f"**/{Path(GATE).name}"]
    if FAST:
        for g in SLOW_TEST_GLOBS:
            cmd += ["--exclude", g]
    rc, out = run(cmd, 900, {**ENV_FOR_CHILDREN})
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
    rc, out = run([*node, str(HERE / "checks.mjs")], 900, {**ENV_FOR_CHILDREN, "GIT_OPTIONAL_LOCKS": "0"})
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
    extra_ts = [WIRING] if (ROOT / WIRING).is_file() else []
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


def tcp_up(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=3):
            return True
    except OSError:
        return False


def read_json(path: Path, started: float):
    if not path.is_file():
        fail(f"gate passed but wrote no {path.relative_to(ROOT)} (DECISIONS.md D21/D22)")
        return None
    if path.stat().st_mtime < started - 2:
        fail(f"{path.relative_to(ROOT)} is older than this run: the gate did not write it")
        return None
    try:
        return json.loads(path.read_text())
    except ValueError:
        fail(f"{path.relative_to(ROOT)} is not JSON")
        return None


def verify_results(started: float) -> None:
    """Re-read the numbers the gate wrote and compare them with the bars independently of the test assertions."""
    data = read_json(RES_FO, started)
    if data is None:
        return
    try:
        slack, rows = float(data["slack_ms"]), data["scenarios"]
        if slack > SLACK_MAX_MS:
            fail(f"failopen slack_ms {slack} is above the allowed {SLACK_MAX_MS}")
        seen = set()
        for r in rows:
            down, kind, hook, graph = tuple(sorted(r["down"])), r["kind"], r["hook"], r.get("graph", "warm")
            budget = BUDGET_PROMPT_MS if hook == "prompt" else BUDGET_PRE_MS
            seen.add((down, kind, hook, graph))
            if float(r["budget_ms"]) != budget:
                fail(f"failopen row {down} {kind} {hook}: budget_ms {r['budget_ms']} != {budget}")
            if int(r["n"]) < 5 or float(r["max_ms"]) > budget + slack:
                fail(f"failopen row {down} {kind} {hook} {graph}: n={r['n']} max_ms={r['max_ms']} (bar {budget} + {slack})")
            if any(c not in (200, 204) for c in r["codes"]):
                fail(f"failopen row {down} {kind} {hook}: reply codes {r['codes']}")
            warm_single = graph == "warm" and down in (("tei",), ("redis",), ("postgres",))
            if warm_single and (hook == "pre" or down == ("tei",)) and int(r["texts"]) != int(r["n"]):
                fail(f"failopen row {down} {kind} {hook}: only {r['texts']} of {r['n']} replies carried text (DECISIONS.md D21)")
        want = {(d, k, h) for d in (("tei",), ("redis",), ("postgres",), ("postgres", "redis", "tei")) for k in ("refused", "hang") for h in ("prompt", "pre")}
        have = {(d, k, h) for d, k, h, _ in seen}
        if want - have:
            fail(f"failopen result lacks scenarios: {sorted(want - have)[:6]}")
        if not {("postgres",), } <= {d for d, _, _, g in seen if g == "cold"}:
            fail("failopen result lacks the Postgres-down cold-graph scenario")
        print(f"failopen: {len(rows)} rows, slack {slack} ms, worst overshoot "
              f"{max(float(r['max_ms']) - float(r['budget_ms']) for r in rows):.1f} ms")
    except (KeyError, TypeError, ValueError):
        fail(f"failopen.json has an unexpected shape: {json.dumps(data)[:300]}")


def gates() -> None:
    section("gate failopen (real TEI :18300, scratch Postgres and Redis; no switch)")
    if FAST:
        print("skipped (--fast)")
        return
    if not (ROOT / GATE).is_file():
        fail(f"gate test file missing: {GATE}")
        return
    try:
        with urllib.request.urlopen(f"{TEI_EMBED}/info", timeout=5) as r:
            info = json.loads(r.read())
        print(f"TEI embedder: {info.get('model_id')}")
    except Exception as e:  # noqa: BLE001 - any failure means the gate cannot run
        fail(f"TEI embedder {TEI_EMBED} not reachable ({type(e).__name__}): the gate needs it (never restart it; ask the orchestrator)")
        return
    if not tcp_up("127.0.0.1", 18395):
        fail("scratch Redis 127.0.0.1:18395 not reachable: the gate needs it (never restart it; ask the orchestrator)")
        return
    started = time.time()
    rc, out = run(["pnpm", "exec", "vitest", "run", GATE, "--reporter=verbose"], GATE_TIMEOUT_S + 60, {**ENV_FOR_CHILDREN})
    print(out[-3000:])
    if rc != 0:
        fail(f"gate failopen exited {rc}")
        return
    if not re.search(rf"Tests\s+{len(GATE_NAMES)} passed", out) or re.search(r"\bskipped\b", out):
        fail(f"gate failopen did not run exactly {len(GATE_NAMES)} passing tests (skipped or extra tests)")
    verify_results(started)


def changed_paths() -> list[str]:
    base = json.loads(BASELINE.read_text()) if BASELINE.exists() else {"dirty": {}}
    return [p for p, h in dirty().items() if base["dirty"].get(p) != h]


# Red on the base branch (checked at the T5.1 base, a244268-descended HEAD; re-check at the T5.2 base): T1.2's migrations lack projects.graph_epoch/mem_epoch (T1.3 D10; see repositories/scratch.ts).
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
    # T5.1's and T3.3's gates skip without their switch and file; T2.4's graph.query gate and this task's failopen gate always run (real TEI, scratch services)
    quiet = {**ENV_FOR_CHILDREN, "CTC_GATE_SUGGEST": "", "CTC_GATE_SUGGEST_SKILLS": "", "CTC_SKILLRET_FILE": str(EVAL / "absent-so-the-gate-skips.json")}
    for script in ["lint", "typecheck", "test"]:
        rc, out = run(["pnpm", "-r", *(["--no-bail"] if script == "test" else []), script], 1800, quiet)
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
    section("scope (allowed paths only; git-ignored files under them count)")
    base = json.loads(BASELINE.read_text()) if BASELINE.exists() else {"head": None, "dirty": {}}
    if not BASELINE.exists():
        print("note: no .baseline.json; every dirty file outside the allowed paths counts (orchestrator: run --snapshot first)")
    head = git("rev-parse", "HEAD").strip()
    if base["head"] and head != base["head"]:
        fail(f"HEAD moved ({base['head'][:8]} -> {head[:8]}): the coder must not commit")
    tracked = set(git("ls-files").splitlines())
    dirs = tuple(p.rstrip("/") + "/" for p in MODULE_DIRS)
    bad, hidden = [], []
    for path, h in dirty().items():
        if base["dirty"].get(path) == h:
            continue
        if path.startswith("!! "):
            hidden.append(path[3:])
            continue
        if path.startswith(dirs + tuple(IGNORED)) or path in EXTRA_FILES:
            continue
        if path.startswith(tuple(NEW_TEST_DIRS)) and path.endswith(".test.ts") and path not in tracked:
            continue
        bad.append(path)
    if bad:
        fail(f"{len(bad)} file(s) changed outside the allowed paths: {bad[:12]}{' ...' if len(bad) > 12 else ''}")
    if hidden:
        fail(f"{len(hidden)} file(s) under the allowed paths are git-ignored, so the merge would drop them: {hidden[:12]}")
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
        tests(); checks(); lint(); gates(); suites(); scope(); leftovers()
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
