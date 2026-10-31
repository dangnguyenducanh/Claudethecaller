#!/usr/bin/env python3
"""Self-check for T3.3 (SKILLRET skill seed channel, TEI client, RAM matrix, loadSkillIndex, gate suggest.skills).
Run from anywhere: python3 agent/t3-3-skill-channel/selfcheck.py [--fast] [--snapshot] [--export]

Sections: contract hashes, preflight, own tests + integration tests (Vitest, the gate excluded), the gate test names, the checks
(checks.mjs), lint (ESLint + tsc), the gate `suggest.skills` run strictly (CTC_GATE_SUGGEST_SKILLS=1, needs the SkillRet export and the real
TEI embedder), project suites (pnpm -r lint/typecheck/test with the gate skipped; pytest only when Python files changed), scope (only the
allowed paths changed since the snapshot, git-ignored files under the allowed paths included), scratch-schema leftovers.
Last line is `SELFCHECK: DONE` only when a FULL run found nothing wrong. `--fast` skips the Postgres/TEI tests, the gate, tsc and the
project suites and can only end with `SELFCHECK: FAST OK`. `--snapshot` (orchestrator, before the coder starts) records the dirty files
already present and HEAD. `--export` only writes .ctc-dev/eval/skillret-test.json from the cached SkillRet dataset (a full run does it
when the file is missing).
stdlib only. Never touches anything but the scratch Postgres (guards below) and reads from TEI :18300; never reads ~/.claude.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
TASK = "T3.3"
MODULE_DIRS = ["packages/core/src/skills", "packages/shared/src/tei", "apps/web/src/skills"]     # whole directories the coder owns
ENTRY_FILES = [f"{d}/index.ts" for d in MODULE_DIRS]                                           # each must exist before anything else runs
EXTRA_FILES = ["packages/shared/src/repositories/library.ts", "packages/shared/src/repositories/tenancy.cases.ts",
               "apps/web/src/library/served.ts", "apps/web/src/library/index.ts"]               # SPEC.md "Change only"
NEW_TEST_DIRS = ["packages/shared/src/repositories/"]                                         # new *.test.ts files allowed
IGNORED = ["agent/", "specs/", ".claude/agents/", ".ctc-dev/"]                                 # never counted by the scope check
GATE_FILE = "apps/web/src/skills/suggest.skills.int.test.ts"
GATES = {GATE_FILE: ("suggest.skills", ["SkillRet test split: NDCG@10 of the skill channel is at least 0.80"])}   # DECISIONS.md D23
TEST_DIRS = [*MODULE_DIRS, "apps/web/src/library"]                                             # own tests + the T3.2 tests served.ts must keep green
INTEGRATION = ["packages/shared/src/repositories/tenancy.test.ts",                             # D21 adds a repo function and its tenancy case
               "packages/shared/src/repositories/graph-library.int.test.ts"]
SLOW_TEST_GLOBS = ["**/*.int.test.ts", "**/tenancy.test.ts"]                                   # skipped by --fast
TSC_PROJECTS = ["apps/web/tsconfig.json", "packages/core/tsconfig.json", "packages/shared/tsconfig.json"]
SCHEMA_PREFIXES = ["ctc_t33_", "ctc_t33chk_"]                                                  # this task's scratch schemas only
DECISION_IDS = [f"D{i}" for i in range(24)]
MIN_TESTS = 24              # at least one test per decision id
CONTRACT = HERE / ".contract.sha256"
BASELINE = HERE / ".baseline.json"
EXPORT = ROOT / ".ctc-dev" / "eval" / "skillret-test.json"
GATE_RESULT = ROOT / ".ctc-dev" / "eval" / "suggest.skills.json"
TEI_EMBED = "http://127.0.0.1:18300"
GATE_TIMEOUT_S = 3600

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


def _pg_url() -> str | None:
    url = os.environ.get("CTC_SCRATCH_PG_URL", "")
    return url if re.match(r"^postgres(?:ql)?://[^@]*@127\.0\.0\.1:18304/", url) else None


PG_URL = _pg_url()  # only the scratch Postgres (ctc-dev-pg); never Supabase
ENV_FOR_CHILDREN = {"CTC_TEST_DATABASE_URL": PG_URL or "", "CTC_SCRATCH_PG_URL": PG_URL or ""}
SCRATCH_REDIS = "redis://127.0.0.1:18395"  # scratch Redis only; the T4.1 spool int test in the project suite needs it (it does not skip)

EXPORT_CODE = r"""
import json, os, sys
from pathlib import Path
from evaluation.loaders import skillret, SKILLRET_REV
skills, queries, qrels = skillret("test")
clean = lambda s: (s or "").replace("\x00", "")
out = {"source": f"ThakiCloud/SKILLRET@{SKILLRET_REV} split test",
       "skills": [{"id": s["id"], "name": clean(s["name"]), "description": clean(s["description"]), "body": clean(s["body"])} for s in skills],
       "queries": [{"id": q["id"], "query": clean(q["query"])} for q in queries],
       "qrels": {qid: {k.split(":", 1)[1]: v for k, v in rel.items()} for qid, rel in qrels.items()}}
