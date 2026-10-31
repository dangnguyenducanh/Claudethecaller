#!/usr/bin/env python3
"""T1.2 self-check: own + integration tests, the checks, lint, typecheck, a run on a real copy, scope.
Last line `SELFCHECK: DONE` only if nothing failed (`SELFCHECK: BLOCKED` when T1.1 or the scratch Postgres is missing).

Usage: python3 agent/t1-2-migrations/selfcheck.py [--fast]
  --fast  skips `pnpm install`, the real-copy import run and the slow checks (450-row batch, vitest re-run inside checks).
Env: CTC_ROOT, CTC_BASE_REF (scope base, default the ctc-007-build branch), CTC_TEST_ADMIN_URL (default the ctc-dev-pg admin URL),
     CTC_TEST_PY_COPY_URL / CTC_TEST_PY_COPY_SCHEMA (a restored pg_dump of the Python DB; default: scratch database `ctc`, schema `ctc`).
Only the scratch server is used; databases and roles it creates are named ctc_t12_*; the Python copy is only read.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = Path(os.environ.get("CTC_ROOT", HERE.parents[1])).resolve()
BASE_REF = os.environ.get("CTC_BASE_REF", "dangnguyenducanh/ctc-007-build")
ADMIN = os.environ.get("CTC_TEST_ADMIN_URL", "postgresql://postgres:ctcdev@127.0.0.1:18304/postgres")
BASE_URL = ADMIN.rsplit("/", 1)[0] + "/"
COPY_URL = os.environ.get("CTC_TEST_PY_COPY_URL", BASE_URL + "ctc")
COPY_SCHEMA = os.environ.get("CTC_TEST_PY_COPY_SCHEMA", "ctc")
FAST = "--fast" in sys.argv

ALLOWED = [
    re.compile(r"^packages/shared/migrations/\d{4}_[a-z0-9_]+\.sql$"),
    re.compile(r"^packages/shared/src/repositories/admin/.+$"),
    re.compile(r"^packages/shared/src/memory-hash/.+$"),
    re.compile(r"^(packages/shared/package\.json|apps/cli/package\.json|pnpm-lock\.yaml)$"),
    re.compile(r"^apps/cli/src/(main|migrate)\.ts$"),
    re.compile(r"^apps/cli/src/[^/]+\.test\.ts$"),
]
IGNORED_PREFIXES = ("agent/", "specs/", ".claude/", "node_modules/")  # untracked orchestrator material; contract files: .contract.sha256
results: list[tuple[str, bool]] = []


def run(cmd: list[str], cwd: Path = ROOT, timeout: int = 900, env: dict | None = None, inp: str | None = None) -> tuple[int, str]:
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout, input=inp, env={**os.environ, **(env or {})})
        return p.returncode, p.stdout + p.stderr
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        return 124, f"{type(e).__name__}: {e}"


def step(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok))
    print(f"{'PASS' if ok else 'FAIL'} {name}")
    if not ok and detail:
        print("  " + "\n  ".join(detail.strip().splitlines()[-25:]))


def cmd_step(name: str, cmd: list[str], **kw) -> tuple[bool, str]:
    code, out = run(cmd, **kw)
    step(name, code == 0, out)
    return code == 0, out


def git(*args: str) -> str:
    return run(["git", *args])[1]


def psql(url: str, sql: str) -> tuple[int, str]:
    code, out = run(["psql", url, "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-f", "-"], inp=sql)
    return code, out.strip()


def blocked(why: str) -> int:
    print(f"BLOCKED: {why}")
    print("SELFCHECK: BLOCKED")
    return 3


def json_at(ref: str, path: str) -> dict:
    code, out = run(["git", "show", f"{ref}:{path}"])
    return json.loads(out) if code == 0 else {}


def scope() -> None:
    base = git("merge-base", "HEAD", BASE_REF).strip()
    if not re.fullmatch(r"[0-9a-f]{40}", base):
        base = git("rev-parse", "HEAD").strip()
    changed = set(git("diff", "--name-only", base).split())
    for line in git("status", "--porcelain", "--untracked-files=normal").splitlines():
        if line.startswith("??"):
            changed.add(line[3:].strip())
    out = sorted(p for p in changed if not p.startswith(IGNORED_PREFIXES) and not any(a.match(p.rstrip("/")) for a in ALLOWED))
    step("scope: only the T1.2 files changed", not out, "outside scope: " + ", ".join(out))
    # the two package.json files may only gain what D9 names
    problems = []
    cur = lambda p: json.loads((ROOT / p).read_text())
    shared_old, shared_new = json_at(base, "packages/shared/package.json"), cur("packages/shared/package.json")
    if shared_old:
        for k in set(shared_old) | set(shared_new):
            if k in ("dependencies", "devDependencies"):
                added = {d for d in (shared_new.get(k) or {}) if d not in (shared_old.get(k) or {})}
                changed_ver = {d for d in (shared_old.get(k) or {}) if (shared_old[k][d] != (shared_new.get(k) or {}).get(d))}
                if added - {"pg", "@types/pg"} or changed_ver:
                    problems.append(f"packages/shared/package.json {k}: only pg and @types/pg may be added (got {sorted(added | changed_ver)})")
            elif shared_old.get(k) != shared_new.get(k):
                problems.append(f"packages/shared/package.json: `{k}` changed")
    cli_old, cli_new = json_at(base, "apps/cli/package.json"), cur("apps/cli/package.json")
    if cli_old:
        for k in set(cli_old) | set(cli_new):
            if k != "bin" and cli_old.get(k) != cli_new.get(k):
                problems.append(f"apps/cli/package.json: `{k}` changed (only `bin` may be added)")
    step("scope: package.json changes limited to D9", not problems, "\n".join(problems))
    for f in ("packages/shared/src/env", "eslint.config.js", "config", "src/ctc", "scripts", ".github"):
        d = git("diff", "--name-only", base, "--", f).split()
        if d:
            step(f"scope: {f} untouched", False, ", ".join(d))


def contract_intact() -> None:
    manifest = HERE / ".contract.sha256"
    if not manifest.exists():
        print("NOTE no .contract.sha256: the orchestrator should write one before the coder starts (see agent/t1-12-OPEN.md)")
        return
    bad = []
    for line in manifest.read_text().splitlines():
        digest, name = line.split(maxsplit=1)
        f = HERE / name.strip().lstrip("*")
        if not f.exists() or hashlib.sha256(f.read_bytes()).hexdigest() != digest:
            bad.append(name)
    step("contract files unchanged (agent/t1-2-migrations)", not bad, ", ".join(bad))


def real_copy() -> None:
    """Import the (read-only) Python copy into a fresh scratch database and compare row counts with SQL, not with the importer's report."""
    code, out = psql(COPY_URL, f"select count(*) from {COPY_SCHEMA}.projects")
    if code:
        print(f"NOTE no Python copy at the configured URL (schema {COPY_SCHEMA}); real-copy run skipped. Set CTC_TEST_PY_COPY_URL to a restored pg_dump.")
        return
    name = f"ctc_t12_selfcheck_{os.getpid()}"
    tgt = BASE_URL + name
    tables = ["projects", "sessions", "capabilities", "cap_vectors", "overrides", "dedup_review", "memories", "graph_nodes", "graph_edges",
              "history_files", "api_keys", "wf_runs", "wf_steps", "wf_schedules"]
    try:
        psql(ADMIN, f"create database {name}")
        env = {"CTC_DATABASE_URL": tgt, "CTC_PYTHON_DATABASE_URL": ""}
        code, o = run(["node", "apps/cli/src/main.ts", "migrate"], env=env)
        if code:
            step("real copy: ctc migrate on a fresh database", False, o)
            return
        src_before = psql(COPY_URL, "select " + " || ',' || ".join(f"(select count(*) from {COPY_SCHEMA}.{t})" for t in tables))[1]
        sargs = ["node", "apps/cli/src/main.ts", "migrate", "--from-python", "--source-url", COPY_URL, "--source-schema", COPY_SCHEMA, "--json"]
        with tempfile.TemporaryDirectory() as arch:
            code, o = run(sargs + ["--archive-dir", arch], env=env)
        try:
            report = json.loads(o[o.index("{"):o.rindex("}") + 1])
        except ValueError:
            step("real copy: import report is JSON", False, o)
            return
        step("real copy: import exit 0", code == 0, o)
        bad = []
        for t in tables:
            s = int(psql(COPY_URL, f"select count(*) from {COPY_SCHEMA}.{t}")[1])
            g = int(psql(tgt, f"select count(*) from ctc.{t}")[1])
            expect = s
            if t == "memories":  # same user/scope/project and normalized text collapse to one row
                dup = int(psql(COPY_URL, f"select coalesce(sum(c-1),0) from (select count(*) c from {COPY_SCHEMA}.memories group by user_id, scope, project_id, lower(regexp_replace(trim(text), '\\s+', ' ', 'g'))) x")[1])
                expect = s - dup
            if t == "overrides":
                orphans = int(psql(COPY_URL, f"select count(*) from {COPY_SCHEMA}.overrides o where not exists (select 1 from {COPY_SCHEMA}.capabilities c where c.id = o.cap_id)")[1])
                expect = s - orphans
            if g != expect:
                bad.append(f"{t}: source {s} expected {expect} target {g}")
        for t in ("capability_versions", "cap_files"):
            s = int(psql(COPY_URL, f"select count(*) from {COPY_SCHEMA}.capabilities")[1])
            g = int(psql(tgt, f"select count(*) from ctc.{t}")[1])
            if s != g:
                bad.append(f"{t}: {g} rows for {s} capabilities")
        for e in report.get("tables", []):
            if e["imported"] + e["skipped"] != e["source_rows"]:
                bad.append(f"report {e['table']}: {e['imported']}+{e['skipped']}!={e['source_rows']}")
        again_code, again = run(sargs, env=env)
        try:
            second = json.loads(again[again.index("{"):again.rindex("}") + 1])
            if any(e["imported"] for e in second["tables"]):
                bad.append("second import wrote rows")
        except ValueError:
            bad.append("second import: no JSON")
        src_after = psql(COPY_URL, "select " + " || ',' || ".join(f"(select count(*) from {COPY_SCHEMA}.{t})" for t in tables))[1]
        if src_before != src_after:
            bad.append("source counts changed")
        step("real copy: SQL row counts match, report adds up, re-run is a no-op, source unchanged", not bad and again_code == 0, "\n".join(bad))
    finally:
        psql(ADMIN, f"drop database if exists {name} with (force)")


