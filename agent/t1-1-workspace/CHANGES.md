# Changes to the T1.1 contract files (verifier)

## Round 1: checks.mjs D10 planted dir gets `package.json {"type":"module"}`
- What: the D10 check now writes `package.json` with `"type": "module"` next to the planted `f.ts`.
- Why: the planted dir lives under `os.tmpdir()` (default `/tmp`) with no `package.json`, so `module nodenext` reads `f.ts` as CommonJS and `verbatimModuleSyntax` adds TS1295 to the expected codes. Every real package is `"type": "module"` (D3a), so the check now plants the same setting. The check passed for the coder only because TMPDIR pointed inside the repo (whose root `package.json` is `"type": "module"`).
- Reproducer (before the fix): `env -u TMPDIR CTC_ROOT=$PWD CTC_CHECKS_FAST=1 node agent/t1-1-workspace/checks.mjs | grep D10` → `FAIL D10 ... got=["TS1294","TS1295","TS2322","TS2375"]`.
