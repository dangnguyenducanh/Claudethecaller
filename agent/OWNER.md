# Owner decisions for the 007 build

Every planner, coder brief and verifier cites these as `FROM-OWNER O#`.

O1  200 baseline prompts = SkillRet test + `data/processed/own-eval.jsonl`. That file has 71 rows, so the split is 71 own + 129 SkillRet (O11 default A).
O2  Public fixtures go in `fixtures/py-baseline/` (committed). Own-transcript prompts and their results stay local and gitignored, with a committed sha256 manifest.
O3  30 graph answers are recorded through the running Python daemon's MCP `graph_search`/`graph_explain`/`graph_path`/`graph_affected`, on 30 questions about this repo. The Python answers are the baseline.
O4  `/api` fixtures cover GET routes only; mutating routes are listed as skipped.
O5  One branch per task, cut from the `dangnguyenducanh/ctc-007-build` HEAD and merged back into it. Amended 2026-10-31 (O12): at the end, one PR from `dangnguyenducanh/ctc-007-build` into `staging`.
O6  Toolchain: pin what is installed, Node 22.22.1 and pnpm 10.34.5 (do NOT install Node 24 or pnpm 12). Library majors follow the spec (TypeScript 6, Vitest 4, BullMQ 5) unless the pinned Node cannot run them; flag that as YOUR-CHOICE.
O7  Scratch services: `ctc-dev-pg` (127.0.0.1:18304) and a scratch Redis 8 `ctc-scratch-redis` on 127.0.0.1:18395. Supabase is never touched, during the whole build including T7 (O12). `ctc migrate --from-python` is tested against the dev copy in the scratch DB.
O8  TS migrations create their schema in the scratch DB only.
O9  systemd units are written into the repo but not installed. `ci.yml` may be edited for the TS jobs.
O10 The pnpm workspace covers `apps/*` and `packages/*` only; `dashboard/` stays standalone.
O11 2026-10-31: the owner accepted every planner default ("A") in `agent/*-OPEN.md` and on every YOUR-CHOICE line, and the defaults below:
    - T0.3: tested on the scratch DB only; the real Supabase export of `decisions`/`events` is deferred to after this build (it is not done here).
    - Coders may use the loopback services above, the live Python daemon at 127.0.0.1:18310 (read-only requests only), and the npm registry for `pnpm add`.
    - TypeScript runs as source on Node's type stripping, with no `dist/` build (T1.1 D3b).
    - Tasks planned later (T2.x to T7.x) follow the same rule: the planner picks the more tolerant, less destructive default, tags it YOUR-CHOICE, and lists it in `agent/<group>-OPEN.md`. The owner reviews these in the final PR.
O12 2026-10-31, owner asleep, reviews only the final PR:
    - Never stop, restart or reconfigure the live Python daemon (:18310) or the containers on :18300-18306. Dev runs of the new stack use `CTC_HOME=$PWD/.ctc-dev` and port 18410 (web) / 18411+ (others).
    - Never write to the real `~/.claude` (settings, skills, hooks) or to Supabase.
    - T7.1 changes `.claude/settings.json` in the branch only; nothing is installed on this machine. T7.2 (delete the Python service) runs only if every §7 gate is green on the new stack; otherwise it is skipped and reported.
    - The dashboard rework has no frontend spec (spec §10), so the dashboard-e2e gate is reported as not run.
