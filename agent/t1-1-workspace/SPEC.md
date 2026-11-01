# Task: Build the pnpm/TypeScript workspace for ctc (strict TS, Vitest, ESLint ban on SQL drivers, Zod config loader) so CI is green on nearly empty packages.

Later tasks put the whole TypeScript rewrite of ctc into this workspace, and CI plus `scripts/check.sh` run `pnpm -r lint`, `pnpm -r typecheck` and `pnpm -r test` on it. The only real code here is the loader for `config/*.yaml`, which every app calls at start. Config files and env vars are written by the operator; what must be caught is a typo or wrong type, which has to stop the start with the YAML path of the bad key. The Python service keeps running and keeps reading the same `config/*.yaml`.

Public names (all in `packages/shared/src/env/index.ts`, imported as `@ctc/shared/env`):

    loadConfig(opts?: { dir?: string; env?: Record<string, string | undefined>; home?: string }): Config
    loadConfigOrExit(opts?): Config                       // prints issue lines to stderr, exit code 78
    class ConfigError extends Error { issues: ConfigIssue[] }
    type ConfigIssue = { file: string; path: string; message: string }
    const ConfigSchema: ZodType; type Config

## How to work
1. `agent/t1-1-workspace/DECISIONS.md` is the behaviour contract. Implement exactly that.
2. `agent/t1-1-workspace/PROCESS.md` is the order of work.
3. Change only the files listed in D9 and new test files.

Python is not used in this task. Node 22.22.1 and pnpm 10.34.5 are already installed; do not install other versions. Use the registry only to install the packages D2 names.

## Done
`python3 agent/t1-1-workspace/selfcheck.py` prints `SELFCHECK: DONE`.