def main() -> int:
    contract_intact()
    for need in ("package.json", "pnpm-workspace.yaml", "eslint.config.js", "packages/shared/src/env/index.ts", "apps/cli/package.json"):
        if not (ROOT / need).exists():
            return blocked(f"T1.1 is not merged here ({need} is missing)")
    code, _ = psql(ADMIN, "select 1")
    if code:
        return blocked("the scratch Postgres (ctc-dev-pg, CTC_TEST_ADMIN_URL) is not reachable")
    scope()
    if not FAST:
        cmd_step("pnpm install --frozen-lockfile", ["pnpm", "install", "--frozen-lockfile"])
    cmd_step("lint: pnpm -r lint (includes the SQL-import ban)", ["pnpm", "-r", "lint"])
    cmd_step("typecheck: pnpm -r typecheck", ["pnpm", "-r", "typecheck"])
    env = {"CTC_TEST_ADMIN_URL": ADMIN, "CTC_TEST_PY_COPY_URL": COPY_URL, "CTC_TEST_PY_COPY_SCHEMA": COPY_SCHEMA}
    ok, out = cmd_step("tests: pnpm -r test (own + integration)", ["pnpm", "-r", "test"], env=env, timeout=1800)
    skipped = [int(n) for n in re.findall(r"(\d+) skipped", out)]
    step("tests: no DB test was skipped", not any(skipped), f"skipped counts: {skipped}")
    code, o = run(["node", str(HERE / "checks.mjs")], env={"CTC_ROOT": str(ROOT), "CTC_CHECKS_FAST": "1" if FAST else "0", "CTC_TEST_ADMIN_URL": ADMIN}, timeout=3600)
    fails = [l for l in o.splitlines() if l.startswith("FAIL")]
    print(o.rstrip().splitlines()[-1] if o.strip() else "checks: no output")
    step("checks.mjs: every decision id", code == 0 and not fails, "\n".join(l[:300] for l in fails))
    if not FAST:
        real_copy()
    left, o = psql(ADMIN, "select datname from pg_database where datname like 'ctc_t12_%' union all select rolname from pg_roles where rolname like 'ctc_t12_%'")
    step("no ctc_t12_ database or role left behind", left == 0 and not o, o)
    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} steps passed" + (f"; failed: {'; '.join(failed)}" if failed else ""))
    print("SELFCHECK: DONE" if not failed else "SELFCHECK: FAILED")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