dst = Path(sys.argv[1]); dst.parent.mkdir(parents=True, exist_ok=True)
part = dst.with_suffix(".part"); part.write_text(json.dumps(out, ensure_ascii=False)); os.replace(part, dst)
print(f"exported {len(out['skills'])} skills, {len(out['queries'])} queries, {len(out['qrels'])} qrels -> {dst}")
"""


def export() -> bool:
    section("SkillRet export (.ctc-dev/eval/skillret-test.json)")
    if EXPORT.is_file() and "--export" not in sys.argv:
        print(f"present: {EXPORT}")
        return True
    if not shutil.which("uv"):
        fail("uv not on PATH: cannot export SkillRet")
        return False
    rc, out = run(["uv", "run", "python", "-c", EXPORT_CODE, str(EXPORT)], 900, {"HF_DATASETS_OFFLINE": "1", "HF_HUB_OFFLINE": "1"})
    print(out[-1500:])
    if rc != 0:
        fail(f"SkillRet export exited {rc} (needs data/raw/hf with the cached dataset)")
        return False
    return True


if "--export" in sys.argv:
    sys.exit(0 if export() else 1)


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


def gate_names() -> None:
    for rel, (describe, names) in GATES.items():
        gate = ROOT / rel
        if not gate.is_file():
            fail(f"gate test file missing: {rel}")
            continue
        src = gate.read_text(encoding="utf-8")
        if not re.search(r"describe(?:\.skipIf\([^)]*\))?\(\s*['\"`]" + re.escape(describe) + r"['\"`]", src):
            fail(f"{rel}: no describe('{describe}')")
        for name in names:
            if not re.search(r"\b(it|test)\(\s*['\"`]" + re.escape(name) + r"['\"`]", src):
                fail(f"{rel}: gate test missing: {name!r}")


def tests() -> None:
    section("own tests + integration tests (vitest, gate excluded)")
    gate_names()
    cmd = ["pnpm", "exec", "vitest", "run", *TEST_DIRS, *([] if FAST else INTEGRATION), "--reporter=dot", "--exclude", f"**/{Path(GATE_FILE).name}"]
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


def gate() -> None:
    section("gate suggest.skills (strict: CTC_GATE_SUGGEST_SKILLS=1, real TEI :18300, SkillRet test split)")
    if FAST:
        print("skipped (--fast)")
        return
    if not (ROOT / GATE_FILE).is_file():
        fail(f"gate test file missing: {GATE_FILE}")
        return
    if not export():
        return
    try:
        with urllib.request.urlopen(f"{TEI_EMBED}/info", timeout=5) as r:
            info = json.loads(r.read())
        print(f"TEI embedder: {info.get('model_id')}")
    except Exception as e:  # noqa: BLE001 - any failure means the gate cannot run
        fail(f"TEI embedder {TEI_EMBED} not reachable ({type(e).__name__}): the gate needs it (never restart it; ask the orchestrator)")
        return
    rc, out = run(["pnpm", "exec", "vitest", "run", GATE_FILE, "--reporter=verbose"], GATE_TIMEOUT_S + 60,
                  {**ENV_FOR_CHILDREN, "CTC_GATE_SUGGEST_SKILLS": "1", "CTC_SKILLRET_FILE": str(EXPORT)})
    print(out[-3000:])
    if rc != 0:
        fail(f"gate suggest.skills exited {rc}")
        return
    if not re.search(r"Tests\s+1 passed", out) or re.search(r"\bskipped\b", out):
        fail("gate suggest.skills did not run exactly one passing test (skipped or extra tests)")
    if GATE_RESULT.is_file():
        print(f"gate result: {GATE_RESULT.read_text()[:600]}")
    else:
        fail(f"gate passed but wrote no {GATE_RESULT.relative_to(ROOT)} (DECISIONS.md D23(5))")


def changed_paths() -> list[str]:
    base = json.loads(BASELINE.read_text()) if BASELINE.exists() else {"dirty": {}}
    return [p for p, h in dirty().items() if base["dirty"].get(p) != h]


# Red on the base branch (still red at the T3.3 base, 7b5098f): T1.2's migrations lack projects.graph_epoch/mem_epoch (T1.3 D10; see repositories/scratch.ts).
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
    no_gate = {**ENV_FOR_CHILDREN, "CTC_SCRATCH_REDIS_URL": SCRATCH_REDIS, "CTC_SKILLRET_FILE": str(ROOT / ".ctc-dev" / "eval" / "absent-so-the-gate-skips.json"), "CTC_GATE_SUGGEST_SKILLS": ""}
    for script in ["lint", "typecheck", "test"]:
        rc, out = run(["pnpm", "-r", *(["--no-bail"] if script == "test" else []), script], 1200, no_gate)
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
        tests(); checks(); lint(); gate(); suites(); scope(); leftovers()
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
