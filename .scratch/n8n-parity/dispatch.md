# Batch split — 17 tickets across shipyard lanes on cnsh

Rule (owner, Q19): tickets that touch the same file never run at the same time. Lanes are not the limit (cnsh); file locks and the owner's merges are.
Each ticket gets its own test file, so `tests/` is not a hotspot; the shared engine fixtures land once in ticket 01.

## Locks (files several tickets touch)

| Lock | Tickets |
|---|---|
| graph.py + Workflows.tsx (walker/validator + editor) | 03 06 08 09 10 12 13 14 16 17 |
| engine.py | 05 08 09 10 11 12 13 14 15 17 |
| runs.py | 04 07 11 12 17 |
| cli.py | 02 04 11 12 17 |
| export.py | 03 08 10 13 14 |
| Runs.tsx / types.ts | 03 06 11 12 13 16 |

Free of every lock: 01. Pure singles: 02 (cli), 07 (runs + schedule), 15 (engine + app).

## Plan

| Wave | Lanes (parallel) | Starts when |
|---|---|---|
| 1 | **01** test seam · **02** prune · **03** IF/Switch · **07** schedule HEAD + validate | now |
| 2 | **05** notify → then **15** graceful shutdown (same lane, engine lock) · **04** MCP/CLI run control · **06** cheap fixes | 01 merged (05) · 02 + 07 merged (04) · 03 merged (06) |
| 3 | **16** editor parity | 06 merged |
| 4 | **08** disabled → **09** retry-on-fail → **10** error branch (one lane, in order) | 15 + 16 merged |
| 5 | **11** retry / run-from / run-to → **12** pins (one lane) | 10 + 04 merged |
| 6 | **13** for-each → **14** graph extras (one lane) | 12 merged |
| 7 | **17** run inputs + builder skill | 14 + 04 merged |

Critical path: 03 → 06 → 16 → 08 → 09 → 10 → 11 → 12 → 13 → 14 → 17 (11 PRs in a row on the graph/editor/engine locks). Each step waits for a human merge of the previous PR into `staging`.

## Dispatch (wave 1)

Lane 1: `/ship-feature Implement ticket 01-runner-test-seam: read /home/aiface/dangnguyenducanh/claudethecaller/.scratch/n8n-parity/issues/01-runner-test-seam.md and the spec next to it, then build exactly that ticket.`
Lane 2: same with `02-prune-runs.md`
Lane 3: same with `03-if-switch.md`
Lane 4: same with `07-schedule-head-version.md`

## Risks / open questions

- **The strict rule makes the run mostly serial after wave 2.** Relaxing it for the three big files (allow parallel tickets that edit different functions of graph.py / engine.py / Workflows.tsx, since shipyard syncs `staging` into each branch before the PR) would let waves 2–6 run 5–7 lanes at once. Decision for the owner.
- Shipyard lanes wait on each PR until a human merges it; merge speed sets the pace.
- Ticket 11 changes the schema (additive columns); no other ticket does, so no migration-order clash.
