#!/usr/bin/env python3
"""T1.1 self-check: own tests, the checks, lint, typecheck, scope. Last line `SELFCHECK: DONE` only if nothing failed.

Usage: python3 agent/t1-1-workspace/selfcheck.py [--fast]
  --fast  skips `pnpm install`, the dashboard install/build and the slow checks (D12 dashboard install).
Env: CTC_ROOT (checkout to test, default: two levels above this file), CTC_BASE_REF (scope base, default the ctc-007-build branch).
"""
from __future__ import annotations

import hashlib
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = Path(os.environ.get("CTC_ROOT", HERE.parents[1])).resolve()
BASE_REF = os.environ.get("CTC_BASE_REF", "dangnguyenducanh/ctc-007-build")
FAST = "--fast" in sys.argv
NODE, PNPM = "22.22.1", "10.34.5"

ALLOWED = [
    re.compile(r"^(package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml|\.node-version|\.npmrc|tsconfig\.base\.json|eslint\.config\.js|\.gitignore"
               r"|scripts/check\.sh|\.github/workflows/ci\.yml|dashboard/pnpm-workspace\.yaml)$"),
    re.compile(r"^(apps/(web|worker|cli)|packages/(shared|core))/(package\.json|tsconfig\.json|src/.+)$"),
]
# untracked orchestrator material that exists before the coder starts; the contract files are guarded by .contract.sha256 below
IGNORED_PREFIXES = ("agent/", "specs/", ".claude/", "node_modules/")
GITIGNORE_OK = {"node_modules/", "*.tsbuildinfo"}

results: list[tuple[str, bool]] = []


def run(cmd: list[str], cwd: Path = ROOT, timeout: int = 900, env: dict | None = None) -> tuple[int, str]:
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout, env={**os.environ, **(env or {})})
        return p.returncode, p.stdout + p.stderr
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        return 124, f"{type(e).__name__}: {e}"


def step(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok))
    print(f"{'PASS' if ok else 'FAIL'} {name}")
    if not ok and detail:
        print("  " + "\n  ".join(detail.strip().splitlines()[-25:]))


def cmd_step(name: str, cmd: list[str], **kw) -> bool:
    code, out = run(cmd, **kw)
    step(name, code == 0, out)
    return code == 0


def git(*args: str) -> str:
    return run(["git", *args])[1]


def scope() -> None:
    base = git("merge-base", "HEAD", BASE_REF).strip()
    if not re.fullmatch(r"[0-9a-f]{40}", base):
        base = git("rev-parse", "HEAD").strip()
    changed = set(git("diff", "--name-only", base).split())
    for line in git("status", "--porcelain", "--untracked-files=normal").splitlines():
        if line.startswith("??"):
            changed.add(line[3:].strip())
    out = sorted(p for p in changed if not p.startswith(IGNORED_PREFIXES) and not any(a.match(p.rstrip("/")) for a in ALLOWED))
    bad_gitignore = ""
    if ".gitignore" in changed:
        d = git("diff", "-U0", base, "--", ".gitignore")
        added = {l[1:].strip() for l in d.splitlines() if l.startswith("+") and not l.startswith("+++")}
        removed = [l for l in d.splitlines() if l.startswith("-") and not l.startswith("---")]
        if removed or not added <= GITIGNORE_OK:
            bad_gitignore = f".gitignore: only appending {sorted(GITIGNORE_OK)} is allowed; removed={removed} added={sorted(added - GITIGNORE_OK)}"
    step("scope: only the T1.1 files changed", not out and not bad_gitignore, "outside scope: " + ", ".join(out) + "\n" + bad_gitignore)
    dash = git("diff", "--name-only", base, "--", "dashboard").split()
    step("scope: dashboard untouched except the new workspace file", set(dash) <= {"dashboard/pnpm-workspace.yaml"}, "changed: " + ", ".join(dash))


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
    step("contract files unchanged (agent/t1-1-workspace)", not bad, ", ".join(bad))


def main() -> int:
    contract_intact()
    scope()
    _, nv = run(["node", "-v"])
    _, pv = run(["pnpm", "-v"])
    step(f"toolchain: node {NODE}, pnpm {PNPM}", nv.strip() == f"v{NODE}" and pv.strip().splitlines()[-1] == PNPM, f"node {nv.strip()} pnpm {pv.strip()}")
    if not (ROOT / "package.json").exists():
        step("workspace exists (package.json at the root)", False, "nothing built yet")
    else:
        if not FAST:
            cmd_step("pnpm install --frozen-lockfile", ["pnpm", "install", "--frozen-lockfile"])
        cmd_step("lint: pnpm -r lint", ["pnpm", "-r", "lint"])
        cmd_step("typecheck: pnpm -r typecheck", ["pnpm", "-r", "typecheck"])
        cmd_step("tests: pnpm -r test", ["pnpm", "-r", "test"])
    code, out = run(["node", str(HERE / "checks.mjs")], env={"CTC_ROOT": str(ROOT), "CTC_CHECKS_FAST": "1" if FAST else "0"})
    fails = [l for l in out.splitlines() if l.startswith("FAIL")]
    print(out.rstrip().splitlines()[-1] if out.strip() else "checks: no output")
    step("checks.mjs: every decision id", code == 0 and not fails, "\n".join(l[:300] for l in fails))
    if not FAST:
        # CI and check.sh call these two; a root pnpm-workspace.yaml must not hijack them (D12)
        cmd_step("dashboard: install --frozen-lockfile + build", ["bash", "-c", "pnpm -C dashboard install --frozen-lockfile && pnpm -C dashboard build"])
        code, _ = run(["git", "diff", "--quiet", "HEAD", "--", "dashboard/package.json", "dashboard/pnpm-lock.yaml"])
        step("dashboard package.json and lockfile unchanged", code == 0)
    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} steps passed" + (f"; failed: {'; '.join(failed)}" if failed else ""))
    print("SELFCHECK: DONE" if not failed else "SELFCHECK: FAILED")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
